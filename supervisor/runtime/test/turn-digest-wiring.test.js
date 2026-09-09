// turn-digest-wiring.test.js — tier 2 WIRED INTO THE SUPERVISOR (PLAN.md section 8, Rule 4).
//
// WHY A SEPARATE SUITE FROM `domain/test/turn-digest.test.js`
//
// That one proves the digester: pure, no database, no process. This one proves the only thing it cannot
// — that the digester is actually CALLED, on the real event path, against a real child process, and that
// its failures cannot cost anything that matters.
//
// The distinction is not academic. The Phase 3-5 review found three defects that all had the same shape:
// a function that was correct and tested, and a call site that never reached it (FINDINGS §27.5, §28.4,
// §30.2). "The tier exists" and "the tier's module exists" are different claims, and only the second one
// is provable without a running supervisor.
//
// Cases:
//   1. a tier-2 `turn.digest` row is written at `turn.end`, and it summarises THAT turn
//   2. a second turn gets its own digest — one per turn, not one per run
//   3. a REPLAY does not duplicate a digest (the `resume()` path re-persists the whole buffered log)
//   4. a digester that throws costs the digest and nothing else: tier 1 survives, the run survives
//   5. `digestTurns: false` writes none at all, and tier 1 is untouched — the escape hatch works
//   6. tier 2 never contaminates tier 1: every digest row is tier 2, and no tier-1 row is a digest
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import {
  openDb, closeDb, upsertHarness, createWorker, createTask, listTurnDigests, getRun,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, waitFor, sleep } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

const tier1Count = (db, runId) =>
  db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE run_id = ? AND tier = 1").get(runId).n;

