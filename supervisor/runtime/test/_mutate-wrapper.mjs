#!/usr/bin/env node
// _mutate-wrapper.mjs — mutation harness for PLAN.md section 9's `wrapper` tier (the degraded driver).
//
// Same standing rule: break one mechanism, and the suite must fail BY ASSERTION at the case that protects
// it. A mutation that merely crashes proves nothing.
//
// WHAT MAKES A DEGRADED DRIVER WORTH MUTATING: every failure here is a case of the system claiming MORE
// than it has. A wrapper-tier run that is not marked looks like a parsed stream. A fabricated turn boundary
// looks like a turn. An `assistant.delta` carrying half a line looks like a worker that stopped
// mid-sentence. The whole tier exists so that a harness nobody wrote an adapter for is usable AND obviously
// second-class, and each mutation below erases the second half while keeping the first.
//
// W1 and W4 are the two to read. W1 marks a terminal-driven adapter as `active`, which is the actual state
// the code was in before this tier was built — the mechanism meant to prevent a degraded harness being
// "silently treated as equivalent" did exactly that to the one adapter that is degraded by definition. W4
// invents turn boundaries from output, which is how a tier with no turn semantics ends up feeding
// fabricated turns to tier-2 digests that then state them as fact.
//
// Usage: node runtime/test/_mutate-wrapper.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  wrapper: path.join(SUPERVISOR, 'adapters/wrapper/adapter.js'),
  suite: path.join(SUPERVISOR, 'conformance/suite.js'),
  layout: path.join(SUPERVISOR, 'tui/layout.js'),
  supervisor: path.join(SUPERVISOR, 'runtime/supervisor.js'),
};

const WRAP = 'runtime/test/wrapper-tier.test.js';

