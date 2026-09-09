#!/usr/bin/env node
// real-claude-crash.slice.mjs — kill the supervisor, restart it, recover, against the REAL
// `claude` CLI. The last open item on Phase 2's vertical slice.
//
// DELIBERATELY NOT IN `npm test`. It spends real tokens, needs network, and needs a
// logged-in `claude` on PATH. Group 6 (`crash-recovery.test.js`) already proves all of this
// deterministically against the fake harness and a real daemon; what this adds is the one
// thing a fake cannot — that a REAL third-party CLI process behaves the way the recovery
// path assumes when its parent is SIGKILLed:
//
//   * it SURVIVES (it was spawned detached, leading its own process group)
//   * the OS still reports that group as live to a supervisor that never owned it
//   * a request it parked is genuinely UNANSWERABLE afterwards
//   * killing the group really does take down the real CLI and everything it spawned
//
// Run: node runtime/test/real-claude-crash.slice.mjs
// Costs one small real turn (the worker only gets as far as its first tool call).
// Captured output belongs in adapters/claude-code/probe/evidence/.
//
// THE HONEST LIMIT THIS SCRIPT EXISTS TO MAKE TESTABLE, not to work around: a request parked
// on a run whose supervisor died cannot be answered by ANYONE. The child is blocked reading a
// stdin whose write end died with its parent; a restarted supervisor holds no handle to it,
// and neither does any human. So reconciliation closing that ask is CORRECT rather than
// merely tidy — and case 4 asserts the *reason* it is closed, because "closed" alone would
// also be true of a bug that closed asks it could have delivered.
//
// Cases:
//   1. the real worker parked a request, and the crash landed on a live database with a WAL
//   2. the real `claude` process SURVIVED its supervisor's SIGKILL, in its own process group
//   3. a fresh supervisor classifies it `orphaned-unmanaged` and leaves the row OPEN
//   4. the parked ask is closed, as unanswerable-by-anyone rather than as an answer
//   5. the environment pin held on the real CLI, on BOTH axes: no MCP servers, no hooks
//   6. reaping the orphan really kills the real CLI, and closes the row as `reaped`
//   7. a second reconciliation is a no-op, and nothing survives

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  openDb,
  closeDb,
  getRun,
  getAsk,
  listPendingAsks,
  listOrphanSightings,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { dbPath } from "../../paths.js";
import * as claudeCode from "../../adapters/claude-code/adapter.js";
import { readProcInfo, isProcessGroupLive } from "../procinfo.js";
import { sleep, waitFor } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VICTIM = path.join(__dirname, "_real-claude-crash-victim.mjs");

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

// Not under /tmp: on macOS /tmp symlinks to /private/tmp and the tool sandbox compares
// resolved paths, so a cwd there produces working-directory refusals that are never routed
// to the host at all (adapters/FINDINGS.md — an hour lost to that once already).
const home = process.env.HOME || os.tmpdir();
const stateDir = fs.mkdtempSync(path.join(home, "ctd-real-crash-"));
const workDir = fs.mkdtempSync(path.join(home, "ctd-real-crash-work-"));

let db;
let supervisor;
let victim;
let seed; // what the victim reported before it died

let passed = 0;
let failed = 0;
async function testCase(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
  }
}

