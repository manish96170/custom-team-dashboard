// adapter.js
//
// Claude Code spawn adapter — Phase 0b spike.
//
// Implements the interface:
//   start(spec) -> runId
//   sendInput(runId, input) -> void
//   observe(runId) -> AsyncIterable<Event>
//   interrupt(runId) -> void
//   clearContext(runId) -> ack
//   resume(runId) -> runId | 'unsupported'
//   stop(runId) -> void
//
// Backed by real `claude` CLI invocations. See FINDINGS.md in this directory
// for the evidence behind every design decision here — this file only
// implements what was actually proven to work against `claude` 2.1.260.
//
// KEY DESIGN DECISION (see FINDINGS.md #3/#4/#5):
// We run the CLI in RESIDENT mode:
//   claude -p --input-format stream-json --output-format stream-json
//          --include-partial-messages --verbose ...
// This keeps one OS process alive for the life of the run. Multi-turn
// input is sent as additional `{"type":"user",...}` JSON lines on stdin
// (no --resume, no new process needed). Interrupt is sent as a
// `{"type":"control_request","request":{"subtype":"interrupt"}}` line on
// stdin, NOT as SIGINT — SIGINT was proven to kill the whole resident
// process (see FINDINGS.md #4), whereas the control_request interrupts
// only the in-flight turn and leaves the process (and stdin) usable for
// the next turn.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/** @typedef {{prompt: string, cwd: string, model?: string, effort?: string, permissionMode?: string}} StartSpec */

class Run extends EventEmitter {
  constructor(runId, spec) {
    super();
    this.runId = runId;
    this.spec = spec;
    this.claudeSessionId = null; // the CLI's own session_id (changes on /clear)
    this.status = 'starting'; // starting | running | idle | interrupted | errored | stopped | completed
    this.exitCode = null;
    this.exitSignal = null;
    this.terminalReason = null;
    this._buf = '';
    this._pendingControlRequests = new Map(); // request_id -> {resolve, reject}
    this._eventLog = []; // buffered events for observe() replay to late subscribers
  }

  _emitEvent(evt) {
    this._eventLog.push(evt);
    this.emit('event', evt);
  }
}

const runs = new Map();

/**
 * start(spec) -> runId
 *
 * Launches a resident, non-interactive `claude` process in stream-json/
 * stream-json mode. Proven: FINDINGS.md #1, #2, #6, #7.
 */
export function start(spec) {
  const { prompt, cwd, model, effort, permissionMode, permissionPromptTool } = spec;
  if (!cwd) throw new Error('start(spec): spec.cwd is required (proven: cwd isolation via child_process cwd option, not a CLI flag — FINDINGS.md #6)');

  const runId = randomUUID();
  const run = new Run(runId, spec);
  runs.set(runId, run);

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  // permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
  // NOTE: --permission-mode is a blanket policy set at process start, not a
  // per-call decision (FINDINGS.md #9). For real per-call approval routing
  // you must ALSO configure a PreToolUse hook (see approvalHookExample.js).
  args.push('--permission-mode', permissionMode || 'default');

  // child_process cwd option is what actually achieves working-directory
  // isolation; there is no --cwd flag on the CLI (FINDINGS.md #6).
  const child = spawn(CLAUDE_BIN, args, { cwd });
  run.child = child;
  run.status = 'running';

  child.stdout.on('data', (d) => _onStdout(run, d));
  child.stderr.on('data', (d) => {
    run._emitEvent({ type: 'stderr', runId, data: d.toString() });
  });
  child.on('exit', (code, signal) => {
    run.exitCode = code;
    run.exitSignal = signal;
    run.status = run.status === 'interrupted' ? 'interrupted' : (code === 0 ? 'completed' : 'errored');
    run._emitEvent({ type: 'process.exit', runId, code, signal });
  });
  child.on('error', (err) => {
    run.status = 'errored';
    run._emitEvent({ type: 'process.error', runId, error: String(err) });
  });

  _sendUserMessage(run, prompt);
  return runId;
}

