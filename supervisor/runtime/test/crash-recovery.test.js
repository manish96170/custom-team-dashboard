// crash-recovery.test.js — Group 6, half one: SIGKILL a real supervisor while it is
// writing, then prove what the database and the recovery path do about it.
//
// TODO.md Group 6: "kill the supervisor under load, confirm no torn writes, confirm
// reconciliation produces the correct one of the three outcomes."
//
// The crash is real: `_crash-victim.js` runs a real supervisor in a separate OS process
// with real detached children and a continuous write load, and is killed with SIGKILL —
// no teardown, no `closeDb()`, no adapter disposal, an un-checkpointed WAL left on disk.
// Its children survive it, because they lead their own process groups; that is what makes
// them `orphaned-unmanaged` rather than a hypothetical.
//
// Cases:
//   1. the crash landed mid-write, on a database with a live WAL (evidence, not assumption)
//   2. no torn writes: integrity_check, foreign keys, every payload parses, every row obeys
//      the terminal-state invariants, nothing committed was lost
//   3. reconciliation after the crash marks the survivors `orphaned-unmanaged` and leaves
//      their rows OPEN, logging a sighting — so they stay visible to every later boot
//   4. ...and `lost` for the run whose process died with the crash
//   5. ...and never `finished`, which the pre-crash completion path had already written and
//      which must survive untouched
//   6. open asks on both reconciled runs are closed (PLAN.md section 4)
//   7. a second boot re-examines the live orphans (a `repeat` sighting), and the `orphans`
//      view lists them by title, pid and age — the query that was impossible before 0003
//   8. an orphan whose process dies gets its real terminal transition: `lost`
//   9. the orphans are reapable after the crash, closing the row as `reaped` + `reaped_at`
//  10. a second reconciliation over a fully resolved database is a no-op
//
// Standing rule (TODO.md Group 6): every case asserts. This script cannot exit 0 with a
// broken claim.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, closeDb, getRun, listOrphanSightings } from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { readProcInfo, isProcessGroupAlive, signalProcessGroup } from "../procinfo.js";
import { killProcessGroup } from "../spawn.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, sleep, waitFor } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VICTIM = path.join(__dirname, "_crash-victim.js");
const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

const TERMINAL_REASONS = new Set(["finished", "errored", "interrupted", "stopped", "reaped", "lost", "orphaned-unmanaged"]);
const DERIVED_REASONS = new Set(["lost", "orphaned-unmanaged"]);

