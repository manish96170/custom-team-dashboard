// leases.test.js — the supervisor-level lease API (PLAN.md §20, added 2026-09-10): resources.json
// resolution, the `host:heavy-job` memory-pressure check, holder-only release/renew, and the
// authorization wiring. `db/test/leases.test.js` covers the cross-process race and the sweep at the
// persistence layer; this covers the layer that reads config and samples the host.
//
// Cases:
//   1. an undeclared resource is refused
//   2. `host:heavy-job` grants and surfaces sampled memory numbers on a healthy host
//   3. `host:heavy-job` refuses under mocked memory pressure, and surfaces the numbers on refusal too
//   4. `resources.json` overrides are read on demand (no cache, no restart needed)
//   5. a malformed `resources.json` throws loudly, same contract as `harness-defaults.js`
//   6. only the holder may release or renew its own lease
//   7. `resource:lease` gates the three commands over the wire, and a caller-supplied principal
//      cannot survive the authorization wrapper's spread
//   9. invalid ttlMs (negative, zero, over the documented maximum) is refused at the WIRE layer with a
//      clean {ok:false}, not left to the DB primitive's throw — fixed 2026-09-11
//      (`codexdoc/review-luna-2026-09-11.md` finding 5)

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb, closeDb, upsertHarness, createWorker, mintPrincipal } from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { COMMAND_CAPABILITIES, assertCoversCommands } from "../../domain/capabilities.js";
import { CONFIG_FILENAME } from "../../config/resources.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

function withMockedMemory(freeBytes, totalBytes, fn) {
  const origFree = os.freemem;
  const origTotal = os.totalmem;
  os.freemem = () => freeBytes;
  os.totalmem = () => totalBytes;
  try {
    return fn();
  } finally {
    os.freemem = origFree;
    os.totalmem = origTotal;
  }
}

