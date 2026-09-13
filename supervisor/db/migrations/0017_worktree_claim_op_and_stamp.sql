-- 0017_worktree_claim_op_and_stamp.sql — codexdoc/review-consolidated-2026-09-14.md findings 3 and 11.
--
-- Finding 3: `claimTaskWorktreeSlot` wrote the same generic `WORKTREE_CLAIM_PENDING` marker whether the
-- caller was `createTaskWorktree` or `discardTaskWorktree`, with no record of WHICH operation owned the
-- claim. A crash mid-discard (after `git worktree remove` but before finalize) left the row wedged; once
-- the claim went stale, `createTaskWorktree`'s own recovery path had no way to tell "a create crashed, the
-- directory is genuinely missing, redo it" from "a discard crashed, the directory is genuinely gone
-- ON PURPOSE, do not recreate it" — and resurrected a deliberately deleted worktree. `worktree_claim_op`
-- ('create' | 'discard') is that missing distinction.
--
-- Finding 11: stale-claim recovery compared `staleBeforeIso` against `tasks.updated_at`, the row's
-- general-purpose write stamp — ANY unrelated write to the task (a state transition, a title edit)
-- refreshed it and pushed the staleness window out again, so a genuinely crashed claim could stay
-- unrecoverable indefinitely. `worktree_claim_at` is a claim-specific stamp, written only by
-- `claimTaskWorktreeSlot` and `reclaimStaleTaskWorktreeClaim` — nothing else ever touches it.
--
-- Both NULL for every existing row (no backfill needed — a row with no pending claim has nothing to
-- record; a row this migration didn't exist for yet cannot have started a claim under 0017's own rules).
ALTER TABLE tasks ADD COLUMN worktree_claim_op TEXT;
ALTER TABLE tasks ADD COLUMN worktree_claim_at TEXT;
