// preflight.test.js — PLAN.md section 12.1: a preflight session is ephemeral and must leave
// nothing behind, but its VERDICT must survive.
//
// The tension this suite exists to pin down: a preflight row has to be INVISIBLE to every
// human-facing view and simultaneously VISIBLE to reconciliation. Getting that backwards in
// either direction is a real bug —
//
//   * visible to humans  -> "who did what" becomes twenty sessions saying "hi", which is the
//                           history pollution the cleanup exists to prevent
//   * hidden from reconciliation -> a preflight that crashed leaks a live process nobody can
//                           see or reap, which is strictly worse than the pollution
//
// so cases 2 and 7 assert opposite things about the same row on purpose.
//
// Cases:
//   1. a passing preflight records `reachable`, and leaves NO run/event rows behind
//   2. the row is excluded from the human-facing list while it is still running
//   3. a failing preflight still records a verdict, with a groupable error CLASS
//   4. the verdict outlives the session and REPLACES on re-check, rather than accumulating
//   5. `deletePreflightRun` REFUSES a real run — the only destructive delete in the codebase
//   6. deletion removes the children too (event_log, asks), in one transaction
//   7. a preflight that crashed is reconciled by the ORDINARY orphan path, then swept
//   8. the sweep will not delete a preflight that is still OPEN (it may be live)
//   9. the pump is detached BEFORE the rows are deleted (found on the real CLI)
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import {
  openDb,
  closeDb,
  upsertHarness,
  createWorker,
  createTask,
  createAsk,
  createRun,
  getRun,
  endRun,
  listOpenRuns,
  listRunsForDisplay,
  listPreflightRuns,
  deletePreflightRun,
  getModelHealth,
  listModelHealth,
  mintPrincipal,
  tryAcquireLease,
  claimPoolSlot,
  markPoolReady,
  attachToPool,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, waitFor, sleep } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

