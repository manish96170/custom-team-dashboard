#!/usr/bin/env node
// real-claude-adoption.slice.mjs — a REAL `claude` session adopting itself through the real hook.
//
// DELIBERATELY NOT IN `npm test`. Real tokens, real network, a logged-in `claude` on PATH.
// `adoption.test.js` proves all the row-level behaviour deterministically; what this adds is the one
// thing a fake cannot: that the HOOK actually fires inside a real session, that the payload is the
// shape the hook parses, and that the pid it reports really is the `claude` process — because the
// whole adoption story rests on a pid the supervisor did not spawn and must verify.
//
// The session here is started the way a PERSON would: `claude` with its own settings, not through the
// adapter. That is the point — the supervisor never touches it, and learns of it only because the
// hook told it.
//
// Run: node runtime/test/real-claude-adoption.slice.mjs
// Costs one small real turn.
//
// Cases:
//   1. a real `claude` session adopted itself through the hook, unprompted by us
//   2. the pid the hook reported IS the real claude process, verified against the OS
//   3. reconciliation leaves it alone — no orphan state, no sighting, not in orphans()
//   4. reap refuses to kill it, and the session is still running afterwards
//   5. the reported transcript path is PROSPECTIVE at SessionStart, and the transcript appears there
//   6. the session ends, and reconciliation closes the row as lost
//   7. nothing is left running

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  openDb,
  closeDb,
  upsertHarness,
  createWorker,
  createTask,
  getRun,
  listOrphanSightings,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createIpcServer } from "../../ipc/server.js";
import { reap } from "../reconcile.js";
import * as claudeCode from "../../adapters/claude-code/adapter.js";
import { readProcInfo } from "../procinfo.js";
import { sockPath } from "../../paths.js";
import { sleep, waitFor } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, "../../hooks/claude-session-hook.mjs");

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

// Not under /tmp: on macOS /tmp resolves through a symlink and the tool sandbox compares resolved
// paths (adapters/FINDINGS.md).
const home = process.env.HOME || os.tmpdir();
const stateDir = fs.mkdtempSync(path.join(home, "ctd-adopt-state-"));
const workDir = fs.mkdtempSync(path.join(home, "ctd-adopt-work-"));

let db;
let supervisor;
let ipc;
let session = null;      // the "human's" claude process
let adoptedRow = null;
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

