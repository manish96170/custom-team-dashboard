#!/usr/bin/env node
// capture-frames.mjs — render the demo dashboard HEADLESSLY and print the frames.
//
//   node supervisor/tui/capture-frames.mjs > supervisor/tui/evidence/01-demo-frames.txt
//
// WHY THIS EXISTS AS A FILE RATHER THAN A ONE-OFF
//
// The Phase 4 frames were captured by a throwaway script, and the demo has since found three real
// integration bugs that no unit test caught (§28) — because someone LOOKED at the output. That only keeps
// happening if looking is one command. Every frame here is produced by the same `renderFrame` the TUI
// paints, against a real supervisor, a real event pump and a real socket with a fake harness, so what is
// printed is what a terminal would show.
//
// It is not a test and does not assert: `tui/test/tui.test.js` and `runtime/test/tui-replay.test.js` do
// that. This is for the failures assertions are bad at — a panel one row too tall, a truncated status
// line, two panes that disagree about which team is active.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { renderFrame, frameGeometry, hitTest } from "./layout.js";
import { createTuiApp } from "./app.js";
import { sockPath } from "../paths.js";

const SIZE = { cols: Number(process.env.COLUMNS) || 118, rows: Number(process.env.LINES) || 30 };

const { openDb, closeDb, upsertHarness, createWorker, createTask, recordTransition } = await import("../db/index.js");
const { createSupervisor } = await import("../runtime/supervisor.js");
const { createIpcServer } = await import("../ipc/server.js");
const { createFakeHarness } = await import("../runtime/test/_fake-harness-adapter.js");

const stateDir = path.join(os.homedir(), ".custom-team-dashboard", "tui-capture");
fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true });

const db = openDb({ stateDir });
upsertHarness(db, { id: "fake", displayName: "Mock Harness", status: "active" });
db.prepare("INSERT INTO teams (id, name, hidden_from_top_bar) VALUES ('team-vite','Vite Migration',0)").run();
db.prepare("INSERT INTO teams (id, name, hidden_from_top_bar) VALUES ('team-lint','Biome Lint',0)").run();
createTask(db, { id: "task-vite", title: "Invert the Vite tweak", type: "feature", teamId: "team-vite" });
createTask(db, { id: "task-rev", title: "Review the inversion", type: "review", teamId: "team-vite" });
createTask(db, { id: "task-lint", title: "Fix biome rule 42", type: "bug", teamId: "team-lint" });
createWorker(db, { workerId: "w-coder", nickname: "purus", role: "coder", taskId: "task-vite", teamId: "team-vite" });
createWorker(db, { workerId: "w-rev1", nickname: "luna", role: "reviewer", taskId: "task-vite", teamId: "team-vite" });
createWorker(db, { workerId: "w-rev2", nickname: "terra", role: "reviewer", taskId: "task-vite", teamId: "team-vite" });
createWorker(db, { workerId: "w-lint", nickname: "kimi", role: "coder", taskId: "task-lint", teamId: "team-lint" });
// The reviewer ON the review task. Missing in the first version of this script, and the captured frame showed
// "(no pane — select a task or worker in the tree)" under a review bar — a task with a review in flight and
// nobody on it, which is not a state worth putting in the evidence.
createWorker(db, { workerId: "w-revlead", nickname: "sol", role: "reviewer", taskId: "task-rev", teamId: "team-vite" });
recordTransition(db, { id: "d1", taskId: "task-vite", fromState: "created", toState: "starting", actor: "cto" });
recordTransition(db, { id: "d2", taskId: "task-vite", fromState: "starting", toState: "planning", actor: "purus" });
recordTransition(db, { id: "d3", taskId: "task-vite", fromState: "planning", toState: "implementing", actor: "purus" });

const nowIso = new Date().toISOString();
const insertRequest = db.prepare(
  `INSERT INTO requests (id, type, channel, mentioned_handle, raw_text, posted_by, status, created_at, updated_at)
   VALUES (?, 'review', ?, '@you', ?, ?, 'pending', ?, ?)`,
);
insertRequest.run("req-1", "#your-mr-channel", "@you please review !4821 before standup", "nj", nowIso, nowIso);
insertRequest.run("req-2", "#team-planning", "can we pull the lint fix into this sprint?", "asha", nowIso, nowIso);

// A review in flight, so the review bar (PLAN.md §13, ROADMAP Phase 6) appears in the captured frames
// rather than only in a test. Verdicts are written directly: what the bar renders is the EVALUATED rule from
// the snapshot, and the point of the capture is to look at that rendering.
recordTransition(db, { id: "r1", taskId: "task-rev", fromState: "created", toState: "starting", actor: "cto" });
recordTransition(db, { id: "r2", taskId: "task-rev", fromState: "starting", toState: "planning", actor: "sol" });
recordTransition(db, { id: "r3", taskId: "task-rev", fromState: "planning", toState: "implementing", actor: "sol" });
recordTransition(db, { id: "r4", taskId: "task-rev", fromState: "implementing", toState: "awaiting-review", actor: "sol" });
const { recordReviewVerdict } = await import("../db/index.js");
recordReviewVerdict(db, {
  taskId: "task-rev", workerId: "w-revlead", slot: "reviewer1", round: 2, commitSha: "abc1234",
  dimension: "correctness", verdict: "approved",
});
recordReviewVerdict(db, {
  taskId: "task-rev", workerId: "w-revlead", slot: "reviewer1", round: 2, commitSha: "abc1234",
  dimension: "security", verdict: "changes-requested",
  findings: [{ file: "checkout/app.ts", line: 42, summary: "token logged in plaintext", verdict: "unverified" }],
});

