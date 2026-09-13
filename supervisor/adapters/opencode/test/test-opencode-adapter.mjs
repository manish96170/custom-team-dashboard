#!/usr/bin/env node
// Real, asserting tests for the OpenCode adapter fixes.
//
// Every test throws on failure. main() at the bottom catches any throw,
// prints a clear FAIL line, and calls process.exit(1) — no test in this
// file is allowed to exit 0 after an assertion fails (finding M6).
//
// Run: node supervisor/adapters/opencode/test/test-opencode-adapter.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The adapter spawns the bare command name `opencode` (no env override, by
// design — matches the real adapter's `spawn('opencode', ...)`), so the
// only way to control which binary it finds is PATH. Build a scratch PATH
// entry whose only executable is our fake, named exactly `opencode`.
const scratchBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-bin-'));
const FAKE_OC = path.join(scratchBinDir, 'opencode');
const FAKE_OC_MISSING = path.join(scratchBinDir, 'opencode.movedaway');
// Copy the fake server's SOURCE directly into the executable named
// `opencode` (rather than an intermediate `sh -c 'exec node ...'` wrapper)
// so the isolated PATH below only ever needs to resolve `node` itself, not
// `sh`'s own builtins like `dirname` — those aren't guaranteed present on
// a PATH trimmed down to exactly two entries.
fs.copyFileSync(path.join(__dirname, 'fake-opencode-server.mjs'), FAKE_OC);
fs.chmodSync(FAKE_OC, 0o755);
// Isolate PATH down to ONLY our scratch dir plus node's own directory (the
// fake binary's shebang execs `node`). This machine has a real `opencode`
// installed (/opt/homebrew/bin, ~/.opencode/bin) — prepending to the
// existing PATH would let renaming our fake away silently fall through to
// the real binary, defeating the missing-binary tests entirely.
process.env.PATH = `${scratchBinDir}:${path.dirname(process.execPath)}`;

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-log-'));

