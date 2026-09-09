# Findings — Phase 1 Group 1: Persistence foundation

(Written by the parent session — the subagent that did this work was blocked by tool
policy from writing this file itself; this is its report, verbatim.)

## Built (all under `supervisor/db/`)

- `supervisor/package.json` — `better-sqlite3` dependency. **Deviation**: `^11.3.0`
  fails to compile from source on this machine's Node 26 toolchain (v8 header errors
  in node-gyp); switched to `^13.0.3`, which has a prebuilt binary and loads cleanly
  (verified).
- `supervisor/db/migrations/0001_initial.sql` — creates `harnesses`, `teams`,
  `workers`, `runs`, `tasks`, `asks`, `requests`, `integrations` (ships empty),
  `event_log` (tiers 1-2), `transition_journal`, `outbox`.
- `supervisor/db/migrate.js` — `applyMigrations(db)`: numbered `.sql` files,
  `schema_version` table, each migration in its own transaction, idempotent re-runs,
  duplicate-version detection.
- `supervisor/db/paths.js` — state dir/db path resolution
  (`SUPERVISOR_STATE_DIR` override).
- `supervisor/db/redact.js` — `redactPrompt()`: SHA-256 + ~200-char preview by
  default; full text only via explicit opt-in or
  `SUPERVISOR_PERSIST_FULL_PROMPTS=1|true` (anything else fails closed).
- `supervisor/db/index.js` — `openDb()` (0700 dir / 0600 file enforcement, WAL mode,
  foreign keys, busy_timeout, runs migrations) plus targeted single-row writers
  (`createRun`, `recordEvent`, `answerAsk` writes answer+resolved atomically in one
  statement, `endRun`, `createAsk`, `createTask`, `createWorker`, `createTeam`,
  `upsertHarness`, `recordTransition`, `enqueueOutbox`).
- `supervisor/db/test/*.test.js` (migrations, permissions, redaction,
  concurrent-write) and `supervisor/db/bench/event-log-insert.bench.js` — every
  script uses a shared `runTest()` helper (`db/test/_helpers.js`) that
  `process.exit(1)`s with the real error on any failed assertion, `exit(0)` only on
  genuine success — the explicit fix for spike-0b's "printed output, exited 0
  regardless" defect.

## Proven, with real captured output

- **Migrations**: `schema_version=1`, all 12 tables present, `integrations` has 0
  rows, re-applying is a true no-op.
- **Permissions**: state dir forced to `0700` and db file/WAL/SHM sidecars forced to
  `0600`, verified via `statSync`/`ls -la` even after deliberately loosening the dir
  mode beforehand.
- **Redaction**: default path never writes full prompt text to disk (verified by
  scanning raw db bytes for a secret substring); opt-in path (flag or env var) does.
  **One real limitation surfaced during testing**: the ~200-char preview is not a
  secret-scrubber — a secret in the first 200 chars of a prompt legitimately lands in
  `prompt_preview`. Documented, not silently fixed by over-promising.
- **Concurrent writes**: 8 real OS processes hammering the same SQLite file
  concurrently — `PRAGMA integrity_check` = `ok`, exactly 2000/2000 event rows, 0 torn
  rows, correct per-run attribution, no lost writes.
- **No O(all-rows) rewrite**: 40,000 single-row inserts across 40 runs — per-insert
  cost flat (~0.03ms) from an empty table to 40k rows (0.97x ratio, well under a 6x
  failure threshold) — the opposite of spike-0b's full-file-rewrite behavior.

## Deviations from PLAN.md section 3 (documented, deliberate)