/**
 * sendInput(runId, input) -> void
 *
 * Sends a follow-up user turn into the SAME resident process/session.
 * Proven: FINDINGS.md #3 — no --resume needed, no new process needed,
 * because the process is kept alive with --input-format stream-json.
 */
export function sendInput(runId, input) {
  const run = _get(runId);
  _sendUserMessage(run, input);
}

function _sendUserMessage(run, text) {
  const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
  run.child.stdin.write(JSON.stringify(msg) + '\n');
  run.status = 'running';
}

/**
 * observe(runId) -> AsyncIterable<Event>
 *
 * Event shapes emitted: assistant.delta, tool.start, tool.result,
 * approval.request (best-effort, see note below), turn.end.
 * Mapping proven against real stream-json output — FINDINGS.md #2.
 *
 * NOTE on approval.request: no control_request for permission decisions
 * was ever observed from the CLI in --print mode (FINDINGS.md #9) — the
 * CLI decides allow/deny itself using --permission-mode + hooks, and only
 * reports the outcome (`permission_denied` system event / `permission_
 * denials` in the result). So `approval.request` here is emitted
 * best-effort, AFTER THE FACT, as an observability signal — it is NOT a
 * live callback you can answer to change the outcome. If you need to
 * actually control the decision, you must configure a PreToolUse hook in
 * `.claude/settings.json` in the target cwd BEFORE calling start() — see
 * approvalHookExample.js. That hook is the only proven programmatic
 * approval mechanism.
 */
export async function* observe(runId) {
  const run = _get(runId);
  // NOTE: this adapter targets a single logical consumer per run (the
  // pattern the interface's own spec/usage implies: one orchestrator
  // driving one run). We keep ONE shared read cursor on the Run object
  // rather than a fresh per-call cursor, so that repeated calls to
  // observe() (e.g. "drain until this turn ends", called once per turn)
  // continue where the previous call left off instead of re-replaying the
  // whole history. A multi-consumer fan-out design is future work.
  if (run._readCursor === undefined) run._readCursor = 0;
  let wake = () => {};
  const onEvent = () => wake();
  run.on('event', onEvent);

  try {
    while (true) {
      while (run._readCursor < run._eventLog.length) {
        yield run._eventLog[run._readCursor++];
      }
      if (run.status === 'completed' || run.status === 'errored' || run.status === 'stopped') {
        if (run._readCursor >= run._eventLog.length) return;
      }
      await new Promise((res) => {
        wake = res;
        setTimeout(res, 200); // safety-net poll in case an event slips past the listener
      });
    }
  } finally {
    run.off('event', onEvent);
  }
}

function _onStdout(run, chunk) {
  run._buf += chunk.toString();
  const lines = run._buf.split('\n');
  run._buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    _handleLine(run, obj);
  }
}

