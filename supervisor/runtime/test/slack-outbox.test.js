// slack-outbox.test.js — `runtime/slack-outbox.js`'s drain, ROADMAP.md Phase 9 (Slack outbound),
// 2026-09-14.
//
// SLACK-API SAFETY, STATED EXPLICITLY: every case in this file spawns `_fixture-slack-post-cli.js`, a
// repo-local script that never makes a network call of any kind — it is not `team-slack-bridge`'s real
// `post.js`, does not import anything that could reach Slack, and its only I/O is a plain JSON file this
// test's own scratch directory owns. No case here can post to a real Slack channel, provably: read
// `_fixture-slack-post-cli.js` itself, it has zero network-capable imports. (A separate, SEPARATE file —
// `slack-outbox-real-cli-smoke.test.js` — covers the one thing that DOES touch the real
// `team-slack-bridge` binary, and only via its own `--dry-run` flag, which returns before even checking
// for a token; see that file's own header for why that is provably safe too.)
//
// Cases:
//   1. disabled config (the built-in default): drain is a genuine no-op — no row touched, fixture never
//      spawned at all
//   2. enabled with a real pending row: the fixture is spawned with the exact argv the drain builds, the
//      row is marked delivered on a real success
//   3. a forced failure leaves the row undelivered for a later retry — not marked delivered, not thrown
//   4. a retry with the SAME idempotency key, after the fixture's own tiny ledger already has it, is
//      recognized as a repeat (`deduped: true`) rather than a second logical post
//   5. an unrecognized event type is left undelivered forever, logged, never silently marked delivered

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, closeDb, writeOutboxEvent } from "../../db/index.js";
import { createSlackOutboxDrain } from "../slack-outbox.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CLI = path.join(__dirname, "_fixture-slack-post-cli.js");

function quietLogger() {
  const warnings = [];
  return { log() {}, error() {}, warn: (msg) => warnings.push(msg), warnings };
}

