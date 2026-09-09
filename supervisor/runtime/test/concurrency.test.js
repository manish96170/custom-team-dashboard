// concurrency.test.js — Group 6, half two: put the supervisor under concurrent load
// through its real command surface and assert the invariants that concurrency is what
// breaks (TODO.md Group 6).
//
// Everything here goes over the Unix socket, because that is the authoritative mutation
// path (PLAN.md section 4) and therefore the place concurrency actually arrives: eight
// starts issued at once, input load fanned across every run at once, three observers on one
// run while it is being written to, and deliberately racing terminal writers.
//
// Cases:
//   1. eight concurrent starts each get their own verified, distinct process group
//   2. concurrent input load: every run's events are all there, in order, and none of them
//      landed in another run's stream
//   3. three concurrent observers on a run under load each see the whole stream, contiguous,
//      with no silent holes
//   4. `stop` and `reap` racing on one run produce exactly one terminal reason, and a
//      DELIBERATE one — never the `errored` the stream derives from being killed
//   5. two concurrent reaps of the same run: both agree it is dead, and it is closed once
//   6. a process group holding only zombies is reported dead, not "survived the kill"
//   7. concurrent stops plus teardown leave no surviving process group and no open row
//
// Standing rule (TODO.md Group 6): every case asserts. This script cannot exit 0 with a
// broken claim.

import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { openDb, closeDb, upsertHarness, createWorker, getRun, endRun, listOpenRuns } from "../../db/index.js";
import { createIpcServer } from "../../ipc/server.js";
import { connect } from "../../ipc/client.js";
import { createSupervisor } from "../supervisor.js";
import {
  readProcInfo,
  isProcessGroupAlive,
  isProcessGroupLive,
  listProcessGroupStates,
  signalProcessGroup,
} from "../procinfo.js";
import { killProcessGroup } from "../spawn.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, sleep, waitFor, DELTAS_PER_TURN } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };
const CONCURRENT_RUNS = 8;
// Derived from the fake harness rather than restated, so a change to its streaming cannot make this
// arithmetic quietly wrong: it emits a FIXED number of deltas per turn for exactly this reason.
const EVENTS_PER_TURN = 2 + DELTAS_PER_TURN; // turn.start, N * assistant.delta, turn.end
const EVENTS_AT_START = 1 + EVENTS_PER_TURN; // session.init + one turn for the initial prompt