await runTest("crash-recovery", async () => {
  const stateDir = makeScratchDir("supervisor-crash-test");
  const liveGroups = new Set();
  let victim;
  let db;
  let supervisor;
  let harness;

  try {
    // ---- start a real supervisor in its own process, under load ------------------------
    // Plain `spawn`, not spawnManaged: the victim must be at DASHBOARD_SPAWN_DEPTH 0 so its
    // own children land at 1, which is the ceiling (runtime/spawn.js).
    victim = spawn(process.execPath, [VICTIM, stateDir, "3"], { stdio: ["ignore", "pipe", "pipe"] });
    let victimStderr = "";
    victim.stderr.on("data", (c) => { victimStderr += c.toString(); });
    const exited = new Promise((resolve) => victim.on("exit", (code, signal) => resolve({ code, signal })));

    const ready = await readOneJsonLine(victim.stdout, 20000).catch((err) => {
      throw new Error(`${err.message}\nvictim stderr:\n${victimStderr}`);
    });
    assert.equal(ready.ready, true, `victim did not report ready: ${JSON.stringify(ready)}`);
    assert.equal(ready.live.length, 3, "three live runs were expected");
    for (const r of ready.live) {
      assert.ok(Number.isInteger(r.pid) && Number.isInteger(r.pgid), `victim run without an identity: ${JSON.stringify(r)}`);
      assert.equal(r.pgid, r.pid, "each victim child must lead its own process group");
      liveGroups.add(r.pgid);
    }

    // ---- 1. the crash lands mid-write, with a live WAL ---------------------------------
    db = openDb({ stateDir });
    const dbPath = path.join(stateDir, "state.sqlite3");
    const before = countEvents(db);
    const grew = await waitFor(() => {
      const now = countEvents(db);
      return now > before + 30 ? now : null;
    }, { timeoutMs: 15000, pollMs: 25, what: "the victim's write load to be visibly in flight" });
    assert.ok(fs.existsSync(`${dbPath}-wal`), "a WAL file must exist — otherwise this proves nothing about WAL recovery");
    const walBytes = fs.statSync(`${dbPath}-wal`).size;
    assert.ok(walBytes > 0, "the WAL must be non-empty at crash time");
    // Read the count from THIS connection right before the kill: every row it can see is a
    // committed row, so none of them may disappear across the crash.
    const committedBefore = countEvents(db);
    closeDb(db);
    db = null;

    process.kill(victim.pid, "SIGKILL");
    const how = await exited;
    assert.equal(how.signal, "SIGKILL", `the victim must die by SIGKILL, not exit cleanly: ${JSON.stringify(how)}`);
    assert.equal(how.code, null, "a SIGKILLed process has no exit code");
    for (const r of ready.live) {
      assert.equal((await readProcInfo(r.pid)).alive, true, `child ${r.pid} must survive its supervisor — that is the orphan case`);
    }
    console.log(
      `  1. supervisor pid ${ready.supervisorPid} SIGKILLed mid-load (${committedBefore} committed events, ` +
        `${walBytes}-byte WAL left behind, ${ready.live.length} children still alive)`,
    );

    // ---- 2. no torn writes -------------------------------------------------------------
    db = openDb({ stateDir });
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok", "the database must survive SIGKILL intact");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "no dangling foreign keys may survive the crash");

    const events = db.prepare("SELECT seq, run_id, tier, type, payload_json, ts FROM event_log ORDER BY seq").all();
    assert.ok(events.length >= committedBefore, `committed events were lost: ${events.length} < ${committedBefore}`);
    let lastSeq = 0;
    for (const e of events) {
      assert.ok(e.seq > lastSeq, `event_log seq must be strictly increasing (${e.seq} after ${lastSeq})`);
      lastSeq = e.seq;
      assert.ok(e.run_id && e.type && e.ts, `event row ${e.seq} is missing a NOT NULL field`);
      assert.ok(Number.isInteger(e.tier), `event row ${e.seq} has a non-integer tier`);
      // A torn write shows up here: a payload that is not valid JSON is a row that was
      // half-written. SQLite's own atomicity is what makes this hold; asserting it is what
      // turns "SQLite is atomic" from a belief into a checked property of THIS write path.
      if (e.payload_json !== null) JSON.parse(e.payload_json);
    }

    const runs = db.prepare("SELECT * FROM runs").all();
    assert.ok(runs.length >= 4, `expected at least 4 run rows, got ${runs.length}`);
    for (const r of runs) {
      if (r.ended_at === null) {
        assert.equal(r.exit_reason, null, `run ${r.run_id} is open but carries exit_reason "${r.exit_reason}"`);
        assert.ok(Number.isInteger(r.pid), `run ${r.run_id} survived the crash open with no pid — nothing could ever classify it`);
      } else {
        assert.ok(TERMINAL_REASONS.has(r.exit_reason), `run ${r.run_id} closed with an unknown reason "${r.exit_reason}"`);
      }
      if (r.pid !== null) {
        assert.ok(Number.isInteger(r.process_group), `run ${r.run_id} has a pid but no process group`);
        assert.ok(r.proc_lstart, `run ${r.run_id} has a pid but no start time — the pid-reuse guard would be missing`);
      }
      if (r.reconciled_at !== null) {
        assert.ok(DERIVED_REASONS.has(r.exit_reason), `run ${r.run_id} stamps reconciled_at with reason "${r.exit_reason}"`);
      }
    }
    console.log(`  2. after recovery: integrity_check ok, ${events.length} event rows all parse, every run row obeys its invariants`);

    // ---- 3/4/5. reconciliation: orphaned-unmanaged, lost, and never finished ------------
    // Kill one child's group first: that is the run whose process died WITH the crash.
    const lostRun = ready.live[ready.live.length - 1];
    const orphanRuns = ready.live.slice(0, -1);
    await killProcessGroup(lostRun.pgid, { graceMs: 1000 });
    await waitFor(async () => !(await readProcInfo(lostRun.pid)).alive, { timeoutMs: 4000, what: "the lost run's process to be gone" });

    harness = createFakeHarness({ label: "restarted" });
    supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet });
    const boot = await supervisor.boot();

    assert.deepEqual(
      [...boot.rehydrated].sort(),
      [...ready.live.map((r) => r.runId)].sort(),
      "boot must rehydrate exactly the runs the crash left open",
    );
    assert.equal(supervisor.harnessOf(orphanRuns[0].runId), "fake", "routing for a pre-crash run comes from runs.harness_id");
    assert.equal(supervisor.hasHandle(orphanRuns[0].runId), false, "a supervisor that just started holds no handles");

    assert.deepEqual(
      [...boot.reconciliation.orphaned].sort(),
      [...orphanRuns.map((r) => r.runId)].sort(),
      `surviving children must reconcile as orphaned-unmanaged: ${JSON.stringify(boot.reconciliation.details)}`,
    );
    assert.deepEqual(
      boot.reconciliation.lost,
      [lostRun.runId],
      `the run whose process died must reconcile as lost: ${JSON.stringify(boot.reconciliation.details)}`,
    );
    assert.deepEqual(boot.reconciliation.alive, [], "no run can be 'alive and managed' after a crash — no handles exist");
    for (const r of orphanRuns) {
      const row = getRun(db, r.runId);
      // The 0003 model: a verified-alive process is NOT terminal. Closing the row here is what
      // used to make a live orphan invisible to every later boot.
      assert.equal(row.lifecycle, "orphaned-unmanaged", "the orphan must carry the lifecycle state");
      assert.equal(row.ended_at, null, "an orphan is still running, so its row must stay OPEN");
      assert.equal(row.exit_reason, null, "an orphan has no exit reason yet — it has not exited");
      assert.ok(row.reconciled_at, "a derived observation still stamps reconciled_at");
      assert.equal(row.reaped_at, null, "nothing has been killed yet");
      assert.equal(isProcessGroupAlive(row.process_group), true, "orphaned-unmanaged means the process is still running");
      const sightings = listOrphanSightings(db, r.runId);
      assert.equal(sightings.length, 1, `expected exactly one sighting for ${r.runId}, got ${sightings.length}`);
      assert.equal(sightings[0].kind, "new", "the first sighting of a run is a new one");
      assert.equal(sightings[0].pid, r.pid, "the journal records the pid that was seen");
    }
    // And it is visible as an orphan, which is the whole point of the change.
    const listedOpen = supervisor.list();
    for (const r of orphanRuns) {
      const entry = listedOpen.find((e) => e.runId === r.runId);
      assert.ok(entry, `list() must still show the live orphan ${r.runId}`);
      assert.equal(entry.orphaned, true);
      assert.equal(entry.managed, false, "an orphan is by definition unmanaged");
    }
    console.log(`  3. ${orphanRuns.length} surviving children marked orphaned-unmanaged with their rows left OPEN, one sighting each`);

    {
      const row = getRun(db, lostRun.runId);
      assert.equal(row.exit_reason, "lost");
      assert.ok(row.reconciled_at);
      console.log("  4. the run whose process died with the crash reconciled as lost, not orphaned");
    }

    {
      const row = getRun(db, ready.finishedRunId);
      assert.equal(row.exit_reason, "finished", "the pre-crash natural completion must survive the crash");
      assert.equal(row.reconciled_at, null, "`finished` is the adapter's own outcome — reconciliation must not stamp it");
      const derivedFinished = db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE reconciled_at IS NOT NULL AND exit_reason = 'finished'")
        .get().n;
      assert.equal(derivedFinished, 0, "reconciliation may never write `finished` (PLAN.md section 4)");
      console.log("  5. the pre-crash `finished` row is untouched, and no reconciled row claims `finished`");
    }

    // ---- 6. open asks on reconciled runs are closed -------------------------------------
    for (const [label, askId, reason] of [["orphan", ready.asks.orphan, "orphaned-unmanaged"], ["lost", ready.asks.lost, "lost"]]) {
      const ask = db.prepare("SELECT * FROM asks WHERE id = ?").get(askId);
      assert.ok(ask, `ask ${askId} should exist`);
      assert.equal(ask.resolved, 1, `the ${label} run's open ask must be closed, or it blocks its task forever`);
      assert.equal(ask.answered_by, "supervisor:reconciliation");
      assert.match(ask.answer, new RegExp(reason), `the ask's answer should name the outcome: ${ask.answer}`);
    }
    console.log("  6. both open asks were closed by reconciliation, naming the outcome that closed them");

    // ---- 7. a second boot still sees the live orphans, and can list them ---------------
    {
      const asksClosedBefore = db.prepare("SELECT COUNT(*) AS n FROM asks WHERE resolved = 1").get().n;
      const second = await supervisor.boot();
      assert.deepEqual(
        [...second.rehydrated].sort(),
        [...orphanRuns.map((r) => r.runId)].sort(),
        "the live orphans must still be open on the next boot — this is what 0003 fixed",
      );
      assert.deepEqual(second.reconciliation.orphaned, [], "they are not NEWLY orphaned any more");
      assert.deepEqual(
        [...second.reconciliation.stillOrphaned].sort(),
        [...orphanRuns.map((r) => r.runId)].sort(),
        `a repeat sighting must be reported as such: ${JSON.stringify(second.reconciliation.details)}`,
      );
      for (const r of orphanRuns) {
        const sightings = listOrphanSightings(db, r.runId);
        assert.equal(sightings.length, 2, `expected a second sighting for ${r.runId}`);
        assert.equal(sightings[1].kind, "repeat");
      }
      const asksClosedAfter = db.prepare("SELECT COUNT(*) AS n FROM asks WHERE resolved = 1").get().n;
      assert.equal(asksClosedAfter, asksClosedBefore, "a repeat sighting must not re-close already-closed asks");

      const view = supervisor.orphans();
      assert.equal(view.length, orphanRuns.length, `the orphans view must list every live orphan: ${JSON.stringify(view)}`);
      for (const entry of view) {
        assert.ok(entry.title, "each orphan needs something human-readable to identify it by");
        assert.ok(Number.isInteger(entry.pid) && Number.isInteger(entry.processGroup));
        assert.equal(entry.sightings, 2, "the view carries the sighting count from the journal");
        assert.ok(entry.firstSeenAt && entry.lastSeenAt, "first/last seen come from the journal");
        assert.equal(entry.managed, false);
      }
      console.log(`  7. second boot re-examined ${view.length} live orphans (repeat sightings); orphans view lists them by title/pid/age`);
    }

    // ---- 8. an orphan whose process dies transitions to `lost` -------------------------
    {
      const dying = orphanRuns[0];
      await killProcessGroup(dying.pgid, { graceMs: 1000 });
      await waitFor(async () => !(await readProcInfo(dying.pid)).alive, { timeoutMs: 4000, what: "the orphan's process to die" });
      const third = await supervisor.boot();
      assert.deepEqual(third.reconciliation.lost, [dying.runId], `a dead orphan must become lost: ${JSON.stringify(third.reconciliation.details)}`);
      const row = getRun(db, dying.runId);
      assert.equal(row.exit_reason, "lost", "this is the terminal transition an orphan row was waiting for");
      assert.ok(row.ended_at, "and it is finally closed");
      assert.equal(row.lifecycle, "orphaned-unmanaged", "the lifecycle keeps the history of what it was");
      assert.equal(row.reaped_at, null, "we did not kill it; it died on its own");
      assert.equal(supervisor.orphans().length, orphanRuns.length - 1, "a dead orphan drops out of the live-orphan view");
      console.log("  8. an orphan whose process died reconciled to `lost` — the terminal transition, with its history intact");
    }

    // ---- 9. the remaining orphan is reapable, and reap closes the row honestly ---------
    {
      const r = orphanRuns[orphanRuns.length - 1];
      const result = await supervisor.reap(r.runId);
      assert.equal(result.reaped, true, `a post-crash orphan must be reapable: ${JSON.stringify(result)}`);
      assert.equal(result.pgid, r.pgid);
      assert.equal(result.runClosed, true, "the orphan's row was OPEN, so reap is what closes it");
      await waitFor(async () => !(await readProcInfo(r.pid)).alive, { timeoutMs: 4000, what: `orphan ${r.pid} to die` });
      assert.equal(isProcessGroupAlive(r.pgid), false, "nothing may remain in a reaped process group");
      const row = getRun(db, r.runId);
      assert.equal(row.exit_reason, "reaped");
      assert.ok(row.reaped_at, "reaped_at records that WE killed it — history could not say so before 0003");
      assert.equal(row.lifecycle, "orphaned-unmanaged", "the row still remembers it had been orphaned");
      assert.deepEqual(supervisor.orphans(), [], "no live orphans remain");
      console.log("  9. the remaining orphan was reaped: row closed as `reaped`, reaped_at stamped, orphan history kept");
    }

    // ---- 10. recovery is idempotent once everything is resolved ------------------------
    {
      const asksBefore = db.prepare("SELECT COUNT(*) AS n FROM asks WHERE resolved = 1").get().n;
      const sightingsBefore = listOrphanSightings(db).length;
      const final = await supervisor.boot();
      assert.deepEqual(final.rehydrated, [], "nothing should still be open once every run is resolved");
      assert.equal(final.reconciliation.examined, 0, "a reconciliation with nothing open must examine nothing");
      assert.deepEqual(final.reconciliation.lost, []);
      assert.deepEqual(final.reconciliation.orphaned, []);
      assert.deepEqual(final.reconciliation.stillOrphaned, []);
      const asksAfter = db.prepare("SELECT COUNT(*) AS n FROM asks WHERE resolved = 1").get().n;
      assert.equal(asksAfter, asksBefore, "a repeat reconciliation must not touch already-closed asks");
      assert.equal(listOrphanSightings(db).length, sightingsBefore, "and must not append phantom sightings");
      console.log("  10. a second reconciliation over the fully resolved database is a no-op");
    }
  } finally {
    if (victim && victim.exitCode === null && victim.signalCode === null) victim.kill("SIGKILL");
    if (supervisor) await supervisor.shutdown({ timeoutMs: 1500 }).catch(() => {});
    if (harness) await harness.disposeAll().catch(() => {});
    for (const pgid of liveGroups) signalProcessGroup(pgid, "SIGKILL");
    if (db) closeDb(db);
    await sleep(50);
    rmScratchDir(stateDir);
  }
});

function countEvents(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM event_log").get().n;
}

/** Read the victim's single ready line. Rejects loudly rather than hanging the suite. */
function readOneJsonLine(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for the victim's ready line (got: ${JSON.stringify(buf)})`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("close", onClose);
    }
    function onData(chunk) {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      cleanup();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        reject(new Error(`the victim's first stdout line was not JSON: ${JSON.stringify(buf.slice(0, nl))}`));
      }
    }
    function onClose() {
      cleanup();
      reject(new Error(`the victim's stdout closed before it reported ready (got: ${JSON.stringify(buf)})`));
    }
    stream.on("data", onData);
    stream.on("close", onClose);
  });
}
