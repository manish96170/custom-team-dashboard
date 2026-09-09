// review-three.test.js — regression tests for the defects found in the third review round
// (luna + terra + a Sonnet consolidation; see ../../review-three/).
//
// Every case here was run against the pre-fix code first and observed to FAIL. That's the
// standing project rule, and it is the only thing separating these from tests that merely
// describe what the code already does. The pre-fix failure for each case is recorded in the
// comment above it, verbatim from the run.
//
// Cases:
//   1. reap does NOT close the run row when the group kill failed          (finding 1)
//   2. reap does NOT close the row when the shared-group adapterStop failed (finding 2)
//   3. reap refuses outright when the recorded identity is incomplete       (my own finding)
//   4. endRun is first-writer-wins at the SQL level                         (finding 11)
//   5. a refused reap leaves the pump attached and streaming                (finding 7)
//   6. resume() re-attaches the pump and bumps the generation               (finding 3)
//   7. shutdown disposes adapters even when the pump wait is stuck          (finding 6)
//   8. closeRun cancels the adapter iterator                               (finding 8)
//   9. identity timeout kills the child instead of abandoning it            (finding 4)
//  10. a failed spawn does not crash the process                            (finding 5)
//  11. eviction while a subscriber is parked mid-fan-out reports a gap       (finding 12)
//  12. an invalid bufferLimit is refused at construction                     (finding 13)
//  13. closeAll's timer does not hold the event loop open                   (finding 10)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDb, closeDb, upsertHarness, createWorker, createRun, endRun, recordRunProcess, getRun } from "../../db/index.js";
import { createEventPump } from "../event-pump.js";
import { reap } from "../reconcile.js";
import { createSupervisor } from "../supervisor.js";
import { spawnManaged } from "../spawn.js";
import { readProcInfo, isProcessGroupAlive } from "../procinfo.js";
import { makeScratchDir, rmScratchDir, runTest, sleep, waitFor } from "./_helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A run row with a fully verified identity pointing at a real live process group. */
function seedRunWithLiveProcess(db, runId, { pid, pgid, lstart }) {
  createRun(db, { runId, workerId: "w-stub", harnessId: "stub", prompt: "p" });
  recordRunProcess(db, runId, { pid, processGroup: pgid, procLstart: lstart, spawnDepth: "1", cwd: HERE });
}

/**
 * Minimal in-process adapter. Deliberately NOT the fake harness: these cases are about the
 * supervisor's own decisions (does it close the row, does it re-attach the pump), so the
 * stream and the identity are scripted rather than driven by a real child.
 */
function createStubAdapter({ identity }) {
  const streams = new Map(); // runId -> { push, end, ended }
  const stopped = [];
  let disposeDelayMs = 0;
  let resumeCount = 0;

  function channel(runId) {
    let queue = [];
    let wake = null;
    let done = false;
    const ch = {
      push(event) {
        queue.push(event);
        wake?.();
        wake = null;
      },
      end() {
        done = true;
        wake?.();
        wake = null;
      },
      async *stream() {
        for (;;) {
          while (queue.length) yield queue.shift();
          if (done) return;
          await new Promise((r) => {
            wake = r;
          });
        }
      },
    };
    streams.set(runId, ch);
    return ch;
  }

  return {
    _streams: streams,
    _stopped: stopped,
    _channel: (runId) => streams.get(runId),
    _newChannel: channel,
    set _disposeDelayMs(ms) {
      disposeDelayMs = ms;
    },
    get _resumeCount() {
      return resumeCount;
    },
    async start(spec) {
      const runId = spec.runId ?? "stub-run";
      channel(runId);
      return runId;
    },
    observe(runId) {
      return (streams.get(runId) ?? channel(runId)).stream();
    },
    async stop(runId) {
      stopped.push(runId);
      streams.get(runId)?.end();
    },
    async resume(runId) {
      resumeCount += 1;
      channel(runId); // a NEW process means a NEW stream for the same runId
      return "resumed";
    },
    async processIdentity() {
      return identity;
    },
    async disposeAll() {
      if (disposeDelayMs) await sleep(disposeDelayMs);
      return { disposed: true };
    },
    listRuns: () => [...streams.keys()],
  };
}

