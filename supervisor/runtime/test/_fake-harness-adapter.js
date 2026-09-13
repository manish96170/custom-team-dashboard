// _fake-harness-adapter.js — an adapter module shaped exactly like the two real ones
// (adapters/claude-code, adapters/opencode), spawning a real resident process through
// runtime/spawn.js.
//
// Why not test the supervisor against the real adapters: those need `claude` / `opencode`
// installed and would make the supervisor's own lifecycle logic hostage to a third-party
// CLI's availability and timing. Why not a pure in-memory mock (ipc/mock-adapter.js):
// because the things Group 5 actually adds — process-group ownership, pid/pgid/lstart
// verification, reap, orphan reconciliation, teardown of surviving processes — are all
// about real OS processes, and a mock proves none of them.
//
// So: real spawn, real process group, real kill; only the harness's *conversation* is
// fake. Exported as a FACTORY (unlike the real adapters, which are module singletons) so
// a test can create a second, independent instance to stand in for "the supervisor
// restarted and holds no handles anymore".

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnManaged, killProcessGroup } from "../spawn.js";
import { signalProcessGroup } from "../procinfo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(__dirname, "_fake-harness-child.js");

let seq = 0;

export function createFakeHarness({ label = "fake", mcpConfigDelivery = false } = {}) {
  const runs = new Map();

  function get(runId) {
    const run = runs.get(runId);
    if (!run) throw new Error(`Unknown runId: ${runId}`);
    return run;
  }

  function emit(run, event) {
    run.events.push(event);
    for (const wake of run.waiters) wake();
    run.waiters.clear();
  }

  /**
   * The host side of the parked-request protocol, deliberately the SAME shape as
   * adapters/claude-code/adapter.js's: a `_parkedRequests` map keyed by request id, an
   * `approval.request` event out, `answerApproval()` in, generation-pinned so an answer
   * cannot reach the process a resume() replaced. If these two ever diverge, the supervisor
   * is being tested against a contract no real adapter implements.
   */
  function handleHarnessLine(run, obj) {
    if (obj.type === "control_request" && obj.request?.subtype === "can_use_tool") {
      const parked = {
        requestId: obj.request_id,
        toolName: obj.request.tool_name,
        displayName: obj.request.display_name ?? obj.request.tool_name,
        toolUseId: obj.request.tool_use_id ?? null,
        input: obj.request.input ?? {},
        requiresUserInteraction: !!obj.request.requires_user_interaction,
        description: obj.request.description ?? null,
        suggestions: obj.request.permission_suggestions ?? null,
        receivedAt: new Date().toISOString(),
        generation: run.generation,
      };
      run.parked.set(parked.requestId, parked);
      emit(run, { type: "approval.request", runId: run.runId, ...parked });
      return true;
    }
    if (obj.type === "control_cancel_request") {
      const parked = run.parked.get(obj.request_id);
      run.parked.delete(obj.request_id);
      emit(run, {
        type: "approval.withdrawn",
        runId: run.runId,
        requestId: obj.request_id,
        toolName: parked?.toolName ?? null,
        reason: "harness-withdrew",
      });
      return true;
    }
    return false;
  }

  /**
   * Async, and awaits the stdin write callback, because the REAL adapter now does both — a fake
   * that reported success the moment bytes were queued is exactly why the test suite could not
   * see that defect (the consolidated review noted the fake shared the false-success pattern, so
   * the tests were structurally unable to catch it).
   *
   * `err.permanent` marks a failure a retry cannot fix, matching the real adapter, so the
   * supervisor's abandon-vs-retry decision is exercised here rather than only in production.
   */
  async function answerApproval(runId, requestId, decision, { expectGeneration } = {}) {
    const run = get(runId);
    if (run.failNextAnswer) {
      // A TRANSIENT failure (no `permanent` flag) — the case that proves an answer is durable
      // before it is delivered and is retried rather than lost with the attempt.
      run.failNextAnswer = false;
      throw new Error("fake harness: simulated delivery failure");
    }
    const parked = run.parked.get(requestId);
    if (!parked) {
      const err = new Error(`answerApproval: run ${runId} has no parked request ${requestId}`);
      err.permanent = true;
      throw err;
    }
    if (parked.generation !== run.generation) {
      run.parked.delete(requestId);
      const err = new Error(`answerApproval: request ${requestId} belongs to generation ${parked.generation}, run is on ${run.generation}`);
      err.permanent = true;
      throw err;
    }
    if (expectGeneration != null && Number(expectGeneration) !== Number(parked.generation)) {
      const err = new Error(
        `answerApproval: answer was recorded for generation ${expectGeneration} but the parked request belongs to generation ${parked.generation}`,
      );
      err.permanent = true;
      throw err;
    }
    const response = decision.behavior === "allow"
      ? { behavior: "allow", ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}) }
      : { behavior: "deny", message: decision.message || "Denied." };
    await new Promise((resolve, reject) => {
      run.child.stdin.write(
        `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`,
        (err) => (err ? reject(new Error(`fake harness stdin write failed: ${err.message}`)) : resolve()),
      );
    });
    run.parked.delete(requestId);
    emit(run, { type: "approval.answered", runId, requestId, toolName: parked.toolName, behavior: response.behavior });
    return { delivered: true, behavior: response.behavior };
  }

  function pendingApprovals(runId) {
    return [...get(runId).parked.values()];
  }

  function bind(run, { child, identity, spawnDepth }) {
    run.child = child;
    // A rebind is a NEW process: its request ids are unrelated to the old one's, so anything
    // still parked is withdrawn rather than left looking answerable.
    run.generation = (run.generation ?? 0) + 1;
    if (run.parked?.size) {
      for (const parked of run.parked.values()) {
        emit(run, { type: "approval.withdrawn", runId: run.runId, requestId: parked.requestId, toolName: parked.toolName, reason: "process-replaced" });
      }
      run.parked.clear();
    }
    run.identity = identity;
    run.spawnDepth = Number(spawnDepth);
    run.verifiedPgid = null;
    identity
      .then((info) => {
        if (info.verified) run.verifiedPgid = info.pgid;
      })
      .catch(() => {});
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; /* not our framing; ignore */
        }
        // Control traffic is translated, not forwarded: the supervisor consumes normalized
        // adapter events, exactly as it does from the real adapters.
        if (!handleHarnessLine(run, obj)) emit(run, obj);
      }
    });
    child.stdin.on("error", () => {
      /* EPIPE after a kill is ordinary here */
    });
    child.on("exit", (code, signal) => {
      emit(run, { type: "process.exit", code, signal });
      run.ended = true;
      for (const wake of run.waiters) wake();
      run.waiters.clear();
    });
  }

  async function start(spec) {
    const runId = `${label}-run-${++seq}`;
    // `spec` is KEPT, and `spec.env` is passed through — both because the real adapters do. A fake that
    // diverges from the real adapters lets a consumer be wrong while every test passes (finding B4's lesson),
    // and this is exactly where it bit: Phase 7 delivers a worker's principal token in `spec.env`, the fake
    // dropped it, and the assertion that caught it also revealed that the REAL claude-code adapter passed no
    // `env` at all.
    const run = { runId, cwd: spec.cwd, spec, events: [], waiters: new Set(), ended: false, parked: new Map(), generation: 0 };
    runs.set(runId, run);
    bind(run, spawnManaged({
      command: process.execPath, args: [CHILD, spec.prompt ?? ""], cwd: spec.cwd,
      ...(spec.env ? { env: spec.env } : {}),
    }));
    return runId;
  }

  /** One shared source per run, as the real adapters have. The pump is its only consumer. */
  async function* observe(runId) {
    const run = get(runId);
    let cursor = 0;
    for (;;) {
      while (cursor < run.events.length) yield run.events[cursor++];
      if (run.ended) return;
      await new Promise((resolve) => run.waiters.add(resolve));
    }
  }

  async function sendInput(runId, input) {
    const run = get(runId);
    run.child.stdin.write(`${JSON.stringify({ type: "user", text: input })}\n`);
  }

  async function interrupt(runId) {
    const run = get(runId);
    run.child.stdin.write(`${JSON.stringify({ type: "interrupt" })}\n`);
  }

  async function clearContext(runId) {
    const run = get(runId);
    run.child.stdin.write(`${JSON.stringify({ type: "clear" })}\n`);
    return { ack: true, runId, note: "fake harness: new session id, same process" };
  }

  /** Mirrors the Claude Code adapter's cross-process resume: same runId, brand-new child. Also mirrors
   *  its `specOverride` handling (review-consolidated-2026-09-14.md finding 2) — `run.spec` is mutated,
   *  not just read, so a test can inspect `_runs.get(runId).spec` afterward to assert what the
   *  supervisor actually handed this generation, the same way it inspects a fresh `start()`. */
  async function resume(runId, { specOverride } = {}) {
    const run = get(runId);
    if (specOverride) Object.assign(run.spec, specOverride);
    if (!run.ended) return runId;
    run.ended = false;
    bind(run, spawnManaged({ command: process.execPath, args: [CHILD, "resumed"], cwd: run.cwd }));
    return runId;
  }

  async function stop(runId) {
    const run = runs.get(runId);
    if (!run) return;
    if (Number.isInteger(run.verifiedPgid)) signalProcessGroup(run.verifiedPgid, "SIGKILL");
    else run.child?.kill("SIGKILL");
    runs.delete(runId);
  }

  async function processIdentity(runId) {
    const run = get(runId);
    const info = await run.identity;
    return { ...info, cwd: run.cwd, spawnDepth: run.spawnDepth, ownership: "run-owned" };
  }

  function listRuns() {
    return [...runs.keys()];
  }

  async function disposeAll({ graceMs = 300 } = {}) {
    const stopped = [];
    const kills = [];
    for (const [runId, run] of [...runs.entries()]) {
      if (Number.isInteger(run.verifiedPgid)) kills.push(killProcessGroup(run.verifiedPgid, { graceMs }));
      else run.child?.kill("SIGKILL");
      stopped.push(runId);
      runs.delete(runId);
    }
    await Promise.all(kills);
    return { stopped };
  }

  /** Test-only: forget every handle WITHOUT killing anything — exactly what a supervisor
   * crash looks like from the database's point of view (rows open, processes alive). */
  function _forgetAllHandles() {
    const forgotten = [...runs.keys()];
    runs.clear();
    return forgotten;
  }

  /**
   * The fake's declared matrix. It exists so the conformance suite can be exercised
   * deterministically and for free in `npm test` -- a suite that can only be run by hand against a
   * real harness is a suite that rots. Values match what this fake actually does.
   */
  function capabilities() {
    return {
      residentProcess: "per-run",
      resumableTurns: true,
      structuredOutput: "stream-json",
      interrupt: "turn",
      clearContext: "erase",
      approvalProtocol: "host",
      modelDiscovery: false,
      // Overridable per-instance (default `false`, matching every existing caller's assumption) so a
      // test can exercise `runtime/supervisor.js`'s `start()`-side mcpConfig-building logic
      // (review-sol-2026-09-13.md finding 13) without needing the real claude-code adapter installed.
      mcpConfigDelivery,
    };
  }

  return {
    capabilities,
    start,
    observe,
    sendInput,
    interrupt,
    clearContext,
    resume,
    stop,
    processIdentity,
    listRuns,
    disposeAll,
    answerApproval,
    pendingApprovals,
    _forgetAllHandles,
    _runs: runs,
  };
}