let exitCode = 0;
try {
  db = openDb({ stateDir });
  upsertHarness(db, { id: "claude-code", displayName: "Claude Code" });
  createTask(db, { id: "adopt-task", title: "adopt an ad-hoc session", type: "feature" });
  createWorker(db, { workerId: "w-adhoc", nickname: "ad-hoc", role: "coder", taskId: "adopt-task" });

  supervisor = createSupervisor({
    db,
    adapters: { "claude-code": claudeCode },
    askSweepIntervalMs: 0,
    logger: { log(...a) { console.log("  sup:", ...a); }, warn(...a) { console.error("  warn:", ...a); }, error(...a) { console.error("  err:", ...a); } },
  });
  await supervisor.boot();

  // The socket has to be LISTENING, because the hook is a socket client — that is the whole
  // architecture (PLAN.md section 4: hooks never write SQLite). Without this the hook would give up
  // silently and the slice would prove nothing while looking like it passed.
  // The option is `commands`, NOT `commandHandlers` — the same wiring `ipc/daemon.js` uses.
  // Getting it wrong is silent in a useful way and misleading in a worse one: the server starts
  // fine and every command falls through to the built-in demo cases, so the hook got back
  // "unknown cmd: adoptSession". Worth recording because the deterministic suite calls
  // `supervisor.adoptSession()` directly and therefore never exercises the wire path at all —
  // this slice is the only thing that does.
  // `listen(path)` takes the socket path as an argument; teardown is `shutdown`, not `close`.
  ipc = createIpcServer({ commands: supervisor.commandHandlers() });
  await ipc.listen(sockPath(stateDir));
  log(`supervisor listening on ${sockPath(stateDir)}`);

  await testCase("1. a real `claude` session adopted itself through the hook", async () => {
    // Started the way a PERSON starts it: its own settings, no adapter involved. The hook is
    // installed inline via `--settings` so nothing is written to the developer's real config.
    const settings = JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `node ${HOOK} adopt` }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: `node ${HOOK} release` }] }],
      },
    });

    session = spawn("claude", [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--permission-mode", "default",
      // Pinned for the same reasons a worker is (PLAN.md 4.1) — and `--settings` is additive, so the
      // hook still loads even with the project sources switched off.
      "--setting-sources=", "--strict-mcp-config", "--settings", settings,
    ], {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, like a real terminal session — and so that case 4's reap, if the
      // refusal ever broke, could not reach this test runner.
      detached: true,
      env: {
        ...process.env,
        SUPERVISOR_STATE_DIR: stateDir,
        CTD_ADOPT_WORKER_ID: "w-adhoc",
        CTD_HOOK_DEBUG: "1",
      },
    });
    session.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s.includes("[ctd-hook]")) log(`hook said: ${s.slice(0, 200)}`);
    });
    // Keep it alive and talking: a real session sits waiting for input.
    session.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] } })}\n`);

    // Polled from the database rather than looked up by session id, because the SESSION ID IS THE
    // HOOK'S TO CHOOSE — the whole point is that the supervisor learns it from the hook rather than
    // knowing it in advance.
    adoptedRow = await waitFor(() => adoptedFromDb(),
      { timeoutMs: 120_000, pollMs: 300, what: "the hook to adopt the session" });
    log(`adopted: run ${adoptedRow.run_id}, session ${adoptedRow.harness_session_id}, pid ${adoptedRow.pid}`);
    assert.equal(adoptedRow.lifecycle, "adopted", "it must be recorded as adopted, not managed or orphaned");
    assert.equal(adoptedRow.ended_at, null, "and open — the session is running");
    assert.equal(adoptedRow.worker_id, "w-adhoc", "attributed to the worker the hook was told about");
  });

  await testCase("2. the pid the hook reported IS the real claude process", async () => {
    assert.ok(Number.isInteger(adoptedRow.pid), `a pid must have been reported; got ${adoptedRow.pid}`);
    const info = await readProcInfo(adoptedRow.pid);
    assert.equal(info.alive, true, "the reported pid must be alive");
    assert.equal(info.pgid, adoptedRow.process_group, "and the pgid recorded must be the one the OS reports");
    assert.ok(adoptedRow.proc_lstart, "with a start time, which is what makes pid reuse detectable later");

    // The decisive check: the reported pid is the `claude` process itself, not a hook shell.
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(adoptedRow.pid)], { encoding: "utf8" }).trim();
    assert.match(cmd, /claude/, `the adopted pid should be the claude process; ps says: ${cmd.slice(0, 160)}`);
    log(`verified pid ${adoptedRow.pid} is: ${cmd.slice(0, 90)}`);
  });

  await testCase("3. reconciliation leaves the live adopted session alone", async () => {
    const sightingsBefore = listOrphanSightings(db, adoptedRow.run_id).length;
    const boot = await supervisor.boot();
    const row = getRun(db, adoptedRow.run_id);
    assert.equal(row.lifecycle, "adopted", "it must NOT be relabelled orphaned-unmanaged");
    assert.equal(row.ended_at, null, "nor closed");
    assert.equal(listOrphanSightings(db, adoptedRow.run_id).length, sightingsBefore,
      "and must NOT be journalled as an orphan sighting");
    assert.deepEqual(supervisor.orphans().map((o) => o.runId), [],
      "it must not appear in orphans() — that is the list that invites a reap");
    assert.ok(boot.reconciliation.adopted.includes(adoptedRow.run_id), "it is named as adopted");
  });

  await testCase("4. reap refuses to kill it, and the session is still running", async () => {
    const refused = await reap({ db, runId: adoptedRow.run_id, hasHandle: () => false, logger: { log() {}, warn() {} } });
    assert.equal(refused.reaped, false, "reap must refuse an adopted session");
    assert.equal(refused.refused, "adopted");

    const info = await readProcInfo(adoptedRow.pid);
    assert.equal(info.alive, true, "and the person's real claude process must STILL be running");
    assert.equal(getRun(db, adoptedRow.run_id).ended_at, null, "with its row untouched");
    log("reap refused; the session is untouched");
  });

  await testCase("5. the reported transcript path is where the session's transcript APPEARS", async () => {
    assert.ok(adoptedRow.transcript_path, "a transcript path must have been recorded");

    // MEASURED HERE, and it corrects an assumption: at `SessionStart` the transcript file does NOT
    // exist yet. The path the hook reports is PROSPECTIVE — where the transcript will be written —
    // so an adopting supervisor must not treat it as a readable file at adoption time. The first
    // version of this case asserted `existsSync` immediately and failed for that reason.
    //
    // What matters for the claim it supports ("the only route to an adopted session's events") is
    // that the path becomes real once the session does something, so that is what is asserted.
    await waitFor(() => fs.existsSync(adoptedRow.transcript_path),
      { timeoutMs: 60_000, pollMs: 500, what: "the session's transcript to appear at the reported path" });
    const bytes = fs.statSync(adoptedRow.transcript_path).size;
    assert.ok(bytes > 0, "and to have content — an empty file is not a usable route to events");
    log(`transcript appeared (${bytes} bytes): ${adoptedRow.transcript_path}`);
  });

  await testCase("6. the session ends, and reconciliation closes the row as lost", async () => {
    // Killed the way a person closing their terminal would end it.
    try { process.kill(-adoptedRow.process_group, "SIGKILL"); } catch { session.kill("SIGKILL"); }
    await waitFor(async () => !(await readProcInfo(adoptedRow.pid)).alive,
      { timeoutMs: 20_000, pollMs: 250, what: "the session's process to be gone" });

    const boot = await supervisor.boot();
    const row = getRun(db, adoptedRow.run_id);
    assert.ok(row.ended_at, "an adopted session whose process is gone must be closed");
    assert.equal(row.exit_reason, "lost", "as lost — we never owned it, so it was not reaped or stopped");
    assert.ok(boot.reconciliation.lost.includes(adoptedRow.run_id));
  });

  await testCase("7. nothing is left running", async () => {
    await claudeCode.disposeAll({ graceMs: 500 });
    await sleep(400);
    const survivors = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n").filter((l) => l.includes(workDir) || l.includes(stateDir)).map((l) => l.trim());
    assert.deepEqual(survivors, [], `processes survived:\n  ${survivors.join("\n  ")}`);
  });
} catch (err) {
  failed += 1;
  console.error("the slice threw outside a case:");
  console.error(err);
} finally {
  if (session) { try { process.kill(-session.pid, "SIGKILL"); } catch { try { session.kill("SIGKILL"); } catch {} } }
  try { if (ipc) await ipc.shutdown(); } catch (e) { console.error("ipc shutdown:", e.message); }
  try { if (supervisor) await supervisor.shutdown({ timeoutMs: 5000 }); } catch (e) { console.error("shutdown:", e.message); }
  try { await claudeCode.disposeAll({ graceMs: 500 }); } catch { /* teardown */ }
  try { if (db) closeDb(db); } catch (e) { console.error("closeDb:", e.message); }
  for (const dir of [stateDir, workDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const total = passed + failed;
  console.log("");
  if (failed > 0) {
    console.error(`${failed}/${total} case(s) FAILED.`);
    exitCode = 1;
  } else {
    console.log(`All ${total} case(s) passed — a real \`claude\` session adopted itself via the hook,`);
    console.log("and the supervisor sees it without owning it or being able to kill it.");
  }
}

/** The adopted row, whatever its session id — the hook chooses that, not us. */
function adoptedFromDb() {
  return db.prepare("SELECT * FROM runs WHERE lifecycle = 'adopted' ORDER BY adopted_at DESC LIMIT 1").get() ?? null;
}

process.exit(exitCode);
