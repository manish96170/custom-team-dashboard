#!/usr/bin/env node
// _mutate-tui.mjs — mutation harness for the TUI's Phase 4 completion: replay by cursor, the mouse, and
// the Requests panel (FLOWS §5 and §6a).
//
// Same standing rule: break one mechanism, and the suite must fail BY ASSERTION at the case that protects
// it. A mutation that merely crashes proves nothing.
//
// WHY A UI IS WORTH MUTATING AT ALL. A dashboard's failures are quiet by nature: a pane that re-reads the
// last 60 events instead of resuming looks fine until a run is longer than 60 events; a click resolved
// with slightly different arithmetic than the frame was drawn with lands one row off; a status message
// nobody renders is indistinguishable from nothing having happened. None of those throws.
//
// U1 and U11 are the two to read. U1 is the defect this work replaced (re-read a window, call it replay),
// and U11 is the one the demo found by being LOOKED at rather than tested — `state.status` written by half
// the actions and rendered by nothing.
//
// Usage: node runtime/test/_mutate-tui.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  layout: path.join(SUPERVISOR, 'tui/layout.js'),
  state: path.join(SUPERVISOR, 'tui/state.js'),
  app: path.join(SUPERVISOR, 'tui/app.js'),
  supervisor: path.join(SUPERVISOR, 'runtime/supervisor.js'),
  db: path.join(SUPERVISOR, 'db/index.js'),
};

const TUI = 'tui/test/tui.test.js';
const REPLAY = 'runtime/test/tui-replay.test.js';

