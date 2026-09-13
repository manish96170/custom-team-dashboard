// tui.test.js — the TUI's layout and focus model (Phase 4).
//
// Every case here runs with NO terminal, NO socket and NO harness, because `layout.js` and `state.js`
// are pure. That is the whole reason they were split from `app.js`: a TUI you can only check by looking
// at it is a TUI nobody can regression-test, and "the dev pane expands when reviewers are hidden" then
// becomes a thing someone has to remember to eyeball.
//
// Cases:
//   1. every line of every frame is exactly `cols` wide — the redraw contract
//   2. a too-small terminal says so instead of computing negative widths
//   3. the tree is TASK-node with worker children (PLAN.md section 5's cardinality fix)
//   4. the three non-running pane states each SAY which one they are
//   5. the dev pane auto-expands when reviewers are hidden (FLOWS §5: "no dead space")
//   6. `r` is not lossy: it restores the last-shown reviewer set, not a default
//   7. chat focus makes letters TEXT, not commands — the sharpest focus-scoping case
//   8. team navigation clamps rather than wraps, and invalidates a stale selection
//   9. `m` pins and unpins, and refuses on a task node
//  10. `d` needs a worker, and toggles back to the CTO
//  11. an unbound key returns null rather than a no-op action
//  12. the Requests panel is ABSENT at zero pending, appears when one lands, and `h` hides it
//  13. `hitTest` resolves FLOWS §5's click targets, checked against the DRAWN frame
//  14. clicks do what FLOWS says, and dead space does nothing
//  15. `withRequests` un-hides on an empty list and drops a vanished selection
//  16. mouse decoding takes the press of button 0 and nothing else
//  17. `state.status` is RENDERED (it was not), and an over-long one does not break the frame
//  18. the pane layout follows the TASK TYPE, until someone toggles a reviewer explicitly
//  19. the REVIEW BAR (Phase 6) shows which of section 13's conditions is short, and moves the geometry
//  20. `t` hides/shows the TREE from anywhere; the pane area reclaims the width, selection survives
//  21. `R` toggles the Requests panel from anywhere, regardless of pending count (unlike `h`)
//  22. a long request expands to the Request Detail view; closing it restores the layout exactly
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import {
  renderFrame, renderPaneBody, visiblePanes, frameGeometry, hitTest,
  requestsPanelHeight, renderRequestsPanel, teamBarChips, MIN_COLS, MIN_ROWS, fit, cellWidth,
} from "../layout.js";
import { initialState, press, keyToAction, applyAction, withRequests, treeRows, FOCUS } from "../state.js";
import { decodeMouse, decodeKey } from "../app.js";
import { paneDefaultFor } from "../../domain/workflow-profiles.js";

let failed = 0;
let n = 0;
/**
 * Print in the project's NUMBERED convention ("  3. name") and re-print the WHOLE error on failure.
 *
 * Both matter to the mutation harness rather than to a human reader: `_mutate-runner.mjs` locates the
 * broken case by scanning for `^  N.` lines, and it only credits a mutation as caught when the output
 * contains a real `AssertionError`. An earlier version of this file printed "PASS <name>" and only
 * `err.message`, so every mutation was reported as a crash at case 1 — proving nothing. Same trap as
 * FINDINGS section 22.1, one file later.
 */
function testCase(name, fn) {
  n += 1;
  try { fn(); console.log(`  ${n}. ${name}`); } catch (err) {
    failed += 1;
    // `FAIL: <name>` exactly, because that is the form `_mutate-runner.mjs` matches for `breaksCase`.
    // The runner's other mechanism -- "the last numbered line printed is the last case that passed" --
    // does NOT work for this file: it keeps going after a failure, so later cases still print numbers
    // and the arithmetic overshoots. Naming the case is the reliable attribution here.
    console.error(`  FAIL: ${name}`);
    console.error(err);
  }
}

/** A populated state: two teams, a dev + two reviewers on one task. */
function demoState(overrides = {}) {
  return initialState({
    teams: [{ id: "t1", name: "Vite" }, { id: "t2", name: "Lint" }],
    tasks: [
      // PLAN.md section 6's real state names — Phase 5 made them enforced, and this fixture had drifted
      // to `in-progress`, which `taskGlyph` renders as `?`.
      { id: "task-1", title: "Invert the tweak", teamId: "t1", state: "implementing" },
      { id: "task-2", title: "Fix rule 42", teamId: "t2", state: "created" },
    ],
    workers: [
      { workerId: "w1", nickname: "purus", role: "coder", taskId: "task-1" },
      { workerId: "w2", nickname: "luna", role: "reviewer", taskId: "task-1" },
      { workerId: "w3", nickname: "terra", role: "reviewer", taskId: "task-1" },
    ],
    panes: [
      { role: "dev", title: "purus (coder)", status: "running", lines: ["working on it"] },
      { role: "reviewer", slot: "parent", title: "luna (reviewer)", status: "running", lines: ["reviewing"] },
      { role: "reviewer", slot: "rev1", title: "terra (reviewer)", status: "running", lines: ["also reviewing"] },
    ],
    selectedNodeId: "task-1",
    // The fixture shows a SPLIT, which is now a decision rather than the default: `paneLayout` follows the
    // selected task's type (FLOWS §5), and a `feature` task's default is the dev pane alone. Case 18 owns
    // that behaviour; every other case here is about what happens once a split is on screen, so saying so
    // explicitly is what keeps those cases testing what they claim to.
    paneLayout: "review",
    ...overrides,
  });
}

// ── 1 ────────────────────────────────────────────────────────────────────────────────────
// The redraw contract. `app.js` diffs frame against frame and moves the cursor only to changed
// lines; a line shorter than the previous frame's leaves the old characters on screen, and the bug
// presents as corrupted state rather than a missing space.
testCase("every line is exactly cols wide, at several sizes", () => {
  for (const size of [{ cols: 80, rows: 24 }, { cols: 100, rows: 30 }, { cols: 61, rows: 17 }, { cols: 200, rows: 50 }]) {
    const frame = renderFrame(demoState(), size);
    assert.equal(frame.length, size.rows, `expected ${size.rows} rows, got ${frame.length}`);
    for (const [i, line] of frame.entries()) {
      assert.equal(line.length, size.cols,
        `line ${i} is ${line.length} wide, expected ${size.cols} at ${size.cols}x${size.rows}: ${JSON.stringify(line)}`);
    }
  }
});

