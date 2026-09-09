-- Migration 0004: make `asks` capable of a real round trip to a harness and back.
--
-- AMENDED IN PLACE on 2026-09-07, the same day it was written, after a three-model code review
-- found four defects in it (the unique index spanning process generations, `decision` being
-- flattened to 'closed' for historical human answers, a missing way for the redelivery queue to
-- end, and a comment claiming a redaction that does not exist). Amending rather than adding a
-- 0005 is safe here and was checked, not assumed: the only database on this machine that has
-- ever been migrated is at schema_version 2, so no database anywhere has applied 0004. Do NOT
-- treat this as licence to edit a migration in general — the next one to be released is
-- immutable.
--
-- Phase 2's approval slice, and the measurement that motivated it: `claude` 2.1.263 sends
-- the supervisor a `can_use_tool` control request, PARKS the turn indefinitely, and acts on
-- the answer written back on stdin (evidence: adapters/claude-code/probe/, recorded in
-- adapters/FINDINGS.md). Answering it therefore needs three things the old `asks` table
-- could not hold: which parked harness request an answer belongs to, what the worker
-- actually asked (a tool call with arguments, or a multiple-choice question), and whether
-- the answer has been HANDED BACK yet as opposed to merely written down.
--
-- Four changes, each with a reason:
--
-- 1. `task_id` becomes NULLABLE. An ask is created by a RUN — the supervisor sees a parked
--    request on a run and must write the row before anything else can happen. The task is
--    context, and in the Phase 2 slice (and for any adhoc/DM session, PLAN.md section 10)
--    there may not be one. The old NOT NULL forced a caller to invent a task id to satisfy
--    a constraint, and a row that has to lie to be insertable means the constraint is wrong.
--
-- 2. `kind`, `payload_json`, `harness_request_id`, `harness_tool_use_id`, `generation`.
--    `harness_request_id` is the correlation the answer travels back on; without it an
--    answered ask is a row nobody can act on. `generation` pins the ask to the run
--    generation that parked it, because `resume()` bumps `runs.generation` and rebinds to a
--    NEW OS process (0003 review) — an answer must never be delivered to a process that did
--    not ask.
--
-- 3. `answered_at` is split out from `delivered_at`, which previously meant both. They are
--    different facts and PLAN.md section 7 turns on the difference: "persists the answer
--    *before* marking resolved (ordering matters — a crash between those two steps must not
--    lose the answer)". Now `answered_at` = the answer is durable; `delivered_at` = the
--    harness accepted it. A row with `answered_at` set and `delivered_at` NULL is the
--    redelivery queue, and it is what makes the round trip survive a crash.
--    `delivered_at` stays NULL where there was nothing to deliver to (a question with no
--    parked harness request, or a run whose process is already gone) rather than being
--    stamped to look complete.
--
-- 4. `decision` and `answer_json` beside the existing prose `answer`. An approval answer is
--    `allow`/`deny`; a question's answer is a map of question text to chosen label; a
--    supervisor close is neither. Keeping the machine-readable form out of the human-
--    readable column means the auto-close reason string and a structured answer stop
--    fighting over one TEXT field.
--
-- SQLite cannot ALTER a column's nullability, so this is the standard table rebuild.
-- It is safe to do inside migrate.js's `BEGIN IMMEDIATE` **because no other table
-- references `asks`** (checked: no `REFERENCES asks` anywhere in the schema), so there are
-- no child rows for `foreign_keys = ON` to invalidate and nothing for the rename to rewrite.
-- Do not copy this pattern onto a table that IS referenced without re-checking that.

CREATE TABLE asks_new (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(run_id),
  -- Nullable on purpose; see note 1 above.
  task_id             TEXT REFERENCES tasks(id),
  -- 'question'      : a worker asking a human something (AskUserQuestion, or a plain ask).
  -- 'tool-approval' : a worker blocked on permission to run a specific tool call.
  -- Measured (adapters/FINDINGS.md): on Claude Code BOTH arrive on the same `can_use_tool`
  -- channel and are told apart by `requires_user_interaction`, so this column records the
  -- distinction the wire makes rather than inventing one.
  kind                TEXT NOT NULL DEFAULT 'question',
  question            TEXT NOT NULL,
  -- The structured request as the harness sent it (tool name, arguments, the harness's own
  -- "always allow this rule" suggestions, the question options).
  --
  -- RETAINED IN FULL WHILE THE ASK IS PENDING, AND DELIBERATELY SO. An earlier version of
  -- this comment claimed it was "redacted at the write boundary like every other payload in
  -- this schema", which was simply false and was caught by both reviewers: `db/redact.js` is
  -- only wired to `runs.prompt`. The claim was also the wrong goal — approving a command you
  -- cannot read is worse than the retention, so a human must see the exact argv.
  --
  -- What is done instead (`redactAskPayload` in db/index.js): the full payload lives only for
  -- the decision window, and is replaced by a hash + bounded preview when the ask resolves,
  -- unless SUPERVISOR_PERSIST_FULL_PROMPTS opts in. So a bearer token in a Bash command is
  -- visible to the human deciding on it and is not still sitting in the database next month.
  -- `event_log` remains a separate, pre-existing, still-open gap — see HANDOFF.md.
  payload_json        TEXT,
  -- The parked harness control_request this ask answers. NULL for an ask that nothing is
  -- waiting on.
  harness_request_id  TEXT,
  harness_tool_use_id TEXT,
  -- runs.generation at the moment the ask was created; see note 2.
  generation          INTEGER,
  answer              TEXT,
  answer_json         TEXT,
  -- 'allow' | 'deny' | 'answered' | 'closed' | 'withdrawn'
  decision            TEXT,
  answered_by         TEXT,
  answered_at         TEXT,
  delivered_at        TEXT,
  -- Why a delivery attempt failed, kept so a stuck round trip is diagnosable rather than
  -- just silently undelivered.
  delivery_error      TEXT,
  -- When delivery was given up on for good, as opposed to failing and being worth a retry.
  -- Added after review: without it, a row whose parked request no longer exists (the harness
  -- withdrew it, the process was replaced, the run was reconciled) sat in the redelivery queue
  -- being retried on every boot forever, because "answered and not delivered" is true of a
  -- permanently undeliverable answer exactly as it is of a transiently failed one. The queue
  -- has to be able to end.
  delivery_abandoned_at TEXT,
  resolved            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  auto_close_at       TEXT
);

