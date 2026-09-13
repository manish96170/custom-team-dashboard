// worktree.test.js — the shared per-task worktree lifecycle (PLAN.md §7, added 2026-09-10).
//
// No mocked git: every case below runs `git worktree add`/`remove` against a real throwaway repo in
// `os.tmpdir()`, the same "verify the mechanism, not just the conclusion" rule this project applies
// everywhere else that touches a real OS resource (crash-recovery's real SIGKILL, concurrency's real
// process groups). There is no "pre-fix" version of this code, so per the standing rule for brand-new
// mechanisms (see FINDINGS.md's notes on Group 5), the cases below are what stands in for that —
// asserting the real git side effect, not just the returned object shape.
//
// Cases:
//   1. createTaskWorktree makes a real worktree, sets tasks.worktree_id/branch, and is IDEMPOTENT
//   2. discardTaskWorktree refuses on a non-terminal task
//   3. discardTaskWorktree removes the worktree and clears the columns once the task is terminal
//   4. requestWorktree refuses with no reason
//   5. requestWorktree creates a genuinely separate directory from the task's shared worktree
//   6. the capability/coverage wiring for all three commands is intact (belt-and-braces alongside
//      authorization.test.js's own coverage case)
//   7. discardTaskWorktree refuses while an open run still uses the worktree, even on a terminal task,
//      and succeeds once that run ends (added 2026-09-11)
//   8. requestWorktree binds a worker-backed principal to its own run; no-principal callers unaffected
//      (added 2026-09-11)
//   9. createTaskWorktree is race-safe ACROSS REAL PROCESSES: N concurrent callers on the same task
//      produce exactly one real git worktree and a consistent task row (added 2026-09-11)
//   10. the deterministic, forced-interleaving version of case 9 (added 2026-09-11)
//   11. createTaskWorktree refuses a conflicting repoPath/branch, finalized or still pending
//      (codexdoc/review-luna-2026-09-11.md finding 5, added 2026-09-11)
//   12. a crashed worktree claim recovers instead of deadlocking forever (finding 6, added 2026-09-11)
//   13. assignTask refuses a terminal task outright (finding 7, added 2026-09-11)
//   14. discardTaskWorktree refuses a dirty worktree unless force: true (finding 8, added 2026-09-11)

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import {
  openDb, closeDb, upsertHarness, createTask, createWorker, createRun, endRun, WORKTREE_CLAIM_PENDING,
  claimTaskWorktreeSlot, reclaimStaleTaskWorktreeClaim, finalizeTaskWorktreeSlot, releaseTaskWorktreeClaim,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { COMMAND_CAPABILITIES, assertCoversCommands } from "../../domain/capabilities.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RACE_CHILD_SCRIPT = path.join(__dirname, "_worktree-race-child.js");
const CLAIM_RACE_CHILD_SCRIPT = path.join(__dirname, "_worktree-claim-race-child.js");

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRealRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

function runRaceChild(stateDir, index, barrierPath, taskId, repoPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RACE_CHILD_SCRIPT, stateDir, String(index), barrierPath, taskId, repoPath], {
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

async function waitForRaceReady(barrierDir, barrierPath, n, prefix = "") {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ready = fs.readdirSync(barrierDir).filter((f) => f.includes(`${prefix}.ready.`)).length;
    if (ready === n) break;
    if (Date.now() > deadline) throw new Error(`only ${ready}/${n} race children reported ready for barrier ${prefix || barrierPath}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  fs.writeFileSync(barrierPath, "");
}

function runClaimRaceChild(stateDir, index, readBarrierPath, claimBarrierPath, taskId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLAIM_RACE_CHILD_SCRIPT, stateDir, String(index), readBarrierPath, claimBarrierPath, taskId], {
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

await runTest("shared per-task worktree lifecycle", async () => {
  const stateDir = makeScratchDir("supervisor-worktree-test");
  const repoDir = path.join(stateDir, "repo");
  let db;
  let supervisor;

  try {
    makeRealRepo(repoDir);

    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createTask(db, { id: "t1", title: "Task with a shared worktree", type: "feature" });
    createWorker(db, { workerId: "w-coder", nickname: "coder-1", role: "coder", taskId: "t1" });

    supervisor = createSupervisor({ db, adapters: { fake: createFakeHarness({ label: "worktree" }) }, logger: quiet, askSweepIntervalMs: 0 });
    await supervisor.boot();

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    let worktreePath;
    {
      const created = await supervisor.createTaskWorktree("t1", { repoPath: repoDir });
      assert.equal(created.created, true);
      assert.ok(fs.existsSync(created.worktreeId), "the worktree directory must actually exist on disk");
      assert.equal(created.branch, "ctd/t1");
      worktreePath = created.worktreeId;

      const row = db.prepare("SELECT worktree_id, branch FROM tasks WHERE id = 't1'").get();
      assert.equal(row.worktree_id, worktreePath, "tasks.worktree_id must be set to the real path");
      assert.equal(row.branch, "ctd/t1");

      // A real git worktree, confirmed the same way the rest of this codebase confirms git state
      // (runtime/supervisor.js's own currentHeadFor) -- not just "the function returned no error".
      const listed = git(repoDir, ["worktree", "list"]);
      assert.ok(listed.includes(worktreePath), "git itself must know about this worktree");

      // Idempotent: calling again must not error and must not create a second worktree entry.
      const again = await supervisor.createTaskWorktree("t1", { repoPath: repoDir });
      assert.equal(again.created, false, "a second call must recognize the existing worktree rather than redoing it");
      assert.equal(again.worktreeId, worktreePath);
      const listedAgain = git(repoDir, ["worktree", "list"]);
      assert.equal(
        listedAgain.split("\n").filter((l) => l.includes(worktreePath)).length, 1,
        "calling create twice must not produce two worktree entries for the same task",
      );
      console.log("  1. createTaskWorktree makes a real worktree, sets tasks.worktree_id/branch, and is IDEMPOTENT");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    {
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id = 't1'").get().state, "created",
        "precondition: the task is not terminal yet");
      const refused = await supervisor.discardTaskWorktree("t1");
      assert.equal(refused.ok, false);
      assert.equal(refused.refused, "not-terminal");
      assert.ok(fs.existsSync(worktreePath), "a refused discard must leave the worktree in place");
      console.log("  2. discardTaskWorktree refuses on a non-terminal task");
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      db.prepare("UPDATE tasks SET state = 'merged' WHERE id = 't1'").run();
      const discarded = await supervisor.discardTaskWorktree("t1", { actor: "owner" });
      assert.equal(discarded.discarded, true);
      assert.equal(fs.existsSync(worktreePath), false, "the worktree directory must actually be gone");
      const row = db.prepare("SELECT worktree_id, branch FROM tasks WHERE id = 't1'").get();
      assert.equal(row.worktree_id, null, "tasks.worktree_id must be cleared, not left pointing at a deleted path");
      assert.equal(row.branch, null);
      console.log("  3. discardTaskWorktree removes the worktree and clears the columns once the task is terminal");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    // Fresh task for the requestWorktree cases, so case 5 has a live shared worktree to branch off.
    createTask(db, { id: "t2", title: "Task for requestWorktree", type: "feature" });
    createWorker(db, { workerId: "w-coder-2", nickname: "coder-2", role: "coder", taskId: "t2" });
    const created2 = await supervisor.createTaskWorktree("t2", { repoPath: repoDir });
    createRun(db, { runId: "r1", workerId: "w-coder-2", harnessId: "fake", prompt: "isolated test" });
    {
      const refused = await supervisor.requestWorktree("r1", { reason: "" });
      assert.equal(refused.ok, false);
      assert.equal(refused.refused, "missing-reason");
      console.log("  4. requestWorktree refuses with no reason");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    {
      const overlay = await supervisor.requestWorktree("r1", { reason: "dry-run a destructive migration" });
      assert.ok(overlay.worktreePath, "must return a real path");
      assert.notEqual(overlay.worktreePath, created2.worktreeId,
        "the overlay must be a SEPARATE directory from the task's shared worktree");
      assert.ok(fs.existsSync(overlay.worktreePath), "the overlay worktree must actually exist on disk");
      assert.ok(fs.existsSync(created2.worktreeId), "creating the overlay must not disturb the shared worktree");
      const listed = git(repoDir, ["worktree", "list"]);
      assert.ok(listed.includes(overlay.worktreePath) && listed.includes(created2.worktreeId),
        "git must know about both worktrees independently");
      console.log("  5. requestWorktree creates a genuinely separate directory from the task's shared worktree");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    {
      for (const name of ["createTaskWorktree", "discardTaskWorktree", "requestWorktree"]) {
        assert.equal(COMMAND_CAPABILITIES[name], "task:worktree", `${name} must require task:worktree`);
      }
      const cover = assertCoversCommands(Object.keys(supervisor.commandHandlers()));
      assert.deepEqual(cover.missing, []);
      assert.deepEqual(cover.stale, []);
      console.log("  6. the capability/coverage wiring for all three commands is intact");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    // TERMINAL TASK STATE ALONE IS NOT A FILESYSTEM-LIFECYCLE LOCK. `mergeTask` moves a task to `merged`
    // without stopping any run using it, so a task can be terminal while an open run still writes into its
    // shared worktree. Found by both codex reviews (`codexdoc/review-phase7-uncommitted.md` finding 3,
    // `codexdoc/REVIEW-NOTES.md` finding 4), fixed 2026-09-11.
    {
      createTask(db, { id: "t-openrun", title: "terminal task, still-open run", type: "feature" });
      createWorker(db, { workerId: "w-openrun", nickname: "openrun", role: "coder", taskId: "t-openrun" });
      const created = await supervisor.createTaskWorktree("t-openrun", { repoPath: repoDir });
      createRun(db, { runId: "r-openrun", workerId: "w-openrun", harnessId: "fake", prompt: "still going" });
      db.prepare("UPDATE tasks SET state = 'cancelled' WHERE id = 't-openrun'").run();

      const refused = await supervisor.discardTaskWorktree("t-openrun");
      assert.equal(refused.ok, false, "a terminal task with an OPEN run must refuse discard");
      assert.equal(refused.refused, "open-run");
      assert.match(refused.error, /r-openrun/);
      assert.ok(fs.existsSync(created.worktreeId), "the worktree must still exist — nothing was deleted underneath the open run");

      // Once the run actually ends, the SAME terminal task can discard normally — the check is scoped to
      // OPEN runs, not a permanent block on this task.
      endRun(db, "r-openrun", { exitReason: "finished" });
      const discarded = await supervisor.discardTaskWorktree("t-openrun");
      assert.equal(discarded.discarded, true, JSON.stringify(discarded));
      assert.equal(fs.existsSync(created.worktreeId), false);
      console.log("  7. discardTaskWorktree refuses while an open run still uses the worktree, and succeeds once it ends");
    }

    // ── 8 ────────────────────────────────────────────────────────────────────────────
    // Cross-run ownership binding, added 2026-09-11 (`codexdoc/review-phase7-uncommitted.md` finding 4):
    // a worker-backed principal may only request an overlay for ITS OWN run.
    {
      const rightfulPrincipal = supervisor.ensureWorkerPrincipal("w-coder-2").principal;
      createWorker(db, { workerId: "w-impersonator", nickname: "impersonator", role: "coder" });
      const impersonatorPrincipal = supervisor.ensureWorkerPrincipal("w-impersonator").principal;
      createRun(db, { runId: "r-ownercheck", workerId: "w-coder-2", harnessId: "fake", prompt: "ownership test" });

      const impersonated = await supervisor.requestWorktree("r-ownercheck", { reason: "not mine", principal: impersonatorPrincipal });
      assert.equal(impersonated.ok, false);
      assert.equal(impersonated.refused, "not-your-run");

      const rightful = await supervisor.requestWorktree("r-ownercheck", { reason: "actually mine", principal: rightfulPrincipal });
      assert.ok(rightful.ok !== false, JSON.stringify(rightful));
      assert.ok(fs.existsSync(rightful.worktreePath));

      // No principal at all (e.g. an in-process/legacy caller) is unrestricted — this fix only binds a
      // WORKER-backed principal to its own run, it does not newly require a principal where none existed.
      createRun(db, { runId: "r-unowned-check", workerId: "w-coder-2", harnessId: "fake", prompt: "no principal" });
      const noPrincipal = await supervisor.requestWorktree("r-unowned-check", { reason: "no principal supplied" });
      assert.ok(noPrincipal.ok !== false, JSON.stringify(noPrincipal));

      console.log("  8. requestWorktree binds a worker-backed principal to its own run; no-principal callers unaffected");
    }

    // ── 9 ────────────────────────────────────────────────────────────────────────────
    // Cross-process creation race, added 2026-09-11 (`codexdoc/review-phase7-uncommitted.md` finding 2,
    // blocking). N REAL OS processes race `createTaskWorktree` on the SAME task, same shape as
    // `db/test/leases.test.js`'s cross-process lease race — a sequential pair of calls proves nothing
    // about a real race.
    {
      const raceRepoDir = path.join(stateDir, "race-repo");
      makeRealRepo(raceRepoDir);
      createTask(db, { id: "t-race", title: "cross-process worktree race", type: "feature" });

      const barrierDir = makeScratchDir("supervisor-worktree-race-barrier");
      const barrierPath = path.join(barrierDir, "go");
      const N = 6;
      try {
        const pending = Array.from({ length: N }, (_, i) => runRaceChild(stateDir, i, barrierPath, "t-race", raceRepoDir));
        await waitForRaceReady(barrierDir, barrierPath, N);
        const results = await Promise.all(pending);

        const failed = results.filter((r) => r.code !== 0);
        assert.equal(failed.length, 0, failed.map((r) => `child ${r.index} exited ${r.code}\n${r.stderr}`).join("\n---\n"));

        const reports = results.map((r) => JSON.parse(r.stdout.trim()));
        const createdReports = reports.filter((r) => r.created);
        // Exactly ONE child may have actually run `git worktree add` and gotten `created: true` — the
        // rest must have joined the winner's real result (idempotent attach) or, in the tightest possible
        // window, hit the bounded pending-claim wait. Either way, no report may claim `created: true` with
        // a DIFFERENT worktreeId than the others.
        assert.ok(createdReports.length >= 1, "at least one child must have actually created the worktree");
        const distinctPaths = new Set(reports.filter((r) => r.worktreeId).map((r) => r.worktreeId));
        assert.equal(distinctPaths.size, 1, `all children must agree on ONE worktree path, got: ${JSON.stringify([...distinctPaths])}`);

        const row = db.prepare("SELECT worktree_id, branch FROM tasks WHERE id = 't-race'").get();
        assert.ok(row.worktree_id && row.worktree_id !== " pending-worktree-claim ", "the task row must end up with a real, finalized path, never stuck on the claim marker");
        assert.equal(row.worktree_id, [...distinctPaths][0]);
        assert.ok(fs.existsSync(row.worktree_id));

        // Prove there is exactly ONE real linked git worktree registered for this repo (plus the main
        // checkout itself) — not two orphaned ones with only one attached to the task row, which is the
        // exact defect this fix closes.
        const listed = git(raceRepoDir, ["worktree", "list"]);
        const worktreeLines = listed.trim().split("\n").filter(Boolean);
        assert.equal(worktreeLines.length, 2, `expected the main checkout + exactly 1 linked worktree, got:\n${listed}`);

        console.log(`  9. ${N} real processes race createTaskWorktree on the same task; exactly one real worktree is created and every child agrees on it`);
      } finally {
        rmScratchDir(barrierDir);
      }
    }

    // ── 10 ───────────────────────────────────────────────────────────────────────────
    // The DETERMINISTIC version of case 9: case 9 alone doesn't prove the fix — it passed 3/3 times
    // against the OLD, unfixed code too, because 6 fast local `git worktree add` calls rarely actually
    // overlap without being forced to. This case uses TWO barriers (one after the read, one before the
    // claim attempt) to GUARANTEE every child observes the same stale value before any of them races to
    // claim it — the exact interleaving the review's own reproduction forced ("a barrier immediately
    // after each task SELECT"). Same lesson this project has hit before (FINDINGS.md: "a test that only
    // sometimes exercises its mechanism has not proven it").
    {
      createTask(db, { id: "t-claim-race", title: "deterministic claim race", type: "feature" });
      const barrierDir = makeScratchDir("supervisor-worktree-claim-race-barrier");
      const readBarrierPath = path.join(barrierDir, "read-go");
      const claimBarrierPath = path.join(barrierDir, "claim-go");
      const N = 8;
      try {
        const pending = Array.from({ length: N }, (_, i) => runClaimRaceChild(stateDir, i, readBarrierPath, claimBarrierPath, "t-claim-race"));
        await waitForRaceReady(barrierDir, readBarrierPath, N, "read-go");
        await waitForRaceReady(barrierDir, claimBarrierPath, N, "claim-go");
        const results = await Promise.all(pending);

        const failed = results.filter((r) => r.code !== 0);
        assert.equal(failed.length, 0, failed.map((r) => `child ${r.index} exited ${r.code}\n${r.stderr}`).join("\n---\n"));

        const reports = results.map((r) => JSON.parse(r.stdout.trim()));
        const claimed = reports.filter((r) => r.claimed);
        assert.equal(claimed.length, 1, `exactly 1 of ${N} children (ALL of which read the same stale value) must win the claim, got ${claimed.length}`);

        const row = db.prepare("SELECT worktree_id FROM tasks WHERE id = 't-claim-race'").get();
        assert.equal(row.worktree_id, WORKTREE_CLAIM_PENDING, "the winner's claim must actually be visible in the row");

        console.log(`  10. ${N} processes FORCED to read the same stale value all race the claim; exactly 1 wins (deterministic, not timing-dependent)`);
      } finally {
        rmScratchDir(barrierDir);
      }
    }

    // ── 11 ───────────────────────────────────────────────────────────────────────────
    // Finding 5 (`codexdoc/review-luna-2026-09-11.md`, blocking): a conflicting caller must be REFUSED,
    // not handed back the first caller's repo/branch as if it were idempotent success — checked against
    // both an already-finalized worktree and a still-pending claim.
    {
      const otherRepoDir = path.join(stateDir, "other-repo");
      makeRealRepo(otherRepoDir);

      createTask(db, { id: "t-mismatch", title: "conflicting repo/branch", type: "feature" });
      const first = await supervisor.createTaskWorktree("t-mismatch", { repoPath: repoDir, branch: "ctd/a" });
      assert.equal(first.created, true);

      const conflictingRepo = await supervisor.createTaskWorktree("t-mismatch", { repoPath: otherRepoDir, branch: "ctd/a" });
      assert.equal(conflictingRepo.ok, false, "a different repoPath for an already-finalized worktree must be refused");
      assert.equal(conflictingRepo.refused, "worktree-repo-mismatch");
      assert.ok(fs.existsSync(first.worktreeId), "the mismatch refusal must not touch the real worktree");

      const conflictingBranch = await supervisor.createTaskWorktree("t-mismatch", { repoPath: repoDir, branch: "ctd/b" });
      assert.equal(conflictingBranch.ok, false);
      assert.equal(conflictingBranch.refused, "worktree-branch-mismatch");

      // Same check on the PENDING side of the claim (before anything is finalized) — a caller naming a
      // different repo must be refused immediately, not made to wait out the poll budget only to receive
      // someone else's result.
      createTask(db, { id: "t-mismatch-pending", title: "conflicting repo while pending", type: "feature" });
      const pendingClaim = claimTaskWorktreeSlot(db, "t-mismatch-pending", {
        previousValue: null, repoPath: path.resolve(repoDir), branch: "ctd/t-mismatch-pending",
      });
      assert.equal(pendingClaim.claimed, true, "test setup: the direct DB claim must succeed");

      const start = Date.now();
      const pendingMismatch = await supervisor.createTaskWorktree("t-mismatch-pending", { repoPath: otherRepoDir });
      const elapsedMs = Date.now() - start;
      assert.equal(pendingMismatch.ok, false);
      assert.equal(pendingMismatch.refused, "worktree-repo-mismatch");
      assert.ok(elapsedMs < 1000, `a pending-claim mismatch must refuse immediately, not poll first (took ${elapsedMs}ms)`);

      console.log("  11. createTaskWorktree refuses a conflicting repoPath/branch, both against a finalized worktree and a still-pending claim");
    }

    // ── 12 ───────────────────────────────────────────────────────────────────────────
    // Finding 6 (`codexdoc/review-luna-2026-09-11.md`, blocking): a claimant that crashes after
    // `claimTaskWorktreeSlot` and before finalizing must not deadlock every later caller forever. Both
    // simulate the crash directly (claim, then never finalize) and backdate `updated_at` past the
    // staleness threshold rather than actually sleeping 60s.
    {
      // 12a: the crashed claimant's real git work never happened — recovery must run it.
      createTask(db, { id: "t-stale-redo", title: "stale claim, nothing on disk yet", type: "feature" });
      const resolvedRepoPath = path.resolve(repoDir);
      const redoClaim = claimTaskWorktreeSlot(db, "t-stale-redo", {
        previousValue: null, repoPath: resolvedRepoPath, branch: "ctd/t-stale-redo",
      });
      assert.equal(redoClaim.claimed, true);
      db.prepare("UPDATE tasks SET updated_at = ? WHERE id = 't-stale-redo'")
        .run(new Date(Date.now() - 10 * 60_000).toISOString());

      const recoveredRedo = await supervisor.createTaskWorktree("t-stale-redo", { repoPath: repoDir });
      assert.equal(recoveredRedo.ok, undefined, JSON.stringify(recoveredRedo));
      assert.equal(recoveredRedo.created, true, "nothing existed on disk, so recovery must have done the real git work");
      assert.equal(recoveredRedo.recoveredFromCrashedClaim, true);
      assert.ok(fs.existsSync(recoveredRedo.worktreeId));
      const rowRedo = db.prepare("SELECT worktree_id FROM tasks WHERE id = 't-stale-redo'").get();
      assert.equal(rowRedo.worktree_id, recoveredRedo.worktreeId, "the row must be finalized, not left pending");

      // 12b: the crashed claimant's git work DID land before it died — recovery must adopt it, not
      // duplicate it.
      createTask(db, { id: "t-stale-adopt", title: "stale claim, git already succeeded", type: "feature" });
      const adoptClaim = claimTaskWorktreeSlot(db, "t-stale-adopt", {
        previousValue: null, repoPath: resolvedRepoPath, branch: "ctd/t-stale-adopt",
      });
      assert.equal(adoptClaim.claimed, true);
      const preCreatedPath = path.join(resolvedRepoPath, ".git", "ctd-worktrees", "t-stale-adopt");
      fs.mkdirSync(path.dirname(preCreatedPath), { recursive: true });
      execFileSync("git", ["worktree", "add", "-b", "ctd/t-stale-adopt", preCreatedPath], {
        cwd: repoDir, stdio: ["ignore", "pipe", "pipe"],
      });
      db.prepare("UPDATE tasks SET updated_at = ? WHERE id = 't-stale-adopt'")
        .run(new Date(Date.now() - 10 * 60_000).toISOString());

      const listedBefore = git(repoDir, ["worktree", "list"]).trim().split("\n").filter(Boolean).length;
      const recoveredAdopt = await supervisor.createTaskWorktree("t-stale-adopt", { repoPath: repoDir });
      assert.equal(recoveredAdopt.created, false, "the git work already existed — recovery must ADOPT it, not redo it");
      assert.equal(recoveredAdopt.recoveredFromCrashedClaim, true);
      assert.equal(recoveredAdopt.worktreeId, preCreatedPath);
      const listedAfter = git(repoDir, ["worktree", "list"]).trim().split("\n").filter(Boolean).length;
      assert.equal(listedAfter, listedBefore, "adopting an existing worktree must not create a duplicate");

      console.log("  12. a crashed worktree claim recovers instead of deadlocking forever — redoing the git work if it never happened, adopting it if it did");
    }

    // ── 13 ───────────────────────────────────────────────────────────────────────────
    // Finding 7 (`codexdoc/review-luna-2026-09-11.md`, blocking): assignTask must refuse a terminal task
    // outright — otherwise a start landing between discardTaskWorktree's open-run check and its actual
    // `git worktree remove` can be deleted out from under the run it just created.
    {
      createTask(db, { id: "t-terminal-assign", title: "terminal task, no reopen", type: "feature" });
      createWorker(db, { workerId: "w-terminal-assign", nickname: "terminal", role: "coder", taskId: "t-terminal-assign" });
      db.prepare("UPDATE tasks SET state = 'merged' WHERE id = 't-terminal-assign'").run();

      const result = await supervisor.assignTask("t-terminal-assign", {});
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.refused, "task-terminal");
      assert.equal(result.assigned, false);

      const openRuns = db.prepare(
        "SELECT r.run_id AS runId FROM runs r JOIN workers w ON r.worker_id = w.worker_id WHERE w.task_id = ? AND r.ended_at IS NULL",
      ).all("t-terminal-assign");
      assert.equal(openRuns.length, 0, "a refused assignTask must not have started anything");

      console.log("  13. assignTask refuses a terminal task outright, closing its race against discardTaskWorktree's open-run check");
    }

    // ── 14 ───────────────────────────────────────────────────────────────────────────
    // Finding 8 (`codexdoc/review-luna-2026-09-11.md`, should-fix): a terminal task with no open run can
    // still have uncommitted work sitting in its worktree — the unconditional `--force` used to delete it
    // with no trace. Must refuse by default; `force: true` is the explicit, named override.
    {
      createTask(db, { id: "t-dirty", title: "terminal task, dirty worktree", type: "feature" });
      const created = await supervisor.createTaskWorktree("t-dirty", { repoPath: repoDir });
      fs.writeFileSync(path.join(created.worktreeId, "uncommitted.txt"), "not committed\n");
      db.prepare("UPDATE tasks SET state = 'cancelled' WHERE id = 't-dirty'").run();

      const refused = await supervisor.discardTaskWorktree("t-dirty");
      assert.equal(refused.ok, false, JSON.stringify(refused));
      assert.equal(refused.refused, "worktree-dirty");
      assert.ok(fs.existsSync(created.worktreeId), "a refused discard must leave the dirty worktree in place");
      assert.ok(fs.existsSync(path.join(created.worktreeId, "uncommitted.txt")));

      const forced = await supervisor.discardTaskWorktree("t-dirty", { force: true });
      assert.equal(forced.discarded, true, JSON.stringify(forced));
      assert.equal(fs.existsSync(created.worktreeId), false, "force: true must actually remove the dirty worktree");

      console.log("  14. discardTaskWorktree refuses a dirty worktree by default and only removes it with an explicit force: true");
    }

    // ── 15 ───────────────────────────────────────────────────────────────────────────
    // review-sol-2026-09-13.md finding 2 (create side): a worker/reviewer principal may only create the
    // worktree for the task it is CURRENTLY assigned to. Before this fix there was no ownership check at
    // all — any worker's token could create task worktrees anywhere.
    {
      createTask(db, { id: "t-owned-create", title: "ownership-checked create", type: "feature" });
      createTask(db, { id: "t-other-create", title: "a different task", type: "feature" });
      createWorker(db, { workerId: "w-owns-create", nickname: "owns-create", role: "coder", taskId: "t-owned-create" });
      const creatorPrincipal = supervisor.ensureWorkerPrincipal("w-owns-create").principal;

      const wrongTask = await supervisor.createTaskWorktree("t-other-create", { repoPath: repoDir, principal: creatorPrincipal });
      assert.equal(wrongTask.ok, false, JSON.stringify(wrongTask));
      assert.equal(wrongTask.refused, "not-your-task");
      assert.equal(db.prepare("SELECT worktree_id FROM tasks WHERE id = 't-other-create'").get().worktree_id, null,
        "a refused cross-task create must not have touched the other task's row at all");

      const ownTask = await supervisor.createTaskWorktree("t-owned-create", { repoPath: repoDir, principal: creatorPrincipal });
      assert.ok(ownTask.ok !== false, JSON.stringify(ownTask));
      assert.ok(fs.existsSync(ownTask.worktreeId));

      // No principal at all (in-process/legacy caller) remains unrestricted.
      createTask(db, { id: "t-noprincipal-create", title: "no principal supplied", type: "feature" });
      const noPrincipalCreate = await supervisor.createTaskWorktree("t-noprincipal-create", { repoPath: repoDir });
      assert.ok(noPrincipalCreate.ok !== false, JSON.stringify(noPrincipalCreate));

      console.log("  15. createTaskWorktree binds a worker-backed principal to its own assigned task; no-principal callers unaffected");
    }

    // ── 16 ───────────────────────────────────────────────────────────────────────────
    // review-sol-2026-09-13.md finding 2 (discard side): the same ownership boundary for
    // discardTaskWorktree, plus `force: true` must be refused outright for any worker/reviewer principal
    // — it is reserved for owner/CTO regardless of which task is named.
    {
      createTask(db, { id: "t-owned-discard", title: "ownership-checked discard", type: "feature" });
      createTask(db, { id: "t-other-discard", title: "someone else's task", type: "feature" });
      const otherCreated = await supervisor.createTaskWorktree("t-other-discard", { repoPath: repoDir });
      db.prepare("UPDATE tasks SET state = 'cancelled' WHERE id = 't-other-discard'").run();
      createWorker(db, { workerId: "w-owns-discard", nickname: "owns-discard", role: "coder", taskId: "t-owned-discard" });
      const discarderPrincipal = supervisor.ensureWorkerPrincipal("w-owns-discard").principal;

      const wrongDiscard = await supervisor.discardTaskWorktree("t-other-discard", { principal: discarderPrincipal });
      assert.equal(wrongDiscard.ok, false, JSON.stringify(wrongDiscard));
      assert.equal(wrongDiscard.refused, "not-your-task");
      assert.ok(fs.existsSync(otherCreated.worktreeId), "a refused cross-task discard must leave the other task's worktree in place");

      const created = await supervisor.createTaskWorktree("t-owned-discard", { repoPath: repoDir });
      fs.writeFileSync(path.join(created.worktreeId, "uncommitted-owned.txt"), "not committed\n");
      db.prepare("UPDATE tasks SET state = 'cancelled' WHERE id = 't-owned-discard'").run();

      const forceRefused = await supervisor.discardTaskWorktree("t-owned-discard", { force: true, principal: discarderPrincipal });
      assert.equal(forceRefused.ok, false, JSON.stringify(forceRefused));
      assert.equal(forceRefused.refused, "force-not-permitted");
      assert.ok(fs.existsSync(created.worktreeId), "a refused force must leave the worktree in place");

      const ownDiscard = await supervisor.discardTaskWorktree("t-owned-discard", { force: true });
      assert.equal(ownDiscard.discarded, true, JSON.stringify(ownDiscard));

      console.log("  16. discardTaskWorktree binds a worker-backed principal to its own assigned task and always refuses force: true from it");
    }

    // ── 17 ───────────────────────────────────────────────────────────────────────────
    // review-sol-2026-09-13.md finding 7: `git status` failing (not just "returning clean") must not be
    // silently treated as clean and authorize a force-remove. A `worktree_id` pointing at a real directory
    // that is NOT a git worktree makes `git status --porcelain` genuinely fail.
    {
      createTask(db, { id: "t-status-error", title: "unverifiable worktree status", type: "feature" });
      const notAWorktree = path.join(stateDir, "not-a-git-worktree");
      fs.mkdirSync(notAWorktree, { recursive: true });
      db.prepare("UPDATE tasks SET state = 'cancelled', worktree_id = ?, branch = 'whatever' WHERE id = 't-status-error'").run(notAWorktree);

      const refused = await supervisor.discardTaskWorktree("t-status-error");
      assert.equal(refused.ok, false, JSON.stringify(refused));
      assert.equal(refused.refused, "worktree-status-unknown", "a git-status failure must be its own refusal, never silently 'clean'");
      assert.ok(fs.existsSync(notAWorktree), "an unverified status must never authorize removal");

      console.log("  17. discardTaskWorktree refuses to remove a worktree whose status git genuinely could not determine, rather than treating the failure as clean");
    }

    // ── 18 ───────────────────────────────────────────────────────────────────────────
    // review-sol-2026-09-13.md finding 9: the pending marker itself never changed identity across a
    // reclaim, so the ORIGINAL claimant — merely slow, not actually dead — could still finalize/release
    // successfully after being reclaimed, silently overwriting whatever the reclaimer's own (possibly
    // different) real git work had already finalized. A per-claim token now makes that impossible: only
    // the CURRENT token holder can resolve a claim.
    {
      createTask(db, { id: "t-stale-token", title: "stale claimant token test", type: "feature" });
      const original = claimTaskWorktreeSlot(db, "t-stale-token", { previousValue: null, repoPath: repoDir, branch: "orig-branch" });
      assert.equal(original.claimed, true);
      assert.ok(original.claimToken, "a real claim must mint a real token");

      // Simulate the original claimant going stale, and a second process reclaiming it.
      const reclaim = reclaimStaleTaskWorktreeClaim(db, "t-stale-token", { staleBeforeIso: new Date(Date.now() + 1000).toISOString() });
      assert.equal(reclaim.reclaimed, true);
      assert.ok(reclaim.claimToken, "a reclaim must mint its own real token");
      assert.notEqual(reclaim.claimToken, original.claimToken, "the reclaim's token must NOT be the same as the original claimant's");

      // ORDER MATTERS, and matches the real vulnerability exactly: the ORIGINAL claimant is not
      // actually dead, just slow — it is STILL RUNNING ITS OWN git work, unaware it was reclaimed, and
      // finishes and calls finalize FIRST, before the reclaimer's own (separately redone) work does.
      // Without a per-claim token, `worktree_id` is still the plain PENDING marker at this point (a
      // reclaim only bumps `updated_at`), so the stale claimant's finalize would incorrectly succeed —
      // and the REAL winner (the reclaimer, whose work is the one actually trusted to be current) would
      // then find the row no longer PENDING and fail, losing its own correct result. That ordering is
      // the actual "stale loser overwrites/precedes the real winner" defect, not the reverse.
      const staleFinalizeAttempt = finalizeTaskWorktreeSlot(db, "t-stale-token", {
        worktreeId: "/stale/wrong/path", branch: "original-branch", repoPath: repoDir, claimToken: original.claimToken,
      });
      assert.equal(staleFinalizeAttempt.finalized, false, "the ORIGINAL claimant's stale token must not be able to finalize once reclaimed, even finalizing FIRST");
      const rowAfterStale = db.prepare("SELECT worktree_id FROM tasks WHERE id = 't-stale-token'").get();
      assert.equal(rowAfterStale.worktree_id, WORKTREE_CLAIM_PENDING, "a refused stale finalize must not have touched the row at all");

      // The reclaimer, holding the CURRENT token, finalizes successfully with its own real result.
      const reclaimerPath = path.join(stateDir, "reclaimer-worktree");
      const finalizedByReclaimer = finalizeTaskWorktreeSlot(db, "t-stale-token", {
        worktreeId: reclaimerPath, branch: "reclaimer-branch", repoPath: repoDir, claimToken: reclaim.claimToken,
      });
      assert.equal(finalizedByReclaimer.finalized, true, "the reclaimer, holding the CURRENT token, must be able to finalize");
      const row = db.prepare("SELECT worktree_id, branch FROM tasks WHERE id = 't-stale-token'").get();
      assert.equal(row.worktree_id, reclaimerPath, "the reclaimer's real result must be what the row ends up with");
      assert.equal(row.branch, "reclaimer-branch");

      // The stale claimant trying to RELEASE (rather than finalize) with its old token must fail too,
      // and must not disturb the reclaimer's already-finalized result.
      const staleReleaseAttempt = releaseTaskWorktreeClaim(db, "t-stale-token", { previousValue: null, claimToken: original.claimToken });
      assert.equal(staleReleaseAttempt.released, false, "the ORIGINAL claimant's stale token must not be able to release once reclaimed either");
      const rowAfterReleaseAttempt = db.prepare("SELECT worktree_id FROM tasks WHERE id = 't-stale-token'").get();
      assert.equal(rowAfterReleaseAttempt.worktree_id, reclaimerPath, "a stale release attempt must not have cleared the reclaimer's real result");

      console.log("  18. a stale claimant's old token can no longer finalize or release a claim once a reclaim has minted a new one");
    }

    // ── 19 ───────────────────────────────────────────────────────────────────────────
    // review-sol-2026-09-13.md finding 23: `createTaskWorktree`/`discardTaskWorktree`/`worktreeStatus`
    // used to run every git call through `execFileSync` — blocking the WHOLE daemon event loop for as
    // long as the child ran, not just this call's own logic. Same real-slow-git-process technique
    // `git-create-push.test.js` case 7 already uses (there via a slow pre-commit hook; here via a slow
    // `git` on PATH, since worktree operations don't go through hooks at all).
    {
      const realGitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const slowGitDir = path.join(stateDir, "slow-git-bin");
      fs.mkdirSync(slowGitDir, { recursive: true });
      const slowGitPath = path.join(slowGitDir, "git");
      fs.writeFileSync(slowGitPath, `#!/bin/sh\nsleep 1\nexec "${realGitPath}" "$@"\n`, { mode: 0o755 });

      createTask(db, { id: "t-nonblocking-worktree", title: "event loop check", type: "feature" });
      const originalPath = process.env.PATH;
      let ticks = 0;
      let ticker;
      try {
        process.env.PATH = `${slowGitDir}:${originalPath}`;
        ticker = setInterval(() => { ticks += 1; }, 10);
        // The outcome is irrelevant — what matters is that the daemon's event loop kept ticking while
        // this ~1s-slowed git call was in flight, proving it is genuinely awaited, not blocking.
        await supervisor.createTaskWorktree("t-nonblocking-worktree", { repoPath: repoDir }).catch(() => {});
      } finally {
        clearInterval(ticker);
        process.env.PATH = originalPath;
      }
      assert.ok(ticks > 20,
        `the event loop must keep servicing timers while a slow git worktree call runs (only ${ticks} ticks across ~1s of delay -- looks blocked)`);
      console.log(`  19. the event loop kept servicing timers (${ticks} ticks) while a slow git worktree call ran — createTaskWorktree no longer blocks it`);
    }
  } finally {
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* best effort */ }
    try { if (db) closeDb(db); } catch { /* best effort */ }
    rmScratchDir(stateDir);
  }
});
