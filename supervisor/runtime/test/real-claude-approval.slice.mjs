#!/usr/bin/env node
// real-claude-approval.slice.mjs — the Phase 2 approval round trip against the REAL
// `claude` CLI, through the real supervisor, the real database and the real adapter.
//
// DELIBERATELY NOT IN `npm test`. It spends real tokens, needs network, and needs a
// logged-in `claude` on PATH. Everything it proves is also covered deterministically by
// `approval.test.js` against the fake harness — what this adds is the one thing a fake
// cannot: that the protocol we implemented is the protocol the real CLI actually speaks.
// ROADMAP Phase 2 calls the approval round trip the risky part of the slice, and a green
// fake-harness suite is not evidence about a third-party CLI.
//
// Run: node runtime/test/real-claude-approval.slice.mjs
// Costs roughly $0.30 and about a minute. Captured output belongs in
// adapters/claude-code/probe/evidence/.
//
// What it walks through, in order:
//   spawn -> worker blocks on a tool -> ask row appears -> ALLOW -> the tool really runs
//         -> sendInput (a second turn on the same resident process) -> blocks again
//         -> DENY with a reason -> the worker reads that reason -> stop -> nothing survives
//
// The deny is the leg where a mistake would be silent (an allow that never arrives looks like
// the model changing its mind; a deny whose message is lost is invisible unless you read the
// model's next sentence), so it is asserted hardest — but it goes second, for a reason
// recorded at that step.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, closeDb, upsertHarness, createWorker, createTask } from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import * as claudeCode from "../../adapters/claude-code/adapter.js";
import { isProcessGroupLive } from "../procinfo.js";
import { sleep, waitFor } from "./_helpers.js";

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

// Not under /tmp: on macOS /tmp symlinks to /private/tmp and the tool sandbox compares
// resolved paths, so a cwd there produces working-directory refusals that are never routed to
// the host at all — an hour lost to that once already (adapters/FINDINGS.md).
const stateDir = fs.mkdtempSync(path.join(process.env.HOME || os.tmpdir(), "ctd-real-slice-"));
const workDir = fs.mkdtempSync(path.join(process.env.HOME || os.tmpdir(), "ctd-real-work-"));

let db;
let supervisor;
let runId;
let pgid;

const eventsOf = (id) =>
  db.prepare("SELECT type, payload_json FROM event_log WHERE run_id = ? ORDER BY seq").all(id).map((r) => ({
    type: r.type,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null,
  }));

/** The text the model produced after a given point — how we check what the worker was told. */
const assistantTextSince = (id, sinceSeq) =>
  db
    .prepare("SELECT payload_json FROM event_log WHERE run_id = ? AND type = 'assistant.delta' AND seq > ? ORDER BY seq")
    .all(id, sinceSeq)
    .map((r) => JSON.parse(r.payload_json)?.text ?? "")
    .join("");

const seqNow = (id) => db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM event_log WHERE run_id = ?").get(id).s;

// ── the operator loop ────────────────────────────────────────────────────────────────
//
// A standing loop that answers EVERY ask, rather than the script answering the one ask it
// expects. That is not defensive padding — the first version of this script answered only the
// first request and hung for two minutes, because a denied model does what a person would:
// it tried a different tool to work around the refusal, parked a second request, and nothing
// was listening. Which is the design behaving correctly and the test being naive.
//
// A real dashboard has a human watching the pane, so a loop is also the more faithful model.
let policy = () => ({ allow: false, answer: "Not permitted in this slice." });
const answered = [];

async function operatorLoop(signal) {
  while (!signal.stopped) {
    for (const ask of supervisor?.asks() ?? []) {
      const decision = policy(ask);
      try {
        const result = await supervisor.answerAsk(ask.askId, { ...decision, answeredBy: "slice-operator" });
        answered.push({ tool: ask.payload?.toolName, kind: ask.kind, ...decision, delivered: result.delivered });
        log(`operator answered ${ask.payload?.toolName}: ${decision.allow ? "allow" : "deny"} (delivered=${result.delivered})`);
      } catch (err) {
        log(`operator could not answer ${ask.askId}: ${err.message}`);
      }
    }
    await sleep(200);
  }
}

