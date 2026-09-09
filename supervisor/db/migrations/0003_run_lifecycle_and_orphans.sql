-- Migration 0003: make `orphaned-unmanaged` a lifecycle STATE on a still-open run row
-- instead of a terminal exit reason, and give asks a grace period before auto-closing.
--
-- Why (Group 6 finding, decided 2026-09-06 after three independent model opinions all
-- landed on the same shape): reconciliation used to write `ended_at` + `exit_reason =
-- 'orphaned-unmanaged'` for a process it had just verified to be STILL RUNNING. Since
-- reconciliation's input set is `WHERE ended_at IS NULL`, that closed row made a live,
-- unmanaged process invisible to every later boot — it kept consuming CPU and tokens with
-- nobody watching, and nothing would ever mention it again. It also dropped out of
-- `listOpenRunsSharingProcessGroup`, so reaping a sibling run on a pooled `opencode serve`
-- pgid would group-kill the orphan's still-live session without anyone noticing.
--
-- `ended_at` now means what it says: execution actually ended. An orphan is not ended, so
-- it keeps `ended_at IS NULL` and carries `lifecycle = 'orphaned-unmanaged'` instead. The
-- consequence, and the point: every boot re-examines it, and it gets a real terminal
-- transition later — `lost` once its process is gone, `reaped` once we kill it.
--
--   runs.lifecycle   'managed' (default) | 'orphaned-unmanaged'. NOT a status field in the
--                    PLAN.md section 4 sense: it is not derived from an event stream, it
--                    records what reconciliation OBSERVED about OS-level ownership.
--   runs.reaped_at   when a successful reap actually killed the process group. Distinct
--                    from `ended_at`: "the row was closed" and "we killed the process" are
--                    different facts, and before this column history could not tell a
--                    reaped orphan from one still running.
--   asks.auto_close_at  when an unanswered ask on a NATURALLY COMPLETED run becomes
--                    eligible for auto-close (completion + a 5-minute grace, so a human
--                    who is around can still answer). Persisted rather than held as an
--                    in-memory timer on purpose: a supervisor crash during the grace must
--                    not lose the pending close, so boot sweeps it.

ALTER TABLE runs ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'managed';
ALTER TABLE runs ADD COLUMN reaped_at TEXT;

ALTER TABLE asks ADD COLUMN auto_close_at TEXT;

-- Reconciliation's second hot query, alongside idx_runs_open: "which open rows are already
-- known orphans" (so a repeat sighting is distinguishable from a new one).
CREATE INDEX idx_runs_orphaned ON runs(lifecycle) WHERE lifecycle = 'orphaned-unmanaged';

-- The sweep's query: unresolved asks with an expired grace.
CREATE INDEX idx_asks_auto_close ON asks(auto_close_at) WHERE resolved = 0 AND auto_close_at IS NOT NULL;

-- Append-only sightings log. Deliberately NOT a second source of truth about orphans —
-- `runs.lifecycle` is that. This is a journal in the same spirit as `transition_journal`:
-- one row every time reconciliation observes a live-but-unmanaged process, so "we have been
-- getting a lot of orphans lately" is a query rather than a feeling, and a future watcher
-- process has a history to reason about. Nothing reads it back as state.
CREATE TABLE orphan_sightings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES runs(run_id),
  seen_at        TEXT NOT NULL,
  pid            INTEGER,
  process_group  INTEGER,
  proc_lstart    TEXT,
  -- 'new' the first time this run is seen orphaned, 'repeat' on every later boot that still
  -- finds it alive and unmanaged.
  kind           TEXT NOT NULL,
  note           TEXT
);

CREATE INDEX idx_orphan_sightings_run_id ON orphan_sightings(run_id, seen_at);
