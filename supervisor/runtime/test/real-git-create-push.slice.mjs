#!/usr/bin/env node
// real-git-create-push.slice.mjs — pushes for real and opens a real PR against a real sandbox GitHub
// repo, via `agents/git-create-push.js`'s `openPullRequest` (a real `gh pr create` call).
//
// DELIBERATELY NOT IN `npm test`. Real credentials (a logged-in `gh`), real network, and a real
// disposable GitHub repo you control. `agents/test/git-create-push.test.js` and
// `runtime/test/git-create-push.test.js` already prove the fight loop, the lease, and the
// authorization wiring deterministically against local file:// remotes — what this adds is the one
// thing those cannot: that `gh pr create` actually returns a real PR URL for a real push, and that
// runFightLoop's `openPr: true` path wires it through correctly end to end.
//
// SETUP, before running this by hand:
//   1. `gh auth status` must show a logged-in account with push access to a repo you're willing to
//      spam with disposable branches/PRs — do NOT point this at a real product repo.
//   2. Create (or reuse) an empty-ish sandbox repo on GitHub, clone it once locally, and note its path.
//   3. Set CTD_REAL_GIT_SANDBOX_REPO to that local clone's path:
//        CTD_REAL_GIT_SANDBOX_REPO=/path/to/your/sandbox-repo node runtime/test/real-git-create-push.slice.mjs
//   4. The sandbox repo's default branch is used as the PR base. This script creates a NEW branch each
//      run (`ctd-real-slice-<timestamp>`) off the current HEAD, commits one throwaway file, pushes it,
//      and opens a PR against the default branch — it does not touch the default branch itself.
//
// This leaves a real branch and a real (open) PR behind on every run — clean those up by hand
// afterward (`gh pr close <n> --delete-branch`). Not automated on purpose: an automated cleanup step
// here would itself need the same real credentials this script exists to isolate from `npm test`.
//
// Cases:
//   1. a real push to the sandbox repo succeeds
//   2. `openPr: true` returns a real, fetchable PR URL

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runFightLoop } from "../../agents/git-create-push.js";

const repoDir = process.env.CTD_REAL_GIT_SANDBOX_REPO;
if (!repoDir) {
  console.error("CTD_REAL_GIT_SANDBOX_REPO is not set — see this file's header for setup. Skipping, not failing:"
    + " this slice needs a human-provided sandbox repo and cannot run unattended.");
  process.exit(0);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const branch = `ctd-real-slice-${Date.now()}`;
git(repoDir, ["checkout", "-b", branch]);

const fs = await import("node:fs");
const path = await import("node:path");
fs.writeFileSync(path.join(repoDir, `real-slice-${Date.now()}.txt`), "produced by real-git-create-push.slice.mjs\n");

const result = await runFightLoop({
  cwd: repoDir,
  message: `real-git-create-push.slice.mjs: ${branch}`,
  remote: "origin",
  targetBranch: branch,
  openPr: true,
  prTitle: `[throwaway] real-git-create-push.slice.mjs ${branch}`,
  prBody: "Opened by a manual real-slice test. Safe to close and delete the branch.",
});

assert.equal(result.status, "pushed", JSON.stringify(result));
console.log("  1. a real push to the sandbox repo succeeded");

assert.ok(result.mrUrl, `expected a real PR URL; got ${JSON.stringify(result)}`);
assert.match(result.mrUrl, /^https:\/\//);
console.log(`  2. openPr:true returned a real PR URL: ${result.mrUrl}`);
console.log(`\n  Remember to close it: gh pr close <number> --delete-branch (repo: ${repoDir}, branch: ${branch})`);

console.log("\nPASS: real-git-create-push.slice");