const harness = createFakeHarness({ label: "capture" });
const supervisor = createSupervisor({
  db, adapters: { fake: harness }, askSweepIntervalMs: 0, logger: { log() {}, warn() {}, error() {} },
});
await supervisor.boot();
for (const workerId of ["w-coder", "w-rev1", "w-rev2", "w-lint"]) {
  await supervisor.start({ harnessId: "fake", workerId, spec: { cwd: stateDir, prompt: `demo work for ${workerId}` } });
}
// The AUTHORIZED map, like the daemon and `--demo`: frames captured against a surface production does not
// serve would be evidence of the wrong thing.
const ipc = createIpcServer({ commands: supervisor.authorizedCommandHandlers() });
const sock = sockPath(stateDir);
await ipc.listen(sock);

/** The same one-shot client `cli.js` uses. */
function createClient(socketPath, token) {
  let seq = 0;
  return {
    request(cmd) {
      if (token) cmd = { ...cmd, token };
      return new Promise((resolve, reject) => {
        const s = net.createConnection(socketPath);
        let buf = "";
        const done = (fn, v) => { try { s.destroy(); } catch { /* gone */ } fn(v); };
        const timer = setTimeout(() => done(reject, new Error("timed out")), 5000);
        s.setEncoding("utf8");
        s.on("connect", () => s.write(`${JSON.stringify({ id: `cap-${++seq}`, ...cmd })}\n`));
        s.on("data", (d) => {
          buf += d;
          const nl = buf.indexOf("\n");
          if (nl === -1) return;
          clearTimeout(timer);
          try { done(resolve, JSON.parse(buf.slice(0, nl))); } catch (e) { done(reject, e); }
        });
        s.on("error", (err) => { clearTimeout(timer); done(reject, err); });
      });
    },
  };
}

// A sink for `out`, so nothing is painted while frames are being collected.
const sink = { write() {}, columns: SIZE.cols, rows: SIZE.rows, on() {} };
const ownerToken = fs.readFileSync(path.join(stateDir, "owner.token"), "utf8").trim();
const app = createTuiApp({ client: createClient(sock, ownerToken), out: sink, input: { on() {}, resume() {}, pause() {} } });

const lines = [];
const say = (t = "") => lines.push(t);
const frame = (label) => {
  say(`## ${label}`);
  for (const l of renderFrame(app.state, SIZE)) say(l);
  say("");
};

say(`# TUI demo frames (Phase 4), captured headlessly at ${SIZE.cols}x${SIZE.rows} from:`);
say("#   node supervisor/tui/capture-frames.mjs");
say("# Real supervisor, real event pump, real socket, fake harness. No tokens.");
say("");

// Two refreshes, deliberately: the first backfills the transcript from the cursor's start, the second
// proves the pane KEEPS what it had rather than re-reading a window (FLOWS §5's replay by cursor).
await app.refresh();
await new Promise((r) => setTimeout(r, 600));
await app.refresh();

frame("default: first team (alphabetical), the Requests panel present because two requests are pending");

await app.handleKey("l");
await app.refresh();
frame("after `l`: the Vite team, dev + reviewer split");

// Select the task that is under review, so the review bar has something to say.
app.state = { ...app.state, selectedNodeId: "task-rev" };
await app.refresh();
frame("the task under review: the REVIEW BAR says which of section 13's conditions is short");

// A CLICK, resolved through the same `hitTest` the app uses — this is the mouse path, headlessly.
const g = frameGeometry(app.state, SIZE);
const requestsTarget = hitTest(app.state, SIZE, 5, g.requests.top + 2);
await app.handleClick({ col: 5, row: g.requests.top + 2 });
frame(`click on the Requests panel at row ${g.requests.top + 2} (hit: ${JSON.stringify(requestsTarget)}) — focused, and the status line says how to hide it`);

await app.handleKey("h");
frame("then `h`: the panel is hidden and the pane area grows — the same key that moves teams elsewhere");

await app.handleKey("r");
frame("`r`: all reviewer panes hidden, dev pane auto-expands (FLOWS section 5: no dead space)");

await app.handleKey("/");
for (const ch of "hello") await app.handleKey(ch);
frame("`/` then typing: letters are TEXT in the chat bar, not commands");

// What the panes are actually holding, which the frames only show 40 lines of.
say("## accumulated transcript state (replay cursors)");
for (const [runId, t] of app.transcriptState()) {
  say(`  ${runId}: cursor=${t.cursor} lines=${t.lines.length} provisional=${JSON.stringify(t.provisional)}`);
}
say("");

process.stdout.write(`${lines.join("\n")}\n`);

try { await ipc.shutdown(); } catch { /* teardown */ }
try { await supervisor.shutdown({ timeoutMs: 3000 }); } catch { /* teardown */ }
try { await harness.disposeAll?.({ graceMs: 300 }); } catch { /* teardown */ }
try { closeDb(db); } catch { /* teardown */ }
fs.rmSync(stateDir, { recursive: true, force: true });
process.exit(0);
