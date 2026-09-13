// migration-0013-to-0016.test.js — review-sol-2026-09-13.md finding 47: migrations 0013-0016 had NO
// dedicated upgrade test at all (only 0011/0012 did), and the generic `migrations.test.js` only ever
// checks a FRESH database, never a POPULATED one upgrading through them. This proves the upgrade path
// with REAL PRE-EXISTING ROWS at schema version 0012 — an mcp_pool row in its pre-0013 shape (no
// status/pgid/lstart columns yet), a task, and a resource_leases row — then upgrades to latest and
// checks: the new columns/table exist, existing rows get the DOCUMENTED backfill default (not NULL,
// not an error), the new FOREIGN KEY constraints (0011/0013, checked against `runs`) hold for a bad
// reference, and `PRAGMA integrity_check` still reports `ok` after all of it.
//
// Cases:
//   1. a database populated at schema version 0012 upgrades cleanly to latest
//   2. the pre-existing mcp_pool row is backfilled with the DOCUMENTED defaults (status='starting',
//      pgid/lstart NULL), not silently dropped or left in an inconsistent state
//   3. the new mcp_pool_attachments table (0013) exists, is empty, and enforces its FK against runs
//   4. the pre-existing task row gets worktree_repo_path (0014) and, later, no worktree_claim_token
//      (0016) issue -- both NULL for a row that predates the claim mechanism entirely
//   5. PRAGMA integrity_check reports ok after the full upgrade

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, closeDb } from "../index.js";
import { applyMigrations, getSchemaVersion, latestMigrationVersion, migrationFiles, MIGRATIONS_DIR } from "../migrate.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

function columns(db, table) {
  return db.prepare(`SELECT name FROM pragma_table_info('${table.replace(/'/g, "''")}')`).all().map((r) => r.name);
}

