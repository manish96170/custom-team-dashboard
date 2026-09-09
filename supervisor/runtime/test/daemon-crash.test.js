// daemon-crash.test.js — Group 6, half three: crash and restart the REAL daemon
// (`ipc/daemon.js`), not a supervisor composed inside a test.
//
// crash-recovery.test.js kills a supervisor built in-process from the same modules. That
// proves the database and reconciliation survive, but it deliberately skips three things
// only the daemon owns, and all three are what a crash actually leaves behind:
//
//   * the single-instance lock (`lock/lock.js`) — a SIGKILLed daemon never releases it, so
//     the next daemon has to recognise a lock held by a DEAD pid as stale and take it over,
//     while a daemon started alongside a LIVE one must still refuse
//   * the control socket — the crashed process left the socket file on disk, bound to
//     nothing; the next daemon has to rebind it
//   * boot order — `acquireLock` → `openDb` → `boot()` (reconcile) → `listen`, so a refused
//     second daemon must not have touched the socket the live one is serving
//
// The runs here are seeded directly into the database with real detached children, so the
// test needs neither `claude` nor `opencode` installed: the daemon registers the real
// adapters, and the point is that it can still reconcile and reap a run it holds no handle
// for — the `orphaned-unmanaged` path, end to end, over the wire.
//
// Cases:
//   1. a fresh daemon acquires the lock, reconciles the seeded orphans, and serves commands
//   2. `reap` over the socket kills an orphan the daemon never started
//   3. SIGKILL leaves a lock held by a dead pid and a stale socket file, database intact
//   4. the next daemon takes over the stale lock, rebinds the stale socket, AND still sees the
//      live orphan it inherited (migration 0003 — this is the case that used to prove the gap)
//   5. a third daemon started against the LIVE one is refused, and does not disturb it
//   6. SIGTERM shuts down cleanly, releases the lock, and leaves no harness process behind
//
// Standing rule (TODO.md Group 6): every case asserts. This script cannot exit 0 with a
// broken claim.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  openDb,
  closeDb,
  upsertHarness,
  createWorker,
  createTask,
  createRun,
  createAsk,
  recordRunProcess,
  getRun,
} from "../../db/index.js";
import { connect } from "../../ipc/client.js";
import { spawnManaged } from "../spawn.js";
import { readProcInfo, isProcessGroupAlive, signalProcessGroup } from "../procinfo.js";
import { makeScratchDir, rmScratchDir, runTest, sleep, waitFor } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(__dirname, "../../ipc/daemon.js");
const FAKE_CHILD = path.join(__dirname, "_fake-harness-child.js");

