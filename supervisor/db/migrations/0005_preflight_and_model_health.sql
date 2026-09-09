-- 0005_preflight_and_model_health.sql — PLAN.md section 12.1: a preflight session is
-- ephemeral and must leave nothing behind, but its VERDICT must survive.
--
-- WHY THIS NEEDS SCHEMA AT ALL
--
-- Verifying that a harness/model combination is reachable means starting a real session and
-- sending a real prompt, which writes a real `runs` row and real `event_log` rows. None of
-- that is work anyone will ever want to read, and all of it pollutes the history a human or
-- the CTO reads back: "who did what" becomes twenty sessions saying "hi". So two things are
-- needed, and they pull in opposite directions:
--
--   1. `runs.is_preflight` — so the row can be EXCLUDED from every human-facing view while
--      still being visible to reconciliation. That distinction is the whole point: a
--      preflight that crashed is an orphaned process like any other and must be reaped by
--      the same path, not by a second mechanism. Hiding it from reconciliation too would
--      turn "leaves nothing behind" into "leaks a process nobody can see".
--   2. `model_health` — the verdict, kept after the session is deleted. It is a fact about
--      the MODEL, not a session anyone should be able to open, which is why it is a separate
--      table rather than a surviving `runs` row: section 12.3's denylist and settings surface
--      read this, and nothing there wants a run id.
--
-- WHY `is_preflight` IS A COLUMN AND NOT A `lifecycle` VALUE
--
-- `runs.lifecycle` (migration 0003) answers "was this process ever observed running
-- unmanaged". Whether a run is a preflight is orthogonal: a preflight can perfectly well be
-- orphaned, and needs to be reaped as one. Folding the two together would recreate exactly
-- the mistake 0003 fixed, where one column answered two questions and the second was lost.

ALTER TABLE runs ADD COLUMN is_preflight INTEGER NOT NULL DEFAULT 0;

-- Reconciliation reads `WHERE ended_at IS NULL`; the human-facing list additionally filters
-- on this. Indexed together because "open AND not preflight" is the common query and
-- "preflight rows still around" is the cleanup sweep.
CREATE INDEX idx_runs_is_preflight ON runs(is_preflight, ended_at);

-- The verdict that outlives the session.
--
-- One row per (harness, provider, model) — a check REPLACES the previous verdict rather than
-- appending, because what section 12.3 needs is "is this usable right now", not a history of
-- every ping. `checked_at` is what makes a stale verdict recognisable as stale; without it a
-- month-old "unreachable" would look like present fact.
CREATE TABLE model_health (
  harness_id    TEXT NOT NULL REFERENCES harnesses(id),
  provider_id   TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  -- 1 = a real response came back. 0 = it did not. Deliberately NOT NULL: "we do not know"
  -- is the absence of a row, not a third value in this column, so a reader cannot mistake an
  -- unfinished check for a failed one.
  reachable     INTEGER NOT NULL,
  -- A CLASS, not a message: 'ok' | 'timeout' | 'spawn-failed' | 'auth' | 'no-response' |
  -- 'harness-error' | 'crashed'. Section 12.3 wants to reason about these ("everything on
  -- Bedrock is failing"), and a free-text provider message cannot be grouped. The message
  -- itself goes in `detail` for a human, and is nullable because a success has nothing to say.
  error_class   TEXT NOT NULL,
  detail        TEXT,
  latency_ms    INTEGER,
  checked_at    TEXT NOT NULL,
  PRIMARY KEY (harness_id, provider_id, model_id)
);

CREATE INDEX idx_model_health_checked_at ON model_health(checked_at);
