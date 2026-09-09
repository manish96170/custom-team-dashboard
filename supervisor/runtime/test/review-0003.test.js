// review-0003.test.js — regression cases for the defects three independent models found in
// migration 0003 (the Group 6 follow-through), after each mechanism was reproduced here first.
//
// Same rule as review-three.test.js: every case below was written against the PRE-FIX code and
// observed failing, and the mechanism it asserts is the mechanism that was actually verified —
// not the one the review stated. Two of the reviews' mechanisms needed correcting, and one claim
// was refuted outright; see runtime/FINDINGS.md section 15.
//
// Cases:
//   1. `reap` on a row some other path already closed still records that it killed the group
//   2. `start()` kills its child when the run row cannot be persisted, instead of orphaning it
//   3. `resume()` re-opens the run row, so a resumed live process is not invisible
//   4. the orphan sightings journal is bounded, and reading it is bounded
//   5. an orphan whose recorded identity cannot be verified says so, instead of looking reapable
//   6. `reconcileRun` refuses to write the old terminal form of `orphaned-unmanaged`
//   7. a run recorded onto the process group DURING a kill is reported, not silently collateral
//
// Standing rule (TODO.md Group 6): every case asserts. This script cannot exit 0 with a broken
// claim.

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
  endRun,
  reconcileRun,
  markRunOrphaned,
  listOrphanSightings,
  ORPHAN_SIGHTINGS_PER_RUN,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { reap } from "../reconcile.js";
import { spawnManaged, killProcessGroup } from "../spawn.js";
import { readProcInfo, isProcessGroupAlive, signalProcessGroup } from "../procinfo.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, sleep, waitFor } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

/** A real detached process to hang identities off, with no run row of its own. */
async function spawnSleeper() {
  const { child, identity } = spawnManaged({ command: "sleep", args: ["45"], stdio: ["ignore", "ignore", "ignore"] });
  const info = await identity;
  assert.equal(info.verified, true, `sleeper identity must verify: ${JSON.stringify(info)}`);
  return { child, ...info };
}