await runTest("resource leases", async () => {
  const stateDir = makeScratchDir("supervisor-leases-test");
  let db;
  let supervisor;

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createWorker(db, { workerId: "w-coder", nickname: "coder-1", role: "coder" });

    supervisor = createSupervisor({ db, adapters: { fake: createFakeHarness({ label: "leases" }) }, logger: quiet, askSweepIntervalMs: 0 });
    const booted = await supervisor.boot();

    const owner = { id: booted.owner.id, kind: "human" };
    const worker = supervisor.ensureWorkerPrincipal("w-coder").principal;
    mintPrincipal(db, { id: "p-other", kind: "worker", tokenSha256: "hash-other", capabilities: ["resource:lease"] });
    const other = { id: "p-other" };

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    {
      const r = supervisor.acquireLease({ resourceName: "no:such:resource", principal: owner });
      assert.equal(r.granted, false);
      assert.equal(r.refused, "unknown-resource");
      console.log("  1. an undeclared resource is refused");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    // Mocked, not real ambient memory: the real host's free% fluctuates with whatever ELSE is
    // running (measured — this case flaked on a re-run when something else briefly used enough
    // memory to drop real free% under 15%), and a test whose assertion direction depends on
    // ambient host state has not proven the mechanism, the same lesson this codebase's own
    // FINDINGS already draws from a different trap shape.
    let heavyLease;
    {
      const r = withMockedMemory(50, 100, () => // 50% free — comfortably above any reasonable headroom
        supervisor.acquireLease({ resourceName: "host:heavy-job", principal: owner, reason: "test build" }));
      assert.equal(r.granted, true, JSON.stringify(r));
      assert.ok(r.memory, "a host:heavy-job grant must surface the sampled memory numbers, not just pass/fail");
      assert.ok(typeof r.memory.freePercent === "number");
      assert.ok(typeof r.memory.headroomPercent === "number");
      heavyLease = r.lease;
      console.log(`  2. host:heavy-job grants when free memory is comfortably above headroom, and surfaces the numbers`);
    }
    supervisor.releaseLease({ leaseId: heavyLease.id, principal: owner });

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      const r = withMockedMemory(1, 100, () => // 1% free — deep under any reasonable headroom
        supervisor.acquireLease({ resourceName: "host:heavy-job", principal: owner, reason: "should be refused" }));
      assert.equal(r.granted, false);
      assert.equal(r.refused, "host-memory-pressure");
      assert.ok(r.memory, "a memory-pressure REFUSAL must also surface the sampled numbers — a human sees the number, not just a refusal");
      assert.ok(r.memory.freePercent < 5);
      console.log("  3. host:heavy-job refuses under mocked memory pressure, and surfaces the numbers on the refusal too");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    {
      // A headroom of 0 makes even 1%-free "enough" — proves the file is actually read (on demand,
      // not cached), not just that the built-in default happens to work.
      fs.writeFileSync(path.join(stateDir, CONFIG_FILENAME), JSON.stringify({ memoryHeadroomPercent: 0 }));
      const r = withMockedMemory(1, 100, () =>
        supervisor.acquireLease({ resourceName: "host:heavy-job", principal: owner, reason: "headroom override" }));
      assert.equal(r.granted, true, JSON.stringify(r));
      supervisor.releaseLease({ leaseId: r.lease.id, principal: owner });
      console.log("  4. resources.json overrides (e.g. memoryHeadroomPercent) are read on demand");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    {
      fs.writeFileSync(path.join(stateDir, CONFIG_FILENAME), "{ not valid json");
      assert.throws(() => supervisor.acquireLease({ resourceName: "git:identity", principal: owner }),
        /not valid JSON/, "a malformed resources.json must throw loudly, same contract as harness-defaults.js");
      fs.unlinkSync(path.join(stateDir, CONFIG_FILENAME));
      console.log("  5. a malformed resources.json throws loudly rather than silently falling back");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    {
      const a = supervisor.acquireLease({ resourceName: "git:identity", principal: worker, reason: "push" });
      assert.equal(a.granted, true);
      const wrongRelease = supervisor.releaseLease({ leaseId: a.lease.id, principal: other });
      assert.equal(wrongRelease.released, false);
      assert.equal(wrongRelease.refused, "not-the-holder");
      const wrongRenew = supervisor.renewLease({ leaseId: a.lease.id, principal: other });
      assert.equal(wrongRenew.renewed, false);
      assert.equal(wrongRenew.refused, "not-the-holder");
      const rightRenew = supervisor.renewLease({ leaseId: a.lease.id, principal: worker });
      assert.equal(rightRenew.renewed, true);
      const rightRelease = supervisor.releaseLease({ leaseId: a.lease.id, principal: worker });
      assert.equal(rightRelease.released, true);
      console.log("  6. only the holder may release or renew its own lease");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    {
      const names = Object.keys(supervisor.commandHandlers());
      assert.ok(names.includes("acquireLease") && names.includes("releaseLease") && names.includes("renewLease"));
      const cover = assertCoversCommands(names);
      assert.deepEqual(cover.missing, []);
      assert.deepEqual(cover.stale, []);
      assert.equal(COMMAND_CAPABILITIES.acquireLease, "resource:lease");

      const wrapped = supervisor.authorizedCommandHandlers();
      const noCapPrincipal = mintPrincipal(db, { id: "p-nocap", kind: "worker", tokenSha256: "hash-nocap", capabilities: ["read:registry"] });
      const refused = await wrapped.acquireLease({ id: "c1", token: "irrelevant-because-hash-differs", resourceName: "git:identity" });
      assert.equal(refused.ok, false);
      assert.equal(refused.refused, "unauthorized");
      console.log("  7. resource:lease gates the three lease commands over the wire; an unauthenticated request is refused");
    }

    // ── 8 ────────────────────────────────────────────────────────────────────────────
    // Cross-run ownership binding, added 2026-09-11 (`codexdoc/review-phase7-uncommitted.md` finding 4):
    // a worker-backed principal may only acquire a lease naming ITS OWN run.
    {
      createWorker(db, { workerId: "w-other", nickname: "other-1", role: "coder" });
      const otherWorkerPrincipal = supervisor.ensureWorkerPrincipal("w-other").principal;
      const { runId: coderRunId } = await supervisor.start({
        harnessId: "fake", workerId: "w-coder", spec: { cwd: stateDir, prompt: "cross-run test" },
      });

      // worker "other" (a DIFFERENT worker) tries to acquire a lease naming w-coder's run — refused.
      const impersonated = supervisor.acquireLease({
        resourceName: "git:identity", principal: otherWorkerPrincipal, runId: coderRunId, reason: "not mine",
      });
      assert.equal(impersonated.granted, false);
      assert.equal(impersonated.refused, "not-your-run");

      // w-coder acquiring a lease naming ITS OWN run still works.
      const ownRun = supervisor.acquireLease({ resourceName: "git:identity", principal: worker, runId: coderRunId, reason: "mine" });
      assert.equal(ownRun.granted, true, JSON.stringify(ownRun));
      supervisor.releaseLease({ leaseId: ownRun.lease.id, principal: worker });

      // The owner (no workerId) is unrestricted — this fix only binds WORKER-backed principals. Checked
      // while the run is still open, since a separate, already-fixed check refuses acquisition for an
      // ENDED run regardless of who's asking — that is not what this case is testing.
      const asOwner = supervisor.acquireLease({ resourceName: "git:identity", principal: owner, runId: coderRunId, reason: "owner override" });
      assert.equal(asOwner.granted, true, JSON.stringify(asOwner));
      supervisor.releaseLease({ leaseId: asOwner.lease.id, principal: owner });

      // Reproduce the review's exact scenario: worker "other" holds an UNRELATED lease (no runId), then
      // w-coder's run ends — "other"'s own holdership must be completely unaffected by a run it never
      // named.
      const unrelated = supervisor.acquireLease({ resourceName: "git:identity", principal: otherWorkerPrincipal, reason: "unrelated" });
      assert.equal(unrelated.granted, true, JSON.stringify(unrelated));
      await supervisor.stop(coderRunId);
      const stillHeld = supervisor.renewLease({ leaseId: unrelated.lease.id, principal: otherWorkerPrincipal });
      assert.equal(stillHeld.renewed, true, "ending a DIFFERENT worker's run must not touch this principal's own unrelated lease");
      supervisor.releaseLease({ leaseId: unrelated.lease.id, principal: otherWorkerPrincipal });

      console.log("  8. a worker-backed principal may only acquire a lease naming its OWN run; owner/CTO unrestricted");
    }

    // ── 9 ────────────────────────────────────────────────────────────────────────────
    // Invalid TTLs used to return `granted: true`/`renewed: true` for a lease already expired the
    // instant it was created — fixed 2026-09-11 (`codexdoc/review-luna-2026-09-11.md` finding 5).
    {
      const wrapped = supervisor.authorizedCommandHandlers();
      const workerToken = supervisor.ensureWorkerPrincipal("w-coder", { rotate: true }).token;

      for (const badTtl of [-1, 0, 999_999_999]) {
        const refused = await wrapped.acquireLease({ id: "c-bad", token: workerToken, resourceName: "git:identity", ttlMs: badTtl });
        assert.equal(refused.ok, false, `ttlMs ${badTtl} must be refused, not granted`);
        assert.match(refused.error, /positive integer/, `the refusal must name why: ${JSON.stringify(refused)}`);
      }
      // None of the refused attempts above may have actually created a lease — git:identity (exclusive)
      // must still be free.
      const stillFree = supervisor.acquireLease({ resourceName: "git:identity", principal: worker });
      assert.equal(stillFree.granted, true, "no bad-ttlMs attempt above may have silently created a lease");
      supervisor.releaseLease({ leaseId: stillFree.lease.id, principal: worker });

      // A VALID ttlMs at the wire layer still works, and so does a valid renew.
      const valid = await wrapped.acquireLease({ id: "c-good", token: workerToken, resourceName: "git:identity", ttlMs: 5000 });
      assert.equal(valid.ok, true, JSON.stringify(valid));
      const renewedBad = await wrapped.renewLease({ id: "c-renew-bad", token: workerToken, leaseId: valid.lease.id, ttlMs: -5 });
      assert.equal(renewedBad.ok, false);
      const renewedGood = await wrapped.renewLease({ id: "c-renew-good", token: workerToken, leaseId: valid.lease.id, ttlMs: 5000 });
      assert.equal(renewedGood.ok, true, JSON.stringify(renewedGood));
      await wrapped.releaseLease({ id: "c-rel", token: workerToken, leaseId: valid.lease.id });

      // Defense in depth: the DB primitive itself refuses too, for an in-process caller that bypasses
      // the wire layer entirely (review finding 5: "reject in BOTH the DB primitives and the wire path").
      assert.throws(() => supervisor.acquireLease({ resourceName: "git:identity", principal: worker, ttlMs: -1 }), /positive integer/);
      assert.throws(() => supervisor.acquireLease({ resourceName: "git:identity", principal: worker, ttlMs: 999_999_999 }), /exceeds the maximum/);
      console.log("  9. invalid ttlMs is refused cleanly at the wire layer, and still refused (by throwing) at the DB-primitive layer for a direct in-process caller");
    }

    closeDb(db);
  } finally {
    rmScratchDir(stateDir);
  }
});
