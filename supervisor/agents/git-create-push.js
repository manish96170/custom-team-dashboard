// git-create-push.js — the git-create-push utility agent's fight-loop (PLAN.md §16's roster, contract in
// §8 Rule 2), added 2026-09-10 as Phase 7 step 5.
//
// The exact contract §8 Rule 2 specifies, quoted rather than paraphrased so this file can be checked
// against it directly:
//
//   push(taskId, runId, worktreeId, intent): {
//     status: 'pushed' | 'blocked' | 'failed',
//     mrUrl?: string,
//     attempts: Attempt[],              // internal -- never returned to the caller's context
//     unresolved?: { class: FailureClass, oneParagraphDiagnosis: string, files: string[] }
//   }
//
//   "It owns the whole loop: stage -> commit -> pre-commit hooks -> on failure, classify (format |
//   lint-autofixable | lint-semantic | typecheck | test | hook-other | conflict | protected-branch) ->
//   auto-fix ONLY the mechanically fixable classes, bounded at N attempts -> re-run. Anything semantic
//   returns as one paragraph plus a file list, never as raw tool output."
//
// WHAT LIVES HERE VS IN `runtime/supervisor.js`
//
// This module is the pure git mechanics: given a working directory, it stages, commits, classifies a
// hook failure, auto-fixes what it can, and pushes. It knows nothing about tasks, principals, leases, or
// the database -- that glue lives in `runGitPush`/`gitCreatePush` wire commands in `supervisor.js`, the
// same split `domain/capabilities.js` and `domain/review.js` already keep from the persistence layer.
// Testable against a real throwaway repo with no supervisor running at all.
//
// TWO WIRE COMMANDS, ONE FIGHT LOOP -- the protected/non-protected split is a CAPABILITY decision, not a
// runtime flag
//
// `domain/capabilities.js` already declares `git:push` and `git:push-protected` (the latter in the
// SENSITIVE class). This module has no "protected: true" flag anywhere in its own API on purpose:
// whether a push needed a second signature is answered by WHICH WIRE COMMAND the caller invoked
// (`gitPush` vs `gitPushProtected`), which the generic authorization wrapper
// (`authorizedCommandHandlers()`) has already gated before either command's handler runs. A boolean
// argument here would be exactly the "a request that names its own capabilities is refused exactly like
// one that does not" shape this project's authorization layer is built to reject -- so it isn't offered
// as an argument to fight with. Both commands call the SAME `runFightLoop` below.
//
// AUTOFIX IS AN EXTENSION POINT, NOT A GUESS AT SOMEONE ELSE'S TOOLCHAIN
//
// This is generic infrastructure for whatever repo a task's worktree points at -- it cannot assume
// prettier, eslint, or any specific formatter is installed. So "auto-fix the mechanically fixable
// classes" means: if the repo's root has an executable `.git-create-push-autofix.sh`, run it with the
// classified failure's class and file list as arguments and re-stage; if it doesn't exist, `format` and
// `lint-autofixable` are treated exactly like the non-autofixable classes -- honestly unresolved, with a
// diagnosis that says an autofix script isn't configured, rather than silently doing nothing and
// claiming success.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

// `codexdoc/REVIEW-NOTES.md` finding 12: this whole fight loop used to run every git call through
// `execFileSync`, which blocks the WHOLE Node event loop for as long as the child runs — not just this
// call's own logic, but every socket command, ask, digest, and sweep timer on the SAME daemon process,
// for up to 30s per call across several attempts. `execFile` (promisified) waits on the child via
// libuv without blocking the event loop, so the daemon keeps serving everything else while git/hooks run.
// The sequence of git calls and what they mean is UNCHANGED — only how each one is awaited.
const execFileAsync = promisify(execFile);

export const AUTOFIX_SCRIPT_NAME = ".git-create-push-autofix.sh";

// Bounded at 3 total commit attempts: the first real attempt, plus up to two autofix-and-retry rounds.
// Chosen over an unbounded loop because a script that never converges (a fixer that "fixes" a file back
// into the state that fails) must not hang the fight loop forever -- see PLAN.md §8 Rule 2's own "bounded
// at N attempts." Two retries is enough for the common case (one file needed reformatting) without
// turning a broken autofix script into a long silent loop.
export const MAX_COMMIT_ATTEMPTS = 3;

const AUTOFIXABLE_CLASSES = new Set(["format", "lint-autofixable"]);

async function run(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
    return { ok: true, stdout: String(stdout), stderr: "" };
  } catch (err) {
    if (!allowFailure) throw err;
    return {
      ok: false,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? ""),
      status: err.code ?? null,
    };
  }
}