const adapter = await import('../adapter.js');

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function withFreshLog(fn) {
  const logFile = path.join(logDir, `prompts-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.FAKE_OC_LOG_FILE = logFile;
  try {
    return await fn(logFile);
  } finally {
    delete process.env.FAKE_OC_LOG_FILE;
  }
}

function readLogLines(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function drainUntilTurnEnd(runId, { timeoutMs = 5000 } = {}) {
  const events = [];
  const overallTimeout = sleep(timeoutMs).then(() => 'timeout');
  const iter = adapter.observe(runId);
  while (true) {
    const result = await Promise.race([iter.next(), overallTimeout]);
    if (result === 'timeout') break;
    const { value, done } = result;
    if (value !== undefined) events.push(value);
    if (done) break;
    if (value && value.type === 'turn.end') break;
  }
  return events;
}

// Unlike drainUntilTurnEnd, does NOT stop at the first turn.end — it drains until the generator
// itself naturally returns (observe()'s own `sawTerminal` exit) or the timeout. Needed to prove a
// SECOND, redundant turn.end was actually suppressed rather than merely unobserved because the test
// itself stopped looking right after the first one.
async function drainAll(runId, { timeoutMs = 3000 } = {}) {
  const events = [];
  const overallTimeout = sleep(timeoutMs).then(() => 'timeout');
  const iter = adapter.observe(runId);
  while (true) {
    const result = await Promise.race([iter.next(), overallTimeout]);
    if (result === 'timeout') break;
    const { value, done } = result;
    if (value !== undefined) events.push(value);
    if (done) break;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Finding M14: preflight() must succeed for a present binary and fail
// clearly for a missing one.
// ---------------------------------------------------------------------------
async function test_preflight() {
  const ok = await adapter.preflight();
  assert.equal(ok.ok, true, 'preflight against the fake opencode binary must succeed');

  fs.renameSync(FAKE_OC, FAKE_OC_MISSING);
  try {
    const missing = await adapter.preflight();
    assert.equal(missing.ok, false, 'preflight must report failure for a missing binary');
    assert.match(missing.reason, /not found/i, 'preflight must give a clear reason');
  } finally {
    fs.renameSync(FAKE_OC_MISSING, FAKE_OC);
  }
}

// ---------------------------------------------------------------------------
// Finding S6: a missing `opencode` binary at spawn time (i.e. discovered
// after preflight, mid-run) must reject start() with a clear error instead
// of crashing the host process via an unhandled child 'error' event.
// ---------------------------------------------------------------------------
async function test_missing_binary_spawn_error_is_handled() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
  fs.renameSync(FAKE_OC, FAKE_OC_MISSING);
  let threw = false;
  try {
    await adapter.start({ prompt: 'hi', cwd });
  } catch (err) {
    threw = true;
    assert.match(String(err.message || err), /failed to spawn|ENOENT/i, 'error must clearly indicate a spawn failure');
  } finally {
    fs.renameSync(FAKE_OC_MISSING, FAKE_OC);
  }
  // The real proof this works is that this test process is still running at
  // all — an unhandled child 'error' event would have crashed it already.
  assert.equal(threw, true, 'start() must reject, not hang or silently succeed, when the binary is missing');
}

// ---------------------------------------------------------------------------
// Finding S5: sendInput() must reuse the model persisted at start() time,
// not silently fall back to a hardcoded default.
// ---------------------------------------------------------------------------
async function test_model_persists_across_turns() {
  await withFreshLog(async (logFile) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
    const requestedModel = { providerID: 'test-provider', modelID: 'test-model-x' };
    const runId = await adapter.start({ prompt: 'turn 1', cwd, model: requestedModel, effort: 'high' });
    await drainUntilTurnEnd(runId);

    await adapter.sendInput(runId, 'turn 2');
    await sleep(150); // let the fake server log the second prompt_async call

    const calls = readLogLines(logFile);
    assert.equal(calls.length, 2, `expected 2 logged prompt_async calls, got ${calls.length}`);
    for (const [i, call] of calls.entries()) {
      assert.deepEqual(call.model, requestedModel, `turn ${i + 1} must use the model requested at start(), got ${JSON.stringify(call.model)}`);
      assert.equal(call.variant, 'high', `turn ${i + 1} must carry the effort/variant persisted at start()`);
    }
    await adapter.stop(runId);
  });
}

// ---------------------------------------------------------------------------
// Finding S8: observe() must replay from a buffer started at start() time,
// so a turn that finishes before observe() is ever called does not hang
// the caller forever.
// ---------------------------------------------------------------------------
async function test_observe_replays_fast_turn() {
  process.env.FAKE_OC_FAST_TURN = '1';
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
    const runId = await adapter.start({ prompt: 'fast', cwd });
    // Deliberately wait for the turn to finish server-side BEFORE calling
    // observe() at all — this is the exact failure mode finding S8 covers.
    await sleep(300);
    const events = await drainUntilTurnEnd(runId, { timeoutMs: 2000 });
    const turnEnd = events.find((e) => e.type === 'turn.end');
    assert.ok(turnEnd, 'observe() must still surface the turn.end for a turn that already finished before observe() was called');
    assert.equal(turnEnd.status, 'completed');
    await adapter.stop(runId);
  } finally {
    delete process.env.FAKE_OC_FAST_TURN;
  }
}

// ---------------------------------------------------------------------------
// Finding B4: turn.end must carry the normalized `status` field plus a
// derived `isError` boolean, for both the success and error/abort paths.
// ---------------------------------------------------------------------------
async function test_turnEnd_status_shape() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
  const runId = await adapter.start({ prompt: 'hi', cwd });
  const events = await drainUntilTurnEnd(runId);
  const turnEnd = events.find((e) => e.type === 'turn.end');
  assert.ok(turnEnd, 'expected a turn.end event');
  assert.equal(turnEnd.status, 'completed');
  assert.equal(turnEnd.isError, false, 'isError must be derived from status, not a separate source of truth');
  await adapter.stop(runId);
}

async function test_turnEnd_prompt_rejected_synthesizes_error() {
  process.env.FAKE_OC_PROMPT_MODE = 'reject';
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
    const runId = await adapter.start({ prompt: 'hi', cwd });
    const events = await drainUntilTurnEnd(runId, { timeoutMs: 3000 });
    const turnEnd = events.find((e) => e.type === 'turn.end');
    assert.ok(turnEnd, 'a rejected prompt_async must still synthesize a terminating turn.end, not hang forever (finding B9)');
    assert.equal(turnEnd.status, 'error');
    assert.equal(turnEnd.isError, true);
  } finally {
    delete process.env.FAKE_OC_PROMPT_MODE;
  }
}

// ---------------------------------------------------------------------------
// Finding S9: an SSE event with no sessionID, and a type NOT on the
// verified session-less allowlist, must be dropped — not broadcast to
// every session on that server.
// ---------------------------------------------------------------------------
async function test_sessionless_nonallowlisted_event_is_dropped() {
  process.env.FAKE_OC_EMIT_LEAK_EVENT = '1';
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
    // Two sessions on the SAME server/cwd, so both are on the one SSE
    // stream the leak event would be broadcast into.
    const runIdA = await adapter.start({ prompt: 'A', cwd });
    const runIdB = await adapter.start({ prompt: 'B', cwd });
    const [eventsA, eventsB] = await Promise.all([
      drainUntilTurnEnd(runIdA, { timeoutMs: 3000 }),
      drainUntilTurnEnd(runIdB, { timeoutMs: 3000 }),
    ]);
    for (const [label, events] of [['A', eventsA], ['B', eventsB]]) {
      const leakedDelta = events.find((e) => e.type === 'assistant.delta' && e.text === 'LEAKED-CONTENT');
      assert.equal(
        leakedDelta,
        undefined,
        `session ${label} must NOT have received the session-less assistant.delta ("LEAKED-CONTENT") — a fail-open filter would deliver it to every session on the server`,
      );
      const turnEnd = events.find((e) => e.type === 'turn.end');
      assert.ok(turnEnd, `session ${label} must still have received its own real turn.end`);
    }
    await adapter.stop(runIdA);
    await adapter.stop(runIdB);
  } finally {
    delete process.env.FAKE_OC_EMIT_LEAK_EVENT;
  }
}

// ---------------------------------------------------------------------------
// Older should-fix backlog: a real OpenCode abort emits BOTH session.error
// (MessageAbortedError) and session.idle for the SAME logical turn ending
// (measured, see interrupt()'s own doc comment) — both map to turn.end, so
// an aborted run used to get overwritten to status "completed" by the
// second, redundant event in any last-wins consumer (event-pump.js's
// updateDerived does exactly this).
// ---------------------------------------------------------------------------
async function test_abort_does_not_emit_a_redundant_second_turn_end() {
  process.env.FAKE_OC_NEVER_FINISH = '1';
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
    const runId = await adapter.start({ prompt: 'this turn never naturally finishes', cwd });
    await sleep(100); // let the turn genuinely be in flight before aborting it
    await adapter.interrupt(runId);

    // drainAll, not drainUntilTurnEnd: the latter stops at the FIRST turn.end by design, which
    // would make this assertion pass trivially (never even looking for a second one) regardless
    // of whether the adapter actually suppressed it.
    const events = await drainAll(runId, { timeoutMs: 3000 });
    const turnEnds = events.filter((e) => e.type === 'turn.end');
    assert.equal(
      turnEnds.length, 1,
      `an abort must produce exactly ONE turn.end, not the server's real two-event sequence leaking through; got ${JSON.stringify(turnEnds)}`,
    );
    assert.equal(turnEnds[0].status, 'aborted', 'the real (first) event\'s status must survive, not get overwritten to "completed" by the redundant second one');
  } finally {
    delete process.env.FAKE_OC_NEVER_FINISH;
  }
}

