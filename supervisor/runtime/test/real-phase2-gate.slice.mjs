#!/usr/bin/env node
// real-phase2-gate.slice.mjs — the Phase 2 go/no-go gate, as one continuous run.
//
// WHY THIS EXISTS AND WHY IT IS NOT JUST ANOTHER SLICE
//
// ROADMAP's Phase 2 ends with: "If this phase doesn't work end-to-end, stop and reassess before
// writing anything else." Every piece of the slice is already proven on its own — the approval round
// trip, the live pane, crash recovery, the worker environment, preflight cleanup, the tier-3 handoff
// — but each was proven in isolation. A gate is not a list of passing parts; it is the question
// "does the whole thing hold together as one story", and nothing had asked that yet.
//
// So this walks the actual workflow, in order, against the REAL `claude` CLI:
//
//   check the model is reachable (and leave nothing behind)
//     -> put a worker on a task
//     -> it blocks on a tool
//     -> the handoff a lead would read SHOWS that block
//     -> a human answers
//     -> the tool runs, a second turn lands
//     -> the task moves state
//     -> the final handoff says nothing is blocked
//
// The composition is the point. Case 4 is the case that could not exist in any single-feature
// slice: it asserts the tier-3 handoff reflects LIVE state that another subsystem created.
//
// WHAT THIS DELIBERATELY DOES NOT RE-PROVE
//
// Supervisor crash and recovery. `real-claude-crash.slice.mjs` covers it in 7 cases against the real
// CLI, including the honest limit that a request parked when the supervisor died is unanswerable by
// anyone. Re-running it here would need a second OS process (the claude adapter has no
// `_forgetAllHandles` seam — that is fake-harness-only) and would spend real tokens re-proving a
// green result. Stating the boundary is better than implying coverage this script does not have.
//
// DELIBERATELY NOT IN `npm test`. Real tokens, real network, a logged-in `claude` on PATH.
// Run: node runtime/test/real-phase2-gate.slice.mjs
// Costs roughly two small turns plus a preflight.
//
// Cases:
//   1. preflight says the model is reachable, and leaves no trace
//   2. a worker starts on a real task and blocks on a tool it may not use
//   3. the environment pin held on the real CLI — both axes
//   4. the tier-3 handoff reports the LIVE block as a blocker (the composition case)
//   5. a human answers; the tool runs and a second turn lands on the same process
//   6. the task moves state and the final handoff says nothing is blocked
//   7. nothing survives, and no preflight or orphan rows are left
//
// THIS RUN ALREADY EARNED ITS KEEP: the first version exposed a defect no unit test had -- a task
// transition journalled the move without updating `tasks.state`, so the handoff's Goal said
// `created` while its own Decisions list showed `in-review`. Two sources of truth for one fact, and
// the assertion that should have caught it searched the whole document instead of the Goal section.
// Both are fixed. That is what a gate is for.

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
  createTask,
  recordTransition,
  getRun,
  listPreflightRuns,
  listRunsForDisplay,
  latestTaskHandoff,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import * as claudeCode from "../../adapters/claude-code/adapter.js";
import { isProcessGroupLive } from "../procinfo.js";
import { sleep, waitFor } from "./_helpers.js";

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

// Not under /tmp: on macOS /tmp resolves through a symlink and the tool sandbox compares resolved
// paths, so a cwd there produces working-directory refusals that never reach the host at all
// (adapters/FINDINGS.md — an hour lost to that once).
const home = process.env.HOME || os.tmpdir();
const stateDir = fs.mkdtempSync(path.join(home, "ctd-gate-"));
const workDir = fs.mkdtempSync(path.join(home, "ctd-gate-work-"));

let db;
let supervisor;
let runId = null;
let pgid = null;
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

/** The transcript a pane would render, read the same way the pane reads it: from `event_log`. */
const transcript = (id) =>
  db.prepare("SELECT type, payload_json FROM event_log WHERE run_id = ? ORDER BY seq").all(id)
    .map((r) => ({ type: r.type, p: r.payload_json ? JSON.parse(r.payload_json) : null }));

