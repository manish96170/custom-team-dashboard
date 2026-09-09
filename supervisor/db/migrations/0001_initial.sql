-- Migration 0001: initial schema (PLAN.md section 3, Phase 1 / TODO Group 1 scope).
--
-- Scope note: this migration creates only the tables TODO.md's "Group 1 — Persistence
-- foundation" enumerates: schema_version, harnesses, teams, workers, runs, tasks, asks,
-- requests, integrations, event_log (tiers 1-2 only), transition_journal, outbox.
-- review_profiles / review_verdicts (PLAN.md section 12) are explicitly out of scope
-- for Group 1 and are not created here — add them in a later numbered migration when
-- that phase lands.
--
-- Deviation from PLAN.md's schema block, documented here and in db/FINDINGS.md:
-- PLAN.md's `runs` table does not list a prompt column, but the spike-0b review
-- (finding S13, consolidated-review-claudeopus5-medium--spike-0b.md) found the spike
-- persisting `prompt: spec.prompt` verbatim on the run record in a plain JSON file.
-- Since a run's initial prompt is the concrete thing that needs redacting at the write
-- boundary, this migration adds three columns to `runs` for it: prompt_sha256 (always
-- populated), prompt_preview (first ~200 chars, always populated), and prompt_full
-- (nullable; populated only when the caller opts in). See db/redact.js.

CREATE TABLE harnesses (
  id                  TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  heartbeat_mechanism  TEXT,
  config_path         TEXT,
  status              TEXT NOT NULL DEFAULT 'not-configured',
  capabilities_json    TEXT,
  onboarded_at         TEXT
);

CREATE TABLE teams (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  hidden_from_top_bar   INTEGER NOT NULL DEFAULT 0
);

-- membership is derived from workers.team_id, never duplicated (PLAN.md section 3)
CREATE TABLE workers (
  worker_id   TEXT PRIMARY KEY,
  nickname    TEXT NOT NULL,
  role        TEXT NOT NULL,
  team_id     TEXT REFERENCES teams(id),
  task_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'idle',
  cwd         TEXT,
  revision    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_workers_team_id ON workers(team_id);
CREATE INDEX idx_workers_task_id ON workers(task_id);

-- one immutable process generation; every heartbeat/event/command carries run_id,
-- never worker_id, so a late heartbeat from a killed process cannot overwrite the
-- status of the run that replaced it (PLAN.md section 3).
CREATE TABLE runs (
  run_id              TEXT PRIMARY KEY,
  worker_id           TEXT NOT NULL REFERENCES workers(worker_id),
  harness_id          TEXT NOT NULL REFERENCES harnesses(id),
  harness_session_id  TEXT,
  pid                 INTEGER,
  process_group       INTEGER,
  generation          INTEGER NOT NULL DEFAULT 1,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  exit_reason         TEXT,
  -- redaction at the write boundary (S13) -- see note above
  prompt_sha256       TEXT,
  prompt_preview      TEXT,
  prompt_full         TEXT
);

CREATE INDEX idx_runs_worker_id ON runs(worker_id);
CREATE INDEX idx_runs_harness_id ON runs(harness_id);

CREATE TABLE tasks (
  id                          TEXT PRIMARY KEY,
  title                       TEXT NOT NULL,
  aliases_json                TEXT,
  team_id                     TEXT REFERENCES teams(id),
  type                        TEXT NOT NULL,
  state                       TEXT NOT NULL DEFAULT 'created',
  main_worker_id              TEXT REFERENCES workers(worker_id),
  source                      TEXT,
  repo_id                     TEXT,
  worktree_id                 TEXT,
  branch                      TEXT,
  base_rev                    TEXT,
  harness_assignments_json    TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  merged_at                   TEXT,
  revision                    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_tasks_team_id ON tasks(team_id);
CREATE INDEX idx_tasks_state ON tasks(state);

-- the approval control plane, not a notification nicety (PLAN.md section 7).
-- Persist the answer before marking resolved, always -- enforced at the call site
-- in db/index.js's answerAsk(), not just documented here.
CREATE TABLE asks (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(run_id),
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  question      TEXT NOT NULL,
  answer        TEXT,
  answered_by   TEXT,
  delivered_at  TEXT,
  resolved      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_asks_task_id ON asks(task_id);
CREATE INDEX idx_asks_run_id ON asks(run_id);
CREATE INDEX idx_asks_resolved ON asks(resolved);

-- Slack inbound only (backlog per PLAN.md section 13.2) -- table exists now so the
-- schema doesn't need a later migration just to add it.
CREATE TABLE requests (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  channel           TEXT,
  mentioned_handle  TEXT,
  raw_text          TEXT,
  slack_permalink   TEXT,
  posted_by         TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  linked_task_id    TEXT REFERENCES tasks(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_linked_task_id ON requests(linked_task_id);

-- ships EMPTY and versioned (PLAN.md section 3) -- no pre-created rows, ever.
CREATE TABLE integrations (
  id      TEXT PRIMARY KEY,
  status  TEXT NOT NULL DEFAULT 'not-configured'
);

-- tier 1 (raw) / tier 2 (turn digest) only, per this migration's scope (tier 3 task
-- handoff docs are derived/regenerated elsewhere, not stored as event_log rows).
-- seq is a single global monotonic AUTOINCREMENT rather than one counter per run_id --
-- PLAN.md says "monotonic seq per run," and a global monotonic sequence still yields a
-- monotonic per-run subsequence when filtered by run_id, so the requirement holds;
-- recorded here as a deliberate simplification, not an oversight.
CREATE TABLE event_log (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(run_id),
  tier          INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload_json  TEXT,
  ts            TEXT NOT NULL
);

CREATE INDEX idx_event_log_run_id_seq ON event_log(run_id, seq);
CREATE INDEX idx_event_log_tier ON event_log(tier);

CREATE TABLE transition_journal (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  actor       TEXT NOT NULL,
  at          TEXT NOT NULL
);

CREATE INDEX idx_transition_journal_task_id ON transition_journal(task_id);

-- append-only audit trail + basis for Slack outbound and any future
-- "notify me when X changes" integration, without polling (PLAN.md section 3).
CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  payload_json  TEXT,
  delivered     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_outbox_delivered ON outbox(delivered);
