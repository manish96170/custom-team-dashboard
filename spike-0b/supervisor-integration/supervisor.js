// supervisor.js — the real minimal supervisor for Phase 0b's two remaining
// gate items.
//
// Wires packaging-probe's proven lock/socket/lazy-start scaffold to the two
// REAL, already-proven-standalone adapters:
//   - ../claude-code-adapter/adapter.js  (resident stdin process)
//   - ../opencode-adapter/adapter.js     (resident HTTP+SSE server)
//
// Protocol: newline-delimited JSON over a Unix domain socket. One JSON
// object per line in, one-or-more JSON objects per line out. `observe`
// upgrades the connection into a long-lived event stream (JSON-lines,
// one per adapter event) rather than a single request/response.
//
// Persistence (explicitly NOT the real SQLite store — that's Phase 1):
// a flat JSON file (`runs-state.json`, see paths.js) is rewritten on every
// run-state transition. It exists ONLY to prove the reconciliation *logic*
// described in PLAN.md section 4 survives a real `kill -9` of this process
// while a real run is in flight — enough to prove the rule, not a claim
// about the eventual real persistence layer.

import net from "node:net";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acquireLock } from "../packaging-probe/lock.js";
import { STATE_DIR, SOCK_PATH, RUNS_STATE_PATH } from "./paths.js";

import * as claudeAdapter from "../claude-code-adapter/adapter.js";
import * as openCodeAdapter from "../opencode-adapter/adapter.js";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(...args) {
  const line = `[supervisor pid=${process.pid}] ${new Date().toISOString()} ${args.join(" ")}`;
  process.stdout.write(line + "\n");
}

// runId -> 'claude-code' | 'opencode'   — the routing table this item's spec
// asks for explicitly ("route to the correct adapter based on which harness
// a given runId belongs to"). Built at start() time; this is the ONLY thing
// that lets a single `sendInput`/`interrupt`/`stop`/`observe` command work
// without the caller having to say which harness a runId belongs to.
const harnessOf = new Map();

// In-memory run registry, mirrored to disk (RUNS_STATE_PATH) on every change.
// Keyed by runId. This is the thing restart reconciliation re-derives trust
// for on the next boot.
const registry = new Map();

async function persistState() {
  const rows = [...registry.values()];
  await fs.writeFile(RUNS_STATE_PATH, JSON.stringify(rows, null, 2));
}

