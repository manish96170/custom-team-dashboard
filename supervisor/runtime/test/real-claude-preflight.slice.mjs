#!/usr/bin/env node
// real-claude-preflight.slice.mjs — preflight against the REAL `claude` CLI (PLAN.md 12.1).
//
// DELIBERATELY NOT IN `npm test`. Real tokens, real network, a logged-in `claude` on PATH.
// `preflight.test.js` already proves all the row-level behaviour deterministically against the fake
// harness; what this adds is the one thing a fake cannot — that the cleanup actually holds against a
// third-party CLI, and specifically that **`--no-session-persistence` really does stop the harness
// writing a session of its own**. That flag is the reason the Claude Code path needs no
// "delete the harness's session" step at all, so if it silently stopped working, the deterministic
// suite would stay green while every preflight quietly littered the CLI's session store.
//
// Run: node runtime/test/real-claude-preflight.slice.mjs
// Costs one very small real turn (a two-token answer).
//
// Cases:
//   1. a real preflight against `claude` returns reachable, with a real latency
//   2. it left NO rows behind — not the run, not its events
//   3. it left NO session in the CLI's own store either (the whole point of the flag)
//   4. the verdict survived in `model_health`, which is what section 12.3 reads
//   5. a preflight for a model that does not exist is recorded as unreachable, and still cleans up
//   6. nothing is left running

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  openDb,
  closeDb,
  upsertHarness,
  createWorker,
  listPreflightRuns,
  listModelHealth,
  getModelHealth,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import * as claudeCode from "../../adapters/claude-code/adapter.js";
import { sleep } from "./_helpers.js";

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

// Not under /tmp: on macOS /tmp resolves through a symlink and the tool sandbox compares resolved
// paths (adapters/FINDINGS.md).
const home = process.env.HOME || os.tmpdir();
const stateDir = fs.mkdtempSync(path.join(home, "ctd-real-preflight-"));
const workDir = fs.mkdtempSync(path.join(home, "ctd-real-preflight-work-"));

// Where the CLI keeps its own sessions.
//
// SCOPED TO THIS RUN'S DIRECTORY, not a global count. A global before/after count is what this first
// did, and it FLAKED: the count is machine-wide, so any other `claude` writing a session while the
// slice runs changes it — observed once, with a concurrent slice running. The CLI derives its project
// directory from the cwd, so counting only that subtree is both precise and immune to unrelated
// sessions. A test that fails because of something else on the machine teaches people to re-run it.
const CLI_SESSION_DIRS = [
  path.join(home, ".claude", "projects"),
  path.join(home, ".config", "claude", "projects"),
];

/**
 * Session files the CLI wrote FOR THIS RUN'S working directory.
 *
 * The CLI encodes the cwd into its project directory name (observed:
 * `~/.claude/projects/-Users-me-ctd-real-preflight-work-XXXX/<session>.jsonl`), so matching on the
 * mangled cwd isolates this slice from every other `claude` on the machine.
 */
function countCliSessionFiles(forCwd) {
  const tag = forCwd.replace(/[/.]/g, "-");
  let n = 0;
  for (const dir of CLI_SESSION_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        // Suffix match rather than equality: the leading separator is mangled too, and pinning the
        // exact transform would make this brittle against a CLI that changes it.
        if (!tag.endsWith(entry.name) && !entry.name.endsWith(tag)) continue;
        for (const f of fs.readdirSync(path.join(dir, entry.name))) {
          if (f.endsWith(".jsonl")) n += 1;
        }
      }
    } catch { /* unreadable subtree; best-effort */ }
  }
  return n;
}

