// _concurrent-startup-child.js — spawned as a separate OS process by
// concurrent-startup.test.js. Unlike _concurrent-writer-child.js, this child opens a
// state dir that is NOT pre-migrated: every child races every other child through
// `journal_mode = WAL` and through applyMigrations() on the same fresh database. That
// is the exact condition the two Group 1 blocking migration bugs needed.
//
// Prints one JSON line describing what it observed, so the parent can assert on which
// child actually applied the migration. Exits 0 on success, non-zero on any failure.

import fs from "node:fs";
import { openDb, closeDb } from "../index.js";
import { getSchemaVersion } from "../migrate.js";

const [, , stateDir, childIndex, barrierPath] = process.argv;

// Start barrier: process spawn is staggered by tens of milliseconds, which is enough
// for the children to file politely through openDb() one at a time and never collide.
// Spin (not sleep) on a sentinel file the parent creates once every child is up, so all
// of them enter openDb() within the same millisecond or two.
if (barrierPath) {
  fs.writeFileSync(`${barrierPath}.ready.${childIndex}`, "");
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(barrierPath)) {
    if (Date.now() > deadline) throw new Error(`child ${childIndex}: start barrier never appeared`);
  }
}

// Deliberately short: a busy_timeout long enough to hide a serialization bug behind
// retries would defeat the point. 10s is only there to absorb the legitimate wait
// while another child holds the write lock for one small DDL script.
const db = openDb({ stateDir, busyTimeoutMs: 10000 });

const version = getSchemaVersion(db);
if (version < 1) {
  throw new Error(`child ${childIndex}: expected schema_version >= 1 after openDb, got ${version}`);
}

// The schema must be usable from this connection, not merely "present according to
// schema_version" -- a child that lost the migration race must still see real tables.
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((r) => r.name);
for (const required of ["runs", "event_log", "asks", "schema_version"]) {
  if (!tables.includes(required)) {
    throw new Error(`child ${childIndex}: table "${required}" missing after openDb; have ${tables.join(",")}`);
  }
}

const result = db.__migrationResult;
closeDb(db);

process.stdout.write(
  `${JSON.stringify({
    childIndex: Number(childIndex),
    pid: process.pid,
    version,
    applied: result.applied,
    appliedFrom: result.appliedFrom,
    appliedTo: result.appliedTo,
  })}\n`,
);