-- Existing rows are all plain questions. `answered_at` inherits the old `delivered_at`,
-- because under the old semantics that column WAS the answer timestamp; `delivered_at` is
-- reset to NULL rather than carried over, since nothing was ever delivered to a harness
-- before this migration existed. That is a deliberate rewrite of history to the truth, not
-- a data loss: the value survives in `answered_at`.
--
-- `decision` is BACKFILLED BY WHO ANSWERED, not flattened to 'closed'. The first version of
-- this migration wrote 'closed' for every resolved row, which relabelled a real human answer
-- as a supervisor close and destroyed the one distinction the column exists to record. The
-- supervisor's own closers are the only writers of `answered_by` values beginning
-- 'supervisor:' (`closeOpenAsksForRun` writes 'supervisor:reconciliation', `sweepExpiredAsks`
-- writes 'supervisor:auto-close'), so that prefix is the reliable discriminator.
INSERT INTO asks_new (id, run_id, task_id, kind, question, answer, answered_by, answered_at,
                      delivered_at, resolved, created_at, auto_close_at, decision)
SELECT id, run_id, task_id, 'question', question, answer, answered_by, delivered_at,
       NULL, resolved, created_at, auto_close_at,
       CASE
         WHEN resolved = 0 THEN NULL
         WHEN answered_by IS NOT NULL AND answered_by LIKE 'supervisor:%' THEN 'closed'
         WHEN answer IS NOT NULL OR answered_by IS NOT NULL THEN 'answered'
         ELSE 'closed'
       END
  FROM asks;

DROP TABLE asks;
ALTER TABLE asks_new RENAME TO asks;

-- Rebuilt from 0001 and 0003; a table rebuild drops the originals with the old table.
CREATE INDEX idx_asks_task_id ON asks(task_id);
CREATE INDEX idx_asks_run_id ON asks(run_id);
CREATE INDEX idx_asks_resolved ON asks(resolved);
CREATE INDEX idx_asks_auto_close ON asks(auto_close_at) WHERE resolved = 0 AND auto_close_at IS NOT NULL;

-- "What is blocked right now, oldest first" — the query the dashboard's badge and the
-- `asks` wire command both run.
CREATE INDEX idx_asks_pending ON asks(created_at) WHERE resolved = 0;

-- The redelivery queue: answered and durable, the harness has not taken it yet, and we have
-- not given up on it.
CREATE INDEX idx_asks_undelivered ON asks(run_id)
  WHERE answered_at IS NOT NULL AND delivered_at IS NULL AND delivery_abandoned_at IS NULL
    AND harness_request_id IS NOT NULL;

-- One ask per parked harness request, PER GENERATION. The event pump can re-deliver an event
-- (its whole point is that eviction is never silent, not that delivery is exactly-once), so
-- without a unique guard one parked request could become two competing ask rows and answering
-- one would leave the other open forever.
--
-- `generation` is in the key because of a defect both reviewers found: scoped to
-- (run_id, harness_request_id) alone, the index reserved a request id for the whole LIFETIME
-- of a logical run, across every OS process `resume()` ever binds to it. A second generation
-- reusing an id — which a harness numbering requests per process will do immediately — hit the
-- historical row, `recordApprovalAsk` swallowed the UNIQUE error as a benign duplicate, and the
-- new worker stayed parked forever with no ask row through which anyone could answer it.
-- `COALESCE(generation, -1)` rather than a bare `generation`, because SQLite treats NULLs as
-- DISTINCT in a unique index: with the bare column, two asks that both carry a request id but no
-- generation would not conflict, and the guard would silently not apply to exactly the rows least
-- likely to have been written carefully. Caught by this migration's own test.
CREATE UNIQUE INDEX idx_asks_harness_request
  ON asks(run_id, COALESCE(generation, -1), harness_request_id)
  WHERE harness_request_id IS NOT NULL;