// ── 2 ────────────────────────────────────────────────────────────────────────────────────
testCase("a too-small terminal says so rather than computing negative widths", () => {
  const frame = renderFrame(demoState(), { cols: 20, rows: 5 });
  assert.equal(frame.length, 5);
  assert.match(frame[0], /terminal too small/);
  for (const line of frame) assert.equal(line.length, 20, "and still honours the width contract");
  // The boundary is inclusive: exactly the minimum must render normally.
  const ok = renderFrame(demoState(), { cols: MIN_COLS, rows: MIN_ROWS });
  assert.equal(/terminal too small/.test(ok[0]), false, `${MIN_COLS}x${MIN_ROWS} must be renderable`);
});

// ── 3 ────────────────────────────────────────────────────────────────────────────────────
// PLAN.md section 5's cardinality fix: the tree's nodes are TASKS, with workers as children. A
// member-node tree has to invent a parent for each worker.
testCase("the tree is task-node with worker children", () => {
  const rows = treeRows(demoState());
  assert.deepEqual(rows.map((r) => r.kind), ["task", "worker", "worker", "worker"],
    "a task, then its workers — not a flat list of members");
  assert.equal(rows[0].id, "task-1");

  // And it is scoped to the active team: task-2 belongs to the other one.
  // The tree is ~15% of the width (FLOWS §6's "TREE 15%"), so at 100 cols it is 15 characters and a
  // task title TRUNCATES. That is by design — the pane header carries the full name — so this asserts
  // the truncated prefix rather than pretending the whole title fits.
  const frame = renderFrame(demoState(), { cols: 100, rows: 30 }).join("\n");
  assert.ok(/Invert the/.test(frame), `the active team's task is shown (truncated); frame had no match`);
  assert.equal(/Fix rule 42/.test(frame), false, "the other team's task is not");
  // Wide enough, and the whole title fits — so truncation is a width consequence, not a bug.
  assert.ok(renderFrame(demoState(), { cols: 200, rows: 30 }).join("\n").includes("Invert the tweak"),
    "and at 200 cols the full title fits");
});

// ── 4 ────────────────────────────────────────────────────────────────────────────────────
// A blank pane is the most confusing thing a dashboard can show: "empty", "it died" and "this is old
// output" look identical unless each one says which it is.
testCase("the three non-running pane states each say which they are", () => {
  const empty = renderPaneBody({ title: "x", status: "empty", lines: [] }, 40, 8).join("\n");
  assert.match(empty, /nothing has happened/);

  // "ended", not "crashed" — fixed 2026-09-11 (`codexdoc/REVIEW-NOTES.md` finding 15's second half):
  // a status literally named "crashed" for EVERY ended run asserted a failure a normal `finished`/
  // `stopped` exit never had. Two cases: a deliberate reap (not a failure) and a genuine error, both
  // rendered under the same neutral status, distinguished only by the reason text.
  const reaped = renderPaneBody({ title: "x", status: "ended", exitReason: "reaped", lines: ["last words"] }, 40, 10).join("\n");
  assert.match(reaped, /this run ended: reaped/, "a closed run names its exit reason");
  assert.match(reaped, /last words/, "and still shows what it produced");
  assert.doesNotMatch(reaped, /crashed/i, "a deliberate reap must not be labelled a crash anywhere in the render");

  const errored = renderPaneBody({ title: "x", status: "ended", exitReason: "errored", lines: [] }, 40, 10).join("\n");
  assert.match(errored, /this run ended: errored/, "a genuine failure still names its real reason");

  const stale = renderPaneBody({ title: "x", status: "stale", lines: [] }, 46, 8).join("\n");
  assert.match(stale, /not streaming/);
  assert.match(stale, /not controllable/, "an adopted session must not look like a live pane");

  const none = renderPaneBody(null, 40, 6).join("\n");
  assert.match(none, /no pane/, "and no pane at all is its own message");
});

// ── 5 ────────────────────────────────────────────────────────────────────────────────────
testCase("the dev pane auto-expands when reviewers are hidden", () => {
  const split = demoState();
  assert.equal(visiblePanes(split).length, 2, "precondition: a dev pane and one reviewer");

  const hidden = press(split, "r");
  assert.equal(hidden.reviewersHidden, true);
  const panes = visiblePanes(hidden);
  assert.equal(panes.length, 1, "FLOWS §5: no dead space — the dev pane takes the width");
  assert.equal(panes[0].role, "dev");

  // Measured in the frame, not just in the model: the pane body must actually be wider.
  const wideLine = renderFrame(hidden, { cols: 100, rows: 30 }).find((l) => l.includes("purus"));
  const splitLine = renderFrame(split, { cols: 100, rows: 30 }).find((l) => l.includes("purus"));
  assert.ok(wideLine.indexOf("│", 30) > splitLine.indexOf("│", 30),
    "the dev pane's right-hand border must move outward when the reviewer pane is hidden");
});

// ── 6 ────────────────────────────────────────────────────────────────────────────────────
// FLOWS §5 says `r` again "restores last-shown reviewer pane state". Restoring a DEFAULT instead
// would silently discard a selection the user made, which is the difference between hiding and losing.
testCase("r is not lossy — it restores the last-shown reviewer set", () => {
  let s = demoState({ visibleReviewers: ["parent", "rev1"] });
  s = press(s, "r");
  assert.equal(s.reviewersHidden, true);
  s = press(s, "r");
  assert.deepEqual(s.visibleReviewers.sort(), ["parent", "rev1"], "both come back, not just the default");

  // Toggling an individual slot on is an implicit un-hide, or `r` then `1` would be a dead keypress.
  let t = press(demoState(), "r");
  assert.equal(t.reviewersHidden, true);
  t = press(t, "1");
  assert.equal(t.reviewersHidden, false, "turning a slot on must un-hide");
  assert.ok(t.visibleReviewers.includes("rev1"));
});

// ── 7 ────────────────────────────────────────────────────────────────────────────────────
// The sharpest case for focus-scoped keys. A chat box where typing "fq" toggles fullscreen and quits
// is not a chat box.
testCase("chat focus makes letters text, not commands", () => {
  let s = press(demoState(), "/");
  assert.equal(s.focus, FOCUS.CHAT);

  for (const ch of ["f", "q", "r", "1", "d", "g"]) s = press(s, ch);
  assert.equal(s.chatInput, "fqr1dg", `letters must accumulate as text; got ${JSON.stringify(s.chatInput)}`);
  assert.equal(s.quit, false, "q must NOT quit while typing");
  assert.equal(s.fullscreen, false, "f must NOT toggle fullscreen while typing");
  assert.equal(s.reviewersHidden, false, "r must NOT hide reviewers while typing");

  s = press(s, "backspace");
  assert.equal(s.chatInput, "fqr1d");
  s = press(s, "return");
  assert.equal(s.pendingChat.text, "fqr1d", "submit hands the text off as an action for app.js to send");
  assert.equal(s.chatInput, "", "and clears the field");

  s = press(s, "escape");
  assert.equal(s.focus, FOCUS.TREE, "escape leaves the chat bar");
  s = press(s, "q");
  assert.equal(s.quit, true, "and q is a command again once focus has left");
});