// `getRun` returns null (not undefined) for a missing row, so absence is asserted as `?? null`
// rather than against `undefined`. Worth stating because the two are easy to swap and the
// resulting failure ("null !== undefined") says nothing about what actually went wrong.
const rowCount = (db, table, runId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?`).get(runId).n;

await runTest("preflight", async () => {
  const stateDir = makeScratchDir("supervisor-preflight-test");
  let db;
  let supervisor;
  let harness;

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createWorker(db, { workerId: "w1", nickname: "tester", role: "worker" });
    createTask(db, { id: "t1", title: "preflight", type: "feature" });

    harness = createFakeHarness({ label: "preflight" });
    supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askSweepIntervalMs: 0 });
    await supervisor.boot();

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    {
      const before = listOpenRuns(db).length;
      const result = await supervisor.preflight({
        harnessId: "fake",
        workerId: "w1",
        cwd: stateDir,
        model: { providerID: "amazon-bedrock", modelID: "test-model" },
        timeoutMs: 15_000,
      });

      assert.equal(result.reachable, true, `expected reachable, got ${JSON.stringify(result)}`);
      assert.equal(result.errorClass, "ok");
      assert.ok(result.latencyMs >= 0, "latency is recorded — it is what makes a slow model visible");
      assert.equal(result.cleanup.deleted, true, "the session's rows must be gone");

      // "Leaves nothing behind" means nothing, not "nothing open".
      assert.equal(listPreflightRuns(db).length, 0, "no preflight row may survive its check");
      assert.equal(listOpenRuns(db).length, before, "and the open-run set is exactly as it was");
      console.log("  1. a passing preflight recorded reachable=true and deleted its own session");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    // The exclusion is a READ-TIME filter, so it must already hold while the check is running —
    // not only once the row is deleted. Twenty in-flight "hi" sessions pollute a team view just
    // as effectively as twenty finished ones.
    {
      const { runId } = await supervisor.start({
        harnessId: "fake",
        workerId: "w1",
        spec: { cwd: stateDir, prompt: "in-flight preflight", isPreflight: true },
      });

      assert.equal(getRun(db, runId).is_preflight, 1, "marked at INSERT time, not on the way out");
      assert.equal(
        listRunsForDisplay(db).some((r) => r.run_id === runId), false,
        "a preflight must never appear in a human-facing list, even while running",
      );
      assert.equal(
        listOpenRuns(db).some((r) => r.run_id === runId), true,
        "but it MUST be visible to reconciliation, or a crashed preflight leaks a live process",
      );

      await supervisor.discardPreflightRun(runId, "fake");
      assert.equal(getRun(db, runId) ?? null, null, "and it is gone after cleanup");
      console.log("  2. hidden from the human-facing list, visible to reconciliation — both at once");
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      const result = await supervisor.preflight({
        harnessId: "fake",
        workerId: "w1",
        cwd: stateDir,
        model: { providerID: "amazon-bedrock", modelID: "silent-model" },
        // The fake answers immediately, so the only way to observe a timeout is to give it no
        // time at all. That is a real code path, not a contrivance: it is what a wedged provider
        // looks like from here.
        timeoutMs: 1,
      });

      assert.equal(result.reachable, false, "a model that did not answer in time is not reachable");
      assert.equal(result.errorClass, "timeout", `expected a groupable class, got ${result.errorClass}`);
      assert.match(result.detail, /no turn within/, "and a human-readable detail beside it");
      assert.equal(result.cleanup.deleted, true, "a FAILED check must clean up just as thoroughly");
      assert.equal(listPreflightRuns(db).length, 0);
      console.log("  3. a failing preflight recorded a groupable error class and still cleaned up");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    {
      const key = { harnessId: "fake", providerId: "amazon-bedrock", modelId: "test-model" };
      const first = getModelHealth(db, key);
      assert.ok(first, "the verdict outlived the deleted session — that is the point of the table");
      assert.equal(first.reachable, 1);
      assert.equal(first.error_class, "ok");

      const beforeCount = listModelHealth(db).length;
      await supervisor.preflight({
        harnessId: "fake", workerId: "w1", cwd: stateDir,
        model: { providerID: "amazon-bedrock", modelID: "test-model" },
        timeoutMs: 1, // make this one fail, so the row must visibly change
      });
      const after = getModelHealth(db, key);
      assert.equal(listModelHealth(db).length, beforeCount,
        "a re-check REPLACES the verdict; a check designed to run liberally must not grow a history table");
      assert.equal(after.reachable, 0, "and the newest result is what stands");
      assert.notEqual(after.checked_at ?? null, null, "with a timestamp, so a stale verdict is recognisable as stale");
      console.log("  4. the verdict outlives the session and is replaced, not accumulated");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    // The guard on the only destructive delete in this codebase.
    {
      const { runId } = await supervisor.start({
        harnessId: "fake",
        workerId: "w1",
        spec: { cwd: stateDir, prompt: "a real worker run" },
      });
      assert.equal(getRun(db, runId).is_preflight, 0);

      assert.throws(
        () => deletePreflightRun(db, runId),
        /not a preflight run/,
        "deleting a real run must be refused loudly, not attempted",
      );
      assert.ok(getRun(db, runId), "and the real run is untouched");

      // ...and the supervisor's wrapper must not swallow that into a silent no-op either.
      const viaSupervisor = await supervisor.discardPreflightRun(runId, "fake");
      assert.equal(viaSupervisor.deleted, false, "the wrapper reports the refusal");
      assert.ok(getRun(db, runId), "and still did not delete it");

      await supervisor.stop(runId);
      console.log("  5. deletePreflightRun refused a real run, twice, and deleted nothing");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    {
      const { runId } = await supervisor.start({
        harnessId: "fake",
        workerId: "w1",
        spec: { cwd: stateDir, prompt: "preflight with children", isPreflight: true },
      });
      createAsk(db, { id: "preflight-ask", runId, taskId: "t1", question: "anything?" });
      await waitFor(() => rowCount(db, "event_log", runId) > 0, { timeoutMs: 5000, what: "event rows" });

      assert.ok(rowCount(db, "event_log", runId) > 0, "precondition: there are children to orphan");
      assert.equal(rowCount(db, "asks", runId), 1);

      const removed = deletePreflightRun(db, runId);
      assert.equal(removed.deleted, true);
      assert.ok(removed.events > 0, `event rows were counted as deleted, got ${removed.events}`);
      assert.equal(removed.asks, 1);
      assert.equal(rowCount(db, "event_log", runId), 0, "no orphaned event rows: they are unreadable AND undeletable");
      assert.equal(rowCount(db, "asks", runId), 0);
      assert.equal(getRun(db, runId) ?? null, null);
      console.log("  6. deletion took the children with it, in one transaction");
      await supervisor.stop(runId).catch(() => {});
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    // A crashed preflight is an orphan like any other. PLAN.md 12.1: "the same reconciliation
    // path, not a second mechanism". Simulated the way integration.test.js case 8 does it — the
    // handles are gone, which is the cooperative shape of what a crash leaves.
    {
      const runId = "preflight-crashed";
      createRun(db, {
        runId, workerId: "w1", harnessId: "fake", prompt: "crashed mid-check", isPreflight: true,
      });
      assert.equal(listOpenRuns(db).some((r) => r.run_id === runId), true,
        "an open crashed preflight is in reconciliation's input set");

      // Give it a terminal state the way reconciliation would for a process that is simply gone,
      // then let the boot sweep remove the row.
      endRun(db, runId, { exitReason: "lost" });
      assert.ok(getRun(db, runId).ended_at, "precondition: reconciliation has closed it");
      assert.equal(listPreflightRuns(db).length, 1, "the row is still on disk, waiting to be swept");

      const boot = await supervisor.boot();
      assert.deepEqual(boot.preflights.swept, [runId], `boot must sweep it; got ${JSON.stringify(boot.preflights)}`);
      assert.equal(getRun(db, runId) ?? null, null, "and the row is gone");
      console.log("  7. a crashed preflight was reconciled, then swept by the ordinary boot path");
    }

    // ── 8 ────────────────────────────────────────────────────────────────────────────
    // The sweep must NOT touch an open preflight. Another supervisor may be mid-check, and
    // deleting the row of a live process manufactures an orphan nothing can ever reap — which is
    // exactly the bug migration 0003 exists to prevent, arriving by a new route.
    {
      const runId = "preflight-still-running";
      createRun(db, {
        runId, workerId: "w1", harnessId: "fake", prompt: "still checking", isPreflight: true,
      });
      assert.equal(getRun(db, runId).ended_at, null, "precondition: it is OPEN");

      const result = await supervisor.sweepPreflightRuns();
      assert.deepEqual(result.swept, [], "an open preflight must survive the sweep");
      assert.ok(getRun(db, runId), "its row is still there, so whatever owns it can still be reaped");

      // Once it is terminal, the same sweep does remove it — proving the guard is the OPEN state
      // and not a blanket refusal.
      endRun(db, runId, { exitReason: "reaped" });
      const second = await supervisor.sweepPreflightRuns();
      assert.deepEqual(second.swept, [runId], "and a terminal one is swept by the same call");
      console.log("  8. the sweep spared an OPEN preflight and removed it once terminal");
    }
    // ── 9 ────────────────────────────────────────────────────────────────────────────
    // The pump must be DETACHED before the rows are deleted. Ordering, not tidiness: the pump
    // keeps consuming the adapter's stream, and every event it persists for a deleted run violates
    // the `event_log` foreign key. Found on the REAL CLI (`real-claude-preflight.slice.mjs`), where
    // each preflight logged "recordEvent failed ... FOREIGN KEY constraint failed" as the tail of
    // the stream landed after the delete.
    //
    // Asserted on the pump's `closed` flag, and neither of the two more obvious choices works:
    //   * the FK warning itself needs a STILL-STREAMING process to appear, and against the fake
    //     harness the stream ends promptly, so that assertion would pass with the ordering broken;
    //   * `pump.has()` stays TRUE by design after `closeRun` — the state is deliberately retained
    //     because `derived()` reads it for `status()`/`list()` (see runtime/FINDINGS.md's open
    //     items), so `has()` answers "is this run known", not "is it still consuming".
    // `closed` is the flag the consumer loop actually checks before persisting each event
    // (event-pump.js line ~132), so it is the mechanism, not a proxy for it.
    {
      const { runId } = await supervisor.start({
        harnessId: "fake",
        workerId: "w1",
        spec: { cwd: stateDir, prompt: "pump detach", isPreflight: true },
      });
      await waitFor(() => rowCount(db, "event_log", runId) > 0, { timeoutMs: 5000, what: "the pump to be live" });
      assert.equal(supervisor.pump._runs.get(runId)?.closed ?? true, false,
        "precondition: the pump is attached and still consuming");

      await supervisor.discardPreflightRun(runId, "fake");
      assert.equal(supervisor.pump._runs.get(runId)?.closed ?? false, true,
        "the pump must be closed before the rows go, or it persists events for a run that no longer exists");
      assert.equal(getRun(db, runId) ?? null, null, "and the row is gone");
      console.log("  9. the pump was detached before the rows were deleted");
    }

    // ── 10 ───────────────────────────────────────────────────────────────────────────
    // review-sol-2026-09-13.md finding 20: migrations 0011/0013 added FOREIGN KEY references to
    // `runs(run_id)` from `resource_leases.holder_run_id` and `mcp_pool_attachments.run_id`, neither of
    // which existed when `deletePreflightRun` was written. A preflight run that ever acquired a lease
    // or attached to a pooled MCP server used to make the `DELETE FROM runs` fail with a real
    // `FOREIGN KEY constraint failed`, regardless of whether the lease/attachment had already been
    // released/detached — the historical row's FK reference remains either way.
    {
      const { runId } = await supervisor.start({
        harnessId: "fake",
        workerId: "w1",
        spec: { cwd: stateDir, prompt: "preflight with FK children", isPreflight: true },
      });
      await waitFor(() => rowCount(db, "event_log", runId) > 0, { timeoutMs: 5000, what: "event rows" });

      mintPrincipal(db, { id: "p-preflight-fk", kind: "worker", tokenSha256: "hash-preflight-fk", capabilities: ["resource:lease"] });
      const lease = tryAcquireLease(db, { resourceName: "host:heavy-job", kind: "counted", capacity: 3, holderPrincipalId: "p-preflight-fk", holderRunId: runId });
      assert.equal(lease.granted, true, "precondition: the preflight run holds a real lease referencing it");

      const claim = claimPoolSlot(db, { name: "preflight-fk-pool", configHash: "x" });
      markPoolReady(db, claim.pool.id, { pid: 999997, pgid: 999997 });
      const attached = attachToPool(db, { name: "preflight-fk-pool", configHash: "x", runId });
      assert.equal(attached.attached, true, "precondition: the preflight run has a real MCP pool attachment referencing it");

      const removed = deletePreflightRun(db, runId);
      assert.equal(removed.deleted, true, `deletePreflightRun must succeed despite the FK-referencing lease/attachment rows; got ${JSON.stringify(removed)}`);
      assert.equal(removed.leases, 1, "the lease row must have been deleted along with the run");
      assert.equal(removed.mcpAttachments, 1, "the mcp_pool_attachments row must have been deleted along with the run");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM resource_leases WHERE holder_run_id = ?").get(runId).n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mcp_pool_attachments WHERE run_id = ?").get(runId).n, 0);
      assert.equal(getRun(db, runId) ?? null, null, "and the run row itself is gone");
      console.log("  10. deletePreflightRun succeeds despite FK-referencing resource_leases/mcp_pool_attachments rows, deleting them too");
    }
  } finally {
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* best effort */ }
    try { if (db) closeDb(db); } catch { /* best effort */ }
    rmScratchDir(stateDir);
  }
});