// ---------------------------------------------------------------------------
// Older should-fix backlog: `server.instance.disposed` mapped to `null` (a
// deliberate liveness-only broadcast), so a run still mid-turn when its
// server tore itself down never got ANY terminal event — observe() would
// wait forever for a turn.end that could now never arrive.
// ---------------------------------------------------------------------------
async function test_server_disposed_mid_turn_synthesizes_turn_end() {
  process.env.FAKE_OC_NEVER_FINISH = '1';
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
    const runId = await adapter.start({ prompt: 'this turn never naturally finishes', cwd });
    const baseUrl = runId.split('::')[0];

    // Give the (never-finishing) turn a moment to genuinely be in flight, then dispose the
    // server out from under it — the exact "server ends before the turn does" ordering the
    // backlog note describes, not something a fast synchronous turn could ever race into.
    await sleep(100);
    const disposeRes = await fetch(`${baseUrl}/debug/dispose`, { method: 'POST' });
    assert.equal(disposeRes.ok, true, 'precondition: the fake server must have accepted the dispose trigger');

    const events = await drainUntilTurnEnd(runId, { timeoutMs: 3000 });
    const turnEnd = events.find((e) => e.type === 'turn.end');
    assert.ok(
      turnEnd,
      `a run whose server was disposed mid-turn must still get a synthesized turn.end, not hang forever; got events: ${JSON.stringify(events)}`,
    );
    assert.equal(turnEnd.status, 'error');
    assert.equal(turnEnd.isError, true);
    assert.match(turnEnd.error, /disposed/i);
  } finally {
    delete process.env.FAKE_OC_NEVER_FINISH;
  }
}

