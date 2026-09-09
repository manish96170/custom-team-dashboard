// asks-round-trip.test.js — migration 0004: `asks` gains what a real harness round trip
// needs (correlation id, kind, structured payload, answered-vs-delivered), and `task_id`
// becomes nullable.
//
// The case that matters most is case 1: 0004 is a TABLE REBUILD, not an ALTER, because
// SQLite cannot change a column's nullability. A rebuild that silently loses rows, drops an
// index, or leaves foreign keys dangling would be a much worse bug than the gap it closes,
// and none of that is visible on a fresh database — only on the upgrade path. So this test
// builds a database at version 3, puts real ask rows in it, and only then applies 0004.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, closeDb, upsertHarness, createTask, createWorker } from "../index.js";
import { applyMigrations, getSchemaVersion, latestMigrationVersion, MIGRATIONS_DIR } from "../migrate.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const nowIso = () => new Date().toISOString();

/** A migrations dir holding everything EXCEPT 0004, so we can build a real v3 database. */
/**
 * A migrations directory holding everything that came BEFORE 0004.
 *
 * "Before 0004", not "everything except 0004". The first version of this filtered out only the
 * 0004 file, which was indistinguishable from the intent while 0004 was the newest migration --
 * and then 0005 landed, the "pre-0004" database came up at version 5, and this test failed for a
 * reason that had nothing to do with 0004. The test was right to fail; the filter was wrong.
 */
function migrationsDirBefore0004() {
  const dir = makeScratchDir("asks-round-trip-pre0004");
  for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
    const version = Number(file.match(/^(\d+)_/)?.[1]);
    if (!Number.isInteger(version) || version >= 4) continue;
    fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
  }
  return dir;
}

/**
 * Seed rows in the SHAPE THEY HAD AT VERSION 3, with raw SQL rather than through
 * `createAsk`/`answerAsk`.
 *
 * That is not fussiness: those functions write the post-0004 columns, so using them here
 * would test the migration against rows only the new code could ever have produced — and this
 * test's whole purpose is the rows written before it existed. (The first version of this file
 * did use them, and broke the moment `createAsk` was updated, which is the test doing its job.)
 */