// ── 8 ────────────────────────────────────────────────────────────────────────────────────
testCase("team navigation clamps rather than wraps, and drops a stale selection", () => {
  let s = demoState();
  s = press(s, "h");
  assert.equal(s.activeTeamIndex, 0, "clamped at the left edge — wrapping reads as a glitch");
  s = press(s, "l");
  assert.equal(s.activeTeamIndex, 1);
  assert.equal(s.selectedNodeId, null, "a selection belonging to the previous team is invalidated");
  s = press(s, "l");
  assert.equal(s.activeTeamIndex, 1, "clamped at the right edge too");
});

// ── 9 ────────────────────────────────────────────────────────────────────────────────────
testCase("m pins and unpins a worker, and refuses on a task node", () => {
  let s = demoState({ selectedNodeId: "task-1" });
  s = press(s, "m");
  assert.equal(s.pinnedWorkerId, null, "a task is not pinnable");
  assert.match(s.status, /applies to a worker/, "and it says so rather than doing nothing");

  s = applyAction(s, { type: "treeDown" }); // onto the first worker
  s = press(s, "m");
  assert.equal(s.pinnedWorkerId, "w1");
  const frame = renderFrame(s, { cols: 100, rows: 30 }).join("\n");
  assert.match(frame, /purus \*/, "a pin is visible in the tree — otherwise 'why this pane' is unanswerable");
  s = press(s, "m");
  assert.equal(s.pinnedWorkerId, null, "and it toggles off — a pin you cannot remove is a trap");
});

// ── 10 ───────────────────────────────────────────────────────────────────────────────────
testCase("d needs a worker selected, and toggles back to the CTO", () => {
  let s = demoState({ selectedNodeId: "task-1" });
  s = press(s, "d");
  assert.equal(s.chatTarget, "cto", "a task is not a direct-chat target");
  assert.match(s.status, /needs a worker/);

  s = applyAction(s, { type: "treeDown" });
  s = press(s, "d");
  assert.equal(s.chatTarget, "w1");
  assert.equal(s.chatTargetName, "purus");
  const frame = renderFrame(s, { cols: 100, rows: 30 }).join("\n");
  assert.match(frame, /purus \(direct\)/, "the chat bar states its target — never implies it");

  s = press(s, "d");
  assert.equal(s.chatTarget, "cto", "and toggles back");
});

// An unbound key must be reported as unbound, so `app.js` can tell "means nothing" from "is text".
testCase("an unbound key returns null rather than a no-op action", () => {
  assert.equal(keyToAction("z", demoState()), null);
  assert.equal(keyToAction("f", demoState()).type, "toggleFullscreen");
});


// ── 12 ───────────────────────────────────────────────────────────────────────────────────
// FLOWS §6a: "collapsed by default when there are zero pending requests; appears the moment one lands",
// and hidden again by `h` WHILE FOCUSED. That last part is the collision §5 rules out by scoping keys to
// focus — `h` moves across the team bar everywhere else, and both meanings have to hold.
testCase("the Requests panel is absent at zero pending, appears when one lands, and h hides it", () => {
  const size = { cols: 100, rows: 30 };
  const empty = demoState();
  assert.equal(requestsPanelHeight(empty, size.rows), 0, "no pending requests, no panel");
  assert.equal(renderFrame(empty, size).join("\n").includes("REQUESTS"), false,
    "and not a single row of screen space spent saying there is nothing to triage");

  const req = { id: "r1", from: "nj", channel: "#your-mr-channel", text: "@you please review this" };
  const withOne = withRequests(empty, [req]);
  assert.ok(requestsPanelHeight(withOne, size.rows) > 0, "one request and the panel appears");
  const frame = renderFrame(withOne, size).join("\n");
  assert.match(frame, /REQUESTS \(1 pending\)/, "with a count, so a collapsed panel is still informative");
  assert.match(frame, /please review this/, "and the message itself, which is the thing being triaged");
  assert.match(frame, /\[Accepted\] \[Declined\]/, "plus §6a's button row");

  // `h` hides only while the panel is focused; elsewhere it is still team navigation.
  const focused = applyAction(withOne, { type: "click", target: { kind: "requests", requestId: "r1" } });
  assert.equal(focused.focus, FOCUS.REQUESTS);
  const hidden = press(focused, "h");
  assert.equal(hidden.requestsHidden, true, "`h` in the requests panel hides the panel");
  assert.equal(hidden.focus, FOCUS.TREE, "and returns focus somewhere usable");
  assert.equal(renderFrame(hidden, size).join("\n").includes("REQUESTS"), false);
  // The same key, one focus over: still team navigation. This is the assertion that makes the scoping
  // claim non-vacuous.
  const elsewhere = press(withOne, "h");
  assert.equal(elsewhere.requestsHidden, false, "`h` outside the panel must NOT hide it");

  // And the panel keeps the message rather than the buttons when it is short (§6a).
  const short = renderRequestsPanel(withOne, 100, 2);
  assert.equal(short.length, 2);
  assert.equal(short.join("").includes("[Accepted]"), false, "the buttons collapse first");
  assert.ok(short.join("").includes("please review this"), "the message survives — it is what is being triaged");
});

