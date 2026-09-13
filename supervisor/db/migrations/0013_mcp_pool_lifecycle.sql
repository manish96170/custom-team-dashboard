-- 0013_mcp_pool_lifecycle.sql — a real lifecycle and attachment-derived refcount for `mcp_pool`
-- (PLAN.md section 21.1). Phase 7.
--
-- Migration 0011 built `mcp_pool` as schema only, with a bare `refcount` integer and an explicit note
-- that "spawn/attach/detach/idle-teardown logic is NOT part of this migration". Building that logic
-- (`runtime/mcp-pool.js`) exposed why a bare integer doesn't survive review: a crash between "attach
-- decided refcount should go from 0 to 1" and "the increment committed" leaves no record of what
-- actually happened, and there is no way to reconstruct it later. `codexdoc/REVIEW-NOTES.md`'s "Before
-- MCP pooling and lazy discovery" section says this explicitly: "Derive refcounts from attachment
-- records ... a lone integer cannot explain a crash between attach and increment."
--
-- STATUS — a real lifecycle, not just "does it have a pid":
--   'starting' — a caller claimed the (name, config_hash) slot and is spawning the process. No other
--                caller may spawn a second one for the same identity; the unique index on
--                (name, config_hash) already made that a DB-level guarantee, this makes it a business
--                one too.
--   'ready'    — spawned, pid recorded, attachable.
--   'draining' — the last attachment detached; teardown in progress. NOT attachable — a caller arriving
--                here creates a fresh row instead of joining a dying process (see `runtime/mcp-pool.js`'s
--                `attach()` for exactly how that avoids the last-detach-vs-new-attach race).
--   'stopped'  — torn down cleanly.
--   'failed'   — spawn failed, or the process died unexpectedly (caught by boot-time reconciliation).
--
-- `refcount` is UNUSED as of this migration — kept as a column (SQLite table rebuilds are not worth the
-- risk pre-release, and no code ever wrote a real value into it) but nothing reads it either. The
-- authoritative count is `COUNT(*) FROM mcp_pool_attachments WHERE pool_id = ? AND detached_at IS NULL`.
--
-- `mcp_pool_attachments` is one row per live client attachment, the same `released_at`-style
-- nullable-timestamp-means-still-open convention `resource_leases`/`asks`/`runs` already use for "is
-- this still open" — chosen deliberately so the same query shape applies here too.
ALTER TABLE mcp_pool ADD COLUMN status TEXT NOT NULL DEFAULT 'starting';
-- The process GROUP id, not just the pid — ownership verification before a kill needs it, same reasoning
-- `runs.process_group` already has for exactly the same purpose (migration 0002).
ALTER TABLE mcp_pool ADD COLUMN pgid INTEGER;

CREATE TABLE mcp_pool_attachments (
  id            TEXT PRIMARY KEY,
  pool_id       TEXT NOT NULL REFERENCES mcp_pool(id),
  principal_id  TEXT REFERENCES principals(id),
  run_id        TEXT REFERENCES runs(run_id),
  attached_at   TEXT NOT NULL,
  -- NULL means still attached. Set exactly once, at detach — same convention as
  -- `resource_leases.released_at`.
  detached_at   TEXT
);

-- "How many live attachments does this pool have right now" — the query both `attach()`'s
-- draining-vs-joinable decision and `detach()`'s drain-trigger decision run.
CREATE INDEX idx_mcp_pool_attachments_live ON mcp_pool_attachments(pool_id, detached_at);