// ---------------------------------------------------------------------------
// Older should-fix backlog: verifyRunIdentity()'s HTTP-unavailable fallback
// (entry.sessionsKnown) used to be add-only — discardSession() never removed
// an entry once the session was genuinely deleted server-side, so a check
// landing during a transient HTTP outage fell back to that stale cache and
// reported a REAL server's 404 as a false "sessionKnown: true".
// ---------------------------------------------------------------------------
async function test_discarded_session_does_not_falsely_report_known_on_http_failure() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
  const runId = await adapter.start({ prompt: 'discard me', cwd });

  const discarded = await adapter.discardSession(runId);
  assert.equal(discarded.discarded, true, `precondition: the fake server must have actually deleted the session; got ${JSON.stringify(discarded)}`);

  // Force the SAME failure mode verifyRunIdentity()'s catch block handles: the server process
  // itself is still alive (verifyRunIdentity's `serverAlive` check is process-based, keyed by
  // `run.cwd`, untouched here), but the HTTP call to it fails. Pointing `run.baseUrl` at a port
  // nothing listens on makes the fetch fail fast (ECONNREFUSED) without needing to actually stop
  // responding to the real server, which would be slow and non-deterministic to arrange.
  const run = adapter._getRunForTest(runId);
  const realBaseUrl = run.baseUrl;
  run.baseUrl = 'http://127.0.0.1:1';
  let identity;
  try {
    identity = await adapter.verifyRunIdentity(runId);
  } finally {
    run.baseUrl = realBaseUrl;
  }

  assert.equal(identity.serverAlive, true, 'the server process itself is still alive — only the HTTP call to it failed');
  assert.equal(
    identity.sessionKnown, false,
    `a discarded session must not be falsely reported as known just because the HTTP check itself failed; got ${JSON.stringify(identity)}`,
  );
}

// ---------------------------------------------------------------------------
// Older should-fix backlog: "full adapter-iterator cancellation needs an
// AbortSignal on both adapters' observe() — iterator.return() is invoked
// now, but return() on an async generator suspended inside an await is
// queued until it resumes, so a generator blocked on a socket read cannot
// be cancelled at all." That JS semantics fact is real in general, but this
// checks whether it actually manifests as a hang against THIS adapter's
// actual observe() shape: its only internal await is bounded by its own
// 200ms setTimeout safety net (see observe()'s own doc comment), never a
// raw indefinite socket read — so return() should settle a parked next()
// well within that window, not "not at all."
// ---------------------------------------------------------------------------
async function test_iterator_return_settles_a_parked_next_within_bounded_time() {
  process.env.FAKE_OC_NEVER_FINISH = '1';
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
    const runId = await adapter.start({ prompt: 'this turn never naturally finishes', cwd });
    // Give the delta a moment to actually land in the run's buffered event log before observing,
    // so the drain loop below can tell "already buffered" from "genuinely parked" by TIMING rather
    // than by an event count this test would otherwise have to hardcode.
    await sleep(150);
    const iter = adapter.observe(runId);
    // Drain whatever is already buffered (worker.env, the delta) so the NEXT next() call is
    // genuinely the one that parks — a call answered instantly by already-buffered events would
    // not exercise the cancellation path being measured here at all. A next() call that does NOT
    // resolve within a short bound (well under observe()'s own 200ms safety-net poll) is the
    // genuinely-parked one; treat it as `parkedNext` rather than looping on it.
    let parkedNext;
    for (;;) {
      const candidate = iter.next();
      const raced = await Promise.race([candidate.then(() => 'resolved'), sleep(60).then(() => 'pending')]);
      if (raced === 'pending') { parkedNext = candidate; break; }
      if ((await candidate).done) { parkedNext = candidate; break; }
    }
    const start = Date.now();
    // The pump's own cancellation contract (runtime/event-pump.js's cancelIterator): call
    // return() while a next() may already be outstanding, exactly as it does during real teardown.
    const returned = iter.return();
    const settled = await Promise.race([
      Promise.all([parkedNext, returned]).then(() => 'settled'),
      sleep(1000).then(() => 'timeout'),
    ]);
    const elapsedMs = Date.now() - start;

    assert.equal(settled, 'settled', `the parked next() must settle once return() is called, not hang; waited ${elapsedMs}ms`);
    assert.ok(elapsedMs < 500, `expected cancellation well within the 200ms safety-net window (plus margin); took ${elapsedMs}ms`);
  } finally {
    delete process.env.FAKE_OC_NEVER_FINISH;
  }
}

