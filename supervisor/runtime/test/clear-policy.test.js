// clear-policy.test.js — Phase 8 (PLAN.md §8 Rule 5) WIRED INTO THE SUPERVISOR. `domain/test/
// clear-policy.test.js` proves the pure decision without a database or an adapter; this proves the
// thing that module cannot: that `clearContext` is genuinely CALLED, on the REAL runtime trigger call
// sites this codebase actually implements (`approveTaskLocked`'s success path for
// "state-transition"/"review-round-concluded", and the pump's own `turn.end` for "always") — and that it
// is NOT called for a worker whose role's policy does not fire on that trigger.
//
// Real spawned processes throughout (the fake harness's real child), same "prove the mechanism, not the
// conclusion" rule this project applies everywhere else.
//
// Cases:
//   1. approveTask's success path clears the coder's OWN open run ("state-transition") and a reviewer's
//      open run ("review-round-concluded") — and does NOT clear a bystander coder's run on an unrelated
//      task
//   2. a utility ("always") role's run is cleared after its own turn.end, with no task-level trigger
//      involved at all
//   3. a harness that declares no clearContext support is never called, regardless of policy

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  openDb, closeDb, upsertHarness, createTask, createWorker, recordTransition, latestTaskHandoff,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { CONFIG_FILENAME } from "../../config/review-profiles.js";
import { makeScratchDir, rmScratchDir, runTest, waitFor } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

/** Wrap a fake harness's `clearContext` with a call-recording spy, keeping its real behavior. */
function spyOnClearContext(harness) {
  const calls = [];
  const real = harness.clearContext.bind(harness);
  harness.clearContext = async (runId) => {
    calls.push(runId);
    return real(runId);
  };
  return calls;
}

function walkToReview(db, taskId) {
  let from = "created";
  for (const to of ["starting", "planning", "implementing", "awaiting-review"]) {
    recordTransition(db, { id: `tr-${taskId}-${to}`, taskId, fromState: from, toState: to, actor: "tester" });
    from = to;
  }
}

