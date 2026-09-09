#!/usr/bin/env node
// Real, asserting tests for the Claude Code adapter fixes.
//
// Every test throws on failure. main() at the bottom catches any throw,
// prints a clear FAIL line, and calls process.exit(1) — this file must
// never exit 0 after a failed assertion, which is the exact defect
// (finding M6 in consolidated-review-claudeopus5-medium--spike-0b.md) this
// suite exists to not repeat.
//
// Run: node supervisor/adapters/claude-code/test/test-claude-code-adapter.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Copy the fake binary into a scratch dir we control exclusively, so the
// "spawn a genuinely missing binary" test (resume()'s error-handler fix)
// can rename it away and back without touching the checked-in fixture and
// without racing any other test that might be reading the original path.
// This also sidesteps adapter.js capturing CLAUDE_BIN as a module-level
// constant at import time — we fix the *path*, then make the file at that
// path disappear/reappear, rather than trying to change the env var after
// the adapter has already read it (which would silently do nothing).
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-adapter-test-'));
const FAKE_CLAUDE = path.join(scratchDir, 'fake-claude');
const FAKE_CLAUDE_MISSING = path.join(scratchDir, 'fake-claude.movedaway');
fs.copyFileSync(path.join(__dirname, 'fake-claude'), FAKE_CLAUDE);
fs.copyFileSync(path.join(__dirname, 'fake-claude.mjs'), path.join(scratchDir, 'fake-claude.mjs'));
fs.chmodSync(FAKE_CLAUDE, 0o755);

