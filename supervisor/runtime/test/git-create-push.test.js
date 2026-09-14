// git-create-push.test.js — the supervisor-level glue for the git-create-push agent (PLAN.md §8 Rule 2,
// §16, §20), added 2026-09-10 as Phase 7 step 5: the first real consumer of both the shared per-task
// worktree (step 3, `worktree.test.js`) and resource leases (step 4, `leases.test.js`). The pure fight
// loop itself (classification, autofix, no database) is tested in isolation in
// `agents/test/git-create-push.test.js` — this file is what proves the two pieces actually work
// TOGETHER: a task's real worktree, a real `git:identity` lease held across the push, and the
// authorization wiring (`git:push` vs the SENSITIVE `git:push-protected`).
//
// Cases:
//   1. a clean push through supervisor.gitCreatePush succeeds, and the git:identity lease is released
//      afterward (not left held)
//   2. wire-level: `gitPush` succeeds for a `utility:git` principal
//   3. wire-level: `gitPushProtected` is refused with no approval, and succeeds once one is granted,
//      bound to the exact arguments (reusing grantApproval, same mechanism as mergeTask/task:merge)
//   4. cross-process contention: a REAL separate OS process holds `git:identity` (via the same
//      `_lease-race-child.js` `db/test/leases.test.js` uses for its own race), and gitCreatePush called
//      from THIS process is genuinely blocked by it
//   5. a thrown mid-loop error (a task whose worktree_id points nowhere) still releases the lease —
//      the finally must run even when runFightLoop throws rather than returning a refusal
//   6. capability/coverage wiring for gitPush and gitPushProtected is intact
//   7. the daemon's event loop is NOT starved while a slow git call is in flight (finding 12,
//      codexdoc/REVIEW-NOTES.md, added 2026-09-11)
//   8. gitPush cannot be used to bypass gitPushProtected's signature for a protected destination

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import {
  openDb, closeDb, upsertHarness, createTask, createWorker, listActiveLeases,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { COMMAND_CAPABILITIES, assertCoversCommands } from "../../domain/capabilities.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEASE_CHILD_SCRIPT = path.join(__dirname, "..", "..", "db", "test", "_lease-race-child.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

function makeBareRemote(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "--bare"]);
}

/** Runs `_lease-race-child.js` to completion (no barrier wait — the file is pre-created) and returns its
 *  parsed result. A REAL separate process, not a simulation: the lease row it leaves behind persists in
 *  the shared SQLite file after this process exits, because the child never releases it. */
