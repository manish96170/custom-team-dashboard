-- Migration 0002: the columns startup reconciliation and `reap` actually need
-- (TODO.md Group 5).
--
-- PLAN.md section 4 requires reconciliation to "verify PID + process group + start time
-- actually match a live process", but PLAN.md's own `runs` schema block (and therefore
-- migration 0001) lists only `pid` and `process_group`. Start time was never persisted,
-- which makes the pid-reuse guard impossible: a recorded pid that is alive again as an
-- unrelated process would verify clean, and `reap` would kill a stranger's process
-- group. `proc_lstart` closes that.
--
-- The other three columns are what Group 5's routing needs on boot, when the only thing
-- that survives a supervisor restart is the database:
--   cwd         -- which working directory this run belongs to. Required to dispose the
--                  right pooled `opencode serve` process (the OpenCode adapter pools one
--                  server per cwd), and to re-derive a run's identity after a restart.
--   spawn_depth -- the DASHBOARD_SPAWN_DEPTH the child was actually spawned with, so a
--                  recursion-guard violation is visible in the record, not just refused
--                  in memory.
--   reconciled_at -- set only by reconciliation. Distinguishes "the adapter's own normal
--                  completion path ended this run" (NULL) from "a supervisor restart
--                  derived its outcome" (a timestamp), which is exactly the distinction
--                  PLAN.md's three-outcome model rests on: `finished` is never written
--                  by reconciliation.

ALTER TABLE runs ADD COLUMN proc_lstart   TEXT;
ALTER TABLE runs ADD COLUMN cwd           TEXT;
ALTER TABLE runs ADD COLUMN spawn_depth   INTEGER;
ALTER TABLE runs ADD COLUMN reconciled_at TEXT;

-- Reconciliation's hot query is "every run that isn't terminal yet", run once per boot
-- over a table that grows without bound.
CREATE INDEX idx_runs_open ON runs(ended_at) WHERE ended_at IS NULL;