// ---------------------------------------------------------------------------
// Finding S4: verifyRunIdentity() must independently report server liveness
// and whether the server still recognizes this specific session.
// ---------------------------------------------------------------------------
async function test_verifyRunIdentity_two_levels() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
  const runId = await adapter.start({ prompt: 'hi', cwd });
  await drainUntilTurnEnd(runId);

  const alive = await adapter.verifyRunIdentity(runId);
  assert.equal(alive.serverAlive, true, 'server must be reported alive while it is actually running');
  assert.equal(alive.sessionKnown, true, 'the server must still recognize a session it just handled');

  await adapter.disposeServer(cwd);
  await sleep(100);
  const afterDispose = await adapter.verifyRunIdentity(runId);
  assert.equal(afterDispose.serverAlive, false, 'server must be reported dead once its process has been killed');
  assert.equal(afterDispose.sessionKnown, false, 'a dead server cannot know about any session');
}

// ---------------------------------------------------------------------------
// Finding S4 (identity shape): two runs sharing one server must have the
// SAME serverPid but DIFFERENT sessionIDs — proving process identity alone
// cannot distinguish them, which is exactly why the two-level check exists.
// ---------------------------------------------------------------------------
async function test_two_runs_share_server_pid_but_not_sessionID() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
  const runIdA = await adapter.start({ prompt: 'A', cwd });
  const runIdB = await adapter.start({ prompt: 'B', cwd });
  await Promise.all([drainUntilTurnEnd(runIdA), drainUntilTurnEnd(runIdB)]);

  const infoA = adapter.getRunProcessInfo(runIdA);
  const infoB = adapter.getRunProcessInfo(runIdB);
  assert.equal(infoA.pid, infoB.pid, 'both runs share the same opencode serve process (that is the bug S4 works around)');
  assert.notEqual(infoA.sessionID, infoB.sessionID, 'sessions must still be distinguishable at the sessionID level');

  await adapter.stop(runIdA);
  await adapter.stop(runIdB);
}

// ---------------------------------------------------------------------------
// Group 4 blocking finding (review-two/group4-adapters-luna.md): getServer()
// used to kick off the /event SSE subscription fire-and-forget, so `ready`
// resolved — and start() went on to POST prompt_async — while the subscription
// was still being established. A turn that finished inside that window emitted
// its terminating event to nobody, and observe() hung forever.
//
// This test makes the window large and deterministic (FAKE_OC_EVENT_DELAY_MS
// holds the /event response back well past the time a fast turn takes) and
// asserts the terminating event still arrives. Against the pre-fix adapter this
// hangs until the timeout and fails; against the fixed one, start() simply
// doesn't return until the stream is genuinely live.
// ---------------------------------------------------------------------------
async function test_sse_subscription_is_live_before_turn_starts() {
  const EVENT_DELAY_MS = 700;
  process.env.FAKE_OC_EVENT_DELAY_MS = String(EVENT_DELAY_MS);
  process.env.FAKE_OC_FAST_TURN = '1'; // idle emitted before prompt_async even responds
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-test-cwd-'));
    const startedAt = Date.now();
    const runId = await adapter.start({ prompt: 'fast', cwd });
    const startElapsed = Date.now() - startedAt;

    // The proof that the fix is load-bearing rather than incidental: start()
    // must have actually WAITED for the subscription, not raced it.
    assert.ok(
      startElapsed >= EVENT_DELAY_MS,
      `start() must not return before the /event subscription is live; returned in ${startElapsed}ms ` +
        `against a ${EVENT_DELAY_MS}ms subscription delay (pre-fix behavior)`,
    );

    const events = await drainUntilTurnEnd(runId, { timeoutMs: 3000 });
    const turnEnd = events.find((e) => e.type === 'turn.end');
    assert.ok(
      turnEnd,
      'turn.end must survive a slow /event subscription — a turn that finishes before the ' +
        'subscription is live would otherwise hang observe() forever',
    );
    assert.equal(turnEnd.status, 'completed');
    await adapter.stop(runId);
  } finally {
    delete process.env.FAKE_OC_EVENT_DELAY_MS;
    delete process.env.FAKE_OC_FAST_TURN;
  }
}

