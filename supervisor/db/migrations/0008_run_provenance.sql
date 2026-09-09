-- 0008_run_provenance.sql — who started this run (owner's request, 2026-09-07).
--
-- WHY, AND WHAT IT IS *NOT* FIXING
--
-- The concern that prompted this: "a session started outside the dashboard could be stopped by the
-- orphan mechanism". Checked before building, and that specific fear does not reproduce — a session a
-- person starts by hand has **no `runs` row at all**, and both dangerous paths are row-driven:
--
--   reconcileOnBoot()  input is `listOpenRuns(db)`   -> a process with no row is never examined
--   reap()             takes a runId from `getRun()` -> a process with no row cannot be named
--
-- and group-kill cannot leak into one either, because `spawnManaged` gives every child its own
-- process group (pgid === pid) and `reap` already refuses a pgid shared with another open run.
-- Migration 0007 then covers the one externally-started case that DOES get a row — an adopted
-- session — by making `reap` refuse it.
--
-- So this column is not a new safety mechanism. It makes an invariant that was previously *implicit
-- in three separate mechanisms* into one explicit, queryable fact:
--
--   **the supervisor only ever kills a process it started itself.**
--
-- That is worth having written down for the same reason `runs.lifecycle` was worth having (0003):
-- an invariant nothing can state is an invariant nothing can test, and this one is now asserted
-- directly rather than inferred from the absence of a row.
--
--   'dashboard' : the supervisor spawned it. The ONLY value that may be reaped.
--   'hook'      : an externally-started session that reported itself (0007). Never reaped.
--   'preflight' : the supervisor spawned it for a reachability check (0005). Reaped by its own
--                 cleanup path, not by the orphan reaper.
--
-- Existing rows default to 'dashboard', which is correct: every row that exists before this
-- migration was created by `supervisor.start()`.

ALTER TABLE runs ADD COLUMN started_by TEXT NOT NULL DEFAULT 'dashboard';

-- The query the invariant is checked with: "is anything reapable that we did not start?"
CREATE INDEX idx_runs_started_by ON runs(started_by, ended_at);
