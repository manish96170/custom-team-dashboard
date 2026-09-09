// wal-conversion.test.js — deterministic regression test for the first of Group 1's two
// blocking migration bugs (review-two/group1-persistence-luna.md finding 1): openDb()
// failing with SQLITE_BUSY when another process has the same database open.
//
// concurrent-startup.test.js covers the same bug, but only probabilistically -- with the
// serialization fix in place it reproduces the WAL collision on roughly one run in six.
// This test removes the race entirely: a helper process holds an open write transaction
// on a non-WAL database for a known window, and the parent calls openDb() into it. The
// WAL conversion *must* fail at first (SQLite does not run the busy handler for a
// journal-mode change), so the only way to pass is to retry until the holder lets go.
//
// Verified to FAIL against the pre-fix code (a bare `db.pragma("journal_mode = WAL")`
// with no retry): SQliteError: database is locked, every single run.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { openDb, closeDb } from "../index.js";
import { defaultDbPath } from "../paths.js";
import { latestMigrationVersion } from "../migrate.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOLDER_SCRIPT = path.join(__dirname, "_wal-holder-child.js");

const HOLD_MS = 800;

/** Spawn the holder and resolve once it reports that its transaction is open. */
function startHolder(dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOLDER_SCRIPT, dbPath, String(HOLD_MS)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const exited = new Promise((resolveExit) => {
      child.on("exit", (code) => resolveExit({ code, stdout, stderr }));
    });
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.includes("holding")) resolve({ child, exited, stderrOf: () => stderr });
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`holder exited (${code}) before holding\nstderr:\n${stderr}`)));
  });
}

await runTest("wal-conversion", async () => {
  const stateDir = makeScratchDir("supervisor-wal-conversion-test");
  try {
    const dbPath = defaultDbPath(stateDir);
    const holder = await startHolder(dbPath);

    // openDb() is synchronous and will block this process while it retries. That is the
    // intended behavior: a supervisor starting up while another one is mid-write should
    // wait for its turn, not crash.
    const started = Date.now();
    const db = openDb({ stateDir, busyTimeoutMs: 5000 });
    const elapsedMs = Date.now() - started;
    console.log(`openDb() succeeded after waiting ${elapsedMs}ms for the holder's transaction`);

    try {
      assert.equal(db.pragma("journal_mode", { simple: true }), "wal", "db must be in WAL mode after openDb");
      assert.equal(db.__migrationResult.appliedTo, latestMigrationVersion(), "migrations must have run");
      // Proof that it really did have to wait rather than sailing through: the holder
      // held its transaction for HOLD_MS from before openDb() was called.
      assert.ok(
        elapsedMs >= HOLD_MS * 0.5,
        `openDb() returned in ${elapsedMs}ms, too fast to have waited for the ${HOLD_MS}ms holder -- the contention this test relies on did not happen`,
      );
      // The holder's own table survived the conversion: retrying WAL mode must not have
      // clobbered or recreated the database.
      const probe = db.prepare("SELECT COUNT(*) AS n FROM holder_probe").get().n;
      assert.equal(probe, 1, `holder's committed row must survive the WAL conversion, found ${probe}`);
    } finally {
      closeDb(db);
    }

    const holderResult = await holder.exited;
    assert.equal(holderResult.code, 0, `holder exited ${holderResult.code}\nstderr:\n${holderResult.stderr}`);
  } finally {
    rmScratchDir(stateDir);
  }
});
