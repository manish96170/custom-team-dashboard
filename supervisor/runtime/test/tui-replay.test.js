// tui-replay.test.js — the TUI's transcripts are replayed BY CURSOR (FLOWS §5), over a real socket.
//
// WHY THIS IS A RUNTIME SUITE AND NOT A PURE ONE
//
// `tui/test/tui.test.js` proves the layout and the focus model without a terminal, and it cannot prove
// this: replay is a protocol between the TUI and the supervisor, over the wire, against a real event
// stream. Until now the TUI re-read "the last 60 events" every tick, which looks identical to replay for
// any run shorter than 60 events — so the only way to tell the two apart is a run that is longer.
//
// The three properties, and each is a thing the old projection got wrong:
//   * a cursor RESUMES: the second read returns only what is new, not the window again
//   * a gap is ANNOUNCED, not closed up: a pane that silently skips events shows a hole that looks
//     exactly like a worker having said nothing
//   * prose that is still being written is PROVISIONAL, so a poll landing mid-turn does not commit half
//     a sentence as a finished line — the "one fragment per line" defect (§28) from a new direction
//
// Cases:
//   1. a first read with no cursor backfills, and returns a cursor
//   2. a second read at that cursor returns NOTHING new — replay resumes, it does not repeat
//   3. new events after the cursor come back, and only those
//   4. a slice smaller than what arrived reports the gap it skipped
//   5. tier-2 digests never appear in a human's transcript
//   6. `applyTranscripts` in the app accumulates across ticks, announces the gap, and replaces
//      provisional prose rather than appending it
//   7. the dev pane follows the MOST RECENTLY ACTIVE coder, unless pinned (FLOWS §5)
//   8. a finished review CLEARS the review bar — a stale one states a condition the system has left
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import net from "node:net";
import {
  openDb, closeDb, upsertHarness, createWorker, createTask, createRun, recordEvent, listTier1EventsSince,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createIpcServer } from "../../ipc/server.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { createTuiApp } from "../../tui/app.js";
import { makeScratchDir, rmScratchDir, runTest, sleep } from "./_helpers.js";
import { sockPath } from "../../paths.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

/** One request over a real socket — the shape the TUI itself uses. */
function request(sock, cmd, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = "";
    const done = (fn, v) => { try { c.destroy(); } catch { /* gone */ } fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`timed out waiting for ${cmd.cmd}`)), timeoutMs);
    c.setEncoding("utf8");
    c.on("connect", () => c.write(`${JSON.stringify(cmd)}\n`));
    c.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      try { done(resolve, JSON.parse(buf.slice(0, nl))); } catch (e) { done(reject, e); }
    });
    c.on("error", (err) => { clearTimeout(timer); done(reject, err); });
  });
}