- `review_profiles`/`review_verdicts` not created (out of Group 1's scope — add as a
  migration `0002` later, alongside section 12's configurable-reviews work).
- Added `prompt_sha256`/`prompt_preview`/`prompt_full` columns to `runs` — PLAN.md's
  schema block has no prompt column, but spike-0b finding S13 specifically concerns
  `runs`-adjacent prompt persistence, so this was added to actually close that gap.
- `event_log.seq` is one global `AUTOINCREMENT` rather than per-run — still monotonic
  per-run when filtered, avoids an extra counter table.

## Deferred / open

- Only `runs.prompt_*` is redacted — `event_log.payload_json` tier-1/2 bodies are
  stored as-is per plan and were out of this task's named scope.
- No retention/rotation policy for `event_log` yet — belongs with Group 5's
  run-lifecycle ownership.
- Concurrent-write test used 8 processes, not the full "10 concurrent sessions"
  target scale (no structural reason to expect different behavior, but not tested at
  that exact number).

Reproduce: `cd supervisor/ && npm install && npm run test:db && npm run bench:db`.

## Fix applied (2026-09-05, post cross-model code review)

**Blocking bug fixed**: `createAsk()` (index.js:220) had a VALUES clause with 8 slots
for 9 listed columns — every call threw `SqliteError: 8 values for 9 columns` and
`createAsk()` always failed, which meant `answerAsk()` had nothing to operate on
either. Found independently by review (`review-two/group1-persistence-luna.md`).
Fixed: added the missing `NULL` for `delivered_at`. Verified end-to-end with a real
insert (team/worker/task/run/harness parent rows + createAsk + SELECT back) — see
git history for the exact before/after.

## Fixes applied (2026-09-05, second pass — the two remaining blocking bugs)

Both of Group 1's remaining blocking findings are now fixed, with regression tests in
`db/test/concurrent-startup.test.js` and `db/test/wal-conversion.test.js` (both wired
into `npm run test:db`).

**1. Concurrent-startup `SQLITE_BUSY`** (`index.js`, `openDb()` / `setWalMode()`).
Two parts, and only the second one is load-bearing:
- `busy_timeout` is now the *first* pragma on the connection, before anything that can
  contend. Correct by construction, but reverting this alone did not make any test fail
  — the timeout was already in place before migrations either way.
- The real fix: **`journal_mode = WAL` is now retried**. SQLite requires exclusive
  access to convert a database to WAL and does **not** invoke the busy handler for that
  conversion, so a `busy_timeout` cannot absorb it at all — it returns `SQLITE_BUSY`
  immediately if any other connection has an open transaction. `setWalMode()` retries
  within the timeout budget and treats "another process already made it WAL" as success.
  Once the file is WAL the pragma is a no-op needing no lock, so this only ever spins on
  the first open of a fresh database.

`wal-conversion.test.js` reproduces this deterministically (a helper process holds an
open write transaction on a non-WAL db while the parent calls `openDb()`); it fails 3/3
runs against the pre-fix code with `database is locked`.

**2. Unserialized migration application** (`migrate.js`, `applyMigrations()`). Each
migration now runs inside a `BEGIN IMMEDIATE` transaction that takes the write lock
*before* re-reading `schema_version`, so a connection that lost the race re-reads under
the lock, sees the migration already applied, and skips it instead of re-running the
DDL. `concurrent-startup.test.js` (8 processes racing openDb() on an empty state dir,
6 rounds alternating simultaneous-barrier and staggered arrival) fails 6/6 runs against
the pre-fix code with `table harnesses already exists`; it also asserts that exactly one
process reports applying `0001_initial.sql`.

Note on the arrival patterns: they are not decoration. Barrier rounds reliably surface
the migration race but *hide* the WAL one (all children find a zero-length file, whose
conversion needs no contended lock); staggered rounds do the opposite. Measured by
reverting each fix in turn.

Also fixed in passing, since it is in the lines being touched: `busyTimeoutMs` is now
validated as a non-negative integer before being interpolated into the PRAGMA.

**Not yet fixed, carried forward** (see review-two/ for full detail):
- Redaction doesn't cover `event_log`/`outbox` payloads, only `runs.prompt_*`
  (should-fix, partially already documented as a known limitation).
- Schema declares a `requests` table with no corresponding writer function
  (should-fix).
- Errors during `openDb()` setup can leave a handle open (should-fix).
- `endRun()`/`answerAsk()` don't check affected-row counts (minor).