function _handleLine(run, obj) {
  const runId = run.runId;

  if (obj.type === 'control_response') {
    const pending = run._pendingControlRequests.get(obj.response?.request_id);
    if (pending) {
      run._pendingControlRequests.delete(obj.response.request_id);
      if (obj.response.subtype === 'success') pending.resolve(obj.response.response);
      else pending.reject(new Error(obj.response.error || 'control_request failed'));
    }
    return;
  }

  if (obj.type === 'system' && obj.subtype === 'init') {
    run.claudeSessionId = obj.session_id;
    run._emitEvent({ type: 'session.init', runId, claudeSessionId: obj.session_id });
    return;
  }

  if (obj.type === 'system' && obj.subtype === 'permission_denied') {
    // After-the-fact notification, not a live callback (see observe() docstring).
    run._emitEvent({
      type: 'approval.request',
      runId,
      toolName: obj.tool_name,
      decision: 'denied',
      reason: obj.message,
    });
    return;
  }

  if (obj.type === 'stream_event') {
    const ev = obj.event;
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      run._emitEvent({ type: 'tool.start', runId, toolName: ev.content_block.name, toolUseId: ev.content_block.id });
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      run._emitEvent({ type: 'assistant.delta', runId, text: ev.delta.text });
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
      run._emitEvent({ type: 'assistant.delta', runId, text: ev.delta.thinking, channel: 'thinking' });
    }
    return;
  }

  if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (block.type === 'tool_result') {
        run._emitEvent({
          type: 'tool.result',
          runId,
          toolUseId: block.tool_use_id,
          isError: !!block.is_error,
          content: block.content,
        });
      } else if (block.type === 'text' && block.text === '[Request interrupted by user]') {
        run.status = 'interrupted';
      }
    }
    return;
  }

  if (obj.type === 'result') {
    run.terminalReason = obj.terminal_reason;
    // Exit classification (proven: FINDINGS.md #8) — exit code alone is
    // NOT sufficient (interrupt also exits 0). Must inspect this record.
    if (obj.terminal_reason === 'aborted_streaming') {
      run.status = 'interrupted';
    } else if (obj.is_error) {
      run.status = 'errored';
    } else {
      run.status = 'idle'; // turn completed; resident process still alive for more input
    }
    run._emitEvent({
      type: 'turn.end',
      runId,
      result: obj.result,
      isError: !!obj.is_error,
      terminalReason: obj.terminal_reason,
      subtype: obj.subtype,
      apiErrorStatus: obj.api_error_status ?? null,
      costUsd: obj.total_cost_usd,
      claudeSessionId: obj.session_id,
      // ADDED for supervisor-integration spike (item 4, token telemetry —
      // PLAN.md section 8, Rule 8). The final `result` record already
      // carries a real `usage` object (proven: evidence/05-clean-default-
      // permission.txt) — this was previously read and discarded. tokensIn
      // includes only the non-cached input tokens per Anthropic's usage
      // shape; cachedTokens is cache_read (tokens served from cache, i.e.
      // NOT re-billed as fresh input) plus cache_creation is reported
      // separately since it IS billed, just at a different rate.
      tokensIn: obj.usage?.input_tokens ?? null,
      tokensOut: obj.usage?.output_tokens ?? null,
      cachedTokens: obj.usage?.cache_read_input_tokens ?? null,
      cacheCreationTokens: obj.usage?.cache_creation_input_tokens ?? null,
    });
    return;
  }
}

/**
 * interrupt(runId) -> void
 *
 * Sends a control_request interrupt over stdin. Proven (FINDINGS.md #4)
 * to cancel only the in-flight turn while leaving the resident process
 * and stdin usable for the next sendInput() call. This is a BEST-EFFORT,
 * fire-and-forget call here (matching the required sync void signature);
 * internally it's async (writes to stdin, control_response arrives later
 * as a control_response line, which we swallow if no one awaited it).
 *
 * IMPORTANT CAVEAT: SIGINT (process.kill('SIGINT')) was tried first and
 * proven to kill the entire resident process instead of just the turn —
 * do NOT use SIGINT for interrupt on a resident process. (SIGINT is fine,
 * and is the ONLY option, for the non-resident/one-shot invocation style,
 * where killing the process is the intended effect of interrupt().)
 */