function seedV3RunAndAsks(db, stateDir) {
  upsertHarness(db, { id: "h", displayName: "Harness" });
  createTask(db, { id: "t1", title: "T", type: "code", source: "test" });
  createWorker(db, { workerId: "w1", nickname: "Purus", role: "coder", taskId: "t1", cwd: stateDir });
  db.prepare("INSERT INTO runs (run_id, worker_id, harness_id, started_at) VALUES ('r1','w1','h',?)").run(nowIso());

  const insert = db.prepare(
    `INSERT INTO asks (id, run_id, task_id, question, answer, answered_by, delivered_at, resolved, created_at)
     VALUES (?, 'r1', 't1', ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("a-open", "still open?", null, null, null, 0, nowIso());
  // A v3 "answered" ask: the answer timestamp lived in `delivered_at`, which is exactly the
  // conflation 0004 undoes.
  insert.run("a-done", "already answered?", "yes", "human", nowIso(), 1, nowIso());
  // A v3 ask the SUPERVISOR closed. The two must not be backfilled the same way — see case 1.
  insert.run("a-swept", "nobody answered?", "[closed by supervisor: run-completed]", "supervisor:auto-close", nowIso(), 1, nowIso());
}

await runTest("asks round-trip migration (0004)", async () => {
  const scratch = makeScratchDir("asks-round-trip");
  const preDir = migrationsDirBefore0004();

  try {
    // ── 1. The upgrade path, over a database that already holds ask rows ────────────
    const dbPath = path.join(scratch, "state.db");
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    applyMigrations(db, { dir: preDir });
    assert.equal(getSchemaVersion(db), 3, "the pre-0004 database really is at version 3");

    seedV3RunAndAsks(db, scratch);
    const before = new Map(db.prepare("SELECT * FROM asks").all().map((r) => [r.id, r]));

    const result = applyMigrations(db);
    // Every migration from 0004 onward is pending here, and 0004 must be among them. Pinning this
    // to exactly ["0004_..."] would make every future migration fail this assertion for no reason.
    assert.ok(result.applied.includes("0004_asks_round_trip.sql"), `0004 was pending; applied ${result.applied}`);
    assert.equal(result.applied[0], "0004_asks_round_trip.sql", "and it was applied first, in order");
    assert.equal(getSchemaVersion(db), latestMigrationVersion(), "and the database is now current");

    const after = new Map(db.prepare("SELECT * FROM asks").all().map((r) => [r.id, r]));
    assert.equal(after.size, 3, "every row survived the rebuild");

    const open = after.get("a-open");
    assert.equal(open.kind, "question", "an existing ask is a plain question");
    assert.equal(open.resolved, 0, "and it is still open");
    assert.equal(open.decision, null, "an open ask has no decision yet");
    assert.equal(open.question, "still open?", "its text is intact");

    const done = after.get("a-done");
    assert.equal(done.resolved, 1);
    assert.equal(done.answer, "yes", "the answer text survived");
    assert.equal(done.answered_by, "human");
    // Corrected after review: the first version of this migration wrote 'closed' for EVERY
    // resolved row, which relabelled a real human answer as a supervisor close and destroyed the
    // one distinction the column exists to record. `answered_by LIKE 'supervisor:%'` is the
    // discriminator, because the supervisor's own closers are its only writers.
    assert.equal(done.decision, "answered", "a human's historical answer is backfilled as answered, not closed");
    const swept = after.get("a-swept");
    assert.equal(swept.decision, "closed", "a supervisor auto-close is backfilled as closed");
    assert.equal(swept.answered_by, "supervisor:auto-close", "and keeps its attribution");
    // The point of splitting the two columns: the old `delivered_at` was really the answer
    // timestamp, so it moves to `answered_at`, and `delivered_at` becomes honest.
    assert.equal(done.answered_at, before.get("a-done").delivered_at, "old delivered_at became answered_at");
    assert.equal(done.delivered_at, null, "nothing was ever delivered to a harness, so delivered_at is NULL");

    console.log(
      `  1. upgraded v3 -> v${latestMigrationVersion()} with 3 ask rows intact; old delivered_at moved to answered_at, and a human answer backfilled as "answered" while a supervisor close backfilled as "closed"`,
    );

    // ── 2. A rebuild must not leave the schema damaged ──────────────────────────────
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "no foreign-key violations after the rebuild");
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok", "integrity_check ok after the rebuild");

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='asks'")
      .all()
      .map((r) => r.name);
    // The first four existed before 0004 and are dropped WITH the old table, so a rebuild
    // that forgets to recreate them is a silent performance regression on the sweep.
    for (const want of [
      "idx_asks_task_id",
      "idx_asks_run_id",
      "idx_asks_resolved",
      "idx_asks_auto_close",
      "idx_asks_pending",
      "idx_asks_undelivered",
      "idx_asks_harness_request",
    ]) {
      assert.ok(indexes.includes(want), `index ${want} is missing (have: ${indexes.join(", ")})`);
    }
    console.log(`  2. integrity ok, no FK violations, all ${indexes.length} indexes present after the rebuild`);

    // ── 3. task_id is nullable now, which is the reason for the rebuild ─────────────
    // The supervisor sees a parked request on a RUN and must record it. Before this it had
    // to invent a task id to satisfy NOT NULL.
    db.prepare(
      `INSERT INTO asks (id, run_id, task_id, kind, question, created_at) VALUES ('a-notask','r1',NULL,'tool-approval','may I run this?',?)`,
    ).run(nowIso());
    assert.equal(db.prepare("SELECT task_id FROM asks WHERE id='a-notask'").get().task_id, null);
    console.log("  3. an ask can be recorded against a run with no task at all");

    // ── 4. One ask per parked harness request, PER GENERATION ───────────────────────
    // The pump re-delivers events by design (eviction is never silent), so two rows for one live
    // parked request would mean answering one and leaving the other open forever, pointing at a
    // request the harness has already settled.
    const askInsert = (id, runId, requestId, generation) =>
      db
        .prepare(
          `INSERT INTO asks (id, run_id, kind, question, harness_request_id, generation, created_at)
           VALUES (?, ?, 'tool-approval', 'q', ?, ?, ?)`,
        )
        .run(id, runId, requestId, generation, nowIso());

    askInsert("a-p1", "r1", "req-1", 1);
    assert.throws(
      () => askInsert("a-p2", "r1", "req-1", 1),
      /UNIQUE/,
      "a second ask for the same parked request IN THE SAME GENERATION must be refused",
    );

    // A LATER generation of the same run reusing the id is legitimate and must be allowed. This is
    // the defect the review found: keyed on (run_id, harness_request_id) alone, the index reserved
    // an id for the whole life of a logical run, so a resumed process reusing it got no ask row at
    // all and its worker stayed parked forever with nothing to answer.
    askInsert("a-p1-gen2", "r1", "req-1", 2);

    // ...and the guard is per run, not global: two runs may legitimately be handed the same
    // request id by two independent harness processes.
    db.prepare("INSERT INTO runs (run_id, worker_id, harness_id, started_at) VALUES ('r2','w1','h',?)").run(nowIso());
    askInsert("a-p3", "r2", "req-1", 1);

    // A NULL generation must STILL be guarded. SQLite treats NULLs as distinct in a unique index,
    // so the key is on COALESCE(generation, -1) — without that, the rows least likely to have been
    // written carefully would be the only ones with no protection at all.
    askInsert("a-nogen", "r1", "req-nogen", null);
    assert.throws(
      () => askInsert("a-nogen2", "r1", "req-nogen", null),
      /UNIQUE/,
      "two asks with a request id and NO generation must still collide",
    );
    console.log(
      "  4. per generation: same generation refused, later generation allowed, other run allowed, NULL generations still guarded",
    );

    db.close();

    // ── 5. A database built from scratch lands on the same shape ────────────────────
    // A rebuild migration is the easiest way to end up with two different schemas depending
    // on whether a database is old or new, which is the bug that outlives the migration.
    const freshDir = makeScratchDir("asks-round-trip-fresh");
    const fresh = openDb({ stateDir: freshDir });
    const cols = fresh.prepare("PRAGMA table_info(asks)").all();
    const names = cols.map((c) => c.name);
    for (const want of [
      "kind",
      "payload_json",
      "harness_request_id",
      "harness_tool_use_id",
      "generation",
      "answer_json",
      "decision",
      "answered_at",
      "delivery_error",
      "delivery_abandoned_at",
    ]) {
      assert.ok(names.includes(want), `a fresh database is missing column ${want}`);
    }
    assert.equal(cols.find((c) => c.name === "task_id").notnull, 0, "task_id is nullable on a fresh database too");
    assert.equal(cols.find((c) => c.name === "run_id").notnull, 1, "run_id is still required — an ask belongs to a run");
    closeDb(fresh);
    rmScratchDir(freshDir);
    console.log("  5. a from-scratch database has the identical asks shape");
  } finally {
    rmScratchDir(preDir);
    rmScratchDir(scratch);
  }
});
