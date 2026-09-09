// integration.test.js — Group 5 end to end: the real database, the real socket server,
// a real resident child process in its own process group, the supervisor's own event
// consumer, real routing, a real reap, and deterministic teardown.
//
// Everything below runs against `runtime/supervisor.js` wired into `ipc/server.js` via
// `commands` — i.e. the composition that replaces ipc/persistence-stub.js and
// ipc/mock-adapter.js. The harness itself is `_fake-harness-adapter.js`, which spawns a
// real OS process through runtime/spawn.js (see its header for why a pure mock would
// prove nothing here).
//
// Cases, and what each one would have looked like before Group 5:
//   1. start persists a VERIFIED identity (pid + pgid + lstart + spawn depth + cwd).
//      Before: `runs.pid` was whatever the adapter happened to hold, `process_group` was
//      the SUPERVISOR's own group, and there was no start time at all.
//   2. events reach event_log with nobody subscribed. Before: zero rows.
//   3. two concurrent `observe` clients both see every event, id-correlated, from ONE
//      supervisor-owned consumer.
//   4. a duplicate in-flight correlation id is rejected.
//   5. a client that disconnects mid-stream does not stop the run or the persistence.
//   6. clearContext and resume are routable commands.
//   7. reap verifies identity and kills the whole process group.
//   8. restart: a second supervisor over the same database routes commands for runs it
//      never started (harnessOf rehydrated from persisted rows) and reconciles the
//      surviving process as `orphaned-unmanaged`, then reaps it.
//   9. shutdown is bounded, kills the harness processes, and leaves no live child behind.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDb, closeDb, upsertHarness, createWorker, getRun } from "../../db/index.js";
import { createIpcServer } from "../../ipc/server.js";
import { connect } from "../../ipc/client.js";
import { createSupervisor } from "../supervisor.js";
import { readProcInfo, isProcessGroupAlive, signalProcessGroup } from "../procinfo.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, sleep, waitFor } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

