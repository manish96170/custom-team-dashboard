// slack-outbox-wiring.test.js — ROADMAP.md Phase 9 (Slack outbound), 2026-09-14: proves the PRODUCER
// side (`approveTask`/`mergeTask` writing real `outbox` rows on their real success paths) and that the
// boot-time/interval drain this supervisor now runs actually delivers them — end to end, through the
// SAME safe local fixture `slack-outbox.test.js` uses (never the real Slack API; see that file's header
// for the exact safety argument, which applies identically here since this test spawns the identical
// fixture script).
//
// Cases:
//   1. approveTask's success path writes a real "task-approved" outbox row with the task's own title,
//      and — with notifications configured against the local fixture — it is actually delivered by the
//      supervisor's own sweep timer, no manual drain call needed
//   2. mergeTask's success path writes a real "task-merged" outbox row, delivered the same way
//   3. with NO slack-notifications.json at all (the built-in disabled default), the row is still WRITTEN
//      (the producer never checks the consumer's config) but never delivered — the two are genuinely
//      decoupled

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb, closeDb, upsertHarness, createTask, createWorker, recordTransition,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { CONFIG_FILENAME as REVIEW_PROFILES_FILENAME } from "../../config/review-profiles.js";
import { CONFIG_FILENAME as SLACK_CONFIG_FILENAME } from "../../config/slack-notifications.js";
import { makeScratchDir, rmScratchDir, runTest, waitFor } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CLI = path.join(__dirname, "_fixture-slack-post-cli.js");
const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

function walkToReview(db, taskId) {
  let from = "created";
  for (const to of ["starting", "planning", "implementing", "awaiting-review"]) {
    recordTransition(db, { id: `tr-${taskId}-${to}`, taskId, fromState: from, toState: to, actor: "tester" });
    from = to;
  }
}