// ── 13 ───────────────────────────────────────────────────────────────────────────────────
// Checked against the RENDERED FRAME, not against the geometry that produced it. Asserting that
// `hitTest` agrees with `frameGeometry` would be vacuous — they are the same arithmetic — so every
// target here is confirmed by reading the characters actually drawn at that row and column.
testCase("hitTest resolves FLOWS' click targets, verified against the drawn frame", () => {
  const size = { cols: 100, rows: 30 };
  const s = withRequests(demoState({ visibleReviewers: ["parent"] }), [
    { id: "r1", from: "nj", channel: "#chan", text: "please review" },
  ]);
  const frame = renderFrame(s, size);
  const g = frameGeometry(s, size);

  // A team chip: the hit must land inside the characters that spell that team's name.
  const chip = teamBarChips(s, size.cols).shown[1];
  const drawn = frame[g.teamBar.chipRow].slice(chip.col, chip.col + chip.width);
  assert.ok(drawn.includes("Lint"), `the chip for team 2 must actually be drawn there; found ${JSON.stringify(drawn)}`);
  const teamHit = hitTest(s, size, chip.col + 1, g.teamBar.chipRow);
  assert.deepEqual({ kind: teamHit.kind, index: teamHit.index }, { kind: "team", index: 1 });

  // A tree row: find the frame row that shows `luna`, and hit it.
  const lunaRow = frame.findIndex((l, i) => i >= g.paneArea.top && l.slice(1, g.treeWidth).includes("luna"));
  assert.ok(lunaRow > 0, "precondition: luna is drawn in the tree");
  assert.deepEqual(hitTest(s, size, 3, lunaRow), { kind: "treeRow", id: "w2", nodeKind: "worker" });

  // A pane: the second pane's columns must be where the second pane's title was drawn.
  assert.equal(g.paneArea.panes.length, 2, "precondition: two panes are visible");
  const right = g.paneArea.panes[1];
  const titleRow = frame.findIndex((l, i) => i >= g.paneArea.top && l.slice(right.colStart, right.colEnd + 1).includes("luna (reviewer)"));
  assert.ok(titleRow > 0, "precondition: the reviewer pane's title is drawn in the right-hand columns");
  assert.deepEqual(hitTest(s, size, right.colStart + 2, titleRow), { kind: "pane", index: 1 });

  // The requests panel: the hit must name the request DRAWN on that row, not just the panel. Asserting
  // only `kind` would pass with the body offset by a row, which is exactly the off-by-one a click model
  // built from separate arithmetic produces.
  const reqRow = frame.findIndex((l) => l.includes("please review"));
  assert.ok(reqRow > 0, "precondition: the request is drawn");
  const reqHit = hitTest(s, size, 5, reqRow);
  // `fits: true` since 2026-09-11 (FLOWS §6c) — this short request fits inline, so a click selects it
  // rather than expanding to the Request Detail view; see the new case below for the "doesn't fit" path.
  assert.deepEqual(reqHit, { kind: "requests", requestId: "r1", fits: true },
    `the click must resolve to the request on that row; frame row ${reqRow} reads ${JSON.stringify(frame[reqRow])}`);
  assert.equal(hitTest(s, size, 5, g.chat.top + 1).kind, "chat");
  // Off-frame is null rather than a clamped guess — a click nobody made must not act.
  assert.equal(hitTest(s, size, 5, size.rows + 3), null);
  assert.equal(hitTest(s, size, -1, 1), null);
});

// ── 14 ───────────────────────────────────────────────────────────────────────────────────
testCase("clicks do what FLOWS says, and dead space does nothing", () => {
  const s = demoState({ selectedNodeId: "task-1" });

  // "Click a team in top bar -> that team becomes active; tree + panes scope to it." The stale selection
  // must go with it, or the tree and the panes disagree — the demo's real §28 defect.
  const teamClick = applyAction(s, { type: "click", target: { kind: "team", index: 1 } });
  assert.equal(teamClick.activeTeamIndex, 1);
  assert.equal(teamClick.selectedNodeId, null, "a selection from the old team is dropped");

  // "Click a worker in tree -> opens that worker's pane directly, full focus."
  const workerClick = applyAction(s, { type: "click", target: { kind: "treeRow", id: "w1", nodeKind: "worker" } });
  assert.equal(workerClick.selectedNodeId, "w1");
  assert.equal(workerClick.openedNodeId, "w1", "a click OPENS — unlike moving the cursor, it is explicit");
  assert.equal(workerClick.focus, FOCUS.PANE);

  // "Click a worker, then `m` -> pins that worker's run." The two rows compose, which is the point of
  // click-produces-a-selection rather than click-does-everything.
  const pinned = press(workerClick, "m");
  assert.equal(pinned.pinnedWorkerId, "w1");

  const paneClick = applyAction(s, { type: "click", target: { kind: "pane", index: 1 } });
  assert.equal(paneClick.focusedPane, 1);
  assert.equal(paneClick.focus, FOCUS.PANE);

  // Dead space and the footer do nothing at all. A click that falls through to a default is how a UI
  // ends up switching panes because someone clicked a border.
  assert.equal(applyAction(s, { type: "click", target: null }), s);
  assert.equal(applyAction(s, { type: "click", target: { kind: "footer" } }).focus, s.focus);
});

// ── 15 ───────────────────────────────────────────────────────────────────────────────────
// `h` hides the requests you have seen, not the panel forever. Without this, hiding one batch would
// silently swallow every future request, and FLOWS §6a's "appears the moment one lands" would be false.
testCase("withRequests un-hides on an empty list and drops a vanished selection", () => {
  const a = withRequests(demoState(), [{ id: "r1", text: "one" }, { id: "r2", text: "two" }]);
  assert.equal(a.selectedRequestId, "r1", "something is selected, so the panel is navigable at once");

  const focused = applyAction(a, { type: "click", target: { kind: "requests", requestId: "r2" } });
  assert.equal(applyAction(focused, { type: "requestUp" }).selectedRequestId, "r1");
  const hidden = press(focused, "h");
  assert.equal(hidden.requestsHidden, true);

  const emptied = withRequests(hidden, []);
  assert.equal(emptied.requestsHidden, false, "an empty list un-hides the panel for the NEXT request");
  assert.equal(emptied.selectedRequestId, null);
  assert.notEqual(emptied.focus, FOCUS.REQUESTS, "and focus does not stay on a panel that is gone");

  // A selection that no longer exists moves to something that does, rather than pointing at nothing.
  const replaced = withRequests(a, [{ id: "r3", text: "three" }]);
  assert.equal(replaced.selectedRequestId, "r3");
});

// ── 16 ───────────────────────────────────────────────────────────────────────────────────
// The press of button 0, and nothing else. Acting on the release too would double every click; decoding
// a wheel event as a click would scroll the tree by opening whatever is under the pointer.
testCase("mouse decoding takes the press of button 0 and nothing else", () => {
  assert.deepEqual(decodeMouse(Buffer.from("\x1b[<0;10;5M")), { col: 9, row: 4 }, "1-based on the wire, 0-based here");
  assert.equal(decodeMouse(Buffer.from("\x1b[<0;10;5m")), null, "a release is not a second click");
  assert.equal(decodeMouse(Buffer.from("\x1b[<64;10;5M")), null, "wheel up is not a click");
  assert.equal(decodeMouse(Buffer.from("\x1b[<2;10;5M")), null, "and neither is the right button");
  assert.equal(decodeMouse(Buffer.from("\x1b[A")), null, "an arrow key is not a mouse report");
  assert.equal(decodeMouse(Buffer.from("q")), null);
  // And the two decoders must not both claim a mouse report — `decodeKey` seeing `ESC[<...` would
  // silently drop it, which is why `app.js` tries the mouse first.
  assert.equal(decodeKey(Buffer.from("\x1b[<0;10;5M")), null,
    "decodeKey does not recognise a mouse report, so the mouse decoder must run first");
});


