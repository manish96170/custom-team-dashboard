// event-pump.test.js — the supervisor-owned event consumer (TODO.md Group 5).
//
// What each case pins down, and what it looked like before the pump existed (when
// ipc/server.js's `observe` handler WAS the only consumer):
//
//   1. persists-with-no-subscriber — a run that starts and finishes with nobody watching
//      wrote ZERO event_log rows before. Verified to fail pre-fix by construction: the
//      old code path only ran inside a client's observe() handler.
//   2. one-consumer-two-subscribers — two clients used to mean two independent adapter
//      consumers, so every event was persisted twice; and against the real Claude Code
//      adapter (one shared read cursor per run) the two consumers SPLIT the stream
//      instead of each seeing all of it. Asserted here directly: both subscribers see
//      every event, and persistence sees each event exactly once.
//   3. late-subscriber-replay — a subscriber attaching after the run ended still gets the
//      whole history from the buffer.
//   4. per-subscriber-cursor — a slow subscriber's position does not affect a fast one.
//   5. cancel-one-subscriber — an aborted subscriber (client disconnect) stops without
//      ending the run or disturbing the other subscriber. This is the deferred review
//      item "cancel a peer's observe iterator on disconnect".
//   6. eviction-reports-a-gap — a bounded buffer that drops events tells the subscriber
//      so, rather than silently skipping sequence numbers.
//   7. derived-status-fails-closed — an unrecognized turn.end status derives 'error'.
//   8. closeAll-is-bounded — teardown of a consumer stuck on a stream that never ends
//      resolves anyway.

import assert from "node:assert/strict";
import { createEventPump } from "../event-pump.js";
import { runTest, sleep } from "./_helpers.js";

/** Minimal persistence double recording exactly what the real db writer would receive. */
function recorder() {
  const rows = [];
  return {
    rows,
    async recordEvent(row) {
      rows.push(row);
    },
  };
}

/** An adapter-shaped async stream we can drive from the test. */
function controllableStream() {
  const queue = [];
  let wake = null;
  let ended = false;
  return {
    push(event) {
      queue.push(event);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (ended) return;
        await new Promise((r) => {
          wake = r;
        });
      }
    },
  };
}