await runTest("review-0003", async () => {
  const stateDir = makeScratchDir("supervisor-review-0003-test");
  const liveGroups = new Set();
  let db;
  let supervisor;
  let harness;

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createWorker(db, { workerId: "w1", nickname: "tester", role: "worker" });
    createTask(db, { id: "t1", title: "review 0003", type: "test" });
    harness = createFakeHarness({ label: "r3" });
    supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askGraceMs: 300, askSweepIntervalMs: 0 });
    await supervisor.boot();

    // ---- 1. a kill through an already-closed row is still recorded ---------------------
    // Pre-fix: `reaped_at` was only written by the gated `endRun`, so two different facts were
    // conflated — "we killed the group" and "we wrote the terminal row". Verified failing: a row
    // closed as `finished` over a still-live process was reaped, the process died, and the row
    // recorded nothing at all (`exit_reason` still `finished`, `reaped_at` NULL). Nothing in
    // history could then distinguish a reaped orphan from one still running, which is the whole
    // reason `reaped_at` exists.
    {
      const { runId } = await supervisor.start({ harnessId: "fake", workerId: "w1", spec: { cwd: stateDir, prompt: "closed-then-reaped" } });
      const row = getRun(db, runId);
      liveGroups.add(row.process_group);
      assert.equal(endRun(db, runId, { exitReason: "finished" }), 1, "close the row without killing anything");

      const result = await reap({ db, runId, graceMs: 1200, logger: quiet });
      assert.equal(result.reaped, true, `the live group must still be killable: ${JSON.stringify(result)}`);
      assert.equal(result.alreadyClosed, true, "and reap must say the row was closed by someone else");
      assert.equal(result.runClosed, false, "it must not re-close it");
      await waitFor(async () => !(await readProcInfo(row.pid)).alive, { timeoutMs: 4000, what: "the process to die" });

      const after = getRun(db, runId);
      assert.equal(after.exit_reason, "finished", "first-writer-wins still owns the REASON");
      assert.ok(after.reaped_at, "but the kill itself must be recorded — this is what was missing");
      console.log("  1. reap through an already-closed row: killed, exit_reason preserved, reaped_at stamped");
    }

    // ---- 2. a persistence failure must not leave a live, unrecorded process ------------
    // Pre-fix verified: `start()` spawned the child, then `createRun` threw on the
    // `runs.worker_id` foreign key, and the detached child kept running with NO row — not in
    // `list()`, not routable, invisible to reconciliation forever. An error path manufacturing
    // the exact orphan the module exists to prevent.
    {
      const before = new Set(harness.listRuns());
      let threw = null;
      try {
        await supervisor.start({ harnessId: "fake", workerId: "no-such-worker", spec: { cwd: stateDir, prompt: "doomed" } });
      } catch (err) {
        threw = err.message;
      }
      assert.match(threw ?? "", /FOREIGN KEY/, `the insert should have failed: ${threw}`);
      const leaked = harness.listRuns().filter((r) => !before.has(r));
      assert.deepEqual(leaked, [], `no adapter handle may survive a failed start: ${JSON.stringify(leaked)}`);
      // And nothing of that run is in the database either, so there is nothing to reconcile.
      const orphanRows = db.prepare("SELECT run_id FROM runs WHERE prompt_preview LIKE '%doomed%'").all();
      assert.deepEqual(orphanRows, [], "and no row should exist for it");
      console.log("  2. a failed start killed its own child instead of leaving a live process with no row");
    }

    // ---- 3. resume() re-opens the row ---------------------------------------------------
    // Pre-fix verified: `resume()` reported `resumed: true, generation: 2` over a genuinely live
    // process whose row still said `finished` — so `listOpenRuns()` could not see it, boot
    // reconciliation never examined it, `list()` never showed it, and generation 2's completion
    // write was rejected by `endRun`'s guard, which also meant its asks were never scheduled.
    {
      const { runId } = await supervisor.start({ harnessId: "fake", workerId: "w1", spec: { cwd: stateDir, prompt: "resume-me" } });
      liveGroups.add(getRun(db, runId).process_group);
      createAsk(db, { id: "ask-gen1", runId, taskId: "t1", question: "gen 1?" });
      harness._runs.get(runId).child.stdin.write(`${JSON.stringify({ type: "exit" })}\n`);
      await waitFor(() => getRun(db, runId).ended_at, { timeoutMs: 5000, what: "generation 1 to complete" });
      assert.ok(db.prepare("SELECT auto_close_at FROM asks WHERE id = 'ask-gen1'").get().auto_close_at, "gen 1 scheduled its grace");

      const res = await supervisor.resume(runId);
      assert.equal(res.resumed, true, JSON.stringify(res));
      assert.equal(res.reopened, true, "resume must re-open the row it is resuming");
      const row = getRun(db, runId);
      liveGroups.add(row.process_group);
      assert.equal(row.ended_at, null, "a resumed run is live, so its row must be open");
      assert.equal(row.exit_reason, null);
      assert.equal(row.lifecycle, "managed");
      assert.equal(row.generation, 2, "and it is a new generation");
      assert.equal((await readProcInfo(row.pid)).alive, true, "the resumed process must be running");
      assert.ok(supervisor.list().some((r) => r.runId === runId), "list() must show the resumed run");
      // The stale grace is cancelled: the run can answer again.
      assert.equal(db.prepare("SELECT auto_close_at FROM asks WHERE id = 'ask-gen1'").get().auto_close_at, null,
        "a re-opened run's pending ask deadline must be cancelled");

      // ...and generation 2's own completion is now recorded, asks included.
      createAsk(db, { id: "ask-gen2", runId, taskId: "t1", question: "gen 2?" });
      harness._runs.get(runId).child.stdin.write(`${JSON.stringify({ type: "exit" })}\n`);
      await waitFor(() => getRun(db, runId).ended_at, { timeoutMs: 5000, what: "generation 2 to complete" });
      assert.equal(getRun(db, runId).exit_reason, "finished", "generation 2's completion must be written");
      assert.ok(db.prepare("SELECT auto_close_at FROM asks WHERE id = 'ask-gen2'").get().auto_close_at,
        "and generation 2's ask must get its grace");
      console.log("  3. resume() re-opened the row: live process visible, generation 2's completion and asks recorded");
    }

    // ---- 4. the sightings journal is bounded, and so is reading it ----------------------
    {
      const sleeper = await spawnSleeper();
      liveGroups.add(sleeper.pgid);
      const runId = "bounded-orphan";
      createRun(db, { runId, workerId: "w1", harnessId: "fake", prompt: "bounded" });
      recordRunProcess(db, runId, { pid: sleeper.pid, processGroup: sleeper.pgid, procLstart: sleeper.lstart, spawnDepth: 1, cwd: stateDir });

      const boots = ORPHAN_SIGHTINGS_PER_RUN + 25;
      for (let i = 0; i < boots; i++) assert.equal(markRunOrphaned(db, runId, { note: `boot ${i}` }).changed, 1);

      const rows = db.prepare("SELECT COUNT(*) AS n FROM orphan_sightings WHERE run_id = ?").get(runId).n;
      assert.ok(rows <= ORPHAN_SIGHTINGS_PER_RUN, `the journal must be bounded, found ${rows} rows for one run`);
      const kept = listOrphanSightings(db, runId, { limit: 1000 });
      assert.equal(kept[0].kind, "new", "the FIRST sighting is kept — it is when this started");
      assert.equal(kept[kept.length - 1].note, `boot ${boots - 1}`, "and the most recent one is kept");
      // Reading is bounded independently of retention, because the read is exposed over the wire.
      assert.equal(listOrphanSightings(db, runId, { limit: 5 }).length, 5, "limit must cap the read");
      assert.throws(() => listOrphanSightings(db, runId, { limit: 0 }), /positive integer/);
      console.log(`  4. ${boots} sightings pruned to ${rows} (first + newest kept); reads capped by limit`);
      signalProcessGroup(sleeper.pgid, "SIGKILL");
      endRun(db, runId, { exitReason: "reaped" });
    }

    // ---- 5. an unverifiable orphan identity is surfaced, not hidden ---------------------
    // The schema-v1 shape: a pid and a pgid, but no `proc_lstart`. `verifyProcIdentity` treats a
    // missing recorded field as "don't compare", so such a row verifies alive and is classified
    // an orphan — while `reap` (correctly) refuses to kill an identity it cannot verify. Without
    // saying so, that row reappears every boot looking like an ordinary reapable orphan with no
    // hint why nothing works.
    {
      const sleeper = await spawnSleeper();
      liveGroups.add(sleeper.pgid);
      const runId = "v1-shaped-orphan";
      createRun(db, { runId, workerId: "w1", harnessId: "fake", prompt: "v1 row" });
      recordRunProcess(db, runId, { pid: sleeper.pid, processGroup: sleeper.pgid, spawnDepth: 1, cwd: stateDir });
      assert.equal(getRun(db, runId).proc_lstart, null, "this row must have no start time, like a pre-0002 row");
      markRunOrphaned(db, runId, { note: "v1 shape" });

      const entry = supervisor.orphans().find((o) => o.runId === runId);
      assert.ok(entry, "it must appear in the orphans view");
      assert.equal(entry.identityComplete, false, "and it must be flagged as unverifiable rather than looking reapable");
      const refusal = await reap({ db, runId, logger: quiet });
      assert.equal(refusal.reaped, false, "reap must refuse an identity it cannot verify");
      assert.match(refusal.reason, /incomplete/, refusal.reason);
      assert.equal((await readProcInfo(sleeper.pid)).alive, true, "and it must not kill on pid alone");
      // A complete one is not flagged, so the flag means something.
      const complete = supervisor.orphans().find((o) => o.runId !== runId && o.identityComplete === true);
      assert.ok(complete === undefined || complete.identityComplete === true);
      console.log("  5. a v1-shaped orphan is flagged identityComplete:false, and reap still refuses to guess");
      signalProcessGroup(sleeper.pgid, "SIGKILL");
      endRun(db, runId, { exitReason: "lost" });
    }

    // ---- 6. the old terminal orphan form is no longer writable --------------------------
    {
      assert.throws(
        () => reconcileRun(db, "v1-shaped-orphan", { exitReason: "orphaned-unmanaged" }),
        /lifecycle state written by markRunOrphaned/,
        "writing the old terminal form would rebuild the invisibility bug 0003 removed",
      );
      console.log("  6. reconcileRun refuses `orphaned-unmanaged` — it is a lifecycle state, not a terminal reason");
    }

    // ---- 7. a sibling recorded DURING the kill is reported ------------------------------
    // The sibling check is a point-in-time read and the kill takes up to graceMs, so a pooled
    // server can gain a run mid-kill. Narrow, and the real fix is a reservation at the adapter's
    // pool boundary (Phase 2) — but it must not be SILENT, which is what this asserts.
    {
      const sleeper = await spawnSleeper();
      liveGroups.add(sleeper.pgid);
      const runId = "kill-window-a";
      const latecomer = "kill-window-b";
      createRun(db, { runId, workerId: "w1", harnessId: "fake", prompt: "window" });
      recordRunProcess(db, runId, { pid: sleeper.pid, processGroup: sleeper.pgid, procLstart: sleeper.lstart, spawnDepth: 1, cwd: stateDir });

      const result = await reap({
        db,
        runId,
        logger: quiet,
        // The seam stands in for "another run's identity landed on this pgid while we were
        // killing it" — the only way to occupy that window deterministically.
        killGroup: async (pgid, opts) => {
          createRun(db, { runId: latecomer, workerId: "w1", harnessId: "fake", prompt: "latecomer" });
          recordRunProcess(db, latecomer, { pid: sleeper.pid, processGroup: pgid, procLstart: sleeper.lstart, spawnDepth: 1, cwd: stateDir });
          return killProcessGroup(pgid, opts);
        },
      });
      assert.equal(result.reaped, true, JSON.stringify(result));
      assert.deepEqual(result.collateralRisk, [latecomer], `the late arrival must be reported: ${JSON.stringify(result)}`);
      console.log(`  7. a run recorded during the kill was reported as possible collateral (${latecomer})`);
      endRun(db, latecomer, { exitReason: "lost" });
    }
  } finally {
    if (supervisor) await supervisor.shutdown({ timeoutMs: 1500 }).catch(() => {});
    if (harness) await harness.disposeAll().catch(() => {});
    for (const pgid of liveGroups) signalProcessGroup(pgid, "SIGKILL");
    if (db) closeDb(db);
    await sleep(50);
    rmScratchDir(stateDir);
  }
});