// ── 17 ───────────────────────────────────────────────────────────────────────────────────
// `state.status` was written by half the actions and RENDERED BY NOTHING, so a TUI whose supervisor had
// died looked exactly like one whose workers were quiet. Found by reading a captured frame, not by a
// test — which is why there is now a test.
testCase("the status line is actually rendered, and a long one does not break the frame", () => {
  const size = { cols: 100, rows: 30 };
  const quiet = renderFrame(demoState(), size);
  assert.equal(quiet.join("\n").includes("supervisor unreachable"), false, "precondition: nothing to say");

  const s = demoState({ status: "supervisor unreachable: connect ENOENT /tmp/control.sock" });
  const frame = renderFrame(s, size);
  assert.match(frame.join("\n"), /supervisor unreachable/,
    "a status the state layer bothered to write must reach the screen");

  // And the redraw contract still holds with a status far longer than the terminal is wide — this is the
  // case that breaks a frame only once something has already gone wrong.
  const long = renderFrame(demoState({ status: "x".repeat(400) }), { cols: 70, rows: 24 });
  for (const [i, line] of long.entries()) {
    assert.equal(line.length, 70, `line ${i} must be exactly 70 wide with an over-long status; got ${line.length}`);
  }
  assert.equal(long.length, 24);
});


// ── 18 ───────────────────────────────────────────────────────────────────────────────────
// FLOWS §5: "click a task node -> smart default from task type: dev task shows last-active dev run (by
// most-recent-message, unless pinned); review task shows dev pane + one reviewer pane". A DEFAULT, not a
// policy: the first explicit reviewer toggle has to win from then on, or the layout would keep snapping
// back and the toggles would feel broken.
testCase("the pane layout follows the task type, until someone toggles a reviewer", () => {
  const devTask = demoState({ paneLayout: "dev" });
  assert.equal(visiblePanes(devTask).length, 1, "a dev task shows the dev pane alone");
  assert.equal(visiblePanes(devTask)[0].role, "dev");

  const reviewTask = demoState({ paneLayout: "review" });
  assert.equal(visiblePanes(reviewTask).length, 2, "a review task shows dev + one reviewer");

  // An explicit toggle ends the default. `p` turns the parent reviewer off and then on again, and the
  // dev-task layout must NOT reassert itself in between — that is the difference between a default and a
  // rule, and getting it wrong makes `1`/`2`/`p` look like they do nothing on a dev task.
  let s = press(devTask, "p");
  assert.equal(s.reviewerDefaultFromType, false, "the first toggle ends the type-driven default");
  s = press(s, "p");
  assert.equal(visiblePanes(s).length, 2,
    "and after that the reviewer shows on a DEV task too, because the user asked for it");

  // `r` (hide all) also counts as asking.
  const viaR = press(press(demoState({ paneLayout: "dev" }), "r"), "r");
  assert.equal(viaR.reviewerDefaultFromType, false);
  assert.equal(visiblePanes(viaR).length, 2);

  // And the mapping itself comes from the workflow profile, so there is one home for type -> layout.
  assert.equal(paneDefaultFor("review"), "review");
  assert.equal(paneDefaultFor("feature"), "dev");
  assert.equal(paneDefaultFor("adhoc"), "dev");
  assert.equal(paneDefaultFor("something-nobody-profiled"), "dev", "an unknown type still renders");
});


// ── 19 ───────────────────────────────────────────────────────────────────────────────────
// ROADMAP Phase 6's "review-pane wiring". The toggles it names were built in Phase 4; what was missing is
// the thing a human needs from a review — WHICH of section 13's three conditions is short. "awaiting-review"
// as a glyph answers none of them: a reviewer can have approved everything while quorum is one short, and
// that looks identical to nobody having looked.
testCase("the review bar shows which condition is short, and only when a review is in flight", () => {
  const size = { cols: 100, rows: 30 };
  const noReview = demoState();
  assert.equal(renderFrame(noReview, size).join("\n").includes("REVIEW"), false,
    "no review in flight, no rows spent on one");
  assert.equal(frameGeometry(noReview, size).review, null);

  const s = demoState({
    review: {
      round: 2,
      approved: false,
      dimensions: {
        correctness: { approvals: 2, changeRequests: 0, satisfied: true },
        security: { approvals: 0, changeRequests: 1, satisfied: false },
        tests: { approvals: 0, changeRequests: 0, satisfied: false },
      },
      quorum: { required: 2, distinctReviewers: 1 },
      findings: [{ file: "a.js", line: 4, summary: "x", verdict: "CONFIRMED" }],
    },
  });
  const frame = renderFrame(s, size);
  const text = frame.join("\n");
  assert.match(text, /REVIEW round 2 — blocked/, "the verdict first, before the detail");
  assert.match(text, /corr ok/, "a satisfied dimension says so");
  assert.match(text, /secu 1chg/, "a dimension with a change request shows the count");
  assert.match(text, /test -/, "and one with no approval yet is distinguishable from both");
  assert.match(text, /quorum 1\/2/, "quorum is its own condition, not folded into the dimensions");
  assert.match(text, /1 finding\(s\)/);

  // The redraw contract still holds with the extra rows, and the geometry MOVED — which is what would
  // silently break clicking if `frameGeometry` and `renderFrame` disagreed.
  for (const [i, line] of frame.entries()) assert.equal(line.length, 100, `line ${i} is exactly cols wide`);
  const g = frameGeometry(s, size);
  assert.equal(g.review.height, 2);
  assert.equal(g.paneArea.top, frameGeometry(noReview, size).paneArea.top + 2,
    "the pane area moved down by exactly the bar's height");

  // Verified against the DRAWN frame, the same way case 13 does it: find the row that actually contains the
  // review text and check the hit test lands on it.
  const barRow = frame.findIndex((l) => l.includes("quorum 1/2"));
  assert.ok(barRow > 0, "precondition: the bar is drawn");
  assert.deepEqual(hitTest(s, size, 5, barRow), { kind: "reviewBar" });

  // Clicking it shows the reviewers, because that is what a blocked review makes you want to read next.
  const clicked = applyAction({ ...s, reviewersHidden: true, visibleReviewers: [] }, { type: "click", target: { kind: "reviewBar" } });
  assert.equal(clicked.reviewersHidden, false);
  assert.deepEqual(clicked.visibleReviewers, ["parent"]);
  assert.equal(clicked.focus, FOCUS.PANE);
  assert.equal(clicked.reviewerDefaultFromType, false, "and it counts as asking, like pressing `p` does");

  // An APPROVED review reads differently, which is the whole point of putting the verdict first.
  const approved = renderFrame(demoState({ review: { round: 3, approved: true, dimensions: {}, quorum: { required: 2, distinctReviewers: 2 } } }), size).join("\n");
  assert.match(approved, /REVIEW round 3 — APPROVED/);
});

