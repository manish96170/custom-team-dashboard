// session-intent.test.js — PLAN.md §7's clean-vs-kill rule (Phase 8) WIRED INTO THE SUPERVISOR.
// `domain/test/session-intent.test.js` proves the pure decision without a database or an adapter; this
// proves the thing that module cannot: that `resetSession` genuinely calls `clearContext` (never
// `stop`+`start`) for an unconfirmed/ambiguous "kill-respawn" request, and genuinely calls `stop`+`start`
// only once the request is unambiguous — real spawned processes throughout, same "prove the mechanism"
// rule this project applies everywhere else.
//
// Cases:
//   1. requestedAction: "kill-respawn" with no explicitKillConfirmed: the run is CLEARED, not killed —
//      the real process from generation 1 is still alive afterward
//   2. the same request WITH explicitKillConfirmed: true: the run is genuinely stopped and a new
//      generation started with the supplied respawnSpec — a real new process, not the old one
//   3. an authorized kill-respawn with no respawnSpec is refused (thrown), and the original run is left
//      untouched — not stopped with nothing to replace it
//   4. requestedAction omitted (a plain reset) behaves exactly like clearContext

import assert from "node:assert/strict";
import { openDb, closeDb, upsertHarness, createTask, createWorker } from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

await runTest("session-intent (clean-vs-kill) wiring", async () => {
  const stateDir = makeScratchDir("supervisor-session-intent-test");
  let db;
  let supervisor;

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake" });
    createTask(db, { id: "t1", title: "reset target", type: "feature" });
    createWorker(db, { workerId: "w-code", nickname: "purus", role: "coder", taskId: "t1" });

    const harness = createFakeHarness({ label: "session-intent" });
    supervisor = createSupervisor({ db, stateDir, adapters: { fake: harness }, askSweepIntervalMs: 0, logger: quiet });
    await supervisor.boot();

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    let gen1RunId;
    {
      const started = await supervisor.start({ harnessId: "fake", workerId: "w-code", spec: { cwd: stateDir, prompt: "gen1" } });
      gen1RunId = started.runId;
      const result = await supervisor.resetSession(gen1RunId, { requestedAction: "kill-respawn" });
      assert.equal(result.action, "clear", "unconfirmed kill-respawn must resolve to a clear");
      assert.ok(result.refused, "the refusal reason must be surfaced to the caller");
      assert.ok(harness._runs.get(gen1RunId), "generation 1's run must still be tracked");
      assert.equal(harness._runs.get(gen1RunId).ended, false, "the ORIGINAL process must still be alive — it was cleared, not killed");
      console.log("  1. requestedAction: \"kill-respawn\" with no explicitKillConfirmed: the run is CLEARED, not killed");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    {
      const before = harness._runs.get(gen1RunId).child.pid;
      const result = await supervisor.resetSession(gen1RunId, {
        requestedAction: "kill-respawn",
        explicitKillConfirmed: true,
        respawnSpec: { harnessId: "fake", workerId: "w-code", spec: { cwd: stateDir, prompt: "gen2" } },
      });
      assert.equal(result.action, "kill-respawn");
      assert.ok(result.stopped, "the original run must have been genuinely stopped");
      assert.ok(result.started?.runId, "a new run must have been genuinely started");
      assert.notEqual(result.started.runId, gen1RunId, "the respawn must be a NEW run, not the same one resumed");
      const newChild = harness._runs.get(result.started.runId);
      assert.ok(newChild, "the new generation must be a real, tracked run");
      assert.notEqual(newChild.child.pid, before, "the respawn must be a genuinely NEW process, not the old one");
      console.log("  2. confirmed kill-respawn: the run is genuinely stopped and a new generation started with the supplied respawnSpec");
      await supervisor.stop(result.started.runId).catch(() => {});
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      const started = await supervisor.start({ harnessId: "fake", workerId: "w-code", spec: { cwd: stateDir, prompt: "gen3" } });
      await assert.rejects(
        supervisor.resetSession(started.runId, { requestedAction: "kill-respawn", explicitKillConfirmed: true }),
        /requires respawnSpec/,
      );
      assert.equal(harness._runs.get(started.runId).ended, false, "a refused kill-respawn (no respawnSpec) must leave the original run untouched, not stop it with nothing to replace it");
      console.log("  3. an authorized kill-respawn with no respawnSpec is refused, and the original run is left running");
      await supervisor.stop(started.runId).catch(() => {});
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    {
      const started = await supervisor.start({ harnessId: "fake", workerId: "w-code", spec: { cwd: stateDir, prompt: "gen4" } });
      const viaReset = await supervisor.resetSession(started.runId, {});
      assert.equal(viaReset.action, "clear");
      assert.ok(harness._runs.get(started.runId).ended === false);
      console.log("  4. requestedAction omitted (a plain reset) behaves exactly like clearContext");
      await supervisor.stop(started.runId).catch(() => {});
    }
  } finally {
    try { await supervisor?.shutdown?.({ timeoutMs: 3000 }); } catch { /* best-effort */ }
    try { closeDb(db); } catch { /* already closed */ }
    rmScratchDir(stateDir);
  }
});
