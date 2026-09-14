// migration-0017-to-0018.test.js — Phase 12 (Release hardening), ROADMAP.md's "migration testing"
// checklist item. Migrations 0017 (`worktree_claim_op_and_stamp`) and 0018 (`requests_thread_ts`) — both
// added this session — had only the generic fresh-database check in `migrations.test.js`, never a
// POPULATED-database upgrade test, the same gap finding 47 (`review-sol-2026-09-13.md`) already found
// and closed for 0013-0016. Same pattern as `migration-0013-to-0016.test.js`: real pre-existing rows at
// schema version 16, upgraded to latest, checked for the documented (NULL, no backfill) outcome.
//
// Cases:
//   1. a database populated at schema version 0016 upgrades cleanly to latest
//   2. the pre-existing task row gets NULL worktree_claim_op/worktree_claim_at (0017) — no backfill,
//      not a guessed value
//   3. the pre-existing requests row gets NULL thread_ts (0018) — same reasoning
//   4. PRAGMA integrity_check reports ok after the full upgrade

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

await runTest("migration-0017-to-0018", async () => {
  const upgradeDir = makeScratchDir("supervisor-migration-0017-to-0018-upgrade");
  const priorMigrationsDir = fs.mkdtempSync(path.join(upgradeDir, "prior-migrations-"));
  try {
    const allFiles = migrationFiles();
    const priorFiles = allFiles.filter((f) => parseInt(f.match(/^(\d+)_/)[1], 10) <= 16);
    assert.ok(priorFiles.length > 0 && priorFiles.length < allFiles.length, "expected some but not all migrations to predate 0017");
    for (const f of priorFiles) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(priorMigrationsDir, f));
    }

    const dbPath = path.join(upgradeDir, "upgrade.sqlite3");
    const rawDb = new Database(dbPath);
    rawDb.pragma("busy_timeout = 5000");
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    const priorResult = applyMigrations(rawDb, { dir: priorMigrationsDir });
    assert.equal(priorResult.appliedTo, 16, `expected to land on version 16, got ${priorResult.appliedTo}`);
    assert.ok(!columns(rawDb, "tasks").includes("worktree_claim_op"), "sanity: tasks.worktree_claim_op must not exist yet at version 16");
    assert.ok(!columns(rawDb, "requests").includes("thread_ts"), "sanity: requests.thread_ts must not exist yet at version 16");

    // Populate REAL rows at v16, in v16's own shape.
    const nowIso = new Date().toISOString();
    rawDb.prepare(
      `INSERT INTO tasks (id, title, type, state, created_at, updated_at) VALUES ('task-pre-0017', 'pre-existing task', 'feature', 'created', ?, ?)`,
    ).run(nowIso, nowIso);
    rawDb.prepare(
      `INSERT INTO requests (id, type, channel, mentioned_handle, raw_text, slack_permalink, posted_by, status, created_at, updated_at)
       VALUES ('req-pre-0018', 'review', '#team', '@bot', 'please review', 'https://slack.example/p/1', 'U123', 'pending', ?, ?)`,
    ).run(nowIso, nowIso);

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    const upgradeResult = applyMigrations(rawDb);
    assert.equal(upgradeResult.appliedFrom, 16);
    assert.equal(upgradeResult.appliedTo, latestMigrationVersion());
    for (const v of [17, 18]) {
      assert.ok(upgradeResult.applied.some((f) => f.startsWith(`00${v}_`)), `expected migration ${v} to apply, applied: ${upgradeResult.applied.join(", ")}`);
    }
    console.log("  1. a database populated at schema version 0016 upgrades cleanly to latest");

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    const taskCols = columns(rawDb, "tasks");
    for (const col of ["worktree_claim_op", "worktree_claim_at"]) {
      assert.ok(taskCols.includes(col), `expected tasks.${col} to exist after upgrade, have: ${taskCols.join(", ")}`);
    }
    const preExistingTask = rawDb.prepare(`SELECT worktree_claim_op, worktree_claim_at FROM tasks WHERE id = 'task-pre-0017'`).get();
    assert.equal(preExistingTask.worktree_claim_op, null, "a task predating the claim-op distinction entirely must have NULL worktree_claim_op, never a guessed value");
    assert.equal(preExistingTask.worktree_claim_at, null, "same for worktree_claim_at (0017) — NULL, not a guessed timestamp");
    console.log("  2. the pre-existing task row gets NULL worktree_claim_op/worktree_claim_at, never guessed values");

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    const requestCols = columns(rawDb, "requests");
    assert.ok(requestCols.includes("thread_ts"), `expected requests.thread_ts to exist after upgrade, have: ${requestCols.join(", ")}`);
    const preExistingRequest = rawDb.prepare(`SELECT thread_ts, channel FROM requests WHERE id = 'req-pre-0018'`).get();
    assert.equal(preExistingRequest.thread_ts, null, "a request predating thread_ts entirely must have it NULL, never a guessed value");
    assert.equal(preExistingRequest.channel, "#team", "the pre-existing channel value must be untouched by the upgrade");
    console.log("  3. the pre-existing requests row gets NULL thread_ts, never a guessed value, and its real channel is untouched");

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    const integrity = rawDb.prepare("PRAGMA integrity_check").all();
    assert.deepEqual(integrity, [{ integrity_check: "ok" }], `expected integrity_check ok after the full upgrade, got: ${JSON.stringify(integrity)}`);
    console.log("  4. PRAGMA integrity_check reports ok after the full 0016 -> latest upgrade with real pre-existing data");

    rawDb.close();
    const db2 = openDb({ stateDir: upgradeDir });
    assert.equal(getSchemaVersion(db2), latestMigrationVersion());
    closeDb(db2);
  } finally {
    rmScratchDir(upgradeDir);
  }
});