/**
 * Classify a failed git operation's output into one of §8 Rule 2's eight classes.
 *
 * A HEURISTIC, stated plainly as one rather than hidden behind confident-sounding code: pattern-matching
 * hook/git output text cannot be a proof, only a best guess, and a future reader should be able to see
 * exactly what triggers each class rather than trust that it's exhaustive. Checked in the order below
 * because some signals are more specific than others (a merge-conflict marker is unambiguous; a bare
 * "error" is not, and falls through to `hook-other`).
 */
export function classifyFailure({ stdout = "", stderr = "" } = {}) {
  const text = `${stdout}\n${stderr}`;

  if (/CONFLICT|Merge conflict|Automatic merge failed|both modified:|needs merge/i.test(text)) {
    return "conflict";
  }
  if (/protected branch|remote rejected|GH006|! \[remote rejected\]|denied to |permission denied \(https\)/i.test(text)) {
    return "protected-branch";
  }
  // A script that ran and reported it made no changes ("nothing to fix") is not the same failure as one
  // that hasn't been given a chance yet -- both still classify as fixable, `runFightLoop` decides whether
  // there's budget left to try.
  if (/would reformat|not formatted|prettier|reformatted \d+ file|code style issues found/i.test(text)) {
    return "format";
  }
  if (/eslint/i.test(text) && /fixable|--fix/i.test(text)) {
    return "lint-autofixable";
  }
  if (/eslint/i.test(text) || /\blint(ing)? error/i.test(text)) {
    return "lint-semantic";
  }
  if (/error TS\d+|type error|tsc\b.*error|Type '.*' is not assignable/i.test(text)) {
    return "typecheck";
  }
  if (/\bFAIL\b|tests? failed|AssertionError|assert(ion)? failed/i.test(text)) {
    return "test";
  }
  return "hook-other";
}

/** The files a classified failure touched, best-effort from the hook's own output. Never throws. */
function filesFromOutput({ stdout = "", stderr = "" } = {}) {
  const text = `${stdout}\n${stderr}`;
  const matches = text.match(/(?:^|\s)([\w./-]+\.[a-zA-Z0-9]+)(?=:|\s|$)/gm) ?? [];
  return [...new Set(matches.map((m) => m.trim()))].slice(0, 20);
}

function oneParagraph(klass, output) {
  const preview = `${output.stderr || output.stdout}`.trim().split("\n").slice(0, 3).join(" ").slice(0, 300);
  return `git-create-push classified this as "${klass}" and did not attempt to fix it automatically `
    + `(only "format"/"lint-autofixable" are auto-fixed, and only when ${AUTOFIX_SCRIPT_NAME} exists at the `
    + `repo root). First lines of what the tool reported: ${preview || "(no output captured)"}`;
}

/** Runs the repo's autofix script if one exists at the repo root. Never throws -- a broken or missing
 *  script is reported as "did not fix it," not as a crash of the whole fight loop. */
async function tryAutofix(cwd, klass, files) {
  const scriptPath = path.join(cwd, AUTOFIX_SCRIPT_NAME);
  if (!fs.existsSync(scriptPath)) return { attempted: false, ran: false };
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
  } catch {
    return { attempted: true, ran: false, error: `${AUTOFIX_SCRIPT_NAME} exists but is not executable` };
  }
  try {
    await execFileAsync(scriptPath, [klass, ...files], { cwd, encoding: "utf8", timeout: 30_000 });
    return { attempted: true, ran: true };
  } catch (err) {
    return { attempted: true, ran: false, error: String(err.stderr ?? err.message ?? err) };
  }
}

/**
 * The remote's actual current SHA for a branch, via `ls-remote` -- never a local remote-tracking
 * branch, which can be stale without a fresh `fetch`. `ls-remote` itself needs no fetch and works
 * whether "remote" is a bare local path (as in this file's own tests) or a real network remote.
 *
 * `sha: null` with `reachable: true` means the branch genuinely does not exist on the remote yet (a
 * real, successful `ls-remote` that found no matching ref) -- the first-push case. `reachable: false`
 * means the remote itself could not be reached/queried at all (bad path, network error, no such
 * remote name configured) -- callers treat that the same as "not caught up," so a real push attempt
 * runs and reports the real failure, rather than this function fabricating a diagnosis it can't verify.
 */
async function remoteHeadSha(cwd, remote, destBranch) {
  const ls = await run(cwd, ["ls-remote", remote, `refs/heads/${destBranch}`], { allowFailure: true });
  if (!ls.ok) return { reachable: false, sha: null };
  const line = ls.stdout.trim().split("\n")[0] ?? "";
  const sha = line.split(/\s+/)[0] || null;
  return { reachable: true, sha };
}

