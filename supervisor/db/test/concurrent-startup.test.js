// concurrent-startup.test.js — regression test for Group 1's two blocking migration
// bugs (review-two/group1-persistence-luna.md):
//
//   1. `journal_mode = WAL` was set BEFORE `busy_timeout`, so two processes opening the
//      same fresh database at once meant one died with SQLITE_BUSY, with no timeout
//      configured yet to absorb the collision.
//   2. The schema_version check and the migration application were not serialized, so
//      two connections could both read "0001 is pending" and both apply it; the loser
//      failed with "table already exists".
//
// concurrent-write.test.js deliberately pre-migrates in the parent (see its line 46),
// so it never exercised this path. Here nothing is pre-created: NUM_PROCESSES separate
// OS processes all race through openDb() on an empty state dir.
//
// Verified to FAIL against the pre-fix code (both fixes reverted): children exit
// non-zero with SQLITE_BUSY / "table already exists".

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { openDb, closeDb } from "../index.js";
import { getSchemaVersion, latestMigrationVersion } from "../migrate.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = path.join(__dirname, "_concurrent-startup-child.js");

const NUM_PROCESSES = 8;
const ROUNDS = 6;

function runChild(stateDir, index, barrierPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD_SCRIPT, stateDir, String(index), barrierPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ index, code, stdout, stderr }));
    child.on("error", (err) => resolve({ index, code: -1, stdout, stderr: String(err) }));
  });
}

/** Wait until every child has reported ready, then release them all at once. */
async function waitForReady(barrierDir, barrierPath) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ready = fs.readdirSync(barrierDir).filter((f) => f.includes(".ready.")).length;
    if (ready === NUM_PROCESSES) break;
    if (Date.now() > deadline) throw new Error(`only ${ready}/${NUM_PROCESSES} children reported ready`);
    await new Promise((r) => setTimeout(r, 5));
  }
  fs.writeFileSync(barrierPath, "");
}

await runTest("concurrent-startup", async () => {
  // A race needs more than one attempt to be trusted: a single passing round could be
  // luck in scheduling. Each round is a brand-new empty state dir.
  //
  // Two different arrival patterns, because the two bugs need opposite ones (measured,
  // by reverting each fix in turn):
  //   - barrier rounds release all children in the same millisecond. That reliably
  //     surfaces the unserialized-migration bug (several children read "0001 pending"
  //     together) but *hides* the WAL/busy_timeout bug: they all find a zero-length db
  //     file, and converting an empty file to WAL needs no contended lock.
  //   - staggered rounds let spawn latency space the children out, so later ones arrive
  //     while an earlier one already holds locks on a non-empty file -- which is exactly
  //     what makes `journal_mode = WAL` return SQLITE_BUSY.
  for (let round = 0; round < ROUNDS; round++) {
    const useBarrier = round % 2 === 1;
    const stateDir = makeScratchDir(`supervisor-concurrent-startup-test-r${round}`);
    try {
      // Nothing is pre-created. Not even the db file: the children race to create,
      // WAL-ify, and migrate it.
      assert.equal(fs.readdirSync(stateDir).length, 0, "state dir must start empty");

      // Barrier lives outside stateDir so the emptiness assertion above stays honest.
      const barrierDir = useBarrier ? makeScratchDir(`supervisor-concurrent-startup-barrier-r${round}`) : null;
      const barrierPath = barrierDir ? path.join(barrierDir, "go") : "";
      const pending = Array.from({ length: NUM_PROCESSES }, (_, i) => runChild(stateDir, i, barrierPath));
      if (barrierDir) await waitForReady(barrierDir, barrierPath);
      const results = await Promise.all(pending);
      if (barrierDir) rmScratchDir(barrierDir);

      const failed = results.filter((r) => r.code !== 0);
      if (failed.length > 0) {
        const detail = failed
          .map((r) => `child ${r.index} exited ${r.code}\nstderr:\n${r.stderr.trim()}`)
          .join("\n---\n");
        assert.fail(
          `round ${round} (${useBarrier ? "barrier" : "staggered"}): ${failed.length}/${NUM_PROCESSES} children failed to open the database concurrently\n${detail}`,
        );
      }

      const reports = results.map((r) => JSON.parse(r.stdout.trim()));
      const arrival = useBarrier ? "barrier" : "staggered";
      console.log(`round ${round} (${arrival}): all ${NUM_PROCESSES} children opened the fresh db successfully`);
      console.log(
        reports
          .map((rep) => `  child ${rep.childIndex} (pid ${rep.pid}) version=${rep.version} applied=[${rep.applied.join(",")}]`)
          .join("\n"),
      );

      // Exactly one child may actually apply 0001; the others must observe it already
      // applied and skip it. Two "applied" reports would mean the DDL ran twice.
      const latest = latestMigrationVersion();
      const appliers = reports.filter((rep) => rep.applied.includes("0001_initial.sql"));
      assert.equal(
        appliers.length,
        1,
        `exactly one child may apply 0001_initial.sql, but ${appliers.length} did: ${JSON.stringify(appliers)}`,
      );
      for (const rep of reports) {
        assert.equal(rep.appliedTo, latest, `child ${rep.childIndex} should end at schema version ${latest}`);
      }

      // And the resulting database must be a single sane copy of the schema, not a
      // doubly-applied one.
      const db = openDb({ stateDir });
      try {
        const integrity = db.pragma("integrity_check");
        assert.equal(integrity[0].integrity_check, "ok", `integrity_check failed: ${JSON.stringify(integrity)}`);
        assert.equal(getSchemaVersion(db), latest, `final schema version must be ${latest}`);
        for (let v = 1; v <= latest; v++) {
          const versionRows = db.prepare("SELECT COUNT(*) AS n FROM schema_version WHERE version = ?").get(v).n;
          assert.equal(versionRows, 1, `migration ${v} must be recorded exactly once, found ${versionRows} schema_version rows`);
        }
        assert.equal(db.pragma("journal_mode", { simple: true }), "wal", "db must have ended up in WAL mode");
      } finally {
        closeDb(db);
      }
    } finally {
      rmScratchDir(stateDir);
    }
  }
});