process.env.CLAUDE_BIN = FAKE_CLAUDE;
const adapter = await import('../adapter.js');

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function drain(runId, { timeoutMs = 5000 } = {}) {
  const events = [];
  const overallTimeout = sleep(timeoutMs).then(() => 'timeout');
  const iter = adapter.observe(runId);
  while (true) {
    const result = await Promise.race([
      iter.next().then((r) => ({ ...r, timedOut: false })),
      overallTimeout,
    ]);
    if (result === 'timeout') break; // sequential — no concurrent iter.next() calls in flight
    const { value, done } = result;
    if (value !== undefined) events.push(value);
    if (done) break;
    if (value && value.type === 'turn.end') break;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Finding B4: turn.end must carry a normalized `status` field, and it must
// be correct for all three terminal shapes (completed/error/aborted), with
// `isError` present as a derived boolean.
// ---------------------------------------------------------------------------
async function test_turnEnd_status_completed() {
  process.env.FAKE_CLAUDE_MODE = 'completed';
  const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
  const events = await drain(runId);
  const turnEnd = events.find((e) => e.type === 'turn.end');
  assert.ok(turnEnd, 'expected a turn.end event');
  assert.equal(turnEnd.status, 'completed', 'status must be "completed"');
  assert.equal(turnEnd.isError, false, 'isError must be derived false');
  adapter.stop(runId);
}

async function test_turnEnd_status_error() {
  process.env.FAKE_CLAUDE_MODE = 'error';
  const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
  const events = await drain(runId);
  const turnEnd = events.find((e) => e.type === 'turn.end');
  assert.ok(turnEnd, 'expected a turn.end event');
  assert.equal(turnEnd.status, 'error', 'status must be "error"');
  assert.equal(turnEnd.isError, true, 'isError must be derived true for an error turn');
  adapter.stop(runId);
}

async function test_turnEnd_status_aborted() {
  process.env.FAKE_CLAUDE_MODE = 'aborted';
  const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
  const events = await drain(runId);
  const turnEnd = events.find((e) => e.type === 'turn.end');
  assert.ok(turnEnd, 'expected a turn.end event');
  assert.equal(turnEnd.status, 'aborted', 'status must be "aborted" for aborted_streaming');
  assert.equal(turnEnd.isError, false, 'an aborted turn is not the same as an error turn');
  adapter.stop(runId);
  delete process.env.FAKE_CLAUDE_MODE;
}

// ---------------------------------------------------------------------------
// Finding S7: stop()'s SIGKILL fallback timer must not kill a process that
// resume() rebinds run.child to within the timer's window. This actually
// triggers the race (a quick death on SIGINT, then an immediate resume())
// and waits past the original 3s fallback deadline to prove the NEW process
// is untouched.
// ---------------------------------------------------------------------------
async function test_stop_resume_race_does_not_kill_new_child() {
  process.env.FAKE_CLAUDE_MODE = 'completed';
  process.env.FAKE_CLAUDE_EXIT_ON_SIGINT_MS = '50'; // old child dies fast on SIGINT
  delete process.env.FAKE_CLAUDE_IGNORE_SIGINT;

  const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
  await drain(runId); // let the first turn finish and claudeSessionId get set
  const run = adapter._getRunForTest(runId);
  assert.ok(run.claudeSessionId, 'precondition: run must have a session id to resume from');

  const oldChild = run.child;
  adapter.stop(runId); // schedules the 3s SIGKILL fallback against oldChild

  // Wait for the old child to actually exit (its fast-death timer fires at ~50ms).
  await new Promise((resolve) => {
    const check = () => {
      if (run.exitCode !== null) return resolve();
      setTimeout(check, 10);
    };
    check();
  });
  assert.notEqual(oldChild.pid, undefined);

  // Resume well inside stop()'s original 3s window.
  delete process.env.FAKE_CLAUDE_EXIT_ON_SIGINT_MS;
  process.env.FAKE_CLAUDE_IGNORE_SIGINT = '1'; // new child must NOT die on SIGINT either
  const resumedRunId = adapter.resume(runId);
  assert.equal(resumedRunId, runId, 'resume() must return the same runId');
  const newChild = run.child;
  assert.notEqual(newChild, oldChild, 'resume() must have rebound run.child to a new process');

  // Wait past the ORIGINAL stop() timer's 3s deadline.
  await sleep(3300);

  assert.equal(newChild.killed, false, 'the stale stop() timer must not have SIGKILLed the resumed child');
  assert.equal(run.exitCode, null, 'the resumed run must still be alive after the stale timer window passes');

  // Cleanup: stop the resumed child for real.
  adapter.stop(runId);
  await sleep(200);
  delete process.env.FAKE_CLAUDE_IGNORE_SIGINT;
  delete process.env.FAKE_CLAUDE_MODE;
}

// ---------------------------------------------------------------------------
// Finding S7 (second half): resume() must install the same child.on('error')
// handler start() does, so a spawn failure during resume() reports an
// 'errored' run status instead of crashing the host process with an
// unhandled 'error' event.
// ---------------------------------------------------------------------------
async function test_resume_installs_error_handler() {
  process.env.FAKE_CLAUDE_MODE = 'completed';
  process.env.FAKE_CLAUDE_EXIT_ON_SIGINT_MS = '20';
  const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
  await drain(runId);
  const run = adapter._getRunForTest(runId);
  adapter.stop(runId);
  await new Promise((resolve) => {
    const check = () => (run.exitCode !== null ? resolve() : setTimeout(check, 10));
    check();
  });

  // Make the binary CLAUDE_BIN points at genuinely disappear on disk, so
  // resume()'s spawn() call gets a real ENOENT — CLAUDE_BIN itself cannot
  // be swapped post-import (adapter.js captures it once, at module load).
  fs.renameSync(FAKE_CLAUDE, FAKE_CLAUDE_MISSING);
  try {
    adapter.resume(runId);
    // If resume() lacked the child.on('error') handler, the ENOENT 'error'
    // event on the child would be unhandled and this process would have
    // already crashed by now instead of reaching this assertion.
    await sleep(300);
    assert.equal(run.status, 'errored', 'a resume() spawn failure must be reported as an errored run, not crash the host');
  } finally {
    fs.renameSync(FAKE_CLAUDE_MISSING, FAKE_CLAUDE);
  }
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_EXIT_ON_SIGINT_MS;
}

// ---------------------------------------------------------------------------
// Finding M14: preflight() must fail fast and clearly for a missing binary,
// and succeed for a present one.
// ---------------------------------------------------------------------------
async function test_preflight() {
  const ok = await adapter.preflight();
  assert.equal(ok.ok, true, 'preflight against the fake claude binary must succeed');
  assert.equal(ok.version, '2.1.260-fake', 'preflight must report the version the binary printed');

  // Make CLAUDE_BIN's target genuinely disappear and re-run preflight()
  // itself (not a hand-rolled equivalent) to prove the real exported
  // function fails fast and clearly.
  fs.renameSync(FAKE_CLAUDE, FAKE_CLAUDE_MISSING);
  try {
    const missing = await adapter.preflight();
    assert.equal(missing.ok, false, 'preflight must report failure for a missing binary');
    assert.match(missing.reason, /not found/i, 'preflight must give a clear reason, not a generic error');
  } finally {
    fs.renameSync(FAKE_CLAUDE_MISSING, FAKE_CLAUDE);
  }
}

// ---------------------------------------------------------------------------
// Phase 2: the approval channel. `--permission-prompt-tool stdio` is what makes
// the CLI park a decision on us instead of auto-denying it, and the auto-deny is
// SILENT — no error, no warning, the model is just told "you haven't granted it
// yet" (measured; ../probe/evidence/02-negative-auto-denied.txt). A flag whose
// absence is invisible is exactly the kind that gets dropped in a tidy-up, so
// argv is asserted directly.
// ---------------------------------------------------------------------------
async function test_approval_flag_is_present_by_default() {
  const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
  const run = adapter._getRunForTest(runId);
  const args = run.child.spawnargs;
  const i = args.indexOf('--permission-prompt-tool');
  assert.ok(i !== -1, `argv must carry --permission-prompt-tool, got: ${args.join(' ')}`);
  assert.equal(args[i + 1], 'stdio', 'and its value must be stdio — that is what routes the decision to us');
  adapter.stop(runId);

  // ...and opting out must really opt out, rather than being ignored.
  const off = adapter.start({ prompt: 'hi', cwd: process.cwd(), approvalMode: 'off' });
  assert.equal(
    adapter._getRunForTest(off).child.spawnargs.includes('--permission-prompt-tool'),
    false,
    'approvalMode: "off" must not pass the flag',
  );
  adapter.stop(off);
}

// ---------------------------------------------------------------------------
// Phase 2, item 2: a worker's environment is DECLARED, not inherited. Asserted on
// the real spawnargs for the same reason as the approval flag above — the failure
// mode is silent. A worker that inherits the developer's global config still works;
// it just costs more, behaves differently, and cannot be reproduced on another
// machine. Measured baseline: 6 MCP servers, 110 tools, 2 SessionStart hooks in an
// EMPTY directory (../probe/evidence/08-worker-env-matrix.txt).
// ---------------------------------------------------------------------------
async function test_worker_env_is_pinned_in_argv() {
  const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
  const args = adapter._getRunForTest(runId).child.spawnargs;
  // `'none'` by default (owner decision 2026-09-08): repo config EXECUTES repo hooks, so it is opt-in.
  assert.ok(args.includes('--setting-sources='),
    `a default worker must load NO settings sources, got: ${args.join(' ')}`);
  assert.equal(args.includes('--setting-sources=project'), false,
    'and must NOT silently load the repo\'s settings, which would execute its hooks');
  assert.ok(args.includes('--strict-mcp-config'),
    'and must not inherit the developer\'s MCP servers');
  adapter.stop(runId);

  // The escape hatch must really escape, or `inherit` is a lie in the record.
  const inherited = adapter.start({ prompt: 'hi', cwd: process.cwd(), envProfile: 'inherit' });
  const iargs = adapter._getRunForTest(inherited).child.spawnargs;
  assert.equal(iargs.some((a) => a.startsWith('--setting-sources')), false,
    'envProfile: "inherit" must pass no --setting-sources');
  assert.equal(iargs.includes('--strict-mcp-config'), false,
    'envProfile: "inherit" must pass no --strict-mcp-config either');
  adapter.stop(inherited);
}

// A resumed generation is spawned from the same builder, so it must be pinned too.
// An unpinned resume would mean generation 1 and generation 2 of one run ran in
// different environments — the divergence finding S7 exists to prevent, by another road.
async function test_worker_env_survives_resume() {
  process.env.FAKE_CLAUDE_MODE = 'completed';
  const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
  await waitForEvent(runId, (e) => e.type === 'session.init', { what: 'session.init (needed for a resumable session id)' });
  adapter.stop(runId);
  await sleep(200);

  const resumed = adapter.resume(runId);
  assert.equal(resumed, runId, `expected a resume, got ${resumed}`);
  const args = adapter._getRunForTest(runId).child.spawnargs;
  assert.ok(args.includes('--setting-sources='), 'a resumed generation must be pinned too');
  assert.ok(args.includes('--strict-mcp-config'));

  // ...and re-recorded, because the settings on disk can change between generations.
  const envEvents = adapter._getRunForTest(runId)._eventLog.filter((e) => e.type === 'worker.env');
  assert.equal(envEvents.length, 2, `expected one worker.env per generation, got ${envEvents.length}`);
  assert.equal(envEvents[1].resumed, true, 'the second must be marked as the resumed one');
  adapter.stop(runId);
}

// The traceability guard: the environment a worker got is in that worker's own transcript.
//
// NOTE ON WHAT THIS DOES *NOT* PROVE. The emit is placed before `spawnManaged` for
// readability — worker.env reads as the transcript's first line — but that ORDERING is not
// independently observable and this case does not claim it: a failed spawn (ENOENT, EACCES)
// arrives ASYNCHRONOUSLY as an 'error' event, so the event log gets worker.env either way.
// Mutation E12 originally claimed to protect the ordering and PASSED, which is what
// surfaced this; see runtime/FINDINGS.md.
async function test_worker_env_event_is_recorded() {
  const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
  const log = adapter._getRunForTest(runId)._eventLog;
  const env = log.find((e) => e.type === 'worker.env');
  assert.ok(env, 'the environment must be recorded in the run\'s own transcript');
  assert.equal(env.profile, 'none');
  assert.equal(env.strictMcpConfig, true);
  assert.equal(env.runId, runId, 'and must be correlated like every other event');
  // It must precede anything the harness itself produced, or the record arrives after the
  // behaviour it is supposed to explain.
  const firstHarnessEvent = log.findIndex((e) => e.type !== 'worker.env');
  assert.ok(firstHarnessEvent === -1 || log.indexOf(env) < firstHarnessEvent,
    'worker.env must come before the harness\'s own events');
  adapter.stop(runId);
}

// A SYNCHRONOUS spawn refusal must leave nothing registered. `spawnManaged` throws before
// `spawn()` when the spawn-depth ceiling is already reached — a real path, since the
// supervisor's own children run at depth 1 — and the caller of a throwing `start()` never
// learns the runId, so a leaked entry would be unreachable and never disposed.
async function test_sync_spawn_refusal_leaves_nothing_registered() {
  const before = adapter.listRuns().length;
  const saved = process.env.DASHBOARD_SPAWN_DEPTH;
  process.env.DASHBOARD_SPAWN_DEPTH = '99'; // already past MAX_SPAWN_DEPTH
  try {
    assert.throws(() => adapter.start({ prompt: 'hi', cwd: process.cwd() }),
      /depth/i, 'the spawn-depth ceiling must refuse the spawn');
    assert.equal(adapter.listRuns().length, before,
      'a synchronously refused spawn must not leave a registered run behind');
  } finally {
    if (saved === undefined) delete process.env.DASHBOARD_SPAWN_DEPTH;
    else process.env.DASHBOARD_SPAWN_DEPTH = saved;
  }
}

// An invalid declaration must be refused BEFORE anything is spawned, and must leave no
// adapter state behind. The mirror of review-0003's `start()` finding: there, a spawn
// preceded its row and left a live child with no row; here a throw after registration
// would leave a row-shaped entry with no child.
async function test_invalid_env_spawns_nothing_and_registers_nothing() {
  // `listRuns`, not `list` — an optional-call against the wrong name would make this
  // assertion silently vacuous, which is the "overlapping guards" trap from the Phase 2
  // review: a case that passes without exercising its mechanism.
  const before = adapter.listRuns().length;
  assert.throws(() => adapter.start({ prompt: 'hi', cwd: process.cwd(), envProfile: 'nope' }),
    /unknown spec.envProfile/, 'an invalid environment must be refused');
  assert.equal(adapter.listRuns().length, before,
    'a refused start must not leave a registered run behind');
}

// The environment pin has TWO axes and only MCP was observable, so a regression that restored
// the developer's global hooks while keeping MCP empty would have left every environment
// assertion green. `harness.hook` closes that. THIS case is the positive control for the real
// slice's `0 hooks fired` assertion: without proof that hook events are mapped at all, asserting
// zero of them proves nothing. Measured against the real CLI too — `envProfile: 'inherit'` yields
// 2 hooks and 6 MCP servers, `'project'` yields 0 and 0
// (../probe/evidence/11-hook-axis-positive-control.txt).
async function test_harness_hook_events_are_mapped() {
  process.env.FAKE_CLAUDE_HOOKS = '1';
  try {
    const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
    await waitForEvent(runId, (e) => e.type === 'session.init', { what: 'session.init' });
    const log = adapter._getRunForTest(runId)._eventLog;

    const started = log.filter((e) => e.type === 'harness.hook' && e.phase === 'started');
    assert.equal(started.length, 1, `a hook the CLI ran must be recorded, got ${JSON.stringify(log.map((e) => e.type))}`);
    assert.equal(started[0].hookName, 'SessionStart:startup', 'and must carry which hook it was');
    assert.ok(log.some((e) => e.type === 'harness.hook' && e.phase === 'response'),
      'both phases are recorded: a hook that started and never responded is the interesting case');

    // Hooks precede init on the real CLI, so the ordering the fake reproduces must survive.
    assert.ok(log.findIndex((e) => e.type === 'harness.hook') < log.findIndex((e) => e.type === 'session.init'),
      'hooks run before the session initializes; a record that reordered them would mislead');

    // ...and session.init must carry what the CLI reported it loaded, not just a session id.
    const init = log.find((e) => e.type === 'session.init');
    assert.deepEqual(init.mcpServers, ['leaky-server:connected'],
      'session.init must record the MCP servers the CLI reports, name and status');
    assert.equal(init.toolCount, 3, 'and counts rather than lists, for the tool set');
    adapter.stop(runId);
  } finally {
    delete process.env.FAKE_CLAUDE_HOOKS;
  }
}

// PLAN.md 12.1: a preflight session must leave nothing behind, and the cheapest way to leave no
// harness-side session is never to write one. `--no-session-persistence` does that. NOT writing it
// beats deleting it, because a delete can fail and a SIGKILL between the check and its cleanup
// pre-empts the delete entirely — which is exactly the case a preflight has to survive, since it is
// designed to be run liberally. Measured on claude 2.1.263; the flag requires `--print`, which this
// argv always passes.
async function test_ephemeral_session_leaves_no_harness_history() {
  const ephemeral = adapter.start({ prompt: 'hi', cwd: process.cwd(), ephemeral: true });
  const args = adapter._getRunForTest(ephemeral).child.spawnargs;
  assert.ok(args.includes('--no-session-persistence'),
    `an ephemeral session must not be written to the harness's store, got: ${args.join(' ')}`);
  assert.ok(args.includes('-p'),
    'and --no-session-persistence requires --print, so that must still be there');
  adapter.stop(ephemeral);

  // Opt-IN, not the default: an ephemeral session cannot be RESUMED, which is correct for a
  // preflight (nothing worth resuming) and wrong for a worker.
  const normal = adapter.start({ prompt: 'hi', cwd: process.cwd() });
  assert.equal(
    adapter._getRunForTest(normal).child.spawnargs.includes('--no-session-persistence'), false,
    'a normal worker run must remain resumable',
  );
  adapter.stop(normal);
}

/** Wait for a predicate over the run's buffered event log, or throw. */
async function waitForEvent(runId, pred, { timeoutMs = 5000, what = 'event' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = adapter._getRunForTest(runId)?._eventLog.find(pred);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function test_approval_request_is_surfaced_and_answerable() {
  process.env.FAKE_CLAUDE_PARK_APPROVAL = '1';
  try {
    const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
    const request = await waitForEvent(runId, (e) => e.type === 'approval.request', { what: 'an approval.request event' });

    assert.equal(request.toolName, 'WebFetch');
    assert.equal(request.requiresUserInteraction, false, 'a plain tool call is not a question');
    assert.deepEqual(request.input, { url: 'https://example.com' }, 'the tool input is passed through for a human to read');
    assert.ok(request.suggestions, "the harness's own always-allow offer is passed through");
    assert.deepEqual(adapter.pendingApprovals(runId).map((p) => p.requestId), [request.requestId]);

    // Awaited: `answerApproval` is async now, because "delivered" must mean the stdin write was
    // accepted rather than merely queued (the review's finding that a queued write was reported
    // as a completed delivery).
    const result = await adapter.answerApproval(runId, request.requestId, { behavior: 'deny', message: 'no external fetches' });
    assert.equal(result.delivered, true);
    assert.deepEqual(adapter.pendingApprovals(runId), [], 'an answered request is no longer parked');

    // The harness echoes what it received, so this asserts the DECISION arrived — not merely
    // that something was written to stdin.
    const toolResult = await waitForEvent(runId, (e) => e.type === 'tool.result', { what: 'the harness to act on the answer' });
    const delivered = JSON.parse(toolResult.content);
    assert.equal(delivered.behavior, 'deny');
    assert.equal(delivered.message, 'no external fetches', 'the deny message must reach the harness unaltered');

    // Answering twice must fail loudly rather than silently writing to a settled request.
    await assert.rejects(
      () => adapter.answerApproval(runId, request.requestId, { behavior: 'allow' }),
      /no parked request/,
      'a second answer to the same request must reject',
    );
    // And a decision that is neither allow nor deny must never be forwarded.
    adapter._getRunForTest(runId)._parkedRequests.set('probe', { ...request, requestId: 'probe', generation: adapter._getRunForTest(runId)._generation });
    await assert.rejects(
      () => adapter.answerApproval(runId, 'probe', { behavior: 'maybe' }),
      /must be 'allow' or 'deny'/,
      'a malformed decision must be refused rather than sent as-is',
    );
    adapter.stop(runId);
  } finally {
    delete process.env.FAKE_CLAUDE_PARK_APPROVAL;
  }
}

// A request parked by a process that resume() has replaced cannot be answered through the new
// process's stdin: the id means nothing there, so the write would be a silent no-op and the
// dashboard would record a delivery that never happened. This is the guard mutation M8 showed
// nothing else covers (the fake harness in runtime/test/ has its own copy of it).
async function test_approval_answer_is_generation_pinned() {
  process.env.FAKE_CLAUDE_PARK_APPROVAL = '1';
  try {
    const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
    const request = await waitForEvent(runId, (e) => e.type === 'approval.request', { what: 'an approval.request event' });
    const run = adapter._getRunForTest(runId);

    // Simulate what a resume() does to the bookkeeping: the parked entry belongs to the
    // generation that asked, and the run has since moved on.
    run._parkedRequests.set(request.requestId, { ...run._parkedRequests.get(request.requestId), generation: run._generation - 1 });
    await assert.rejects(
      () => adapter.answerApproval(runId, request.requestId, { behavior: 'allow' }),
      /generation/,
      'answering a request from a superseded generation must reject, not write to the new process',
    );
    // And the caller's OWN expectation is checked too: a stored answer that names a different
    // generation than the parked request must be refused even when the adapter's own map looks
    // current. That is the authorization question — did the process that asked get the answer that
    // was given to IT — and only the caller can settle it.
    const live = adapter._getRunForTest(runId);
    live._parkedRequests.set('gen-probe', { ...request, requestId: 'gen-probe', generation: live._generation });
    await assert.rejects(
      () => adapter.answerApproval(runId, 'gen-probe', { behavior: 'allow' }, { expectGeneration: live._generation - 1 }),
      /recorded for generation/,
      'an answer recorded for a different generation must be refused',
    );
    // The refusal leaves the request PARKED, unlike the stale-entry case above which drops it:
    // nothing is wrong with the request, only with the answer offered for it, so it stays
    // answerable by a correct one.
    assert.equal(adapter.pendingApprovals(runId).length, 1, 'a refused answer does not consume the request');
    live._parkedRequests.clear();
    assert.deepEqual(adapter.pendingApprovals(runId), [], 'and the stale entry is dropped rather than left looking answerable');
    adapter.stop(runId);
  } finally {
    delete process.env.FAKE_CLAUDE_PARK_APPROVAL;
  }
}

// A real resume() withdraws what the old process had parked. Without this a resumed run keeps
// advertising an answerable question belonging to a process that no longer exists.
//
// The process is killed DIRECTLY here rather than through `adapter.stop()`, because stop()
// clears the parked map itself — deliberately and silently, since the supervisor's terminal
// path closes that run's asks with an accurate reason ("stopped") a moment later, and a
// "withdrawn by the harness" attribution would be wrong for a decision a human made. The
// interesting case for resume() is therefore the one where the process died on its own and
// nothing tidied up first.
async function test_resume_withdraws_parked_requests() {
  process.env.FAKE_CLAUDE_PARK_APPROVAL = '1';
  try {
    const runId = adapter.start({ prompt: 'hi', cwd: process.cwd() });
    await waitForEvent(runId, (e) => e.type === 'approval.request', { what: 'an approval.request event' });
    const run = adapter._getRunForTest(runId);
    run.claudeSessionId = 'fake-sess-for-resume';

    process.kill(run.child.pid, 'SIGKILL');
    await waitForEvent(runId, (e) => e.type === 'process.exit', { what: 'the child to exit' });
    assert.equal(adapter.pendingApprovals(runId).length, 1, 'a process dying does not by itself clear what it parked');

    const resumed = adapter.resume(runId);
    assert.equal(resumed, runId, 'resume keeps the same runId');
    const withdrawn = await waitForEvent(runId, (e) => e.type === 'approval.withdrawn', { what: 'the parked request to be withdrawn' });
    assert.equal(withdrawn.reason, 'process-replaced', 'and it says why, so the ask can be closed honestly');
    assert.deepEqual(adapter.pendingApprovals(runId), [], 'nothing from the old process is still parked');
    adapter.stop(runId);
  } finally {
    delete process.env.FAKE_CLAUDE_PARK_APPROVAL;
  }
}

const tests = [
  ['turn.end status: completed', test_turnEnd_status_completed],
  ['turn.end status: error', test_turnEnd_status_error],
  ['turn.end status: aborted', test_turnEnd_status_aborted],
  ['stop/resume race does not kill the new child', test_stop_resume_race_does_not_kill_new_child],
  ['resume() installs child error handler', test_resume_installs_error_handler],
  ['preflight()', test_preflight],
  ['approval: the stdio host flag is present by default and opt-out works', test_approval_flag_is_present_by_default],
  ['approval: a parked request is surfaced and answerable', test_approval_request_is_surfaced_and_answerable],
  ['approval: an answer is pinned to the generation that asked', test_approval_answer_is_generation_pinned],
  ['approval: resume() withdraws what the replaced process had parked', test_resume_withdraws_parked_requests],
  ['env: a worker\'s environment is pinned in argv, and inherit escapes', test_worker_env_is_pinned_in_argv],
  ['env: the pin and its record survive resume()', test_worker_env_survives_resume],
  ['env: the environment is recorded in the run transcript', test_worker_env_event_is_recorded],
  ['env: an invalid declaration spawns and registers nothing', test_invalid_env_spawns_nothing_and_registers_nothing],
  ['env: a synchronous spawn refusal registers nothing', test_sync_spawn_refusal_leaves_nothing_registered],
  ['env: harness hook events and the CLI-reported environment are mapped', test_harness_hook_events_are_mapped],
  ['env: an ephemeral session leaves no harness-side history', test_ephemeral_session_leaves_no_harness_history],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Teardown, and it is a real test rather than housekeeping.
//
// FOUND BY LOOKING AT `ps`, 2026-09-07: this suite had leaked 29 `fake-claude.mjs`
// processes, the oldest running over FIFTEEN HOURS. Nothing here ever checked, so every
// run of this file quietly added more.
//
// Why they leak, and why `adapter.stop()` is not enough: children are spawned detached
// through runtime/spawn.js (they lead their own process group, by design — that is the
// whole point of Group 5), `stop()` sends SIGINT first, and its SIGKILL escalation is a
// 3-SECOND TIMER. This process exits long before that timer fires, so the timer dies with
// it and a child that ignores SIGINT — which several fixtures deliberately do — survives
// its parent forever. `resume()`-spawned children are the worst case: a fresh detached
// process bound late in a test.
//
// A suite whose subject is process ownership must not leak processes. `disposeAll()` kills
// each run's whole process group and awaits it, and then this asserts the outcome instead
// of trusting it.
// ---------------------------------------------------------------------------
const { execFile } = await import('node:child_process');
const survivors = () =>
  new Promise((resolve) => {
    // `ps -A` + a filter rather than `pgrep -f`, for the same portability reason
    // runtime/procinfo.js gives: BSD and procps disagree about the selector flags.
    execFile('/bin/ps', ['-A', '-o', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        (stdout ?? '')
          .split('\n')
          .filter((line) => line.includes(scratchDir))
          .map((line) => line.trim()),
      );
    });
  });

let leaked = [];
try {
  const disposed = await adapter.disposeAll({ graceMs: 300 });
  // Give the OS a moment to reap the group after the kill returns.
  await sleep(300);
  leaked = await survivors();
  if (leaked.length > 0) {
    failed += 1;
    console.error(`FAIL: teardown left ${leaked.length} process(es) alive after disposeAll (${disposed.stopped.length} run(s) disposed)`);
    for (const line of leaked) console.error(`  leaked: ${line}`);
  } else {
    console.log(`PASS: teardown — disposeAll took down all ${disposed.stopped.length} run(s), nothing survived`);
  }
} catch (err) {
  failed += 1;
  console.error('FAIL: teardown threw');
  console.error(err);
}

// The scratch dir holds a copy of the fake binary; removing it only after the survivor
// check, because the check identifies our children BY that path.
try {
  fs.rmSync(scratchDir, { recursive: true, force: true });
} catch { /* best effort */ }

const total = tests.length + 1; // +1 for the teardown check above
if (failed > 0) {
  console.error(`\n${failed}/${total} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${total} test(s) passed.`);
  process.exit(0);
}