// ── 20 ───────────────────────────────────────────────────────────────────────────────────
// PLAN.md §5, added 2026-09-11. `t` from anywhere hides the tree; the pane area expands into the
// freed width, and selection state survives — hiding is a view change, not a navigation reset, the
// same distinction section 7 already draws for hiding a team from the top bar.
testCase("t hides/shows the tree from anywhere, and the pane area reclaims its width", () => {
  const size = { cols: 100, rows: 30 };
  const shown = demoState();
  assert.equal(frameGeometry(shown, size).treeWidth > 0, true, "precondition: the tree has real width");

  const hidden = press(shown, "t");
  assert.equal(hidden.treeHidden, true);
  const g = frameGeometry(hidden, size);
  assert.equal(g.treeWidth, 0, "the tree column itself is gone");
  assert.equal(g.paneArea.tree, null, "and there is no tree hit-target to click");
  // Selection survives — this is a view change, not a reset.
  assert.equal(hidden.selectedNodeId, shown.selectedNodeId);
  assert.equal(hidden.treeScroll, shown.treeScroll);

  const frame = renderFrame(hidden, size);
  for (const [i, line] of frame.entries()) assert.equal(line.length, 100, `line ${i} is still exactly cols wide`);
  // The task TITLE is tree-only content (a pane's own header looks like "purus (coder)", which would
  // still legitimately contain a worker's name even with the tree gone — the title is the thing that
  // can only come from `renderTree`).
  assert.equal(frame.join("\n").includes("Invert the tweak"), false, "the tree's own content is gone from the frame");

  // `t` again restores it, from a focus other than tree (proving it really is "from anywhere").
  const restored = press({ ...hidden, focus: FOCUS.PANE }, "t");
  assert.equal(restored.treeHidden, false);
  assert.equal(frameGeometry(restored, size).treeWidth, frameGeometry(shown, size).treeWidth);
});

// ── 21 ───────────────────────────────────────────────────────────────────────────────────
// PLAN.md §14.4 correction 2, added 2026-09-11. Unlike `h` (which only hides while the panel is
// focused), `R` toggles regardless of focus AND regardless of pending count, and a new request landing
// while manually hidden still auto-reappears — that rule (`withRequests`) is unchanged by this.
testCase("R toggles the Requests panel from anywhere, regardless of pending count", () => {
  const size = { cols: 100, rows: 30 };
  const req = { id: "r1", from: "nj", channel: "#chan", text: "short one" };
  const withOne = withRequests(demoState(), [req]);
  assert.ok(requestsPanelHeight(withOne, size.rows) > 0, "precondition: the panel is showing");

  // `R` works from TREE focus, not just from inside the panel — the actual point of this key existing
  // (the `h`-while-focused path already covers the focused case).
  const hidden = press(withOne, "R");
  assert.equal(hidden.requestsHidden, true);
  assert.equal(requestsPanelHeight(hidden, size.rows), 0);

  const shown = press(hidden, "R");
  assert.equal(shown.requestsHidden, false);
  assert.ok(requestsPanelHeight(shown, size.rows) > 0, "R toggles back on, unlike h which only ever hides");

  // `withRequests`'s existing empty-list rule (case 15) is unaffected by this new toggle — it is what
  // actually prevents a manual hide from swallowing every future request: the list has to pass through
  // EMPTY (everything resolved) before the "unhide" branch fires, so a batch resolving and a fresh one
  // landing later still surfaces.
  const stillHidden = press(withOne, "R");
  const wentEmpty = withRequests(stillHidden, []);
  assert.equal(wentEmpty.requestsHidden, false, "the list going empty clears the manual hide (case 15's rule, still intact)");
  const withNew = withRequests(wentEmpty, [{ id: "r2", from: "asha", text: "another one" }]);
  assert.equal(withNew.requestsHidden, false, "and a fresh request after that stays visible");
});

// ── 22 ───────────────────────────────────────────────────────────────────────────────────
// PLAN.md §14.4 correction 3 / FLOWS §6c, added 2026-09-11. A request too long to fit inline expands to
// a full-width detail view that REPLACES the tree + pane area; a short one does not (case 13 already
// covers that half). The round trip restores the layout exactly, because nothing but `focus` changes.
testCase("a long request expands to the Request Detail view, and closing it restores the layout exactly", () => {
  const size = { cols: 100, rows: 30 };
  // "payment webhook" is placed well past the panel's truncation width (~96 chars at cols=100) on
  // purpose — this fixture only proves the expand-on-click behaviour if the inline row genuinely
  // cannot show that phrase.
  const longText = "please review this before standup, there is quite a lot of context to give here about why this one is not a simple lint fix, it touches the payment webhook so please take a careful look and there is also a flaky test in the same file";
  const req = { id: "r1", from: "nj", channel: "#your-mr-channel", text: longText };
  const before = withRequests(demoState(), [req]);
  const beforeFrame = renderFrame(before, size).join("\n");
  assert.equal(beforeFrame.includes("payment webhook"), false, "too long to fit inline — it must be truncated, not wrapped, in the small panel");

  // Click resolves as NOT fitting, and that's what state.js keys the expand decision on.
  const g = frameGeometry(before, size);
  const reqRow = g.requests.top + 2; // header rule + button row, first request line
  const hit = hitTest(before, size, 5, reqRow);
  assert.equal(hit.kind, "requests");
  assert.equal(hit.fits, false, "precondition: this request does not fit inline");

  const expanded = applyAction(before, { type: "click", target: hit });
  assert.equal(expanded.focus, FOCUS.REQUEST_DETAIL);
  assert.equal(expanded.selectedRequestId, "r1");

  const detailFrame = renderFrame(expanded, size);
  for (const [i, line] of detailFrame.entries()) assert.equal(line.length, 100, `line ${i} is exactly cols wide`);
  const joined = detailFrame.join("\n");
  assert.match(joined, /REQUEST DETAIL/);
  assert.match(joined, /payment webhook/, "the FULL text is shown, not truncated");
  assert.match(joined, /\[a\] Accept\s+\[d\] Decline/);
  // Tree + pane area are genuinely gone, not just visually similar — no worker names, no dev pane header.
  assert.equal(joined.includes("purus"), false);

  // `return` on a selected (but not yet expanded) request does the same thing as the click.
  const viaReturn = press({ ...before, focus: FOCUS.REQUESTS, selectedRequestId: "r1" }, "return");
  assert.equal(viaReturn.focus, FOCUS.REQUEST_DETAIL);

  // `esc` restores the layout EXACTLY — nothing else was touched, so this is the whole test.
  const closed = press(expanded, "escape");
  assert.equal(closed.focus, FOCUS.REQUESTS);
  assert.deepEqual({ ...closed, focus: null }, { ...before, focus: null },
    "closing the detail view must restore every other field untouched");

  // Accept/Decline hand off to app.js (PLAN.md §16.2's own pattern for `pendingChat`) and also close it.
  const accepted = press(expanded, "a");
  assert.deepEqual(accepted.pendingRequestDecision, { requestId: "r1", decision: "accept" });
  assert.equal(accepted.focus, FOCUS.REQUESTS);
  const declined = press(expanded, "d");
  assert.deepEqual(declined.pendingRequestDecision, { requestId: "r1", decision: "decline" });
});

