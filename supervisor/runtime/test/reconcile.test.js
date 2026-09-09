// reconcile.test.js — startup reconciliation's three-state model and the real `reap`
// command, against the REAL schema and REAL OS processes (TODO.md Group 5).
//
// Nothing here is simulated: every case spawns an actual detached process through
// runtime/spawn.js, records the identity the OS reports back, and then asks
// reconciliation what it makes of it. The two cases that matter most are the two
// REFUSALS, because both are refusals to kill something:
//
//   - pid reuse: a recorded pid that is alive again as an unrelated process. Verified
//     here by corrupting only `proc_lstart` and then asserting the live process is STILL
//     ALIVE after both reconciliation and reap have run. Without migration 0002's
//     proc_lstart column this is undetectable, and reap kills a stranger.
//   - shared process group: `opencode serve` is pooled per cwd, so several runs record
//     one pgid. Asserted by giving two open runs the same pgid and checking reap kills
//     nothing at all.
//
// And the invariant PLAN.md states outright: reconciliation never writes `finished`.

import assert from "node:assert/strict";
import {
  openDb,
  closeDb,
  upsertHarness,
  createWorker,
  createTask,
  createRun,
  createAsk,
  recordRunProcess,
  getRun,
  listOpenRuns,
  reconcileRun,
  markRunOrphaned,
  endRun,
} from "../../db/index.js";
import { spawnManaged } from "../spawn.js";
import { readProcInfo, isProcessGroupAlive, signalProcessGroup } from "../procinfo.js";
import { reconcileOnBoot, reap, classifyRun } from "../reconcile.js";
import { makeScratchDir, rmScratchDir, runTest, sleep, waitFor } from "./_helpers.js";

let runSeq = 0;

/** Spawn a real long-lived detached process and return its OS-verified identity. */
async function spawnSleeper() {
  const { child, identity } = spawnManaged({ command: "sleep", args: ["30"], stdio: ["ignore", "ignore", "ignore"] });
  const info = await identity;
  assert.equal(info.verified, true, `sleeper identity must verify: ${JSON.stringify(info)}`);
  assert.equal(info.pgid, info.pid, "sleeper must lead its own process group");
  return { child, ...info };
}

/** A run row with a real process behind it. Returns { runId, identity }. */
async function seedRunWithProcess(db, { lstartOverride, pgidOverride, harnessId = "claude-code" } = {}) {
  const runId = `run-${++runSeq}`;
  createRun(db, { runId, workerId: "w1", harnessId, prompt: "test" });
  const sleeper = await spawnSleeper();
  recordRunProcess(db, runId, {
    pid: sleeper.pid,
    processGroup: pgidOverride ?? sleeper.pgid,
    procLstart: lstartOverride ?? sleeper.lstart,
    spawnDepth: 1,
    cwd: process.cwd(),
  });
  return { runId, sleeper };
}