let db;
let supervisor;
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
  createWorker(db, { workerId: "w-preflight", nickname: "preflight", role: "worker" });

  supervisor = createSupervisor({
    db,
    adapters: { "claude-code": claudeCode },
    askSweepIntervalMs: 0,
    logger: { log() {}, warn(...a) { console.error("  warn:", ...a); }, error(...a) { console.error("  err:", ...a); } },
  });
  await supervisor.boot();

  const sessionsBefore = countCliSessionFiles(workDir);
  log(`CLI session files for this workDir before: ${sessionsBefore}`);

  let result;
  await testCase("1. a real preflight against `claude` reports reachable", async () => {
    result = await supervisor.preflight({
      harnessId: "claude-code",
      workerId: "w-preflight",
      cwd: workDir,
      timeoutMs: 120_000,
    });
    log(`verdict: ${JSON.stringify(result)}`);
    assert.equal(result.reachable, true, `expected reachable; got ${JSON.stringify(result)}`);
    assert.equal(result.errorClass, "ok");
    assert.ok(result.latencyMs > 0, "a real check takes real time; latency must be recorded");
  });

  await testCase("2. it left no rows behind", async () => {
    assert.deepEqual(listPreflightRuns(db), [], "no preflight run row may survive its check");
    const events = db.prepare("SELECT COUNT(*) AS n FROM event_log").get().n;
    assert.equal(events, 0, `every event row belonged to the preflight and must be gone; ${events} remain`);
    assert.equal(result.cleanup.deleted, true);
  });

  await testCase("3. it left no session in the CLI's own store", async () => {
    // The load-bearing case. `--no-session-persistence` is why the Claude Code path needs no
    // harness-side deletion at all, and its absence would be SILENT: the rows would still be
    // cleaned up and only the CLI's own directory would grow.
    await sleep(500); // give the CLI a moment to have written one, if it were going to
    const after = countCliSessionFiles(workDir);
    assert.equal(after, sessionsBefore,
      `--no-session-persistence must stop the CLI writing a session: ${sessionsBefore} -> ${after}`);
    log(`CLI session files after: ${after} (unchanged)`);
  });

  await testCase("4. the verdict survived the deleted session", async () => {
    const health = listModelHealth(db);
    assert.equal(health.length, 1, `expected exactly one verdict, got ${JSON.stringify(health)}`);
    assert.equal(health[0].harness_id, "claude-code");
    assert.equal(health[0].reachable, 1);
    assert.equal(health[0].error_class, "ok");
    assert.ok(health[0].checked_at, "with a timestamp, so a stale verdict is recognisable as stale");
  });

  await testCase("5. an unreachable model is recorded as such, and still cleans up", async () => {
    const bad = await supervisor.preflight({
      harnessId: "claude-code",
      workerId: "w-preflight",
      cwd: workDir,
      model: "definitely-not-a-real-model-xyz",
      timeoutMs: 45_000,
    });
    log(`bad-model verdict: ${JSON.stringify(bad)}`);
    assert.equal(bad.reachable, false, "a nonexistent model must not be reported reachable");
    assert.notEqual(bad.errorClass, "ok", "and must carry a non-ok error class");
    assert.deepEqual(listPreflightRuns(db), [], "a FAILED check cleans up just as thoroughly");
    const stored = getModelHealth(db, { harnessId: "claude-code", providerId: "", modelId: "definitely-not-a-real-model-xyz" });
    assert.ok(stored, "and its verdict is queryable by model id");
    assert.equal(stored.reachable, 0);
  });

  await testCase("6. nothing is left running", async () => {
    await claudeCode.disposeAll({ graceMs: 500 });
    await sleep(400);
    // `ps` is a test — the Phase 2 review's lesson after 29 leaked children went unnoticed.
    const survivors = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(workDir) || l.includes(stateDir))
      .map((l) => l.trim());
    assert.deepEqual(survivors, [], `processes survived:\n  ${survivors.join("\n  ")}`);
  });
} catch (err) {
  failed += 1;
  console.error("the slice threw outside a case:");
  console.error(err);
} finally {
  try { if (supervisor) await supervisor.shutdown({ timeoutMs: 5000 }); } catch (e) { console.error("shutdown:", e.message); }
  try { await claudeCode.disposeAll({ graceMs: 500 }); } catch (e) { console.error("disposeAll:", e.message); }
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
    console.log(`All ${total} case(s) passed — a real \`claude\` preflight leaves no rows and no harness-side session.`);
  }
}
process.exit(exitCode);
