// state.js — the TUI's focus model and keybindings, as PURE functions (Phase 4; FLOWS.md section 5).
//
// Two functions, both pure: `keyToAction(key, state)` and `applyAction(state, action)`. Splitting them
// is what makes the keybinding table testable as a table — "when you press this and the situation is
// this, it does this" is FLOWS §5's own framing, and it maps one-to-one onto
// `keyToAction` (situation -> action) and `applyAction` (action -> new state).
//
// WHY KEYS ARE SCOPED BY FOCUS RATHER THAN GLOBAL
//
// FLOWS §5 opens with "all keybindings act on the currently focused pane context, not globally", and
// then relies on it: `h` moves across the team bar, and `h` also hides the Requests panel when that
// panel is focused. Those are the same key doing different things by focus — which is a collision if
// keys are global and is not a collision if they are not. So focus is a first-class field and every
// binding is looked up under it.
//
// The chat bar is the sharpest case: while focus is `chat`, letters must be TEXT. A TUI where typing
// "help" into a chat box toggles fullscreen, hides reviewers, and quits is not a chat box.

export const FOCUS = { TREE: "tree", PANE: "pane", CHAT: "chat", REQUESTS: "requests" };

/** A fresh state. Everything the layout reads has a defined value here — no `undefined` in render. */
export function initialState(overrides = {}) {
  return {
    teams: [],
    tasks: [],
    workers: [],
    panes: [],
    activeTeamIndex: 0,
    selectedNodeId: null,
    treeScroll: 0,
    focus: FOCUS.TREE,
    focusedPane: 0,
    fullscreen: false,
    // Which reviewer slots are shown, and the memory `r` restores. FLOWS §5: pressing `r` again
    // "restores last-shown reviewer pane state", so hiding must not be lossy.
    visibleReviewers: ["parent"],
    reviewersHidden: false,
    lastVisibleReviewers: ["parent"],
    // FLOWS §5's smart default BY TASK TYPE: a dev task shows the last-active dev run alone, a review task
    // shows the dev pane plus one reviewer. `reviewerDefaultFromType` is what makes that a default rather
    // than a policy — the first explicit reviewer toggle (`1`, `2`, `p`, `r`) clears it, and from then on
    // the user's choice wins. Without the flag there is no way to tell "reviewers are showing because this
    // is a review task" from "reviewers are showing because someone asked for them".
    paneLayout: "dev",
    reviewerDefaultFromType: true,
    // The selected task's review status (PLAN.md §13), or null when no review is in flight. Set from the
    // snapshot rather than derived here: the rule lives in `domain/review.js` and a second, UI-local
    // evaluation of it is how a dashboard comes to disagree with the system it is displaying.
    review: null,
    pinnedWorkerId: null,
    chatTarget: "cto",
    chatTargetName: null,
    chatInput: "",
    // The Requests panel (FLOWS §6a). Absent until a request lands, hideable with `h` while focused,
    // and re-shown by a new request — `requestsHidden` is deliberately cleared when the list empties so
    // that hiding one batch does not silently hide the next.
    requests: [],
    requestsHidden: false,
    selectedRequestId: null,
    requestScroll: 0,
    status: null,
    quit: false,
    ...overrides,
  };
}

/**
 * A keypress plus the current situation -> an action, or null for "not bound here".
 *
 * Returning null rather than a no-op action matters for the chat case: `app.js` needs to tell "this
 * key means nothing" from "this key is text", and a swallowed keystroke in a text field is a bug a
 * user notices immediately.
 */
