// wrapper/adapter.js — PLAN.md section 9's `wrapper` tier: the canonical DEGRADED driver, for a harness
// with no structured output at all.
//
// WHAT SECTION 9 SPECIFIES, AND WHERE THIS DELIBERATELY DIFFERS
//
// §9 defines the tier as "driven via `node-pty` + a terminal parser instead of its own structured event
// stream, for both liveness/heartbeat purposes and pane output". This implementation is **pipes, not a
// pty, and line-splitting with ANSI stripped, not a terminal parser** — and that is a scope decision made
// with the numbers in front of it rather than a shortcut:
//
//   * `node-pty` is a NATIVE build dependency. This project has exactly one dependency
//     (`better-sqlite3`) on purpose, and PLAN.md §2 is explicit that install friction is a product
//     property, not an implementation detail.
//   * There are ZERO harnesses that need it. Both existing adapters emit structured events
//     (`stream-json` and `sse`). The tier is for a hypothetical third CLI.
//   * A pty buys exactly two things over pipes: a harness that REFUSES to run without a tty, and cursor
//     addressing (progress bars, alternate screens, spinners). The first is a real possibility; the
//     second is output a pane would have to discard anyway.
//
// So: build the tier's real behaviour now with no new dependency, prove it, and add `node-pty` the day a
// harness genuinely demands a tty — at which point the parser can be written against that harness's
// actual output rather than against a guess. Two independent models were asked (this was a fork, not an
// obvious call); both chose this, both for the dependency reason, and both said the same thing about the
// risk of C ("build nothing"): a documented tier nothing exercises hides its architectural gaps until
// integration pressure arrives.
//
// WHAT A WRAPPER-TIER RUN CANNOT DO, declared rather than discovered:
//
//   * **No turn boundaries.** Nothing in raw stdout says a turn ended, so this emits `turn.end` when the
//     PROCESS exits and never mid-run. A one-shot harness therefore gets one turn per run, which is
//     honest — `residentProcess: 'one-shot'`.
//   * **No approvals.** There is no permission protocol to speak, so `approvalProtocol: false`. A worker
//     on this tier that blocks on its own prompt will hang, visibly, rather than parking an `ask` nobody
//     can answer.
//   * **No clear, no resume.** Both need harness-side state this driver knows nothing about.
//   * **Interrupt is `process`** — the only way to stop it is to kill it, which is §7's clean-vs-kill
//     distinction landing on the kill side.
//
// Every one of those is in the declared matrix, so `suite.js` checks it and the tier is marked in the UI.
// Section 9's rule — "never silently treated as equivalent to a real, conformance-passing adapter" — is
// enforced by the declaration rather than by remembering.

import { EventEmitter } from "node:events";
import { spawnManaged, killProcessGroup } from "../../runtime/spawn.js";
import { signalProcessGroup } from "../../runtime/procinfo.js";

/** runId -> Run */
const runs = new Map();

/** Bounded, like every other buffer here: a chatty harness must not grow memory without limit. */
const MAX_BUFFERED_EVENTS = 5000;

/**
 * ANSI/VT escape sequences, stripped.
 *
 * NOT a terminal emulator, and the difference matters: this DISCARDS cursor movement, colour and screen
 * control rather than interpreting them. A harness that redraws a progress bar in place will therefore
 * produce one line per redraw instead of one line that changes — ugly, and honest. Interpreting them is
 * what a pty and a real parser would be for, and that is the deferred half.
 *
 * The pattern covers CSI (`ESC[…`), OSC (`ESC]…BEL/ST`) and the two-character sequences, which is what
 * real CLI output actually contains.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI, "");
}

/**
 * Split a chunk into complete lines, keeping the remainder.
 *
 * Returns `{ lines, rest }` so the caller owns the partial line — a chunk boundary lands mid-line all the
 * time, and emitting the half is the "one fragment per line" defect (FINDINGS §28) at the adapter level.
 * `\r` is treated as a line break as well as `\n`, because a CLI writing progress with bare carriage
 * returns would otherwise accumulate one enormous line.
 */
