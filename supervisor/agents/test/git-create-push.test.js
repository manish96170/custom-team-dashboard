// git-create-push.test.js — the pure fight-loop (PLAN.md §8 Rule 2, agents/git-create-push.js), added
// 2026-09-10 as Phase 7 step 5. No supervisor, no database, no leases — just real git against a real
// throwaway repo and a real bare "remote", same "no mocked git" rule as `runtime/test/worktree.test.js`.
//
// Cases:
//   1. a clean commit pushes successfully to a local bare remote (file:// — no network)
//   2. classifyFailure recognises each of the 8 classes from realistic tool output
//   3. a `format`-classified failure is auto-fixed by a real `.git-create-push-autofix.sh` and re-run succeeds
//   4. a `typecheck`-classified failure is NOT auto-fixed — returns `unresolved` immediately, no raw output leaked
//   5. autofix is bounded: a script that never actually fixes anything exhausts MAX_COMMIT_ATTEMPTS and fails
//   6. a push rejected as a protected branch classifies as `protected-branch` and status is `blocked`
//   7. `paths`, when given, stages exactly those files and leaves an unrelated uncommitted change alone
//      (added 2026-09-11, codex review REVIEW-NOTES.md finding 5)
//   8. `paths` rejects an empty array or non-string entries rather than silently falling back to `-A`

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runFightLoop, classifyFailure, MAX_COMMIT_ATTEMPTS, AUTOFIX_SCRIPT_NAME } from "../git-create-push.js";

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

/** Installs a `.git/hooks/pre-commit` that runs a small script under our control, so classification and
 *  autofix are exercised against a REAL hook failure, not a hardcoded string. */
