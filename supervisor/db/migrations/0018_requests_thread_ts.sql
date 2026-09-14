-- 0018_requests_thread_ts.sql — Phase 9 (Slack outbound), ROADMAP.md's own checklist item: "A `requests`
-- row must carry `{channel, thread_ts}` so an accepted review-request can be answered back into its
-- originating thread." `channel` already existed (migration 0001); `thread_ts` did not (confirmed:
-- `grep -rn "thread_ts" db/migrations/*.sql` returned nothing before this file).
--
-- Additive only, no backfill needed — every existing `requests` row predates Slack inbound entirely (that
-- table's own header comment: "Slack inbound only (backlog per PLAN.md section 13.2)"), so a NULL
-- `thread_ts` on every row that exists today is the honest value, not a guess.
ALTER TABLE requests ADD COLUMN thread_ts TEXT;
