// _real-claude-crash-victim.mjs — a real supervisor, in its own OS process, running a REAL
// `claude` worker, existing to be SIGKILLed while that worker is PARKED on an approval.
//
// The fake-harness twin of this is `_crash-victim.js` (Group 6). Everything about the shape
// is the same and for the same reasons — SIGKILL cannot be caught, so no `finally`, no
// `closeDb()`, no adapter disposal, no lock release, and an un-checkpointed WAL is left on
// disk. What this one adds is the only thing a fake cannot: that a REAL `claude` process
// survives its supervisor's death, that the OS still reports it as a live process group we
// never owned, and that a request it parked really is unanswerable afterwards.
//
// WHY THE WORKER IS PARKED AT CRASH TIME, rather than merely running. A parked worker is the
// worst case for recovery and the one PLAN.md is most explicit about: the child is blocked
// waiting for an answer on a stdin that died with its parent. Nobody can ever answer it —
// not the restarted supervisor, not a human, not another client — because the pipe is gone.
// So reconciliation closing that ask is CORRECT rather than merely tidy, and this is the
// script that makes that claim testable instead of asserted.
//
// It prints ONE line of JSON on stdout describing what it created, then starts a continuous
// write load and never stops. The parent kills it during that load. Nothing here handles a
// signal, on purpose.
//
// Usage: node _real-claude-crash-victim.mjs <stateDir> <workDir>
// Costs a small real turn (the worker only gets as far as its first tool call).

import {
  openDb,
  upsertHarness,
  createWorker,
  listPendingAsks,
  recordEvent,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import * as claudeCode from "../../adapters/claude-code/adapter.js";
import { readProcInfo } from "../procinfo.js";

const stateDir = process.argv[2];
const workDir = process.argv[3];
if (!stateDir || !workDir) {
  process.stderr.write("_real-claude-crash-victim.mjs: <stateDir> <workDir> are both required\n");
  process.exit(2);
}

const quiet = { log() {}, warn() {}, error() {} };
const fail = (m) => { process.stderr.write(`_real-claude-crash-victim: ${m}\n`); process.exit(2); };

const db = openDb({ stateDir });
upsertHarness(db, { id: "claude-code", displayName: "Claude Code" });
createWorker(db, { workerId: "w1", nickname: "real-victim", role: "worker" });

const supervisor = createSupervisor({
  db,
  adapters: { "claude-code": claudeCode },
  logger: quiet,
});
await supervisor.boot();

// A prompt whose FIRST action must be a tool call the CLI will not permit by itself, so the
// worker parks on us almost immediately and stays parked. WebFetch on a fresh domain is the
// cleanest such class: no sandbox involved and no working-directory rule to trip over
// (adapters/FINDINGS.md — a /tmp cwd produces a workingDir refusal that is never routed to
// the host at all, which sent an earlier probe down the wrong path entirely).
const { runId } = await supervisor.start({
  harnessId: "claude-code",
  workerId: "w1",
  // No taskId: `supervisor.start` does not take one, and migration 0004 made `asks.task_id`
  // nullable precisely because an ask belongs to a RUN. In this slice there is no task.
  spec: {
    prompt: "Use the WebFetch tool on https://example.com and tell me the page title. Do this first, before anything else.",
    cwd: workDir,
  },
});

// Wait for the worker to be genuinely parked. Asserted rather than slept for: a crash that
// lands before the park would prove nothing about a parked request, and would do it silently.
const deadline = Date.now() + 120_000;
let ask;
for (;;) {
  ask = listPendingAsks(db, { runId })[0];
  if (ask) break;
  if (Date.now() > deadline) fail("the real worker never parked a request within 120s");
  await new Promise((r) => setTimeout(r, 250));
}

const row = db.prepare("SELECT pid, process_group, harness_session_id FROM runs WHERE run_id = ?").get(runId);
if (!row?.process_group) fail(`run ${runId} has no verified process group; nothing to orphan`);

// Read the identity back from the OS, so the parent is comparing against what the OS says
// rather than against what we recorded. Pid reuse is the whole reason `reap` re-verifies.
// `readProcInfo` always RESOLVES, with `alive: false` rather than null, so the liveness
// check has to read the field. `if (!proc)` would be true never and pass always.
const proc = await readProcInfo(row.pid);
if (!proc.alive) fail(`the OS does not report pid ${row.pid} as live before the crash`);

process.stdout.write(`${JSON.stringify({
  runId,
  pid: row.pid,
  pgid: row.process_group,
  lstart: proc.lstart,
  harnessSessionId: row.harness_session_id,
  askId: ask.id,
  askKind: ask.kind,
  harnessRequestId: ask.harness_request_id,
})}\n`);

// The continuous write load the parent kills us during: a crash between statements is the
// state the recovery path claims to handle, and a quiescent database would not test it.
//
// Through `recordEvent`, not hand-rolled SQL. The first version of this loop wrote its own
// INSERT with a per-run `seq` subquery and no `tier`, which is wrong twice over —
// `event_log.seq` is a GLOBAL `INTEGER PRIMARY KEY AUTOINCREMENT` (so a per-run maximum
// collides with existing rows) and `tier` is NOT NULL. The victim would have died of its own
// constraint violation immediately after printing the seed line, and the "crash under load"
// this script is named for would have been a crash under nothing.
for (;;) {
  recordEvent(db, { runId, tier: 3, type: "victim.load", payload: { t: Date.now() } });
  await new Promise((r) => setTimeout(r, 5));
}
