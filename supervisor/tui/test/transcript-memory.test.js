// transcript-memory.test.js — ChatGPT review, 2026-09-14: `transcripts = new Map()` in `app.js` was
// never pruned. `MAX_LINES_PER_RUN` bounds each run's OWN transcript, but nothing bounded the Map
// itself — confirmed real before fixing (see app.js's `pruneTranscripts` header for the exact
// reasoning): a long-lived TUI session accumulates one entry per run the server has EVER reported,
// forever, since `tuiSnapshot` sends every run system-wide on every tick with no per-tick filtering.
//
// Driven entirely through `createTuiApp`'s real `refresh()` with a scripted fake client — no real
// socket needed, same technique `runtime/test/tui-replay.test.js`'s own case 6/7 already use for this
// exact function's OTHER behaviors.
//
// Cases:
//   1. a run whose row disappears from the server's `runs` list (a cleaned-up preflight) has its
//      transcript entry dropped on the very next refresh
//   2. the total number of tracked transcripts is capped — once the cap is exceeded, the LEAST recently
//      touched entries are evicted first
//   3. a run still being ACTIVELY DISPLAYED (its lines read every tick via the dev pane) is never evicted
//      just because it produced no new lines, even once the cap is under real pressure

import assert from "node:assert/strict";
import { createTuiApp } from "../app.js";

let failed = 0;
let n = 0;
const cases = [];
function testCase(name, fn) { cases.push({ name, fn }); }

function fakeIo() {
  return { out: { write() {}, columns: 100, rows: 30, on() {} }, input: { on() {}, resume() {}, pause() {} } };
}

testCase("a run whose row disappears from the server's runs list has its transcript entry dropped on the next refresh", async () => {
  const { out, input } = fakeIo();
  let snap = {
    ok: true, teams: [], tasks: [], workers: [],
    runs: [{ runId: "r-preflight", workerId: "w1", endedAt: null, lastEventAt: "2026-09-14T00:00:00.000Z", controllable: true }],
    transcripts: { "r-preflight": ["probing model health"] }, provisional: {}, cursors: { "r-preflight": 1 }, gaps: {},
    requests: [], asks: [],
  };
  const app = createTuiApp({ client: { request: async () => snap }, out, input });
  await app.refresh();
  assert.ok(app.transcriptState().has("r-preflight"), "precondition: the transcript was actually recorded");

  // The preflight's row is cleaned up — real behavior, per PLAN.md 12.1 — so the NEXT snapshot no
  // longer mentions it at all, in either `runs` or `transcripts`.
  snap = { ...snap, runs: [], transcripts: {}, cursors: {} };
  await app.refresh();
  assert.equal(app.transcriptState().has("r-preflight"), false, "a run no longer reported by the server must not linger in the client's transcript map forever");
});

testCase("the total number of tracked transcripts is capped, evicting the least recently touched entries first", async () => {
  const { out, input } = fakeIo();
  const CAP = 200; // must match app.js's own MAX_TRACKED_RUNS
  const runs = [];
  const transcripts = {};
  const cursors = {};
  for (let i = 0; i < CAP + 5; i += 1) {
    const runId = `r${i}`;
    runs.push({ runId, workerId: `w${i}`, endedAt: "2026-09-14T00:00:00.000Z", lastEventAt: "2026-09-14T00:00:00.000Z", controllable: true });
    transcripts[runId] = [`line for ${runId}`];
    cursors[runId] = 1;
  }
  const snap = { ok: true, teams: [], tasks: [], workers: [], runs, transcripts, provisional: {}, cursors, gaps: {}, requests: [], asks: [] };
  const app = createTuiApp({ client: { request: async () => snap }, out, input });
  await app.refresh();

  const state = app.transcriptState();
  assert.equal(state.size, CAP, `expected the tracked-transcript count to be capped at ${CAP}, got ${state.size}`);
  // Eviction order is oldest-touched-first: the FIRST runs fed (r0, r1, ...) were touched earliest in
  // this same tick, so they are the ones evicted, not an arbitrary subset.
  assert.equal(state.has("r0"), false, "the oldest-touched entries must be the ones evicted");
  assert.equal(state.has(`r${CAP + 4}`), true, "the most-recently-touched entries must survive");
});

testCase("a run actively displayed in a pane is never evicted just because it produced no new lines", async () => {
  const { out, input } = fakeIo();
  const CAP = 200;
  const workers = [{ workerId: "w-pinned", nickname: "purus", role: "coder", taskId: "task-1" }];
  const tasks = [{ id: "task-1", title: "long task", teamId: "team-1", state: "implementing", type: "feature" }];
  const teams = [{ id: "team-1", name: "Team" }];
  const runs = [{ runId: "r-pinned", workerId: "w-pinned", endedAt: null, lastEventAt: "2026-09-14T00:00:00.000Z", controllable: true }];
  for (let i = 0; i < CAP + 20; i += 1) {
    runs.push({ runId: `noise${i}`, workerId: `noise-worker${i}`, endedAt: "2026-09-14T00:00:00.000Z", lastEventAt: "2026-09-14T00:00:00.000Z", controllable: true });
  }
  const baseSnap = { ok: true, teams, tasks, workers, runs, provisional: {}, gaps: {}, requests: [], asks: [] };

  // `createTuiApp` exposes no client setter, so the client's own `request` is a thin forwarder to a
  // reassignable handler — the same "inject the seam, not the object" shape `runtime/test/
  // tui-replay.test.js`'s scripted-client cases already use, just mutable across ticks here.
  let currentHandler = async () => ({
    ...baseSnap,
    transcripts: { "r-pinned": ["pinned worker said something once"] },
    cursors: { "r-pinned": 1 },
  });
  const app = createTuiApp({ client: { request: (...args) => currentHandler(...args) }, out, input });
  app.state = { ...app.state, selectedNodeId: "task-1" };
  await app.refresh(); // r-pinned gets real content and is selected; every noise run gets its own entry too

  // Several more ticks with NO new lines for r-pinned at all (its cursor stays put, matching a worker
  // that has gone quiet but is still the one on screen) — noise runs keep arriving fresh each time,
  // which is what actually creates the eviction pressure this case needs.
  for (let round = 0; round < 5; round += 1) {
    const freshNoise = runs.filter((r) => r.runId !== "r-pinned").map((r, i) => ({ ...r, runId: `round${round}-noise${i}` }));
    currentHandler = async () => ({
      ...baseSnap,
      runs: [runs[0], ...freshNoise],
      transcripts: {},
      cursors: {},
    });
    await app.refresh();
  }

  assert.ok(app.transcriptState().has("r-pinned"), "the actively-displayed run must survive real eviction pressure from many other runs, even with zero new lines of its own");
});

for (const { name, fn } of cases) {
  n += 1;
  try {
    await fn();
    console.log(`  ${n}. ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL: ${name}`);
    console.error(err);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${n} case(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: transcript-memory (${n} cases)`);
}