await runTest("reconcile", async () => {
  const stateDir = makeScratchDir("supervisor-reconcile-test");
  const spawned = [];
  let db;
  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "claude-code", displayName: "Claude Code" });
    upsertHarness(db, { id: "opencode", displayName: "OpenCode" });
    createWorker(db, { workerId: "w1", nickname: "tester", role: "worker" });
    createTask(db, { id: "t1", title: "reconcile test", type: "test" });

    // ---- 1. verified alive + no adapter handle => orphaned-unmanaged, and reap kills it --
    {
      const { runId, sleeper } = await seedRunWithProcess(db);
      spawned.push(sleeper);
      createAsk(db, { id: `ask-${runId}`, runId, taskId: "t1", question: "may I?" });

      const summary = await reconcileOnBoot({ db, hasHandle: () => false, logger: { log() {}, warn() {} } });
      assert.deepEqual(summary.orphaned, [runId], `expected ${runId} orphaned, got ${JSON.stringify(summary)}`);
      assert.deepEqual(summary.lost, [], "a live, verified process must not be called lost");

      const row = getRun(db, runId);
      // Migration 0003: `orphaned-unmanaged` is a lifecycle STATE on a still-open row, not a
      // terminal exit reason. Closing the row here (as this used to) made a live unmanaged
      // process invisible to every later boot, since reconciliation only reads open rows.
      assert.equal(row.lifecycle, "orphaned-unmanaged");
      assert.equal(row.ended_at, null, "an orphan is still RUNNING — its row must stay open");
      assert.equal(row.exit_reason, null, "it has not exited, so it has no exit reason yet");
      assert.ok(row.reconciled_at, "reconciled_at distinguishes a derived observation from the adapter's own completion");
      const ask = db.prepare("SELECT * FROM asks WHERE run_id = ?").get(runId);
      assert.equal(ask.resolved, 1, "an orphaned run must close its open asks, or a task blocks forever");
      assert.equal(ask.answered_by, "supervisor:reconciliation");

      // The process is still running at this point -- that is what `orphaned-unmanaged`
      // MEANS, and detecting it was all the spike ever did. Now actually reap it.
      assert.equal(isProcessGroupAlive(sleeper.pgid), true, "orphan must still be alive before reap");
      const result = await reap({ db, runId, graceMs: 1500, logger: { log() {}, warn() {} } });
      assert.equal(result.reaped, true, `reap must kill the orphan's group: ${JSON.stringify(result)}`);
      assert.equal(result.pgid, sleeper.pgid);
      await waitFor(async () => !(await readProcInfo(sleeper.pid)).alive, { timeoutMs: 3000, what: "orphan process to be gone" });
      assert.equal(isProcessGroupAlive(sleeper.pgid), false, "reap must leave nothing in the group");
      // The terminal transition an orphan row waits for: reap is what finally closes it.
      const afterReap = getRun(db, runId);
      assert.equal(afterReap.exit_reason, "reaped");
      assert.ok(afterReap.reaped_at, "reaped_at records that WE killed it, not that it died");
      assert.equal(afterReap.lifecycle, "orphaned-unmanaged", "and the row keeps the record of having been orphaned");
      console.log(`  1. orphaned-unmanaged detected (row left open), then reaped (pgid ${sleeper.pgid} gone, row closed)`);
    }

    // ---- 2. process genuinely gone => lost ---------------------------------------------
    {
      const { runId, sleeper } = await seedRunWithProcess(db);
      signalProcessGroup(sleeper.pgid, "SIGKILL");
      await waitFor(async () => !(await readProcInfo(sleeper.pid)).alive, { timeoutMs: 3000, what: "sleeper to die" });

      const summary = await reconcileOnBoot({ db, hasHandle: () => false, logger: { log() {}, warn() {} } });
      assert.deepEqual(summary.lost, [runId], `expected ${runId} lost, got ${JSON.stringify(summary.details)}`);
      assert.equal(getRun(db, runId).exit_reason, "lost");
      console.log("  2. dead process classified lost");
    }

    // ---- 3. pid reuse: recorded lstart no longer matches => lost, and NOTHING is killed --
    {
      const { runId, sleeper } = await seedRunWithProcess(db, {
        lstartOverride: "Mon Jan  1 00:00:00 2001", // as if the pid had been reused
      });
      spawned.push(sleeper);

      const classification = await classifyRun(getRun(db, runId), { hasHandle: () => false });
      assert.equal(classification.outcome, "lost", "a start-time mismatch is a different process, so the run is lost");
      assert.match(classification.reason, /pid reuse/, `reason must name the pid-reuse case: ${classification.reason}`);

      const summary = await reconcileOnBoot({ db, hasHandle: () => false, logger: { log() {}, warn() {} } });
      assert.deepEqual(summary.lost, [runId]);
      assert.equal(
        isProcessGroupAlive(sleeper.pgid),
        true,
        "reconciliation must not touch the live process that happens to hold the recorded pid",
      );

      // Reap must refuse for the same reason, and leave the stranger alone.
      const result = await reap({ db, runId, logger: { log() {}, warn() {} } });
      assert.equal(result.reaped, false, "reap must refuse when the recorded start time does not match");
      assert.match(result.reason, /pid reuse/, `refusal must name the reason: ${result.reason}`);
      await sleep(150);
      assert.equal(
        (await readProcInfo(sleeper.pid)).alive,
        true,
        "THE WHOLE POINT: the live process under the reused pid must survive the reap",
      );
      console.log("  3. pid-reuse guard: run marked lost, the live stranger left untouched by both reconcile and reap");
      signalProcessGroup(sleeper.pgid, "SIGKILL");
    }

    // ---- 4. verified alive AND still bound to a handle => reconciliation leaves it alone --
    {
      const { runId, sleeper } = await seedRunWithProcess(db);
      spawned.push(sleeper);
      const summary = await reconcileOnBoot({ db, hasHandle: (id) => id === runId, logger: { log() {}, warn() {} } });
      assert.deepEqual(summary.alive, [runId], `a healthy in-flight run must be left alone: ${JSON.stringify(summary)}`);
      const row = getRun(db, runId);
      assert.equal(row.ended_at, null, "reconciliation must not close a run it can still see a handle for");
      assert.equal(row.exit_reason, null);
      console.log("  4. live run with an adapter handle left open and untouched");
      signalProcessGroup(sleeper.pgid, "SIGKILL");
      // Leave it closed so it doesn't pollute later cases' open-run set.
      reconcileRun(db, runId, { exitReason: "lost" });
    }

    // ---- 5. no recorded identity => lost, no kill attempted ----------------------------
    {
      const runId = `run-${++runSeq}`;
      createRun(db, { runId, workerId: "w1", harnessId: "claude-code", prompt: "never spawned" });
      const summary = await reconcileOnBoot({ db, hasHandle: () => false, logger: { log() {}, warn() {} } });
      assert.deepEqual(summary.lost, [runId]);
      assert.match(summary.details.find((d) => d.runId === runId).reason, /no process identity/);
      console.log("  5. run with no recorded pid classified lost");
    }

    // ---- 6. shared process group: refusals, and the all-orphan escape hatch ------------
    {
      // Three runs on one pooled `opencode serve`: same pid/pgid/lstart, all open. Three rather
      // than two because each sub-case below needs at least one OTHER open row on the pgid for
      // the group to still count as shared.
      const sleeper = await spawnSleeper();
      spawned.push(sleeper);
      const runA = `run-${++runSeq}`;
      const runB = `run-${++runSeq}`;
      const runC = `run-${++runSeq}`;
      for (const runId of [runA, runB, runC]) {
        createRun(db, { runId, workerId: "w1", harnessId: "opencode", prompt: "pooled" });
        recordRunProcess(db, runId, {
          pid: sleeper.pid,
          processGroup: sleeper.pgid,
          procLstart: sleeper.lstart,
          spawnDepth: 1,
          cwd: "/tmp/shared-cwd",
        });
      }

      // (a) managed run, handle held: end just this session, kill nothing.
      let stoppedSession = null;
      const result = await reap({
        db,
        runId: runA,
        // `hasHandle` is load-bearing now: a session can only be ENDED through a handle we hold.
        // Passing no handle used to still call `adapterStop`, i.e. ask an adapter to stop a run it
        // had never heard of — which throws on Claude Code and silently "succeeds" on OpenCode,
        // and the silent case closed the row over a live session.
        hasHandle: (id) => id === runA,
        adapterStop: (id) => {
          stoppedSession = id;
        },
        logger: { log() {}, warn() {} },
      });
      assert.equal(result.reaped, false, "reap must refuse to kill a shared process group");
      assert.match(result.reason, /shared/, `refusal must name the reason: ${result.reason}`);
      assert.deepEqual([...result.sharedWith].sort(), [runB, runC].sort());
      assert.equal(result.hadHandle, true);
      assert.equal(stoppedSession, runA, "instead of killing the group, reap must end just this session");
      assert.equal(result.runClosed, true, "the reaped run is still closed out");
      assert.equal(getRun(db, runB).ended_at, null, "the sibling runs must stay open");
      assert.equal(
        (await readProcInfo(sleeper.pid)).alive,
        true,
        "THE WHOLE POINT: the pooled server shared with sibling runs must survive",
      );

      // (b) no handle: reap must not claim to have ended a session it could not touch.
      {
        let called = false;
        const noHandle = await reap({
          db,
          runId: runB,
          hasHandle: () => false,
          adapterStop: () => {
            called = true;
          },
          logger: { log() {}, warn() {} },
        });
        assert.equal(noHandle.sessionEnded, false, "no handle means no session end is possible");
        assert.equal(noHandle.hadHandle, false);
        assert.equal(called, false, "and the adapter must not be asked to stop a run it does not know");
        assert.equal(getRun(db, runB).ended_at, null, "so the row must stay open rather than be closed over a live session");
      }

      // (c) the deadlock, and the escape hatch. Since migration 0003 an orphan's row stays OPEN,
      // so two orphans sharing a pooled pgid are each other's live sibling — and after a restart
      // there is no handle to end a session with, so both refusals stood forever and the pooled
      // process could never be killed by anything. When EVERY run on the group is an unmanaged
      // orphan there is no session left to protect, so the group is killed and all of them close.
      assert.equal(markRunOrphaned(db, runB).changed, 1);
      assert.equal(markRunOrphaned(db, runC).changed, 1);
      const escape = await reap({ db, runId: runB, graceMs: 1500, hasHandle: () => false, logger: { log() {}, warn() {} } });
      assert.equal(escape.reaped, true, `an all-orphan group must be killable: ${JSON.stringify(escape)}`);
      assert.equal(escape.allOrphanGroup, true);
      assert.deepEqual(escape.alsoClosed, [runC], "every row on the group closes, not just the one asked about");
      for (const id of [runB, runC]) {
        const r = getRun(db, id);
        assert.equal(r.exit_reason, "reaped", `${id} must be booked as reaped`);
        assert.ok(r.reaped_at, `${id} must record when it was killed`);
      }
      await waitFor(async () => !(await readProcInfo(sleeper.pid)).alive, { timeoutMs: 4000, what: "the all-orphan pooled server to die" });
      console.log("  6. shared group: refused with a handle (session ended), refused without one, all-orphan group killed");
    }

    // ---- 7. `finished` is never written by reconciliation ------------------------------
    {
      const finishedRows = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE exit_reason = 'finished'").get().n;
      assert.equal(finishedRows, 0, "reconciliation must never write `finished` (PLAN.md section 4)");
      // Since 0003 a reconciled row's exit_reason is whatever finally ENDED it — `lost` when the
      // process died, `reaped`/`stopped` when we killed it — while `orphaned-unmanaged` lives in
      // `lifecycle`. What must never appear here is `finished`.
      const reconciledReasons = db
        .prepare("SELECT DISTINCT exit_reason AS r FROM runs WHERE reconciled_at IS NOT NULL")
        .all()
        .map((row) => row.r)
        .sort();
      assert.ok(reconciledReasons.length > 0, "some rows must have been reconciled by now");
      for (const r of reconciledReasons) {
        assert.ok(["lost", "reaped", "stopped"].includes(r), `unexpected reconciled exit_reason "${r}"`);
      }
      // A row reconciled straight to `lost` was never an orphan, so it keeps `lifecycle:
      // 'managed'` — the two fields answer different questions ("how did it end" vs "was its
      // process ever observed running unmanaged"), which is the distinction 0003 introduced.
      const lifecycles = db
        .prepare("SELECT DISTINCT lifecycle AS l FROM runs WHERE reconciled_at IS NOT NULL")
        .all()
        .map((x) => x.l)
        .sort();
      assert.deepEqual(lifecycles, ["managed", "orphaned-unmanaged"], `unexpected lifecycles: ${lifecycles}`);
      const orphanedThenLost = db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE lifecycle = 'orphaned-unmanaged' AND ended_at IS NOT NULL")
        .get().n;
      assert.ok(orphanedThenLost > 0, "at least one orphan must have reached a terminal state in this test");
      assert.throws(
        () => reconcileRun(db, "run-1", { exitReason: "finished" }),
        /must be "lost"/,
        "the writer itself must refuse `finished`",
      );
      // ...and, since 0003, must also refuse the OLD terminal form of the orphan outcome. That
      // form was still writable and would close the row of a verified-live process, rebuilding
      // exactly the invisibility bug 0003 removed (verified reachable before this guard).
      assert.throws(
        () => reconcileRun(db, "run-1", { exitReason: "orphaned-unmanaged" }),
        /lifecycle state written by markRunOrphaned/,
        "`orphaned-unmanaged` is a lifecycle state, not a terminal reason",
      );
      assert.equal(listOpenRuns(db).length, 0, "every seeded run should be closed by now");
      console.log("  7. `finished` never written; reconciled rows only ever lost/orphaned-unmanaged");
    }
  } finally {
    // Never leave a real detached process behind, whatever failed above.
    for (const s of spawned) {
      if (Number.isInteger(s?.pgid)) signalProcessGroup(s.pgid, "SIGKILL");
    }
    if (db) closeDb(db);
    rmScratchDir(stateDir);
  }
});
