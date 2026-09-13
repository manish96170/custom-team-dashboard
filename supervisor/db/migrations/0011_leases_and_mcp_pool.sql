-- 0011_leases_and_mcp_pool.sql — host-resource arbitration (PLAN.md section 20) and MCP server
-- pooling (PLAN.md section 21). Phase 7.
--
-- WHAT THIS MIGRATION DOES NOT DO, AND WHY
--
-- The original task for this migration also asked for `tasks.worktree_path` / `worktree_branch`.
-- Checked first, per this project's own "verify the mechanism, not just the conclusion" rule
-- (HANDOFF.md): `tasks` already has `worktree_id` (migration 0001, used today as the working
-- directory path -- see `runtime/supervisor.js`'s `cwd: task.worktree_id` and
-- `handoff/generate.js`) and `branch`. Adding new columns for the same fact would create two
-- sources of truth for "where does this task's work live" -- exactly the shape HANDOFF.md calls
-- out as a mistake elsewhere (`runs.lifecycle` vs `exit_reason`). PLAN.md section 7's shared
-- per-task worktree lands on the EXISTING `worktree_id`/`branch` columns; nothing new is needed
-- here for that part.
--
-- RESOURCE LEASES (PLAN.md section 20)
--
-- Arbitration between COOPERATING sessions for a machine-wide resource the supervisor did not
-- necessarily create: `git:identity` (one global credential state, two GitHub accounts) and
-- `host:heavy-job` (host memory/CPU -- concurrent webpack builds from independent sessions
-- exhausted it once). Two kinds: 'exclusive' (one live holder) and 'counted' (a semaphore up to
-- `capacity` concurrent holders).
--
-- Modeled as one row per ACTIVE CLAIM, not one row per resource with a holder column, because
-- 'counted' with capacity > 1 needs more than one concurrent holder and a single holder column
-- can't represent that. `released_at IS NULL` means "still held" -- the same convention `runs`
-- and `asks` already use for "still open" (`ended_at IS NULL`), chosen deliberately so the same
-- query shape ("what's still open") already familiar in this codebase applies here too.
--
-- `kind` and `capacity` are stamped onto the claim at acquire time rather than looked up from a
-- separate resource-registry table. PLAN.md section 20.1 declares resources in a static
-- `resources.json`, which stays the source of truth for what a resource *is*; denormalizing kind
-- and capacity onto each claim means a test or an operator can read "who holds what, and under
-- what rule" from the database alone, without also having the config file loaded.
--
-- TTL + heartbeat, both persisted (never an in-memory timer) -- the same reasoning as
-- `asks.auto_close_at` (migration 0003): a holder SIGKILLed mid-lease must expire on its own,
-- not deadlock every future waiter. `heartbeat_at` is what a live holder renews; `ttl_expires_at`
-- is what a sweep compares against. A lease is stale exactly when `released_at IS NULL AND
-- ttl_expires_at < now` -- a query, not an inference.
--
-- Acquire/release logic, the sweep, and admission control are NOT part of this migration --
-- schema only, so the next piece (the lease API) has a foundation rather than a moving target.
CREATE TABLE resource_leases (
  id                TEXT PRIMARY KEY,
  resource_name     TEXT NOT NULL,
  -- 'exclusive' | 'counted'. Enforced by application logic, not a CHECK constraint here --
  -- this project's other enum-shaped columns (e.g. principals.kind, agent_journal.outcome)
  -- follow the same pattern of documenting the allowed set in a comment rather than a CHECK,
  -- so a new kind is an application-level decision, not a migration.
  kind              TEXT NOT NULL,
  -- NULL for 'exclusive' (capacity of 1 is implied); the configured concurrent-holder limit
  -- for 'counted'.
  capacity           INTEGER,
  -- Who holds this claim. A principal always exists (section 16's capability gate applies to
  -- lease acquisition too); the run may not, if a claim is held by something that isn't a
  -- worker run (the sweep itself, a utility agent invocation with no run row).
  holder_principal_id TEXT NOT NULL REFERENCES principals(id),
  holder_run_id       TEXT REFERENCES runs(run_id),
  reason              TEXT,
  acquired_at         TEXT NOT NULL,
  heartbeat_at        TEXT NOT NULL,
  ttl_expires_at      TEXT NOT NULL,
  -- NULL means still held -- see header. Set exactly once, at release.
  released_at         TEXT
);

-- "Who holds resource X right now" -- the query the acquire path runs on every attempt.
CREATE INDEX idx_resource_leases_active ON resource_leases(resource_name, released_at);
-- "Find expired leases" -- the query the (not-yet-built) sweep runs on its interval.
CREATE INDEX idx_resource_leases_expiry ON resource_leases(released_at, ttl_expires_at);
-- "What does this run currently hold" -- released on run end, same shape as other
-- run-scoped cleanup queries in this codebase.
CREATE INDEX idx_resource_leases_run ON resource_leases(holder_run_id);

-- MCP SERVER POOLING (PLAN.md section 21.1)
--
-- Every session that uses an MCP-backed tool today spins its own copy of that MCP server --
-- N concurrent sessions duplicate N processes for one logical service. This table lets the
-- supervisor find and reuse a running one instead: one resident process per distinct
-- (name, config_hash) pair, refcounted by attached sessions, torn down on an idle TTL at zero
-- refcount (never mid-use). `config_hash` is part of identity, not just an integrity check --
-- two sessions configuring the same named server DIFFERENTLY must not share a process, so
-- identity is (name, config) together, not name alone.
--
-- Pool spawn/attach/detach/idle-teardown logic is NOT part of this migration -- schema only.
CREATE TABLE mcp_pool (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  config_hash      TEXT NOT NULL,
  pid              INTEGER,
  socket_path      TEXT,
  refcount         INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT NOT NULL,
  last_attached_at TEXT
);

-- One resident process per distinct (name, config) pair -- the invariant this whole table
-- exists to enforce, made mechanical rather than just documented.
CREATE UNIQUE INDEX idx_mcp_pool_identity ON mcp_pool(name, config_hash);
