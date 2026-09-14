// worktree-service.js — extracted from runtime/supervisor.js (ChatGPT review, 2026-09-14: the
// composition root had grown into a god object; this is one of the "natural extraction seams" the
// review asked for — a subsystem with its own state machine (WORKTREE_CLAIM_PENDING claim/finalize/
// release/reclaim, migration 0017's create/discard op distinction), its own lifecycle (create -> in use
// -> discard, plus the crash-recovery paths for both), and its own dedicated tests
// (runtime/test/worktree.test.js). PURE CODE MOVE — every line of logic below is unchanged from its
// original position in supervisor.js; only the wrapping factory and this file's own imports are new.
//
// Real dependencies, traced before extracting (per the review's own "trace the actual current code
// first" rule): `database` is the only closure variable these functions ever touched — no `logger`, no
// `mcpPool`, no `pump`, no `adapterFor`. Everything else is a module-level import, already importable
// here directly.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  taskIdForRun, workerIdForRun, claimTaskWorktreeSlot, finalizeTaskWorktreeSlot,
  releaseTaskWorktreeClaim, reclaimStaleTaskWorktreeClaim, WORKTREE_CLAIM_PENDING, journalAppend,
} from "../db/index.js";
import { argsHash } from "../domain/capabilities.js";
import { isTerminal } from "../domain/task-states.js";

const execFileAsync = promisify(execFile);

/**
 * createWorktreeService({ database }) -> { createTaskWorktree, discardTaskWorktree, requestWorktree }
 *
 * The shared per-task worktree lifecycle (PLAN.md §7) — see each function's own doc comment for the
 * full reasoning, carried over unchanged.
 */