export function splitLines(buffer) {
  const text = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = text.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

/**
 * The declared capability matrix (PLAN.md section 9, step 1).
 *
 * Every field is the DEGRADED value, and none of them is aspirational — this is the declaration that
 * makes the tier legible to everything downstream, and the reason `wrapper` is a tier rather than an
 * excuse.
 */
export function capabilities() {
  return {
    residentProcess: "one-shot",
    resumableTurns: false,
    structuredOutput: "terminal",
    interrupt: "process",
    clearContext: false,
    approvalProtocol: false,
    modelDiscovery: false,
  };
}

class Run extends EventEmitter {
  constructor({ runId, spec }) {
    super();
    this.runId = runId;
    this.spec = spec;
    this.cwd = spec.cwd;
    this.status = "starting";
    this._eventLog = [];
    this._readCursor = 0;
    this._stdoutRest = "";
    this._stderrRest = "";
    this.child = null;
    this.identity = null;
    this.spawnDepth = null;
    // Every line the harness has produced, in case a pane wants a backfill the event log has evicted.
    this.lineCount = 0;
  }

  emitEvent(event) {
    this._eventLog.push({ runId: this.runId, ...event });
    if (this._eventLog.length > MAX_BUFFERED_EVENTS) {
      // Drop from the FRONT and move the cursor with it, so a consumer that is behind skips rather than
      // re-reading the wrong events. Silent loss is what `event_log`'s persistence is for; this buffer is
      // only the live hand-off.
      const dropped = this._eventLog.length - MAX_BUFFERED_EVENTS;
      this._eventLog.splice(0, dropped);
      this._readCursor = Math.max(0, this._readCursor - dropped);
    }
    this.emit("event", event);
  }
}

function _get(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error(`Unknown runId: ${runId}`);
  return run;
}

/**
 * start(spec) -> runId
 *
 * `spec.command` and `spec.args` are REQUIRED, and that is the whole shape of this tier: the supervisor
 * knows how to own a process, and a wrapper-tier harness is exactly "a command nobody has written an
 * adapter for". There is no default command, because guessing one would make a misconfiguration look
 * like a harness that produces no output.
 */
export function start(spec = {}) {
  if (!spec.cwd) throw new Error("wrapper adapter: spec.cwd is required");
  if (!spec.command) {
    throw new Error(
      "wrapper adapter: spec.command is required — the wrapper tier drives an arbitrary CLI, so there is "
      + "nothing to guess (PLAN.md section 9)",
    );
  }
  const runId = spec.runId ?? `wrapper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run = new Run({ runId, spec });
  runs.set(runId, run);

  const managed = spawnManaged({
    command: spec.command,
    args: spec.args ?? [],
    cwd: spec.cwd,
    // A pipe on stdin even though nothing structured is written to it: `sendInput` writes a line, which
    // is the only input channel this tier has, and a harness given an inherited stdin would read the
    // supervisor's own.
    stdio: ["pipe", "pipe", "pipe"],
    ...(spec.env ? { env: spec.env } : {}),
  });
  run.child = managed.child;
  run.identity = managed.identity;
  run.spawnDepth = managed.spawnDepth ?? null;

  run.emitEvent({ type: "session.init", sessionId: runId, harness: "wrapper", degraded: true });
  run.status = "running";

  run.child.stdout?.setEncoding("utf8");
  run.child.stderr?.setEncoding("utf8");
  run.child.stdout?.on("data", (chunk) => onOutput(run, chunk, "stdout"));
  run.child.stderr?.on("data", (chunk) => onOutput(run, chunk, "stderr"));

  run.child.on("error", (err) => {
    run.status = "errored";
    run.emitEvent({ type: "process.error", message: err.message });
    run.emitEvent({ type: "turn.end", status: "error", isError: true, degraded: true });
  });

  run.child.on("exit", (code, signal) => {
    // FLUSH the partial lines first. A harness whose last line has no trailing newline would otherwise
    // lose it — and the last line before an exit is the one most likely to say why.
    flushRest(run, "stdout");
    flushRest(run, "stderr");
    const aborted = signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGINT";
    const status = aborted ? "aborted" : (code === 0 ? "completed" : "error");
    run.status = status === "completed" ? "completed" : (aborted ? "stopped" : "errored");
    // The ONLY `turn.end` this tier emits, and the reason it declares `residentProcess: 'one-shot'`:
    // nothing in raw output marks a turn boundary, so inventing one would be a guess a tier-2 digest
    // would then summarise as fact.
    run.emitEvent({ type: "turn.end", status, isError: status === "error", exitCode: code, signal, degraded: true });
  });

  // The runId STRING, matching the other two adapters: `supervisor.start()` does
  // `const runId = await adapter.start(spec)`, so returning `{ runId }` here made the object itself the
  // run id and SQLite refused to bind it. The adapter contract is a string, and the uniformity is the
  // point — a third adapter that is subtly different from the two real ones is not a conformance tier,
  // it is a special case.
  return runId;
}

function onOutput(run, chunk, stream) {
  const key = stream === "stdout" ? "_stdoutRest" : "_stderrRest";
  const { lines, rest } = splitLines(run[key] + String(chunk));
  run[key] = rest;
  for (const raw of lines) {
    const line = stripAnsi(raw).replace(/\s+$/, "");
    // Blank lines are DROPPED rather than emitted: a CLI that pads its output with spacing would
    // otherwise fill a pane with empty rows, and a blank line carries no information a reader can use.
    if (!line) continue;
    run.lineCount += 1;
    // `assistant.delta` with a trailing newline, because that is the event every consumer already
    // renders as prose (pane/render.js, the TUI's `collapseTranscript`). Mapping raw output onto the
    // existing vocabulary is what makes a wrapper-tier run readable in the same pane as a real one --
    // and `degraded: true` on every event is what stops it being MISTAKEN for one.
    run.emitEvent({ type: "assistant.delta", text: `${line}\n`, stream, degraded: true });
  }
}

function flushRest(run, stream) {
  const key = stream === "stdout" ? "_stdoutRest" : "_stderrRest";
  const rest = stripAnsi(run[key]).trim();
  run[key] = "";
  if (rest) {
    run.lineCount += 1;
    run.emitEvent({ type: "assistant.delta", text: `${rest}\n`, stream, degraded: true });
  }
}

/**
 * sendInput(runId, text) -> Promise<{ delivered: true }>
 *
 * A line on stdin, and nothing more. Awaits the write callback rather than reporting success the moment
 * bytes are queued — the false-success pattern the fake harness was corrected for (FINDINGS §17), and it
 * matters more here: on this tier there is no structured acknowledgement, so a lost write would be
 * completely silent.
 */
export function sendInput(runId, text) {
  const run = _get(runId);
  if (!run.child?.stdin?.writable) {
    const err = new Error(`wrapper adapter: run ${runId} has no writable stdin`);
    err.permanent = true;
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    run.child.stdin.write(`${text}\n`, (err) => (err
      ? reject(new Error(`wrapper adapter: stdin write failed: ${err.message}`))
      : resolve({ delivered: true })));
  });
}

/** The same shared-cursor stream shape the other two adapters expose. */
export async function* observe(runId) {
  const run = _get(runId);
  if (run._readCursor === undefined) run._readCursor = 0;
  let wake = () => {};
  const onEvent = () => wake();
  run.on("event", onEvent);
  try {
    for (;;) {
      while (run._readCursor < run._eventLog.length) yield run._eventLog[run._readCursor++];
      if (["completed", "errored", "stopped"].includes(run.status) && run._readCursor >= run._eventLog.length) return;
      let timer;
      await new Promise((res) => {
        wake = res;
        timer = setTimeout(res, 100);
      });
      clearTimeout(timer);
    }
  } finally {
    run.off("event", onEvent);
  }
}

/**
 * interrupt(runId) -> the only interrupt this tier has: kill the process.
 *
 * Declared as `interrupt: 'process'` rather than pretended to be `'turn'`. §7's clean-vs-kill distinction
 * is real, and this side of it is the kill: there is no protocol to cancel a turn on a CLI that has no
 * structured protocol at all.
 */
export function interrupt(runId) {
  const run = _get(runId);
  if (!run.child) return { interrupted: false, reason: "no process" };
  signalProcessGroup(run.child.pid, "SIGINT");
  return { interrupted: true, kind: "process" };
}

export function stop(runId) {
  const run = runs.get(runId);
  if (!run) return { stopped: false };
  if (run.child) killProcessGroup(run.child.pid, { graceMs: 300 });
  run.status = "stopped";
  runs.delete(runId);
  return { stopped: true };
}

/**
 * The uniform identity surface the supervisor persists from.
 *
 * `run-owned`, because `spawnManaged` gave this run its own process group — which is the one thing this
 * tier does exactly as well as a real adapter, and the thing that makes a wrapper-tier run reapable and
 * non-orphaning.
 */
export async function processIdentity(runId) {
  const run = _get(runId);
  if (!run.identity) return { verified: false, reason: "run has no spawned child", ownership: "run-owned" };
  const info = await run.identity;
  return { ...info, cwd: run.cwd ?? null, spawnDepth: run.spawnDepth ?? null, ownership: "run-owned" };
}

export function listRuns() {
  return [...runs.keys()];
}

export async function disposeAll({ graceMs = 300 } = {}) {
  const stopped = [];
  for (const runId of [...runs.keys()]) {
    try { stop(runId); stopped.push(runId); } catch { /* teardown */ }
  }
  await new Promise((r) => setTimeout(r, graceMs));
  return { stopped };
}

/** Test seam, same name the other adapters use. */
export function _getRunForTest(runId) {
  return runs.get(runId) ?? null;
}
