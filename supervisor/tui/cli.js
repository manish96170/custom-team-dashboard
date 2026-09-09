#!/usr/bin/env node
// cli.js — run the dashboard TUI (Phase 4).
//
//   node supervisor/tui/cli.js --demo     # self-contained: no daemon, no tokens, no setup
//   node supervisor/tui/cli.js            # attach to a running supervisor over its socket
//
// WHY `--demo` EXISTS AND WHY IT IS THE DEFAULT THING TO REACH FOR
//
// ROADMAP Phase 4: "deterministic and cheap because it's built against Phase 0b's mock harness, not a
// real one — no tokens burned iterating on layout." Demo mode is that instruction made runnable. It
// starts a supervisor, a fake harness, two teams, three tasks and five workers IN THIS PROCESS, runs
// real runs through the real event pump, and points the TUI at them over a real socket. Everything is
// real except the harness — so what you see is the actual layout driven by actual supervisor state,
// and it costs nothing.
//
// It is also the honest way to look at a UI before the CTO agent exists: the bottom chat bar is wired
// to a recipient that is Phase 6, so it REFUSES rather than pretending (see `tuiChat`).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createTuiApp } from "./app.js";
import { sockPath, stateDir as defaultStateDir } from "../paths.js";

const DEMO = process.argv.includes("--demo");

/**
 * A minimal request/response client over the control socket.
 *
 * Hand-rolled for the same reason the hook's is (`hooks/claude-session-hook.mjs`): `ipc/client.js`
 * says of itself that it is a test client, and this needs one behaviour it does not have — a clear
 * error when the supervisor is absent, so the TUI can SAY "supervisor unreachable" in its status line
 * instead of dying with a stack trace over the alternate screen buffer.
 */
function createClient(socketPath, { token = null } = {}) {
  let seq = 0;
  return {
    request(cmd) {
      // The principal token rides on every request (PLAN.md §16). The TUI is a socket client like any other, so
      // it authenticates like any other — and `--demo` therefore exercises the SAME authorized path the daemon
      // serves, rather than a raw command map that only exists in-process. A demo that skips the gate would be
      // the one place the gate is never tested.
      if (token) cmd = { ...cmd, token };
      return new Promise((resolve, reject) => {
        const sock = net.createConnection(socketPath);
        let buf = "";
        const done = (fn, v) => { try { sock.destroy(); } catch { /* already gone */ } fn(v); };
        const timer = setTimeout(() => done(reject, new Error("timed out")), 5000);
        sock.setEncoding("utf8");
        sock.on("connect", () => sock.write(`${JSON.stringify({ id: `tui-${++seq}`, ...cmd })}\n`));
        sock.on("data", (d) => {
          buf += d;
          const nl = buf.indexOf("\n");
          if (nl === -1) return;
          clearTimeout(timer);
          try { done(resolve, JSON.parse(buf.slice(0, nl))); } catch (e) { done(reject, e); }
        });
        sock.on("error", (err) => { clearTimeout(timer); done(reject, err); });
        sock.on("close", () => { clearTimeout(timer); });
      });
    },
  };
}

