-- 0009_reviews.sql — configurable reviews (PLAN.md section 13). Phase 6.
--
-- WHAT SECTION 13 IS FIXING, in its own words: "all four reviews independently found the original review
-- model rigid: hardcoded reviewer slots, verdicts that outlive the commit they judged, undefined quorum,
-- undefined precedence when verdicts disagree." Two tables, and the shape of each is the fix.
--
-- WHY `review_profiles` IS A TABLE AT ALL, given that its source is a hand-edited file.
--
-- PLAN.md section 3 draws the distinction explicitly, and reviews land on the opposite side of it from
-- `harness-defaults.json`: `review-profiles.json` "is imported into the `review_profiles` table on
-- supervisor startup/file-change (that table exists specifically to hold it) — SQLite is truth for *that
-- copy* once imported, and re-editing the JSON re-imports it", whereas `harness-defaults.json` "has no
-- corresponding table and is read straight from disk".
--
-- That is not an inconsistency, and the reason is durability of judgement rather than convenience: a
-- verdict recorded under a profile has to remain interpretable later. `review_verdicts` rows say "correctness
-- was approved" and mean nothing without knowing whether correctness was BLOCKING at the time and what
-- quorum was in force. Reading the current file would answer with today's config, so a profile edit would
-- silently rewrite the meaning of every verdict already recorded — which is precisely the "verdicts that
-- outlive the thing they judged" failure this section exists to remove, arriving from the config side.
--
-- So the imported copy is versioned by content hash, and a verdict records which profile row it was judged
-- under. An assignment's harness/model choice needs no such treatment: it is an input to a process, not a
-- lens through which a stored judgement is read.
--
-- WHY A VERDICT IS FIVE COLUMNS OF IDENTITY AND NOT ONE MUTABLE FIELD
--
--   task_id + round + commit_sha  : WHICH revision this judged. Section 13's `revisionBound` — "approvals
--                                   die when the commit changes" — is enforced by comparing `commit_sha`,
--                                   so an approval cannot survive the code it approved.
--   worker_id + slot              : WHO judged, durably. `worker_id` survives clear/respawn (section 3's
--                                   identity split), so a reviewer that was restarted mid-round does not
--                                   lose its verdicts, and `slot` is what quorum's `parentCounts` reasons
--                                   about.
--   dimension                     : WHAT was judged. Per-dimension, because the approval rule is per
--                                   BLOCKING dimension: one reviewer approving correctness while another
--                                   requests changes on security is a coherent, common state that a single
--                                   `verdict` column cannot express at all.
--
-- The UNIQUE constraint is on exactly that tuple. A reviewer revising its own opinion on one dimension in
-- one round REPLACES that row (upsert); it does not append a second, because "which of these two is current"
-- would then be a question with no answer in the data — and section 13's rule counts CURRENT-ROUND verdicts.
--
-- `findings_json` is stored on the verdict rather than in its own table, deliberately: section 13 asks for
-- findings to be stored "so a re-review can diff against the previous round instead of re-deriving it", and
-- a diff between rounds reads whole rounds at once. Findings are also never queried independently of the
-- verdict that carries them — nothing asks "all findings about line 42 across all tasks".

CREATE TABLE review_profiles (
  -- The profile's name as written in the file ("default", "hotfix", "docs-only", ...).
  id            TEXT NOT NULL,
  -- Content hash of the RESOLVED profile (after `extends` is applied). Part of the key, so a profile
  -- edited between rounds produces a new row rather than mutating the one older verdicts point at.
  config_hash   TEXT NOT NULL,
  config_json   TEXT NOT NULL,
  imported_at   TEXT NOT NULL,
  PRIMARY KEY (id, config_hash)
);

CREATE TABLE review_verdicts (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  worker_id      TEXT NOT NULL REFERENCES workers(worker_id),
  slot           TEXT NOT NULL,
  round          INTEGER NOT NULL,
  commit_sha     TEXT NOT NULL,
  dimension      TEXT NOT NULL,
  -- 'approved' | 'changes-requested' | 'abstain'. Not a CHECK constraint: the legal set lives in
  -- domain/review.js beside the rule that interprets it, and splitting a vocabulary across a schema
  -- constraint and a pure module is how the two drift.
  verdict        TEXT NOT NULL,
  findings_json  TEXT,
  -- Which imported profile row this verdict was judged under, so it stays interpretable after an edit.
  profile_id     TEXT,
  profile_hash   TEXT,
  at             TEXT NOT NULL,
  -- One current opinion per reviewer, per dimension, per round. See the header.
  UNIQUE (task_id, round, commit_sha, worker_id, dimension)
);

CREATE INDEX idx_review_verdicts_task ON review_verdicts(task_id, round);
CREATE INDEX idx_review_verdicts_commit ON review_verdicts(task_id, commit_sha);