/** Run the victim, capture its one JSON line, then SIGKILL it mid-write-load. */
async function crashTheSupervisor() {
  log("starting a real supervisor with a real `claude` worker, in its own OS process");
  victim = spawn(process.execPath, [VICTIM, stateDir, workDir], {
    stdio: ["ignore", "pipe", "pipe"],
    // NOT detached: this child is ours to kill directly. Its `claude` grandchild is the
    // thing that must survive, and it survives because the ADAPTER spawned it detached.
  });

  let out = "";
  let err = "";
  victim.stdout.on("data", (d) => { out += d.toString(); });
  victim.stderr.on("data", (d) => { err += d.toString(); });

  const line = await waitFor(() => {
    const nl = out.indexOf("\n");
    return nl === -1 ? null : out.slice(0, nl);
  }, { timeoutMs: 180_000, pollMs: 250, what: "the victim's seed line (a real claude worker parking a request)" })
    .catch((e) => {
      throw new Error(`${e.message}\n  victim stderr: ${err.slice(-800)}`);
    });

  seed = JSON.parse(line);
  log(`worker parked: run=${seed.runId} pid=${seed.pid} pgid=${seed.pgid} ask=${seed.askId} (${seed.askKind})`);

  // Let the write load actually get going, so the SIGKILL lands mid-statement rather than
  // on a quiescent database. Group 6's point: a crash between writes is the state the
  // recovery path claims to handle.
  await sleep(600);

  log("SIGKILL the supervisor — no finally, no closeDb, no adapter disposal, no lock release");
  victim.kill("SIGKILL");
  await waitFor(() => victim.exitCode !== null || victim.signalCode !== null,
    { timeoutMs: 10_000, what: "the victim process to be gone" });
  assert.equal(victim.signalCode, "SIGKILL", "the victim must have died of SIGKILL, not exited on its own");
}