await runTest("clear-policy wiring", async () => {
  const stateDir = makeScratchDir("supervisor-clear-policy-test");
  const configPath = path.join(stateDir, CONFIG_FILENAME);
  let db;
  let supervisor;

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake" });

    // A single-dimension, quorum-of-2 profile — the fewest verdicts that satisfy `approveTask` for real.
    fs.writeFileSync(configPath, `{
      "schemaVersion": 1,
      "profiles": {
        "default": {
          "dimensions": [{ "id": "correctness", "blocking": true, "prompt": "does it work" }],
          "quorum": { "required": 2, "parentCounts": false }
        }
      }
    }`);

    const harness = createFakeHarness({ label: "clear-policy" });
    const clearCalls = spyOnClearContext(harness);
    supervisor = createSupervisor({ db, stateDir, adapters: { fake: harness }, askSweepIntervalMs: 0, logger: quiet });
    await supervisor.boot();

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    // `config/harness-defaults.js`'s BUILT-IN defaults are used as-is (no harness-defaults.json written):
    // coder -> "on-state-transition", reviewer1/reviewer2 -> "per-review-round".
    let coderRunId;
    let reviewerRunId;
    let bystanderRunId;
    {
      createTask(db, { id: "t1", title: "review me", type: "feature" });
      createWorker(db, { workerId: "w-code", nickname: "purus", role: "coder", taskId: "t1" });
      createWorker(db, { workerId: "w-r1", nickname: "aluna", role: "reviewer", taskId: "t1" });
      createWorker(db, { workerId: "w-r2", nickname: "zterra", role: "reviewer", taskId: "t1" });
      walkToReview(db, "t1");

      // A bystander coder on an UNRELATED task, with its own open run — the negative case: approving t1
      // must never reach this one.
      createTask(db, { id: "t2", title: "unrelated", type: "feature" });
      createWorker(db, { workerId: "w-bystander", nickname: "bystander", role: "coder", taskId: "t2" });

      const coderStart = await supervisor.start({ harnessId: "fake", workerId: "w-code", spec: { cwd: stateDir, prompt: "code" } });
      coderRunId = coderStart.runId;
      const reviewerStart = await supervisor.start({ harnessId: "fake", workerId: "w-r1", spec: { cwd: stateDir, prompt: "review" } });
      reviewerRunId = reviewerStart.runId;
      const bystanderStart = await supervisor.start({ harnessId: "fake", workerId: "w-bystander", spec: { cwd: stateDir, prompt: "code" } });
      bystanderRunId = bystanderStart.runId;

      // Let each run's own automatic first turn.end pass and clear `clearCalls` of that noise — this
      // case is about the APPROVAL trigger, not the "always" trigger case 2 covers on its own.
      await waitFor(() => db.prepare(`SELECT 1 FROM event_log WHERE run_id = ? AND type = 'turn.end'`).get(coderRunId), { what: "coder's first turn.end" });
      await waitFor(() => db.prepare(`SELECT 1 FROM event_log WHERE run_id = ? AND type = 'turn.end'`).get(reviewerRunId), { what: "reviewer's first turn.end" });
      await waitFor(() => db.prepare(`SELECT 1 FROM event_log WHERE run_id = ? AND type = 'turn.end'`).get(bystanderRunId), { what: "bystander's first turn.end" });
      clearCalls.length = 0;

      await supervisor.recordVerdict({ taskId: "t1", workerId: "w-r1", slot: "reviewer1", round: 1, commitSha: "sha1", dimension: "correctness", verdict: "approved" });
      await supervisor.recordVerdict({ taskId: "t1", workerId: "w-r2", slot: "reviewer2", round: 1, commitSha: "sha1", dimension: "correctness", verdict: "approved" });
      const approved = await supervisor.approveTask("t1", { actor: "cto" });
      assert.equal(approved.approved, true, `precondition: t1 must actually approve; refused: ${JSON.stringify(approved.refused)}`);
      assert.ok(latestTaskHandoff(db, "t1"), "precondition: the handoff regenerated (Rule 4) — the same moment clearing is tied to");

      // The clear calls are fired-and-forgotten (`.catch()`, never awaited by `approveTaskLocked`) — wait
      // for them to actually land rather than asserting the instant `approveTask` returns.
      await waitFor(() => clearCalls.includes(coderRunId), { what: "the coder's run to be cleared (on-state-transition)" });
      await waitFor(() => clearCalls.includes(reviewerRunId), { what: "the reviewer's run to be cleared (per-review-round)" });

      assert.ok(!clearCalls.includes(bystanderRunId),
        `approving t1 must never clear the bystander's unrelated run on t2; calls: ${JSON.stringify(clearCalls)}`);
      console.log('  1. approveTask clears the coder\'s run ("state-transition") and the reviewer\'s run ("review-round-concluded"), never a bystander\'s unrelated run');

      await supervisor.stop(coderRunId);
      await supervisor.stop(reviewerRunId);
      await supervisor.stop(bystanderRunId);
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    // The four utility-runner roles' BUILT-IN default is "always" -> fires on the pump's own `turn.end`,
    // with no task-level state transition or review verdict involved at all.
    {
      clearCalls.length = 0;
      const utilityTaskId = "t-util-1";
      createTask(db, { id: utilityTaskId, title: "push it", type: "git-push-task" });
      createWorker(db, { workerId: "w-util", nickname: "git-push-runner", role: "git-push-runner", taskId: utilityTaskId });

      // review-consolidated-2026-09-14.md finding 4: this fake harness can't deliver an mcpConfig; this
      // case is about the "always" clear trigger, not MCP delivery, so it opts into the degraded run.
      const started = await supervisor.start({ harnessId: "fake", workerId: "w-util", spec: { cwd: stateDir, prompt: "push", allowDegradedMcp: true } });
      // The fake child runs its first turn immediately on spawn — this IS the "always" trigger, not a
      // second, manufactured one.
      await waitFor(() => clearCalls.includes(started.runId), { what: "the utility run to be cleared on its own turn.end (always)" });
      console.log('  2. a utility ("always") role\'s run is cleared on its own turn.end, with no task-level trigger involved');
      await supervisor.stop(started.runId);
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    // A harness with NO clearContext support at all must never be called, regardless of what any policy
    // says — `domain/clear-policy.js`'s own capability gate, proven against a real (if minimal) adapter.
    {
      const noClearHarness = {
        ...harness,
        capabilities: () => ({ ...harness.capabilities(), clearContext: false }),
      };
      const noClearCalls = spyOnClearContext(noClearHarness);
      const s2 = createSupervisor({ db, stateDir, adapters: { fake: noClearHarness }, askSweepIntervalMs: 0, logger: quiet });
      await s2.boot();
      createTask(db, { id: "t-noclear", title: "no clear support", type: "git-push-task" });
      createWorker(db, { workerId: "w-noclear", nickname: "git-push-runner", role: "git-push-runner", taskId: "t-noclear" });
      // review-consolidated-2026-09-14.md finding 4: same reason as case 2 above.
      const started = await s2.start({ harnessId: "fake", workerId: "w-noclear", spec: { cwd: stateDir, prompt: "push", allowDegradedMcp: true } });
      await waitFor(() => db.prepare(`SELECT 1 FROM event_log WHERE run_id = ? AND type = 'turn.end'`).get(started.runId), { what: "no-clear run's turn.end" });
      // A settling window, not a wait-for-truth: this asserts an ABSENCE, so there is no positive event
      // to wait for — give the fire-and-forget hook time to have run (and refused) before checking.
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(noClearCalls, [], "a harness declaring clearContext: false must never be called, regardless of policy");
      await s2.stop(started.runId);
      await s2.shutdown({ timeoutMs: 2000 });
      console.log("  3. a harness with no clearContext support is never called, regardless of policy");
    }
  } finally {
    try { await supervisor?.shutdown?.({ timeoutMs: 3000 }); } catch { /* best-effort */ }
    try { closeDb(db); } catch { /* already closed */ }
    rmScratchDir(stateDir);
  }
});
