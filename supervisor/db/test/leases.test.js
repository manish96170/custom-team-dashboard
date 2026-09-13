// leases.test.js — resource_leases (migration 0011/0012, PLAN.md section 20): the
// claim-before-side-effect primitive `tryAcquireLease`, the release/renew/sweep functions
// around it, and (case 1) a genuine cross-process race, not just a sequential pair of calls —
// the same standing rule this project applies to every idempotency key.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  openDb, closeDb, mintPrincipal, tryAcquireLease, getLease, releaseLeaseRow, renewLeaseRow,
  sweepExpiredLeases, listActiveLeases, releaseLeasesForRun, DEFAULT_LEASE_TTL_MS,
  upsertHarness, createWorker, createRun, endRun, reconcileRun,
} from "../index.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = path.join(__dirname, "_lease-race-child.js");

function runChild(stateDir, index, barrierPath, resourceName, kind, capacity) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD_SCRIPT, stateDir, String(index), barrierPath, resourceName, kind, String(capacity)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ index, code, stdout, stderr }));
    child.on("error", (err) => resolve({ index, code: -1, stdout, stderr: String(err) }));
  });
}

async function waitForReady(barrierDir, barrierPath, n) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ready = fs.readdirSync(barrierDir).filter((f) => f.includes(".ready.")).length;
    if (ready === n) break;
    if (Date.now() > deadline) throw new Error(`only ${ready}/${n} children reported ready`);
    await new Promise((r) => setTimeout(r, 5));
  }
  fs.writeFileSync(barrierPath, "");
}

async function raceFor(resourceName, kind, capacity, numChildren) {
  const stateDir = makeScratchDir(`supervisor-lease-race-${kind}`);
  const barrierDir = makeScratchDir("supervisor-lease-race-barrier");
  try {
    // Pre-create the database + schema once, outside the race, so every child races
    // `tryAcquireLease` itself rather than also racing `openDb`'s own migration path
    // (that race is concurrent-startup.test.js's job, not this one's).
    closeDb(openDb({ stateDir }));

    const barrierPath = path.join(barrierDir, "go");
    const pending = Array.from({ length: numChildren }, (_, i) => runChild(stateDir, i, barrierPath, resourceName, kind, capacity));
    await waitForReady(barrierDir, barrierPath, numChildren);
    const results = await Promise.all(pending);

    const failed = results.filter((r) => r.code !== 0);
    if (failed.length > 0) {
      assert.fail(failed.map((r) => `child ${r.index} exited ${r.code}\n${r.stderr}`).join("\n---\n"));
    }
    const reports = results.map((r) => JSON.parse(r.stdout.trim()));
    return { granted: reports.filter((r) => r.granted).length, total: reports.length };
  } finally {
    rmScratchDir(stateDir);
    rmScratchDir(barrierDir);
  }
}