// The deadline is enforced around `next()`, not after a frame arrives. `for await` blocks
// inside `iterator.next()`, so a post-push deadline check is only ever reached once at
// least one frame has been yielded — the failure mode that most needed a timeout (a
// subscriber that yields NOTHING) hung forever instead, surfacing as Node exit 13 with no
// PASS line rather than as this error message.
async function collect(iterator, count, { timeoutMs = 2000 } = {}) {
  const out = [];
  const it = typeof iterator[Symbol.asyncIterator] === "function" ? iterator[Symbol.asyncIterator]() : iterator;
  const deadline = Date.now() + timeoutMs;
  try {
    while (out.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out collecting ${count} frames (got ${out.length})`);
      let timer;
      const TIMED_OUT = Symbol("timeout");
      let step;
      try {
        step = await Promise.race([
          it.next(),
          new Promise((r) => {
            timer = setTimeout(() => r(TIMED_OUT), remaining);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (step === TIMED_OUT) throw new Error(`timed out collecting ${count} frames (got ${out.length})`);
      if (step.done) break;
      out.push(step.value);
    }
  } finally {
    // Match `for await`'s own cleanup: breaking out of a generator must close it.
    await it.return?.();
  }
  return out;
}

await runTest("event-pump", async () => {
  // ---- 1. the pump persists with no subscriber at all -------------------------------
  {
    const persistence = recorder();
    const pump = createEventPump({ persistence, logger: { warn() {} } });
    const stream = controllableStream();
    pump.attach("run-a", stream);

    stream.push({ type: "turn.start" });
    stream.push({ type: "assistant.delta", text: "hi" });
    stream.push({ type: "turn.end", status: "completed", tokensIn: 10, tokensOut: 3, cachedTokens: 100 });
    stream.end();
    await sleep(40);

    assert.deepEqual(
      persistence.rows.map((r) => r.type),
      ["turn.start", "assistant.delta", "turn.end"],
      "every event must be persisted even though nobody ever subscribed",
    );
    assert.equal(persistence.rows[0].runId, "run-a");
    assert.equal(persistence.rows[0].tier, 1);

    const d = pump.derived("run-a");
    assert.equal(d.done, true, "stream ended, so the pump must report done");
    assert.equal(d.terminalStatus, "completed");
    assert.equal(d.turnCount, 1);
    assert.equal(d.tokensIn, 10, "token telemetry must be derived from the stream");
    assert.equal(d.tokensOut, 3);
    assert.equal(d.cachedTokens, 100);
    assert.equal(d.eventsSeen, 3);
    console.log("  1. no-subscriber run: 3 events persisted, status+tokens derived");
  }

  // ---- 2. one consumer, two subscribers, each event persisted exactly once ----------
  {
    const persistence = recorder();
    const pump = createEventPump({ persistence, logger: { warn() {} } });
    const stream = controllableStream();
    pump.attach("run-b", stream);

    const subA = pump.subscribe("run-b");
    const subB = pump.subscribe("run-b");
    const gotA = collect(subA, 3);
    const gotB = collect(subB, 3);

    stream.push({ type: "turn.start" });
    stream.push({ type: "assistant.delta", text: "x" });
    stream.push({ type: "turn.end", status: "completed" });

    const [framesA, framesB] = await Promise.all([gotA, gotB]);
    assert.deepEqual(framesA.map((f) => f.event.type), ["turn.start", "assistant.delta", "turn.end"]);
    assert.deepEqual(framesB.map((f) => f.event.type), ["turn.start", "assistant.delta", "turn.end"]);
    assert.deepEqual(framesA.map((f) => f.seq), [1, 2, 3], "seq numbers are absolute and shared");
    assert.deepEqual(framesB.map((f) => f.seq), [1, 2, 3]);
    assert.equal(persistence.rows.length, 3, `each event persisted exactly once, got ${persistence.rows.length}`);
    stream.end();
    console.log("  2. two subscribers each saw all 3 events; persistence saw each once");
  }

  // ---- 3. a subscriber that arrives after the run ended still gets the history -------
  {
    const pump = createEventPump({ persistence: recorder(), logger: { warn() {} } });
    const stream = controllableStream();
    pump.attach("run-c", stream);
    stream.push({ type: "turn.start" });
    stream.push({ type: "turn.end", status: "completed" });
    stream.end();
    await sleep(30);

    const frames = [];
    for await (const f of pump.subscribe("run-c")) frames.push(f);
    assert.deepEqual(frames.map((f) => f.event.type), ["turn.start", "turn.end"], "late subscriber must get replay");
    console.log("  3. late subscriber replayed 2 buffered events and the iterator ended");
  }

  // ---- 4. per-subscriber cursors are genuinely independent ---------------------------
  {
    const pump = createEventPump({ persistence: recorder(), logger: { warn() {} } });
    const stream = controllableStream();
    pump.attach("run-d", stream);

    const fast = pump.subscribe("run-d");
    const slow = pump.subscribe("run-d");
    stream.push({ type: "e1" });
    stream.push({ type: "e2" });
    await sleep(20);

    const fastFrames = await collect(fast, 2);
    assert.deepEqual(fastFrames.map((f) => f.event.type), ["e1", "e2"]);
    // `slow` has read nothing yet. Its cursor must still be at the beginning.
    const slowFrames = await collect(slow, 2);
    assert.deepEqual(
      slowFrames.map((f) => f.event.type),
      ["e1", "e2"],
      "the slow subscriber's cursor must be its own -- the fast one draining the buffer must not advance it",
    );
    stream.end();
    console.log("  4. slow subscriber still saw e1,e2 after the fast one had drained them");
  }

  // ---- 5. cancelling one subscriber leaves the run and the other subscriber alone -----
  {
    const persistence = recorder();
    const pump = createEventPump({ persistence, logger: { warn() {} } });
    const stream = controllableStream();
    pump.attach("run-e", stream);

    const controller = new AbortController();
    const doomed = pump.subscribe("run-e", { signal: controller.signal });
    const survivor = pump.subscribe("run-e");

    stream.push({ type: "e1" });
    const doomedFrames = [];
    for await (const f of doomed) {
      doomedFrames.push(f);
      break; // simulate the client disconnecting mid-stream
    }
    controller.abort();
    await sleep(10);

    // The run keeps going and keeps being persisted after the subscriber left.
    stream.push({ type: "e2" });
    stream.push({ type: "turn.end", status: "completed" });
    const survivorFrames = await collect(survivor, 3);
    assert.deepEqual(survivorFrames.map((f) => f.event.type), ["e1", "e2", "turn.end"]);
    assert.equal(doomedFrames.length, 1, "the cancelled subscriber stopped where it broke");
    assert.equal(persistence.rows.length, 3, "events after the disconnect are still persisted");
    assert.equal(pump.derived("run-e").subscriberCount, 0, "both subscriptions released their slot");
    stream.end();
    console.log("  5. disconnected subscriber cancelled; run kept streaming and persisting");
  }

  // ---- 6. eviction is reported, not silent ------------------------------------------
  {
    const pump = createEventPump({ persistence: recorder(), logger: { warn() {} }, bufferLimit: 3 });
    const stream = controllableStream();
    pump.attach("run-f", stream);
    for (let i = 1; i <= 6; i++) stream.push({ type: `e${i}` });
    stream.end();
    await sleep(40);

    const frames = [];
    for await (const f of pump.subscribe("run-f")) frames.push(f);
    // Buffer holds the last 3; the subscriber starts at firstSeq, so there is no gap to
    // report from its own cursor -- but the pump must still admit what it dropped.
    assert.deepEqual(frames.filter((f) => f.event).map((f) => f.event.type), ["e4", "e5", "e6"]);
    const d = pump.derived("run-f");
    assert.equal(d.eventsSeen, 6, "all 6 events passed through the pump (and were persisted)");
    assert.equal(d.eventsEvicted, 3, "the 3 dropped events must be reported, not hidden");

    // A subscriber whose cursor points into the evicted region gets an explicit gap frame.
    const gapFrames = [];
    for await (const f of pump.subscribe("run-f", { fromSeq: 1 })) gapFrames.push(f);
    assert.equal(gapFrames[0].gap, 3, `first frame must be a gap of 3, got ${JSON.stringify(gapFrames[0])}`);
    assert.equal(gapFrames[0].fromSeq, 4);
    console.log("  6. bounded buffer evicted 3 events and reported the gap explicitly");
  }

  // ---- 7. unrecognized turn.end status fails closed ----------------------------------
  {
    const pump = createEventPump({ persistence: recorder(), logger: { warn() {} } });
    const stream = controllableStream();
    pump.attach("run-g", stream);
    stream.push({ type: "turn.end", status: "probably-fine-honestly" });
    stream.end();
    await sleep(30);
    assert.equal(
      pump.derived("run-g").terminalStatus,
      "error",
      "an unrecognized turn.end status must derive 'error' (fail closed), not be trusted",
    );
    console.log("  7. unknown turn.end status derived as 'error'");
  }

  // ---- 8. teardown is bounded even against a stream that never ends -------------------
  {
    const pump = createEventPump({ persistence: recorder(), logger: { warn() {} } });
    const stream = controllableStream(); // never .end()ed
    pump.attach("run-h", stream);
    stream.push({ type: "e1" });
    await sleep(20);

    const started = Date.now();
    const result = await pump.closeAll({ timeoutMs: 300 });
    const elapsed = Date.now() - started;
    assert.deepEqual(result.closed, ["run-h"]);
    assert.ok(elapsed < 2000, `closeAll must be bounded, took ${elapsed}ms`);
    assert.equal(pump.has("run-h"), false, "closed runs are released");
    console.log(`  8. closeAll against a never-ending stream returned in ${elapsed}ms`);
  }
});