// ---------------------------------------------------------------------------
// The environment decision, OpenCode side (Phase 2 item 2; the decision and its
// measurements are in ../../FINDINGS.md).
//
// OpenCode CANNOT honour a per-run environment declaration: `opencode serve` has no config
// flag, and one server is POOLED across every run in a cwd, so an environment belongs to the
// server. The adapter must therefore REFUSE such a declaration rather than ignore it — an
// ignored declaration means the caller believes a worker is pinned when it is not, which is
// strictly worse than not offering the feature.
// ---------------------------------------------------------------------------
async function test_env_declaration_is_refused_not_ignored() {
  const cwd = process.cwd();
  for (const decl of [
    { envProfile: 'project' },
    { envProfile: 'none' },
    { settingSources: ['project'] },
    { mcpConfig: '/x.json' },
  ]) {
    await assert.rejects(
      () => adapter.start({ prompt: 'hi', cwd, ...decl }),
      /cannot honour a per-run environment declaration/,
      `opencode must refuse ${JSON.stringify(decl)} rather than silently ignoring it`,
    );
  }
  // A spec with NO declaration must still work — the refusal must not become a blanket block.
  const runId = await adapter.start({ prompt: 'hi', cwd });
  assert.ok(runId, 'a spec with no environment declaration must still start');
}

// The record is the OUTCOME, read back from the server's own /config — the OpenCode counterpart
// of Claude Code's `session.init`. Measured reason it matters: in an EMPTY directory a pooled
// server loads the developer's global config (8 MCP servers, 13 agents, 2 plugins) and no flag
// or OPENCODE_* variable suppresses it.
async function test_server_env_is_recorded_from_the_server_itself() {
  const cwd = process.cwd();
  const runId = await adapter.start({ prompt: 'hi', cwd });
  const log = adapter._getRunForTest(runId)._eventLog;
  const env = log.find((e) => e.type === 'worker.env');
  assert.ok(env, `the environment must be recorded, got ${JSON.stringify(log.map((e) => e.type))}`);
  assert.equal(env.scope, 'server',
    'and must say the environment is SERVER-scoped, because a pooled server is shared by many runs');
  assert.deepEqual(env.mcpServers, ['leaky-one', 'leaky-two'],
    'MCP servers are named — there should normally be none, so the list is the interesting part');
  assert.equal(env.agentCount, 3, 'counts rather than names for agents, for context economy');
  assert.equal(env.pluginCount, 1);
  assert.equal(env.reportedModel, 'fake-provider/fake-model',
    "the model the SERVER reports, so its agreeing with the adapter's default is checkable rather than assumed");
  assert.equal(env.envUnavailable, undefined, 'a successful read must not claim unavailability');
}

// A failed read is recorded AS a failure. Rendering it as an empty environment would be the most
// misleading option available: "we could not ask" and "it loaded nothing" are opposite facts, and
// the second is exactly what a correctly pinned server looks like.
async function test_unavailable_server_env_is_not_an_empty_environment() {
  process.env.FAKE_OPENCODE_CONFIG_FAILS = '1';
  try {
    // A FRESH cwd, because the pool is keyed by cwd and the flag is read by the SERVER process.
    // Reusing the shared cwd reused an already-spawned server that had been started before the
    // flag was set, so the failure never happened and the case failed for the wrong reason —
    // the same "policy set after the loop was already running" race the real-harness slice
    // documents. A new cwd forces a new server, which inherits the flag at spawn.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-env-fail-'));
    const runId = await adapter.start({ prompt: 'hi', cwd });
    const env = adapter._getRunForTest(runId)._eventLog.find((e) => e.type === 'worker.env');
    assert.ok(env, 'the record must still be emitted');
    assert.match(String(env.envUnavailable), /500/, 'the failure must be recorded with its reason');
    assert.equal(env.mcpServers, undefined,
      'and must NOT report an empty server list, which is what a pinned server looks like');
  } finally {
    delete process.env.FAKE_OPENCODE_CONFIG_FAILS;
  }
}