/**
 * The destination branch a push would actually land on — `targetBranch` if the caller names one,
 * otherwise the worktree's own current branch. Exported so a caller can classify the REAL destination
 * (e.g. against a protected-branch list) BEFORE deciding whether this push needs a second signature,
 * without running the whole fight loop first. `runFightLoop`'s own push step resolves the same thing
 * independently (it needs to actually run the push, not just report the name) — the two are kept as
 * separate calls rather than one cached value because a caller here is a database transaction away from
 * the fight loop's own git process, so nothing meaningfully "shares" the answer between them.
 */
export async function resolvePushDestination({ cwd, targetBranch = null } = {}) {
  const branchResult = await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const localBranch = branchResult.stdout.trim();
  return targetBranch || localBranch;
}

/**
 * The whole fight loop: stage -> commit -> (on hook failure) classify -> autofix the fixable classes,
 * bounded -> re-commit -> push. Pure with respect to the database/leases/principals -- `cwd` is all it
 * needs, so it is testable against a real throwaway repo with no supervisor running.
 *
 * Returns exactly §8 Rule 2's shape (`status`, `attempts`, `unresolved?`) minus `mrUrl`, which is the
 * caller's job (opening a PR/MR needs real credentials/network -- see `real-git-create-push.slice.mjs`).
 *
 * `paths`, ADDED 2026-09-11 (codex review, `codexdoc/REVIEW-NOTES.md` finding 5): on a task's SHARED
 * worktree (PLAN.md §7 -- every worker assigned to a task attaches to the SAME worktree on purpose),
 * unconditional `git add -A` stages and then PUSHES whatever any of them left uncommitted, not just the
 * caller's own change. Passing an explicit, non-empty `paths` array stages exactly those paths
 * (`git add -- <paths>`) instead. THIS DOES NOT MAKE THE DEFAULT SAFE -- omitting `paths` still runs
 * `-A`, unchanged, because there is no way to infer "the caller's own files" without per-task change
 * tracking this fight loop does not have. A caller operating on a shared worktree MUST pass explicit
 * paths to be safe; giving callers the tool is what this fixes, not forcing safety automatically.
 */