const MUTATIONS = [
  {
    name: 'W1-terminal-driver-marked-active',
    file: F.suite,
    why: "Deriving the tier from 'did the checks pass' alone, which is the state the code was actually in until this tier was built. A degraded driver that tells the truth passes every check, so the mechanism whose entire purpose is to stop a degraded harness being 'silently treated as equivalent to a real, conformance-passing adapter' marked the one adapter that is degraded BY DEFINITION as `active`. Honesty in the declaration cannot be what costs an adapter its accurate label.",
    breaks: 'wrapper case 4 (a truthful degraded adapter is still tier wrapper)',
    test: WRAP,
    find: `  const terminal = declared?.structuredOutput === "terminal";`,
    replace: `  const terminal = false; // MUTANT: a terminal driver can be "active"`,
  },
  {
    name: 'W2-degraded-and-broken-collapsed',
    file: F.suite,
    why: "Reporting a well-behaved terminal driver as having FAILED its conformance checks. 'This adapter does what it says' and 'this adapter is degraded' are different facts, and collapsing them makes a conforming wrapper indistinguishable from a broken adapter in every report, log and status line -- so an operator cannot tell 'this harness is limited' from 'this harness is lying about itself', which are opposite situations.",
    breaks: 'wrapper case 4 (`passed` stays true for a conforming wrapper)',
    test: WRAP,
    find: `    passed: failed.length === 0,`,
    replace: `    passed: !degraded, // MUTANT: degraded and broken are the same thing`,
  },
  {
    name: 'W3-partial-line-emitted-whole',
    file: F.wrapper,
    why: "Emitting the trailing partial line as if it were complete. A chunk boundary lands mid-line constantly, so this is the 'one fragment per line' defect (FINDINGS section 28) at the adapter level -- and worse than in the TUI, because these fragments are PERSISTED into `event_log` as separate events and no later reader can rejoin them.",
    breaks: 'wrapper case 1 (a partial line is held) and case 2 (ordered lines)',
    test: WRAP,
    find: `  const rest = parts.pop() ?? "";`,
    replace: `  const rest = ""; // MUTANT: the partial line is emitted as complete`,
  },
  {
    name: 'W4-turn-boundaries-invented-from-output',
    file: F.wrapper,
    why: "Fabricating a `turn.end` from output rather than from the process exiting. Nothing in raw terminal text marks a turn, so this is a guess -- and it is a guess that PROPAGATES: tier-2 digests are written at `turn.end` (Rule 4), so an invented boundary produces a summary of half a turn which a resumed worker then reads as the state of the work. The declared matrix says `residentProcess: 'one-shot'` precisely so nothing downstream expects turn semantics that do not exist.",
    breaks: 'wrapper case 3 (the process exit is the only turn boundary)',
    test: WRAP,
    find: `    run.emitEvent({ type: "assistant.delta", text: \`\${line}\\n\`, stream, degraded: true });`,
    replace: `    run.emitEvent({ type: "assistant.delta", text: \`\${line}\\n\`, stream, degraded: true });
    if (/done|complete|finished/i.test(line)) run.emitEvent({ type: "turn.end", status: "completed", degraded: true }); // MUTANT: guessed`,
  },
  {
    name: 'W5-last-line-lost-at-exit',
    file: F.wrapper,
    why: "Not flushing the unterminated final line when the process exits. A CLI that dies without a trailing newline loses its LAST line -- which is the one most likely to say why it died. Silent, and it only happens on the failure path, so every successful run looks fine.",
    breaks: 'wrapper case 2 (an unterminated final line is flushed)',
    test: WRAP,
    find: `    flushRest(run, "stdout");
    flushRest(run, "stderr");`,
    replace: `    void 0; // MUTANT: the last partial line is dropped`,
  },
  {
    name: 'W6-ansi-not-stripped',
    file: F.wrapper,
    why: "Passing escape sequences straight through into the transcript. They reach `event_log`, the pane and the tier-2 digester as literal control bytes: the pane's fixed-width redraw contract breaks (an escape sequence is invisible but occupies string length), and a digest's character budget is spent on bytes nobody can read.",
    breaks: 'wrapper case 1 (ANSI is stripped)',
    test: WRAP,
    find: `export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI, "");`,
    replace: `export function stripAnsi(text) {
  return String(text ?? ""); // MUTANT: escapes pass through`,
  },
  {
    name: 'W7-pane-not-marked-as-degraded',
    file: F.layout,
    why: "Rendering a wrapper-tier pane exactly like a real one. PLAN.md section 9 requires the mark explicitly -- 'always explicitly marked as such in the UI' -- because the difference is not cosmetic: a reader of an unmarked pane believes they are seeing a parsed event stream from a conformance-passing harness, and will trust it accordingly.",
    breaks: 'wrapper case 6 (every wrapper-tier pane is marked)',
    test: WRAP,
    find: `  if (pane.degraded) {
    push("  ◇ degraded driver: raw terminal output, no turn boundaries, no approvals");
  }`,
    replace: `  if (false) { /* MUTANT: the degraded mark is gone */ }`,
  },
  {
    name: 'W8-snapshot-hides-the-tier',
    file: F.supervisor,
    why: "Not telling the UI which harness is degraded. The pane would have to derive it, which means every consumer needs its own copy of the rule and the newest consumer is always the one that forgets -- exactly the shape of the three defects the wire-surface suite was written for (FINDINGS section 32).",
    breaks: 'wrapper case 6 (the snapshot carries the tier and a flag)',
    test: WRAP,
    find: `          degraded: harnessTier.get(r.harness_id) === "wrapper",`,
    replace: `          degraded: false, // MUTANT: the UI is not told`,
  },
  {
    name: 'W9-start-guesses-a-command',
    file: F.wrapper,
    why: "Defaulting the command instead of requiring it. The wrapper tier IS 'a command nobody wrote an adapter for', so a guessed default turns a misconfiguration into a harness that appears to start and then produces no output -- which is indistinguishable from a harness that is simply quiet, and is diagnosed by nobody.",
    breaks: 'wrapper case 7 (start refuses to guess a command)',
    test: WRAP,
    find: `  if (!spec.command) {`,
    replace: `  if (false) { // MUTANT: a default command is guessed`,
  },
  {
    name: 'W10-events-not-flagged-degraded',
    file: F.wrapper,
    why: "Dropping `degraded: true` from the events themselves. The pane mark is a UI decision that any other consumer can miss; the flag on the event is the fact travelling with the data. Without it, a tier-2 digest, a handoff or a future consumer reads a wrapper-tier line as though a real adapter had parsed it.",
    breaks: 'wrapper case 2 (every event carries degraded: true)',
    test: WRAP,
    find: `    run.emitEvent({ type: "assistant.delta", text: \`\${line}\\n\`, stream, degraded: true });
  }
}`,
    replace: `    run.emitEvent({ type: "assistant.delta", text: \`\${line}\\n\`, stream }); // MUTANT: unflagged
  }
}`,
  },
];

const exitCode = await runMutations(MUTATIONS, { cwd: SUPERVISOR, filter: process.argv[2] });
process.exit(exitCode);