// review-sol-2026-09-13.md finding 17: an external request's text used to be written into the Request
// Detail view with no escaping — ESC/OSC/CR/BEL bytes could clear/reposition the terminal or spoof its
// own controls. `renderRequestsPanel`'s compact line happened to be safe only because it wraps text in
// JSON.stringify for unrelated cosmetic reasons; the detail view had no such accident protecting it.
testCase("a request's ESC/OSC/CR/BEL bytes never reach the rendered frame raw, in either the compact panel or the detail view", () => {
  const size = { cols: 100, rows: 30 };
  const dangerous = "before\x1b[2J\x1b]0;pwned\x07mid\rafter\x1b[31mred";
  const req = { id: "r-danger", from: "attacker\x1b[2J", channel: "#c", text: dangerous };
  const state = withRequests(demoState(), [req]);

  const compactFrame = renderFrame(state, size).join("\n");
  assert.equal(compactFrame.includes("\x1b"), false, "no raw ESC byte in the compact panel's rendered frame");
  assert.equal(compactFrame.includes("\x07"), false, "no raw BEL byte in the compact panel's rendered frame");

  const expanded = applyAction(state, {
    type: "click",
    target: { kind: "requests", requestId: "r-danger", fits: false },
  });
  const detailFrame = renderFrame(expanded, size).join("\n");
  assert.equal(detailFrame.includes("\x1b"), false, "no raw ESC byte anywhere in the rendered Request Detail frame");
  assert.equal(detailFrame.includes("\x07"), false, "no raw BEL byte anywhere in the rendered Request Detail frame");
  assert.equal(detailFrame.includes("\r"), false, "no raw CR byte anywhere in the rendered Request Detail frame");
  assert.match(detailFrame, /before/, "the surrounding legitimate text must still render");
  assert.match(detailFrame, /mid/);
  assert.match(detailFrame, /after/);
});

// review-sol-2026-09-13.md finding 18: if the request open in the DETAIL view disappears while
// others remain, `withRequests` used to retarget `selectedRequestId` to whatever request happened to
// be first while leaving `focus` at REQUEST_DETAIL — so the screen silently started showing a
// DIFFERENT request's content than the one the operator opened, and the next Accept/Decline would act
// on it. Detail view must close back to the list instead.
testCase("withRequests closes the Request Detail view (rather than silently swapping its content) when the open request disappears", () => {
  const two = withRequests(demoState(), [{ id: "r1", text: "one" }, { id: "r2", text: "two" }]);
  const openedR2 = applyAction(two, {
    type: "click",
    target: { kind: "requests", requestId: "r2", fits: false },
  });
  assert.equal(openedR2.focus, FOCUS.REQUEST_DETAIL);
  assert.equal(openedR2.selectedRequestId, "r2");

  // r2 (the OPEN one) disappears; r1 and a new r3 remain — a real batch update, not just an empty list.
  const afterUpdate = withRequests(openedR2, [{ id: "r1", text: "one" }, { id: "r3", text: "three" }]);
  assert.notEqual(afterUpdate.focus, FOCUS.REQUEST_DETAIL, "the detail view must close, not silently show a different request");
  assert.equal(afterUpdate.focus, FOCUS.REQUESTS, "control returns to the requests list");
  assert.notEqual(afterUpdate.selectedRequestId, "r2", "the vanished id must not still be selected");
});

// review-sol-2026-09-13.md finding 48: the Request Detail view read `postedAt`/`at`, but the runtime
// projection (`pendingRequests()` in supervisor.js) only ever supplies `createdAt` — so a real request's
// timestamp never rendered at all.
testCase("Request Detail renders a request's createdAt timestamp (the field the runtime projection actually supplies)", () => {
  const size = { cols: 100, rows: 30 };
  const req = { id: "r-ts", from: "nj", channel: "#c", text: "hello", createdAt: "2026-09-13T12:00:00.000Z" };
  const state = withRequests(demoState(), [req]);
  const expanded = applyAction(state, { type: "click", target: { kind: "requests", requestId: "r-ts", fits: false } });
  const frame = renderFrame(expanded, size).join("\n");
  assert.match(frame, /2026-09-13T12:00:00\.000Z/, "the request's real createdAt must appear in the detail view");
});