export function keyToAction(key, state) {
  // ── chat focus: text first, and only the two keys that can leave ──────────────────────
  if (state.focus === FOCUS.CHAT) {
    if (key === "escape") return { type: "blurChat" };
    if (key === "return") return { type: "submitChat" };
    if (key === "backspace") return { type: "chatBackspace" };
    // Deliberately BEFORE the global bindings below. Every printable character is text here.
    if (typeof key === "string" && key.length === 1 && key >= " ") return { type: "chatInsert", char: key };
    return null;
  }

  // ── requests focus: `h` HIDES the panel here, and moves teams everywhere else ─────────
  //
  // This is the collision FLOWS §5 opens by ruling out ("all keybindings act on the currently focused
  // pane context, not globally"), and it is the reason focus is a field rather than a mode flag. Same
  // key, two meanings, no ambiguity — because the lookup is scoped.
  if (state.focus === FOCUS.REQUESTS) {
    if (key === "h" || key === "escape") return { type: "hideRequests" };
    if (key === "up" || key === "k") return { type: "requestUp" };
    if (key === "down" || key === "j") return { type: "requestDown" };
    if (key === "tab" || key === "return") return { type: "blurRequests" };
    // Everything else falls through to the global table on purpose: `/`, `q` and the pane toggles are
    // still the right thing to do from here, and swallowing them would make the panel a trap.
  }

  switch (key) {
    case "/": return { type: "focusChat" };
    case "q": return { type: "quit" };
    case "h": case "left": return { type: "prevTeam" };
    case "l": case "right": return { type: "nextTeam" };
    case "up": case "k": return { type: "treeUp" };
    case "down": case "j": return { type: "treeDown" };
    case "return": return { type: "openSelected" };
    case "tab": return { type: "cyclePane" };
    case "1": return { type: "toggleReviewer", slot: "rev1" };
    case "2": return { type: "toggleReviewer", slot: "rev2" };
    case "p": return { type: "toggleReviewer", slot: "parent" };
    case "r": return { type: "toggleAllReviewers" };
    case "f": return { type: "toggleFullscreen" };
    case "g": return { type: "toggleGrouped" };
    case "m": return { type: "pinSelected" };
    case "d": return { type: "toggleChatTarget" };
    default: return null;
  }
}

/** Every visible tree row, in order. The tree's navigation model, shared with the layout. */
export function treeRows(state) {
  const team = (state.teams ?? [])[state.activeTeamIndex];
  const rows = [];
  for (const task of (state.tasks ?? []).filter((t) => !team || t.teamId === team.id)) {
    rows.push({ kind: "task", id: task.id });
    for (const w of (state.workers ?? []).filter((x) => x.taskId === task.id)) {
      rows.push({ kind: "worker", id: w.workerId });
    }
  }
  return rows;
}

/**
 * Apply an action. Returns a NEW state; never mutates.
 *
 * Immutability is not ceremony here: the render loop compares frames to decide whether to redraw, and
 * a mutated-in-place state makes "did anything change" unanswerable.
 */