export function createWorktreeService({ database }) {
  async function repoRootFromWorktree(worktreePath) {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
        cwd: worktreePath, encoding: "utf8", timeout: 10_000,
      });
      const raw = String(stdout).trim();
      const commonDir = path.isAbsolute(raw) ? raw : path.resolve(worktreePath, raw);
      return path.dirname(commonDir); // commonDir is "<repoRoot>/.git"
    } catch {
      return null;
    }
  }

  /**
   * createTaskWorktree(taskId, { repoPath, branch }) -> the shared per-task worktree (PLAN.md §7).
   *
   * ONE worktree per task, not one per session or run: a task's coder(s) and reviewer(s) are deliberately
   * looking at the same revision (§13's quorum on one commit), so every worker later assigned to the task
   * attaches to this same path through `assignTask`'s existing `cwd ?? task.worktree_id` fallback — nothing
   * downstream needs to change for that to work.
   *
   * `repoPath` is caller-supplied on purpose. `tasks.repo_id` exists in the schema but nothing anywhere reads
   * or writes it (checked, not assumed) — inventing a repo-path registry here would be a second, unrequested
   * design decision. This follows the same pattern `assignTask({ cwd })` already uses for the same reason.
   *
   * Idempotent: if the task already has a `worktree_id` and that path still exists on disk, this returns it
   * rather than re-running `git worktree add` — a retried `start`, or a caller that doesn't know whether an
   * earlier attempt actually landed, is safe to call again.
   */
  /**
   * Cross-process creation race, added 2026-09-11 (`codexdoc/review-phase7-uncommitted.md` finding 2,
   * blocking): two processes could both read `worktree_id = NULL` for the same task, both run real
   * `git worktree add` in parallel, and both get `created: true` back — Git's per-repo lock has nothing
   * to say about the per-TASK invariant "one worktree, one registered path." Fixed with the same
   * "claim a status marker before doing the real work, only the winner proceeds" pattern already proven
   * for `mcp-pool.js`'s `claimPoolSlot`: `claimTaskWorktreeSlot` reserves the slot with
   * `WORKTREE_CLAIM_PENDING` inside a `BEGIN IMMEDIATE` compare-and-swap, so exactly one caller ever runs
   * git for a given task at a time. A caller that loses the claim polls (bounded, ~2s total) for the
   * winner's real result rather than racing it or hanging forever.
   */
  // How long a PENDING claim can sit unfinalized before another caller is allowed to try recovering it
  // (`codexdoc/review-luna-2026-09-11.md` finding 6). Deliberately far above the poll budget below (a
  // real `git worktree add` has its own 30s timeout) — this is "the claimant probably crashed", not
  // "the claimant is slow."
  const STALE_WORKTREE_CLAIM_MS = 60_000;

  /** `.git/ctd-worktrees/<taskId>` is the one deterministic path every claimant for a given
   *  `(repoPath, taskId)` pair computes — used both by a normal claim and by stale-claim recovery to
   *  check whether a dead claimant's git work already landed before deciding whether to redo it. */
  function taskWorktreePath(resolvedRepoPath, taskId) {
    return path.join(resolvedRepoPath, ".git", "ctd-worktrees", taskId);
  }

  /** A real linked worktree has a `.git` FILE (not a repo) pointing back at the main repo's gitdir —
   *  cheap, local, no git invocation needed, sufficient to tell "the crashed claimant already finished"
   *  from "nothing happened yet." */
  function looksLikeRealWorktree(worktreePath) {
    try {
      return fs.existsSync(worktreePath) && fs.existsSync(path.join(worktreePath, ".git"));
    } catch {
      return false;
    }
  }

  async function runGitWorktreeAdd({ resolvedRepoPath, worktreePath, worktreeBranch }) {
    try {
      await execFileAsync("git", ["worktree", "add", "-b", worktreeBranch, worktreePath], {
        cwd: resolvedRepoPath, timeout: 30_000,
      });
      return { ok: true };
    } catch {
      // The branch may already exist — a prior partial attempt, or one created out of band — so retry
      // attaching to it before giving up, rather than treating "branch exists" as a hard failure.
      try {
        await execFileAsync("git", ["worktree", "add", worktreePath, worktreeBranch], {
          cwd: resolvedRepoPath, timeout: 30_000,
        });
        return { ok: true };
      } catch (err2) {
        return { ok: false, error: err2 };
      }
    }
  }

  async function createTaskWorktree(taskId, { repoPath, branch, principal = null } = {}) {
    if (!taskId) throw new Error("createTaskWorktree: taskId is required");
    // review-sol-2026-09-13.md finding 2 (create side): same ownership boundary as `discardTaskWorktree`
    // below — a worker/reviewer principal may create a worktree only for the task it is assigned to.
    if (principal?.workerId) {
      const assignedTaskId = database.prepare(`SELECT task_id FROM workers WHERE worker_id = ?`).get(principal.workerId)?.task_id ?? null;
      if (assignedTaskId !== taskId) {
        return {
          ok: false, refused: "not-your-task",
          error: `principal is authenticated as worker ${principal.workerId}, assigned to task ${assignedTaskId ?? "(none)"}, `
            + `not ${taskId} — a worker may only create the worktree of its own currently-assigned task`,
        };
      }
    }
    if (!repoPath) {
      throw new Error(
        "createTaskWorktree: repoPath is required — there is no repo-path registry (tasks.repo_id is unused), "
        + "so the caller must say where the repo lives",
      );
    }
    // Canonicalized once, up front — this is both the identity a mismatch is checked against
    // (`codexdoc/review-luna-2026-09-11.md` finding 5) and the value persisted alongside the claim.
    const resolvedRepoPath = path.resolve(repoPath);

    const POLL_ATTEMPTS = 40;
    const POLL_INTERVAL_MS = 50;

    for (let attempt = 0; attempt <= POLL_ATTEMPTS; attempt += 1) {
      const task = database
        .prepare(`SELECT id, worktree_id, branch, worktree_repo_path FROM tasks WHERE id = ?`)
        .get(taskId);
      if (!task) throw new Error(`createTaskWorktree: no such task ${taskId}`);

      // Finding 5: a conflicting caller must be refused, not handed someone else's repo/branch as if it
      // were idempotent success — checked against BOTH an already-finalized worktree (below) and a
      // still-pending claim (further down), because the row now carries this identity from claim time.
      const repoMismatch = task.worktree_repo_path && task.worktree_repo_path !== resolvedRepoPath;
      const branchMismatch = branch && task.branch && branch !== task.branch;
      const mismatchResult = (kind) => ({
        ok: false, refused: kind,
        error: kind === "worktree-repo-mismatch"
          ? `task ${taskId}'s worktree is bound to ${task.worktree_repo_path}, not ${resolvedRepoPath} — `
            + "refusing to hand a conflicting caller a different repository's worktree"
          : `task ${taskId}'s worktree is bound to branch "${task.branch}", not "${branch}"`,
      });

      if (task.worktree_id && task.worktree_id !== WORKTREE_CLAIM_PENDING && fs.existsSync(task.worktree_id)) {
        if (repoMismatch) return mismatchResult("worktree-repo-mismatch");
        if (branchMismatch) return mismatchResult("worktree-branch-mismatch");
        return { taskId, worktreeId: task.worktree_id, branch: task.branch, created: false };
      }

      if (task.worktree_id === WORKTREE_CLAIM_PENDING) {
        if (repoMismatch) return mismatchResult("worktree-repo-mismatch");
        if (branchMismatch) return mismatchResult("worktree-branch-mismatch");

        // A DIFFERENT caller is claiming right now — wait for its result rather than racing it.
        if (attempt === POLL_ATTEMPTS) {
          // Finding 6: the poll budget alone can't tell "a real, still-running claimant" from "a dead
          // one" — a real `git worktree add` can legitimately take up to its own 30s timeout. Only
          // treat this as recoverable once the claim has sat unfinalized far longer than any real
          // attempt should.
          const staleBeforeIso = new Date(Date.now() - STALE_WORKTREE_CLAIM_MS).toISOString();
          const reclaim = reclaimStaleTaskWorktreeClaim(database, taskId, { staleBeforeIso });
          if (!reclaim.reclaimed) {
            return {
              ok: false, refused: "worktree-claim-pending",
              error: `another process is creating task ${taskId}'s worktree — retry shortly`,
            };
          }

          // We now own the previously-stale claim, under a FRESH token (finding 9) — the original
          // claimant, if it wakes up later and still holds only its OLD token, can no longer finalize or
          // release this claim; only this reclaim's own `claimToken` can from this point on. The dead
          // claimant may have finished the real `git worktree add` before it died — check disk before
          // redoing work that already landed.
          const worktreeBranch = task.branch ?? branch ?? `ctd/${taskId}`;
          const worktreePath = taskWorktreePath(resolvedRepoPath, taskId);

          // review-consolidated-2026-09-14.md finding 3: the dead claimant might not have been a CREATE
          // at all — a `discardTaskWorktree` call can crash after `git worktree remove` (the directory is
          // genuinely, deliberately gone) but before finalizing to NULL. Without this check, seeing "no
          // directory" below reads identically to "a create never got that far" and this function's own
          // recovery would run `git worktree add`, REVERSING a completed, deliberate deletion. `op` is
          // whatever the DEAD claimant recorded when it claimed (see migration 0017) — a discard op with
          // no real directory on disk means the deletion already happened; refuse instead of redoing.
          if (reclaim.op === "discard" && !looksLikeRealWorktree(worktreePath)) {
            const finalizedAsDiscarded = finalizeTaskWorktreeSlot(database, taskId, {
              worktreeId: null, branch: null, repoPath: null, claimToken: reclaim.claimToken,
            });
            return {
              ok: false, refused: "worktree-was-discarded",
              error: `task ${taskId}'s worktree was already discarded by a crashed process (its claim just `
                + `recovered) — refusing to recreate a worktree that was deliberately deleted`
                + (finalizedAsDiscarded.finalized ? "" : "; the task row may still show a stale claim, investigate manually"),
            };
          }

          if (looksLikeRealWorktree(worktreePath)) {
            const finalizedAdopt = finalizeTaskWorktreeSlot(database, taskId, {
              worktreeId: worktreePath, branch: worktreeBranch, repoPath: resolvedRepoPath, claimToken: reclaim.claimToken,
            });
            // review-sol-2026-09-13.md finding 9's other half: a `finalized: false` here means a THIRD
            // party reclaimed this same claim out from under us (our own reclaim itself sat unfinalized
            // past the stale window) — retry rather than reporting success for a write that did not land.
            if (!finalizedAdopt.finalized) {
              return {
                ok: false, refused: "worktree-claim-superseded",
                error: `task ${taskId}'s worktree claim was reclaimed by another process before this adoption could finalize — retry`,
              };
            }
            return {
              taskId, worktreeId: worktreePath, branch: worktreeBranch, created: false,
              recoveredFromCrashedClaim: true,
            };
          }

          fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
          const added = await runGitWorktreeAdd({ resolvedRepoPath, worktreePath, worktreeBranch });
          if (!added.ok) {
            releaseTaskWorktreeClaim(database, taskId, { previousValue: null, claimToken: reclaim.claimToken });
            return { ok: false, error: added.error.message, refused: "git-worktree-add-failed" };
          }
          const finalizedRedo = finalizeTaskWorktreeSlot(database, taskId, {
            worktreeId: worktreePath, branch: worktreeBranch, repoPath: resolvedRepoPath, claimToken: reclaim.claimToken,
          });
          if (!finalizedRedo.finalized) {
            return {
              ok: false, refused: "worktree-claim-superseded",
              error: `task ${taskId}'s worktree claim was reclaimed by another process before this redo could finalize — retry`,
            };
          }
          return {
            taskId, worktreeId: worktreePath, branch: worktreeBranch, created: true,
            recoveredFromCrashedClaim: true,
          };
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      // `task.worktree_id` is NULL, or a stale path nothing exists at any more — attempt the claim.
      const worktreeBranch = branch ?? task.branch ?? `ctd/${taskId}`;
      const claim = claimTaskWorktreeSlot(database, taskId, {
        previousValue: task.worktree_id, repoPath: resolvedRepoPath, branch: worktreeBranch, op: "create",
      });
      if (!claim.claimed) {
        // Something changed between our read and our claim attempt (another claim landed, or a result
        // did) — re-read and decide again rather than assuming we permanently lost.
        continue;
      }

      // We hold the claim: we are the ONLY caller running git for this task right now.
      const worktreePath = taskWorktreePath(resolvedRepoPath, taskId);
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

      const added = await runGitWorktreeAdd({ resolvedRepoPath, worktreePath, worktreeBranch });
      if (!added.ok) {
        releaseTaskWorktreeClaim(database, taskId, {
          previousValue: task.worktree_id, previousBranch: task.branch, previousRepoPath: task.worktree_repo_path,
          claimToken: claim.claimToken,
        });
        return { ok: false, error: added.error.message, refused: "git-worktree-add-failed" };
      }

      const finalized = finalizeTaskWorktreeSlot(database, taskId, {
        worktreeId: worktreePath, branch: worktreeBranch, repoPath: resolvedRepoPath, claimToken: claim.claimToken,
      });
      if (!finalized.finalized) {
        // finding 9's other half: our own claim sat unfinalized long enough that a later caller's
        // `reclaimStaleTaskWorktreeClaim` minted a NEW token and took it over before this real `git
        // worktree add` (which just succeeded) could finalize. The work on disk is real and will be
        // discovered/adopted by whoever now holds the claim (`looksLikeRealWorktree`, above) — reporting
        // success here for a write that did not land would be the exact lie this fix exists to prevent.
        return {
          ok: false, refused: "worktree-claim-superseded",
          error: `task ${taskId}'s worktree claim was reclaimed by another process before this could finalize — retry`,
        };
      }
      return { taskId, worktreeId: worktreePath, branch: worktreeBranch, created: true };
    }

    // Unreachable in practice — the pending-poll branch above returns at its own budget — but a loop
    // that could theoretically fall through must not return `undefined`.
    return { ok: false, refused: "worktree-claim-timeout", error: `could not claim task ${taskId}'s worktree slot` };
  }

  /**
   * discardTaskWorktree(taskId) -> removes the shared worktree once the task no longer needs it.
   *
   * Refuses on a non-terminal task, the same "refuse rather than silently do something surprising" pattern
   * `reap` already uses for an adopted run — a worker or reviewer could still be attached to this path, and
   * removing it out from under a live run is exactly the accident §7's clean-vs-kill rule exists to prevent
   * elsewhere.
   */
  /** `git status --porcelain` against a worktree path — empty output means clean. Returns `false` (not
   *  dirty) if git itself can't answer, since a discard should not be blocked on an unreadable tree; the
   *  caller-facing consequence is the same "refuse rather than guess" posture as everywhere else here. */
  /**
   * review-sol-2026-09-13.md finding 7: this used to return a bare boolean, and its `catch` returned
   * `false` — meaning "clean" — for a `git status` failure OR timeout, not just a genuinely clean
   * worktree. `discardTaskWorktree`'s caller then ran `git worktree remove --force` on that "clean"
   * verdict, so a permissions error, repo corruption, or a slow disk authorized destroying real
   * uncommitted work that was never actually checked. Now returns one of three states so "could not
   * tell" is a distinguishable, refusable outcome rather than silently downgraded to "clean".
   */
  async function worktreeStatus(worktreePath) {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd: worktreePath, encoding: "utf8", timeout: 10_000,
      });
      return { state: String(stdout).trim().length > 0 ? "dirty" : "clean" };
    } catch (err) {
      return { state: "error", error: err.message };
    }
  }

  async function discardTaskWorktree(taskId, { actor = "owner", force = false, principal = null } = {}) {
    if (!taskId) throw new Error("discardTaskWorktree: taskId is required");
    // review-sol-2026-09-13.md finding 2: `task:worktree` is granted to `worker`/`reviewer` so a run can
    // `requestWorktree` its own overlay (that self-service case is already ownership-bound, see
    // `requestWorktree` above) — but `discardTaskWorktree` took ANY taskId with no ownership check at
    // all, so a worker assigned to task A could force-discard task B's worktree, and `force: true` was
    // reachable by a worker-backed principal at all. A worker/reviewer principal may act only on the
    // task it is CURRENTLY assigned to (`workers.task_id`), and may never pass `force: true` — that is
    // reserved for owner/CTO (no `workerId` on the principal), same boundary `requestWorktree` draws.
    if (principal?.workerId) {
      if (force) {
        return {
          ok: false, refused: "force-not-permitted",
          error: "a worker/reviewer principal may not force-discard a worktree — force is reserved for owner/CTO",
        };
      }
      const assignedTaskId = database.prepare(`SELECT task_id FROM workers WHERE worker_id = ?`).get(principal.workerId)?.task_id ?? null;
      if (assignedTaskId !== taskId) {
        return {
          ok: false, refused: "not-your-task",
          error: `principal is authenticated as worker ${principal.workerId}, assigned to task ${assignedTaskId ?? "(none)"}, `
            + `not ${taskId} — a worker may only discard the worktree of its own currently-assigned task`,
        };
      }
    }
    const task = database
      .prepare(`SELECT id, state, worktree_id, branch, worktree_repo_path FROM tasks WHERE id = ?`)
      .get(taskId);
    if (!task) throw new Error(`discardTaskWorktree: no such task ${taskId}`);
    if (!isTerminal(task.state)) {
      return {
        ok: false, refused: "not-terminal",
        error: `task ${taskId} is "${task.state}", not terminal — refusing to discard a worktree work may still be attached to`,
      };
    }
    if (!task.worktree_id) return { taskId, discarded: false, reason: "no worktree to discard" };
    // Someone else (a concurrent createTaskWorktree redo/adoption, or another discard that landed the
    // instant before this read) already holds the slot — `claimTaskWorktreeSlot`'s CAS is keyed on
    // `previousValue` matching the CURRENT row, so passing the pending marker itself through as
    // `previousValue` would incorrectly "succeed" at re-claiming an already-claimed slot and mint a
    // second, competing token. Refuse instead of racing it — UNLESS the claim has gone stale, in which
    // case a caller that only ever refused here forever is exactly review-consolidated-2026-09-14.md
    // finding 3's "permanently wedged discard": nothing but manual DB surgery could ever clear it, since
    // `reclaimStaleTaskWorktreeClaim` (before this fix) had exactly one caller — `createTaskWorktree`.
    if (task.worktree_id === WORKTREE_CLAIM_PENDING) {
      const staleBeforeIso = new Date(Date.now() - STALE_WORKTREE_CLAIM_MS).toISOString();
      const reclaim = reclaimStaleTaskWorktreeClaim(database, taskId, { staleBeforeIso });
      if (!reclaim.reclaimed) {
        return {
          ok: false, refused: "worktree-claim-conflict",
          error: `task ${taskId}'s worktree slot is already claimed by another in-flight create/discard — retry shortly`,
        };
      }
      // We now hold the previously-stale claim under a fresh token. Whatever the dead claimant was
      // doing, THIS call's own goal is always the same end state: no worktree, `worktree_id = NULL`.
      // `task.worktree_repo_path`/`task.branch` are the values recorded AT CLAIM TIME (migration 0014),
      // which for a legitimate crashed discard are the task's own real values, read and re-passed
      // unchanged by discard's own claim call below — that is what lets us reconstruct the real,
      // deterministic worktree path here even though `task.worktree_id` itself is just the marker.
      const recoveredWorktreePath = task.worktree_repo_path ? taskWorktreePath(task.worktree_repo_path, taskId) : null;
      if (recoveredWorktreePath && looksLikeRealWorktree(recoveredWorktreePath)) {
        const openRunsDuringRecovery = database.prepare(
          `SELECT r.run_id AS runId FROM runs r JOIN workers w ON r.worker_id = w.worker_id
            WHERE w.task_id = ? AND r.ended_at IS NULL`,
        ).all(taskId);
        if (openRunsDuringRecovery.length > 0) {
          // Leave the claim pending under our fresh token rather than releasing it back to a marker a
          // dead process no longer controls — a later retry (after this run ends, or after another
          // stale window) will reclaim it again and can proceed once it's actually safe to.
          return {
            ok: false, refused: "open-run",
            error: `task ${taskId} has ${openRunsDuringRecovery.length} open run(s) still assigned — `
              + "refusing to finish a crashed discard's removal while one is live; stop or reap them first",
          };
        }
        const recoveryRepoRoot = await repoRootFromWorktree(recoveredWorktreePath) ?? task.worktree_repo_path;
        try {
          await execFileAsync("git", ["worktree", "remove", "--force", recoveredWorktreePath], {
            cwd: recoveryRepoRoot, timeout: 30_000,
          });
        } catch (err) {
          return { ok: false, error: err.message, refused: "git-worktree-remove-failed" };
        }
      }
      // Either the directory never existed by the time we got here (the crashed process's own `git
      // worktree remove` already succeeded before it died) or we just finished removing it above —
      // either way, the end state is the same: finalize to NULL.
      const finalizedRecovery = finalizeTaskWorktreeSlot(database, taskId, {
        worktreeId: null, branch: null, repoPath: null, claimToken: reclaim.claimToken,
      });
      if (!finalizedRecovery.finalized) {
        return {
          ok: false, refused: "worktree-claim-superseded",
          error: `task ${taskId}'s worktree was removed on disk, but the claim was superseded before the `
            + "database could be finalized — the task row may still show a stale claim; investigate manually",
        };
      }
      return { taskId, discarded: true, actor, recoveredFromCrashedClaim: true };
    }

    // review-sol-2026-09-13.md finding 8: everything below used to be a plain check-then-act against
    // `task.worktree_id` with no reservation of its own — the open-run check, the clean/dirty check, and
    // `git worktree remove` could all observe a safe state and still race a CONCURRENT
    // `createTaskWorktree`/`assignTask` call landing in the same window, which uses `task.worktree_id`
    // (including mid-removal) as a spawn `cwd`. Claiming the slot with the SAME CAS `createTaskWorktree`
    // itself uses closes that: it flips `worktree_id` to the pending marker atomically, so a concurrent
    // `createTaskWorktree` sees `WORKTREE_CLAIM_PENDING` and polls (never a half-removed directory), and
    // `assignTask`'s `cwd: task.worktree_id` resolution — which cannot itself hold this claim — spawns
    // against the marker string and fails loudly instead of writing into a directory about to be deleted.
    const claim = claimTaskWorktreeSlot(database, taskId, {
      previousValue: task.worktree_id, repoPath: task.worktree_repo_path ?? null, branch: task.branch ?? null, op: "discard",
    });
    if (!claim.claimed) {
      return {
        ok: false, refused: "worktree-claim-conflict",
        error: `task ${taskId}'s worktree slot changed before discard could claim it (now: ${claim.currentValue ?? "(none)"}) `
          + "— another create/discard is in progress for this task, retry",
      };
    }
    const releaseClaim = () => releaseTaskWorktreeClaim(database, taskId, {
      previousValue: task.worktree_id, previousBranch: task.branch, previousRepoPath: task.worktree_repo_path,
      claimToken: claim.claimToken,
    });

    // TASK STATE AND RUN TERMINATION ARE SEPARATE MECHANISMS — `mergeTask` itself moves a task to
    // `merged` without stopping any run using it, so "terminal task state" was never actually the safety
    // backstop this function's comment above claimed. An open run can still be writing into this exact
    // worktree when the task above it is already cancelled/failed/merged. Found by both codex reviews
    // (`codexdoc/review-phase7-uncommitted.md` finding 3, `codexdoc/REVIEW-NOTES.md` finding 4), fixed
    // 2026-09-11. `runs` carries no task_id of its own (task attribution is via the worker's CURRENT
    // assignment) — same join `changedPathsFor`/other task-scoped run lookups already use.
    const openRuns = database.prepare(
      `SELECT r.run_id AS runId FROM runs r JOIN workers w ON r.worker_id = w.worker_id
        WHERE w.task_id = ? AND r.ended_at IS NULL`,
    ).all(taskId);
    if (openRuns.length > 0) {
      releaseClaim();
      return {
        ok: false, refused: "open-run",
        error: `task ${taskId} has ${openRuns.length} open run(s) still assigned (${openRuns.map((r) => r.runId).join(", ")}) — `
          + "terminal task state alone is not a filesystem-lifecycle lock; stop or reap them first",
      };
    }

    // The open-run check above protects a LIVE worker, not the DATA a dead one already produced —
    // `codexdoc/review-luna-2026-09-11.md` finding 8: a terminal task with no open run can still have an
    // uncommitted file sitting in its worktree, and the unconditional `--force` below deleted it with no
    // trace. Refuse by default; `force: true` is the explicit, named override, not a default no one chose.
    // Note: `force` reaching this point at all means the caller was owner/CTO — the check above already
    // refused it for a worker/reviewer principal.
    if (!force) {
      const status = await worktreeStatus(task.worktree_id);
      if (status.state !== "clean") {
        releaseClaim();
        return {
          ok: false, refused: status.state === "dirty" ? "worktree-dirty" : "worktree-status-unknown",
          error: status.state === "dirty"
            ? `task ${taskId}'s worktree has uncommitted changes — pass { force: true } to discard them anyway`
            : `could not determine whether task ${taskId}'s worktree is clean (${status.error}) — `
              + "refusing to discard on an unverified status; pass { force: true } to discard anyway",
        };
      }
    }

    const repoRoot = await repoRootFromWorktree(task.worktree_id);
    if (!repoRoot) {
      releaseClaim();
      return { ok: false, refused: "git-error", error: `could not resolve the repo root for ${task.worktree_id}` };
    }
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", task.worktree_id], {
        cwd: repoRoot, timeout: 30_000,
      });
    } catch (err) {
      releaseClaim();
      return { ok: false, error: err.message, refused: "git-worktree-remove-failed" };
    }

    const finalized = finalizeTaskWorktreeSlot(database, taskId, {
      worktreeId: null, branch: null, repoPath: null, claimToken: claim.claimToken,
    });
    if (!finalized.finalized) {
      // The claim sat unfinalized long enough (or was otherwise superseded) that this write did not
      // land — the git-level removal already happened, but reporting `discarded: true` here would claim
      // a database write that did not take effect.
      return {
        ok: false, refused: "worktree-claim-superseded",
        error: `task ${taskId}'s worktree was removed on disk, but the claim was superseded before the database `
          + "could be finalized — the task row may still show a stale worktree_id; investigate manually",
      };
    }

    return { taskId, discarded: true, actor };
  }

  /**
   * requestWorktree(runId, { reason }) -> an isolated OVERLAY worktree for one run (PLAN.md §7's explicit
   * opt-out from the task's shared worktree).
   *
   * The default is the task's ONE shared worktree, created by `createTaskWorktree`; this exists only for a
   * run that needs isolated testing/experimentation it does not want landing in the shared tree. `reason` is
   * required — §16's "never guess an underspecified request" — and logged to `agent_journal`, the same
   * "task history, not memory" log every other command already writes through `authorizedCommandHandlers()`,
   * so it is queryable later: which runs branched off for isolated work, and why. (That wrapper already
   * journals this call generically on every outcome; the extra call below mirrors `grantApproval`'s own
   * pattern of a SECOND, human-readable entry carrying detail the generic one does not capture — here, the
   * actual reason text, not just the command name and taskId.)
   *
   * Branches off the task's CURRENT HEAD, at a path alongside the shared worktree rather than nested inside
   * it, so discarding one never touches the other.
   */
  async function requestWorktree(runId, { reason, principal = null } = {}) {
    if (!runId) throw new Error("requestWorktree: runId is required");
    if (!reason) {
      return { ok: false, refused: "missing-reason", error: "a reason is required for an isolated worktree request" };
    }
    // Cross-run ownership binding, added 2026-09-11 (`codexdoc/review-phase7-uncommitted.md` finding 4):
    // a worker-backed principal may only request an overlay for ITS OWN run — without this, worker A's
    // token could request (and later be journaled as the requester of) an overlay for worker B's run. A
    // principal with no `workerId` (owner/CTO) is unrestricted — that delegation question is deliberately
    // not decided here, same boundary `recordVerdict`'s sibling fix drew.
    if (principal?.workerId && workerIdForRun(database, runId) !== principal.workerId) {
      return {
        ok: false, refused: "not-your-run",
        error: `principal is authenticated as worker ${principal.workerId}, which does not own run ${runId} — `
          + "a worker may only request an overlay for its own run",
      };
    }

    const taskId = taskIdForRun(database, runId);
    if (!taskId) return { ok: false, refused: "no-task", error: `no task found for run ${runId}` };
    const task = database.prepare(`SELECT id, worktree_id FROM tasks WHERE id = ?`).get(taskId);
    if (!task?.worktree_id) {
      return { ok: false, refused: "no-shared-worktree", error: `task ${taskId} has no shared worktree yet — create one first` };
    }

    const repoRoot = await repoRootFromWorktree(task.worktree_id);
    if (!repoRoot) {
      return { ok: false, refused: "git-error", error: `could not resolve the repo root for ${task.worktree_id}` };
    }

    const overlayPath = path.join(repoRoot, ".git", "ctd-overlays", runId);
    // A DIFFERENT top-level ref namespace than the task branch (`ctd/<taskId>`), not a child of it: git
    // refs are a filesystem-like hierarchy, so `refs/heads/ctd/<taskId>/overlay-<runId>` cannot coexist
    // with `refs/heads/ctd/<taskId>` — "cannot lock ref ... refs/heads/ctd/<taskId> exists" (measured, not
    // assumed; hit this exact collision while building this).
    const overlayBranch = `ctd-overlay/${taskId}/${runId}`;
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });

    try {
      await execFileAsync("git", ["worktree", "add", "-b", overlayBranch, overlayPath, "HEAD"], {
        cwd: task.worktree_id, timeout: 30_000,
      });
    } catch (err) {
      return { ok: false, error: err.message, refused: "git-worktree-add-failed" };
    }

    if (principal) {
      const hash = argsHash({ runId, reason });
      journalAppend(database, {
        principalId: principal.id, action: "task:worktree", argsSha256: hash, taskId,
        argsPreview: `requestWorktree ${runId}: ${reason}`.slice(0, 200), outcome: "done", detail: reason,
      });
    }

    return { runId, taskId, worktreePath: overlayPath, branch: overlayBranch, sharedWorktreePath: task.worktree_id };
  }

  return { createTaskWorktree, discardTaskWorktree, requestWorktree };
}
