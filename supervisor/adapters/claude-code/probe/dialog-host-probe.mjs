#!/usr/bin/env node
// dialog-host-probe.mjs — companion to permission-host-probe.mjs.
//
// That probe settled tool APPROVAL (`can_use_tool`). This one settles the second road a
// worker can take to block on a human: asking a QUESTION. Both end up as `asks` rows, so
// the supervisor needs the wire shape of each, and the two are not the same channel.
//
// What is known from the CLI's own embedded protocol docs before running anything:
//
//  - There is a `request_user_dialog` control_request with a `dialog_kind` and an opaque
//    `dialog_data`, answered with an opaque per-kind result.
//  - A host must DECLARE the kinds it can render, as `supportedDialogKinds` on the
//    `initialize` request. "The CLI treats ABSENCE as 'cannot display' and fails closed:
//    without the kind declared here, a dialog-gated flow degrades to its no-dialog
//    behavior instead of parking a dialog the consumer may mishandle." First-attached-
//    client-wins; a later `initialize` does NOT change it.
//  - Unlike `can_use_tool`, a parked dialog HAS a deadline: 5 minutes by default,
//    overridable by `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` or the settings value `"never"`.
//
// What was NOT knowable without measuring, and is what this probe is for: whether
// `AskUserQuestion` travels as a `request_user_dialog` at all. The only `dialog_kind`
// value that appears in the binary is `refusal_fallback_prompt`, yet the binary also logs
// "Interrupting parked AskUserQuestion toolUseID=... at stream close", so it parks
// somehow. This probe answers "which channel, and what shape" by declaring the dialog
// kinds we know of, answering `can_use_tool` with allow, and dumping every control_request
// verbatim.
//
// Run it:  node dialog-host-probe.mjs
// Costs one real turn. Captured runs in ./evidence/.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Not under /tmp — see permission-host-probe.mjs for why that matters on macOS.
const cwd = mkdtempSync(join(process.env.HOME || tmpdir(), 'ctd-dialog-probe-'));

const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'default',
  '--permission-prompt-tool', 'stdio', // also what makes AskUserQuestion appear at all
];

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

log('cwd', cwd);
const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
const send = (obj) => { log('HOST->CLI', JSON.stringify(obj).slice(0, 500)); child.stdin.write(JSON.stringify(obj) + '\n'); };

const seen = new Set();
let buf = '';

child.stdout.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'stream_event') continue;

    if (obj.type === 'control_request') {
      const sub = obj.request?.subtype;
      seen.add(sub);
      log('CLI->HOST control_request', sub);
      log('   FULL', JSON.stringify(obj));

      if (sub === 'can_use_tool' && obj.request.requires_user_interaction) {
        // MEASURED: AskUserQuestion arrives here, NOT as a request_user_dialog, and a bare
        // `allow` is not an answer — the tool then reports "The user did not answer the
        // questions." The host must hand the answers back as `updatedInput.answers`, keyed
        // by the exact question text. Park first, because parking is the point.
        const input = obj.request.input;
        const answers = {};
        for (const q of input.questions ?? []) answers[q.question] = q.options?.[0]?.label ?? 'yes';
        log('   *** requires_user_interaction — parking 3s, then answering', JSON.stringify(answers));
        setTimeout(() => send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: obj.request_id,
            response: { behavior: 'allow', updatedInput: { ...input, answers } },
          },
        }), 3000);
      } else if (sub === 'can_use_tool') {
        // Ordinary tool approval: this probe is about what happens after approval.
        send({ type: 'control_response', response: { subtype: 'success', request_id: obj.request_id, response: { behavior: 'allow' } } });
      } else if (sub === 'request_user_dialog') {
        log('   *** a dialog parked. Answering after 3s.');
        // The result payload is opaque per dialog_kind, so this is a guess by design:
        // what matters is what the CLI does with a shape it does not like, which it will
        // report as an error response rather than a crash.
        setTimeout(() => send({
          type: 'control_response',
          response: { subtype: 'success', request_id: obj.request_id, response: { result: { choice: 'spaces' } } },
        }), 3000);
      } else if (sub && sub !== 'keepalive' && sub !== 'ping') {
        log('   *** unhandled control_request subtype — not answering');
      }
      continue;
    }

    if (obj.type === 'control_response') { log('CLI->HOST control_response', obj.response?.subtype, obj.response?.error ?? ''); continue; }
    if (obj.type === 'system' && obj.subtype === 'init') { log('EVT init, AskUserQuestion present:', (obj.tools || []).includes('AskUserQuestion')); continue; }
    if (obj.type === 'assistant') {
      for (const b of obj.message?.content ?? []) {
        if (b.type === 'tool_use') log('EVT tool_use', b.name, JSON.stringify(b.input).slice(0, 500));
      }
      continue;
    }
    if (obj.type === 'user') { log('EVT tool_result', JSON.stringify(obj.message?.content).slice(0, 500)); continue; }
    if (obj.type === 'result') {
      log('EVT result', obj.subtype, `cost=$${obj.total_cost_usd}`);
      setTimeout(finish, 500);
      continue;
    }
    log('EVT', [obj.type, obj.subtype].filter(Boolean).join('/'));
  }
});

child.stderr.on('data', (d) => log('STDERR', d.toString().trim().slice(0, 300)));
child.on('exit', (c, s) => { log('EXIT', c, s); finish(); });

send({
  type: 'control_request',
  request_id: 'init-1',
  request: {
    subtype: 'initialize',
    // Declared so a dialog-gated flow parks instead of silently degrading. The list is
    // deliberately wider than the one kind found in the binary: an unknown kind being
    // rejected is itself a useful measurement.
    supportedDialogKinds: ['refusal_fallback_prompt', 'ask_user_question', 'plan_approval'],
  },
});

setTimeout(() => send({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'Use the AskUserQuestion tool to ask me whether this project should use tabs or spaces. Ask, do not guess.' }],
  },
}), 1500);

const hardStop = setTimeout(() => { log('hard stop'); child.kill('SIGKILL'); finish(); }, 180_000);

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(hardStop);
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  console.log('');
  console.log('control_request subtypes seen from the CLI:', [...seen].join(', ') || '(none)');
  process.exit(0);
}
