// wire.test.js — the supervisor's WIRE SURFACE, over a real socket (2026-09-08).
//
// WHY THIS EXISTS
//
// Two defects in the Phase 3-5 review, and one in Phase 3 itself, all lived in
// `supervisor.commandHandlers()` — code with no test:
//
//   * `createIpcServer({ commandHandlers: ... })` instead of `commands:` — the server starts fine,
//     every command falls through to the built-in demo cases, and a hook got back
//     "unknown cmd: adoptSession" (FINDINGS §27.5).
//   * `tuiChat` looked up a run with `list().find(r => r.workerId === ...)`, and `list()` has no
//     `workerId` — so every direct message was refused (§30.2).
//   * The same `list()`-has-no-`workerId` defect in the TUI's panes, fixed one function earlier and
//     missed here (§28.4).
//
// Three hits, same blind spot: the deterministic suites call supervisor FUNCTIONS directly, and every
// real client — the pane, the hooks, the TUI — goes over the SOCKET. A function that works when called
// in-process and fails when addressed by name is invisible to all of them.
//
// TWO HALVES, AND NEITHER IS ENOUGH ALONE
//
// Case 1 enumerates `commandHandlers()` and asserts every name is reachable. That half needs no
// maintenance: a new command is covered the moment it is registered.
//
// But it CANNOT see a command that was never registered — if a handler is deleted from the map, it is
// gone from `Object.keys()` too, and the loop happily reports full coverage of a smaller surface. That
// is exactly the shape of §27.5's defect, so case 1 alone would not have caught it. Discovered here by
// mutation A12, which case 1 passed.
//
// So case 1 also checks a REQUIRED list: the commands real clients address by name. That half does need
// maintenance when a client starts using a new command — which is the correct place for the burden,
// because it is a statement about what the clients depend on rather than about what happens to exist.
//
// Cases:
//   1. every command in the map is reachable, AND every command clients need is in the map
//   2. every reply echoes its request id
//   3. an unknown command is refused, and says what it did not recognise
//   4. `tuiChat` resolves a real worker's run — the §30.2 defect
//   5. `adoptSession` / `adoptedSessions` / `releaseSession` work over the wire — the §27.5 defect
//   6. `tuiSnapshot` returns the shape the TUI actually reads
//   7. a malformed frame does not take the server down
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import {
  openDb, closeDb, upsertHarness, createWorker, createTask, recordTransition,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createIpcServer } from "../../ipc/server.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, waitFor, sleep } from "./_helpers.js";
import { sockPath } from "../../paths.js";
import { readProcInfo } from "../procinfo.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

/**
 * One request over a real socket, one reply.
 *
 * A fresh connection per request on purpose: it is the shape the hook and the TUI actually use, and
 * connection-per-request is the case most likely to expose a server that only works for a long-lived
 * peer.
 */
function request(sock, cmd, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = "";
    const done = (fn, v) => { try { c.destroy(); } catch { /* gone */ } fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`timed out waiting for a reply to ${cmd.cmd}`)), timeoutMs);
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

/** A detached bystander, its own process group — see adoption.test.js for why that matters. */
function spawnBystander() {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    setTimeout(() => resolve(child), 150);
  });
}

