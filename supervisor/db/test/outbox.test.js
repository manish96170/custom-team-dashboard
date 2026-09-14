// outbox.test.js — `db/index.js`'s outbox primitives (ROADMAP.md Phase 9, Slack outbound, 2026-09-14).
// The `outbox` table itself has existed since migration 0001; nothing wrote to or read from it until
// this pass.
//
// Cases:
//   1. writeOutboxEvent persists a real row, undelivered, with the payload round-tripping through JSON
//   2. listUndeliveredOutboxEvents returns only undelivered rows, oldest first
//   3. markOutboxDelivered flips exactly one row, and a second call on the same id is a harmless no-op
//   4. a null payload round-trips as null, not the string "null" or an empty object

import assert from "node:assert/strict";
import { openDb, closeDb, writeOutboxEvent, listUndeliveredOutboxEvents, markOutboxDelivered } from "../index.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

await runTest("outbox primitives", async () => {
  const stateDir = makeScratchDir("supervisor-outbox-test");
  let db;
  try {
    db = openDb({ stateDir });

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    writeOutboxEvent(db, { id: "ob-1", eventType: "task-approved", payload: { taskId: "t1", title: "Fix the thing" }, now: "2026-01-01T00:00:00.000Z" });
    const row = db.prepare(`SELECT * FROM outbox WHERE id = ?`).get("ob-1");
    assert.ok(row, "the row must actually exist");
    assert.equal(row.event_type, "task-approved");
    assert.equal(row.delivered, 0);
    assert.deepEqual(JSON.parse(row.payload_json), { taskId: "t1", title: "Fix the thing" });
    console.log("  1. writeOutboxEvent persists a real row, undelivered, with the payload round-tripping through JSON");

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    writeOutboxEvent(db, { id: "ob-2", eventType: "task-merged", payload: { taskId: "t2" }, now: "2026-01-01T00:00:01.000Z" });
    writeOutboxEvent(db, { id: "ob-3", eventType: "task-merged", payload: { taskId: "t3" }, now: "2026-01-01T00:00:02.000Z" });
    markOutboxDelivered(db, "ob-2");
    const undelivered = listUndeliveredOutboxEvents(db);
    assert.deepEqual(undelivered.map((e) => e.id), ["ob-1", "ob-3"], "only undelivered rows, oldest first — ob-2 was marked delivered above");
    assert.equal(undelivered[0].eventType, "task-approved");
    assert.deepEqual(undelivered[0].payload, { taskId: "t1", title: "Fix the thing" });
    console.log("  2. listUndeliveredOutboxEvents returns only undelivered rows, oldest first");

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    const first = markOutboxDelivered(db, "ob-1");
    assert.equal(first.updated, true);
    assert.equal(db.prepare(`SELECT delivered FROM outbox WHERE id = 'ob-1'`).get().delivered, 1);
    const second = markOutboxDelivered(db, "ob-1");
    assert.equal(second.updated, false, "marking an already-delivered row again must be a harmless no-op, not an error");
    console.log("  3. markOutboxDelivered flips exactly one row, and a second call on the same id is a harmless no-op");

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    writeOutboxEvent(db, { id: "ob-4", eventType: "task-approved", now: "2026-01-01T00:00:03.000Z" });
    const noPayload = listUndeliveredOutboxEvents(db).find((e) => e.id === "ob-4");
    assert.equal(noPayload.payload, null, "an event written with no payload must read back as null, not \"null\" the string or {}");
    console.log("  4. a null payload round-trips as null, not the string \"null\" or an empty object");
  } finally {
    try { closeDb(db); } catch { /* already closed */ }
    rmScratchDir(stateDir);
  }
});