await runTest("tui replay by cursor", async () => {
  const stateDir = makeScratchDir("supervisor-tui-replay-test");
  let db;
  let supervisor;
  let ipc;

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake" });
    createTask(db, { id: "t1", title: "replay", type: "feature" });
    createWorker(db, { workerId: "w1", nickname: "purus", role: "coder", taskId: "t1" });
    createRun(db, { runId: "r1", workerId: "w1", harnessId: "fake", prompt: "replay me" });

    supervisor = createSupervisor({ db, adapters: { fake: createFakeHarness({ label: "replay" }) }, askSweepIntervalMs: 0, logger: quiet });
    await supervisor.boot();
    ipc = createIpcServer({ commands: supervisor.commandHandlers() });
    const sock = sockPath(stateDir);
    await ipc.listen(sock);

    // A run with real history, written directly so the arithmetic is exact rather than timing-dependent.
    // Deltas and discrete events interleaved, because the coalescing rule is what makes the cursor
    // subtle: only `assistant.delta` joins, and only when adjacent.
    const say = (text) => recordEvent(db, { runId: "r1", tier: 1, type: "assistant.delta", payload: { text } });
    recordEvent(db, { runId: "r1", tier: 1, type: "turn.start", payload: { turn: 1 } });
    say("first ");
    say("line");
    recordEvent(db, { runId: "r1", tier: 1, type: "tool.start", payload: { toolName: "Read" } });
    recordEvent(db, { runId: "r1", tier: 1, type: "tool.result", payload: { isError: false } });
    recordEvent(db, { runId: "r1", tier: 1, type: "turn.end", payload: { status: "completed" } });

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    let cursor;
    {
      const snap = await request(sock, { id: "s1", cmd: "tuiSnapshot" });
      assert.equal(snap.ok, true);
      const lines = snap.transcripts["r1"];
      assert.deepEqual(lines, ["· turn.start", "first line", "· Read", "· tool ok", "— turn completed"],
        `a first read backfills, with adjacent deltas coalesced; got ${JSON.stringify(lines)}`);
      cursor = snap.cursors["r1"];
      assert.ok(Number.isInteger(cursor) && cursor > 0, `a cursor must come back with it; got ${cursor}`);
      assert.equal(snap.provisional["r1"], null, "nothing is in flight — the last event was a turn.end");
      assert.equal(snap.gaps?.["r1"], undefined, "and nothing was skipped");
      console.log("  1. a first read backfills and returns a cursor");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    // The property that distinguishes replay from re-reading a window, and the one the old projection
    // could not have: at the cursor, there is nothing to say.
    {
      const snap = await request(sock, { id: "s2", cmd: "tuiSnapshot", cursors: { r1: cursor } });
      assert.deepEqual(snap.transcripts["r1"], [],
        "a read at the cursor returns nothing new — re-reading the window would return all four lines again");
      assert.equal(snap.cursors["r1"], cursor, "and the cursor does not move when nothing happened");
      console.log("  2. a read at the cursor returns nothing new");
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      recordEvent(db, { runId: "r1", tier: 1, type: "turn.start", payload: { turn: 2 } });
      say("second ");
      say("line");
      const midTurn = await request(sock, { id: "s3", cmd: "tuiSnapshot", cursors: { r1: cursor } });
      assert.deepEqual(midTurn.transcripts["r1"], ["· turn.start"],
        "only the settled events come back as lines");
      // The prose is still being written, so it is PROVISIONAL — committing it now would print
      // "second line" and then print the rest of the sentence as a second line on the next tick.
      assert.equal(midTurn.provisional["r1"], "second line",
        "trailing prose is provisional, not a finished line");
      const midCursor = midTurn.cursors["r1"];
      assert.ok(midCursor > cursor, "the cursor advanced past the settled events");

      say(" and more");
      recordEvent(db, { runId: "r1", tier: 1, type: "turn.end", payload: { status: "completed" } });
      const settled = await request(sock, { id: "s4", cmd: "tuiSnapshot", cursors: { r1: midCursor } });
      assert.deepEqual(settled.transcripts["r1"], ["second line and more", "— turn completed"],
        `the whole sentence lands as ONE line once the turn ends; got ${JSON.stringify(settled.transcripts["r1"])}`);
      assert.equal(settled.provisional["r1"], null, "and nothing is in flight any more");
      cursor = settled.cursors["r1"];
      console.log("  3. new events come back once, and prose settles into one line");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    // A gap must be a NUMBER a pane can print, not a silently shorter list. This is the same contract
    // the pump's `gap` frames give the pane (`pane/render.js`).
    {
      for (let i = 0; i < 10; i += 1) {
        recordEvent(db, { runId: "r1", tier: 1, type: "tool.start", payload: { toolName: `T${i}` } });
      }
      const snap = await request(sock, { id: "s5", cmd: "tuiSnapshot", cursors: { r1: cursor }, transcriptLimit: 4 });
      assert.equal(snap.gaps["r1"], 6, `10 events arrived and 4 were asked for, so 6 were skipped; got ${snap.gaps["r1"]}`);
      assert.deepEqual(snap.transcripts["r1"], ["· T6", "· T7", "· T8", "· T9"],
        "and the NEWEST are the ones kept — a pane is a window on now");
      cursor = snap.cursors["r1"];

      // The db function agrees, at the level below the wire.
      const direct = listTier1EventsSince(db, "r1", { afterSeq: 0, limit: 3 });
      assert.equal(direct.rows.length, 3);
      assert.ok(direct.skipped > 0, "and it reports what it left out rather than returning a short list quietly");
      console.log("  4. a gap is reported as a count, with the newest events kept");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    // Tier 2 shares `event_log` (Rule 4). A digest is a summary written FOR AGENTS; putting it in a
    // human's pane would show them a paraphrase of the transcript they are already reading.
    {
      recordEvent(db, {
        runId: "r1", tier: 2, type: "turn.digest",
        payload: { turnIndex: 0, summary: "DIGEST-SHOULD-NOT-APPEAR", assumptions: [], source: "extractive" },
      });
      const snap = await request(sock, { id: "s6", cmd: "tuiSnapshot", cursors: { r1: cursor } });
      const text = JSON.stringify(snap.transcripts["r1"]) + JSON.stringify(snap.provisional["r1"]);
      assert.equal(text.includes("DIGEST-SHOULD-NOT-APPEAR"), false,
        "a tier-2 digest must never reach a human's transcript");
      assert.equal(text.includes("turn.digest"), false, "not even as an unknown event type");
      console.log("  5. tier-2 digests stay out of the human transcript");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    // The client half. `applyTranscripts` is what turns a sequence of slices into a pane, and every one
    // of its three rules is a thing that looks fine for one tick and wrong over three.
    {
      const app = createTuiApp({
        client: { request: async () => ({ ok: false }) },
        out: { write() {}, columns: 100, rows: 30, on() {} },
        input: { on() {}, resume() {}, pause() {} },
      });
      // Driven through `refresh()` with a scripted client, so this exercises the real code path rather
      // than a re-implementation of it.
      const script = [
        { ok: true, teams: [], tasks: [], workers: [], runs: [], transcripts: { r1: ["one"] }, provisional: { r1: "half a sen" }, cursors: { r1: 5 }, gaps: {} },
        { ok: true, teams: [], tasks: [], workers: [], runs: [], transcripts: { r1: [] }, provisional: { r1: "half a sentence" }, cursors: { r1: 5 }, gaps: {} },
        { ok: true, teams: [], tasks: [], workers: [], runs: [], transcripts: { r1: ["half a sentence", "two"] }, provisional: { r1: null }, cursors: { r1: 9 }, gaps: { r1: 3 } },
      ];
      let i = 0;
      const scripted = createTuiApp({
        client: { request: async () => script[Math.min(i++, script.length - 1)] },
        out: { write() {}, columns: 100, rows: 30, on() {} },
        input: { on() {}, resume() {}, pause() {} },
      });
      void app;

      await scripted.refresh();
      let t = scripted.transcriptState().get("r1");
      assert.deepEqual(t.lines, ["one"], "settled lines accumulate");
      assert.equal(t.provisional, "half a sen");
      assert.equal(t.cursor, 5);

      await scripted.refresh();
      t = scripted.transcriptState().get("r1");
      assert.deepEqual(t.lines, ["one"], "an unchanged cursor must not duplicate what is already there");
      assert.equal(t.provisional, "half a sentence",
        "and the growing prose REPLACES the fragment rather than being appended after it");

      await scripted.refresh();
      t = scripted.transcriptState().get("r1");
      assert.equal(t.provisional, null, "a settled line clears the provisional one");
      assert.deepEqual(
        t.lines,
        ["one", "⚠ 3 event(s) were not replayed into this pane (resuming at seq 5)", "half a sentence", "two"],
        `the gap is announced IN the transcript, in order; got ${JSON.stringify(t.lines)}`,
      );
      assert.equal(t.cursor, 9);
      console.log("  6. the app accumulates across ticks, announces the gap, and replaces provisional prose");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    // FLOWS §5: the dev pane shows the "last-active dev run (by most-recent-message, unless pinned)".
    // Previously it showed the first worker whose role was `coder` — the same answer whenever a task has
    // one coder, and a silently wrong one when it has two: the pane would follow whichever the registry
    // listed first, indefinitely, while the other one did the work.
    {
      const snapshot = {
        ok: true,
        teams: [{ id: "team", name: "T" }],
        tasks: [{ id: "task", title: "two coders", teamId: "team", state: "implementing", type: "feature" }],
        workers: [
          { workerId: "wa", nickname: "ana", role: "coder", taskId: "task" },
          { workerId: "wb", nickname: "bo", role: "coder", taskId: "task" },
        ],
        runs: [
          { runId: "ra", workerId: "wa", endedAt: null, lastEventAt: "2026-09-08T10:00:00.000Z", controllable: true },
          { runId: "rb", workerId: "wb", endedAt: null, lastEventAt: "2026-09-08T11:00:00.000Z", controllable: true },
        ],
        transcripts: { ra: ["ana said something"], rb: ["bo said something later"] },
        provisional: {}, cursors: { ra: 1, rb: 2 }, gaps: {}, requests: [], asks: [],
      };
      const app = createTuiApp({
        client: { request: async () => snapshot },
        out: { write() {}, columns: 100, rows: 30, on() {} },
        input: { on() {}, resume() {}, pause() {} },
      });
      await app.refresh();
      assert.equal(app.state.panes[0].title.startsWith("bo"),
        true, `the dev pane must follow the MOST RECENTLY active coder; got ${app.state.panes[0].title}`);

      // ...unless pinned. FLOWS §5: `m` "overrides the most-recent-message default until unpinned".
      app.state = { ...app.state, selectedNodeId: "wa" };
      await app.handleKey("m");
      await app.refresh();
      assert.equal(app.state.pinnedWorkerId, "wa");
      assert.equal(app.state.panes[0].title.startsWith("ana"), true,
        "a pin must beat recency, or pinning would appear to do nothing while the other worker talks");

      await app.handleKey("m");
      await app.refresh();
      assert.equal(app.state.pinnedWorkerId, null);
      assert.equal(app.state.panes[0].title.startsWith("bo"), true, "and unpinning returns to recency");
      console.log("  7. the dev pane follows the most recently active coder, unless pinned");
    }

    // ── 8 ────────────────────────────────────────────────────────────────────────────
    // The review bar must CLEAR when the review is over (PLAN.md §13, ROADMAP Phase 6). Two ticks, because a
    // single snapshot cannot show the difference between "read from this tick" and "kept from the last one" —
    // and a sticky bar states a condition the system has already left, which is the kind of stale claim this
    // project treats as a defect rather than a cosmetic issue.
    {
      const base = {
        ok: true,
        teams: [{ id: "team", name: "T" }],
        tasks: [{ id: "task", title: "under review", teamId: "team", state: "awaiting-review", type: "feature" }],
        workers: [{ workerId: "wr", nickname: "rev", role: "coder", taskId: "task" }],
        runs: [{ runId: "rr", workerId: "wr", endedAt: null, lastEventAt: "2026-09-09T00:00:00.000Z", controllable: true }],
        transcripts: { rr: ["working"] }, provisional: {}, cursors: { rr: 1 }, gaps: {}, requests: [], asks: [],
      };
      const script = [
        { ...base, reviews: { task: { round: 1, approved: false, dimensions: {}, quorum: { required: 2, distinctReviewers: 1 }, reasons: ["quorum not met"] } } },
        // Round over: the task moved on and the supervisor reports no review for it any more.
        { ...base, tasks: [{ ...base.tasks[0], state: "approved" }], reviews: {} },
      ];
      let i = 0;
      const app = createTuiApp({
        client: { request: async () => script[Math.min(i++, script.length - 1)] },
        out: { write() {}, columns: 100, rows: 30, on() {} },
        input: { on() {}, resume() {}, pause() {} },
      });

      await app.refresh();
      assert.ok(app.state.review, "tick one: a review is in flight, so the bar has input");
      assert.equal(app.state.review.approved, false);

      await app.refresh();
      assert.equal(app.state.review, null,
        "tick two: the review is over, so the bar must CLEAR rather than keep the last evaluation");
      console.log("  8. a finished review clears the review bar");
    }
  } finally {
    try { if (ipc) await ipc.shutdown(); } catch { /* teardown */ }
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* teardown */ }
    try { if (db) closeDb(db); } catch { /* teardown */ }
    await sleep(150);
    rmScratchDir(stateDir);
  }
});