await runTest("daemon-crash", async () => {
  const stateDir = makeScratchDir("supervisor-daemon-crash-test");
  const sockPath = path.join(stateDir, "supervisor.sock");
  const lockPath = path.join(stateDir, "supervisor.lock");
  // ONE env var. This used to have to set two — SUPERVISOR_STATE_DIR for the database and
  // socket, CTD_STATE_DIR for the lock — because the two roots disagreed, and needing two was
  // itself the bug: miss one and a test reaches into the developer's real `$HOME`. The roots are
  // now unified (supervisor/paths.js), and this test is what proves it end to end: under the old
  // code the daemon's lock would land in ~/.local/state and case 1's assertion that `lockPath`
  // inside the scratch dir exists would fail.
  const env = { ...process.env, SUPERVISOR_STATE_DIR: stateDir };
  delete env.CTD_STATE_DIR;

  const daemons = [];
  const liveGroups = new Set();
  let db;
  let client;

  function startDaemon() {
    const proc = spawn(process.execPath, [DAEMON], { env, stdio: ["ignore", "pipe", "pipe"] });
    const state = { proc, out: "", err: "", exit: null };
    proc.stdout.on("data", (c) => { state.out += c.toString(); });
    proc.stderr.on("data", (c) => { state.err += c.toString(); });
    proc.on("exit", (code, signal) => { state.exit = { code, signal }; });
    daemons.push(state);
    return state;
  }

  /** Wait for a line to appear in a daemon's stdout, or fail with everything it did say. */
  function waitForLine(state, pattern, { timeoutMs = 15000 } = {}) {
    return waitFor(() => (pattern.test(state.out) ? true : null), {
      timeoutMs,
      pollMs: 25,
      what: `daemon stdout to match ${pattern}`,
    }).catch(() => {
      throw new Error(
        `daemon never printed ${pattern}\n--- stdout ---\n${state.out}\n--- stderr ---\n${state.err}\n--- exit: ${JSON.stringify(state.exit)}`,
      );
    });
  }

  /** A real detached resident process, plus a runs row recording its verified identity. */
  async function seedOrphan(runId) {
    const { child, identity, spawnDepth } = spawnManaged({ command: process.execPath, args: [FAKE_CHILD, runId], cwd: stateDir });
    child.stdout.resume();
    child.stderr.resume();
    const info = await identity;
    assert.equal(info.verified, true, `seeded child for ${runId} must have a verified identity: ${info.reason}`);
    liveGroups.add(info.pgid);
    createRun(db, { runId, workerId: "w1", harnessId: "claude-code", prompt: `seeded ${runId}` });
    recordRunProcess(db, runId, {
      pid: info.pid,
      processGroup: info.pgid,
      procLstart: info.lstart,
      spawnDepth: Number(spawnDepth),
      cwd: stateDir,
    });
    return { runId, pid: info.pid, pgid: info.pgid };
  }

  try {
    // ---- seed: two live orphans and one unresolved ask ---------------------------------
    db = openDb({ stateDir });
    upsertHarness(db, { id: "claude-code", displayName: "Claude Code" });
    createWorker(db, { workerId: "w1", nickname: "seed", role: "worker" });
    createTask(db, { id: "t1", title: "daemon crash task", type: "feature" });
    const orphanA = await seedOrphan("seeded-run-a");
    const orphanB = await seedOrphan("seeded-run-b");
    createAsk(db, { id: "ask-a", runId: orphanA.runId, taskId: "t1", question: "still waiting?" });

    // ---- 1. a fresh daemon: lock, reconcile, serve -------------------------------------
    const d1 = startDaemon();
    await waitForLine(d1, /acquired lock at/);
    await waitForLine(d1, /listening on/);
    assert.match(d1.out, /rehydrated routing for 2 open run\(s\)/, `daemon must rehydrate both seeded runs:\n${d1.out}`);
    assert.match(
      d1.out,
      /reconciliation examined 2: 0 lost, 2 orphaned-unmanaged \(2 new, 0 still\)/,
      `unexpected reconciliation:\n${d1.out}`,
    );
    for (const o of [orphanA, orphanB]) {
      assert.ok(d1.out.includes(`orphaned-unmanaged: ${o.runId}`), `the daemon must NAME each actionable orphan:\n${d1.out}`);
      const row = getRun(db, o.runId);
      assert.equal(row.lifecycle, "orphaned-unmanaged", "the daemon records the lifecycle state");
      assert.equal(row.ended_at, null, "a live orphan's row stays open (migration 0003)");
      assert.ok(row.reconciled_at, "and still stamps reconciled_at");
    }
    const askA = db.prepare("SELECT * FROM asks WHERE id = 'ask-a'").get();
    assert.equal(askA.resolved, 1, "the orphan's open ask must be closed by the daemon's own boot reconciliation");
    assert.ok(fs.existsSync(lockPath), "the lock file must exist while the daemon runs");
    const lockPayload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(lockPayload.pid, d1.proc.pid, `the lock must record the daemon's pid: ${JSON.stringify(lockPayload)}`);

    client = await connect(sockPath);

    // The restarted daemon re-read the same state dir, so the owner principal — and its token — survived.

    const send2 = (cmd, args = {}) => client.send(cmd, { ...args, token: ownerToken });
    // THE DAEMON ENFORCES AUTHORIZATION as of Phase 7 (PLAN.md §16), so this test authenticates like any other
    // client: the owner's token is in the state dir at 0600, written by the daemon's own boot. Before this,
    // `list` came back with no `runs` at all and the failure read as a missing field — which is what a test
    // seeing an authorization refusal it does not expect looks like.
    const ownerToken = fs.readFileSync(path.join(stateDir, "owner.token"), "utf8").trim();
    const send = (cmd, args = {}) => client.send(cmd, { ...args, token: ownerToken });
    // `ping` is deliberately the one command that needs no principal: a liveness probe carries no state, and
    // a crash test has to be able to ask "are you up" before it can read anything.
    const ping = await client.send("ping");
    assert.equal(ping.ok, true, `the daemon must answer ping: ${JSON.stringify(ping)}`);
    const listed = await send("list");
    assert.deepEqual(
      listed.runs.map((r) => [r.runId, r.orphaned, r.managed]).sort(),
      [[orphanA.runId, true, false], [orphanB.runId, true, false]].sort(),
      `both live orphans must still be listed as open-but-unmanaged: ${JSON.stringify(listed.runs)}`,
    );
    const viewed = await send("orphans");
    assert.equal(viewed.ok, true, JSON.stringify(viewed));
    assert.deepEqual(
      viewed.orphans.map((o) => o.runId).sort(),
      [orphanA.runId, orphanB.runId].sort(),
      `the orphans command must list both: ${JSON.stringify(viewed.orphans)}`,
    );
    for (const o of viewed.orphans) {
      assert.equal(o.sightings, 1, "one sighting each, from this daemon's boot");
      assert.ok(o.title, "each orphan carries something readable to identify it by");
    }
    console.log(`  1. daemon ${d1.proc.pid} acquired the lock, reconciled 2 seeded orphans by name, and lists them as live orphans`);

    // ---- 2. reap an orphan the daemon never started, over the socket --------------------
    {
      const reaped = await send("reap", { runId: orphanA.runId });
      assert.equal(reaped.ok, true, JSON.stringify(reaped));
      assert.equal(reaped.reaped, true, `the daemon must reap a pre-existing orphan: ${JSON.stringify(reaped)}`);
      assert.equal(reaped.pgid, orphanA.pgid);
      assert.equal(reaped.harnessId, "claude-code", "routing came from runs.harness_id, not from memory");
      await waitFor(async () => !(await readProcInfo(orphanA.pid)).alive, { timeoutMs: 5000, what: "orphan A to die" });
      assert.equal(isProcessGroupAlive(orphanA.pgid), false, "nothing may remain in the reaped group");
      const reapedRow = getRun(db, orphanA.runId);
      assert.equal(reapedRow.exit_reason, "reaped", "reaping an OPEN orphan row is what closes it");
      assert.ok(reapedRow.reaped_at, "and stamps reaped_at, so history can tell reaped from still-running");
      assert.equal(reapedRow.lifecycle, "orphaned-unmanaged", "while keeping the record that it had been orphaned");
      console.log(`  2. reap over the socket killed pgid ${orphanA.pgid} — a run this daemon never started`);
    }

    // ---- 3. SIGKILL: lock held by a dead pid, stale socket, database intact ------------
    client.close();
    client = null;
    process.kill(d1.proc.pid, "SIGKILL");
    await waitFor(() => d1.exit, { timeoutMs: 5000, what: "the daemon to die" });
    assert.equal(d1.exit.signal, "SIGKILL", `the daemon must die by SIGKILL: ${JSON.stringify(d1.exit)}`);
    assert.ok(fs.existsSync(lockPath), "a crashed daemon cannot release its lock — that is what makes the next one recover it");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, d1.proc.pid, "the stale lock still names the dead pid");
    assert.ok(fs.existsSync(sockPath), "the crashed daemon left its socket file bound to nothing");
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok", "the database must survive the daemon's SIGKILL");
    assert.equal((await readProcInfo(orphanB.pid)).alive, true, "orphan B must outlive the daemon");
    console.log(`  3. SIGKILL left a lock naming dead pid ${d1.proc.pid}, a stale socket file, and an intact database`);

    // ---- 4. the next daemon takes over the stale lock and rebinds the socket ------------
    const d2 = startDaemon();
    await waitForLine(d2, /acquired lock at/);
    await waitForLine(d2, /listening on/);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, d2.proc.pid, "the new daemon must own the lock file");
    // The case that used to document the gap. Before migration 0003 orphan B's row had been
    // CLOSED by d1's reconciliation, so this restart reported "examined 0" and a live,
    // unmanaged process was invisible from here on. Now the row is still open, so d2 inherits
    // it, re-examines it, and says so.
    assert.match(d2.out, /rehydrated routing for 1 open run\(s\)/, `d2 must inherit the live orphan:\n${d2.out}`);
    // A daemon that inherits an orphan sees a REPEAT sighting, and must still report and name
    // it — printing "0 orphaned-unmanaged" over a live unmanaged process would be the same
    // invisibility bug one layer up.
    assert.match(
      d2.out,
      /reconciliation examined 1: 0 lost, 1 orphaned-unmanaged \(0 new, 1 still\)/,
      `unexpected reconciliation on restart:\n${d2.out}`,
    );
    assert.ok(d2.out.includes(`orphaned-unmanaged: ${orphanB.runId}`), `d2 must name the inherited orphan:\n${d2.out}`);
    client = await connect(sockPath);
    assert.equal((await client.send("ping")).ok, true, "the restarted daemon must serve on the rebound socket");
    const inherited = await send2("orphans", { withSightings: true });
    assert.equal(inherited.ok, true, JSON.stringify(inherited));
    assert.deepEqual(
      inherited.orphans.map((o) => o.runId),
      [orphanB.runId],
      `the orphans view must list exactly the inherited live orphan: ${JSON.stringify(inherited.orphans)}`,
    );
    assert.equal(inherited.orphans[0].sightings, 2, "one sighting from each daemon that saw it");
    assert.deepEqual(
      inherited.sightings.map((s) => s.kind),
      ["new", "new", "repeat"],
      `sighting kinds should be A-new, B-new, then B-repeat: ${JSON.stringify(inherited.sightings.map((s) => [s.run_id, s.kind]))}`,
    );
    console.log(`  4. daemon ${d2.proc.pid} took over the stale lock, rebound the socket, and inherited the live orphan (2 sightings)`);

    // ---- 5. a third daemon, against a live one, is refused -----------------------------
    {
      const d3 = startDaemon();
      await waitFor(() => d3.exit, { timeoutMs: 15000, what: "the second daemon to refuse to start" }).catch(() => {
        throw new Error(`a daemon started alongside a live one must exit, not run:\n${d3.out}`);
      });
      assert.equal(d3.exit.code, 1, `a refused daemon must exit non-zero: ${JSON.stringify(d3.exit)}`);
      assert.match(d3.out, new RegExp(`lock held by pid=${d2.proc.pid}`), `it must name the live holder:\n${d3.out}`);
      assert.match(d3.out, /refusing to start a second daemon/);
      // Boot order matters: the lock is taken BEFORE the socket is touched, so the refused
      // daemon cannot have unlinked the socket the live one is serving. Checking the EXISTING
      // connection would prove nothing — an established Unix-socket connection survives its
      // path being unlinked — so this opens a NEW one, which is what an unlinked socket
      // breaks, and what the next TUI client would hit.
      assert.equal((await client.send("ping")).ok, true, "the live daemon must still answer its existing connection");
      const fresh = await connect(sockPath);
      try {
        assert.equal((await fresh.send("ping")).ok, true, "a refused daemon must leave the live daemon's socket connectable");
      } finally {
        fresh.close();
      }
      assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, d2.proc.pid, "the live daemon still owns the lock");
      console.log(`  5. a third daemon was refused (named pid ${d2.proc.pid}) and left the live socket serving`);
    }

    // ---- 6. clean SIGTERM: lock released, nothing left running --------------------------
    {
      const reaped = await send2("reap", { runId: orphanB.runId });
      assert.equal(reaped.reaped, true, `the restarted daemon must reap the surviving orphan: ${JSON.stringify(reaped)}`);
      assert.equal(reaped.runClosed, true, "the inherited orphan's row was open, so this reap closes it");
      assert.deepEqual((await send2("orphans")).orphans, [], "no live orphans may remain after reaping the last one");
      await waitFor(async () => !(await readProcInfo(orphanB.pid)).alive, { timeoutMs: 5000, what: "orphan B to die" });

      client.close();
      client = null;
      process.kill(d2.proc.pid, "SIGTERM");
      await waitFor(() => d2.exit, { timeoutMs: 10000, what: "the daemon to shut down on SIGTERM" });
      assert.equal(d2.exit.code, 0, `a signalled daemon must exit cleanly: ${JSON.stringify(d2.exit)}`);
      assert.match(d2.out, /teardown complete \(sockets timedOut=false, supervisor timedOut=false/, `bounded teardown expected:\n${d2.out}`);
      assert.equal(fs.existsSync(lockPath), false, "a cleanly stopped daemon releases its lock");
      for (const pgid of liveGroups) {
        assert.equal(isProcessGroupAlive(pgid), false, `process group ${pgid} outlived the daemon`);
      }
      console.log("  6. SIGTERM: bounded teardown, lock released, no surviving harness process");
    }
  } finally {
    if (client) client.close();
    for (const d of daemons) {
      if (!d.exit) {
        try {
          d.proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    for (const pgid of liveGroups) signalProcessGroup(pgid, "SIGKILL");
    if (db) closeDb(db);
    await sleep(100);
    rmScratchDir(stateDir);
  }
});
