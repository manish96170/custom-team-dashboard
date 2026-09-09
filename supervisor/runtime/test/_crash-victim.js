// _crash-victim.js — a real supervisor process, in a real OS process, that exists to be
// SIGKILLed while it is writing (TODO.md Group 6).
//
// Why a separate process at all: SIGKILL is the only crash shape that proves anything
// about persistence. It cannot be caught, so no `finally`, no teardown path, no
// `closeDb()`, no adapter disposal, and no lock release runs — which is exactly the state
// the recovery path claims to handle. An in-process test can simulate "the handles are
// gone" (integration.test.js case 8 does, with `_forgetAllHandles`), but it cannot
// simulate "the writer died mid-statement with a WAL that was never checkpointed".
//
// What it does, in order:
//   1. opens the real database in `stateDir` and seeds the rows a run needs
//   2. starts `runCount` runs through the real supervisor and the real spawn path, so each
//      child is detached and leads its own process group — meaning the children SURVIVE
//      this process being killed, which is what makes them `orphaned-unmanaged` afterwards
//   3. ends one extra run through the adapter's own completion path, so the database holds
//      one row closed as `finished` before the crash (the value reconciliation must never
//      write and must never overwrite)
//   4. leaves two `asks` unresolved, on a run that will be orphaned and on one that will be
//      lost — PLAN.md section 4 says both must be closed by reconciliation
//   5. prints ONE line of JSON on stdout describing all of it, then starts a continuous
//      write load and never stops
//
// The parent kills it during step 5. Nothing here handles a signal on purpose.
//
// Usage: node _crash-victim.js <stateDir> [runCount]

import {
  openDb,
  upsertHarness,
  createWorker,
  createTask,
  createAsk,
  getRun,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";

const stateDir = process.argv[2];
const runCount = Number(process.argv[3] ?? 3);
if (!stateDir) {
  process.stderr.write("_crash-victim.js: a stateDir argument is required\n");
  process.exit(2);
}

const quiet = { log() {}, warn() {}, error() {} };

function fail(message) {
  process.stderr.write(`_crash-victim: ${message}\n`);
  process.exit(2);
}

const db = openDb({ stateDir });
upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
createWorker(db, { workerId: "w1", nickname: "victim", role: "worker" });
createTask(db, { id: "t1", title: "crash victim task", type: "feature" });

const harness = createFakeHarness({ label: "victim" });
const supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet });
await supervisor.boot();

// ---- runs that will still be alive when this process is killed -------------------------
const live = [];
for (let i = 0; i < runCount; i++) {
  const { runId, identity } = await supervisor.start({
    harnessId: "fake",
    workerId: "w1",
    spec: { cwd: stateDir, prompt: `victim run ${i}` },
  });
  if (!identity?.verified) fail(`run ${runId} started with an unverified identity (${identity?.reason})`);
  live.push({ runId, pid: identity.pid, pgid: identity.pgid, lstart: identity.lstart });
}

// ---- one run closed as `finished` by the adapter's own completion path -----------------
const finished = await supervisor.start({
  harnessId: "fake",
  workerId: "w1",
  spec: { cwd: stateDir, prompt: "complete before the crash" },
});
harness._runs.get(finished.runId).child.stdin.write(`${JSON.stringify({ type: "exit" })}\n`);
{
  const deadline = Date.now() + 5000;
  for (;;) {
    const row = getRun(db, finished.runId);
    if (row?.ended_at) {
      if (row.exit_reason !== "finished") fail(`the pre-crash run closed as "${row.exit_reason}", expected "finished"`);
      break;
    }
    if (Date.now() >= deadline) fail("the pre-crash run never completed through the adapter path");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---- open asks that reconciliation must close ------------------------------------------
createAsk(db, { id: "ask-orphan", runId: live[0].runId, taskId: "t1", question: "may I proceed?" });
createAsk(db, { id: "ask-lost", runId: live[live.length - 1].runId, taskId: "t1", question: "and me?" });

process.stdout.write(
  `${JSON.stringify({
    ready: true,
    supervisorPid: process.pid,
    live,
    finishedRunId: finished.runId,
    asks: { orphan: "ask-orphan", lost: "ask-lost" },
  })}\n`,
);

// ---- continuous write load, until killed ----------------------------------------------
// Every input produces three events, each a separate INSERT, so the SIGKILL lands with
// writes in flight rather than on an idle database. Errors are ignored: this process is
// expected to die abruptly, and a half-written turn is the point.
setInterval(() => {
  for (const { runId } of live) {
    supervisor.sendInput(runId, `load ${Date.now()}`).catch(() => {});
  }
}, 10);
