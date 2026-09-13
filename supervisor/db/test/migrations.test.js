// migrations.test.js — proves the migrations mechanism: schema_version tracks what's
// applied, applying twice is a no-op the second time, and every table Group 1 is
// responsible for actually exists after migration.

import assert from "node:assert/strict";
import { openDb, closeDb } from "../index.js";
import { applyMigrations, getSchemaVersion, latestMigrationVersion, migrationFiles } from "../migrate.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const EXPECTED_TABLES = [
  "schema_version",
  "harnesses",
  "teams",
  "workers",
  "runs",
  "tasks",
  "asks",
  "requests",
  "integrations",
  "event_log",
  "transition_journal",
  "outbox",
  // migration 0003: the orphan sightings journal (a log, not a second source of truth).
  "orphan_sightings",
  // migration 0010: capability-based authorization.
  "principals",
  "agent_journal",
  "sensitive_approvals",
  // migration 0011: resource leases (PLAN.md section 20) and MCP server pooling (section 21).
  "resource_leases",
  "mcp_pool",
  // review-sol-2026-09-13.md finding 47: migration 0013 added a whole new TABLE this list never
  // named — the per-attachment refcount table `mcp_pool.status`/`.pgid` alone can't derive from.
  "mcp_pool_attachments",
];

await runTest("migrations", async () => {
  const stateDir = makeScratchDir("supervisor-migrations-test");
  try {
    const db = openDb({ stateDir });

    // Derived, not hardcoded: adding a migration must not require editing this test.
    const expectedVersion = latestMigrationVersion();
    const version = getSchemaVersion(db);
    assert.equal(version, expectedVersion, `expected schema_version ${expectedVersion} after initial open, got ${version}`);
    console.log(`migrations on disk: ${migrationFiles().join(", ")} (latest version ${expectedVersion})`);

    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    console.log("tables present:", tableRows);

    for (const t of EXPECTED_TABLES) {
      assert.ok(tableRows.includes(t), `expected table "${t}" to exist, present tables: ${tableRows.join(", ")}`);
    }

    // 0002's columns must be present on runs -- reconciliation and reap are unbuildable
    // without proc_lstart (the pid-reuse guard) and cwd (which pooled server to dispose).
    const runsColumns = db.prepare("SELECT name FROM pragma_table_info('runs')").all().map((r) => r.name);
    for (const col of ["proc_lstart", "cwd", "spawn_depth", "reconciled_at"]) {
      assert.ok(runsColumns.includes(col), `expected runs.${col} to exist, have: ${runsColumns.join(", ")}`);
    }
    // 0003's columns: `orphaned-unmanaged` is a lifecycle state on an OPEN row, and reaped_at
    // is what lets history tell a killed orphan from one still running.
    for (const col of ["lifecycle", "reaped_at"]) {
      assert.ok(runsColumns.includes(col), `expected runs.${col} to exist, have: ${runsColumns.join(", ")}`);
    }
    const asksColumns = db.prepare("SELECT name FROM pragma_table_info('asks')").all().map((r) => r.name);
    assert.ok(asksColumns.includes("auto_close_at"), `expected asks.auto_close_at to exist, have: ${asksColumns.join(", ")}`);
    // A row that predates 0003 must come out of the migration as 'managed', not NULL — every
    // query that filters on lifecycle would silently skip NULL rows.
    const lifecycleDefault = db.prepare("SELECT dflt_value AS d FROM pragma_table_info('runs') WHERE name = 'lifecycle'").get();
    assert.match(String(lifecycleDefault.d), /managed/, `lifecycle needs a non-null default, got ${lifecycleDefault.d}`);

    // integrations must ship EMPTY -- never pre-created rows (PLAN.md section 3).
    const integrationsCount = db.prepare("SELECT COUNT(*) AS n FROM integrations").get().n;
    assert.equal(integrationsCount, 0, "integrations table must ship empty");

    // Re-running applyMigrations against an already-migrated db must be a genuine
    // no-op: no new schema_version rows, no error, same reported version.
    const before = db.prepare("SELECT COUNT(*) AS n FROM schema_version").get().n;
    const result = applyMigrations(db);
    const after = db.prepare("SELECT COUNT(*) AS n FROM schema_version").get().n;
    console.log("second applyMigrations() result:", result);
    assert.equal(result.applied.length, 0, "second applyMigrations() call should apply nothing");
    assert.equal(before, after, "schema_version row count must not change on a no-op migration run");
    assert.equal(getSchemaVersion(db), expectedVersion);

    closeDb(db);

    // Re-opening the same db file from scratch (new connection) must also be a no-op
    // and must not throw -- proves migrations are idempotent across process restarts,
    // not just within one open connection.
    const db2 = openDb({ stateDir });
    assert.equal(getSchemaVersion(db2), expectedVersion);
    closeDb(db2);
  } finally {
    rmScratchDir(stateDir);
  }
});