// ---------------------------------------------------------------------------
// A PRODUCT REQUIREMENT, guarded so it cannot be broken silently: the amazon-bedrock model
// roster (luna, sol, terra, opus, and the rest) must ALWAYS be reachable through this adapter.
// Those agents are defined in the developer's GLOBAL opencode config, so any future attempt to
// pin a worker's environment by relocating XDG_CONFIG_HOME would remove them.
//
// Measured (../probe/evidence/12-opencode-env-matrix.txt): an EMPTY config dir takes /agent from
// 20 agents to 7 built-ins and mcp from 8 to 0. A CURATED dir (the global config's `agent`,
// `provider` and `model` keys, with `mcp` omitted) keeps all 13 custom agents AND reports mcp=0 —
// so if a pin is ever added it takes the curated shape, never the empty one.
//
// This asserts the CURRENT guarantee rather than the future mechanism: the adapter must not
// override the server's config resolution at all. That is machine-independent — it checks
// passthrough, not the developer's actual roster, so it does not fail on a machine that has no
// custom agents configured.
// ---------------------------------------------------------------------------
async function test_adapter_does_not_override_server_config_resolution() {
  const sentinel = '/ctd-sentinel-config-home';
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = sentinel;
  try {
    // A fresh cwd, because the pool is keyed by cwd and the env is read by the SERVER process:
    // reusing a pooled server would reuse one spawned before the sentinel was set.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cfg-passthru-'));
    const runId = await adapter.start({ prompt: 'hi', cwd });
    const baseUrl = runId.split('::')[0];
    const env = await (await fetch(`${baseUrl}/debug/spawn-env`)).json();

    assert.equal(env.XDG_CONFIG_HOME, sentinel,
      'the adapter must pass the ambient XDG_CONFIG_HOME through untouched — relocating it would '
      + 'remove the amazon-bedrock agent roster (luna/sol/terra/opus) this project requires');
    for (const k of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT']) {
      assert.equal(env[k], null,
        `the adapter must not set ${k}; measured, none of them suppress the global config anyway, `
        + 'so setting one would be a pin that does not pin while looking like it does');
    }
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
}

const tests = [
  ['preflight()', test_preflight],
  ['missing binary spawn error is handled, not crashed on', test_missing_binary_spawn_error_is_handled],
  ['model persists across sendInput turns', test_model_persists_across_turns],
  ['observe() replays a turn that finished before observe() was called', test_observe_replays_fast_turn],
  ['SSE subscription is live before any turn starts', test_sse_subscription_is_live_before_turn_starts],
  ['turn.end status shape (completed)', test_turnEnd_status_shape],
  ['turn.end status shape (rejected prompt synthesizes error)', test_turnEnd_prompt_rejected_synthesizes_error],
  ['session-less, non-allowlisted event is dropped, not broadcast', test_sessionless_nonallowlisted_event_is_dropped],
  ['server disposed mid-turn synthesizes a real turn.end, does not hang observe()', test_server_disposed_mid_turn_synthesizes_turn_end],
  ['abort does not emit a redundant second turn.end', test_abort_does_not_emit_a_redundant_second_turn_end],
  ['a discarded session does not falsely report sessionKnown:true on HTTP failure', test_discarded_session_does_not_falsely_report_known_on_http_failure],
  ['iterator.return() settles a parked next() within bounded time', test_iterator_return_settles_a_parked_next_within_bounded_time],
  ['verifyRunIdentity() reports two independent levels', test_verifyRunIdentity_two_levels],
  ['two runs share serverPid but not sessionID', test_two_runs_share_server_pid_but_not_sessionID],
  ['env: a per-run environment declaration is refused, not ignored', test_env_declaration_is_refused_not_ignored],
  ['env: the server-scoped environment is recorded from the server itself', test_server_env_is_recorded_from_the_server_itself],
  ['env: an unavailable read is not recorded as an empty environment', test_unavailable_server_env_is_not_an_empty_environment],
  ['env: the bedrock agent roster is protected (config resolution passed through)', test_adapter_does_not_override_server_config_resolution],
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

await adapter.disposeAll();

if (failed > 0) {
  console.error(`\n${failed}/${tests.length} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${tests.length} test(s) passed.`);
  process.exit(0);
}