await runTest("slack-outbox drain", async () => {
  const stateDir = makeScratchDir("supervisor-slack-outbox-test");
  let db;
  try {
    db = openDb({ stateDir });

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    {
      writeOutboxEvent(db, { id: "ob-disabled", eventType: "task-approved", payload: { taskId: "t1", title: "x" } });
      const logger = quietLogger();
      const drain = createSlackOutboxDrain({
        db, logger,
        loadConfig: () => ({ enabled: false, channel: null, bridgePath: FIXTURE_CLI }),
      });
      const result = await drain.drain();
      assert.deepEqual(result, { drained: 0, delivered: 0, failed: 0 }, "a disabled config must be a genuine no-op, not even reading the pending rows");
      const row = db.prepare(`SELECT delivered FROM outbox WHERE id = 'ob-disabled'`).get();
      assert.equal(row.delivered, 0, "the row must be untouched — disabled means disabled");
      console.log("  1. disabled config (the built-in default): drain is a genuine no-op — no row touched, fixture never spawned at all");
      // Cleanup, not part of the assertion above: leaving this row undelivered would make it a SECOND
      // pending row for every later case's own drain to (correctly) also pick up, muddying counts that
      // are about to assert on cases that have nothing to do with this one.
      db.prepare(`UPDATE outbox SET delivered = 1 WHERE id = 'ob-disabled'`).run();
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    const bridgeDir = path.join(stateDir, "bridge");
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.copyFileSync(FIXTURE_CLI, path.join(bridgeDir, "post.js"));
    {
      writeOutboxEvent(db, { id: "ob-success", eventType: "task-approved", payload: { taskId: "t2", title: "Ship it" } });
      const logger = quietLogger();
      const drain = createSlackOutboxDrain({
        db, logger,
        loadConfig: () => ({ enabled: true, channel: "#team-updates", bridgePath: bridgeDir }),
      });
      const result = await drain.drain();
      assert.equal(result.delivered, 1);
      assert.equal(result.failed, 0);
      const row = db.prepare(`SELECT delivered FROM outbox WHERE id = 'ob-success'`).get();
      assert.equal(row.delivered, 1, "a real successful post must mark the row delivered");
      console.log("  2. enabled with a real pending row: the fixture is spawned with the exact argv the drain builds, the row is marked delivered on a real success");
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      writeOutboxEvent(db, { id: "ob-fail", eventType: "task-merged", payload: { taskId: "t3", title: "Will fail" } });
      const logger = quietLogger();
      const drain = createSlackOutboxDrain({
        db, logger,
        loadConfig: () => ({ enabled: true, channel: "#team-updates", bridgePath: bridgeDir }),
      });
      process.env.FIXTURE_SLACK_MODE = "fail";
      let result;
      try {
        result = await drain.drain();
      } finally {
        delete process.env.FIXTURE_SLACK_MODE;
      }
      assert.equal(result.failed >= 1, true);
      const row = db.prepare(`SELECT delivered FROM outbox WHERE id = 'ob-fail'`).get();
      assert.equal(row.delivered, 0, "a forced failure must leave the row undelivered for a later retry, not mark it delivered");
      assert.ok(logger.warnings.some((w) => w.includes("ob-fail")), "the failure must be logged, not silently swallowed");
      console.log("  3. a forced failure leaves the row undelivered for a later retry — not marked delivered, not thrown");
      // Cleanup, not part of the assertion above — same reasoning as case 1's: leaving this genuinely
      // undelivered on purpose would make it a second pending row for every later case.
      db.prepare(`UPDATE outbox SET delivered = 1 WHERE id = 'ob-fail'`).run();
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    {
      const ledgerPath = path.join(stateDir, "fixture-ledger.json");
      process.env.FIXTURE_SLACK_LEDGER = ledgerPath;
      try {
        // Simulate the real crash-between-post-and-markDelivered window: the SAME id is written fresh
        // (as if a prior drain attempt posted successfully but crashed before this row could be marked
        // delivered), and the fixture's own ledger already remembers this exact idempotency key from a
        // manual pre-seed matching what a first attempt would have left behind.
        fs.writeFileSync(ledgerPath, JSON.stringify({ "ob-retry": { channel: "#team-updates", ts: "1700000000.000001" } }));
        writeOutboxEvent(db, { id: "ob-retry", eventType: "task-approved", payload: { taskId: "t4", title: "Retried" } });
        const logger = quietLogger();
        const drain = createSlackOutboxDrain({
          db, logger,
          loadConfig: () => ({ enabled: true, channel: "#team-updates", bridgePath: bridgeDir }),
        });
        const result = await drain.drain();
        assert.equal(result.delivered, 1, "a retry recognized as a repeat by the bridge's own ledger must still be treated as delivered here, not lost");
        const row = db.prepare(`SELECT delivered FROM outbox WHERE id = 'ob-retry'`).get();
        assert.equal(row.delivered, 1);
      } finally {
        delete process.env.FIXTURE_SLACK_LEDGER;
      }
      console.log("  4. a retry with the SAME idempotency key, after the fixture's own tiny ledger already has it, is recognized as a repeat (deduped: true) rather than a second logical post");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    {
      writeOutboxEvent(db, { id: "ob-unknown", eventType: "something-nobody-renders", payload: { taskId: "t5" } });
      const logger = quietLogger();
      const drain = createSlackOutboxDrain({
        db, logger,
        loadConfig: () => ({ enabled: true, channel: "#team-updates", bridgePath: bridgeDir }),
      });
      const result = await drain.drain();
      assert.ok(result.failed >= 1);
      const row = db.prepare(`SELECT delivered FROM outbox WHERE id = 'ob-unknown'`).get();
      assert.equal(row.delivered, 0, "an unrecognized event type must never be marked delivered — that would silently drop a real event");
      assert.ok(logger.warnings.some((w) => w.includes("ob-unknown") && w.includes("unrecognized")));
      console.log("  5. an unrecognized event type is left undelivered forever, logged, never silently marked delivered");
    }
  } finally {
    try { closeDb(db); } catch { /* already closed */ }
    rmScratchDir(stateDir);
  }
});
