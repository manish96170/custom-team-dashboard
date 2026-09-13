// migration-0012.test.js — proves migration 0012 (`resource_leases.release_reason`, PLAN.md
// section 20) applies cleanly on top of a database that was previously only at schema
// version 0011, not just from scratch.

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

await runTest("migration-0012", async () => {
  // Fresh straight through.
  const freshDir = makeScratchDir("supervisor-migration-0012-fresh");
  try {
    const db = openDb({ stateDir: freshDir });
    assert.ok(columns(db, "resource_leases").includes("release_reason"));
    closeDb(db);
  } finally {
    rmScratchDir(freshDir);
  }

  // A database previously migrated only through 0011.
  const upgradeDir = makeScratchDir("supervisor-migration-0012-upgrade");
  const priorMigrationsDir = fs.mkdtempSync(path.join(upgradeDir, "prior-migrations-"));
  try {
    const allFiles = migrationFiles();
    const priorFiles = allFiles.filter((f) => parseInt(f.match(/^(\d+)_/)[1], 10) <= 11);
    assert.ok(priorFiles.length > 0 && priorFiles.length < allFiles.length, "expected some but not all migrations to predate 0012");
    for (const f of priorFiles) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(priorMigrationsDir, f));
    }

    const dbPath = path.join(upgradeDir, "upgrade.sqlite3");
    const rawDb = new Database(dbPath);
    rawDb.pragma("busy_timeout = 5000");
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    const priorResult = applyMigrations(rawDb, { dir: priorMigrationsDir });
    assert.equal(priorResult.appliedTo, 11, `expected to land on version 11, got ${priorResult.appliedTo}`);
    assert.ok(!columns(rawDb, "resource_leases").includes("release_reason"), "sanity: not present before 0012");

    const upgradeResult = applyMigrations(rawDb);
    assert.equal(upgradeResult.appliedFrom, 11);
    assert.equal(upgradeResult.appliedTo, latestMigrationVersion());
    assert.ok(upgradeResult.applied.some((f) => f.startsWith("0012_")), `expected 0012 to apply, applied: ${upgradeResult.applied.join(", ")}`);
    assert.ok(columns(rawDb, "resource_leases").includes("release_reason"), "0012 must add release_reason on upgrade from 0011");

    rawDb.close();
    const db2 = openDb({ stateDir: upgradeDir });
    assert.equal(getSchemaVersion(db2), latestMigrationVersion());
    closeDb(db2);
  } finally {
    rmScratchDir(upgradeDir);
  }
});