await runTest("concurrency", async () => {
  const stateDir = makeScratchDir("supervisor-concurrency-test");
  const sockPath = path.join(stateDir, "control.sock");
  const liveGroups = new Set();
  let db;
  let server;
  let supervisor;
  let harness;
  let client;

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createWorker(db, { workerId: "w1", nickname: "tester", role: "worker" });

    harness = createFakeHarness({ label: "conc" });
    supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet });
    await supervisor.boot();
    server = createIpcServer({ commands: supervisor.commandHandlers(), logger: quiet });
    await server.listen(sockPath);
    client = await connect(sockPath);

    // ---- 1. eight concurrent starts -----------------------------------------------------
    const started = await Promise.all(
      Array.from({ length: CONCURRENT_RUNS }, (_, i) =>
        client.send("start", { harnessId: "fake", workerId: "w1", spec: { cwd: stateDir, prompt: `concurrent ${i}` } }),
      ),
    );
    for (const res of started) {
      assert.equal(res.ok, true, `a concurrent start failed: ${JSON.stringify(res)}`);
      assert.equal(res.identityVerified, true, `every concurrent start must be OS-verified: ${JSON.stringify(res)}`);
    }
    const runIds = started.map((r) => r.runId);
    assert.equal(new Set(runIds).size, CONCURRENT_RUNS, "concurrent starts must not collide on a run id");

    const rows = runIds.map((id) => getRun(db, id));
    const pids = rows.map((r) => r.pid);
    const pgids = rows.map((r) => r.process_group);
    assert.equal(new Set(pids).size, CONCURRENT_RUNS, `concurrent children must have distinct pids: ${pids}`);
    assert.equal(new Set(pgids).size, CONCURRENT_RUNS, `concurrent children must have distinct process groups: ${pgids}`);
    for (const row of rows) {
      assert.equal(row.process_group, row.pid, "every child leads its own group, even when eight spawn at once");
      assert.notEqual(row.process_group, process.pid, "no child may record the supervisor's own group");
      assert.ok(row.proc_lstart, "the pid-reuse guard must be persisted for every concurrent start");
      liveGroups.add(row.process_group);
    }
    // Eight healthy managed runs are open — and NONE of them is an orphan. The orphan view
    // filters on `lifecycle`, not merely on "the row is open", and this is the only place that
    // distinction can be observed: in the crash suite every open row happens to be an orphan.
    assert.deepEqual(supervisor.orphans(), [], "a healthy managed run must never appear in the orphan view");
    const openNow = supervisor.list();
    assert.equal(openNow.length, CONCURRENT_RUNS, `all ${CONCURRENT_RUNS} runs should be open`);
    for (const entry of openNow) {
      assert.equal(entry.lifecycle, "managed", "a run the supervisor started is managed");
      assert.equal(entry.orphaned, false);
      assert.equal(entry.managed, true, "and it still holds an adapter handle");
    }
    console.log(`  1. ${CONCURRENT_RUNS} concurrent starts: ${CONCURRENT_RUNS} distinct verified process groups, none of them ours, none an orphan`);

    // ---- 2. concurrent write load across every run --------------------------------------
    const TURNS = 5;
    const expectedPerRun = EVENTS_AT_START + TURNS * EVENTS_PER_TURN;
    await Promise.all(
      runIds.flatMap((runId) =>
        Array.from({ length: TURNS }, (_, t) => client.send("sendInput", { runId, input: `turn ${t}` })),
      ),
    );
    await waitFor(
      () => runIds.every((id) => eventCount(db, id) >= expectedPerRun),
      { timeoutMs: 20000, pollMs: 40, what: `every run to persist ${expectedPerRun} events under concurrent load` },
    );
    for (const [i, runId] of runIds.entries()) {
      // TIER 1 only: this counts the harness's own stream, and a tier-2 `turn.digest` is written at
      // `turn.end` by the supervisor (PLAN.md section 8, Rule 4), not by the run.
      const evs = db.prepare("SELECT seq, type, payload_json FROM event_log WHERE run_id = ? AND tier = 1 ORDER BY seq").all(runId);
      assert.equal(evs.length, expectedPerRun, `run ${runId} persisted ${evs.length} events, expected ${expectedPerRun}`);
      assert.equal(evs.filter((e) => e.type === "turn.end").length, TURNS + 1, `run ${runId} lost or duplicated a turn`);
      let last = 0;
      for (const e of evs) {
        assert.ok(e.seq > last, `run ${runId}'s events must be persisted in arrival order (${e.seq} after ${last})`);
        last = e.seq;
      }
      // Anti-crosstalk: the fake child stamps its OWN pid into session.init, so a stream
      // spliced into the wrong run's log is visible rather than merely improbable. This is
      // the failure mode the pre-Group-5 design actually had (one shared read cursor across
      // observe() calls) — under eight concurrent runs it would show up right here.
      const init = JSON.parse(evs[0].payload_json);
      assert.equal(evs[0].type, "session.init", `run ${runId}'s first persisted event should be session.init`);
      assert.equal(
        init.sessionId,
        `fake-session-${rows[i].pid}`,
        `run ${runId} persisted another run's session.init (${init.sessionId} vs pid ${rows[i].pid})`,
      );
    }
    const total = db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE tier = 1").get().n;
    assert.equal(total, expectedPerRun * CONCURRENT_RUNS, `event_log has ${total} rows; no run may persist another's events`);
    console.log(`  2. ${total} events across ${CONCURRENT_RUNS} runs under concurrent load: all in order, none crossed streams`);

    // ---- 3. three concurrent observers on a run that is still being written to ----------
    {
      const runId = runIds[0];
      const before = eventCount(db, runId);
      const expected = before + TURNS * EVENTS_PER_TURN;
      const observers = ["obs-1", "obs-2", "obs-3"].map((id) => collectFrames(client, id, runId, expected, 20000));
      await sleep(80); // let all three subscribe before more load arrives
      await Promise.all(Array.from({ length: TURNS }, (_, t) => client.send("sendInput", { runId, input: `observed ${t}` })));
      const collected = await Promise.all(observers);

      for (const [i, frames] of collected.entries()) {
        const events = frames.filter((f) => f.event);
        const gaps = frames.filter((f) => f.gap);
        assert.deepEqual(gaps, [], `observer ${i + 1} was told about a gap it should not have hit: ${JSON.stringify(gaps)}`);
        assert.equal(events.length, expected, `observer ${i + 1} saw ${events.length} events, expected ${expected}`);
        const seqs = events.map((f) => f.seq);
        assert.deepEqual(
          seqs,
          Array.from({ length: expected }, (_, k) => k + 1),
          `observer ${i + 1}'s cursor must be contiguous from 1 — a hole here is the silent-eviction bug`,
        );
      }
      // Fan-out, not extra consumers: three observers must not multiply the persisted rows.
      assert.equal(eventCount(db, runId), expected, "concurrent observers must not re-persist events");
      console.log(`  3. three concurrent observers each replayed all ${expected} events contiguously; event_log grew once`);
    }

    // ---- 4. `stop` and `reap` racing on the same run ------------------------------------
    {
      const runId = runIds[1];
      const row = getRun(db, runId);
      const [stopRes, reapRes] = await Promise.all([client.send("stop", { runId }), client.send("reap", { runId })]);
      assert.equal(stopRes.ok, true, JSON.stringify(stopRes));
      assert.equal(reapRes.ok, true, JSON.stringify(reapRes));
      const closed = getRun(db, runId);
      assert.ok(closed.ended_at, "a run that was both stopped and reaped must be closed");
      assert.ok(
        closed.exit_reason === "stopped" || closed.exit_reason === "reaped",
        `a deliberate terminal action must outrank the status derived from the stream ending, got "${closed.exit_reason}"`,
      );
      assert.equal(closed.reconciled_at, null, "neither stop nor reap is a reconciliation-derived outcome");
      // Exactly one writer landed: a third attempt must change nothing.
      assert.equal(endRun(db, runId, { exitReason: "finished" }), 0, "the terminal write must be first-writer-wins");
      assert.equal(getRun(db, runId).exit_reason, closed.exit_reason, "a later writer must not clobber the reason");
      await waitFor(async () => !(await readProcInfo(row.pid)).alive, { timeoutMs: 5000, what: "the raced run's process to die" });
      assert.equal(isProcessGroupAlive(row.process_group), false, "a raced stop+reap must still leave nothing running");
      console.log(`  4. stop and reap raced on one run: exit_reason "${closed.exit_reason}" (deliberate, not derived), process gone`);
    }

    // ---- 5. two concurrent reaps of the same run ----------------------------------------
    {
      const runId = runIds[2];
      const row = getRun(db, runId);
      const results = await Promise.all([client.send("reap", { runId }), client.send("reap", { runId })]);
      for (const r of results) {
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.reaped, true, `both reaps must agree the group is dead: ${JSON.stringify(r)}`);
      }
      // At most one of them may report closing the row — and it can legitimately be NEITHER:
      // killing the child ends its stream, so the pump's `onEnd` hook can land the terminal
      // write first. What matters is that whoever wrote it wrote the DELIBERATE reason (the
      // `terminalIntent` mechanism), and that only one write took effect.
      const closedBy = results.filter((r) => r.runClosed === true);
      assert.ok(closedBy.length <= 1, `at most one concurrent reap may close the row, ${closedBy.length} did`);
      const closed = getRun(db, runId);
      assert.ok(closed.ended_at, "a reaped run must be closed by someone");
      assert.equal(closed.exit_reason, "reaped", "the deliberate reason must win over the `errored` derived from the kill");
      assert.equal(endRun(db, runId, { exitReason: "finished" }), 0, "the row must already be closed to further writers");
      await waitFor(async () => !(await readProcInfo(row.pid)).alive, { timeoutMs: 5000, what: "the doubly-reaped process to die" });
      console.log(
        `  5. two concurrent reaps of one run: both report it dead, closed once as "reaped" ` +
          `(${closedBy.length} of the two reaps did the write; the pump's onEnd may legitimately do it)`,
      );
    }

    // ---- 6. a zombie-only process group is dead, not "survived the kill" -----------------
    // The deterministic form of what case 5 found by racing. A group whose members have all
    // exited but not yet been waited for answers `kill(-pgid, 0)` with success and
    // `kill(-pgid, SIGTERM)` with EPERM, so the pre-fix `killProcessGroup` reported
    // `killed: false` — and `reap` gates its terminal write on that flag, so it left the run
    // row open and kept advertising a reap for a process that no longer exists.
    //
    // Case 5 only exercises this when the zombie window (a few ms, until libuv waits) happens
    // to overlap the second reap, which is exactly the kind of "sometimes proves it" test the
    // project's standing rule rejects. A `perl` parent never waits for its child, so the
    // zombie persists for as long as the test needs it to.
    {
      const holder = spawn(
        "perl",
        ["-e", 'my $pid=fork(); if(!$pid){ setpgrp(0,0); exec("sleep","600"); } $|=1; print "$pid\n"; sleep 600;'],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        const pgid = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("the zombie holder never printed its child's pid")), 5000);
          holder.stdout.once("data", (d) => {
            clearTimeout(timer);
            const n = Number(String(d).trim());
            Number.isInteger(n) && n > 1 ? resolve(n) : reject(new Error(`unusable pid from the zombie holder: ${String(d)}`));
          });
        });
        liveGroups.add(pgid);
        assert.equal((await listProcessGroupStates(pgid)).some((m) => !m.zombie), true, "the grandchild should start out running");

        signalProcessGroup(pgid, "SIGTERM");
        const states = await waitFor(
          async () => {
            const s = await listProcessGroupStates(pgid);
            return s.length > 0 && s.every((m) => m.zombie) ? s : null;
          },
          { timeoutMs: 5000, pollMs: 50, what: "the group to become zombie-only" },
        );
        // The two cheap primitives both mislead here; that is the whole point of the case.
        assert.equal(isProcessGroupAlive(pgid), true, "kill(-pgid, 0) succeeds on a zombie — the cheap check cannot decide this");
        assert.equal(signalProcessGroup(pgid, "SIGTERM").reason, "EPERM", "signalling a zombie-only group returns EPERM, not ESRCH");
        assert.equal(await isProcessGroupLive(pgid), false, "nothing in a zombie-only group is running");

        const kill = await killProcessGroup(pgid, { graceMs: 400 });
        assert.equal(kill.killed, true, `a zombie-only group must be reported dead, not survived: ${JSON.stringify(kill)}`);
        assert.equal(kill.escalated, false, "there is nothing left to escalate SIGKILL against");
        assert.match(kill.note ?? "", /zombie-only|already exited/, `the note should say why: ${JSON.stringify(kill)}`);
        console.log(
          `  6. zombie-only group ${pgid} (ps says ${states.map((s) => s.stat).join(",")}): EPERM on the signal, ` +
            `reported dead rather than "survived the kill"`,
        );
      } finally {
        holder.kill("SIGKILL");
      }
    }

    // ---- 7. concurrent stops, then bounded teardown --------------------------------------
    {
      const remaining = listOpenRuns(db).map((r) => r.run_id);
      assert.ok(remaining.length >= 4, `expected several runs still open, got ${remaining.length}`);
      const survivor = remaining[remaining.length - 1];
      // Hold an observe open on one of them: the shape that hangs a naive teardown.
      client.socket.write(`${JSON.stringify({ id: "hold-obs", cmd: "observe", runId: survivor })}\n`);
      await sleep(100);

      const stops = await Promise.all(remaining.slice(0, -1).map((runId) => client.send("stop", { runId })));
      for (const s of stops) assert.equal(s.ok, true, JSON.stringify(s));

      const startedAt = Date.now();
      const socketTeardown = await server.shutdown({ timeoutMs: 3000, reason: "concurrency test teardown" });
      const supTeardown = await supervisor.shutdown({ timeoutMs: 3000 });
      const elapsed = Date.now() - startedAt;
      assert.equal(socketTeardown.timedOut, false, "socket teardown must stay bounded under load");
      assert.equal(supTeardown.timedOut, false, "supervisor teardown must stay bounded under load");
      assert.ok(elapsed < 6000, `teardown took ${elapsed}ms`);
      server = null;
      supervisor = null;

      for (const pgid of liveGroups) {
        await waitFor(() => !isProcessGroupAlive(pgid), {
          timeoutMs: 5000,
          what: `process group ${pgid} to be gone after concurrent stops + teardown`,
        });
      }
      const stillOpen = listOpenRuns(db);
      assert.deepEqual(stillOpen.map((r) => r.run_id), [], `every run must be closed: ${JSON.stringify(stillOpen.map((r) => r.run_id))}`);
      for (const runId of remaining) {
        const reason = getRun(db, runId).exit_reason;
        assert.ok(
          ["stopped", "reaped", "finished", "interrupted"].includes(reason),
          `run ${runId} closed as "${reason}" — a deliberately stopped run must not be booked as errored`,
        );
      }
      console.log(`  7. ${remaining.length} concurrent stops + teardown in ${elapsed}ms: no surviving group, no open row`);
    }
  } finally {
    if (client) client.close();
    if (server) await server.shutdown({ timeoutMs: 1000 }).catch(() => {});
    if (supervisor) await supervisor.shutdown({ timeoutMs: 1000 }).catch(() => {});
    if (harness) await harness.disposeAll().catch(() => {});
    for (const pgid of liveGroups) signalProcessGroup(pgid, "SIGKILL");
    if (db) closeDb(db);
    rmScratchDir(stateDir);
  }
});

function eventCount(db, runId) {
  return db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE run_id = ? AND tier = 1").get(runId).n;
}

/** Subscribe with `observe` and collect until `count` event frames have arrived. */
function collectFrames(client, id, runId, count, timeoutMs) {
  const frames = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`observe ${id} timed out with ${frames.filter((f) => f.event).length}/${count} event frames`));
    }, timeoutMs);
    const unsub = client.onStream(id, (frame) => {
      if (frame.ok === false) {
        clearTimeout(timer);
        unsub();
        reject(new Error(`observe ${id} failed: ${frame.error}`));
        return;
      }
      if (frame.event || frame.gap) frames.push(frame);
      if (frames.filter((f) => f.event).length >= count) {
        clearTimeout(timer);
        unsub();
        resolve(frames);
      }
    });
    client.socket.write(`${JSON.stringify({ id, cmd: "observe", runId })}\n`);
  });
}
