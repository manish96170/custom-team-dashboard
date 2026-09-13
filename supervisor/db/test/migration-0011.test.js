// migration-0011.test.js — proves migration 0011 (resource_leases, mcp_pool; PLAN.md
// sections 20/21) both on a fresh database and on one upgraded from schema version 0010,
// matching the standing rule that a migration must apply cleanly on top of prior state,
// not just from scratch.

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

await runTest("migration-0011", async () => {
  // --- Part 1: fresh database straight through to latest -------------------------------
  const freshDir = makeScratchDir("supervisor-migration-0011-fresh");
  try {
    const db = openDb({ stateDir: freshDir });

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    assert.ok(tables.includes("resource_leases"), `expected resource_leases table, have: ${tables.join(", ")}`);
    assert.ok(tables.includes("mcp_pool"), `expected mcp_pool table, have: ${tables.join(", ")}`);

    const leaseColumns = columns(db, "resource_leases");
    for (const col of [
      "id", "resource_name", "kind", "capacity",
      "holder_principal_id", "holder_run_id", "reason",
      "acquired_at", "heartbeat_at", "ttl_expires_at", "released_at", "release_reason",
    ]) {
      assert.ok(leaseColumns.includes(col), `expected resource_leases.${col}, have: ${leaseColumns.join(", ")}`);
    }

    const poolColumns = columns(db, "mcp_pool");
    for (const col of ["id", "name", "config_hash", "pid", "socket_path", "refcount", "started_at", "last_attached_at"]) {
      assert.ok(poolColumns.includes(col), `expected mcp_pool.${col}, have: ${poolColumns.join(", ")}`);
    }

    // tasks.worktree_id / branch already existed (migration 0001) -- 0011 deliberately adds
    // nothing there. Assert the columns are still exactly the pre-existing ones, so nobody
    // reads "0011 didn't touch tasks" as an oversight later.
    const taskColumns = columns(db, "tasks");
    assert.ok(taskColumns.includes("worktree_id"), "tasks.worktree_id must still exist (migration 0001)");
    assert.ok(taskColumns.includes("branch"), "tasks.branch must still exist (migration 0001)");
    assert.ok(!taskColumns.includes("worktree_path"), "0011 must not add a redundant worktree_path column");
    assert.ok(!taskColumns.includes("worktree_branch"), "0011 must not add a redundant worktree_branch column");

    // Unique index enforces one resident MCP process per (name, config_hash).
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mcp_pool'").all().map((r) => r.name);
    assert.ok(indexes.includes("idx_mcp_pool_identity"), `expected idx_mcp_pool_identity, have: ${indexes.join(", ")}`);

    assert.equal(getSchemaVersion(db), latestMigrationVersion());
    closeDb(db);
  } finally {
    rmScratchDir(freshDir);
  }

  // --- Part 2: a database previously migrated only through 0010, then upgraded ---------
  const upgradeDir = makeScratchDir("supervisor-migration-0011-upgrade");
  const priorMigrationsDir = fs.mkdtempSync(path.join(upgradeDir, "prior-migrations-"));
  try {
    // Stage a directory containing only migrations up to and including 0010, so
    // applyMigrations can bring a fresh db to exactly that version -- simulating "this
    // database was created before 0011 existed."
    const allFiles = migrationFiles();
    const priorFiles = allFiles.filter((f) => parseInt(f.match(/^(\d+)_/)[1], 10) <= 10);
    assert.ok(priorFiles.length > 0 && priorFiles.length < allFiles.length, "expected some but not all migrations to predate 0011");
    for (const f of priorFiles) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(priorMigrationsDir, f));
    }

    const dbPath = path.join(upgradeDir, "upgrade.sqlite3");
    const rawDb = new Database(dbPath);
    rawDb.pragma("busy_timeout = 5000");
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    const priorResult = applyMigrations(rawDb, { dir: priorMigrationsDir });
    assert.equal(priorResult.appliedTo, 10, `expected to land on version 10, got ${priorResult.appliedTo}`);
    const priorTables = rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(!priorTables.includes("resource_leases"), "resource_leases must not exist yet at version 10");
    assert.ok(!priorTables.includes("mcp_pool"), "mcp_pool must not exist yet at version 10");

    // Now upgrade the same connection to latest using the real migrations directory.
    const upgradeResult = applyMigrations(rawDb);
    assert.equal(upgradeResult.appliedFrom, 10);
    assert.equal(upgradeResult.appliedTo, latestMigrationVersion());
    assert.ok(upgradeResult.applied.some((f) => f.startsWith("0011_")), `expected 0011 to apply, applied: ${upgradeResult.applied.join(", ")}`);

    const upgradedTables = rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(upgradedTables.includes("resource_leases"), "resource_leases must exist after upgrading from 0010");
    assert.ok(upgradedTables.includes("mcp_pool"), "mcp_pool must exist after upgrading from 0010");

    // Re-running is a genuine no-op, same standing rule as migrations.test.js.
    const before = rawDb.prepare("SELECT COUNT(*) AS n FROM schema_version").get().n;
    const noop = applyMigrations(rawDb);
    const after = rawDb.prepare("SELECT COUNT(*) AS n FROM schema_version").get().n;
    assert.equal(noop.applied.length, 0, "re-running applyMigrations after the upgrade must apply nothing");
    assert.equal(before, after);

    rawDb.close();
  } finally {
    rmScratchDir(upgradeDir);
  }
});