/** Deny anything the slice is not specifically testing, in terms that do not invite a retry. */
const denyEverythingElse = {
  allow: false,
  // Wording matters: "use the vendored copy instead" sent the model hunting with Bash. A
  // refusal that suggests an alternative is an instruction, not a refusal.
  answer: "Not permitted for this worker. Do not attempt an alternative; report that it was refused.",
};

try {
  const preflight = await claudeCode.preflight();
  assert.equal(preflight.ok, true, `claude must be available: ${preflight.reason ?? ""}`);
  log("preflight ok:", preflight.version);

  db = openDb({ stateDir });
  upsertHarness(db, { id: "claude-code", displayName: "Claude Code" });
  createTask(db, { id: "t-slice", title: "Phase 2 slice", type: "feature" });
  createWorker(db, { workerId: "w-slice", nickname: "Purus", role: "coder", taskId: "t-slice", cwd: workDir });

  supervisor = createSupervisor({
    db,
    adapters: { "claude-code": claudeCode },
    // The 5-minute default would outlast the script; nothing here depends on the grace.
    askGraceMs: 60_000,
    askSweepIntervalMs: 0,
  });
  await supervisor.boot();

  // ── spawn ───────────────────────────────────────────────────────────────────────────
  ({ runId } = await supervisor.start({
    harnessId: "claude-code",
    workerId: "w-slice",
    spec: {
      cwd: workDir,
      // WebFetch on a fresh domain is the cleanest genuine "ask": no sandbox, no
      // working-directory rule, and refused by default so it MUST ask.
      prompt: "Use the WebFetch tool on https://example.com and tell me the page title.",
      permissionMode: "default",
    },
  }));
  pgid = db.prepare("SELECT process_group FROM runs WHERE run_id = ?").get(runId).process_group;
  log(`started run ${runId}, verified pgid ${pgid}`);
  assert.ok(Number.isInteger(pgid) && pgid > 1, "the run must own a verified process group");

  // ── the worker blocks, and we hear about it ──────────────────────────────────────────
  // Inspected BEFORE the operator loop starts, so the ask can be examined while it is
  // genuinely parked rather than raced against its own answer.
  const first = await waitFor(() => supervisor.asks({ runId })[0], {
    timeoutMs: 120_000,
    pollMs: 250,
    what: "the real CLI to park a permission request on us",
  });
  log("ask raised:", JSON.stringify({ kind: first.kind, question: first.question, answerable: first.answerable }));

  assert.equal(first.kind, "tool-approval", "a tool call is an approval");
  assert.equal(first.answerable, true, "the CLI is parked on it right now");
  assert.equal(first.payload.toolName, "WebFetch");
  assert.equal(first.payload.input.url, "https://example.com");
  assert.ok(first.payload.suggestions, "the CLI's own always-allow offer came through");
  assert.equal(
    db.prepare("SELECT ended_at FROM runs WHERE run_id = ?").get(runId).ended_at,
    null,
    "a run blocked on approval has not ended — it is waiting",
  );

  // ── allow first, and the tool must actually run ──────────────────────────────────────
  //
  // ALLOW BEFORE DENY, which is the reverse of what this script did at first. A deny is the
  // more interesting case, so it started there — but a model that has just been refused
  // reasonably stops trying that tool, and the second turn then never parked anything, so the
  // script timed out waiting for a request the worker had sensibly decided not to make. Order
  // the legs so each one can actually happen; the deny is still asserted, second.
  //
  // The policy is also set BEFORE the loop starts: setting it after let the loop's first pass
  // answer with the placeholder default, and the assertion then failed on a message the
  // operator never sent — a race in the test that read as a protocol bug.
  const beforeAllow = seqNow(runId);
  policy = (ask) => (ask.payload?.toolName === "WebFetch" ? { allow: true } : denyEverythingElse);

  const signal = { stopped: false };
  const loop = operatorLoop(signal);

  await waitFor(() => eventsOf(runId).some((e) => e.type === "turn.end"), {
    timeoutMs: 180_000,
    pollMs: 250,
    what: "the first turn to end after the approval",
  });
  log("model said:", JSON.stringify(assistantTextSince(runId, beforeAllow).slice(0, 250)));
  const succeeded = eventsOf(runId).find(
    (e) => e.type === "tool.result" && !e.payload?.isError && JSON.stringify(e.payload?.content ?? "").length > 0,
  );
  assert.ok(succeeded, "an allowed WebFetch must produce a non-error tool_result — i.e. it really ran");
  log("1/3 allow: the parked tool call ran once approved, and returned a result");

  // ── a second turn on the SAME resident process, denied this time ─────────────────────
  const beforeDeny = seqNow(runId);
  const askedBefore = answered.length;
  policy = () => denyEverythingElse;
  await supervisor.sendInput(runId, "Now use the WebFetch tool on https://example.org and tell me its title.");

  await waitFor(() => answered.length > askedBefore, {
    timeoutMs: 180_000,
    pollMs: 250,
    what: "a second parked request on the same resident process",
  });
  const secondAsk = db.prepare("SELECT * FROM asks WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(runId);
  assert.notEqual(secondAsk.harness_request_id, first.harnessRequestId, "a new request gets a new correlation id");
  log("2/3 sendInput on the same resident process parked a second, distinct request");

  await waitFor(() => eventsOf(runId).filter((e) => e.type === "turn.end").length >= 2, {
    timeoutMs: 180_000,
    pollMs: 250,
    what: "the second turn to end after the denial",
  });
  log("model said:", JSON.stringify(assistantTextSince(runId, beforeDeny).slice(0, 250)));
  // The measured behavior is that a deny message becomes the tool_result error text, so the
  // model can see WHY. This asserts the operator's reason actually reached the model — the part
  // that would fail silently if we sent an empty or generic denial.
  const denialSeen = eventsOf(runId).find(
    (e) => e.type === "tool.result" && e.payload?.isError && JSON.stringify(e.payload.content ?? "").includes("Do not attempt an alternative"),
  );
  assert.ok(denialSeen, "the operator's reason must reach the worker verbatim as the tool_result error");
  log(`3/3 deny: the operator's reason reached the model (${answered.length} request(s) answered in total)`);

  signal.stopped = true;
  await loop;

  // ── the durable record ──────────────────────────────────────────────────────────────
  const rows = db.prepare("SELECT * FROM asks WHERE run_id = ? ORDER BY created_at").all(runId);
  assert.ok(rows.length >= 2, `at least the two decisions above are on the record, got ${rows.length}`);
  for (const row of rows) {
    assert.equal(row.resolved, 1, "every ask this slice raised was settled");
    assert.ok(row.answered_at, "with the answer durable");
    assert.ok(row.delivered_at, "and delivered to the harness");
    assert.ok(new Date(row.answered_at) <= new Date(row.delivered_at), "answered before delivered, on the record");
    assert.equal(row.delivery_error, null);
    assert.equal(row.answered_by, "slice-operator");
  }
  assert.equal(rows[0].decision, "allow", "the first decision was the approval");
  assert.ok(rows.some((r) => r.decision === "deny"), "and one of them was a denial");
  log(`audit trail: ${rows.length} asks, all answered-then-delivered, attributed to the operator`);

  // ── teardown: nothing may outlive the supervisor ─────────────────────────────────────
  await supervisor.stop(runId);
  await supervisor.shutdown({ timeoutMs: 8000 });
  supervisor = null;
  await sleep(500);
  assert.equal(await isProcessGroupLive(pgid), false, `process group ${pgid} must not have survived teardown`);
  log("teardown: the process group is gone");

  console.log("\nPASS: real-claude approval slice — allow ran the tool, sendInput, deny carried the reason, audit trail, clean teardown");
  process.exit(0);
} catch (err) {
  console.error("\nFAIL: real-claude approval slice");
  console.error(err?.stack ?? err);
  process.exit(1);
} finally {
  try {
    if (supervisor) await supervisor.shutdown({ timeoutMs: 5000 });
  } catch { /* already down */ }
  try {
    await claudeCode.disposeAll({ graceMs: 300 });
  } catch { /* nothing to dispose */ }
  if (db) closeDb(db);
  // The state dir is left behind on purpose when something failed — the database IS the
  // evidence. Printed rather than deleted.
  console.error(`state dir: ${stateDir}\nwork dir: ${workDir}`);
}