function acquireInChildProcess(stateDir, resourceName, kind, capacity) {
  return new Promise((resolve, reject) => {
    const barrierPath = path.join(stateDir, "no-wait-barrier");
    fs.writeFileSync(barrierPath, ""); // already exists, so the child's poll loop passes immediately
    const child = spawn(process.execPath, [
      LEASE_CHILD_SCRIPT, stateDir, "0", barrierPath, resourceName, kind, capacity === null ? "null" : String(capacity),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`lease child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim())); } catch (err) { reject(err); }
    });
    child.on("error", reject);
  });
}

await runTest("git-create-push agent (supervisor glue)", async () => {
  const stateDir = makeScratchDir("supervisor-git-create-push-test");
  let db;
  let supervisor;

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });

    supervisor = createSupervisor({ db, adapters: { fake: createFakeHarness({ label: "gcp" }) }, logger: quiet, askSweepIntervalMs: 0 });
    const booted = await supervisor.boot();
    const owner = { id: booted.owner.id, kind: "human" };
    const ownerToken = fs.readFileSync(path.join(stateDir, "owner.token"), "utf8").trim();
    const gitAgent = supervisor.mintNamedPrincipal({ preset: "utility:git", displayName: "git-create-push" });

    // ── 1: a clean push through the supervisor function, lease released afterward ──────────
    {
      const repoDir = path.join(stateDir, "repo-1");
      const remoteDir = path.join(stateDir, "remote-1.git");
      makeRepo(repoDir);
      makeBareRemote(remoteDir);
      createTask(db, { id: "t-clean", title: "clean push", type: "feature" });
      createWorker(db, { workerId: "w1", nickname: "coder-1", role: "coder", taskId: "t-clean" });
      const created = await supervisor.createTaskWorktree("t-clean", { repoPath: repoDir });
      git(created.worktreeId, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(created.worktreeId, "new-file.txt"), "content\n");

      const result = await supervisor.gitCreatePush("t-clean", { principal: owner, message: "add new-file.txt" });
      assert.equal(result.status, "pushed", JSON.stringify(result));
      assert.deepEqual(listActiveLeases(db, "git:identity"), [], "the lease must be released once the push completes, not left held");
      console.log("  1. a clean push through supervisor.gitCreatePush succeeds and releases git:identity afterward");
    }

    // ── 2: wire-level gitPush for a utility:git principal ───────────────────────────────────
    {
      const repoDir = path.join(stateDir, "repo-2");
      const remoteDir = path.join(stateDir, "remote-2.git");
      makeRepo(repoDir);
      makeBareRemote(remoteDir);
      createTask(db, { id: "t-wire", title: "wire push", type: "feature" });
      createWorker(db, { workerId: "w2", nickname: "coder-2", role: "coder", taskId: "t-wire" });
      const created = await supervisor.createTaskWorktree("t-wire", { repoPath: repoDir });
      git(created.worktreeId, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(created.worktreeId, "another.txt"), "content\n");

      const wrapped = supervisor.authorizedCommandHandlers();
      const res = await wrapped.gitPush({ id: "gp1", token: gitAgent.token, taskId: "t-wire", message: "add another.txt" });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.status, "pushed");
      console.log("  2. wire-level `gitPush` succeeds for a utility:git principal");
    }

    // ── 3: gitPushProtected refused without an approval, succeeds once granted ─────────────
    {
      const repoDir = path.join(stateDir, "repo-3");
      const remoteDir = path.join(stateDir, "remote-3.git");
      makeRepo(repoDir);
      makeBareRemote(remoteDir);
      createTask(db, { id: "t-protected", title: "protected push", type: "feature" });
      createWorker(db, { workerId: "w3", nickname: "coder-3", role: "coder", taskId: "t-protected" });
      const created = await supervisor.createTaskWorktree("t-protected", { repoPath: repoDir });
      git(created.worktreeId, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(created.worktreeId, "protected.txt"), "content\n");

      const wrapped = supervisor.authorizedCommandHandlers();
      const args = { taskId: "t-protected", message: "add protected.txt" };

      const refused = await wrapped.gitPushProtected({ id: "gpp1", token: gitAgent.token, ...args });
      assert.equal(refused.ok, false);
      assert.equal(refused.refused, "unauthorized");
      assert.equal(refused.needsApproval, true);

      const granted = await supervisor.grantApproval({
        granterToken: ownerToken, forPrincipal: gitAgent.id, action: "git:push-protected", args,
      });
      assert.equal(granted.granted, true, JSON.stringify(granted));

      const allowed = await wrapped.gitPushProtected({ id: "gpp2", token: gitAgent.token, ...args });
      assert.equal(allowed.ok, true, JSON.stringify(allowed));
      assert.equal(allowed.status, "pushed");

      // The approval was single-use, exactly like task:merge's.
      fs.writeFileSync(path.join(created.worktreeId, "protected2.txt"), "content\n");
      const reused = await wrapped.gitPushProtected({ id: "gpp3", token: gitAgent.token, ...args });
      assert.equal(reused.ok, false, "a consumed approval must not authorize a second push");
      console.log("  3. `gitPushProtected` is refused with no approval and succeeds once one is granted, bound to the exact args");
    }

    // ── 4: a REAL separate OS process holds git:identity; gitCreatePush here is genuinely blocked ──
    {
      const repoDir = path.join(stateDir, "repo-4");
      makeRepo(repoDir);
      createTask(db, { id: "t-blocked", title: "blocked by another process", type: "feature" });
      createWorker(db, { workerId: "w4", nickname: "coder-4", role: "coder", taskId: "t-blocked" });
      const created = await supervisor.createTaskWorktree("t-blocked", { repoPath: repoDir });
      fs.writeFileSync(path.join(created.worktreeId, "blocked.txt"), "content\n");

      const childResult = await acquireInChildProcess(stateDir, "git:identity", "exclusive", null);
      assert.equal(childResult.granted, true, "the child process must actually have acquired the lease for this test to mean anything");

      const result = await supervisor.gitCreatePush("t-blocked", { principal: owner, message: "add blocked.txt" });
      assert.equal(result.status, "blocked", JSON.stringify(result));
      assert.equal(result.unresolved.class, "hook-other");
      assert.match(result.unresolved.oneParagraphDiagnosis, /git:identity is held by principal p-child-0/);
      console.log("  4. a real separate OS process holding git:identity genuinely blocks gitCreatePush called from this process");

      // Clean up: release what the child left held, so it doesn't leak into later cases via the sweep only.
      const held = listActiveLeases(db, "git:identity")[0];
      if (held) db.prepare("UPDATE resource_leases SET released_at = ?, release_reason = 'test-cleanup' WHERE id = ?")
        .run(new Date().toISOString(), held.id);
    }

    // ── 5: a thrown mid-loop error still releases the lease ─────────────────────────────────
    {
      createTask(db, { id: "t-throws", title: "worktree points nowhere", type: "feature" });
      createWorker(db, { workerId: "w5", nickname: "coder-5", role: "coder", taskId: "t-throws" });
      db.prepare("UPDATE tasks SET worktree_id = ? WHERE id = ?").run(path.join(stateDir, "does-not-exist"), "t-throws");

      await assert.rejects(() => supervisor.gitCreatePush("t-throws", { principal: owner, message: "will never commit" }));
      assert.deepEqual(listActiveLeases(db, "git:identity"), [], "the finally must release the lease even when the fight loop throws");
      console.log("  5. a thrown mid-loop error still releases git:identity — the finally runs regardless");
    }

    // ── 6: capability/coverage wiring ───────────────────────────────────────────────────────
    {
      const names = Object.keys(supervisor.commandHandlers());
      assert.ok(names.includes("gitPush") && names.includes("gitPushProtected"));
      const cover = assertCoversCommands(names);
      assert.deepEqual(cover.missing, []);
      assert.deepEqual(cover.stale, []);
      assert.equal(COMMAND_CAPABILITIES.gitPush, "git:push");
      assert.equal(COMMAND_CAPABILITIES.gitPushProtected, "git:push-protected");
      console.log("  6. gitPush/gitPushProtected are covered by the capability map and the coverage check");
    }

    // ── 7: the daemon's event loop is NOT starved while a slow git call is in flight ────────
    // `codexdoc/REVIEW-NOTES.md` finding 12: the fight loop used to run every git call through
    // `execFileSync`, which blocks the WHOLE Node process for as long as the child runs — no socket
    // command, ask, digest, or sweep timer on the SAME daemon could make progress. A real, slow
    // pre-commit hook is the most direct way to observe this: a concurrent timer's tick RATE is the
    // event loop's own pulse, and a blocked loop starves it regardless of what git itself is doing.
    {
      const repoDir = path.join(stateDir, "repo-nonblocking");
      makeRepo(repoDir);
      createTask(db, { id: "t-nonblocking", title: "event loop check", type: "feature" });
      createWorker(db, { workerId: "w-nonblocking", nickname: "coder-nb", role: "coder", taskId: "t-nonblocking" });
      const created = await supervisor.createTaskWorktree("t-nonblocking", { repoPath: repoDir });
      // A linked worktree's `.git` is a FILE pointing at the main repo's real gitdir — hooks are shared
      // across all of a repo's worktrees and live in the MAIN repo's `.git/hooks/`, not per-worktree.
      fs.writeFileSync(
        path.join(repoDir, ".git", "hooks", "pre-commit"),
        "#!/bin/sh\nsleep 1\n",
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(created.worktreeId, "slow.txt"), "content\n");

      let ticks = 0;
      const ticker = setInterval(() => { ticks += 1; }, 10);
      try {
        // The outcome (pushed/failed/blocked) is irrelevant here — a bare repo with no remote will fail
        // at the push step, which is fine; what matters is that the CALL ran without starving the timer.
        await supervisor.gitCreatePush("t-nonblocking", { principal: owner, message: "add slow.txt" }).catch(() => {});
      } finally {
        clearInterval(ticker);
      }
      assert.ok(ticks > 20,
        `the event loop must keep servicing timers while a slow git hook runs (only ${ticks} ticks across ~1s of hook sleep -- looks blocked)`);
      console.log(`  7. the event loop kept servicing timers (${ticks} ticks) while a slow git hook ran — the fight loop no longer blocks it`);
    }

    // ── 8: gitPush cannot be used to bypass gitPushProtected's signature for a protected
    // destination — codex review finding (both jobs), fixed 2026-09-11 ─────────────────────
    {
      const repoDir = path.join(stateDir, "repo-7");
      const remoteDir = path.join(stateDir, "remote-7.git");
      makeRepo(repoDir);
      makeBareRemote(remoteDir);
      createTask(db, { id: "t-bypass", title: "bypass attempt", type: "feature" });
      createWorker(db, { workerId: "w7", nickname: "coder-7", role: "coder", taskId: "t-bypass" });
      const created = await supervisor.createTaskWorktree("t-bypass", { repoPath: repoDir });
      git(created.worktreeId, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(created.worktreeId, "sneaky.txt"), "content\n");

      const wrapped = supervisor.authorizedCommandHandlers();

      // The cheap command, aimed at "main" — this must be refused server-side, with NO approval
      // involved at all (it never even reaches the sensitive-approval machinery).
      const bypassAttempt = await wrapped.gitPush({
        id: "gp-bypass", token: gitAgent.token, taskId: "t-bypass", message: "sneak into main", targetBranch: "main",
      });
      assert.equal(bypassAttempt.ok, false, "gitPush must refuse a push whose destination is protected");
      assert.match(bypassAttempt.error, /protected destination/);
      assert.match(bypassAttempt.error, /gitPushProtected/);
      // Nothing was pushed — the remote must not have gained a "main" ref from this attempt.
      const remoteRefs = execFileSync("git", ["--git-dir", remoteDir, "branch", "--list", "main"], { encoding: "utf8" }).trim();
      assert.equal(remoteRefs, "", "the protected destination must not have received the push");

      // The SAME task, a NON-protected destination, still works via the cheap command.
      const okPush = await wrapped.gitPush({
        id: "gp-ok", token: gitAgent.token, taskId: "t-bypass", message: "sneak into main", targetBranch: "a-feature-branch",
      });
      assert.equal(okPush.ok, true, JSON.stringify(okPush));
      assert.equal(okPush.status, "pushed");

      // gitPushProtected against "main" must still require and consume an approval — the classification
      // above must not have weakened the strict path.
      fs.writeFileSync(path.join(created.worktreeId, "sneaky2.txt"), "content\n");
      const stillGated = await wrapped.gitPushProtected({
        id: "gpp-still", token: gitAgent.token, taskId: "t-bypass", message: "add sneaky2.txt", targetBranch: "main",
      });
      assert.equal(stillGated.ok, false);
      assert.equal(stillGated.needsApproval, true);
      const grant = await supervisor.grantApproval({
        granterToken: ownerToken, forPrincipal: gitAgent.id, action: "git:push-protected",
        args: { taskId: "t-bypass", message: "add sneaky2.txt", targetBranch: "main" },
      });
      assert.equal(grant.granted, true, JSON.stringify(grant));
      const nowAllowed = await wrapped.gitPushProtected({
        id: "gpp-still2", token: gitAgent.token, taskId: "t-bypass", message: "add sneaky2.txt", targetBranch: "main",
      });
      assert.equal(nowAllowed.ok, true, JSON.stringify(nowAllowed));
      console.log("  8. gitPush refuses a protected destination server-side; a non-protected one still works; gitPushProtected against \"main\" is unaffected");
    }

    // ── 9 ────────────────────────────────────────────────────────────────────────────
    // review-sol-2026-09-13.md finding 4: neither git command bound the caller to a task at all — a
    // REAL worker-backed utility:git principal (`ensureWorkerPrincipal`, the actual production path for
    // a git-push-runner — unlike `gitAgent` above, which is a standalone `mintNamedPrincipal` with no
    // `workerId` and therefore unrestricted) could name ANY task's worktree, not just the one it was
    // dispatched to work on.
    {
      const repoA = path.join(stateDir, "repo-9a");
      const remoteA = path.join(stateDir, "remote-9a.git");
      makeRepo(repoA);
      makeBareRemote(remoteA);
      createTask(db, { id: "t-own-9", title: "the runner's own task", type: "git-push-task" });
      createTask(db, { id: "t-other-9", title: "a different task", type: "feature" });
      createWorker(db, { workerId: "w-git-runner-9", nickname: "git-runner-9", role: "git-push-runner", taskId: "t-own-9" });
      const { token: runnerToken } = supervisor.ensureWorkerPrincipal("w-git-runner-9");
      const createdOther = await supervisor.createTaskWorktree("t-other-9", { repoPath: repoA });
      git(createdOther.worktreeId, ["remote", "add", "origin", remoteA]);
      fs.writeFileSync(path.join(createdOther.worktreeId, "unrelated.txt"), "content\n");

      const wrapped9 = supervisor.authorizedCommandHandlers();
      const wrongTaskAttempt = await wrapped9.gitPush({
        id: "gp-wrong-task", token: runnerToken, taskId: "t-other-9", message: "push someone else's task",
      });
      assert.equal(wrongTaskAttempt.ok, false, "a git-push-runner must not be able to push a task it is not assigned to");
      assert.match(wrongTaskAttempt.error, /may only push the task it is currently assigned to/);

      // The SAME check applies to the protected path — reaching it via a granted approval must not
      // bypass ownership. Grant the approval FIRST so the request reaches this handler's own body at
      // all (an unapproved sensitive command is refused by the authorization wrapper before any handler
      // code runs, which is a separate, already-tested gate — case 3, above).
      const wrongTaskArgs = { taskId: "t-other-9", message: "push someone else's task", targetBranch: "main" };
      const wrongTaskGrant = await supervisor.grantApproval({
        granterToken: ownerToken, forPrincipal: (await supervisor.ensureWorkerPrincipal("w-git-runner-9")).principal.id,
        action: "git:push-protected", args: wrongTaskArgs,
      });
      assert.equal(wrongTaskGrant.granted, true, JSON.stringify(wrongTaskGrant));
      const wrongTaskProtected = await wrapped9.gitPushProtected({ id: "gpp-wrong-task", token: runnerToken, ...wrongTaskArgs });
      assert.equal(wrongTaskProtected.ok, false);
      assert.match(wrongTaskProtected.error, /may only push the task it is currently assigned to/);

      // Its OWN assigned task still works normally.
      const repoB = path.join(stateDir, "repo-9b");
      const remoteB = path.join(stateDir, "remote-9b.git");
      makeRepo(repoB);
      makeBareRemote(remoteB);
      const createdOwn = await supervisor.createTaskWorktree("t-own-9", { repoPath: repoB });
      git(createdOwn.worktreeId, ["remote", "add", "origin", remoteB]);
      fs.writeFileSync(path.join(createdOwn.worktreeId, "mine.txt"), "content\n");
      const ownTaskPush = await wrapped9.gitPush({
        id: "gp-own-task", token: runnerToken, taskId: "t-own-9", message: "push my own task",
      });
      assert.equal(ownTaskPush.ok, true, JSON.stringify(ownTaskPush));

      // owner/CTO principals (no workerId) remain unrestricted.
      const ownerCrossTask = await wrapped9.gitPush({
        id: "gp-owner-cross", token: ownerToken, taskId: "t-other-9", message: "owner override",
      });
      assert.equal(ownerCrossTask.ok, true, JSON.stringify(ownerCrossTask));
      console.log("  9. gitPush/gitPushProtected refuse a worker-backed principal naming a task it is not assigned to; owner/CTO unrestricted");
    }

    // ── 10 ───────────────────────────────────────────────────────────────────────────
    // External review (ChatGPT, 2026-09-14) finding 5: `paths` was purely opt-in — nothing forced a
    // real caller to use it on a task whose shared worktree (PLAN.md §7) more than one worker is
    // actually assigned to, so a plain `git add -A` push risked staging and committing another
    // worker's unrelated, uncommitted change. `gitCreatePush` now refuses outright when the task has
    // more than one worker and no explicit `paths` was given — a solo-worker task (every OTHER case in
    // this file) is completely unaffected, matching this repo's own established "fail closed only when
    // the risk is real" convention.
    {
      const repoDir = path.join(stateDir, "repo-10");
      const remoteDir = path.join(stateDir, "remote-10.git");
      makeRepo(repoDir);
      makeBareRemote(remoteDir);
      createTask(db, { id: "t-shared-10", title: "shared worktree, two workers", type: "feature" });
      createWorker(db, { workerId: "w-coder-10a", nickname: "coder-10a", role: "coder", taskId: "t-shared-10" });
      createWorker(db, { workerId: "w-coder-10b", nickname: "coder-10b", role: "coder", taskId: "t-shared-10" });
      const created = await supervisor.createTaskWorktree("t-shared-10", { repoPath: repoDir });
      git(created.worktreeId, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(created.worktreeId, "mine.txt"), "content\n");
      fs.writeFileSync(path.join(created.worktreeId, "other-workers-unrelated-change.txt"), "not mine\n");

      const refused = await supervisor.gitCreatePush("t-shared-10", { principal: owner, message: "push without paths" });
      assert.equal(refused.status, "failed", `a two-worker task with no explicit paths must refuse, got ${JSON.stringify(refused)}`);
      assert.equal(refused.unresolved.class, "hook-other");
      assert.match(refused.unresolved.oneParagraphDiagnosis, /2 workers sharing this worktree/);
      assert.deepEqual(listActiveLeases(db, "git:identity"), [], "a refused-before-acquiring push must never leave the lease held");
      // Nothing was staged/committed/pushed — the risky unrelated file is still just sitting there.
      const statusAfterRefusal = git(created.worktreeId, ["status", "--porcelain"]);
      assert.match(statusAfterRefusal, /mine\.txt/);
      assert.match(statusAfterRefusal, /other-workers-unrelated-change\.txt/);

      const scoped = await supervisor.gitCreatePush("t-shared-10", { principal: owner, message: "push mine.txt only", paths: ["mine.txt"] });
      assert.equal(scoped.status, "pushed", `passing explicit paths on the same two-worker task must still succeed, got ${JSON.stringify(scoped)}`);
      const committedFiles = git(created.worktreeId, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n");
      assert.deepEqual(committedFiles, ["mine.txt"], "the explicit-paths push must commit ONLY the named file, not the other worker's unrelated change");
      const statusAfterScopedPush = git(created.worktreeId, ["status", "--porcelain"]);
      assert.match(statusAfterScopedPush, /other-workers-unrelated-change\.txt/, "the unrelated file must still be sitting there, uncommitted, after the scoped push");
      console.log("  10. gitCreatePush refuses a two-worker task's unscoped push by default, and an explicit paths push on the same task still commits only what was named");
    }

    closeDb(db);
  } finally {
    rmScratchDir(stateDir);
  }
});