async function main() {
  await crashTheSupervisor();

  db = openDb({ stateDir });

  await testCase("1. the real worker parked a request, and the crash left an un-checkpointed WAL", async () => {
    assert.ok(seed.askId, "the victim must have reported a parked ask");
    const ask = getAsk(db, seed.askId);
    assert.ok(ask, "the ask must be readable from the crashed database");
    assert.equal(ask.resolved, 0, "and must still be unresolved: nothing closed it before the crash");
    assert.ok(ask.harness_request_id, "a parked harness request must carry its correlation id");

    // Evidence the crash was ABRUPT -- not that it landed inside a statement. The victim's
    // write loop is synchronous INSERTs separated by a 5ms sleep and the SIGKILL arrives at an
    // arbitrary moment, so it very often lands in the sleep BETWEEN statements. What a non-empty
    // WAL proves is that committed frames were never checkpointed -- no clean shutdown ran -- and
    // that is the state recovery has to handle. The stronger "died mid-statement" claim is NOT
    // established here and is not needed: SQLite's atomicity is not under test, the recovery is.
    // The path comes from `paths.js` rather than a literal: the first version of this case
    // guessed `supervisor.db-wal` and failed against the real filename (`state.sqlite3`),
    // which is a test bug that reads exactly like a recovery bug.
    const wal = `${dbPath(stateDir)}-wal`;
    assert.ok(fs.existsSync(wal),
      `expected an un-checkpointed WAL at ${wal}; state dir contains: ${fs.readdirSync(stateDir).join(", ")}`);
    assert.ok(fs.statSync(wal).size > 0,
      "the WAL must be non-empty: committed frames were left un-checkpointed, so no clean shutdown ran");
    const integrity = db.prepare("PRAGMA integrity_check").get();
    assert.equal(integrity.integrity_check, "ok", `database corrupted by the crash: ${JSON.stringify(integrity)}`);
  });

  await testCase("2. the real `claude` process survived its supervisor's SIGKILL", async () => {
    const proc = await readProcInfo(seed.pid);
    assert.equal(proc.alive, true, `the real claude process ${seed.pid} did not survive the crash`);
    assert.equal(proc.pgid, seed.pgid, "and must still lead the process group we recorded");
    assert.equal(proc.pgid, seed.pid, "which is its own pid: it was spawned detached as a group leader");
    // The identity must be the SAME process, not a pid that was reused between the crash and
    // now. This is the check `reap` exists to make and the reason it refuses without it.
    assert.equal(proc.lstart, seed.lstart, "pid reuse: the live pid is not the process we spawned");
    assert.equal(await isProcessGroupLive(seed.pgid), true, "the OS must report the group as live");
  });

  await testCase("3. a fresh supervisor classifies it `orphaned-unmanaged` and leaves the row OPEN", async () => {
    supervisor = createSupervisor({
      db,
      adapters: { "claude-code": claudeCode },
      // The default 5-minute grace would outlast this script. Nothing here depends on the
      // grace: the asks under test are closed by reconciliation, not by the sweep.
      askGraceMs: 60_000,
      askSweepIntervalMs: 0,
      logger: { log() {}, warn() {}, error(...a) { console.error("  supervisor:", ...a); } },
    });
    const boot = await supervisor.boot();
    log(`reconciliation: ${JSON.stringify(boot?.reconciliation ?? boot)}`);

    const run = getRun(db, seed.runId);
    assert.equal(run.lifecycle, "orphaned-unmanaged",
      `expected lifecycle orphaned-unmanaged, got ${run.lifecycle}`);
    // Migration 0003's whole point: the process has NOT ended, so the row must not be
    // closed. A closed row drops out of `listOpenRuns`, which is reconciliation's own input
    // set, so the live process would be classified once and then invisible forever.
    assert.equal(run.ended_at, null, "an orphan row must stay OPEN: its process is still running");
    assert.equal(run.exit_reason, null, "and must carry no terminal reason it has not earned");

    const sightings = listOrphanSightings(db, seed.runId);
    assert.ok(sightings.length >= 1, "reconciliation must journal a sighting");
    assert.equal(sightings[0].kind, "new", `the first sighting of this orphan is 'new', got ${sightings[0].kind}`);
  });

  await testCase("4. the parked ask is closed as unanswerable-by-anyone, not as an answer", async () => {
    const ask = getAsk(db, seed.askId);
    assert.equal(ask.resolved, 1, "reconciliation must close an ask nothing can ever answer");
    // The REASON matters more than the fact. "Closed" alone would also be true of a bug
    // that closed asks it could still have delivered; and it must never look like a human
    // decided anything, because the audit trail is the point of the column.
    assert.equal(ask.answered_by, "supervisor:reconciliation",
      `an unanswerable ask must be attributed to the supervisor, got answered_by=${ask.answered_by}`);
    assert.equal(ask.decision, "closed",
      `and its decision must be 'closed' — never allow/deny/answered, which are the only deliverable ones; got ${ask.decision}`);
    assert.equal(ask.delivered_at, null,
      "and must NOT be recorded as delivered: the worker's stdin died with its parent, so nothing reached it");
    assert.deepEqual(listPendingAsks(db, { runId: seed.runId }), [],
      "no ask on a crashed run may be left pending, or a human would be offered a question with no destination");
  });

  await testCase("5. the environment pin held on the real CLI", async () => {
    // Item 2, verified against the real harness rather than against the probe: `worker.env`
    // is what we ASKED for, `session.init` is what the CLI reports it actually LOADED.
    const rows = db.prepare(
      "SELECT type, payload_json FROM event_log WHERE run_id = ? AND type IN ('worker.env','session.init') ORDER BY seq",
    ).all(seed.runId).map((r) => ({ type: r.type, p: JSON.parse(r.payload_json) }));

    const declared = rows.find((r) => r.type === "worker.env");
    assert.ok(declared, "the run must record the environment it was given");
    assert.equal(declared.p.profile, "none", "the default is 'none': repo config executes repo hooks, so it is opt-in");
    assert.equal(declared.p.strictMcpConfig, true);

    const actual = rows.find((r) => r.type === "session.init");
    assert.ok(actual, "the CLI's own init must be recorded");
    assert.deepEqual(actual.p.mcpServers, [],
      `the real CLI still loaded MCP servers, so the pin did not hold: ${JSON.stringify(actual.p.mcpServers)}`);

    // BOTH AXES, not just MCP. `--setting-sources` governs hooks and `--strict-mcp-config`
    // governs MCP servers, and they are independent (measured: `--strict-mcp-config` alone left
    // all 3 hooks firing while taking MCP to 0). Asserting only `mcpServers` meant a regression
    // that dropped `--setting-sources=project` while keeping `--strict-mcp-config` would restore
    // the developer's global hooks and leave this case green. Raised by the cross-model review.
    const hooks = db.prepare(
      "SELECT payload_json FROM event_log WHERE run_id = ? AND type = 'harness.hook'",
    ).all(seed.runId).map((r) => JSON.parse(r.payload_json));
    const started = hooks.filter((h) => h.phase === "started");
    assert.deepEqual(started, [],
      `no hook may run in a pinned worker started in a directory with no project settings; got ${JSON.stringify(started)}`);
    log(`hook axis: ${started.length} hooks fired (developer global config defines 2)`);
    log(`real session loaded: ${actual.p.toolCount} tools, ${actual.p.slashCommandCount} commands, ${actual.p.mcpServers.length} MCP servers`);
  });

  await testCase("6. reaping the orphan kills the real CLI and closes the row as `reaped`", async () => {
    const result = await supervisor.reap(seed.runId);
    log(`reap: ${JSON.stringify(result)}`);

    await waitFor(async () => (await isProcessGroupLive(seed.pgid)) === false,
      { timeoutMs: 20_000, pollMs: 250, what: "the real claude process group to actually die" });

    const run = getRun(db, seed.runId);
    assert.equal(run.exit_reason, "reaped", `expected exit_reason reaped, got ${run.exit_reason}`);
    assert.ok(run.ended_at, "a reaped run's row must be closed: its process really has ended now");
    assert.ok(run.reaped_at, "and reaped_at must be stamped independently of the terminal write");

    const proc = await readProcInfo(seed.pid);
    assert.equal(proc.alive, false, `the real claude process ${seed.pid} is still alive after the reap`);
  });

  await testCase("7. a second reconciliation is a no-op, and nothing survives", async () => {
    const before = getRun(db, seed.runId);
    // `boot()` is how a second reconciliation is run — the supervisor exposes no
    // `reconcile()`; reconciliation is something a boot does. Same pattern as
    // crash-recovery.test.js cases 7/8/10.
    const again = await supervisor.boot();
    log(`second reconciliation: ${JSON.stringify(again?.reconciliation ?? again)}`);
    const after = getRun(db, seed.runId);
    assert.equal(after.exit_reason, before.exit_reason, "a resolved run must not be rewritten");
    assert.equal(after.ended_at, before.ended_at, "nor re-closed with a new timestamp");

    // `ps` is a test — the Phase 2 review's lesson, after the adapter suite was found to
    // have leaked 29 detached test children (the oldest running over fifteen hours) in a
    // project whose whole subject is process ownership, because nothing checked.
    const disposed = await claudeCode.disposeAll({ graceMs: 500 });
    await sleep(400);
    assert.equal(await isProcessGroupLive(seed.pgid), false, "the orphan's group must be gone");

    // Broader than the one pgid: anything still holding this run's directories. A real CLI
    // spawns children of its own, and the group kill is what is supposed to reach them.
    const ps = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(stateDir) || l.includes(workDir))
      .map((l) => l.trim());
    assert.deepEqual(ps, [], `processes survived this slice:\n  ${ps.join("\n  ")}`);
    log(`teardown: disposeAll stopped ${disposed?.stopped?.length ?? 0} run(s), 0 survivors`);
  });
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  failed += 1;
  console.error("the slice threw outside a case:");
  console.error(err);
} finally {
  // Teardown must run even on a throw, and must not mask a failure with a teardown error.
  try { if (supervisor) await supervisor.shutdown?.({ graceMs: 500 }); } catch (e) { console.error("shutdown:", e.message); }
  try { await claudeCode.disposeAll({ graceMs: 500 }); } catch (e) { console.error("disposeAll:", e.message); }
  try { if (victim && victim.exitCode === null && victim.signalCode === null) victim.kill("SIGKILL"); } catch { /* already gone */ }
  try { if (db) closeDb(db); } catch (e) { console.error("closeDb:", e.message); }

  // A last-resort sweep: if a case failed BEFORE the reap, the real claude process is still
  // out there. Leaving a live third-party CLI running because a test failed would be this
  // project's own subject matter biting it.
  if (seed?.pgid) {
    try {
      if (await isProcessGroupLive(seed.pgid)) {
        console.error(`  cleanup: process group ${seed.pgid} still live after a failed run — killing it`);
        process.kill(-seed.pgid, "SIGKILL");
      }
    } catch { /* already gone, or never ours */ }
  }

  for (const dir of [stateDir, workDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const total = passed + failed;
  console.log("");
  if (failed > 0) {
    console.error(`${failed}/${total} case(s) FAILED.`);
    exitCode = 1;
  } else {
    console.log(`All ${total} case(s) passed — supervisor crash, restart and recovery work against the real \`claude\` CLI.`);
  }
}
process.exit(exitCode);