/** Everything demo mode needs, torn down on exit. Returns the socket path to point the TUI at. */
async function startDemo() {
  const { openDb, closeDb, upsertHarness, createWorker, createTask, recordTransition } = await import("../db/index.js");
  const { createSupervisor } = await import("../runtime/supervisor.js");
  const { createIpcServer } = await import("../ipc/server.js");
  const { createFakeHarness } = await import("../runtime/test/_fake-harness-adapter.js");

  // ONE FIXED directory, reused, not a fresh `mkdtemp` per run. The demo is torn down cleanly on
  // SIGINT/SIGTERM, but a SIGKILL bypasses teardown by definition — and a demo people are meant to
  // run repeatedly must not leave a directory behind each time it is killed. (36 of them accumulated
  // while capturing frames for the docs, which is how this was noticed.) Recreated on each start, so
  // every demo still begins from an empty database.
  const stateDir = path.join(os.homedir(), ".custom-team-dashboard", "tui-demo");
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const db = openDb({ stateDir });
  upsertHarness(db, { id: "fake", displayName: "Mock Harness", status: "active" });

  // Two teams so the team bar has something to move across; a review task so the split pane and the
  // reviewer toggles (1 / 2 / p / r) have panes to toggle.
  db.prepare("INSERT INTO teams (id, name, hidden_from_top_bar) VALUES ('team-vite','Vite Migration',0)").run();
  db.prepare("INSERT INTO teams (id, name, hidden_from_top_bar) VALUES ('team-lint','Biome Lint',0)").run();

  createTask(db, { id: "task-vite", title: "Invert the Vite tweak", type: "feature", teamId: "team-vite" });
  createTask(db, { id: "task-rev", title: "Review the inversion", type: "review", teamId: "team-vite" });
  createTask(db, { id: "task-lint", title: "Fix biome rule 42", type: "bug", teamId: "team-lint" });

  createWorker(db, { workerId: "w-coder", nickname: "purus", role: "coder", taskId: "task-vite", teamId: "team-vite" });
  createWorker(db, { workerId: "w-rev1", nickname: "luna", role: "reviewer", taskId: "task-vite", teamId: "team-vite" });
  createWorker(db, { workerId: "w-rev2", nickname: "terra", role: "reviewer", taskId: "task-vite", teamId: "team-vite" });
  createWorker(db, { workerId: "w-revlead", nickname: "sol", role: "reviewer", taskId: "task-rev", teamId: "team-vite" });
  createWorker(db, { workerId: "w-lint", nickname: "kimi", role: "coder", taskId: "task-lint", teamId: "team-lint" });

  // PLAN.md section 6's real states — enforced as of Phase 5, so the demo has to walk the real path.
  recordTransition(db, { id: "d1", taskId: "task-vite", fromState: "created", toState: "starting", actor: "cto" });
  recordTransition(db, { id: "d2", taskId: "task-vite", fromState: "starting", toState: "planning", actor: "purus" });
  recordTransition(db, { id: "d3", taskId: "task-vite", fromState: "planning", toState: "implementing", actor: "purus" });
  recordTransition(db, { id: "d4", taskId: "task-rev", fromState: "created", toState: "starting", actor: "cto" });
  recordTransition(db, { id: "d5", taskId: "task-rev", fromState: "starting", toState: "planning", actor: "sol" });
  recordTransition(db, { id: "d6", taskId: "task-rev", fromState: "planning", toState: "implementing", actor: "sol" });
  recordTransition(db, { id: "d7", taskId: "task-rev", fromState: "implementing", toState: "awaiting-review", actor: "sol" });

  const harness = createFakeHarness({ label: "demo" });
  const supervisor = createSupervisor({ db, adapters: { fake: harness }, askSweepIntervalMs: 0,
    logger: { log() {}, warn() {}, error() {} } });
  await supervisor.boot();

  // Real runs through the real pump, so the panes show real event_log content rather than a fixture.
  const started = [];
  for (const workerId of ["w-coder", "w-rev1", "w-rev2", "w-lint"]) {
    const { runId } = await supervisor.start({
      harnessId: "fake", workerId,
      spec: { cwd: stateDir, prompt: `demo work for ${workerId}` },
    });
    started.push(runId);
  }
  // One worker left with NO run, so the `empty` pane state is visible rather than hypothetical.

  // Two PENDING requests, so the Requests panel (FLOWS §6a) is visible in the demo rather than
  // hypothetical. Inserted directly: the Slack inbound path that creates these for real is backlog
  // (PLAN.md section 14.4), and the panel is read-only until it exists — pressing `h` while it is
  // focused hides it, which is the whole interaction the design specifies today.
  const nowIso = new Date().toISOString();
  const insertRequest = db.prepare(
    `INSERT INTO requests (id, type, channel, mentioned_handle, raw_text, posted_by, status, created_at, updated_at)
     VALUES (?, 'review', ?, '@you', ?, ?, 'pending', ?, ?)`,
  );
  insertRequest.run("req-1", "#your-mr-channel", "@you please review !4821 before standup", "nj", nowIso, nowIso);
  insertRequest.run("req-2", "#team-planning", "can we pull the lint fix into this sprint?", "asha", nowIso, nowIso);

  // The AUTHORIZED map, as the daemon uses. See `createClient`: the demo holds the owner's token.
  const ipc = createIpcServer({ commands: supervisor.authorizedCommandHandlers() });
  const sock = sockPath(stateDir);
  await ipc.listen(sock);

  // Keep the demo alive and changing, so the pane is visibly live rather than a still frame.
  const chatter = setInterval(() => {
    for (const runId of started) {
      try { supervisor.sendInput(runId, `tick ${new Date().toISOString().slice(11, 19)}`); } catch { /* run may have ended */ }
    }
  }, 3000);
  chatter.unref?.();

  return {
    sock,
    // Read from the file the supervisor's boot wrote (0600). The demo is a client, so it holds a credential
    // rather than a privilege.
    token: fs.readFileSync(path.join(stateDir, "owner.token"), "utf8").trim(),
    async teardown() {
      clearInterval(chatter);
      try { await ipc.shutdown(); } catch { /* teardown */ }
      try { await supervisor.shutdown({ timeoutMs: 3000 }); } catch { /* teardown */ }
      try { closeDb(db); } catch { /* teardown */ }
      // Left in place rather than removed: it is a single fixed path that the next run recreates, and
      // keeping it means a crashed demo's database can still be inspected.
      void stateDir;
    },
  };
}

let demo = null;
if (DEMO) {
  process.stdout.write("starting the demo supervisor (fake harness, no tokens)...\n");
  demo = await startDemo();
}

const app = createTuiApp({
  client: createClient(demo ? demo.sock : sockPath(), {
    // Outside demo mode the token comes from the daemon's state dir, which only this user can read.
    token: demo ? demo.token : readOwnerToken(),
  }),
});

/** The owner's token, or null — in which case every command will be refused, and the status line will say so. */
function readOwnerToken() {
  try {
    return fs.readFileSync(path.join(defaultStateDir(), "owner.token"), "utf8").trim();
  } catch {
    return null;
  }
}

/** Restore the terminal on every exit path — including a crash. See `app.stop()`. */
async function shutdown(code = 0) {
  try { app.stop(); } catch { /* already stopped */ }
  if (demo) await demo.teardown();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", async (err) => {
  // Leave the alternate screen FIRST, or the stack trace is painted over a frame and then erased with
  // it — which is how a TUI crash becomes unreportable.
  try { app.stop(); } catch { /* ignore */ }
  process.stderr.write(`TUI crashed: ${err?.stack ?? err}\n`);
  await shutdown(1);
});

await app.start();

// The TUI exits when `q` or ctrl-c is pressed; `app.start()` returns immediately, so wait on state.
const watch = setInterval(() => { if (app.state.quit) { clearInterval(watch); shutdown(0); } }, 150);