export function interrupt(runId) {
  const run = _get(runId);
  const requestId = randomUUID();
  const req = { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
  run.child.stdin.write(JSON.stringify(req) + '\n');
}

/**
 * clearContext(runId) -> ack
 *
 * PROVEN (FINDINGS.md #5): there is no in-place "clear this session's
 * history but keep the same session id" operation. Sending a `/clear`
 * user turn on the SAME resident stdin pipe keeps the OS process alive
 * (same runId from this adapter's point of view) but the CLI mints a
 * brand-new internal session_id and the model provably has no memory of
 * prior turns. So: process-level identity (runId) survives; session-level
 * identity (claudeSessionId, and hence anything tied to --resume) does
 * NOT. Document this precisely to callers — "clear" == "new session,
 * same OS process."
 */
export function clearContext(runId) {
  const run = _get(runId);
  const previousSessionId = run.claudeSessionId;
  _sendUserMessage(run, '/clear');
  return {
    ack: true,
    runId,
    previousClaudeSessionId: previousSessionId,
    note: 'A new internal Claude session_id will be issued on the next init event; runId/process identity is preserved but conversation history is not.',
  };
}

/**
 * resume(runId) -> runId | 'unsupported'
 *
 * Two distinct resume mechanisms were proven:
 *  1. Cross-process resume: `claude --resume <session_id>` from a brand
 *     new invocation reconstitutes history (FINDINGS.md #3). Useful if
 *     the resident process from start() has already exited/been stopped.
 *  2. Same-process "resume": simply keep sending sendInput() on a still-
 *     running resident process — no resume verb needed at all, because
 *     the process never went away.
 *
 * This function implements (1): if the run's process has exited, spawn a
 * fresh resident process with --resume <lastKnownSessionId> and return
 * the SAME runId (rebinding it to a new child process). If the run is
 * still alive, resume is a no-op — just keep using sendInput/runId as-is.
 */
export function resume(runId) {
  const run = _get(runId);
  if (run.status !== 'stopped' && run.status !== 'errored' && run.child && !run.child.killed && run.exitCode === null) {
    // Process still alive — nothing to do, same runId already usable.
    return runId;
  }
  if (!run.claudeSessionId) {
    return 'unsupported'; // never got far enough to have a session id to resume
  }

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--resume', run.claudeSessionId,
  ];
  if (run.spec.model) args.push('--model', run.spec.model);
  if (run.spec.effort) args.push('--effort', run.spec.effort);
  args.push('--permission-mode', run.spec.permissionMode || 'default');

  const child = spawn(CLAUDE_BIN, args, { cwd: run.spec.cwd });
  run.child = child;
  run.status = 'running';
  run._buf = '';
  child.stdout.on('data', (d) => _onStdout(run, d));
  child.stderr.on('data', (d) => run._emitEvent({ type: 'stderr', runId, data: d.toString() }));
  child.on('exit', (code, signal) => {
    run.exitCode = code;
    run.exitSignal = signal;
    run.status = run.status === 'interrupted' ? 'interrupted' : (code === 0 ? 'completed' : 'errored');
    run._emitEvent({ type: 'process.exit', runId, code, signal });
  });
  return runId;
}

/**
 * stop(runId) -> void
 *
 * Hard stop. Attempts SIGINT first (to give the CLI a chance to flush its
 * final result/session state to disk so a later resume() can still work),
 * falling back to SIGKILL after 3s if it doesn't die.
 *
 * CORRECTION (2026-09-05, code review, finding M2): this used to claim SIGINT
 * was "proven to terminate the resident process cleanly — exit code 0, no
 * zombie." That's false — concurrency-evidence.log:75 records the actual
 * captured result as `signal: "SIGKILL"`: the 3s fallback fired, meaning an
 * idle resident `claude` process did NOT die from SIGINT alone in the case
 * that was actually tested. Treat SIGINT here as best-effort only; SIGKILL
 * fallback firing is the observed common case, not a rare backstop.
 */
export function stop(runId) {
  const run = _get(runId);
  run.status = 'stopped';
  if (run.child && run.exitCode === null) {
    run.child.kill('SIGINT');
    setTimeout(() => {
      if (run.exitCode === null) run.child.kill('SIGKILL');
    }, 3000);
  }
  if (run.child?.stdin && !run.child.stdin.destroyed) {
    try { run.child.stdin.end(); } catch { /* ignore */ }
  }
}

function _get(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error(`Unknown runId: ${runId}`);
  return run;
}

export function _getRunForTest(runId) {
  return runs.get(runId);
}
