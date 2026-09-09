// concurrent-write.test.js — proves concurrent writers never tear a record.
//
// Spawns NUM_PROCESSES real, separate OS processes (not just interleaved promises
// inside one process -- better-sqlite3 is synchronous, so within one process there is
// no actual concurrency to prove anything with) that all open the *same* SQLite file
// concurrently and hammer event_log + runs with real inserts/updates. WAL mode plus a
// busy_timeout means writers block-and-retry on SQLITE_BUSY rather than erroring or
// silently losing a write. After all children exit, the parent verifies: (a) every
// expected row actually landed (no lost writes), (b) no row is partially written /
// has a NULL required column (no torn records), (c) SQLite's own integrity_check
// passes.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { openDb, closeDb } from "../index.js";
import { makeScratchDir, rmScratchDir, openSeededDb, runTest } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = path.join(__dirname, "_concurrent-writer-child.js");

const NUM_PROCESSES = 8;
const INSERTS_PER_PROCESS = 250;

function runChild(stateDir, index) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD_SCRIPT, stateDir, String(index), String(INSERTS_PER_PROCESS)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => {
      if (code === 0) resolve({ index, stdout, stderr });
      else reject(new Error(`child ${index} exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
    child.on("error", reject);
  });
}

await runTest("concurrent-write", async () => {
  const stateDir = makeScratchDir("supervisor-concurrent-write-test");
  try {
    // Parent seeds the schema + FK rows first so children never race on migrations.
    const seedDb = openSeededDb(stateDir);
    closeDb(seedDb);

    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: NUM_PROCESSES }, (_, i) => runChild(stateDir, i)),
    );
    const elapsedMs = Date.now() - started;
    for (const r of results) process.stdout.write(r.stdout);
    console.log(`\n${NUM_PROCESSES} concurrent processes finished in ${elapsedMs}ms`);

    const db = openDb({ stateDir });

    const integrity = db.pragma("integrity_check");
    console.log("PRAGMA integrity_check:", integrity);
    assert.equal(integrity.length, 1, "integrity_check should return exactly one row when ok");
    assert.equal(integrity[0].integrity_check, "ok", `db failed integrity_check: ${JSON.stringify(integrity)}`);

    const expectedEvents = NUM_PROCESSES * INSERTS_PER_PROCESS;
    const actualEvents = db.prepare("SELECT COUNT(*) AS n FROM event_log").get().n;
    console.log(`event_log rows: expected ${expectedEvents}, actual ${actualEvents}`);
    assert.equal(actualEvents, expectedEvents, "no concurrent write may be lost");

    const actualRuns = db.prepare("SELECT COUNT(*) AS n FROM runs").get().n;
    console.log(`runs rows (excluding seed): ${actualRuns}`);
    assert.equal(actualRuns, NUM_PROCESSES, "each child process's run row must exist exactly once");

    // No torn records: every event_log row must have all its required columns set --
    // a genuinely torn write (partial row) would show up as an unexpected NULL here.
    const tornEvents = db
      .prepare(
        `SELECT COUNT(*) AS n FROM event_log WHERE run_id IS NULL OR tier IS NULL OR type IS NULL OR ts IS NULL`,
      )
      .get().n;
    console.log(`torn event_log rows (should be 0): ${tornEvents}`);
    assert.equal(tornEvents, 0, "found a torn event_log row (a required column was NULL)");

    const tornRuns = db
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE run_id IS NULL OR worker_id IS NULL OR harness_id IS NULL OR started_at IS NULL`)
      .get().n;
    assert.equal(tornRuns, 0, "found a torn runs row");

    // Every run must have ended cleanly (endRun ran to completion in its child) and
    // must have exactly INSERTS_PER_PROCESS events attributed to it -- proves rows
    // from different processes never got cross-attributed to the wrong run_id under
    // concurrent access.
    const perRunCounts = db
      .prepare(
        `SELECT r.run_id AS runId, r.exit_reason AS exitReason, COUNT(e.seq) AS eventCount
         FROM runs r LEFT JOIN event_log e ON e.run_id = r.run_id
         WHERE r.run_id LIKE 'run-child-%'
         GROUP BY r.run_id`,
      )
      .all();
    console.log("per-run event counts:", perRunCounts);
    for (const row of perRunCounts) {
      assert.equal(row.exitReason, "completed", `run ${row.runId} did not end cleanly`);
      assert.equal(row.eventCount, INSERTS_PER_PROCESS, `run ${row.runId} has ${row.eventCount} events, expected ${INSERTS_PER_PROCESS}`);
    }

    closeDb(db);
  } finally {
    rmScratchDir(stateDir);
  }
});