export function applyAction(state, action) {
  if (!action) return state;
  const s = { ...state };

  switch (action.type) {
    case "quit":
      s.quit = true;
      return s;

    case "focusChat":
      s.focus = FOCUS.CHAT;
      return s;

    case "blurChat":
      s.focus = FOCUS.TREE;
      return s;

    case "chatInsert":
      s.chatInput = `${s.chatInput ?? ""}${action.char}`;
      return s;

    case "chatBackspace":
      s.chatInput = (s.chatInput ?? "").slice(0, -1);
      return s;

    case "submitChat":
      // The text is handed to `app.js` as `pendingChat` rather than acted on here: this file is pure,
      // and sending a message is I/O. Keeping the split honest is what lets the whole keybinding table
      // be tested without a socket.
      s.pendingChat = { target: s.chatTarget, targetName: s.chatTargetName, text: s.chatInput ?? "" };
      s.chatInput = "";
      return s;

    case "prevTeam":
    case "nextTeam": {
      const teams = (s.teams ?? []).filter((t) => !t.hiddenFromTopBar);
      if (!teams.length) return s;
      const delta = action.type === "nextTeam" ? 1 : -1;
      // Clamped, not wrapped: wrapping past the end of a team bar reads as a glitch rather than as
      // navigation, especially when the bar is windowed and the jump is off-screen.
      s.activeTeamIndex = Math.max(0, Math.min(teams.length - 1, (s.activeTeamIndex ?? 0) + delta));
      // Switching team invalidates a selection that belonged to the old one.
      s.selectedNodeId = null;
      s.treeScroll = 0;
      return s;
    }

    case "treeUp":
    case "treeDown": {
      const rows = treeRows(s);
      if (!rows.length) return s;
      const current = rows.findIndex((r) => r.id === s.selectedNodeId);
      const next = action.type === "treeDown"
        ? Math.min(rows.length - 1, current + 1)
        : Math.max(0, (current === -1 ? 0 : current) - 1);
      s.selectedNodeId = rows[next].id;
      s.focus = FOCUS.TREE;
      return s;
    }

    case "openSelected":
      // Selection and focus are separate: moving the cursor in the tree must not steal focus from a
      // pane you are reading, and opening must.
      s.focus = FOCUS.PANE;
      s.openedNodeId = s.selectedNodeId;
      return s;

    case "cyclePane": {
      const count = Math.max(1, (s.panes ?? []).length);
      s.focusedPane = ((s.focusedPane ?? 0) + 1) % count;
      s.focus = FOCUS.PANE;
      return s;
    }

    case "toggleReviewer": {
      // An explicit toggle ends the type-driven default, for this session — see `reviewerDefaultFromType`.
      s.reviewerDefaultFromType = false;
      const shown = new Set(s.visibleReviewers ?? []);
      if (shown.has(action.slot)) shown.delete(action.slot); else shown.add(action.slot);
      s.visibleReviewers = [...shown];
      // Toggling an individual slot ON is an implicit un-hide: otherwise `r` then `1` would appear to
      // do nothing, which is the kind of dead keypress that makes a UI feel broken.
      if (s.visibleReviewers.length) { s.reviewersHidden = false; s.lastVisibleReviewers = s.visibleReviewers; }
      else s.reviewersHidden = true;
      return s;
    }

    case "toggleAllReviewers":
      s.reviewerDefaultFromType = false;
      if (s.reviewersHidden) {
        // Restore what was shown, not a default. FLOWS §5 is explicit that `r` again restores the
        // LAST-SHOWN state, so this must remember rather than reset.
        s.reviewersHidden = false;
        s.visibleReviewers = (s.lastVisibleReviewers ?? []).length ? [...s.lastVisibleReviewers] : ["parent"];
      } else {
        s.lastVisibleReviewers = [...(s.visibleReviewers ?? [])];
        s.reviewersHidden = true;
      }
      return s;

    case "toggleFullscreen":
      s.fullscreen = !s.fullscreen;
      return s;

    case "toggleGrouped":
      s.grouped = !s.grouped;
      return s;

    case "pinSelected": {
      const isWorker = treeRows(s).some((r) => r.kind === "worker" && r.id === s.selectedNodeId);
      if (!isWorker) { s.status = "pin (m) applies to a worker — select one in the tree"; return s; }
      // Toggling: a pin you cannot remove is a trap, and FLOWS §5 describes the default as "until
      // unpinned".
      s.pinnedWorkerId = s.pinnedWorkerId === s.selectedNodeId ? null : s.selectedNodeId;
      s.status = s.pinnedWorkerId ? `pinned ${s.pinnedWorkerId}` : "unpinned";
      return s;
    }

    case "toggleChatTarget": {
      if (s.chatTarget !== "cto") { s.chatTarget = "cto"; s.chatTargetName = null; return s; }
      const worker = (s.workers ?? []).find((w) => w.workerId === s.selectedNodeId);
      if (!worker) { s.status = "direct chat (d) needs a worker selected in the tree"; return s; }
      s.chatTarget = worker.workerId;
      s.chatTargetName = worker.nickname;
      return s;
    }

    // ── the mouse (FLOWS §5's click rows) ───────────────────────────────────────────────
    //
    // A click is one action carrying a TARGET that `layout.hitTest` resolved, so this file still owns
    // what a click means while knowing nothing about rows and columns. The four targets are exactly the
    // ones FLOWS lists; anything else is dead space and does nothing, deliberately — a click that falls
    // through to a default is how a UI ends up switching panes because someone clicked a border.
    case "click": {
      const t = action.target;
      // `state`, not `s`: returning the ORIGINAL object is what makes "this click changed nothing" visible
      // to `app.js`, which repaints only when the state object actually changed. A copy would repaint the
      // screen every time someone clicked a border.
      if (!t) return state;
      if (t.kind === "team") {
        const teams = (s.teams ?? []).filter((x) => !x.hiddenFromTopBar);
        if (!teams.length) return s;
        s.activeTeamIndex = Math.max(0, Math.min(teams.length - 1, t.index));
        // Same invalidation as `prevTeam`/`nextTeam`: a selection that belonged to the old team would
        // make the tree and the panes disagree, which is the demo's §28 defect in another costume.
        s.selectedNodeId = null;
        s.treeScroll = 0;
        s.focus = FOCUS.TREE;
        return s;
      }
      if (t.kind === "treeRow") {
        s.selectedNodeId = t.id;
        // FLOWS: clicking a worker "opens that worker's pane directly, full focus"; clicking a task node
        // shows that task's panes. Both open — a click is an explicit act, unlike moving the cursor.
        s.focus = FOCUS.PANE;
        s.openedNodeId = t.id;
        s.focusedPane = 0;
        return s;
      }
      if (t.kind === "pane") {
        s.focusedPane = t.index;
        s.focus = FOCUS.PANE;
        return s;
      }
      if (t.kind === "requests") {
        s.focus = FOCUS.REQUESTS;
        if (t.requestId) s.selectedRequestId = t.requestId;
        s.status = "requests panel focused — h hides it";
        return s;
      }
      if (t.kind === "reviewBar") {
        // Show the reviewers and focus one — the review bar says a review is blocked, and the next thing
        // anyone wants is the reviewer's own pane. An explicit toggle, so it also ends the type-driven
        // default the same way pressing `p` would.
        s.reviewerDefaultFromType = false;
        if (!s.visibleReviewers?.length) s.visibleReviewers = ["parent"];
        s.reviewersHidden = false;
        s.focus = FOCUS.PANE;
        s.focusedPane = Math.min(1, Math.max(0, (s.panes ?? []).length - 1));
        return s;
      }
      if (t.kind === "chat") { s.focus = FOCUS.CHAT; return s; }
      return state; // the footer and every other target: drawn, not clickable
    }

    case "hideRequests":
      s.requestsHidden = true;
      s.focus = FOCUS.TREE;
      s.status = "requests panel hidden — it returns when a new request lands";
      return s;

    case "blurRequests":
      s.focus = FOCUS.TREE;
      return s;

    case "requestUp":
    case "requestDown": {
      const list = s.requests ?? [];
      if (!list.length) return s;
      const at = Math.max(0, list.findIndex((r) => r.id === s.selectedRequestId));
      const next = action.type === "requestDown" ? Math.min(list.length - 1, at + 1) : Math.max(0, at - 1);
      s.selectedRequestId = list[next].id;
      return s;
    }

    default:
      return s;
  }
}

/**
 * Fold a fresh list of pending requests into the state.
 *
 * Pure, and separate from `refresh()` in `app.js`, because it carries two decisions that are easy to get
 * wrong and worth asserting:
 *
 *   * **An empty list un-hides the panel.** `h` hides the requests you have seen, not the panel forever.
 *     Without this, hiding one batch would silently swallow every future request — FLOWS §6a says the
 *     panel "appears the moment one lands", and a permanent hide would make that false.
 *   * **A selection that no longer exists is dropped.** A request that was accepted elsewhere must not
 *     leave the cursor pointing at a row that is gone.
 */
export function withRequests(state, requests = []) {
  const s = { ...state, requests };
  if (!requests.length) {
    s.requestsHidden = false;
    s.selectedRequestId = null;
    s.requestScroll = 0;
    // Nothing to focus. Leaving focus here would make every keypress hit the requests table above.
    if (s.focus === FOCUS.REQUESTS) s.focus = FOCUS.TREE;
    return s;
  }
  if (!requests.some((r) => r.id === s.selectedRequestId)) s.selectedRequestId = requests[0].id;
  return s;
}

/** Convenience for tests and for `app.js`: one keypress, start to finish. */
export function press(state, key) {
  return applyAction(state, keyToAction(key, state));
}