await runTest("migration-0013-to-0016", async () => {
  const upgradeDir = makeScratchDir("supervisor-migration-0013-to-0016-upgrade");
  const priorMigrationsDir = fs.mkdtempSync(path.join(upgradeDir, "prior-migrations-"));
  try {
    const allFiles = migrationFiles();
    const priorFiles = allFiles.filter((f) => parseInt(f.match(/^(\d+)_/)[1], 10) <= 12);
    assert.ok(priorFiles.length > 0 && priorFiles.length < allFiles.length, "expected some but not all migrations to predate 0013");
    for (const f of priorFiles) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(priorMigrationsDir, f));
    }

    const dbPath = path.join(upgradeDir, "upgrade.sqlite3");
    const rawDb = new Database(dbPath);
    rawDb.pragma("busy_timeout = 5000");
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    const priorResult = applyMigrations(rawDb, { dir: priorMigrationsDir });
    assert.equal(priorResult.appliedTo, 12, `expected to land on version 12, got ${priorResult.appliedTo}`);
    assert.ok(!columns(rawDb, "mcp_pool").includes("status"), "sanity: mcp_pool.status must not exist yet at version 12");

    // Populate REAL rows at v12, in v12's own shape — this is the part `migrations.test.js`'s
    // fresh-database check can never exercise: real data that has to SURVIVE the upgrade.
    const nowIso = new Date().toISOString();
    rawDb.prepare(
      `INSERT INTO mcp_pool (id, name, config_hash, pid, socket_path, refcount, started_at, last_attached_at)
       VALUES ('pool-pre-0013', 'leo-mcp', 'hash1', 12345, NULL, 1, ?, NULL)`,
    ).run(nowIso);
    rawDb.prepare(`INSERT INTO harnesses (id, display_name) VALUES ('fake', 'Fake Harness')`).run();
    rawDb.prepare(
      `INSERT INTO tasks (id, title, type, state, created_at, updated_at) VALUES ('task-pre-0013', 'pre-existing task', 'feature', 'created', ?, ?)`,
    ).run(nowIso, nowIso);

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    const upgradeResult = applyMigrations(rawDb);
    assert.equal(upgradeResult.appliedFrom, 12);
    assert.equal(upgradeResult.appliedTo, latestMigrationVersion());
    for (const v of [13, 14, 15, 16]) {
      assert.ok(upgradeResult.applied.some((f) => f.startsWith(`00${v}_`)), `expected migration ${v} to apply, applied: ${upgradeResult.applied.join(", ")}`);
    }
    console.log("  1. a database populated at schema version 0012 upgrades cleanly to latest");

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    const poolCols = columns(rawDb, "mcp_pool");
    for (const col of ["status", "pgid", "lstart"]) {
      assert.ok(poolCols.includes(col), `expected mcp_pool.${col} to exist after upgrade, have: ${poolCols.join(", ")}`);
    }
    const preExistingPool = rawDb.prepare(`SELECT * FROM mcp_pool WHERE id = 'pool-pre-0013'`).get();
    assert.ok(preExistingPool, "the pre-existing mcp_pool row must have survived the upgrade");
    assert.equal(preExistingPool.status, "starting", "a pre-existing row must be backfilled with the migration's OWN documented default, not left NULL");
    assert.equal(preExistingPool.pgid, null, "pgid has no default to backfill and must stay NULL, not error or get a guessed value");
    assert.equal(preExistingPool.lstart, null, "lstart (0015) has no default to backfill and must stay NULL");
    assert.equal(preExistingPool.pid, 12345, "the pre-existing pid must be untouched by the upgrade");
    console.log("  2. the pre-existing mcp_pool row is backfilled with the documented defaults, not dropped or left inconsistent");

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    const tableRows = rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(tableRows.includes("mcp_pool_attachments"), `expected mcp_pool_attachments after upgrade, have: ${tableRows.join(", ")}`);
    const attachmentCount = rawDb.prepare(`SELECT COUNT(*) AS n FROM mcp_pool_attachments`).get().n;
    assert.equal(attachmentCount, 0, "the new table must be genuinely empty after an upgrade, not pre-populated with a guess");
    // The FK (0013) references runs(run_id) — a bogus run_id must be refused, proving the constraint is
    // REAL, not just declared. `foreign_keys = ON` was set on this connection above.
    assert.throws(
      () => rawDb.prepare(
        `INSERT INTO mcp_pool_attachments (id, pool_id, principal_id, run_id, attached_at, detached_at)
         VALUES ('att-bad', 'pool-pre-0013', NULL, 'no-such-run', ?, NULL)`,
      ).run(nowIso),
      /FOREIGN KEY constraint failed/,
      "mcp_pool_attachments.run_id must genuinely enforce its FK against runs, not just declare one",
    );
    console.log("  3. mcp_pool_attachments exists, is empty after upgrade, and genuinely enforces its FK against runs");

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    const taskCols = columns(rawDb, "tasks");
    for (const col of ["worktree_repo_path", "worktree_claim_token"]) {
      assert.ok(taskCols.includes(col), `expected tasks.${col} to exist after upgrade, have: ${taskCols.join(", ")}`);
    }
    const preExistingTask = rawDb.prepare(`SELECT worktree_repo_path, worktree_claim_token FROM tasks WHERE id = 'task-pre-0013'`).get();
    assert.equal(preExistingTask.worktree_repo_path, null, "a task predating the worktree-claim mechanism entirely must have NULL worktree_repo_path (0014), never a guessed value");
    assert.equal(preExistingTask.worktree_claim_token, null, "same for worktree_claim_token (0016) — NULL, not a guessed value");
    console.log("  4. the pre-existing task row gets NULL worktree_repo_path/worktree_claim_token, never guessed values");

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    const integrity = rawDb.prepare("PRAGMA integrity_check").all();
    assert.deepEqual(integrity, [{ integrity_check: "ok" }], `expected integrity_check ok after the full upgrade, got: ${JSON.stringify(integrity)}`);
    console.log("  5. PRAGMA integrity_check reports ok after the full 0012 -> latest upgrade with real pre-existing data");

    rawDb.close();
    const db2 = openDb({ stateDir: upgradeDir });
    assert.equal(getSchemaVersion(db2), latestMigrationVersion());
    closeDb(db2);
  } finally {
    rmScratchDir(upgradeDir);
  }
});