export async function runFightLoop({
  cwd, message, remote = "origin", targetBranch = null, maxAttempts = MAX_COMMIT_ATTEMPTS,
  openPr = false, prTitle = null, prBody = null, prBase = null, paths = null,
} = {}) {
  if (!cwd) throw new Error("runFightLoop: cwd is required");
  if (!message) throw new Error("runFightLoop: message is required");
  if (paths !== null && (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p.length > 0))) {
    throw new Error("runFightLoop: paths, if given, must be a non-empty array of non-empty strings");
  }

  const attempts = [];

  // ── stage + commit, with bounded autofix-and-retry ──────────────────────────────────────
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (paths) await run(cwd, ["add", "--", ...paths]);
    else await run(cwd, ["add", "-A"]);
    const status = await run(cwd, ["status", "--porcelain"]);
    if (!status.stdout.trim()) {
      // ADDED 2026-09-11 (codexdoc/REVIEW-NOTES.md finding 11): "nothing staged" used to always mean
      // "nothing to do" -- but it is ALSO exactly what a RETRY looks like after a commit succeeded and
      // the push failed: the commit already happened, so staging finds nothing new, and the old code
      // reported a false "nothing to commit" while a real, unpushed commit sat on disk, never retried.
      //
      // Distinguish the two by asking the REMOTE (via `ls-remote`, never a possibly-stale local
      // remote-tracking branch) whether local HEAD is already its exact tip. If it is NOT -- genuinely
      // ahead (this bug's exact scenario, and also a first-ever push where the remote branch does not
      // exist yet), behind, or diverged -- "nothing was staged to commit" would be a LIE: there is a
      // real difference to reconcile, so skip this failure and go straight to the push step with the
      // commit that's already there. A genuine divergence (local behind, or diverged) is never silently
      // forced through: `git push` itself refuses a non-fast-forward update on its own, and THAT real
      // refusal is what gets classified and reported by the push step below -- this function never
      // fabricates a diagnosis for a case it can't verify by trying the real operation.
      const destBranch = targetBranch || (await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      const head = (await run(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      const remoteState = await remoteHeadSha(cwd, remote, destBranch);
      const upToDate = remoteState.reachable && remoteState.sha === head;
      if (!upToDate) {
        attempts.push({
          attempt, class: null, fixed: true,
          note: "nothing new to stage; local HEAD differs from the remote tip -- proceeding to push the existing commit",
        });
        break;
      }
      // Genuinely nothing to do: the autofix script made no changes, or there was never anything to
      // commit, AND local HEAD already matches the remote. Report it rather than committing an empty
      // change (`git commit` would itself fail with a confusing, unrelated error).
      attempts.push({ attempt, class: null, fixed: false, note: "nothing to commit after staging" });
      return {
        status: "failed",
        attempts,
        unresolved: { class: "hook-other", oneParagraphDiagnosis: "nothing was staged to commit — the working tree matched HEAD, and local HEAD already matches the remote.", files: [] },
      };
    }

    // review-sol-2026-09-13.md finding 5: `paths` used to scope only the `git add` above -- `git commit`
    // with no pathspec commits the WHOLE index, so anything ALREADY staged before this call (a different
    // task's unrelated change, on the shared worktree `paths` exists specifically to protect) rode along
    // into the same commit anyway (reproduced: `paths: ["mine.txt"]` committed both `mine.txt` and an
    // unrelated pre-staged `other.txt`). `git commit -- <pathspec>` is git's own "partial commit" form --
    // it commits only the named paths' changes regardless of what else is staged, so passing the SAME
    // `paths` here closes the gap `add`'s own scoping never could.
    const commit = await run(cwd, paths ? ["commit", "-m", message, "--", ...paths] : ["commit", "-m", message], { allowFailure: true });
    if (commit.ok) {
      attempts.push({ attempt, class: null, fixed: true, note: "committed" });
      break;
    }

    const klass = classifyFailure(commit);
    const files = filesFromOutput(commit);

    if (!AUTOFIXABLE_CLASSES.has(klass) || attempt === maxAttempts) {
      attempts.push({ attempt, class: klass, fixed: false });
      return {
        status: "failed",
        attempts,
        unresolved: { class: klass, oneParagraphDiagnosis: oneParagraph(klass, commit), files },
      };
    }

    const fix = await tryAutofix(cwd, klass, files);
    attempts.push({ attempt, class: klass, fixed: false, autofix: fix.ran === true });
    if (!fix.ran) {
      // The class WAS fixable in principle, but nothing actually fixed it this round (no script, or the
      // script failed) -- one more spin of the loop would just repeat the same failure, so stop here
      // instead of burning the remaining attempt budget for nothing.
      return {
        status: "failed",
        attempts,
        unresolved: {
          class: klass,
          oneParagraphDiagnosis: fix.attempted
            ? `git-create-push classified this as "${klass}" and tried ${AUTOFIX_SCRIPT_NAME}, but it did not resolve it: ${fix.error}`
            : oneParagraph(klass, commit),
          files,
        },
      };
    }
    // Loop again: re-stage whatever the autofix script changed and retry the commit.
  }

  // ── push ─────────────────────────────────────────────────────────────────────────────────
  const branchResult = await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const localBranch = branchResult.stdout.trim();
  const refspec = targetBranch ? `${localBranch}:${targetBranch}` : localBranch;
  const push = await run(cwd, ["push", remote, refspec], { allowFailure: true });

  if (push.ok) {
    attempts.push({ attempt: attempts.length + 1, class: null, fixed: true, note: "pushed" });
    if (!openPr) return { status: "pushed", attempts };
    // Opt-in only (default false), and never exercised by the automated suite -- see this file's own
    // `openPullRequest` for why. A caller that wants a PR/MR asks for one explicitly; a failure to open
    // one does not undo a push that already succeeded, so it is reported alongside `pushed`, not instead
    // of it.
    const pr = await openPullRequest({ cwd, title: prTitle ?? message, body: prBody, base: prBase ?? targetBranch ?? "main" });
    return pr.ok ? { status: "pushed", attempts, mrUrl: pr.url } : { status: "pushed", attempts, prError: pr.error };
  }

  const klass = classifyFailure(push);
  attempts.push({ attempt: attempts.length + 1, class: klass, fixed: false, note: "push failed" });
  // Push failures are never auto-fixed, regardless of class -- §8 Rule 2 scopes autofix to the COMMIT
  // loop ("pre-commit hooks... auto-fix"), and a rejected push (protected branch, non-fast-forward) is
  // not something restaging files can resolve.
  return {
    status: klass === "protected-branch" ? "blocked" : "failed",
    attempts,
    unresolved: { class: klass, oneParagraphDiagnosis: oneParagraph(klass, push), files: filesFromOutput(push) },
  };
}

/**
 * Open a PR/MR via `gh pr create`. Real, wired in, and opt-in (`runFightLoop`'s `openPr: false`
 * default) — but NEVER exercised by the automated suite, because it needs real credentials, a real
 * network call, and a real remote GitHub repo, the same class of thing this project already keeps out
 * of `npm test` (see any `real-*.slice.mjs`). `runtime/test/real-git-create-push.slice.mjs` is the
 * manual-run counterpart a human runs by hand against a real sandbox repo.
 */
export async function openPullRequest({ cwd, title, body = null, base = "main" } = {}) {
  try {
    const args = ["pr", "create", "--title", title, "--base", base, "--body", body ?? ""];
    const { stdout } = await execFileAsync("gh", args, { cwd, encoding: "utf8", timeout: 30_000 });
    const url = String(stdout).trim().split("\n").pop();
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: String(err.stderr ?? err.message ?? err) };
  }
}