await runTest("leases", async () => {
  // ── 1: cross-process race, exclusive ──────────────────────────────────────────────
  {
    const { granted, total } = await raceFor("git:identity", "exclusive", null, 8);
    assert.equal(total, 8);
    assert.equal(granted, 1, `an exclusive resource must have exactly 1 winner among 8 concurrent acquirers, got ${granted}`);
    console.log("  1. 8 processes race an exclusive lease concurrently; exactly 1 is granted");
  }

  // ── 2: cross-process race, counted ────────────────────────────────────────────────
  {
    const { granted, total } = await raceFor("host:heavy-job", "counted", 3, 8);
    assert.equal(total, 8);
    assert.equal(granted, 3, `a capacity-3 resource must admit exactly 3 of 8 concurrent acquirers, got ${granted}`);
    console.log("  2. 8 processes race a capacity-3 lease concurrently; exactly 3 are granted");
  }

  const stateDir = makeScratchDir("supervisor-leases-inprocess");
  try {
    const db = openDb({ stateDir });
    mintPrincipal(db, { id: "p1", kind: "worker", tokenSha256: "h1", capabilities: ["resource:lease"] });
    mintPrincipal(db, { id: "p2", kind: "worker", tokenSha256: "h2", capabilities: ["resource:lease"] });

    // ── 3: exclusive refuses a 2nd sequential holder and names the blocker ────────────
    {
      const a = tryAcquireLease(db, { resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p1", reason: "push" });
      assert.equal(a.granted, true);
      const b = tryAcquireLease(db, { resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p2", reason: "push2" });
      assert.equal(b.granted, false);
      assert.equal(b.blockedBy.length, 1);
      assert.equal(b.blockedBy[0].principalId, "p1");
      assert.equal(b.blockedBy[0].reason, "push");
      releaseLeaseRow(db, a.lease.id);
      console.log("  3. exclusive refuses a 2nd holder and names who holds it");
    }

    // ── 4: counted admits up to capacity, refuses beyond ─────────────────────────────
    {
      const one = tryAcquireLease(db, { resourceName: "host:heavy-job", kind: "counted", capacity: 2, holderPrincipalId: "p1" });
      const two = tryAcquireLease(db, { resourceName: "host:heavy-job", kind: "counted", capacity: 2, holderPrincipalId: "p2" });
      assert.equal(one.granted, true);
      assert.equal(two.granted, true);
      const three = tryAcquireLease(db, { resourceName: "host:heavy-job", kind: "counted", capacity: 2, holderPrincipalId: "p1" });
      assert.equal(three.granted, false);
      assert.equal(three.blockedBy.length, 2);
      releaseLeaseRow(db, one.lease.id);
      releaseLeaseRow(db, two.lease.id);
      console.log("  4. counted admits exactly `capacity` holders and refuses beyond it");
    }

    // ── 5: a stale (TTL-expired, unswept) holder does not block a new acquire ────────
    {
      const past = new Date(Date.now() - 60_000).toISOString();
      const stale = tryAcquireLease(db, {
        resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p1", ttlMs: 1, now: past,
      });
      assert.equal(stale.granted, true);
      // stale.lease.ttlExpiresAt is in the past relative to "now" — nothing has swept it, but a
      // fresh acquire must not see it as an active holder.
      const fresh = tryAcquireLease(db, { resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p2" });
      assert.equal(fresh.granted, true, "an unswept but TTL-expired row must not count against capacity");
      releaseLeaseRow(db, fresh.lease.id);
      console.log("  5. a TTL-expired, unswept holder does not block a new acquire");
    }

    // ── 6: the sweep actually releases expired leases, and is idempotent ─────────────
    {
      const past = new Date(Date.now() - 60_000).toISOString();
      const willExpire = tryAcquireLease(db, {
        resourceName: "host:heavy-job", kind: "counted", capacity: 1, holderPrincipalId: "p1", ttlMs: 1, now: past,
      });
      assert.equal(willExpire.granted, true);
      const before = getLease(db, willExpire.lease.id);
      assert.equal(before.releasedAt, null);

      const swept = sweepExpiredLeases(db);
      assert.ok(swept >= 1, `expected the sweep to release at least 1 expired lease, got ${swept}`);
      const after = getLease(db, willExpire.lease.id);
      assert.notEqual(after.releasedAt, null);
      assert.equal(after.releaseReason, "expired-swept", "a sweep release must be distinguishable from a normal release");

      const secondSweep = sweepExpiredLeases(db);
      assert.equal(secondSweep, 0, "sweeping twice must not double-release the same row");
      console.log("  6. the sweep releases expired leases, marks release_reason, and is idempotent");
    }

    // ── 7: renew bumps heartbeat/TTL; release/renew refuse on an unknown or already-released lease ──
    {
      const l = tryAcquireLease(db, { resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p1" });
      assert.equal(l.granted, true);
      const renewed = renewLeaseRow(db, l.lease.id, { ttlMs: DEFAULT_LEASE_TTL_MS * 2 });
      assert.equal(renewed.renewed, true);
      const row = getLease(db, l.lease.id);
      assert.ok(new Date(row.ttlExpiresAt).getTime() > new Date(l.lease.ttlExpiresAt).getTime(), "renew must push the TTL out");

      const released = releaseLeaseRow(db, l.lease.id);
      assert.equal(released.released, true);
      const secondRelease = releaseLeaseRow(db, l.lease.id);
      assert.equal(secondRelease.released, false, "releasing an already-released lease must be a no-op, not a double-release");

      const unknown = renewLeaseRow(db, "no-such-lease");
      assert.equal(unknown.renewed, false);
      console.log("  7. renew extends the TTL; release/renew refuse on an unknown or already-released lease");
    }

    // ── 8: listActiveLeases and releaseLeasesForRun ───────────────────────────────────
    {
      upsertHarness(db, { id: "fake", displayName: "fake", heartbeatMechanism: "none", status: "active" });
      createWorker(db, { workerId: "w-x", nickname: "w-x", role: "coder" });
      createRun(db, { runId: "run-x", workerId: "w-x", harnessId: "fake" });
      const withRun = tryAcquireLease(db, {
        resourceName: "host:heavy-job", kind: "counted", capacity: 5, holderPrincipalId: "p1", holderRunId: "run-x",
      });
      assert.equal(withRun.granted, true);
      const active = listActiveLeases(db, "host:heavy-job");
      assert.ok(active.some((r) => r.id === withRun.lease.id));
      const released = releaseLeasesForRun(db, "run-x");
      assert.equal(released.released, 1);
      const activeAfter = listActiveLeases(db, "host:heavy-job");
      assert.ok(!activeAfter.some((r) => r.id === withRun.lease.id));
      console.log("  8. listActiveLeases reports live holders; releaseLeasesForRun clears everything a run holds");
    }

    // ── 9: endRun releases whatever the run was holding — a run that ended is no longer a
    // cooperating session, so nothing it held should outlive it (PLAN.md §20.4) ───────────
    {
      createWorker(db, { workerId: "w-y", nickname: "w-y", role: "coder" });
      createRun(db, { runId: "run-y", workerId: "w-y", harnessId: "fake" });
      const held = tryAcquireLease(db, {
        resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p1", holderRunId: "run-y",
      });
      assert.equal(held.granted, true);
      const changes = endRun(db, "run-y", { exitReason: "finished" });
      assert.equal(changes, 1, "endRun must actually close the row for this assertion to mean anything");
      const activeAfterEnd = listActiveLeases(db, "git:identity");
      assert.ok(!activeAfterEnd.some((r) => r.id === held.lease.id), "endRun must release leases the run held");
      const row = getLease(db, held.lease.id);
      assert.equal(row.releaseReason, "finished", "the lease's release reason should trace back to why the run ended");

      // A second endRun on an already-closed row is a no-op (endRun's own first-writer-wins rule) and must
      // not blow up trying to release leases a prior call already released.
      const secondChanges = endRun(db, "run-y", { exitReason: "errored" });
      assert.equal(secondChanges, 0);
      console.log("  9. endRun releases everything the run held, tagged with the run's exit reason, and a rejected second call is a safe no-op");
    }

    // ── 10: renewal must NOT resurrect an expired lease after a replacement has already been
    // granted the resource — codex review finding (both jobs), fixed 2026-09-11 ──────────
    {
      const past = new Date(Date.now() - 60_000).toISOString();
      const a = tryAcquireLease(db, {
        resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p1", ttlMs: 1, now: past,
      });
      assert.equal(a.granted, true);
      // A's TTL is in the past and unswept, exactly like case 5 — a fresh acquire for B must succeed.
      const b = tryAcquireLease(db, { resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p2" });
      assert.equal(b.granted, true, "B must be able to acquire the resource A's expired lease no longer protects");

      // Renewing A BY ID must now fail — A lost the resource the moment its TTL passed, and renewal must
      // not revive it into a second live exclusive holder alongside B.
      const renewed = renewLeaseRow(db, a.lease.id, { ttlMs: DEFAULT_LEASE_TTL_MS });
      assert.equal(renewed.renewed, false, "renewing an already-expired lease must fail, not resurrect it");

      const active = listActiveLeases(db, "git:identity");
      assert.equal(active.length, 1, "exactly one exclusive holder must be active after the renewal attempt");
      assert.equal(active[0].id, b.lease.id, "B, not resurrected A, must be the sole active holder");
      releaseLeaseRow(db, b.lease.id);
      console.log("  10. renewing an expired-but-unswept lease fails and cannot resurrect it alongside a replacement holder");
    }

    // ── 11: acquiring a lease for a run that has ALREADY ended must be refused — a lease bound to a
    // closed run can never be released by endRun's own guard, so it would only ever clear via the TTL
    // sweep. Codex review finding (job 1 #5), fixed 2026-09-11 ──────────────────────────────
    {
      createWorker(db, { workerId: "w-ended", nickname: "w-ended", role: "coder" });
      createRun(db, { runId: "run-ended", workerId: "w-ended", harnessId: "fake" });
      const changes = endRun(db, "run-ended", { exitReason: "finished" });
      assert.equal(changes, 1);

      const attempt = tryAcquireLease(db, {
        resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p1", holderRunId: "run-ended",
      });
      assert.equal(attempt.granted, false, "a lease must not be grantable for a run that has already ended");
      assert.match(attempt.refused ?? "", /already ended/);
      console.log("  11. acquiring a lease for an already-ended run is refused, not silently granted");
    }

    // ── 12: endRun's terminal write and its lease release are ONE transaction — a thrown error in the
    // release step must roll back the run's ended_at too, not leave an ended run with a stuck lease.
    // Codex review finding (both jobs), fixed 2026-09-11 ──────────────────────────────────
    {
      createWorker(db, { workerId: "w-atomic", nickname: "w-atomic", role: "coder" });
      createRun(db, { runId: "run-atomic", workerId: "w-atomic", harnessId: "fake" });
      const held = tryAcquireLease(db, {
        resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p1", holderRunId: "run-atomic",
      });
      assert.equal(held.granted, true);

      // Force the lease-release UPDATE inside endRun's transaction to fail, by dropping the column it
      // writes to via a temporary trigger that aborts on write — a real SQL failure, not a mock.
      db.exec(`
        CREATE TRIGGER fail_lease_release
        BEFORE UPDATE ON resource_leases
        WHEN NEW.release_reason = 'boom-injected-failure'
        BEGIN SELECT RAISE(ABORT, 'injected failure for test 12'); END;
      `);
      // releaseLeasesForRun always writes reason "run-ended" unless exitReason overrides it — force that
      // value to match the trigger's condition.
      assert.throws(() => endRun(db, "run-atomic", { exitReason: "boom-injected-failure" }));
      db.exec(`DROP TRIGGER fail_lease_release;`);

      // Because the whole thing rolled back, the run must STILL be open and the lease STILL held —
      // proving the two writes really are one transaction, not "run closes even if release throws".
      const runRow = db.prepare("SELECT ended_at FROM runs WHERE run_id = 'run-atomic'").get();
      assert.equal(runRow.ended_at, null, "a thrown lease-release error must roll back the run's own ended_at too");
      const stillHeld = getLease(db, held.lease.id);
      assert.equal(stillHeld.releasedAt, null, "the lease must still be held after the rolled-back attempt");

      // A clean retry (without the trigger) must succeed and release everything, proving the failure was
      // recoverable rather than a permanently corrupted state.
      const retried = endRun(db, "run-atomic", { exitReason: "finished" });
      assert.equal(retried, 1);
      const releasedNow = getLease(db, held.lease.id);
      assert.notEqual(releasedNow.releasedAt, null, "a clean retry must release the lease");
      console.log("  12. endRun's terminal write and lease release are one transaction; a thrown release error rolls both back, and a clean retry recovers");
    }

    // ── 13: reconcileRun releases a run's leases too, not just endRun — codex review finding (both
    // jobs' #9/#13), fixed 2026-09-11 ─────────────────────────────────────────────────────
    {
      createWorker(db, { workerId: "w-recon", nickname: "w-recon", role: "coder" });
      createRun(db, { runId: "run-recon", workerId: "w-recon", harnessId: "fake" });
      const held = tryAcquireLease(db, {
        resourceName: "host:heavy-job", kind: "counted", capacity: 3, holderPrincipalId: "p1", holderRunId: "run-recon",
      });
      assert.equal(held.granted, true);

      const changes = reconcileRun(db, "run-recon", { exitReason: "lost" });
      assert.equal(changes, 1);
      const row = getLease(db, held.lease.id);
      assert.notEqual(row.releasedAt, null, "reconcileRun must release the leases a reconciled-to-lost run held");
      assert.equal(row.releaseReason, "lost");

      const runRow = db.prepare("SELECT reconciled_at FROM runs WHERE run_id = 'run-recon'").get();
      assert.notEqual(runRow.reconciled_at, null, "reconciled_at semantics must be unchanged by the lease-release addition");
      console.log("  13. reconcileRun releases whatever leases the reconciled run held, and its own reconciled_at semantics are unchanged");
    }

    closeDb(db);
  } finally {
    rmScratchDir(stateDir);
  }

  // ── 14 ───────────────────────────────────────────────────────────────────────────────
  // review-sol-2026-09-13.md finding 10: `renewLeaseRow` used to compute "now" BEFORE the UPDATE ran.
  // A real second OS process holds SQLite's write lock for 600ms while this test tries to renew a
  // lease whose TTL is only 200ms — the renew call blocks on the busy handler for that whole 600ms,
  // so by the time it actually runs, the lease has been expired for ~400ms. Fixed: `now` is read only
  // after `BEGIN IMMEDIATE` grants the lock, so the expiry check sees the real, post-wait time.
  {
    const stateDir = makeScratchDir("supervisor-lease-renew-lockwait");
    try {
      let db = openDb({ stateDir });
      mintPrincipal(db, { id: "p1", kind: "worker", tokenSha256: "hash-1", capabilities: ["resource:lease"] });
      const acquired = tryAcquireLease(db, { resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p1", ttlMs: 200 });
      assert.equal(acquired.granted, true);
      closeDb(db);

      const lockHolderScript = path.join(__dirname, "_renew-lock-holder-child.js");
      const holder = spawn(process.execPath, [lockHolderScript, stateDir, "600"], { stdio: ["ignore", "pipe", "pipe"] });
      let holderOutput = "";
      holder.stdout.on("data", (d) => (holderOutput += d));
      // Give the child a moment to actually acquire BEGIN IMMEDIATE before this process's renew call
      // races it — the point is the RENEW call blocking on an ALREADY-HELD lock, not a fair race for it.
      await new Promise((r) => setTimeout(r, 100));

      db = openDb({ stateDir });
      const before = Date.now();
      const renewed = renewLeaseRow(db, acquired.lease.id, { ttlMs: DEFAULT_LEASE_TTL_MS });
      const waited = Date.now() - before;
      assert.ok(waited > 300, `renewLeaseRow must have genuinely blocked on the held lock (waited ${waited}ms)`);
      assert.equal(renewed.renewed, false, "a lease that expired WHILE this call was blocked on the write lock must not be renewed with a stale pre-wait timestamp");
      closeDb(db);

      await new Promise((resolve) => holder.on("exit", resolve));
      assert.match(holderOutput, /done/, "the lock-holder child must have completed its held transaction");
      console.log("  14. renewLeaseRow reads \"now\" after the write lock is actually held, not before a busy-wait that can outlast the lease's own TTL");
    } finally {
      rmScratchDir(stateDir);
    }
  }

  // ── 15 ───────────────────────────────────────────────────────────────────────────────
  // review-sol-2026-09-13.md finding 11: an acquire's `active.length >= limit` check used only THIS
  // call's own kind/capacity, with no check that active rows for the same resource were admitted under
  // the SAME policy — a counted request could be admitted alongside an active EXCLUSIVE holder, since
  // its own capacity (e.g. 3) made `active.length` (1) look like room, defeating the exclusive holder's
  // whole guarantee. Must refuse a policy-disagreeing acquire outright, not just count against its own limit.
  {
    const stateDir = makeScratchDir("supervisor-lease-policy-conflict");
    try {
      const db = openDb({ stateDir });
      mintPrincipal(db, { id: "p1", kind: "worker", tokenSha256: "h1", capabilities: ["resource:lease"] });
      mintPrincipal(db, { id: "p2", kind: "worker", tokenSha256: "h2", capabilities: ["resource:lease"] });

      const exclusiveHeld = tryAcquireLease(db, { resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p1" });
      assert.equal(exclusiveHeld.granted, true);

      // A DIFFERENT policy (counted, capacity 3) for the SAME resource must be refused outright — not
      // admitted just because 1 active row happens to be under this call's own capacity of 3.
      const countedAttempt = tryAcquireLease(db, { resourceName: "git:identity", kind: "counted", capacity: 3, holderPrincipalId: "p2" });
      assert.equal(countedAttempt.granted, false, "a counted request must not be admitted alongside an active exclusive holder");
      assert.match(countedAttempt.refused, /policy|disagrees/i);
      assert.equal(countedAttempt.blockedBy?.[0]?.principalId, "p1");

      // The genuinely SAME policy (exclusive) is still correctly refused by the ordinary limit check,
      // unaffected by this fix.
      const secondExclusive = tryAcquireLease(db, { resourceName: "git:identity", kind: "exclusive", holderPrincipalId: "p2" });
      assert.equal(secondExclusive.granted, false);

      closeDb(db);
      console.log("  15. tryAcquireLease refuses a policy-disagreeing acquire for a resource with an active lease under a different kind/capacity");
    } finally {
      rmScratchDir(stateDir);
    }
  }
});