await runTest("tier-2 digest wiring", async () => {
  const stateDir = makeScratchDir("supervisor-digest-wiring-test");
  let db;
  const supervisors = [];

  /** A supervisor plus its own harness instance, tracked for teardown. */
  function makeSupervisor(opts = {}) {
    const harness = createFakeHarness({ label: "digest" });
    const s = createSupervisor({ db, adapters: { fake: harness }, askSweepIntervalMs: 0, logger: quiet, ...opts });
    supervisors.push({ s, harness });
    return s;
  }

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake" });
    createTask(db, { id: "t1", title: "digest wiring", type: "feature" });
    for (const w of ["w1", "w2", "w3", "w4"]) {
      createWorker(db, { workerId: w, nickname: w, role: "coder", taskId: "t1" });
    }

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    const sup = makeSupervisor();
    await sup.boot();
    let runId;
    {
      ({ runId } = await sup.start({ harnessId: "fake", workerId: "w1", spec: { cwd: stateDir, prompt: "first" } }));
      await waitFor(() => listTurnDigests(db, runId).length >= 1,
        { timeoutMs: 8000, pollMs: 50, what: "a tier-2 digest to be written at turn.end" });

      const [d] = listTurnDigests(db, runId);
      assert.equal(d.turnIndex, 0, "the first turn is turn 0");
      assert.equal(d.source, "extractive", "the default digester is the extractive one — free, and cannot invent");
      assert.ok(d.turnKey, "with a content key, which is what makes a replay recognisable as the same turn");
      // The digest is OF THAT TURN, not a generic string: the fake child echoes its prompt.
      assert.ok(d.summary.includes("echo:first"),
        `the digest must summarise the turn that ended; got: ${JSON.stringify(d.summary)}`);
      assert.deepEqual(d.assumptions, [], "and the extractive digester states no assumptions");
      console.log("  1. a tier-2 digest was written at turn.end and summarises that turn");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    // Rule 4 says "per turn". A digest written once per RUN would look identical on a one-turn run,
    // which is every run in most of this project's suites.
    {
      await sup.sendInput(runId, "second");
      await waitFor(() => listTurnDigests(db, runId).length >= 2,
        { timeoutMs: 8000, pollMs: 50, what: "the second turn to be digested" });
      const ds = listTurnDigests(db, runId);
      assert.equal(ds.length, 2, `one digest per turn; got ${ds.length}`);
      assert.deepEqual(ds.map((d) => d.turnIndex), [0, 1], "indexed in order");
      assert.ok(ds[1].summary.includes("echo:second"), "and the second digest is of the second turn");
      assert.notEqual(ds[0].turnKey, ds[1].turnKey, "two different turns have two different keys");
      console.log("  2. each turn got its own digest, in order");
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    // The case `turnIndex` alone cannot handle. `resume()` resets the pump and re-observes, so the
    // adapter's whole buffered log is replayed and re-persisted — one real turn then occupies two slices
    // of `event_log`, and an index-keyed digest would be written a second time. That duplicate reaches
    // tier 3 as a second worker stating the same assumption: duplication that inflates evidence.
    {
      const before = listTurnDigests(db, runId);
      const tier1Before = tier1Count(db, runId);

      // Ended through the CHILD's own exit rather than `stop()`: `stop()` forgets the run in the
      // adapter, and a forgotten run cannot be resumed — which is the same reason approval.test.js
      // case 10 ends its process this way.
      const { harness } = supervisors[0];
      harness._runs.get(runId).child.stdin.write(`${JSON.stringify({ type: "exit" })}\n`);
      await waitFor(() => db.prepare("SELECT ended_at FROM runs WHERE run_id = ?").get(runId).ended_at,
        { timeoutMs: 8000, pollMs: 50, what: "the run to end so it can be resumed" });
      const resumed = await sup.resume(runId);
      assert.equal(resumed.resumed, true, "precondition: the fake harness supports resume");

      // The resumed child runs a turn of its own, so wait for the log to have grown rather than for a
      // fixed count — otherwise this asserts on a race instead of on the replay.
      await waitFor(() => tier1Count(db, runId) > tier1Before,
        { timeoutMs: 8000, pollMs: 50, what: "the replayed log to be re-persisted" });
      await waitFor(() => listTurnDigests(db, runId).length > before.length,
        { timeoutMs: 8000, pollMs: 50, what: "the resumed run's own turn to be digested" });
      await sleep(400); // and give any duplicate a chance to appear, rather than only proving it is slow

      const after = listTurnDigests(db, runId);
      const shown = after.map((d) => `turn ${d.turnIndex} key ${d.turnKey}: ${d.summary.slice(0, 60)}`).join("\n       ");

      // ON THE CONTENT, not on the key. Asserting that the keys are distinct is VACUOUS -- it is true
      // whenever the keying is broken, since a duplicate that got past the guard did so by having a
      // different key. The first version of this case asserted exactly that and passed while `echo:first`
      // was digested twice (the replay seam prefixed the slice with the previous session's last events,
      // so the whole-slice hash differed). Same trap as FINDINGS section 24.3: an assertion that can only
      // fail when the mechanism it checks is already working.
      const summaries = after.map((d) => d.summary);
      assert.deepEqual([...new Set(summaries)], summaries,
        `no turn may be digested twice; a replayed turn is the SAME turn. Digests:\n       ${shown}`);
      for (const d of before) {
        assert.equal(after.filter((x) => x.summary === d.summary).length, 1,
          `the turn digested before the resume must still have exactly ONE digest. Digests:\n       ${shown}`);
        assert.equal(after.filter((x) => x.turnKey === d.turnKey).length, 1,
          `and be recognised by its key across the replay (key ${d.turnKey})`);
      }
      assert.ok(after.some((d) => d.summary.includes("echo:resumed")),
        "while the resumed process's OWN new turn was digested — de-duplication must not become 'stop digesting'");
      console.log(`       ${shown}`);
      console.log(`  3. a replay re-persisted tier 1 but produced no duplicate digest (${after.length} digests, all distinct)`);
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    // Tier 2 is a convenience for whoever reads the run later; tier 1 is the record of what happened.
    // Trading the second for the first would be the wrong direction, so a broken digester must cost
    // exactly one missing summary.
    {
      let calls = 0;
      const broken = makeSupervisor({
        digester: () => { calls += 1; throw new Error("digester exploded"); },
      });
      await broken.boot();
      const { runId: badRun } = await broken.start({
        harnessId: "fake", workerId: "w2", spec: { cwd: stateDir, prompt: "boom" },
      });
      await waitFor(() => calls > 0, { timeoutMs: 8000, pollMs: 50, what: "the broken digester to be called" });
      await sleep(300);

      assert.deepEqual(listTurnDigests(db, badRun), [], "no digest, which is the correct outcome of a failed digest");
      assert.ok(tier1Count(db, badRun) > 0, "but tier 1 was persisted anyway — the transcript is not the digest's hostage");
      assert.equal(getRun(db, badRun).ended_at, null, "and the run is still alive");
      // Still serving: a hook that poisoned the pump would show up as a run that stops recording.
      await broken.sendInput(badRun, "still working");
      const n1 = tier1Count(db, badRun);
      await waitFor(() => tier1Count(db, badRun) > n1,
        { timeoutMs: 8000, pollMs: 50, what: "the run to keep persisting after a digest failure" });
      console.log("  4. a throwing digester cost the digest and nothing else");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    // The escape hatch has to actually switch the tier off — a flag that is read but not obeyed is worse
    // than no flag, because it is believed.
    {
      const off = makeSupervisor({ digestTurns: false });
      await off.boot();
      const { runId: quietRun } = await off.start({
        harnessId: "fake", workerId: "w3", spec: { cwd: stateDir, prompt: "no digests please" },
      });
      await waitFor(() => tier1Count(db, quietRun) > 0,
        { timeoutMs: 8000, pollMs: 50, what: "the run to produce tier-1 events" });
      await sleep(400); // long enough that a digest would have been written if one were going to be
      assert.deepEqual(listTurnDigests(db, quietRun), [], "digestTurns: false must write no tier-2 rows");
      assert.ok(tier1Count(db, quietRun) > 0, "while tier 1 is unaffected");
      console.log("  5. digestTurns: false wrote no digests and left tier 1 alone");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    // The two tiers share one table, which is Rule 4's design — so the tier column is the only thing
    // keeping "raw events for humans" apart from "summaries for agents". Several suites count tier-1
    // rows exactly, and a digest written with the wrong tier would corrupt that arithmetic silently.
    {
      const mixedTiers = db.prepare("SELECT DISTINCT tier FROM event_log WHERE type = 'turn.digest'").all().map((r) => r.tier);
      assert.deepEqual(mixedTiers, [2], `every turn.digest row must be tier 2; found tiers ${JSON.stringify(mixedTiers)}`);
      const digestInTier1 = db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE tier = 1 AND type = 'turn.digest'").get().n;
      assert.equal(digestInTier1, 0, "and no tier-1 row is a digest");
      const nonDigestTier2 = db.prepare("SELECT DISTINCT type FROM event_log WHERE tier = 2 AND type <> 'turn.digest'").all();
      assert.deepEqual(nonDigestTier2, [], "nothing else writes tier 2 yet, so anything else here is a mistake");
      console.log("  6. tier 2 and tier 1 stayed separate in the shared table");
    }
  } finally {
    for (const { s, harness } of supervisors) {
      try { await s.shutdown({ timeoutMs: 3000 }); } catch { /* teardown */ }
      try { await harness.disposeAll?.({ graceMs: 300 }); } catch { /* teardown */ }
    }
    try { if (db) closeDb(db); } catch { /* teardown */ }
    await sleep(150);
    rmScratchDir(stateDir);
  }
});
