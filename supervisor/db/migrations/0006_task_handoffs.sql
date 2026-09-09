-- 0006_task_handoffs.sql — PLAN.md section 8, Rule 4: the tier-3 task handoff.
--
-- A CORRECTION TO PLAN.md SECTION 8, and the reason this table exists at all.
--
-- Rule 4 says "three tiers over the same `event_log`". That is right for tiers 1 and 2 and
-- **cannot** be right for tier 3, because the two are scoped differently and the schema says
-- so out loud:
--
--   event_log.run_id  TEXT NOT NULL REFERENCES runs(run_id)
--
-- `event_log` is RUN-scoped and NOT NULL. A tier-3 handoff is TASK-scoped by definition -- Rule
-- 4's own table says "per task, regenerated on transition", and its readers are "CTO, leads,
-- reviewers, any new/cleared worker", none of whom are asking about one run. A task outlives
-- every individual run on it, which is the entire reason a handoff is worth writing.
--
-- Attaching it to "the task's most recent run" would have worked mechanically and been wrong in
-- two ways that matter: a task with no runs yet could have no handoff, and deleting a run would
-- delete task knowledge. (The second is not hypothetical -- migration 0005's
-- `deletePreflightRun` deletes `event_log` rows by `run_id`.)
--
-- So tiers 1 and 2 share `event_log`; tier 3 gets this table. PLAN.md section 8 has been
-- corrected to say so.
--
-- APPEND-ONLY, NOT REPLACE. Rule 4 says "regenerated on transition", and the previous handoff is
-- what makes a regeneration reviewable: "the goal changed between these two" is a question worth
-- being able to ask. Readers take the newest row for a task. This differs deliberately from
-- migration 0005's `model_health`, which DOES replace -- that answers "is this usable right now"
-- and has no historical value, whereas a handoff is a record of understanding over time.

CREATE TABLE task_handoffs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  -- The rendered document. Text rather than structured columns because its consumer is a MODEL
  -- (or a human) reading a page, and because Rule 4 caps it at roughly one page -- so the
  -- storage cost of the rendered form is the point rather than a concern.
  doc           TEXT NOT NULL,
  -- What it was generated FROM, as a JSON object of counts and ids. This is what makes a handoff
  -- auditable rather than merely present: "which transitions and which asks did this see" is the
  -- first question anyone will ask of a summary they do not trust, and a summary nobody trusts is
  -- worse than no summary.
  sources_json  TEXT,
  -- Rule 4's budget is "rolling ~1 page". Recorded so a handoff that hit the cap is
  -- recognisable as truncated rather than looking complete.
  chars         INTEGER NOT NULL,
  truncated     INTEGER NOT NULL DEFAULT 0,
  -- What triggered it: 'manual' | 'state-transition' | 'clear' | 'boot'. Rule 5 makes clearing
  -- routine precisely because tier 3 exists, so knowing which handoff was written FOR a clear is
  -- how that claim gets checked later.
  reason        TEXT NOT NULL,
  generated_at  TEXT NOT NULL
);

CREATE INDEX idx_task_handoffs_task_id ON task_handoffs(task_id, id);