await runTest("wire surface", async () => {
  const stateDir = makeScratchDir("supervisor-wire-test");
  let db;
  let supervisor;
  let ipc;
  const bystanders = [];

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake" });
    createTask(db, { id: "t1", title: "wire", type: "feature" });
    createWorker(db, { workerId: "w1", nickname: "wirey", role: "coder", taskId: "t1" });

    const harness = createFakeHarness({ label: "wire" });
    supervisor = createSupervisor({ db, adapters: { fake: harness }, askSweepIntervalMs: 0, logger: quiet });
    await supervisor.boot();

    // The `commands:` key, which is the whole point of §27.5's defect.
    const handlers = supervisor.commandHandlers();
    ipc = createIpcServer({ commands: handlers });
    const sock = sockPath(stateDir);
    await ipc.listen(sock);

    const { runId } = await supervisor.start({
      harnessId: "fake", workerId: "w1", spec: { cwd: stateDir, prompt: "wire test" },
    });
    await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE run_id = ?").get(runId).n > 0,
      { timeoutMs: 5000, what: "the run to produce events" });

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    // Self-maintaining coverage. Every handler name must be REACHABLE — not necessarily happy, since
    // most need arguments this loop does not know. "Not `unknown cmd`" is the assertion, and it is
    // exactly what the three past defects violated.
    {
      const names = Object.keys(handlers);
      assert.ok(names.length >= 20, `expected the full command surface; found ${names.length}`);

      // The commands real clients address BY NAME. Enumerating the map cannot catch a missing
      // registration (a deleted handler vanishes from the keys as well), so this is the half that does.
      // Grouped by who depends on each, because that is what makes the list reviewable rather than a
      // number someone bumps.
      const REQUIRED = [
        // pane/cli.js
        "observe", "asks", "answerAsk", "sendInput", "interrupt", "list",
        // hooks/claude-session-hook.mjs
        "adoptSession", "releaseSession",
        // tui/app.js
        "tuiSnapshot", "tuiChat",
        // the supervisor's own lifecycle surface
        "start", "stop", "status", "reap", "orphans", "preflight", "taskHandoff", "onboardHarness",
        // PLAN.md §11's "one picker, one config source, everywhere" — every start-work path addresses these
        "assignTask", "assignmentPreview",
        // PLAN.md §13's review surface — a reviewer, a pane and the CTO all address these by name
        "recordVerdict", "reviewStatus", "reviewFindings", "approveTask", "reviewProfiles",
      ];
      const missing = REQUIRED.filter((c) => !(c in handlers));
      assert.deepEqual(missing, [],
        `a command a real client addresses by name is not registered: ${missing.join(", ")} — `
        + "a supervisor function that is not in the handler map does not exist to the pane, the hooks or the TUI");

      // A DISPOSABLE run for the probe, because sending every command necessarily MUTATES state —
      // `stop`, `reap`, `interrupt` and `clearContext` are all in the map. The first version aimed the
      // probe at the run the later cases depend on and killed it, and case 4 then failed with "no open
      // run for worker w1", which reads exactly like the defect it was written to catch. A coverage
      // probe has to be pointed at something it is allowed to destroy.
      //
      // A disposable TASK too, as of the assignment step (PLAN.md §11): `assignTask` transitions task
      // state, so aiming the probe at `t1` left it in `start-failed` and case 6's `created -> starting`
      // then failed. Same lesson as §32.2, one command later — a probe that sends every command needs
      // every target it touches to be expendable, not just the ones that were obvious the first time.
      const probeTask = "t-probe";
      const probeWorker = "w-probe";
      createTask(db, { id: probeTask, title: "probe target", type: "adhoc" });
      createWorker(db, { workerId: probeWorker, nickname: "probe", role: "coder", taskId: probeTask });
      const { runId: probeRun } = await supervisor.start({
        harnessId: "fake", workerId: probeWorker, spec: { cwd: stateDir, prompt: "disposable" },
      });

      const unreachable = [];
      for (const name of names) {
        // `observe` streams and never sends a single terminating reply, so it is checked separately
        // below rather than being excluded silently.
        if (name === "observe") continue;
        let reply;
        try {
          reply = await request(sock, {
            id: `probe-${name}`, cmd: name,
            runId: probeRun, taskId: probeTask, harnessId: "fake", workerId: probeWorker,
          });
        } catch (err) {
          unreachable.push(`${name} (no reply: ${err.message})`);
          continue;
        }
        if (typeof reply?.error === "string" && /unknown cmd/i.test(reply.error)) {
          unreachable.push(`${name} (server said: ${reply.error})`);
        }
      }
      assert.deepEqual(unreachable, [],
        `every command in the handler map must be reachable over the socket; unreachable:\n  ${unreachable.join("\n  ")}`);
      // Cleaned up here rather than in `finally`: the probe deliberately half-destroyed it, and leaving
      // it open would make the later cases' run counts ambiguous.
      try { await supervisor.stop(probeRun); } catch { /* the probe may already have stopped it */ }
      console.log(`  1. all ${names.length - 1} non-streaming commands are reachable over a real socket`);
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    {
      const reply = await request(sock, { id: "echo-me-42", cmd: "list" });
      assert.equal(reply.id, "echo-me-42",
        "every reply must echo its request id — correlation is what makes one socket usable by one client");
      console.log("  2. replies echo their request id");
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      const reply = await request(sock, { id: "nope", cmd: "definitelyNotACommand" });
      assert.equal(reply.ok, false);
      assert.match(reply.error, /unknown cmd/i, "an unknown command must be refused, not silently accepted");
      assert.match(reply.error, /definitelyNotACommand/, "and must name what it did not recognise");
      console.log("  3. an unknown command is refused by name");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    // §30.2: `tuiChat` used `list()`, whose projection has no `workerId`, so this always failed with
    // "no open run for worker w1" — a defect invisible to every in-process test.
    {
      const reply = await request(sock, { id: "chat-1", cmd: "tuiChat", target: "w1", text: "hello over the wire" });
      assert.equal(reply.ok, true, `a direct message to a worker with an open run must succeed; got ${JSON.stringify(reply)}`);
      assert.equal(reply.runId, runId, "and must resolve to that worker's actual run");

      // The CTO target refuses on purpose (Phase 6), and says why rather than swallowing the message.
      const cto = await request(sock, { id: "chat-2", cmd: "tuiChat", target: "cto", text: "hi" });
      assert.equal(cto.ok, false);
      assert.match(cto.error, /CTO agent does not exist yet/, "a missing recipient must say so");

      const nobody = await request(sock, { id: "chat-3", cmd: "tuiChat", target: "no-such-worker", text: "hi" });
      assert.equal(nobody.ok, false);
      assert.match(nobody.error, /no open run/, "and an unknown worker is refused clearly");
      console.log("  4. tuiChat resolves a real worker's run over the wire");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    // §27.5: adoption's whole architecture is that a hook is a SOCKET CLIENT. If these are not
    // reachable by name, the feature does not exist however well its function is tested.
    {
      const bystander = await spawnBystander();
      bystanders.push(bystander);
      const info = await readProcInfo(bystander.pid);

      const adopted = await request(sock, {
        id: "adopt-1", cmd: "adoptSession", harnessId: "fake", sessionId: "wire-sess",
        workerId: "w1", cwd: stateDir, pid: bystander.pid,
      });
      assert.equal(adopted.ok, true, `adoptSession must work over the wire; got ${JSON.stringify(adopted)}`);
      assert.equal(adopted.adopted, true);
      assert.equal(adopted.pgid, info.pgid, "with the OS-verified identity, not the reported pid alone");

      const listed = await request(sock, { id: "adopt-2", cmd: "adoptedSessions" });
      assert.equal(listed.ok, true);
      const one = listed.sessions.find((x) => x.sessionId === "wire-sess");
      assert.ok(one, "and the adopted session is listable over the wire");
      assert.equal(one.controllable, false, "reported as visible but not controllable");

      const released = await request(sock, { id: "adopt-3", cmd: "releaseSession", harnessId: "fake", sessionId: "wire-sess" });
      assert.equal(released.ok, true);
      assert.equal(released.released, true);
      console.log("  5. adoptSession / adoptedSessions / releaseSession all work over the wire");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    // The TUI reads exactly these fields. §28.4's pane defect was a missing field in a projection, so
    // the shape is what gets asserted rather than merely `ok: true`.
    {
      recordTransition(db, { id: "wtr1", taskId: "t1", fromState: "created", toState: "starting", actor: "tester" });
      const snap = await request(sock, { id: "snap-1", cmd: "tuiSnapshot" });
      assert.equal(snap.ok, true);
      for (const key of ["teams", "tasks", "workers", "runs", "transcripts", "asks"]) {
        assert.ok(key in snap, `tuiSnapshot must carry "${key}" — the TUI reads it`);
      }
      const w = snap.workers.find((x) => x.workerId === "w1");
      assert.ok(w, "workers are keyed as the TUI expects");
      assert.equal(w.taskId, "t1", "with the task link the tree is built from");
      const r = snap.runs.find((x) => x.runId === runId);
      assert.ok(r, "runs are present");
      assert.equal(r.workerId, "w1",
        "and carry workerId — the field whose absence from list() caused the pane and tuiChat defects");
      assert.ok(Array.isArray(snap.transcripts[runId]), "with a transcript array per run");
      console.log("  6. tuiSnapshot returns the shape the TUI actually reads");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    // A client that sends nonsense must not be able to take the daemon down for everyone else.
    {
      await new Promise((resolve) => {
        const c = net.createConnection(sock, () => { c.write("this is not json\n"); setTimeout(() => { c.destroy(); resolve(); }, 200); });
        c.on("error", () => resolve());
      });
      const after = await request(sock, { id: "still-alive", cmd: "list" });
      assert.equal(after.ok, true, "the server must still be serving after a malformed frame");
      console.log("  7. a malformed frame did not take the server down");
    }
  } finally {
    for (const b of bystanders) { try { b.kill("SIGKILL"); } catch { /* gone */ } }
    try { if (ipc) await ipc.shutdown(); } catch { /* teardown */ }
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* teardown */ }
    try { if (db) closeDb(db); } catch { /* teardown */ }
    await sleep(150);
    rmScratchDir(stateDir);
  }
});