await runTest("slack-outbox wiring", async () => {
  const stateDir = makeScratchDir("supervisor-slack-outbox-wiring-test");
  let db;
  let supervisor;
  try {
    const bridgeDir = path.join(stateDir, "bridge");
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.copyFileSync(FIXTURE_CLI, path.join(bridgeDir, "post.js"));
    fs.writeFileSync(
      path.join(stateDir, SLACK_CONFIG_FILENAME),
      JSON.stringify({ enabled: true, channel: "#team-updates", bridgePath: bridgeDir }),
    );
    fs.writeFileSync(path.join(stateDir, REVIEW_PROFILES_FILENAME), `{
      "schemaVersion": 1,
      "profiles": {
        "default": {
          "dimensions": [{ "id": "correctness", "blocking": true, "prompt": "does it work" }],
          "quorum": { "required": 2, "parentCounts": false }
        }
      }
    }`);

    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake" });

    createTask(db, { id: "t1", title: "Ship the Slack outbox", type: "feature" });
    createWorker(db, { workerId: "w-code", nickname: "purus", role: "coder", taskId: "t1" });
    createWorker(db, { workerId: "w-r1", nickname: "aluna", role: "reviewer", taskId: "t1" });
    createWorker(db, { workerId: "w-r2", nickname: "zterra", role: "reviewer", taskId: "t1" });
    walkToReview(db, "t1");

    const harness = createFakeHarness({ label: "slack-outbox-wiring" });
    // A short real interval, not 0 — this is exactly what production runs, and the point of this test is
    // that the SWEEP TIMER (not a manual drain call) is what delivers the row.
    supervisor = createSupervisor({ db, stateDir, adapters: { fake: harness }, askSweepIntervalMs: 50, logger: quiet });
    await supervisor.boot();

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    {
      await supervisor.recordVerdict({ taskId: "t1", workerId: "w-r1", slot: "reviewer1", round: 1, commitSha: "sha1", dimension: "correctness", verdict: "approved" });
      await supervisor.recordVerdict({ taskId: "t1", workerId: "w-r2", slot: "reviewer2", round: 1, commitSha: "sha1", dimension: "correctness", verdict: "approved" });
      const approved = await supervisor.approveTask("t1", { actor: "cto" });
      assert.equal(approved.approved, true, `precondition: t1 must actually approve; refused: ${JSON.stringify(approved.refused)}`);

      const row = await waitFor(
        () => db.prepare(`SELECT * FROM outbox WHERE event_type = 'task-approved' AND json_extract(payload_json, '$.taskId') = 't1'`).get(),
        { what: "a real task-approved outbox row for t1" },
      );
      assert.deepEqual(JSON.parse(row.payload_json), { taskId: "t1", title: "Ship the Slack outbox", actor: "cto" });

      await waitFor(() => db.prepare(`SELECT delivered FROM outbox WHERE id = ?`).get(row.id)?.delivered === 1,
        { what: "the sweep timer to actually deliver the row via the local fixture, with no manual drain call" });
      console.log("  1. approveTask's success path writes a real \"task-approved\" outbox row with the task's own title, and the supervisor's own sweep timer delivers it");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    {
      const merged = supervisor.mergeTask("t1", { actor: "owner" });
      assert.equal(merged.merged, true);

      const row = await waitFor(
        () => db.prepare(`SELECT * FROM outbox WHERE event_type = 'task-merged' AND json_extract(payload_json, '$.taskId') = 't1'`).get(),
        { what: "a real task-merged outbox row for t1" },
      );
      assert.deepEqual(JSON.parse(row.payload_json), { taskId: "t1", title: "Ship the Slack outbox", actor: "owner" });

      await waitFor(() => db.prepare(`SELECT delivered FROM outbox WHERE id = ?`).get(row.id)?.delivered === 1,
        { what: "mergeTask's outbox row to also be delivered by the sweep timer" });
      console.log("  2. mergeTask's success path writes a real \"task-merged\" outbox row, delivered the same way");
    }
  } finally {
    try { await supervisor?.shutdown?.({ timeoutMs: 3000 }); } catch { /* best-effort */ }
    try { closeDb(db); } catch { /* already closed */ }
    rmScratchDir(stateDir);
  }

  await outboxWithoutNotificationsConfigured();
});

// ── 3 ──────────────────────────────────────────────────────────────────────────────────
// A SEPARATE state dir/db, deliberately: no slack-notifications.json at all, so the built-in default
// (disabled) governs — proving the producer and consumer are genuinely decoupled, not that this repeats
// case 1 with different config. A plain function, hoisted above the `await runTest(...)` call above that
// invokes it — `runTest` owns the single PASS/FAIL/process.exit for the whole file, so this must run
// INSIDE that call, not after it (anything after `runTest` resolves never executes: it already called
// `process.exit`).
async function outboxWithoutNotificationsConfigured() {
  {
    const stateDir2 = makeScratchDir("supervisor-slack-outbox-wiring-disabled-test");
    let db2;
    let supervisor2;
    try {
      fs.writeFileSync(path.join(stateDir2, REVIEW_PROFILES_FILENAME), `{
        "schemaVersion": 1,
        "profiles": {
          "default": {
            "dimensions": [{ "id": "correctness", "blocking": true, "prompt": "does it work" }],
            "quorum": { "required": 2, "parentCounts": false }
          }
        }
      }`);
      db2 = openDb({ stateDir: stateDir2 });
      upsertHarness(db2, { id: "fake", displayName: "Fake" });
      createTask(db2, { id: "t2", title: "Undelivered by design", type: "feature" });
      createWorker(db2, { workerId: "w-code2", nickname: "purus2", role: "coder", taskId: "t2" });
      createWorker(db2, { workerId: "w-r1b", nickname: "aluna2", role: "reviewer", taskId: "t2" });
      createWorker(db2, { workerId: "w-r2b", nickname: "zterra2", role: "reviewer", taskId: "t2" });
      walkToReview(db2, "t2");

      const harness2 = createFakeHarness({ label: "slack-outbox-wiring-disabled" });
      supervisor2 = createSupervisor({ db: db2, stateDir: stateDir2, adapters: { fake: harness2 }, askSweepIntervalMs: 50, logger: quiet });
      await supervisor2.boot();

      await supervisor2.recordVerdict({ taskId: "t2", workerId: "w-r1b", slot: "reviewer1", round: 1, commitSha: "sha1", dimension: "correctness", verdict: "approved" });
      await supervisor2.recordVerdict({ taskId: "t2", workerId: "w-r2b", slot: "reviewer2", round: 1, commitSha: "sha1", dimension: "correctness", verdict: "approved" });
      const approved2 = await supervisor2.approveTask("t2", { actor: "cto" });
      assert.equal(approved2.approved, true);

      const row = await waitFor(
        () => db2.prepare(`SELECT * FROM outbox WHERE event_type = 'task-approved' AND json_extract(payload_json, '$.taskId') = 't2'`).get(),
        { what: "the row to be written even with notifications disabled — the producer does not consult the consumer's config" },
      );
      // A real wait, not an instant check — proves absence over TIME (multiple real sweep ticks), not
      // just that delivery hasn't happened yet at the exact moment right after approveTask returns.
      await new Promise((r) => setTimeout(r, 300));
      const after = db2.prepare(`SELECT delivered FROM outbox WHERE id = ?`).get(row.id);
      assert.equal(after.delivered, 0, "with no slack-notifications.json (built-in disabled default), the row must NEVER be delivered, across several real sweep ticks");
      console.log("  3. with no slack-notifications.json at all, the row is still WRITTEN but never delivered — producer and consumer are genuinely decoupled");
    } finally {
      try { await supervisor2?.shutdown?.({ timeoutMs: 3000 }); } catch { /* best-effort */ }
      try { closeDb(db2); } catch { /* already closed */ }
      rmScratchDir(stateDir2);
    }
  }
}
