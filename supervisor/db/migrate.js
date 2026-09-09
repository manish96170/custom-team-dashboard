// migrate.js — the migrations story from row one.
//
// Mechanism: a migrations/ folder with numbered *.sql files (0001_initial.sql,
// 0002_..., ...), a schema_version table tracking the highest applied version, and
// applyMigrations(db) that applies whatever's pending, in order, each inside its own
// transaction. A second migration later is "add a file" -- nothing else in this module
// needs to change.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function ensureVersionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

function currentVersion(db) {
  ensureVersionTable(db);
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
  return row && row.v != null ? row.v : 0;
}

function loadMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const migrations = files.map((file) => {
    const m = file.match(/^(\d+)_/);
    if (!m) {
      throw new Error(
        `migration file "${file}" must be prefixed with a zero-padded numeric version, e.g. "0002_add_thing.sql"`,
      );
    }
    return {
      version: parseInt(m[1], 10),
      file,
      sql: fs.readFileSync(path.join(dir, file), "utf8"),
    };
  });
  migrations.sort((a, b) => a.version - b.version);
  // catch duplicate version numbers -- two files claiming "0002" is a footgun we can
  // detect cheaply instead of applying whichever one readdir happened to list first.
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].version === migrations[i - 1].version) {
      throw new Error(
        `duplicate migration version ${migrations[i].version}: "${migrations[i - 1].file}" and "${migrations[i].file}"`,
      );
    }
  }
  return migrations;
}

/**
 * Apply every migration in MIGRATIONS_DIR whose version is greater than the database's
 * current schema_version. Each migration runs inside its own transaction: its DDL plus
 * the schema_version insert either both land or neither does.
 *
 * Concurrency: safe to call from several processes opening the same database at once.
 * Bug found by independent code review (2026-09-05): the version check and the
 * application used to be separate, unserialized steps, so two connections could both
 * read "version 0, migration 0001 is pending" and both try to apply it -- the loser
 * failing with "table already exists". Each migration now runs inside a BEGIN
 * IMMEDIATE transaction that takes the write lock BEFORE re-reading schema_version, so
 * the loser blocks on the lock (absorbed by the connection's busy_timeout, which
 * openDb() sets first for exactly this reason), then re-reads inside its own
 * transaction, sees the migration already applied, and skips it.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ dir?: string }} [opts]
 * @returns {{ appliedFrom: number, appliedTo: number, applied: string[] }}
 */
export function applyMigrations(db, opts = {}) {
  const dir = opts.dir || MIGRATIONS_DIR;
  ensureVersionTable(db);
  const startVersion = currentVersion(db);
  const migrations = loadMigrations(dir);
  const pending = migrations.filter((m) => m.version > startVersion);

  const applied = [];
  for (const m of pending) {
    const runMigration = db.transaction(() => {
      // Re-check under the write lock: another process may have applied this while we
      // were queued behind it.
      if (currentVersion(db) >= m.version) return false;
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
      return true;
    });
    if (runMigration.immediate()) applied.push(m.file);
  }

  return {
    appliedFrom: startVersion,
    appliedTo: currentVersion(db),
    applied,
  };
}

export function getSchemaVersion(db) {
  return currentVersion(db);
}

/**
 * Highest version present on disk — i.e. what a fully-migrated database should report.
 * Tests derive their expectation from this rather than hardcoding a number, so adding a
 * migration doesn't require editing every test that asserts "we're up to date".
 */
export function latestMigrationVersion(dir = MIGRATIONS_DIR) {
  const migrations = loadMigrations(dir);
  return migrations.length ? migrations[migrations.length - 1].version : 0;
}

/** Filenames in apply order. Useful for asserting *which* migrations a caller applied. */
export function migrationFiles(dir = MIGRATIONS_DIR) {
  return loadMigrations(dir).map((m) => m.file);
}