async function pgidOf(pid) {
  try {
    const { stdout } = await execFileP("ps", ["-o", "pgid=", "-p", String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function lstartOf(pid) {
  try {
    const { stdout } = await execFileP("ps", ["-o", "lstart=", "-p", String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Resolve the OS PID backing a runId, regardless of which adapter owns it. */
function pidForRun(runId) {
  const harness = harnessOf.get(runId);
  if (harness === "claude-code") {
    const run = claudeAdapter._getRunForTest(runId);
    return run?.child?.pid ?? null;
  }
  if (harness === "opencode") {
    const info = openCodeAdapter.getRunProcessInfo(runId);
    return info?.pid ?? null;
  }
  return null;
}

async function registerRun(runId, harness, spec) {
  harnessOf.set(runId, harness);
  const pid = pidForRun(runId);
  const pgid = pid ? await pgidOf(pid) : null;
  const lstart = pid ? await lstartOf(pid) : null;
  const row = {
    runId,
    harness,
    prompt: spec.prompt,
    cwd: spec.cwd,
    pid,
    pgid,
    lstart, // raw `ps -o lstart=` string, used as a start-time fingerprint on reconciliation
    startedAtIso: new Date().toISOString(),
    status: "running",
    turns: [], // { tokensIn, tokensOut, cachedTokens, ts }
    lastEvent: null,
    lastUpdated: new Date().toISOString(),
  };
  registry.set(runId, row);
  await persistState();
  log(`start: runId=${runId} harness=${harness} pid=${pid} pgid=${pgid} cwd=${spec.cwd}`);
  return row;
}

async function updateRun(runId, patch) {
  const row = registry.get(runId);
  if (!row) return;
  Object.assign(row, patch, { lastUpdated: new Date().toISOString() });
  await persistState();
}

function adapterFor(runId) {
  const harness = harnessOf.get(runId);
  if (harness === "claude-code") return claudeAdapter;
  if (harness === "opencode") return openCodeAdapter;
  throw new Error(`unknown runId (no harness routing entry): ${runId}`);
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleStart(cmd) {
  const { harness, spec } = cmd;
  if (harness !== "claude-code" && harness !== "opencode") {
    throw new Error(`unknown harness: ${harness}`);
  }
  const adapter = harness === "claude-code" ? claudeAdapter : openCodeAdapter;
  const runId = await adapter.start(spec);
  await registerRun(runId, harness, spec);
  return { ok: true, runId };
}

async function handleSendInput(cmd) {
  const adapter = adapterFor(cmd.runId);
  await adapter.sendInput(cmd.runId, cmd.input);
  return { ok: true };
}

async function handleInterrupt(cmd) {
  const adapter = adapterFor(cmd.runId);
  await adapter.interrupt(cmd.runId);
  await updateRun(cmd.runId, { status: "interrupted" });
  return { ok: true };
}

async function handleStop(cmd) {
  const adapter = adapterFor(cmd.runId);
  await adapter.stop(cmd.runId);
  await updateRun(cmd.runId, { status: "stopped" });
  return { ok: true };
}

/**
 * OpenCode-only: answer a pending `permission.asked` approval. Claude Code
 * has no equivalent supervisor-routed command (PLAN.md section 4/7 — its
 * approval protocol is a synchronous PreToolUse hook that resolves itself,
 * not an ask the supervisor answers later), so this is intentionally not a
 * generic `answerApproval` dispatched by harness type — routing it to the
 * wrong adapter would silently no-op rather than error, which is worse than
 * an adapter-specific command that fails loudly if misused.
 */
async function handleAnswerApproval(cmd) {
  const harness = harnessOf.get(cmd.runId);
  if (harness !== "opencode") {
    throw new Error(`answerApproval is only defined for opencode runs (runId=${cmd.runId} is ${harness})`);
  }
  const info = openCodeAdapter.getRunProcessInfo(cmd.runId);
  const [baseUrl, sessionID] = cmd.runId.split("::");
  const res = await fetch(`${baseUrl}/session/${sessionID}/permissions/${cmd.approvalId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response: cmd.decision || "once" }),
  });
  if (!res.ok) throw new Error(`answerApproval failed: ${res.status} ${await res.text()}`);
  return { ok: true };
}

async function handleList() {
  return { ok: true, runs: [...registry.values()] };
}

async function handlePing() {
  return { ok: true, pid: process.pid, startedAt: SUPERVISOR_STARTED_AT };
}

/**
 * observe streams events for socket.write directly rather than returning one
 * object, because it's a long-lived subscription, not a request/response.
 * Also where token telemetry (item 4) is captured: every `turn.end`
 * (Claude Code) or `usage` (OpenCode) event that carries token fields gets
 * appended to the run's row and persisted, then forwarded to the client
 * unmodified so the client sees exactly what the adapter reported.
 */
async function handleObserve(cmd, socket) {
  const adapter = adapterFor(cmd.runId);
  const runId = cmd.runId;
  try {
    for await (const evt of adapter.observe(runId)) {
      const line = JSON.stringify({ ok: true, stream: "observe", runId, event: evt }) + "\n";
      socket.write(line);

      if (evt.type === "turn.end") {
        const row = registry.get(runId);
        if (row) {
          if (evt.tokensIn != null || evt.tokensOut != null || evt.cachedTokens != null) {
            row.turns.push({
              ts: new Date().toISOString(),
              tokensIn: evt.tokensIn ?? null,
              tokensOut: evt.tokensOut ?? null,
              cachedTokens: evt.cachedTokens ?? null,
              cacheCreationTokens: evt.cacheCreationTokens ?? null,
            });
          }
          if (row.status === "running") row.status = evt.isError ? "errored" : "idle";
          await persistState();
        }
      }
      if (evt.type === "usage") {
        const row = registry.get(runId);
        if (row) {
          row.turns.push({
            ts: new Date().toISOString(),
            tokensIn: evt.tokensIn ?? null,
            tokensOut: evt.tokensOut ?? null,
            cachedTokens: evt.cachedTokens ?? null,
            cacheWriteTokens: evt.cacheWriteTokens ?? null,
            costUsd: evt.costUsd ?? null,
          });
          await persistState();
        }
      }
    }
  } catch (err) {
    socket.write(JSON.stringify({ ok: false, stream: "observe", runId, error: String(err) }) + "\n");
  }
  socket.write(JSON.stringify({ ok: true, stream: "observe", runId, done: true }) + "\n");
}

async function dispatch(cmd, socket) {
  switch (cmd.cmd) {
    case "start":
      return handleStart(cmd);
    case "sendInput":
      return handleSendInput(cmd);
    case "interrupt":
      return handleInterrupt(cmd);
    case "stop":
      return handleStop(cmd);
    case "list":
      return handleList();
    case "answerApproval":
      return handleAnswerApproval(cmd);
    case "ping":
      return handlePing();
    case "observe":
      await handleObserve(cmd, socket);
      return null; // response(s) already written directly to the socket
    default:
      throw new Error(`unknown cmd: ${cmd.cmd}`);
  }
}

// ---------------------------------------------------------------------------
// Startup reconciliation (PLAN.md section 4's reconciliation rule)
// ---------------------------------------------------------------------------
//
// "status on a runs row is never asserted directly — it's derived, and on
// supervisor startup that derivation must be re-verified... verify PID +
// process group + start time actually match a live process. If verification
// fails, mark the row `lost` (not silently `finished`)."
//
// This process has just booted with EMPTY in-memory adapter state (fresh
// Maps in claude-code-adapter/adapter.js and opencode-adapter/adapter.js —
// they hold no memory of any run from a previous supervisor process, by
// construction). So EVERY non-terminal row from a previous run of this
// supervisor is, by definition, something this new process has no adapter
// handle for. The only question reconciliation can answer here is: is the
// underlying OS process still verifiably the same one, or not.
async function reconcileOnStartup() {
  let rows;
  try {
    const raw = await fs.readFile(RUNS_STATE_PATH, "utf8");
    rows = JSON.parse(raw);
  } catch {
    log("reconcile: no runs-state.json found, nothing to reconcile");
    return;
  }

  const nonTerminal = ["running", "idle", "interrupted"];
  let lost = 0;
  let orphaned = 0;
  for (const row of rows) {
    if (!nonTerminal.includes(row.status)) {
      registry.set(row.runId, row); // keep terminal rows as-is, restore for `list`
      continue;
    }

    const alive = isPidAlive(row.pid);
    let verified = false;
    if (alive) {
      const currentLstart = await lstartOf(row.pid);
      // Same PID could have been reused by an unrelated process since this
      // supervisor died; lstart is the fingerprint that catches that. Exact
      // string match is intentional — `ps -o lstart=` on macOS is
      // second-granularity and stable for a still-running process across
      // repeated invocations, so an unchanged value IS the verification.
      verified = currentLstart != null && currentLstart === row.lstart;
    }

    if (verified) {
      // The OS process really is still alive and really is the same
      // generation — but this fresh supervisor process has no adapter
      // object bound to it (no stdin handle, no HTTP session cursor). This
      // is deliberately NOT "finished" and NOT re-silently-adopted as
      // "running" either — it is surfaced as a distinct, honest state so a
      // human/TUI knows this run needs manual intervention (attach or kill)
      // rather than either extreme.
      row.status = "orphaned-unmanaged";
      row.reconciledAt = new Date().toISOString();
      orphaned++;
      // CORRECTION (2026-09-05, code review, finding B5): this log line used to say
      // "(pgid/lstart match)". pgid is recorded on the row but never actually
      // compared here — only lstart is checked above. Log only the check that's
      // real. (Also: until B6 is fixed, the recorded pgid is the supervisor's own
      // pgid, not the child's, so comparing it here would currently be meaningless
      // even if added.)
      log(`reconcile: runId=${row.runId} pid=${row.pid} verified ALIVE (lstart match) -> orphaned-unmanaged`);
    } else {
      row.status = "lost";
      row.reconciledAt = new Date().toISOString();
      lost++;
      log(`reconcile: runId=${row.runId} pid=${row.pid} could NOT be verified (alive=${alive}) -> lost`);
    }
    registry.set(row.runId, row);
  }
  await persistState();
  log(`reconcile: done — ${lost} run(s) marked lost, ${orphaned} run(s) marked orphaned-unmanaged`);
}

const SUPERVISOR_STARTED_AT = new Date().toISOString();

async function main() {
  const lockPath = path.join(STATE_DIR, "supervisor.lock");
  const lockResult = await acquireLock(lockPath);
  if (!lockResult.acquired) {
    log(`lock already held by pid=${lockResult.holderPid} (${lockResult.reason}) — refusing to start a second supervisor`);
    process.exit(1);
  }
  log(`acquired lock at ${lockResult.path}`);

  await fs.mkdir(STATE_DIR, { recursive: true });
  await reconcileOnStartup();

  await fs.rm(SOCK_PATH, { force: true });

  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (data) => {
      buf += data.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let cmd;
        try {
          cmd = JSON.parse(line);
        } catch (err) {
          socket.write(JSON.stringify({ ok: false, error: `bad json: ${err.message}` }) + "\n");
          continue;
        }
        dispatch(cmd, socket)
          .then((result) => {
            if (result !== null) socket.write(JSON.stringify(result) + "\n");
          })
          .catch((err) => {
            socket.write(JSON.stringify({ ok: false, cmd: cmd.cmd, error: String(err?.message ?? err) }) + "\n");
          });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCK_PATH, resolve);
  });
  log(`listening on ${SOCK_PATH}`);

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down gracefully`);
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(SOCK_PATH, { force: true });
    await lockResult.release();
    log("released lock, closed socket, exiting");
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error("supervisor fatal error:", err);
    process.exit(1);
  });
}

export { STATE_DIR, SOCK_PATH };