const MUTATIONS = [
  {
    name: 'U1-cursor-ignored-window-re-read',
    file: F.supervisor,
    why: "Ignoring the client's cursor and re-reading a window every tick. This is EXACTLY the behaviour this work replaced, and it is invisible on any run shorter than the window: the pane looks live, it just silently forgets everything older and re-sends what the client already has. FLOWS section 5 asks for replay by cursor, and 'looks the same in the demo' is why it went unbuilt for a phase.",
    breaks: 'replay case 2 (a read at the cursor returns nothing new)',
    test: REPLAY,
    find: `          const after = Number.isInteger(cursorsIn[r.run_id]) ? cursorsIn[r.run_id] : 0;`,
    replace: `          const after = 0; // MUTANT: cursor ignored, window re-read`,
  },
  {
    name: 'U2-cursor-advances-past-unfinished-prose',
    file: F.supervisor,
    why: "Advancing the cursor past a turn's trailing `assistant.delta` events. A poll that lands mid-turn then commits half a sentence as a finished line and prints the rest as a second line -- the 'one fragment per line' defect (FINDINGS section 28) arriving from a new direction, and this time in an append-only client buffer where the wrong version stays.",
    breaks: 'replay case 3 (prose settles into one line)',
    test: REPLAY,
    find: `    while (cut > 0 && rows[cut - 1].type === "assistant.delta") cut -= 1;`,
    replace: `    void 0; // MUTANT: trailing prose treated as settled`,
  },
  {
    name: 'U3-gap-not-reported',
    file: F.db,
    why: "Returning a short list without saying anything was skipped. A pane with a hole in it looks exactly like a worker that said nothing, so the human draws a conclusion from an absence that is not real -- the same reason the event pump emits explicit `gap` frames rather than quietly resuming.",
    breaks: 'replay case 4 (a gap is reported as a count)',
    test: REPLAY,
    find: `  return { rows, skipped: Math.max(0, total - rows.length) };`,
    replace: `  return { rows, skipped: 0 }; // MUTANT: the gap is swallowed`,
  },
  {
    name: 'U4-transcript-replaced-not-appended',
    file: F.app,
    why: 'Replacing the accumulated transcript with each incremental slice instead of appending to it. Every tick that brought nothing new would blank the pane, and every tick that brought one line would show one line -- a dashboard that flickers between empty and almost-empty while the work is going fine.',
    breaks: 'replay case 6 (the app accumulates across ticks)',
    test: REPLAY,
    find: `      if (lines.length) t.lines.push(...lines);`,
    replace: `      t.lines = [...lines]; // MUTANT: accumulated transcript discarded`,
  },
  {
    name: 'U5-tier2-digests-shown-to-humans',
    file: F.db,
    why: "Letting tier-2 digests into a human's transcript. They share `event_log` (Rule 4), so the tier filter is the only thing keeping 'raw events for humans' apart from 'summaries for agents' -- and a pane would then show a paraphrase of the transcript printed directly above it, in a window whose whole constraint is that it is small.",
    breaks: 'replay case 5 (tier-2 digests stay out of the human transcript)',
    test: REPLAY,
    find: `                              WHERE run_id = ? AND tier = 1 AND seq > ? ORDER BY seq DESC LIMIT ?)`,
    replace: `                              WHERE run_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?)`,
  },
  {
    name: 'U6-requests-panel-always-shown',
    breaksCase: 'the Requests panel is absent at zero pending, appears when one lands, and h hides it',
    file: F.layout,
    why: 'Showing the Requests panel when nothing is pending. FLOWS section 6a is explicit that it is "collapsed by default when there are zero pending requests" -- and this is the one element on screen whose purpose is to be absent most of the time, so an always-present version spends roughly 12% of the dashboard saying there is nothing to triage.',
    breaks: 'tui case 12 (the panel is absent at zero pending)',
    test: TUI,
    find: `  if (!requests.length || state.requestsHidden) return 0;`,
    replace: `  if (false) return 0; // MUTANT: the panel always takes its space`,
  },
  {
    name: 'U7-h-is-global-again',
    breaksCase: 'the Requests panel is absent at zero pending, appears when one lands, and h hides it',
    file: F.state,
    why: 'Making `h` hide the Requests panel from ANY focus. FLOWS section 5 opens by ruling this out ("all keybindings act on the currently focused pane context, not globally") precisely because `h` also moves across the team bar -- so the unscoped version silently breaks team navigation, which is the more common action of the two.',
    breaks: 'tui case 12 (`h` outside the panel must not hide it)',
    test: TUI,
    find: `  if (state.focus === FOCUS.REQUESTS) {
    if (key === "h" || key === "escape") return { type: "hideRequests" };`,
    replace: `  if (true) { // MUTANT: h is global again
    if (key === "h" || key === "escape") return { type: "hideRequests" };`,
  },
  {
    name: 'U8-click-target-off-by-one',
    breaksCase: "hitTest resolves FLOWS' click targets, verified against the drawn frame",
    file: F.layout,
    why: "Resolving a click in the Requests panel one row away from where the panel drew it. The classic way mouse support rots: two copies of the same arithmetic, one to draw and one to hit-test. The symptom is 'clicking a request selects the one below it', which reads as a mouse problem rather than as a duplicated calculation -- which is why `frameGeometry` is shared and why the test checks the hit against the DRAWN frame rather than against the geometry.",
    breaks: 'tui case 13 (the click resolves to the request on that row)',
    test: TUI,
    find: `    const bodyTop = g.requests.top + (g.requests.height - 1 >= 2 ? 2 : 1);`,
    replace: `    const bodyTop = g.requests.top + 1; // MUTANT: off by one when the button row is drawn`,
  },
  {
    name: 'U9-team-click-keeps-stale-selection',
    breaksCase: 'clicks do what FLOWS says, and dead space does nothing',
    file: F.state,
    why: "Switching team on a click without dropping the selection from the old team. This is FINDINGS section 28's real defect in a new costume: the tree filters by team and the panes filter by selection, so a selection outside the active team makes the two halves of the screen describe different teams -- and each half looks internally consistent.",
    breaks: 'tui case 14 (a selection from the old team is dropped)',
    test: TUI,
    find: `        s.selectedNodeId = null;
        s.treeScroll = 0;
        s.focus = FOCUS.TREE;
        return s;`,
    replace: `        s.treeScroll = 0; // MUTANT: stale selection kept
        s.focus = FOCUS.TREE;
        return s;`,
  },
  {
    name: 'U10-hidden-panel-stays-hidden-forever',
    breaksCase: 'withRequests un-hides on an empty list and drops a vanished selection',
    file: F.state,
    why: '`h` hiding the panel permanently instead of hiding the batch you have seen. Every future request is then swallowed silently, which makes FLOWS section 6a\'s "appears the moment one lands" false -- and the failure is unobservable from inside the UI: there is no indication that anything was suppressed.',
    breaks: 'tui case 15 (an empty list un-hides the panel)',
    test: TUI,
    find: `    s.requestsHidden = false;
    s.selectedRequestId = null;`,
    replace: `    s.selectedRequestId = null; // MUTANT: hidden forever`,
  },
  {
    name: 'U11-status-never-rendered',
    breaksCase: 'the status line is actually rendered, and a long one does not break the frame',
    file: F.layout,
    why: "Writing `state.status` and never drawing it. THIS WAS THE REAL STATE OF THE CODE until a captured frame was read: 'supervisor unreachable' was set on every failed round trip and rendered nowhere, so a dashboard whose daemon had died was indistinguishable from one whose workers were quiet. The most expensive kind of silent failure -- the system knows what is wrong and does not say.",
    breaks: 'tui case 17 (the status line is rendered)',
    test: TUI,
    find: `    rule(cols, { left: B.lt, right: B.rt, label: state.status ? \`! \${state.status}\` : null }),`,
    replace: `    rule(cols, { left: B.lt, right: B.rt }), // MUTANT: status written, never drawn`,
  },
  {
    name: 'U12-rule-label-not-truncated',
    breaksCase: 'the status line is actually rendered, and a long one does not break the frame',
    file: F.layout,
    why: "Not truncating a rule's label. Now that the footer's rule carries arbitrary status text, an over-long message returns a line WIDER than `cols` -- which breaks the redraw contract every other line obeys, leaving fragments of the previous frame on screen. And it breaks it only once something else has already gone wrong, since the long messages are the error ones.",
    breaks: 'tui case 17 (an over-long status does not break the frame)',
    test: TUI,
    find: `  const tag = \` \${fit(label, Math.max(0, inner - 3)).trimEnd()} \`;`,
    replace: `  const tag = \` \${label} \`; // MUTANT: unbounded label`,
  },
  {
    name: 'U14-review-bar-shown-when-no-review',
    breaksCase: 'the review bar shows which condition is short, and only when a review is in flight',
    file: F.layout,
    why: "Rendering the review bar whether or not a review is in flight. Two rows of every frame spent saying nothing, and worse: an empty bar reads as 'a review exists and has no verdicts', which is a different and more alarming state than 'this task is not being reviewed'.",
    breaks: 'tui case 19 (no review in flight, no bar)',
    test: TUI,
    find: `  const reviewHeight = state.review ? 2 : 0;`,
    replace: `  const reviewHeight = 2; // MUTANT: the bar is always there`,
  },
  {
    name: 'U15-review-bar-geometry-not-accounted-for',
    breaksCase: 'the review bar shows which condition is short, and only when a review is in flight',
    file: F.layout,
    why: "Drawing the review bar without moving the pane area down for it. Every click below the bar then lands two rows above where it was drawn -- the classic mouse rot, and this time introduced by adding a row to the layout rather than by duplicating arithmetic, which is why `frameGeometry` has to be the thing that decides both.",
    breaks: 'tui case 13 / 19 (the geometry moves by exactly the bar height)',
    test: TUI,
    find: `  const paneTop = teamBarHeight + requestsHeight + reviewHeight + 1; // +1 for the divider under the header block`,
    replace: `  const paneTop = teamBarHeight + requestsHeight + 1; // MUTANT: the bar is drawn but not measured`,
  },
  {
    name: 'U16-review-status-recomputed-in-the-ui',
    file: F.app,
    why: "Leaving a finished review's status on screen instead of clearing it. `?? null` is what makes the bar disappear when a review ends; keeping the last evaluation means the dashboard states a condition the system has already left -- and a stale 'blocked' on an approved task is the kind of wrong that gets acted on.",
    breaks: 'review case 10 / tui case 19 (the bar reflects the current task only)',
    test: TUI,
    find: `        state.review = (selectedTaskId && snap.reviews?.[selectedTaskId]) ?? null;`,
    replace: `        state.review = (selectedTaskId && snap.reviews?.[selectedTaskId]) ?? state.review; // MUTANT: sticky`,
    breaks: 'replay case 8 (a finished review clears the bar)',
    test: REPLAY,
  },
  {
    name: 'U13-mouse-release-counts-as-a-click',
    breaksCase: 'mouse decoding takes the press of button 0 and nothing else',
    file: F.app,
    why: 'Treating the release as a second click. Every click then fires twice, which is invisible for selection (the second one selects the same thing) and wrong for anything that TOGGLES -- a click on a toggle would land back where it started, and the UI would look like it was ignoring the mouse.',
    breaks: 'tui case 16 (a release is not a second click)',
    test: TUI,
    find: `  if (kind !== "M" || Number(btn) !== 0) return null;`,
    replace: `  if (Number(btn) !== 0) return null; // MUTANT: release counts too`,
  },
];

const exitCode = await runMutations(MUTATIONS, { cwd: SUPERVISOR, filter: process.argv[2] });
process.exit(exitCode);
