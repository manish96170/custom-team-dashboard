#!/usr/bin/env node
// _mutate-pane.mjs — mutations for the pane: rendering rules and the attach/cursor contract.
//
// The machinery (apply-exactly-once, restore-from-original-bytes, caught-means-AssertionError) lives
// in `../../runtime/test/_mutate-runner.mjs`, which explains why each of those checks exists. This
// file is only the list.
//
// A pane is where a human's understanding of a worker comes from, so the mechanisms worth breaking
// are the ones whose failure is INVISIBLE: an event silently dropped, a gap silently swallowed, a
// cursor that quietly replays or quietly skips. None of those announce themselves — the transcript
// just reads slightly wrong, which is worse than an error.
//
// Every pattern below is a SINGLE-QUOTED string, not a template literal: the code being mutated is
// full of backticks and `${...}`, and nesting those inside a template literal is a syntax error
// waiting to happen (it was, once).
//
// Usage: node pane/test/_mutate-pane.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from '../../runtime/test/_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  render: path.join(SUPERVISOR, 'pane/render.js'),
  pane: path.join(SUPERVISOR, 'pane/pane.js'),
};

const RENDER = 'pane/test/render.test.js';
const E2E = 'pane/test/pane-e2e.test.js';

const MUTATIONS = [
  {
    name: 'P1-unknown-event-dropped',
    file: F.render,
    why: 'Silently drops an event type the renderer does not know. The event set grows by design, but "ignore what you do not recognise" must not become "hide it from the human reading the pane".',
    breaks: 'render case 1 (an unknown event is shown with its payload and seq)',
    test: RENDER,
    find: '        push(`${stamp()}${s.dim(`· ${event.type}`)}',
    replace: '        if (true) return; push(`${stamp()}${s.dim(`· ${event.type}`)}',
  },
  {
    name: 'P2-gap-rendered-silently',
    file: F.render,
    why: 'Turns a gap frame into nothing. The event pump guarantees eviction is never silent; this throws that guarantee away at the last hop, the one a human actually sees.',
    breaks: 'render case 2 (a gap says how many events were lost)',
    test: RENDER,
    find: '    push(s.yellow(`⚠ ${missing} event(s) were evicted',
    replace: '    push(""); if (true) { return [lines[lines.length - 1]]; } push(s.yellow(`⚠ ${missing} event(s) were evicted',
  },
  {
    name: 'P3-thinking-shown-by-default',
    file: F.render,
    why: "Renders the model's scratch space by default, burying the actual answer in a pane whose whole job is legibility.",
    breaks: 'render case 4 (thinking is hidden unless asked for)',
    test: RENDER,
    find: '        if (event.channel === "thinking" && !showThinking) return;',
    replace: '        // MUTANT: thinking always shown',
  },
  {
    name: 'P4-approval-offers-no-affordance',
    file: F.render,
    why: 'Removes the "the worker is waiting" line, so an approval reads as an ordinary transcript row and a stopped worker looks like a slow one.',
    breaks: 'render case 5 (an approval says the worker is stopped and how to answer)',
    test: RENDER,
    find: '        push(`   ${s.dim("the worker is waiting',
    replace: '        if (true) return; push(`   ${s.dim("the worker is waiting',
  },
  {
    name: 'P5-auto-denial-looks-like-a-live-request',
    file: F.render,
    why: 'Stops handling the harness auto-denial as its own case, so it falls through to the unknown-event renderer and a decision that cannot be changed reads like something unrecognised rather than something settled.',
    breaks: 'render case 7 (an auto-denial reads as already-decided)',
    test: RENDER,
    find: '      case "approval.auto-denied":',
    replace: '      case "approval.auto-denied-DISABLED-BY-MUTANT":',
  },
  {
    name: 'P6-cursor-never-advances',
    file: F.pane,
    why: 'Leaves the replay cursor at 0, so re-attaching replays the entire history instead of resuming — for a long-running session, a pane switch dumps thousands of stale lines.',
    breaks: 'e2e case 5 (re-attaching replays only what was missed)',
    test: E2E,
    find: '        if (typeof frame.seq === "number") cursor = frame.seq;',
    replace: '        // MUTANT: cursor frozen',
  },
  {
    name: 'P7-answer-ignores-answerable',
    file: F.pane,
    why: 'Lets the pane answer an ask the harness has already withdrawn or whose process was replaced, so a human makes a decision that goes nowhere and is told it worked.',
    breaks: 'nothing yet — recorded rather than hidden; see the note in the source',
    test: E2E,
    find: '    if (ask.answerable === false) {',
    replace: '    if (false) { // MUTANT: answerability unchecked',
    // Deliberately expected to SURVIVE, with the reason written down rather than left as a silent
    // gap. The e2e suite only ever answers asks that are answerable, and constructing the opposite
    // needs a withdrawal racing an answer across the socket — which `runtime/test/approval.test.js`
    // case 12 already covers at the supervisor level, where the guard that protects the DATA lives.
    // This pane check is a UX guard in front of that one: worth having, not worth a flaky socket
    // race to prove.
    expectSurvives: true,
  },
  {
    name: 'P8-streamed-line-repeated-not-updated',
    file: F.pane,
    why: 'Stops telling the consumer that a coalesced line is an UPDATE, so an append-only consumer prints the line once per token — exactly what the first real captured transcript did ("assistant The", "assistant The page", ...). Correct data presented wrongly, and invisible to any test whose fake emits one delta per line.',
    breaks: 'e2e case 8 (an update extends the previous line rather than repeating it)',
    test: E2E,
    find: '    const replacesPrevious = produced.length === 1 && totalNow === renderedCount;',
    replace: '    const replacesPrevious = false; // MUTANT: every frame looks like a new line',
  },
];

process.exit(await runMutations(MUTATIONS, { cwd: SUPERVISOR, filter: process.argv[2] }));