const assistantText = (id) =>
  transcript(id).filter((e) => e.type === "assistant.delta").map((e) => e.p?.text ?? "").join("");

let exitCode = 0;
try {
  db = openDb({ stateDir });
  upsertHarness(db, { id: "claude-code", displayName: "Claude Code" });
  createTask(db, { id: "gate-task", title: "Fetch the example.com title", type: "feature" });
  createWorker(db, { workerId: "gate-worker", nickname: "gate-coder", role: "coder", taskId: "gate-task" });

  supervisor = createSupervisor({
    db,
    adapters: { "claude-code": claudeCode },
    askGraceMs: 120_000,
    askSweepIntervalMs: 0,
    logger: { log() {}, warn(...a) { console.error("  warn:", ...a); }, error(...a) { console.error("  err:", ...a); } },
  });
  await supervisor.boot();

  // ── 1 ────────────────────────────────────────────────────────────────────────────────
  await testCase("1. preflight says the model is reachable, and leaves no trace", async () => {
    // PLAN.md 12.1's actual purpose: check before committing real work, not once at install time.
    const verdict = await supervisor.preflight({
      harnessId: "claude-code",
      workerId: "gate-worker",
      cwd: workDir,
      timeoutMs: 120_000,
    });
    log(`preflight: reachable=${verdict.reachable} in ${verdict.latencyMs}ms`);
    assert.equal(verdict.reachable, true, `the gate cannot proceed if the model is unreachable: ${JSON.stringify(verdict)}`);
    assert.deepEqual(listPreflightRuns(db), [], "and the check left no run row behind");
    assert.deepEqual(listRunsForDisplay(db), [], "nor anything a human would see in a team view");
    assert.equal(supervisor.modelHealth().length, 1, "only its verdict survived");
  });

  // ── 2 ────────────────────────────────────────────────────────────────────────────────
  await testCase("2. a worker starts on the task and blocks on a tool it may not use", async () => {
    // PLAN.md section 6's real state names (Phase 5 made them enforced, not decorative).
    recordTransition(db, { id: "gate-tr2", taskId: "gate-task", fromState: "created", toState: "starting", actor: "operator" });
    recordTransition(db, { id: "gate-tr3", taskId: "gate-task", fromState: "starting", toState: "planning", actor: "gate-coder" });
    recordTransition(db, { id: "gate-tr4", taskId: "gate-task", fromState: "planning", toState: "implementing", actor: "gate-coder" });

    ({ runId } = await supervisor.start({
      harnessId: "claude-code",
      workerId: "gate-worker",
      spec: {
        cwd: workDir,
        prompt: "Use the WebFetch tool on https://example.com and tell me the page title. Do that first, before anything else.",
        permissionMode: "default",
      },
    }));
    log(`worker started: ${runId}`);

    const ask = await waitFor(() => supervisor.asks({ runId })[0],
      { timeoutMs: 120_000, pollMs: 250, what: "the worker to block on a tool" });
    log(`blocked on: ${ask.kind} — ${ask.question ?? "(tool approval)"}`);

    assert.equal(ask.answerable, true, "a live block must be answerable, or a human has nothing to do");
    const row = getRun(db, runId);
    assert.equal(row.ended_at, null, "a run waiting for an answer has NOT ended — it is waiting");
    assert.ok(row.process_group, "and its process group was verified, so it can be owned and reaped");
    pgid = row.process_group;
    assert.equal(row.is_preflight, 0, "this is real work, not a check");
  });

  // ── 3 ────────────────────────────────────────────────────────────────────────────────
  await testCase("3. the environment pin held on the real CLI, on both axes", async () => {
    const t = transcript(runId);
    const declared = t.find((e) => e.type === "worker.env");
    const actual = t.find((e) => e.type === "session.init");
    assert.ok(declared, "the environment the worker was given must be recorded");
    assert.equal(declared.p.profile, "none", "the default is 'none' — repo config is opt-in");
    assert.ok(actual, "and what the CLI reports it loaded");
    assert.deepEqual(actual.p.mcpServers, [], `MCP servers leaked in: ${JSON.stringify(actual.p.mcpServers)}`);
    const hooks = t.filter((e) => e.type === "harness.hook" && e.p?.phase === "started");
    assert.deepEqual(hooks, [], `inherited hooks ran: ${JSON.stringify(hooks)}`);
    log(`environment: ${actual.p.toolCount} tools, ${actual.p.mcpServers.length} MCP servers, ${hooks.length} hooks`);
  });

  // ── 4 ────────────────────────────────────────────────────────────────────────────────
  // THE COMPOSITION CASE. No single-feature slice could contain it: the approval subsystem created
  // a live block, and the handoff subsystem — which knows nothing about approvals — has to report it
  // as the thing a lead should act on.
  await testCase("4. the tier-3 handoff reports the live block as a blocker", async () => {
    const h = supervisor.taskHandoff("gate-task", { reason: "manual" });
    log(`handoff: ${h.chars} chars, truncated=${h.truncated}`);

    assert.ok(h.doc.includes("Fetch the example.com title"), "the goal is the real task title");
    assert.ok(h.doc.includes("implementing"), "with the task's real state");
    assert.ok(h.doc.includes("`starting` → `planning`"), "and the transitions that got it there");
    assert.ok(h.doc.includes("gate-coder"), "naming the worker, so a reader knows who to ask");

    assert.equal(h.doc.includes("_Nothing is blocked._"), false,
      "a handoff generated while a worker is stopped must NOT say nothing is blocked");
    assert.ok(/awaiting (approval|an answer)/.test(h.doc),
      `the live block must appear as a blocker; got:\n${h.doc}`);
    assert.equal(h.sources.openAsks, 1, "and the sources record which ask it saw");
    assert.ok(h.chars <= 4000, "still inside Rule 4's one-page budget");
    assert.equal(h.truncated, false, "and not truncated at this size");
  });

  // ── 5 ────────────────────────────────────────────────────────────────────────────────
  await testCase("5. a human answers; the tool runs and a second turn lands", async () => {
    const ask = supervisor.asks({ runId })[0];
    const seqBefore = db.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM event_log WHERE run_id = ?").get(runId).s;
    const turnsBefore = transcript(runId).filter((e) => e.type === "turn.end").length;

    // `asks()` exposes the row's id as `askId`.
    const answered = await supervisor.answerAsk(ask.askId, { allow: true, answeredBy: "gate-operator" });
    assert.equal(answered.delivered, true, "the answer must actually reach the parked worker");
    log("answered: allow");

    // Wait for a NEW turn to end, counted rather than matched on a field — an earlier version
    // tested `e.p?.seq === undefined`, which is true of every turn.end and so waited for nothing.
    await waitFor(() => transcript(runId).filter((e) => e.type === "turn.end").length > turnsBefore,
      { timeoutMs: 180_000, pollMs: 500, what: "the turn to finish after the approval" });

    const toolResults = transcript(runId).filter((e) => e.type === "tool.result");
    assert.ok(toolResults.length >= 1, "the approved tool must actually have run");
    assert.ok(/example/i.test(assistantText(runId)),
      `the worker should have reported what it fetched; transcript said:\n${assistantText(runId).slice(-400)}`);
    assert.deepEqual(supervisor.asks({ runId }), [], "and nothing is left parked");

    // A second turn on the SAME resident process — the thing `sendInput` exists for.
    await supervisor.sendInput(runId, "In one word, was that page reachable?");
    await waitFor(() => db.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM event_log WHERE run_id = ?").get(runId).s > seqBefore + 5,
      { timeoutMs: 180_000, pollMs: 500, what: "the second turn's events" });
    log("second turn landed on the same process");
  });

  // ── 6 ────────────────────────────────────────────────────────────────────────────────
  await testCase("6. the task moves state and the final handoff says nothing is blocked", async () => {
    await supervisor.stop(runId);
    await waitFor(() => getRun(db, runId).ended_at, { timeoutMs: 30_000, pollMs: 250, what: "the run to close" });
    recordTransition(db, { id: "gate-tr5", taskId: "gate-task", fromState: "implementing", toState: "awaiting-review", actor: "gate-coder" });

    const h = supervisor.taskHandoff("gate-task", { reason: "state-transition" });
    // In the GOAL section, not anywhere in the document. The first version searched the whole doc
    // and passed while the Goal still said `created` -- because the new state also appears in the
    // journal-derived Decisions list. That vacuous assertion was sitting on a real defect:
    // `recordTransition` journalled the move without updating `tasks.state`. This gate run is what
    // exposed it, and it is now fixed in db/index.js.
    const goal = h.doc.slice(h.doc.indexOf("## Goal"), h.doc.indexOf("## Decisions"));
    assert.ok(goal.includes("awaiting-review"),
      `the handoff's Goal must carry the task's CURRENT state; got:\n${goal}`);
    assert.ok(h.doc.includes("_Nothing is blocked._"),
      `with the ask answered and the run closed, nothing is blocked; got:\n${h.doc}`);
    assert.equal(h.sources.openAsks, 0);
    assert.equal(h.sources.openRuns, 0, "and no run is left open");
    assert.ok(supervisor.taskHandoffHistory("gate-task").length >= 2,
      "and the earlier handoff survived — a regeneration must stay reviewable");
    assert.equal(latestTaskHandoff(db, "gate-task").reason, "state-transition", "with its trigger recorded");
  });

  // ── 7 ────────────────────────────────────────────────────────────────────────────────
  await testCase("7. nothing survives, and no preflight or orphan rows are left", async () => {
    await claudeCode.disposeAll({ graceMs: 500 });
    await sleep(400);
    if (pgid) {
      assert.equal(await isProcessGroupLive(pgid), false, "the worker's process group must be gone");
    }
    assert.deepEqual(listPreflightRuns(db), [], "no preflight row survived the whole run");
    const orphans = supervisor.orphans();
    assert.deepEqual(orphans, [], `no orphan was left behind: ${JSON.stringify(orphans)}`);

    // `ps` is a test — the Phase 2 review's lesson, after 29 leaked children went unnoticed.
    const survivors = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n").filter((l) => l.includes(workDir) || l.includes(stateDir)).map((l) => l.trim());
    assert.deepEqual(survivors, [], `processes survived:\n  ${survivors.join("\n  ")}`);
  });

  // The artifact a human reads to make the gate call.
  console.log("");
  console.log("  ── the final tier-3 handoff for this task ─────────────────────────────");
  for (const line of (latestTaskHandoff(db, "gate-task")?.doc ?? "(none)").split("\n")) console.log(`  | ${line}`);
  console.log("  ──────────────────────────────────────────────────────────────────────");
} catch (err) {
  failed += 1;
  console.error("the gate slice threw outside a case:");
  console.error(err);
} finally {
  try { if (supervisor) await supervisor.shutdown({ timeoutMs: 5000 }); } catch (e) { console.error("shutdown:", e.message); }
  try { await claudeCode.disposeAll({ graceMs: 500 }); } catch (e) { console.error("disposeAll:", e.message); }
  try { if (db) closeDb(db); } catch (e) { console.error("closeDb:", e.message); }
  // Last resort: a failure before case 7 leaves a real CLI running, and this project's whole
  // subject is not doing that.
  if (pgid) {
    try {
      if (await isProcessGroupLive(pgid)) {
        console.error(`  cleanup: process group ${pgid} still live after a failed run — killing it`);
        process.kill(-pgid, "SIGKILL");
      }
    } catch { /* already gone */ }
  }
  for (const dir of [stateDir, workDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const total = passed + failed;
  console.log("");
  if (failed > 0) {
    console.error(`${failed}/${total} gate case(s) FAILED — Phase 2 does NOT hold together end-to-end.`);
    exitCode = 1;
  } else {
    console.log(`All ${total} gate case(s) passed — Phase 2's vertical slice holds together end-to-end`);
    console.log("against the real `claude` CLI. Crash recovery is proven separately by");
    console.log("real-claude-crash.slice.mjs and is deliberately not re-run here.");
  }
}
process.exit(exitCode);
