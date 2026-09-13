#!/usr/bin/env node
// Fake `claude` binary used only by the adapter tests in this directory.
// Speaks just enough of the real stream-json protocol (as documented in
// spike-0b FINDINGS.md and mirrored by adapter.js's _handleLine) to drive
// the specific behaviors under test, without needing the real CLI
// installed. Controlled entirely by env vars so each test can pick a
// scenario without new argv plumbing:
//
//   FAKE_CLAUDE_MODE=completed|error|aborted   (default: completed)
//   FAKE_CLAUDE_IGNORE_SIGINT=1                (stay alive on SIGINT, so
//                                                stop()'s SIGKILL fallback
//                                                timer is the thing that
//                                                actually ends the process)
//   FAKE_CLAUDE_EXIT_ON_SIGINT_MS=<n>          (exit `n`ms after SIGINT,
//                                                simulating a quick death —
//                                                used for the resume/stop
//                                                race test)

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.260-fake\n');
  process.exit(0);
}

let buf = '';
let sessionId = `fake-sess-${process.pid}`;
let ignoreSigint = process.env.FAKE_CLAUDE_IGNORE_SIGINT === '1';
let exitOnSigintMs = process.env.FAKE_CLAUDE_EXIT_ON_SIGINT_MS ? Number(process.env.FAKE_CLAUDE_EXIT_ON_SIGINT_MS) : null;

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

process.on('SIGINT', () => {
  if (exitOnSigintMs !== null) {
    setTimeout(() => process.exit(0), exitOnSigintMs);
    return;
  }
  if (ignoreSigint) return; // stay alive — forces the caller's SIGKILL fallback
  process.exit(0);
});

process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === 'user') handleTurn();
    if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
      writeLine({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'success' } });
    }
    if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
      // The real CLI answers with commands/models/pending requests; the adapter only needs it
      // not to be an error.
      writeLine({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'success', response: { commands: [] } } });
      // Phase 2: park a permission request on the host, the way the real CLI does when it
      // meets a tool it may not run. Gated so the existing tests' timing is untouched.
      if (process.env.FAKE_CLAUDE_PARK_APPROVAL) parkApproval();
    }
    // The host answering a parked request. Echoed as a tool.result-ish line so a test can see
    // WHAT was delivered, not merely that stdin was written to.
    if (msg.type === 'control_response' && msg.response?.request_id === parkedRequestId) {
      parkedRequestId = null;
      writeLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-parked', is_error: msg.response.response?.behavior === 'deny', content: JSON.stringify(msg.response.response) }] } });
    }
  }
});

let initSent = false;
let parkedRequestId = null;

/**
 * Park a `can_use_tool` request on the host, in the exact shape measured from `claude`
 * 2.1.263 (see ../probe/ and ../../FINDINGS.md). `FAKE_CLAUDE_PARK_APPROVAL=question` parks
 * an AskUserQuestion-style request instead, which the real CLI marks with
 * `requires_user_interaction`.
 */
function parkApproval() {
  const isQuestion = process.env.FAKE_CLAUDE_PARK_APPROVAL === 'question';
  parkedRequestId = 'req-parked-1';
  writeLine({
    type: 'control_request',
    request_id: parkedRequestId,
    request: isQuestion
      ? {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          display_name: 'AskUserQuestion',
          requires_user_interaction: true,
          input: { questions: [{ question: 'Tabs or spaces?', header: 'Indent', options: [{ label: 'Spaces' }, { label: 'Tabs' }] }] },
          tool_use_id: 'toolu-parked',
        }
      : {
          subtype: 'can_use_tool',
          tool_name: 'WebFetch',
          display_name: 'WebFetch',
          description: 'https://example.com',
          input: { url: 'https://example.com' },
          tool_use_id: 'toolu-parked',
          permission_suggestions: [{ type: 'addRules', destination: 'localSettings', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow' }],
        },
  });
}

function handleTurn() {
  if (!initSent) {
    // Hooks fire BEFORE init on the real CLI (measured: two hook_started/hook_response pairs
    // precede it), so the fake emits them in that order too. Gated on an env var because most
    // cases want a clean transcript; the point is that the adapter's hook MAPPING can be
    // regression-tested without a real CLI and without tokens. The real-harness positive
    // control lives in ../probe/hook-axis-control.mjs.
    if (process.env.FAKE_CLAUDE_HOOKS) {
      writeLine({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' });
      writeLine({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup' });
    }
    writeLine({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      // Shaped like the real init so the adapter's environment record is exercised rather than
      // defaulted: `mcp_servers` non-empty ONLY when the fake is told to inherit.
      mcp_servers: process.env.FAKE_CLAUDE_HOOKS ? [{ name: 'leaky-server', status: 'connected' }] : [],
      tools: ['Read', 'Write', 'Bash'],
      slash_commands: ['/help'],
      agents: ['general-purpose'],
      model: 'fake-model',
    });
    initSent = true;
  }
  const mode = process.env.FAKE_CLAUDE_MODE || 'completed';
  writeLine({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
  });
  setTimeout(() => {
    if (mode === 'stall') {
      // Never emits a result and never exits — the turn sits genuinely, permanently mid-flight.
      // Distinct from 'crash': the PROCESS stays alive, so `observe()`'s idle-poll loop keeps
      // running rather than being ended by a process.exit event.
      return;
    }
    if (mode === 'crash') {
      // Older should-fix backlog: "a Claude Code process exiting with no `result` object
      // produces no turn.end at all." Exits with a nonzero code having printed the delta above
      // but NEVER a `type: 'result'` line — the exact on-wire shape a real crash mid-turn leaves.
      process.exit(1);
      return;
    }
    if (mode === 'crash-clean-exit') {
      // review-sol-2026-09-13.md finding 19: same "no result line" shape as 'crash', but exit code
      // 0 — a process that exits cleanly WITHOUT ever printing a result is still a protocol failure,
      // never a completed turn, regardless of its exit code.
      process.exit(0);
      return;
    }
    if (mode === 'error') {
      writeLine({ type: 'result', is_error: true, terminal_reason: 'error', subtype: 'error_during_execution', result: 'boom', usage: {} });
    } else if (mode === 'aborted') {
      writeLine({ type: 'result', is_error: false, terminal_reason: 'aborted_streaming', subtype: 'aborted', result: null, usage: {} });
    } else {
      writeLine({ type: 'result', is_error: false, terminal_reason: 'other', subtype: 'success', result: 'done', session_id: sessionId, usage: { input_tokens: 5, output_tokens: 3 } });
    }
  }, 30);
}

// Keep the event loop alive even with no stdin activity yet.
setInterval(() => {}, 1000);
