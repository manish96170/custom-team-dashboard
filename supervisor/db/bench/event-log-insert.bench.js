// event-log-insert.bench.js — proves that recording one event is a targeted row
// insert whose cost does not grow with the total number of rows already persisted
// across many runs. This is the direct counter-proof to spike-0b finding S1
// ("persistState() is an unserialized, non-atomic, full-file rewrite on the hot
// path") -- that design's per-event cost was O(total rows in the whole registry);
// this design's per-event cost should be flat (SQLite b-tree insert is O(log n), which
// is indistinguishable from flat at these row counts).
//
// Method: insert NUM_RUNS runs, each with EVENTS_PER_RUN events into event_log, one
// INSERT at a time (mirroring how a real supervisor writes -- one event as it
// streams in, not a batch). Time each run's batch of inserts. If the design regressed
// to an O(all-rows) rewrite, later batches (inserting into an event_log that already
// has hundreds of thousands of rows) would take dramatically longer per insert than
// the first batch. Assert they don't.
//
// Exits 1 (loudly) if the claim doesn't hold -- this is a benchmark that asserts, not
// a script that prints a number and exits 0 regardless.

import assert from "node:assert/strict";
import { closeDb, createRun, recordEvent } from "../index.js";
import { openSeededDb, makeScratchDir, rmScratchDir, runTest } from "../test/_helpers.js";

const NUM_RUNS = 40;
const EVENTS_PER_RUN = 1000;
// Generous ratio: real SQLite b-tree behavior at these row counts should be close to
// flat; this just needs to catch an accidental full-table-rewrite regression, which
// would show up as a much larger multiple (10x, 100x), not a marginal 2x-3x from
// unrelated noise.
const MAX_ACCEPTABLE_SLOWDOWN_RATIO = 6;

await runTest("event-log-insert benchmark", async () => {
  const stateDir = makeScratchDir("supervisor-bench-event-log");
  try {
    const db = openSeededDb(stateDir);

    const batchAvgMs = [];
    for (let runIdx = 0; runIdx < NUM_RUNS; runIdx++) {
      const runId = `bench-run-${runIdx}`;
      createRun(db, { runId, workerId: "worker-1", harnessId: "claude-code", prompt: `bench run ${runIdx}` });

      const t0 = process.hrtime.bigint();
      for (let i = 0; i < EVENTS_PER_RUN; i++) {
        recordEvent(db, { runId, tier: 1, type: "assistant.delta", payload: { i } });
      }
      const t1 = process.hrtime.bigint();
      const totalMs = Number(t1 - t0) / 1e6;
      batchAvgMs.push(totalMs / EVENTS_PER_RUN);
    }

    const totalRows = db.prepare("SELECT COUNT(*) AS n FROM event_log").get().n;
    console.log(`total event_log rows after ${NUM_RUNS} runs x ${EVENTS_PER_RUN} events: ${totalRows}`);
    assert.equal(totalRows, NUM_RUNS * EVENTS_PER_RUN);

    console.log("\nper-run average ms/insert (batch index -> avg ms):");
    batchAvgMs.forEach((ms, i) => console.log(`  run ${String(i).padStart(2, "0")}: ${ms.toFixed(4)} ms/insert`));

    // Compare the first few batches (table still small) against the last few
    // (table has ~NUM_RUNS * EVENTS_PER_RUN rows already) -- average a small window
    // on each end to reduce noise from a single slow batch (GC pause, etc).
    const windowSize = 5;
    const firstWindow = batchAvgMs.slice(0, windowSize);
    const lastWindow = batchAvgMs.slice(-windowSize);
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const firstAvg = avg(firstWindow);
    const lastAvg = avg(lastWindow);
    const ratio = lastAvg / firstAvg;

    console.log(`\nfirst ${windowSize} batches avg: ${firstAvg.toFixed(4)} ms/insert (table nearly empty)`);
    console.log(`last  ${windowSize} batches avg: ${lastAvg.toFixed(4)} ms/insert (table has ~${totalRows} rows)`);
    console.log(`slowdown ratio (last/first): ${ratio.toFixed(2)}x (threshold: ${MAX_ACCEPTABLE_SLOWDOWN_RATIO}x)`);

    assert.ok(
      ratio < MAX_ACCEPTABLE_SLOWDOWN_RATIO,
      `per-insert cost grew ${ratio.toFixed(2)}x from an empty table to ${totalRows} rows -- ` +
        `this smells like an O(all-rows) rewrite path, not a targeted insert`,
    );

    // Absolute sanity ceiling: even the slowest window should be well under what a
    // full-table JSON rewrite of tens of thousands of rows would cost (that would be
    // tens to hundreds of ms per event, not fractions of a ms).
    assert.ok(lastAvg < 5, `average insert cost ${lastAvg.toFixed(4)}ms is too high for a single targeted row insert`);

    closeDb(db);
  } finally {
    rmScratchDir(stateDir);
  }
});