// review-sol-2026-09-13.md finding 27: `requestUp`/`requestDown` move `selectedRequestId` but never
// touched `requestScroll` — pressing down repeatedly could select a request several rows below the
// visible window, with `return` then opening whatever request the operator could not actually see.
testCase("requestUp/requestDown keep the selected request within the visible window, in both render and hitTest", () => {
  const size = { cols: 100, rows: 30 };
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, from: "nj", text: `request ${i}` }));
  let s = withRequests(demoState(), many);
  s = applyAction(s, { type: "click", target: { kind: "requests", requestId: "r0" } });
  assert.equal(s.focus, FOCUS.REQUESTS);

  // A small panel: requestsPanelHeight forces a short height here via a tiny fraction override, so the
  // visible room is far smaller than 10 requests — room is what forces the scroll question at all.
  s = { ...s, requestsHeightFraction: 0.001 };
  const height = requestsPanelHeight(s, size.rows);
  assert.ok(height > 0 && height < 6, `precondition: the panel must be small enough that not all 10 requests fit; got height=${height}`);

  // Press down enough times to select a request well past the initial visible window.
  for (let i = 0; i < 7; i += 1) s = applyAction(s, { type: "requestDown" });
  assert.equal(s.selectedRequestId, "r7");

  const rendered = renderRequestsPanel(s, size.cols, height).join("\n");
  assert.match(rendered, /request 7/, `the selected request must actually be rendered in the visible window; got:\n${rendered}`);

  // hitTest must agree with what was actually drawn — clicking the row where the selection now shows
  // must resolve to "r7", not to whatever a stale, unclamped scroll would have pointed at.
  const g = frameGeometry(s, size);
  const bodyTop = g.requests.top + (g.requests.height - 1 >= 2 ? 2 : 1);
  const hit = hitTest(s, size, 5, bodyTop);
  assert.equal(hit.requestId, "r7", `hitTest must resolve the same row renderRequestsPanel actually drew there; got ${JSON.stringify(hit)}`);
});

// review-sol-2026-09-13.md finding 25: a single token wider than the viewport used to become one
// unsplit "line" that `row()`'s own `fit()` then silently truncated with an ellipsis — the rest of a
// long URL/hash/stack-trace line was gone with no indication, right before an Accept/Decline decision.
testCase("Request Detail hard-splits a single token wider than the viewport, rather than silently truncating it", () => {
  const size = { cols: MIN_COLS, rows: 30 };
  const longToken = "x".repeat(200); // far wider than any plausible column count
  const req = { id: "r-long-token", from: "nj", text: `see ${longToken} for details` };
  const state = withRequests(demoState(), [req]);
  const expanded = applyAction(state, { type: "click", target: { kind: "requests", requestId: "r-long-token", fits: false } });
  const frame = renderFrame(expanded, size).join("\n");
  // If the token were still unsplit, `x`.repeat(200) would appear as one run far longer than any single
  // rendered line (36 visible chars at cols=40) — so finding it split across lines means every
  // individual line-length invariant already enforced elsewhere held AND the full token is present.
  const totalXs = (frame.match(/x/g) ?? []).length;
  assert.equal(totalXs, 200, `the full long token must still be present somewhere in the frame (split across lines), got ${totalXs} of 200 x's`);
  for (const line of frame.split("\n")) assert.ok(line.length <= size.cols, `every rendered line must stay within cols; got length ${line.length}: ${JSON.stringify(line)}`);
});

testCase("Request Detail shows an explicit continuation indicator rather than silently dropping lines past the viewport", () => {
  const size = { cols: 100, rows: MIN_ROWS }; // deliberately at the minimum, so a long message overflows the body budget
  const longText = Array.from({ length: 50 }, (_, i) => `sentence number ${i} in a very long message`).join(". ");
  const req = { id: "r-tall", from: "nj", text: longText };
  const state = withRequests(demoState(), [req]);
  const expanded = applyAction(state, { type: "click", target: { kind: "requests", requestId: "r-tall", fits: false } });
  const frame = renderFrame(expanded, size).join("\n");
  assert.match(frame, /more line\(s\) not shown/, `an overflowing message must show an explicit continuation indicator, not silently drop lines; got:\n${frame}`);
});

// review-sol-2026-09-13.md finding 26: closing the Request Detail view used to route focus to REQUESTS
// unconditionally — but the panel could have been hidden (`R`) WHILE detail was open, since
// `toggleRequestsHidden` only redirects focus away from REQUESTS when focus was ALREADY there at the
// moment of hiding. Escape then left focus on a panel that isn't drawn at all.
testCase("closing Request Detail routes focus to TREE (not the hidden REQUESTS panel) if the panel was hidden while detail was open", () => {
  const two = withRequests(demoState(), [{ id: "r1", text: "one" }, { id: "r2", text: "two" }]);
  const opened = applyAction(two, { type: "click", target: { kind: "requests", requestId: "r1", fits: false } });
  assert.equal(opened.focus, FOCUS.REQUEST_DETAIL);

  const hiddenWhileOpen = press(opened, "R");
  assert.equal(hiddenWhileOpen.requestsHidden, true, "R must hide the panel even while detail view has focus");
  assert.equal(hiddenWhileOpen.focus, FOCUS.REQUEST_DETAIL, "hiding must not itself close the detail view");

  const closed = press(hiddenWhileOpen, "escape");
  assert.notEqual(closed.focus, FOCUS.REQUESTS, "closing detail must not land focus on a panel that is hidden and therefore not drawn");
  assert.equal(closed.focus, FOCUS.TREE);
});

// review-sol-2026-09-13.md finding 29: `fit()` used `.length` — UTF-16 code units — for both the
// "does it fit" check and the truncation point, so wide characters (CJK, most emoji) could overflow
// past the intended column budget, or get cut at a point that doesn't match the actual visible width.
testCase("fit() measures and pads/truncates by terminal CELL width, not UTF-16 code-unit length", () => {
  // A CJK string: 5 characters, each 1 UTF-16 code unit but 2 terminal cells — 10 cells total, NOT 5.
  const cjk = "日本語text!"; // 3 wide (6 cells) + "text!" (5 cells) = 11 cells, 8 code units
  assert.equal(cellWidth(cjk), 11);
  const padded = fit(cjk, 15);
  assert.equal(cellWidth(padded), 15, "fit() must pad to the exact CELL width requested, not code-unit length");

  // A string wider (in cells) than the target width must truncate SHORT ENOUGH that cell width + the
  // ellipsis fits exactly — using code-unit length here would keep too many wide characters and overflow.
  const long = "日".repeat(10); // 10 characters, 20 cells
  const truncated = fit(long, 10);
  assert.equal(cellWidth(truncated), 10, `truncated output must be exactly 10 CELLS wide, not 10 code units; got cellWidth=${cellWidth(truncated)} for ${JSON.stringify(truncated)}`);
  assert.ok(truncated.includes("…"), "truncation must still be visible");

  // A combining mark occupies 0 cells of its own — must not be counted as a full column.
  const combining = "ééé"; // "é" written as e + combining acute, 3 times: 3 cells, 6 code units
  assert.equal(cellWidth(combining), 3);
});

if (failed > 0) {
  console.error(`\n${failed} TUI case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: tui layout + focus model");