await runTest("review-three", async () => {
  const stateDir = makeScratchDir("rt-review3");
  const pgids = [];
  let db;
  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "stub", displayName: "Stub harness" });
    createWorker(db, { workerId: "w-stub", nickname: "tester", role: "worker" });

    // A single real detached child, used by the cases that need a genuinely live,
    // genuinely verifiable process group.
    const spawned = spawnManaged({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: stateDir,
    });
    const live = await spawned.identity;
    assert.equal(live.verified, true, "fixture child must be verifiable");
    pgids.push(live.pgid);

    // ---- 1. a failed group kill must NOT close the run row ---------------------------
    // Pre-fix: `closed` was computed unconditionally, so the row came back
    //   ended_at set, exit_reason 'reaped'
    // for a process group that was still alive — a live process with no open row and no
    // adapter handle, which nothing would ever try to reap again.
    {
      seedRunWithLiveProcess(db, "kill-failed", live);
      const result = await reap({
        db,
        runId: "kill-failed",
        logger: { warn() {}, log() {} },
        killGroup: async () => ({ killed: false, escalated: true, note: "EPERM" }),
      });
      assert.equal(result.reaped, false, "a kill that did not work is not a reap");
      const row = getRun(db, "kill-failed");
      assert.equal(row.ended_at, null, "the row must stay OPEN when the group survived the kill");
      assert.equal(row.exit_reason, null);
      assert.equal(isProcessGroupAlive(live.pgid), true, "this case must not kill the fixture child");
      console.log("  1. failed kill left the run row open (exit_reason still null)");
    }

    // ---- 2. a failed adapterStop on a shared group must NOT close the row ------------
    // Pre-fix: `endRun(db, runId, { exitReason: "stopped" })` ran unconditionally — and
    // unlike every other call site, without even an `ended_at` pre-check. Consequence
    // beyond the wrong row: the shared-group refusal is answered from
    // listOpenRunsSharingProcessGroup, so closing A's row makes a later reap of B kill the
    // whole group, taking A's still-running session with it.
    {
      seedRunWithLiveProcess(db, "shared-a", live);
      seedRunWithLiveProcess(db, "shared-b", live);
      const result = await reap({
        db,
        runId: "shared-a",
        // `hasHandle` is required for the adapter to be asked at all (0003 review): ending a
        // session is only possible through a handle we hold, and asking an adapter to stop a run
        // it has never heard of either throws or — worse — silently "succeeds". This case is about
        // a MANAGED run whose stop fails, so the handle is stated explicitly.
        hasHandle: () => true,
        logger: { warn() {}, log() {} },
        adapterStop: async () => {
          throw new Error("adapter unavailable after a restart");
        },
      });
      assert.equal(result.sessionEnded, false);
      assert.equal(result.runClosed, false);
      assert.equal(getRun(db, "shared-a").ended_at, null, "row must stay open when the session did not end");
      assert.equal(isProcessGroupAlive(live.pgid), true, "the shared group must not be killed");

      // ...and with a working adapterStop the row DOES close, so the gate is not just
      // "never write".
      const ok = await reap({
        db,
        runId: "shared-a",
        hasHandle: () => true,
        logger: { warn() {}, log() {} },
        adapterStop: async () => true,
      });
      assert.equal(ok.sessionEnded, true);
      assert.equal(getRun(db, "shared-a").exit_reason, "stopped");
      console.log("  2. shared-group reap: row stayed open on a failed stop, closed on a successful one");
    }

    // ---- 3. an incomplete recorded identity is refused outright ----------------------
    // Pre-fix: verifyProcIdentity treats a null recorded pgid/lstart as a wildcard, so a
    // row with a pid and no start time verified on pid alone and the group was killed.
    // Not hypothetical: schema v1 had pid + process_group and no proc_lstart column, so
    // every pre-0002 row has exactly this shape.
    {
      // Its OWN process group, and the only open run on it: with the refusal removed, the
      // only thing standing between this row and a kill is the missing start time. (Reusing
      // the shared fixture here would have made the shared-group refusal answer first, and
      // the case would have "passed" while proving nothing — checked by reverting.)
      const solo = spawnManaged({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: stateDir,
      });
      const soloId = await solo.identity;
      assert.equal(soloId.verified, true);
      pgids.push(soloId.pgid);

      createRun(db, { runId: "no-lstart", workerId: "w-stub", harnessId: "stub", prompt: "p" });
      // Write pid + pgid with NO lstart, the shape schema v1 could produce.
      db.prepare(`UPDATE runs SET pid = ?, process_group = ? WHERE run_id = ?`).run(soloId.pid, soloId.pgid, "no-lstart");
      const result = await reap({ db, runId: "no-lstart", logger: { warn() {}, log() {} } });
      assert.equal(result.reaped, false);
      assert.match(result.reason, /incomplete/, `expected an incompleteness refusal, got: ${result.reason}`);
      assert.equal(isProcessGroupAlive(soloId.pgid), true, "a pid with no verified start time must never be killed");
      assert.equal(getRun(db, "no-lstart").ended_at, null, "we do not know what this run is; do not close it either");
      console.log("  3. pid recorded with no start time: reap refused, its process left running");
    }

    // ---- 4. endRun is first-writer-wins in SQL, not in application code --------------
    // Pre-fix: `UPDATE runs SET ended_at = ?, exit_reason = ? WHERE run_id = ?` with no
    // `ended_at IS NULL` guard, so the second of two concurrent terminal writers silently
    // overwrote the first's reason (a deliberate "stopped" becoming "finished").
    {
      createRun(db, { runId: "double-end", workerId: "w-stub", harnessId: "stub", prompt: "p" });
      assert.equal(endRun(db, "double-end", { exitReason: "stopped" }), 1, "first writer wins");
      assert.equal(endRun(db, "double-end", { exitReason: "finished" }), 0, "second writer must change nothing");
      assert.equal(getRun(db, "double-end").exit_reason, "stopped", "the first reason must survive");
      console.log("  4. endRun: second terminal writer changed 0 rows and did not clobber the reason");
    }

    // ---- 5. a refused reap leaves the pump attached ----------------------------------
    // Pre-fix: supervisor.reap() called pump.closeRun(runId) unconditionally, so a run
    // that survived a refused reap kept running with nothing persisting or fanning out
    // its events, and nothing to re-attach a consumer.
    {
      const adapter = createStubAdapter({ identity: { verified: false, reason: "scripted" } });
      const sup = createSupervisor({ db, adapters: { stub: adapter }, logger: { warn() {}, log() {} } });
      await sup.start({ harnessId: "stub", workerId: "w-stub", spec: { cwd: stateDir, runId: "refused" } });
      // No recorded identity at all -> reap refuses with "no process identity".
      const result = await sup.reap("refused");
      assert.equal(result.reaped, false);
      assert.equal(sup.pump.has("refused"), true, "pump state must survive a refused reap");
      adapter._channel("refused").push({ type: "assistant.delta", text: "still alive" });
      const seen = await waitFor(
        () => {
          const d = sup.pump.derived("refused");
          return d && d.eventsSeen > 0 ? d : null;
        },
        { what: "an event persisted after a refused reap" },
      );
      assert.equal(seen.eventsSeen, 1, "the run must keep streaming after a refused reap");
      console.log("  5. refused reap: pump still attached, event after the reap was still consumed");
    }

    // ---- 6. resume() re-attaches the pump and bumps the generation -------------------
    // Pre-fix: resume() persisted the new identity but never called pump.attach(), and
    // attach() is a no-op once state.consumer is set — so the resumed process's events
    // were consumed by nobody. Observed pre-fix: eventsSeen stayed at 1 forever and the
    // waitFor below timed out.
    {
      const adapter = createStubAdapter({ identity: { verified: false, reason: "scripted" } });
      const sup = createSupervisor({ db, adapters: { stub: adapter }, logger: { warn() {}, log() {} } });
      await sup.start({ harnessId: "stub", workerId: "w-stub", spec: { cwd: stateDir, runId: "resumed" } });
      adapter._channel("resumed").push({ type: "turn.end", status: "completed" });
      adapter._channel("resumed").end();
      await waitFor(() => sup.pump.derived("resumed")?.done, { what: "the first generation to end" });
      assert.equal(getRun(db, "resumed").generation, 1);

      const res = await sup.resume("resumed");
      assert.equal(res.resumed, true);
      assert.equal(res.generation, 2, "a resumed run is a new generation");
      adapter._channel("resumed").push({ type: "assistant.delta", text: "second generation" });
      const after = await waitFor(
        () => {
          const d = sup.pump.derived("resumed");
          return d && d.eventsSeen > 0 && d.lastEventType === "assistant.delta" ? d : null;
        },
        { what: "the resumed generation's events to be consumed" },
      );
      assert.equal(after.done, false, "the resumed run is live again, not still finished");
      console.log("  6. resume(): generation 1 -> 2, new stream consumed, status no longer terminal");
    }

    // ---- 7. shutdown disposes adapters even when the pump wait is stuck --------------
    // Pre-fix: pump.closeAll() and the whole shutdown raced independent timers of
    // comparable length, so a genuinely stuck consumer consumed the entire budget and
    // adapter.disposeAll() — the step that kills harness processes — never ran. Observed
    // pre-fix: result.adapters was {} and timedOut was true.
    {
      const adapter = createStubAdapter({ identity: { verified: false, reason: "scripted" } });
      adapter._disposeDelayMs = 250;
      const sup = createSupervisor({ db, adapters: { stub: adapter }, logger: { warn() {}, log() {} } });
      await sup.start({ harnessId: "stub", workerId: "w-stub", spec: { cwd: stateDir, runId: "stuck" } });
      // Never ended: the consumer is parked inside the stub's stream forever, which is
      // exactly the "adapter iterator that never yields again" case.
      const t0 = Date.now();
      const result = await sup.shutdown({ timeoutMs: 800 });
      const elapsed = Date.now() - t0;
      assert.deepEqual(result.adapters.stub, { disposed: true }, "disposal must run even when the pump wait is stuck");
      assert.equal(result.disposeTimedOut, false);
      assert.ok(elapsed < 1600, `shutdown must stay bounded, took ${elapsed}ms`);
      console.log(`  7. stuck consumer: adapters still disposed, shutdown returned in ${elapsed}ms`);
    }

    // ---- 8. closeRun cancels the adapter iterator ------------------------------------
    // Pre-fix: closeRun only set state.closed, which the consumer notices on its NEXT
    // iteration — never, if the stream is blocked on a socket read. Observed pre-fix:
    // `cancelled` stayed false and the parked next() was never settled.
    //
    // The source here is a hand-rolled async iterator, not an async generator, and that is
    // deliberate: `return()` on an async GENERATOR that is suspended inside an `await`
    // (rather than at a `yield`) is queued until the generator resumes, so a generator
    // blocked forever cannot be cancelled by any means the language offers. Verified while
    // writing this case — the generator version of it times out even with the fix in place.
    // What `closeRun` can and now does guarantee is that the cancellation contract is
    // *invoked*: a source that implements `return()` (closing its socket, aborting its
    // fetch, settling its parked read) gets told to do so. Adapters using bare generators
    // need an AbortSignal instead; see FINDINGS.md, "partially fixed".
    {
      let cancelled = false;
      let parked = null;
      let sentFirst = false;
      const source = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          if (cancelled) return Promise.resolve({ done: true, value: undefined });
          if (!sentFirst) {
            sentFirst = true;
            return Promise.resolve({ done: false, value: { type: "session.init" } });
          }
          // Blocked exactly like a read on a socket that will never deliver again.
          return new Promise((resolve) => {
            parked = resolve;
          });
        },
        return() {
          cancelled = true;
          parked?.({ done: true, value: undefined });
          parked = null;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
      const pump = createEventPump({ persistence: { recordEvent: async () => {} }, logger: { warn() {} } });
      const consumer = pump.attach("blocked", source);
      await waitFor(() => pump.derived("blocked")?.eventsSeen === 1, { what: "the first event" });
      pump.closeRun("blocked");
      await waitFor(() => cancelled, { what: "the adapter iterator to be cancelled", timeoutMs: 2000 });
      // And the consumer task itself finishes, rather than living on holding the source open.
      await Promise.race([consumer, sleep(1000).then(() => Promise.reject(new Error("consumer never finished")))]);
      console.log("  8. closeRun invoked the source's return(): parked read settled, consumer finished");
    }

    // ---- 9. an unverifiable child is killed, not abandoned ---------------------------
    // Pre-fix: captureIdentity returned { verified: false } on timeout and left the child
    // running. persistIdentity then records no pid, classifyRun calls the row "lost"
    // without asking the OS, and reap short-circuits on the NULL pid — a live process
    // group nothing can find. Observed pre-fix: isProcessGroupAlive(pid) was still true.
    {
      const orphan = spawnManaged({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: stateDir,
        identityTimeoutMs: 60,
        readProc: async () => ({ alive: false }), // the OS "can't see" it, but it is alive
      });
      const id = await orphan.identity;
      assert.equal(id.verified, false);
      assert.equal(id.killed, true, "an unownable child must be killed");
      assert.match(id.reason, /killed rather than left unowned/);
      await waitFor(() => !isProcessGroupAlive(id.pid), { what: "the unverifiable child to die", timeoutMs: 3000 });
      console.log("  9. identity timeout killed the child instead of leaving an untrackable orphan");
    }

    // ---- 10. a failed spawn does not crash the process -------------------------------
    // Pre-fix, reproduced exactly this way: the child process printed
    //   Error: spawn definitely-not-a-command-hb ENOENT ... Emitted 'error' event
    // and exited non-zero. Run in a CHILD process on purpose: an unhandled 'error' event
    // kills the process it happens in, so asserting on it from inside this test would take
    // the whole suite down instead of failing one case.
    {
      const script = `
        import { spawnManaged } from ${JSON.stringify(path.join(HERE, "..", "spawn.js"))};
        const { identity } = spawnManaged({ command: "definitely-not-a-command-hb", cwd: process.cwd() });
        const id = await identity;
        await new Promise((r) => setTimeout(r, 150)); // outlive the async 'error' emission
        console.log(JSON.stringify({ verified: id.verified, reason: id.reason }));
      `;
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: stateDir,
        encoding: "utf8",
      });
      const parsed = JSON.parse(out.trim().split("\n").pop());
      assert.equal(parsed.verified, false);
      assert.match(parsed.reason, /ENOENT/, `the reason should name the real failure, got: ${parsed.reason}`);
      console.log("  10. failed spawn: child survived and reported ENOENT instead of crashing");
    }

    // ---- 11. eviction while a subscriber is parked mid-fan-out reports a gap ---------
    // Pre-fix: the gap check existed only at the top of the OUTER loop. A subscriber parked
    // at a yield inside the inner loop resumed straight into a negative buffer index,
    // `if (!frame) continue` skipped the slot silently, and the cursor walked forward — a
    // hole the client was never told about. Observed pre-fix: frames were
    // [1,2,6,7,8] with no gap frame at all.
    {
      const pump = createEventPump({
        persistence: { recordEvent: async () => {} },
        logger: { warn() {} },
        bufferLimit: 3,
      });
      const ch = (() => {
        let queue = [];
        let wake = null;
        let done = false;
        return {
          push(e) {
            queue.push(e);
            wake?.();
            wake = null;
          },
          end() {
            done = true;
            wake?.();
            wake = null;
          },
          async *stream() {
            for (;;) {
              while (queue.length) yield queue.shift();
              if (done) return;
              await new Promise((r) => {
                wake = r;
              });
            }
          },
        };
      })();
      pump.attach("evict", ch.stream());
      for (let i = 1; i <= 3; i += 1) ch.push({ type: "e", n: i });
      await waitFor(() => pump.derived("evict")?.eventsSeen === 3, { what: "3 events buffered" });

      const it = pump.subscribe("evict")[Symbol.asyncIterator]();
      const first = await it.next(); // parks the subscriber inside the inner loop after seq 1
      assert.equal(first.value.seq, 1);

      // Evict past the subscriber's cursor while it is suspended at that yield.
      for (let i = 4; i <= 8; i += 1) ch.push({ type: "e", n: i });
      await waitFor(() => pump.derived("evict")?.eventsEvicted >= 4, { what: "eviction past the cursor" });

      const second = await it.next();
      assert.ok(second.value.gap > 0, `expected a gap frame after eviction, got ${JSON.stringify(second.value)}`);
      assert.equal(second.value.fromSeq, pump.derived("evict").eventsSeen - 2, "the gap must name where the stream resumes");
      await it.return?.();
      console.log(`  11. eviction mid-fan-out reported gap=${second.value.gap} instead of a silent hole`);
    }

    // ---- 12. an invalid bufferLimit is refused at construction -----------------------
    // Pre-fix: bufferLimit: -1 made append() compute dropped = 1 - (-1) = 2 while splicing
    // one element, advancing firstSeq by 2 — every subscriber cursor off by one, silently.
    {
      assert.throws(() => createEventPump({ persistence: {}, bufferLimit: -1 }), /positive integer/);
      assert.throws(() => createEventPump({ persistence: {}, bufferLimit: 1.5 }), /positive integer/);
      assert.throws(() => createEventPump({ persistence: {}, bufferLimit: 0 }), /positive integer/);
      console.log("  12. createEventPump refused bufferLimit -1, 1.5 and 0");
    }

    // ---- 13. closeAll's timer does not hold the event loop open ----------------------
    // Pre-fix, measured: a child that called closeAll({ timeoutMs: 3000 }) with nothing to
    // wait for took ~3.0s of wall clock to EXIT, because the abandoned setTimeout kept the
    // loop alive. Asserting on process exit (not on when closeAll resolves) is the whole
    // point — closeAll resolved immediately in both versions.
    {
      const script = `
        import { createEventPump } from ${JSON.stringify(path.join(HERE, "..", "event-pump.js"))};
        const pump = createEventPump({ persistence: { recordEvent: async () => {} } });
        await pump.closeAll({ timeoutMs: 3000 });
        console.log("closed");
      `;
      const t0 = Date.now();
      execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: stateDir, encoding: "utf8" });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 2000, `an abandoned closeAll timer kept the process alive for ${elapsed}ms`);
      console.log(`  13. process with a settled closeAll exited in ${elapsed}ms (budget was 3000ms)`);
    }

    // The fixture child is still alive at this point: nothing above was allowed to kill it.
    assert.equal(isProcessGroupAlive(live.pgid), true, "no case above may kill the fixture child");
    const stillThere = await readProcInfo(live.pid);
    assert.equal(stillThere.lstart, live.lstart, "and it must still be the same process");
  } finally {
    for (const pgid of pgids) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (db) closeDb(db);
    rmScratchDir(stateDir);
  }
});
