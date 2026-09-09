#!/usr/bin/env node
// permission-host-probe.mjs — the reproducible measurement behind adapters/FINDINGS.md
// section "Claude Code CAN park a permission decision" (2026-09-07, Phase 2).
//
// WHY THIS EXISTS
//
// PLAN.md sections 4 and 7 said, on the strength of the Phase 0b spike against
// `claude` 2.1.260, that Claude Code has NO live permission callback in `--print`
// mode: "the only mechanism is a PreToolUse hook subprocess that must itself resolve
// the decision *before* returning, so the supervisor's Claude Code adapter has to make
// that hook synchronously poll/long-poll the control socket."
//
// That is FALSE as of `claude` 2.1.263. The CLI will send the host a
// `can_use_tool` control_request on its stdout stream, PARK the turn for as long as
// the host takes, and act on the answer the host writes back on stdin. Which is the
// same async shape as OpenCode's `permission.asked` — an `ask` row can sit pending.
//
// Run it:  node permission-host-probe.mjs [--park-ms 4000] [--decision allow|deny]
// It costs one real (small) Claude Code turn. Captured runs: ./evidence/.
//
// THE FOUR FLAGS THAT MATTER, and the one that is load-bearing:
//
//   --input-format stream-json --output-format stream-json   the control channel itself
//   --permission-prompt-tool stdio    <-- LOAD-BEARING. Without it the CLI never asks
//                                         the host: it auto-DENIES and tells the model
//                                         "you haven't granted it yet". Measured.
//   --permission-prompts host         the default already; not sufficient alone
//   --await-initialize                NOT required (measured). It only makes the CLI
//                                     block on the host's `initialize` during startup.
//
// The auto-deny without `--permission-prompt-tool stdio` is the trap: it looks exactly
// like "this harness cannot do async approval", which is how the spike concluded what
// it concluded. Nothing errors, nothing warns, the session just proceeds having quietly
// refused the tool.
//
// TWO MEASUREMENTS THAT SHAPE THE DESIGN
//
//  1. A 65-second park was held and then honoured — no deadline fired. The CLI's own
//     embedded docs say the 5-minute park deadline applies to a dialog "forwarded to a
//     remote client" and that "local-only permission prompts (no remote client) are
//     unaffected", which matches. So `asks.auto_close_at` is the supervisor's policy
//     choice, not a race against a harness timeout.
//  2. The host's `deny` message reaches the model verbatim as the tool_result error
//     text, so a human's reason for refusing is visible to the worker.
//
// AND ONE SIDE EFFECT WORTH KNOWING: with `--permission-prompt-tool stdio` the session's
// tool list GAINS `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` (diffed against
// a run without it). Those are further host round-trips, not permission decisions — a
// worker can now ask a *question*, which is `asks` by another road. Don't wire them
// blind; see FINDINGS.md.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const parkMs = Number(argOf('park-ms', 4000));
const decision = argOf('decision', 'allow');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// A real directory, NOT one under /tmp. On macOS /tmp is a symlink to /private/tmp and
// the tool sandbox compares resolved paths, so a write inside a /tmp cwd is refused with
// a *workingDir* message rather than being asked about — which sends this probe down the
// wrong path entirely. Cost an hour once; don't move this back to /tmp.
const cwd = mkdtempSync(join(process.env.HOME || tmpdir(), 'ctd-permission-probe-'));

// `--negative` drops the load-bearing flag, so the probe captures the auto-deny too.
// The negative run is the more useful evidence of the two: it is what the Phase 0b spike
// saw, and it is indistinguishable from "this harness has no async approval" unless you
// already know the flag exists.
const negative = process.argv.includes('--negative');

const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'default',
  ...(negative ? [] : ['--permission-prompt-tool', 'stdio']),
];

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

log('cwd', cwd);
log('spawn', CLAUDE_BIN, args.join(' '));

const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
const send = (obj) => {
  log('HOST->CLI', JSON.stringify(obj).slice(0, 400));
  child.stdin.write(JSON.stringify(obj) + '\n');
};

let asked = false;
let answered = false;
let buf = '';

child.stdout.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { log('UNPARSED', line.slice(0, 200)); continue; }

    // Token-level frames are noise for this probe.
    if (obj.type === 'stream_event') continue;

    if (obj.type === 'control_request' && obj.request?.subtype === 'can_use_tool') {
      asked = true;
      log('CLI->HOST can_use_tool', JSON.stringify(obj.request));
      log(`parking the decision for ${parkMs}ms — this is the whole point of the probe`);
      setTimeout(() => {
        answered = true;
        send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: obj.request_id,
            response: decision === 'deny'
              ? { behavior: 'deny', message: 'The dashboard operator declined this (probe).' }
              : { behavior: 'allow' },
          },
        });
      }, parkMs);
      continue;
    }

    if (obj.type === 'control_response') {
      log('CLI->HOST control_response for', obj.response?.request_id, obj.response?.subtype);
      continue;
    }

    if (obj.type === 'system' && obj.subtype === 'init') {
      // The tool-list diff noted at the top of this file is read from here.
      log('EVT system/init tools:', JSON.stringify(obj.tools));
      continue;
    }

    if (obj.type === 'system' && obj.subtype === 'permission_denied') {
      // Reaching here having never been asked IS the negative result: it is what a run
      // without `--permission-prompt-tool stdio` does.
      log('EVT system/permission_denied', JSON.stringify(obj));
      continue;
    }

    if (obj.type === 'user') { log('EVT tool_result', JSON.stringify(obj.message?.content).slice(0, 400)); continue; }
    if (obj.type === 'result') {
      log('EVT result', obj.subtype, `cost=$${obj.total_cost_usd}`);
      // The turn is over, so the probe has its answer. The CLI stays resident waiting for
      // more stdin (that residency is the adapter's whole design), so nothing will exit on
      // its own — end it here rather than sitting out the hard stop.
      setTimeout(() => { child.kill('SIGKILL'); verdict(); }, 500);
      continue;
    }
    log('EVT', [obj.type, obj.subtype].filter(Boolean).join('/'));
  }
});

child.stderr.on('data', (d) => log('STDERR', d.toString().trim().slice(0, 300)));

child.on('exit', (code, signal) => {
  log('EXIT', code, signal);
  verdict();
});

send({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } });

// WebFetch on a fresh domain is the cleanest "ask" class available: no sandbox involved,
// no working-directory rule to trip over, and it is refused by default so it must ask.
setTimeout(() => send({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'Use the WebFetch tool on https://example.com and tell me the page title.' }] },
}), 1500);

const hardStopMs = parkMs + 90_000;
const hardStop = setTimeout(() => {
  log('hard stop reached');
  child.kill('SIGKILL');
  verdict();
}, hardStopMs);

function verdict() {
  clearTimeout(hardStop);
  console.log('');
  console.log(`PROBE VERDICT: negative=${negative} asked=${asked} answered=${answered} parkMs=${parkMs} decision=${decision}`);
  if (negative) {
    console.log(asked
      ? 'UNEXPECTED — the negative run was asked anyway; the flag is no longer load-bearing. Re-read FINDINGS.'
      : 'EXPECTED — no flag, no question: the CLI auto-denied without consulting the host.');
    process.exit(asked ? 1 : 0);
  }
  console.log(asked
    ? 'PASS — the CLI asked the host and waited. Async approval is available on Claude Code.'
    : 'FAIL — never asked. Check --permission-prompt-tool stdio is present and the CLI is >= 2.1.263.');
  process.exit(asked ? 0 : 1);
}
