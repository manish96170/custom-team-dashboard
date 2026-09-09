// _wal-holder-child.js — spawned by wal-conversion.test.js. Opens the given db file in
// its default (non-WAL) journal mode, holds an open write transaction for a fixed
// window, then commits and closes. Prints "holding" on stdout once the transaction is
// actually open, so the parent knows when to race it.
//
// Not a test itself; nothing here should be run directly.

import Database from "better-sqlite3";

const [, , dbPath, holdMsStr] = process.argv;
const holdMs = parseInt(holdMsStr, 10);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
// Deliberately NOT switching to WAL: the point of this child is to be the "other
// connection with an open transaction" that makes someone else's WAL conversion fail.
db.exec("CREATE TABLE IF NOT EXISTS holder_probe (k INTEGER)");

db.transaction(() => {
  db.prepare("INSERT INTO holder_probe (k) VALUES (1)").run();
  process.stdout.write("holding\n");
  sleepSync(holdMs);
}).immediate();

db.close();
process.stdout.write("released\n");