await runTest("integration", async () => {
  const stateDir = makeScratchDir("supervisor-integration-test");
  const sockPath = path.join(stateDir, "control.sock");
  const liveGroups = new Set();
  let db;
  let server;
  let supervisor;
  let harness;

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createWorker(db, { workerId: "w1", nickname: "tester", role: "worker" });

    harness = createFakeHarness();
    supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet });
    const bootResult = await supervisor.boot();
    assert.deepEqual(bootResult.rehydrated, [], "a fresh database has no open runs to rehydrate");

    server = createIpcServer({ commands: supervisor.commandHandlers(), logger: quiet });
    await server.listen(sockPath);
    const client = await connect(sockPath);

    // ---- 1. start persists a verified process identity ---------------------------------
    const startRes = await client.send("start", { harnessId: "fake", workerId: "w1", spec: { cwd: stateDir, prompt: "hello" } });
    assert.equal(startRes.ok, true, `start failed: ${JSON.stringify(startRes)}`);
    assert.equal(startRes.identityVerified, true, "the spawned child's identity must be OS-verified");
    const runId = startRes.runId;

    const row = getRun(db, runId);
    assert.ok(Number.isInteger(row.pid), "pid must be persisted");
    assert.equal(row.process_group, row.pid, "the child must lead its OWN process group, not inherit the supervisor's");
    assert.notEqual(row.process_group, process.pid, "the recorded group must not be the supervisor's");
    assert.ok(row.proc_lstart, "start time must be persisted -- it is the pid-reuse guard");
    assert.equal(row.spawn_depth, 1, "a supervisor-managed child is at DASHBOARD_SPAWN_DEPTH=1");
    assert.equal(row.cwd, stateDir);
    liveGroups.add(row.process_group);

    const observedNow = await readProcInfo(row.pid);
    assert.equal(observedNow.alive, true);
    assert.equal(observedNow.lstart, row.proc_lstart, "the persisted start time must be what the OS actually reports");
    console.log(`  1. start: pid ${row.pid} leads pgid ${row.process_group}, lstart + depth + cwd persisted`);

    // ---- 2. events are persisted with no subscriber whatsoever -------------------------
    await waitFor(
      () => db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE run_id = ? AND type = 'turn.end'").get(runId).n > 0,
      { timeoutMs: 5000, what: "turn.end to be persisted with no client subscribed" },
    );
    // TIER 1 only. `event_log` holds tiers 1 and 2 (PLAN.md section 8, Rule 4), and this case is about
    // the harness's own event stream — a tier-2 `turn.digest` written at `turn.end` is a different tier
    // in the same table, so an unfiltered read made this assertion fail for a reason unrelated to what
    // it tests.
    const types = db.prepare("SELECT type FROM event_log WHERE run_id = ? AND tier = 1 ORDER BY seq")
      .all(runId).map((r) => r.type);
    // The ENVELOPE is asserted, not the number of deltas. This used to pin the exact sequence
    // including a single `assistant.delta`, which made it a test of how the fake harness chunks its
    // token stream — incidental, and it broke the moment the fake started streaming in chunks the
    // way a real harness does. What this case is actually about is that events are persisted with no
    // subscriber at all, in order, from session start to turn end.
    assert.equal(types[0], "session.init", `unexpected event_log: ${types}`);
    assert.equal(types[1], "turn.start", `unexpected event_log: ${types}`);
    assert.equal(types.at(-1), "turn.end", `unexpected event_log: ${types}`);
    const deltas = types.slice(2, -1);
    assert.ok(deltas.length > 0, `expected at least one assistant.delta: ${types}`);
    assert.ok(deltas.every((t) => t === "assistant.delta"), `only deltas should sit between turn.start and turn.end: ${types}`);
    const statusRes = await client.send("status", { runId });
    assert.equal(statusRes.status.derived.terminalStatus, "completed", "status is derived from the pump's stream");
    assert.equal(statusRes.status.derived.tokensIn, 5, "token telemetry derived from turn.end");
    assert.equal(statusRes.status.managed, true);
    console.log(`  2. ${types.length} events persisted in order and status/telemetry derived with zero subscribers`);

    // ---- 3. two concurrent observe clients, one consumer --------------------------------
    {
      // Counted from what was actually persisted rather than hardcoded: the property under test is
      // "each subscriber sees the WHOLE stream, not a share of it", and pinning a literal count made
      // that hostage to how the fake harness chunks its token stream.
      const expected = types.length;
      const a = observeFramesFor(client, "obs-a", runId, expected);
      const b = observeFramesFor(client, "obs-b", runId, expected);
      const [framesA, framesB] = await Promise.all([a, b]);
      for (const [label, frames] of [["A", framesA], ["B", framesB]]) {
        assert.equal(frames.length, expected, `subscriber ${label} should replay all ${expected} buffered events`);
        assert.ok(frames.every((f) => f.id === (label === "A" ? "obs-a" : "obs-b")), "every stream frame must echo its own id");
        assert.deepEqual(
          frames.map((f) => f.event.type),
          types,
          `subscriber ${label} must see the whole stream, not a share of it`,
        );
      }
      // No duplicate persistence: the pump, not the subscribers, writes event_log.
      // TIER 1 only — the count is about the harness's stream, and a tier-2 `turn.digest` is written at
      // `turn.end` by the supervisor rather than by a subscriber (PLAN.md section 8, Rule 4).
      const after = db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE run_id = ? AND tier = 1").get(runId).n;
      assert.equal(after, expected, `fan-out must not re-persist events; event_log has ${after} rows`);
      console.log(`  3. two observe clients each replayed all ${expected} events; event_log still has exactly ${expected} rows`);
    }

    // ---- 4. duplicate in-flight correlation id is rejected ------------------------------
    {
      const id = "dup-id";
      const frames = [];
      const unsub = client.onStream(id, (f) => frames.push(f));
      // A long-lived observe holds `id`; a second command reusing it must be refused.
      client.socket.write(`${JSON.stringify({ id, cmd: "observe", runId })}\n`);
      await sleep(120);
      client.socket.write(`${JSON.stringify({ id, cmd: "ping" })}\n`);
      await waitFor(() => frames.some((f) => f.ok === false && /already in flight/.test(f.error ?? "")), {
        timeoutMs: 3000,
        what: "a duplicate-correlation-id rejection",
      });
      unsub();
      console.log("  4. a second command reusing an in-flight correlation id was rejected");
    }

    // ---- 5. a client that disconnects mid-stream does not affect the run ----------------
    {
      const peer = await connect(sockPath);
      const seen = [];
      peer.onStream("peer-obs", (f) => seen.push(f));
      peer.socket.write(`${JSON.stringify({ id: "peer-obs", cmd: "observe", runId })}\n`);
      await waitFor(() => seen.length > 0, { timeoutMs: 3000, what: "the peer's first frame" });
      peer.close(); // hard disconnect, mid-subscription
      await sleep(100);

      const before = db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE run_id = ?").get(runId).n;
      await client.send("sendInput", { runId, input: "still there?" });
      await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE run_id = ?").get(runId).n > before, {
        timeoutMs: 5000,
        what: "events from a turn after the peer disconnected",
      });
      const ping = await client.send("ping");
      assert.equal(ping.ok, true, "the daemon must survive a peer disconnecting mid-stream");
      console.log("  5. peer disconnected mid-observe; the run kept streaming and persisting");
    }

    // ---- 6. clearContext and resume are routable ---------------------------------------
    {
      const cleared = await client.send("clearContext", { runId });
      assert.equal(cleared.ok, true, `clearContext must be routable: ${JSON.stringify(cleared)}`);
      assert.equal(cleared.supported, true);
      assert.equal(cleared.harnessId, "fake", "the command must be routed via harnessOf");
      assert.equal(cleared.ack.ack, true, "the adapter's own ack is passed back, not flattened");
      await waitFor(
        () => db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE run_id = ? AND type = 'session.init'").get(runId).n >= 2,
        { timeoutMs: 5000, what: "the post-clear session.init event" },
      );

      const resumed = await client.send("resume", { runId });
      assert.equal(resumed.ok, true, `resume must be routable: ${JSON.stringify(resumed)}`);
      // The child is still alive, so this harness (like the real Claude Code adapter)
      // reports the same runId with nothing to do.
      assert.equal(resumed.result, runId);
      console.log("  6. clearContext and resume routed through harnessOf to the right adapter");
    }

    // ---- 7. reap: verify identity, then kill the whole process group --------------------
    {
      const spec = { cwd: stateDir, prompt: "reap me" };
      const started = await client.send("start", { harnessId: "fake", workerId: "w1", spec });
      const reapRow = getRun(db, started.runId);
      liveGroups.add(reapRow.process_group);
      assert.equal(isProcessGroupAlive(reapRow.process_group), true);

      const reaped = await client.send("reap", { runId: started.runId });
      assert.equal(reaped.ok, true, JSON.stringify(reaped));
      assert.equal(reaped.reaped, true, `reap must report the kill: ${JSON.stringify(reaped)}`);
      assert.equal(reaped.pgid, reapRow.process_group);
      await waitFor(async () => !(await readProcInfo(reapRow.pid)).alive, { timeoutMs: 4000, what: "reaped process to die" });
      assert.equal(isProcessGroupAlive(reapRow.process_group), false, "nothing may remain in the reaped group");
      const closed = getRun(db, started.runId);
      assert.ok(closed.ended_at, "a reaped run is closed");
      assert.equal(closed.exit_reason, "reaped");
      assert.equal(closed.reconciled_at, null, "reap is a deliberate action, not a reconciliation-derived outcome");
      console.log(`  7. reap killed pgid ${reapRow.process_group} after verifying pid+pgid+lstart`);
    }

    // ---- 8. restart: routing rehydrated from rows; orphan reconciled and reaped ---------
    {
      // Simulate the supervisor crashing: the rows stay open and the processes stay alive,
      // but every adapter handle is gone. This is exactly PLAN.md's `orphaned-unmanaged`.
      const orphanRow = getRun(db, runId);
      assert.equal(orphanRow.ended_at, null, "the first run should still be open at this point");
      const forgotten = harness._forgetAllHandles();
      assert.ok(forgotten.includes(runId));
      assert.equal((await readProcInfo(orphanRow.pid)).alive, true, "the orphan's process must still be running");

      const restartedHarness = createFakeHarness({ label: "fake2" });
      const restarted = createSupervisor({ db, adapters: { fake: restartedHarness }, logger: quiet });
      // Routing for a run this instance never started, straight from the persisted row.
      assert.equal(restarted.harnessOf(runId), "fake", "harnessOf must be rehydrated from runs.harness_id");
      assert.equal(restarted.hasHandle(runId), false, "a restarted supervisor holds no handles");

      const boot = await restarted.boot();
      assert.ok(boot.rehydrated.includes(runId), `boot must rehydrate open runs: ${JSON.stringify(boot.rehydrated)}`);
      assert.deepEqual(
        boot.reconciliation.orphaned,
        [runId],
        `the surviving process must reconcile as orphaned-unmanaged: ${JSON.stringify(boot.reconciliation.details)}`,
      );
      const reconciled = getRun(db, runId);
      // Migration 0003: an orphan is a lifecycle state on a still-OPEN row, because its process
      // is still running — closing it here is what used to hide a live orphan from every later
      // boot. Its terminal write comes from the reap below.
      assert.equal(reconciled.lifecycle, "orphaned-unmanaged");
      assert.equal(reconciled.ended_at, null, "an orphan's row stays open while its process lives");
      assert.ok(reconciled.reconciled_at, "a derived observation still stamps reconciled_at");
      assert.notEqual(reconciled.exit_reason, "finished", "reconciliation never writes finished");

      // And now the part the review called a dead end: act on it.
      const reaped = await restarted.reap(runId);
      assert.equal(reaped.reaped, true, `a restarted supervisor must be able to reap the orphan: ${JSON.stringify(reaped)}`);
      await waitFor(async () => !(await readProcInfo(orphanRow.pid)).alive, { timeoutMs: 4000, what: "orphan to be reaped" });
      console.log("  8. after a simulated restart: routing rehydrated, orphan reconciled and then actually reaped");
    }

    // ---- 9. deterministic teardown ------------------------------------------------------
    {
      const survivor = await client.send("start", { harnessId: "fake", workerId: "w1", spec: { cwd: stateDir, prompt: "teardown" } });
      const survivorRow = getRun(db, survivor.runId);
      liveGroups.add(survivorRow.process_group);
      // Hold an open observe subscription: this is the shape that hangs a naive shutdown.
      client.socket.write(`${JSON.stringify({ id: "teardown-obs", cmd: "observe", runId: survivor.runId })}\n`);
      await sleep(150);
      assert.ok(server.listSockets().length >= 1, "at least one socket must be open before teardown");

      const started = Date.now();
      const socketResult = await server.shutdown({ timeoutMs: 3000, reason: "test teardown" });
      const supResult = await supervisor.shutdown({ timeoutMs: 3000 });
      const elapsed = Date.now() - started;

      assert.equal(socketResult.timedOut, false, "socket teardown must not hit its hard timeout");
      assert.equal(server.listSockets().length, 0, "every socket must be force-closed");
      assert.equal(supResult.timedOut, false, "supervisor teardown must not hit its hard timeout");
      assert.deepEqual(supResult.adapters.fake.stopped, [survivor.runId], "teardown must dispose the live run");
      assert.ok(elapsed < 6000, `teardown must be bounded, took ${elapsed}ms`);

      await waitFor(async () => !(await readProcInfo(survivorRow.pid)).alive, {
        timeoutMs: 4000,
        what: "the harness process to be killed by teardown",
      });
      assert.equal(
        isProcessGroupAlive(survivorRow.process_group),
        false,
        "no harness process may outlive the supervisor -- that is the orphaned-unmanaged state this all exists to prevent",
      );
      console.log(`  9. teardown in ${elapsed}ms: sockets force-closed, harness process group gone`);
      server = null;
      supervisor = null;
    }

    // The db handle is owned by this test (passed in), so the supervisor left it open.
    assert.equal(fs.existsSync(path.join(stateDir, "state.sqlite3")), true);
  } finally {
    if (server) await server.shutdown({ timeoutMs: 1000 }).catch(() => {});
    if (supervisor) await supervisor.shutdown({ timeoutMs: 1000 }).catch(() => {});
    if (harness) await harness.disposeAll().catch(() => {});
    for (const pgid of liveGroups) signalProcessGroup(pgid, "SIGKILL");
    if (db) closeDb(db);
    rmScratchDir(stateDir);
  }
});

/** Issue an `observe` on an existing connection and collect exactly `count` event frames. */
function observeFramesFor(client, id, runId, count) {
  const frames = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`observe ${id} timed out with ${frames.length}/${count} frames`)), 5000);
    const unsub = client.onStream(id, (frame) => {
      if (frame.ok === false) {
        clearTimeout(timer);
        unsub();
        reject(new Error(`observe ${id} failed: ${frame.error}`));
        return;
      }
      if (frame.event) frames.push(frame);
      if (frames.length >= count) {
        clearTimeout(timer);
        unsub();
        resolve(frames);
      }
    });
    client.socket.write(`${JSON.stringify({ id, cmd: "observe", runId })}\n`);
  });
}