function installHook(repoDir, scriptBody) {
  const hooksDir = path.join(repoDir, ".git", "hooks");
  const hookPath = path.join(hooksDir, "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
}

function installAutofixScript(repoDir, scriptBody) {
  const scriptPath = path.join(repoDir, AUTOFIX_SCRIPT_NAME);
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
}

let failed = false;
async function testCase(name, fn) {
  try {
    await fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed = true;
    console.error(`  FAIL — ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ctd-gitpush-test-"));

try {
  // ── 1 ──────────────────────────────────────────────────────────────────────────────────
  await testCase("a clean commit pushes to a local bare remote", async () => {
    const repo = path.join(scratch, "repo-1");
    const remote = path.join(scratch, "remote-1.git");
    makeRepo(repo);
    makeBareRemote(remote);
    git(repo, ["remote", "add", "origin", remote]);
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");

    const result = await runFightLoop({ cwd: repo, message: "add file.txt", remote: "origin" });
    assert.equal(result.status, "pushed");
    assert.ok(Array.isArray(result.attempts) && result.attempts.length > 0);
    assert.equal(result.unresolved, undefined);

    // Prove it actually landed on the remote, not just that git exited 0.
    const remoteLog = execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
    assert.equal(remoteLog, "add file.txt");
  });

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────
  await testCase("classifyFailure recognises each of the 8 classes from realistic output", async () => {
    assert.equal(classifyFailure({ stderr: "CONFLICT (content): Merge conflict in a.txt" }), "conflict");
    assert.equal(classifyFailure({ stderr: "! [remote rejected] main -> main (protected branch hook declined)" }), "protected-branch");
    assert.equal(classifyFailure({ stdout: "Checking formatting...\nsrc/a.js\nCode style issues found in 1 file. Run Prettier to fix." }), "format");
    assert.equal(classifyFailure({ stdout: "eslint\n1 problem (1 error, 0 warnings)\n  1 error potentially fixable with the `--fix` option." }), "lint-autofixable");
    assert.equal(classifyFailure({ stdout: "eslint\nsrc/a.js\n  no-unused-vars: 'x' is defined but never used" }), "lint-semantic");
    assert.equal(classifyFailure({ stdout: "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'." }), "typecheck");
    assert.equal(classifyFailure({ stdout: "  1 failing\n  1) suite test: AssertionError: expected 1 to equal 2" }), "test");
    assert.equal(classifyFailure({ stdout: "some pre-commit hook exited 1 for a reason nobody anticipated" }), "hook-other");
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────
  await testCase("a format failure is auto-fixed by a real autofix script and the retry succeeds", async () => {
    const repo = path.join(scratch, "repo-3");
    const remote = path.join(scratch, "remote-3.git");
    makeRepo(repo);
    makeBareRemote(remote);
    git(repo, ["remote", "add", "origin", remote]);

    // The hook fails ONCE by checking a marker file the autofix script removes — a real failure with a
    // real fix, not a scripted pass-on-attempt-2.
    fs.writeFileSync(path.join(repo, "needs-format.txt"), "  bad   spacing  \n");
    installHook(repo, `
if [ -f .needs-format-marker ]; then
  echo "Code style issues found in 1 file. Run Prettier to fix."
  exit 1
fi
`);
    fs.writeFileSync(path.join(repo, ".needs-format-marker"), "1\n");
    installAutofixScript(repo, `
rm -f .needs-format-marker
sed -i.bak 's/  */ /g' needs-format.txt 2>/dev/null || sed -i '' 's/  */ /g' needs-format.txt
rm -f needs-format.txt.bak
`);

    const result = await runFightLoop({ cwd: repo, message: "add needs-format.txt", remote: "origin" });
    assert.equal(result.status, "pushed", JSON.stringify(result));
    const fixedAttempt = result.attempts.find((a) => a.class === "format");
    assert.ok(fixedAttempt, "an attempt should have been classified as format");
    assert.equal(fixedAttempt.autofix, true);
  });

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────
  await testCase("a typecheck failure is never auto-fixed and returns unresolved with no raw output leaked", async () => {
    const repo = path.join(scratch, "repo-4");
    makeRepo(repo);
    fs.writeFileSync(path.join(repo, "a.ts"), "const x: number = 'not a number';\n");
    installHook(repo, `echo "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'." >&2; exit 1`);
    // Deliberately no autofix script installed — typecheck must not be attempted regardless.

    const result = await runFightLoop({ cwd: repo, message: "add a.ts" });
    assert.equal(result.status, "failed");
    assert.equal(result.unresolved.class, "typecheck");
    assert.equal(result.attempts.length, 1, "typecheck is not autofixable, so there is no retry round");
    assert.ok(result.unresolved.oneParagraphDiagnosis.length < 500, "must be a paragraph, not a dump");
    assert.ok(!result.unresolved.oneParagraphDiagnosis.includes("\n\n\n"), "no raw multi-line tool output pasted verbatim");
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────
  await testCase("a script that never actually fixes anything exhausts the bounded attempts and fails", async () => {
    const repo = path.join(scratch, "repo-5");
    makeRepo(repo);
    fs.writeFileSync(path.join(repo, "b.txt"), "x\n");
    installHook(repo, `echo "Code style issues found in 1 file. Run Prettier to fix."; exit 1`);
    installAutofixScript(repo, `exit 0`); // "ran successfully" but changed nothing — the failure repeats

    const result = await runFightLoop({ cwd: repo, message: "add b.txt" });
    assert.equal(result.status, "failed");
    assert.equal(result.unresolved.class, "format");
    assert.equal(result.attempts.length, MAX_COMMIT_ATTEMPTS, "must stop exactly at the bound, not loop forever");
  });

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────
  await testCase("a push rejected by a protected-branch hook classifies as protected-branch and blocks rather than fails", async () => {
    const repo = path.join(scratch, "repo-6");
    const remote = path.join(scratch, "remote-6.git");
    makeRepo(repo);
    makeBareRemote(remote);
    // A real server-side rejection: a bare repo's `update` hook can refuse a ref update outright.
    fs.writeFileSync(path.join(remote, "hooks", "update"), `#!/bin/sh\necho "protected branch: main is protected" >&2\nexit 1\n`, { mode: 0o755 });
    git(repo, ["remote", "add", "origin", remote]);
    fs.writeFileSync(path.join(repo, "c.txt"), "y\n");

    const result = await runFightLoop({ cwd: repo, message: "add c.txt", remote: "origin" });
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(result.unresolved.class, "protected-branch");
  });

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────
  // `paths`, added 2026-09-11 (codex review, REVIEW-NOTES.md finding 5): on a SHARED worktree, `git add
  // -A` stages and pushes ANY uncommitted change present, not just the caller's own. Passing explicit
  // `paths` must stage exactly those and leave an unrelated uncommitted file untouched.
  await testCase("paths, when given, stages exactly those files and leaves an unrelated uncommitted change alone", async () => {
    const repo = path.join(scratch, "repo-7");
    const remote = path.join(scratch, "remote-7.git");
    makeRepo(repo);
    makeBareRemote(remote);
    git(repo, ["remote", "add", "origin", remote]);
    // Simulates ANOTHER worker's uncommitted work sitting in the same shared worktree.
    fs.writeFileSync(path.join(repo, "someone-elses-file.txt"), "not mine\n");
    fs.writeFileSync(path.join(repo, "mine.txt"), "my change\n");

    const result = await runFightLoop({ cwd: repo, message: "add mine.txt only", remote: "origin", paths: ["mine.txt"] });
    assert.equal(result.status, "pushed", JSON.stringify(result));

    const committedFiles = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(committedFiles, ["mine.txt"], "only the explicitly-named path must be in the commit");
    // The unrelated file must still be sitting there, uncommitted — untouched, not swept up.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.match(status, /someone-elses-file\.txt/, "the unrelated uncommitted file must still be untracked/unstaged, not pushed");
  });

  // review-sol-2026-09-13.md finding 5: `paths` used to scope only `git add`, so anything ALREADY
  // staged before the call (not merely uncommitted) rode along into the same commit anyway.
  await testCase("paths, when given, excludes a path that was ALREADY staged before the call, not just uncommitted", async () => {
    const repo = path.join(scratch, "repo-7b");
    const remote = path.join(scratch, "remote-7b.git");
    makeRepo(repo);
    makeBareRemote(remote);
    git(repo, ["remote", "add", "origin", remote]);
    // Simulates a DIFFERENT task's change already staged in this shared worktree's index.
    fs.writeFileSync(path.join(repo, "other.txt"), "someone else's staged work\n");
    git(repo, ["add", "other.txt"]);
    fs.writeFileSync(path.join(repo, "mine.txt"), "my change\n");

    const result = await runFightLoop({ cwd: repo, message: "add mine.txt only", remote: "origin", paths: ["mine.txt"] });
    assert.equal(result.status, "pushed", JSON.stringify(result));

    const committedFiles = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(committedFiles, ["mine.txt"], "a path staged by someone else before this call must not ride into this commit");
    // The other change must still be sitting there, staged but uncommitted — untouched, not swept up.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.match(status, /other\.txt/, "the pre-staged unrelated file must still be present in the working tree, not committed");
  });

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────
  await testCase("paths rejects an empty array or non-string entries rather than silently falling back to -A", async () => {
    const repo = path.join(scratch, "repo-8");
    makeRepo(repo);
    await assert.rejects(() => runFightLoop({ cwd: repo, message: "x", paths: [] }), /non-empty array/);
    await assert.rejects(() => runFightLoop({ cwd: repo, message: "x", paths: [123] }), /non-empty array/);
  });

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────
  // Fixed 2026-09-11 (codexdoc/REVIEW-NOTES.md finding 11): a commit that succeeds followed by a push
  // that fails used to be unretryable — the next call saw nothing staged and reported a false "nothing
  // to commit," leaving the real commit stuck locally forever. This is the exact reproduction: push
  // fails because the remote doesn't exist YET (destination "repaired" afterward, matching the finding's
  // own phrasing), then the SAME call is retried.
  await testCase("a commit that already succeeded is not silently skipped after a prior push failure, and is not duplicated on retry", async () => {
    const repo = path.join(scratch, "repo-9");
    const remotePath = path.join(scratch, "remote-9.git"); // deliberately does not exist yet
    makeRepo(repo);
    git(repo, ["remote", "add", "origin", remotePath]);
    fs.writeFileSync(path.join(repo, "retry.txt"), "content\n");

    const first = await runFightLoop({ cwd: repo, message: "add retry.txt", remote: "origin" });
    assert.equal(first.status, "failed", JSON.stringify(first));
    // The commit itself must have landed locally despite the push failure.
    assert.equal(git(repo, ["log", "-1", "--format=%s"]), "add retry.txt");

    // "destination is repaired" (the finding's own words) — the remote now actually exists.
    makeBareRemote(remotePath);

    const second = await runFightLoop({ cwd: repo, message: "add retry.txt", remote: "origin" });
    assert.equal(second.status, "pushed", JSON.stringify(second));
    const remoteLog = execFileSync("git", ["--git-dir", remotePath, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
    assert.equal(remoteLog, "add retry.txt", "the ALREADY-COMMITTED change must reach the remote on retry");
    const localHistory = git(repo, ["log", "--oneline"]).split("\n");
    assert.equal(localHistory.length, 2, "must still be exactly 2 commits (initial + retry.txt) — no duplicate commit created on retry");
  });

  // ── 10 ─────────────────────────────────────────────────────────────────────────────────
  // Case (a) from the fix directive: the remote branch doesn't exist yet at all (first push ever), and
  // there is separately nothing NEW to stage (the commit predates this call). Must still push, not
  // report "no such remote ref" as a blocking error.
  await testCase("nothing new to stage, and the remote branch doesn't exist yet — still pushes the existing commit", async () => {
    const repo = path.join(scratch, "repo-10");
    const remote = path.join(scratch, "remote-10.git");
    makeRepo(repo); // one local commit ("initial"), nothing uncommitted
    makeBareRemote(remote); // exists, but has no refs at all yet
    git(repo, ["remote", "add", "origin", remote]);

    const result = await runFightLoop({ cwd: repo, message: "irrelevant — nothing will be committed" });
    assert.equal(result.status, "pushed", JSON.stringify(result));
    const remoteLog = execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
    assert.equal(remoteLog, "initial");
  });

  // ── 11 ─────────────────────────────────────────────────────────────────────────────────
  // Case (b): local HEAD is BEHIND the remote (someone else pushed in between) — must not silently
  // force-push or claim success.
  await testCase("nothing new to stage, but local HEAD is behind the remote — refuses rather than force-pushing or claiming success", async () => {
    const repo = path.join(scratch, "repo-11");
    const other = path.join(scratch, "repo-11-other-clone");
    const remote = path.join(scratch, "remote-11.git");
    makeRepo(repo);
    makeBareRemote(remote);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "origin", "main"]); // repo starts in sync with the remote

    // A second clone pushes something new, so the remote moves ahead of `repo`'s local HEAD.
    execFileSync("git", ["clone", "-q", remote, other], { encoding: "utf8" });
    git(other, ["config", "user.email", "test@example.com"]);
    git(other, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(other, "elsewhere.txt"), "x\n");
    git(other, ["add", "."]);
    git(other, ["commit", "-q", "-m", "elsewhere"]);
    git(other, ["push", "origin", "main"]);

    // `repo` has nothing new to stage locally, but its HEAD is now behind the remote's real tip.
    const result = await runFightLoop({ cwd: repo, message: "irrelevant" });
    assert.equal(result.status, "failed", JSON.stringify(result));
    const remoteLog = execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
    assert.equal(remoteLog, "elsewhere", "the remote's real history must be untouched — no force-push, no silent success");
  });

  // ── 12 ─────────────────────────────────────────────────────────────────────────────────
  // Case (c): genuinely nothing to do — local HEAD already matches the remote. Must behave exactly as
  // before this fix: an honest "nothing was staged to commit" failure, not a push attempt.
  await testCase("genuinely nothing to do — local HEAD already matches the remote — unchanged honest failure", async () => {
    const repo = path.join(scratch, "repo-12");
    const remote = path.join(scratch, "remote-12.git");
    makeRepo(repo);
    makeBareRemote(remote);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "origin", "main"]);

    const result = await runFightLoop({ cwd: repo, message: "irrelevant" });
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.unresolved.class, "hook-other");
    assert.match(result.unresolved.oneParagraphDiagnosis, /nothing was staged to commit/);
  });

  // review-sol-2026-09-13.md finding 6: `runtime/supervisor.js`'s `gitPush` classifies a destination
  // branch and (before the fix) passed the CALLER's original `targetBranch` (often null) onward, so
  // `runFightLoop`'s own push step re-derived the local HEAD branch independently, at push time —
  // whatever the worktree's checked-out branch had become by then, not what was classified. The fix
  // is to pin the classified value as an explicit `targetBranch`. This proves the MECHANISM that pin
  // relies on: an explicit `targetBranch` always wins as the remote destination, even when the local
  // checked-out branch has since changed to something else (simulating exactly the race window).
  await testCase("an explicit targetBranch pins the remote destination even if the local checked-out branch changes before the push runs", async () => {
    const repo = path.join(scratch, "repo-13");
    const remote = path.join(scratch, "remote-13.git");
    makeRepo(repo);
    makeBareRemote(remote);
    git(repo, ["remote", "add", "origin", remote]);

    // "safe-branch" is what a caller classified as the destination (e.g. non-protected) BEFORE this
    // call — simulated here by simply naming it explicitly, the same way the fixed `gitPush` handler
    // now always does.
    git(repo, ["checkout", "-b", "safe-branch"]);
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");

    // The race: after classification but before the push actually runs, the worktree's checked-out
    // branch changes to something else entirely (another process, a concurrent operation).
    git(repo, ["checkout", "-b", "switched-away"]);

    const result = await runFightLoop({ cwd: repo, message: "pin test", targetBranch: "safe-branch" });
    assert.equal(result.status, "pushed", JSON.stringify(result));

    const pushedToSafe = execFileSync("git", ["--git-dir", remote, "branch", "--list", "safe-branch"], { encoding: "utf8" }).trim();
    assert.match(pushedToSafe, /safe-branch/, "the pinned destination must have actually received the push");
    const pushedToSwitched = execFileSync("git", ["--git-dir", remote, "branch", "--list", "switched-away"], { encoding: "utf8" }).trim();
    assert.equal(pushedToSwitched, "", "the branch the worktree happened to be on at push time must NOT be what the remote received");
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (failed) {
  console.error("\nFAIL: git-create-push fight loop");
  process.exit(1);
}
console.log("\nPASS: git-create-push fight loop");
