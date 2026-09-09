// layout.js — the TUI's rendering, as a PURE function (Phase 4; FLOWS.md sections 5 and 6).
//
// THE ONE DESIGN DECISION EVERYTHING ELSE FOLLOWS: `renderFrame(state, size)` takes a plain object
// and returns an array of strings. It touches no terminal, no socket and no clock.
//
// That is not stylistic. A TUI whose output can only be checked by looking at it is a TUI nobody can
// regression-test, and this project's entire method is "assert the mechanism". With rendering pure,
// "the dev pane expands when all reviewer panes are hidden" and "a crashed pane says so" are ordinary
// unit assertions on strings — no pty, no screenshots, no human in the loop. `app.js` does the I/O
// and knows nothing about layout; this file knows nothing about I/O.
//
// EVERY LINE IS EXACTLY `cols` WIDE. Padded and truncated, always. A terminal redraw that leaves a
// line shorter than the last frame leaves the previous frame's characters on screen, and the bug looks
// like corrupted state rather than a missing space. Enforced here and asserted in the tests.
//
// THE TREE IS TASK-NODE, NOT MEMBER-NODE — PLAN.md section 5's cardinality fix. Workers hang off
// tasks, because a worker without a task is not a thing the dashboard shows and one task genuinely has
// several workers. A member-node tree would have to invent a parent for each worker.

/** Box-drawing, kept in one place so a future ASCII-only mode is one constant away. */
const B = { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘", lt: "├", rt: "┤", tt: "┬", bt: "┴", x: "┼" };

export const MIN_COLS = 60;
export const MIN_ROWS = 16;

/** Truncate with an ellipsis so a long title degrades legibly instead of breaking the frame. */
export function fit(text, width) {
  const s = String(text ?? "");
  if (width <= 0) return "";
  if (s.length <= width) return s + " ".repeat(width - s.length);
  if (width === 1) return "…";
  return `${s.slice(0, width - 1)}…`;
}

/** A framed row: `│ content │`, content fitted to the inner width. */
const row = (content, cols) => `${B.v}${fit(content, cols - 2)}${B.v}`;

/** A horizontal rule with an optional inline label: `┌─ TEAMS ────┐`. */
function rule(cols, { left = B.tl, right = B.tr, label = null } = {}) {
  const inner = cols - 2;
  if (!label) return `${left}${B.h.repeat(inner)}${right}`;
  // TRUNCATED to fit, because a label is now allowed to be arbitrary text: the footer's rule carries
  // `state.status`, and "supervisor unreachable: connect ENOENT /long/path/control.sock" is longer than a
  // narrow terminal. Without this the line comes back wider than `cols`, which breaks the redraw contract
  // every other line obeys — and it would break it only when something had already gone wrong.
  const tag = ` ${fit(label, Math.max(0, inner - 3)).trimEnd()} `;
  const dashes = Math.max(0, inner - tag.length - 1);
  return `${left}${B.h}${tag}${B.h.repeat(dashes)}${right}`;
}

/**
 * The team bar. Shows overflow explicitly rather than silently dropping teams.
 *
 * A bar that quietly hid a team would make "my team is gone" a support question; `<-`/`->` markers
 * make it a keypress. Hidden teams (`hiddenFromTopBar`) are a view filter, not a deletion (FLOWS §5).
 */
/**
 * The team bar's chips AND where each one sits on the line.
 *
 * Split out from rendering because a click on a team has to hit the same rectangle the chip was drawn
 * in. Two copies of this windowing arithmetic — one to draw, one to hit-test — would drift the first
 * time either changed, and the symptom would be "clicking a team selects the one next to it", which
 * looks like a mouse bug rather than a duplicated calculation.
 */
export function teamBarChips(state, cols) {
  const teams = (state.teams ?? []).filter((t) => !t.hiddenFromTopBar);
  if (!teams.length) return { shown: [], start: 0, total: 0, more: "    " };

  const inner = cols - 2;
  const chips = teams.map((t, i) => ({
    index: i,
    id: t.id,
    text: i === state.activeTeamIndex ? `[${t.name}]` : ` ${t.name} `,
  }));
  // Window the chips around the active one so the selection is always visible.
  let start = 0;
  let width = 0;
  for (let i = 0; i < chips.length; i += 1) {
    width += chips[i].text.length + 1;
    if (width > inner - 8 && i <= state.activeTeamIndex) { start = i; width = chips[i].text.length + 1; }
  }
  const shown = [];
  let used = 0;
  for (let i = start; i < chips.length; i += 1) {
    if (used + chips[i].text.length + 1 > inner - 8) break;
    // `col` is the 0-based column of the chip's first character within the whole frame: 1 for the
    // border, 1 for the leading space `renderTeamBar` prints, then everything drawn before it.
    shown.push({ ...chips[i], col: 2 + used, width: chips[i].text.length });
    used += chips[i].text.length + 1;
  }
  const more = [start > 0 ? "<-" : "  ", start + shown.length < chips.length ? "->" : "  "].join("");
  return { shown, start, total: chips.length, more };
}

export function renderTeamBar(state, cols) {
  const lines = [rule(cols, { label: "TEAMS" })];
  const { shown, more } = teamBarChips(state, cols);
  if (!shown.length) return [...lines, row("  (no teams yet — ask the CTO to create one)", cols)];
  const inner = cols - 2;
  lines.push(row(` ${shown.map((c) => c.text).join(" ")}`.padEnd(inner - 5) + more, cols));
  return lines;
}

/** The Requests panel's button row (FLOWS §6a). Rendered, not wired — see `requestsPanelHeight`. */
const REQUEST_BUTTONS = "[Accepted] [Declined] [Completed] [Team Requests]";

/**
 * How tall the Requests panel is, or 0 for "not shown".
 *
 * FLOWS §6a: "collapsed by default when there are zero pending requests; appears the moment one lands",
 * and its height is "configurable, default ~12%". Both are load-bearing — a panel that occupied 12% of
 * the screen to say "nothing pending" would be the most expensive empty box in the UI, and this is the
 * one thing on screen whose whole purpose is to be absent most of the time.
 */
export function requestsPanelHeight(state, rows) {
  const requests = state.requests ?? [];
  if (!requests.length || state.requestsHidden) return 0;
  const fraction = typeof state.requestsHeightFraction === "number" ? state.requestsHeightFraction : 0.12;
  const budget = Math.max(3, Math.round(rows * fraction));
  // 1 rule + 1 button row + at least one request; never more than it needs.
  return Math.min(budget, 2 + requests.length);
}

/**
 * The Requests panel itself.
 *
 * The button row is DROPPED rather than the request text when the panel is short — FLOWS §6a says "the
 * button row may collapse to keep the whole panel within its configured height rather than growing the
 * panel". That is the right way round: the buttons are always the same four words, and the message is
 * the thing a human is triaging.
 */
export function renderRequestsPanel(state, cols, height) {
  if (height <= 0) return [];
  const requests = state.requests ?? [];
  const focused = state.focus === "requests";
  const lines = [rule(cols, { left: B.lt, right: B.rt, label: `REQUESTS (${requests.length} pending)` })];
  const body = height - 1;
  const showButtons = body >= 2;
  if (showButtons) lines.push(row(` ${REQUEST_BUTTONS}`, cols));
  const room = height - lines.length;
  for (let i = 0; i < room; i += 1) {
    const r = requests[i + (state.requestScroll ?? 0)];
    if (!r) { lines.push(row("", cols)); continue; }
    const selected = focused && (state.selectedRequestId ?? requests[0]?.id) === r.id;
    const who = r.from ?? r.mentioned ?? "someone";
    const where = r.channel ? ` in ${r.channel}` : "";
    lines.push(row(`${selected ? ">" : " "} @${who}${where}: ${JSON.stringify(r.text ?? "")}`, cols));
  }
  return lines.slice(0, height);
}

/**
 * The review bar: where the selected task's review stands, in one line (PLAN.md section 13).
 *
 * ROADMAP's Phase 6 asks for "review-pane wiring", and the toggles it names (`1`/`2`/`p`/`r`) were built in
 * Phase 4. What was missing is the thing a human actually needs from a review: whether it is satisfied, and
 * if not, WHICH condition is short. Section 13's rule has three independent clauses, so "awaiting-review" as
 * a state glyph answers none of them — a reviewer can have approved everything while quorum is one short,
 * and that is indistinguishable from nobody having looked.
 *
 * ONE LINE, and it only appears when there is a review in flight. A permanent panel would spend rows on
 * every task that is not being reviewed, which is most of them at any moment.
 *
 * Per dimension: `ok` when satisfied, `N chg` when there are change requests, `-` when nothing has approved
 * it yet. Not a tick and a cross: at a 60-column minimum the words survive truncation more legibly than
 * symbols whose meaning has to be remembered.
 */
export function renderReviewBar(state, cols) {
  const r = state.review;
  if (!r) return [];
  const bits = [];
  for (const [id, d] of Object.entries(r.dimensions ?? {})) {
    const short = id.slice(0, 4);
    bits.push(d.changeRequests > 0 ? `${short} ${d.changeRequests}chg` : (d.satisfied ? `${short} ok` : `${short} -`));
  }
  const q = r.quorum ?? {};
  bits.push(`quorum ${q.distinctReviewers ?? 0}/${q.required ?? "?"}`);
  // `findingCount`, not `findings.length`: the snapshot sends the top few for detail plus the real total, and
  // rendering the slice's length reported "5 finding(s)" for any number above five.
  const findingCount = Number.isInteger(r.findingCount) ? r.findingCount : (r.findings?.length ?? 0);
  if (findingCount) bits.push(`${findingCount} finding(s)`);
  // The verdict FIRST, because it is the one thing a reader wants before the detail — and `blocked` rather
  // than `not approved`, since the reasons are actionable and "not approved" reads as a passive state.
  const head = r.approved ? "APPROVED" : "blocked";
  return [
    rule(cols, { left: B.lt, right: B.rt, label: `REVIEW round ${r.round ?? "?"} — ${head}` }),
    row(` ${bits.join("  ·  ")}`, cols),
  ];
}

/** One glyph per task state (PLAN.md section 6). Unknown states get `?` rather than being hidden. */
export function taskGlyph(state) {
  switch (state) {
    case "awaiting-review": case "approved": return "◆";   // waiting on people
    case "blocked": return "⚑";                             // waiting on an answer
    case "merged": return "✔";
    case "failed": case "start-failed": case "cancelled": return "✖";
    case "created": case "starting": return "○";            // not yet working
    case "planning": case "implementing": case "fixing": return "●";
    default: return "?";
  }
}

/**
 * The task tree for the active team. Task nodes, worker children.
 *
 * `focus` is drawn as `>` and the selected row is bracketed, because a TUI with no visible focus is a
 * TUI where every keypress is a guess.
 */
export function renderTree(state, width, height) {
  const rows = [];
  const team = (state.teams ?? [])[state.activeTeamIndex];
  const tasks = (state.tasks ?? []).filter((t) => !team || t.teamId === team.id);

  for (const task of tasks) {
    // Marker by state, using PLAN.md section 6's real names (Phase 5 made them enforced). A task
    // waiting on people looks different from one being worked on, and one that is finished or broken
    // differs from both — three glyphs rather than a colour, so it survives a monochrome terminal.
    rows.push({ kind: "task", id: task.id, label: `${taskGlyph(task.state)} ${task.title}` });
    const workers = (state.workers ?? []).filter((w) => w.taskId === task.id);
    for (let i = 0; i < workers.length; i += 1) {
      const last = i === workers.length - 1;
      const w = workers[i];
      // The pin marker is the answer to "why is this pane showing this worker" (FLOWS §5, `m`).
      const pin = state.pinnedWorkerId === w.workerId ? " *" : "";
      rows.push({ kind: "worker", id: w.workerId, label: `${last ? "└" : "├"}${w.nickname}${pin}` });
    }
  }
  if (!rows.length) rows.push({ kind: "empty", id: null, label: "(no tasks)" });

  const out = [];
  for (let i = 0; i < height; i += 1) {
    const r = rows[i + (state.treeScroll ?? 0)];
    if (!r) { out.push(fit("", width)); continue; }
    const selected = r.id !== null && r.id === state.selectedNodeId;
    const marker = selected ? (state.focus === "tree" ? ">" : "·") : " ";
    out.push(fit(`${marker}${r.label}`, width));
  }
  return { lines: out, rows };
}

/**
 * One pane's body. The three non-running states are explicit, because ROADMAP names them and because
 * a blank pane is the single most confusing thing a dashboard can show: "empty", "the worker died"
 * and "this is old output" all look identical if none of them says which it is.
 */
export function renderPaneBody(pane, width, height) {
  const out = [];
  const push = (t) => out.push(fit(t, width));

  if (!pane) {
    push("");
    push("  (no pane — select a task or worker in the tree)");
    while (out.length < height) push("");
    return out.slice(0, height);
  }

  const header = `${pane.title}${pane.pinned ? " *" : ""}${pane.degraded ? "  [wrapper tier]" : ""}`;
  push(` ${header}`);
  push(` ${"-".repeat(Math.max(0, Math.min(width - 2, header.length + 1)))}`);

  // PLAN.md §9: a `wrapper`-tier harness "is always explicitly marked as such in the UI — never silently
  // treated as equivalent to a real, conformance-passing adapter". In the HEADER and again here, because
  // the header is one line that a narrow split pane truncates, and this is the difference between "the
  // worker said this" and "this is raw terminal output nobody parsed".
  if (pane.degraded) {
    push("  ◇ degraded driver: raw terminal output, no turn boundaries, no approvals");
  }

  if (pane.status === "empty") {
    push("");
    push("  nothing has happened on this run yet");
  } else if (pane.status === "crashed") {
    // Named, with the reason, because "why did it stop" is the first question and the answer is
    // already in the row (`exit_reason`).
    push("");
    push(`  ✖ this run ended: ${pane.exitReason ?? "unknown reason"}`);
    push("    the transcript below is what it produced before it stopped");
    push("");
  } else if (pane.status === "stale") {
    // A pane the supervisor is no longer streaming — an adopted session, or a run whose events we
    // cannot follow. Saying "stale" is the honest alternative to showing old output as if it were live.
    push("");
    push("  ◔ not streaming — visible only");
    // Split across short lines on purpose: at a half-width split pane (~46 cols) a single sentence is
    // truncated mid-word, and a status message that gets cut is worse than one that is terse.
    push("  not controllable from here");
    push("  (an adopted session answers in its own terminal)");
    push("");
  }

  for (const line of pane.lines ?? []) {
    if (out.length >= height) break;
    push(`  ${line}`);
  }
  if (pane.blockedOn && out.length < height) {
    push("");
    push(`  ⚑ BLOCKED: ${pane.blockedOn}`);
  }
  while (out.length < height) push("");
  return out.slice(0, height);
}

/**
 * The pane area: one pane full width, or two side by side.
 *
 * The dev pane AUTO-EXPANDS when no reviewer pane is visible (FLOWS §5: "no dead space"). That is a
 * layout rule with a reason — a half-width pane beside an empty half is worse than either a full pane
 * or a populated split.
 */
export function renderPaneArea(state, cols, height, treeWidth) {
  const paneCols = cols - treeWidth - 3; // two outer borders + the tree divider
  const panes = visiblePanes(state);
  const lines = [];

  if (panes.length <= 1) {
    const body = renderPaneBody(panes[0], paneCols, height);
    const tree = renderTree(state, treeWidth, height);
    for (let i = 0; i < height; i += 1) {
      lines.push(`${B.v}${tree.lines[i]}${B.v}${body[i]}${B.v}`);
    }
    return lines;
  }

  // Two panes. The focused one gets the extra column when the split is odd, so focus is visible in
  // the geometry as well as the marker.
  const leftWidth = Math.floor((paneCols - 1) / 2) + (state.focusedPane === 0 && (paneCols - 1) % 2 ? 1 : 0);
  const rightWidth = paneCols - 1 - leftWidth;
  const left = renderPaneBody(panes[0], leftWidth, height);
  const right = renderPaneBody(panes[1], rightWidth, height);
  const tree = renderTree(state, treeWidth, height);
  for (let i = 0; i < height; i += 1) {
    lines.push(`${B.v}${tree.lines[i]}${B.v}${left[i]}${B.v}${right[i]}${B.v}`);
  }
  return lines;
}

/**
 * Which panes are visible, and in what order.
 *
 * The dev pane is always first when present. Reviewer visibility is per-slot (`1`, `2`, `p`) with a
 * global `r` toggle that REMEMBERS what was shown — FLOWS §5 says `r` again "restores last-shown
 * reviewer pane state", so hiding cannot be a lossy operation.
 */
export function visiblePanes(state) {
  const all = state.panes ?? [];
  if (state.fullscreen && all.length) {
    const idx = Math.min(state.focusedPane ?? 0, all.length - 1);
    return [all[idx]];
  }
  const dev = all.filter((p) => p.role !== "reviewer");
  if (state.reviewersHidden) return dev.slice(0, 1);
  // The TYPE-DRIVEN default (FLOWS §5): a dev task shows the last-active dev run ALONE; a review task
  // shows the dev pane plus one reviewer. Only while nobody has toggled a reviewer explicitly — after
  // that, `visibleReviewers` is a decision rather than a default and this must not override it.
  if (state.reviewerDefaultFromType && state.paneLayout !== "review") return dev.slice(0, 1);
  const reviewers = all.filter((p) => p.role === "reviewer" && state.visibleReviewers?.includes(p.slot));
  return [...dev.slice(0, 1), ...reviewers].slice(0, 2);
}

/**
 * The footer: which keys do what, right now — plus the status line.
 *
 * THE STATUS LINE IS NEW, and it is here because it was MISSING. `state.status` is written by half the
 * actions ("pin (m) applies to a worker", "sent to w1", "not sent: …") and, most importantly, by
 * `refresh()` on a failed round trip — and nothing rendered it. So a TUI whose supervisor had died looked
 * exactly like one whose workers were quiet: the message existed, in a field nobody drew. Found by
 * reading a captured frame rather than by a test, which is the third time the demo has earned its keep.
 *
 * It goes in the footer's rule rather than on a row of its own, so it costs no vertical space and cannot
 * push the pane area around as messages come and go.
 */
export function renderFooter(state, cols) {
  const hidden = state.reviewersHidden;
  const bits = [
    "[1] rev1", "[2] rev2", "[p] parent",
    hidden ? "[r] show revs" : "[r] hide revs",
    state.fullscreen ? "[f] unfullscreen" : "[f] fullscreen",
    "[h/l] team", state.chatTarget === "cto" ? "[d] direct" : "[d] cto", "[/] chat", "[q] quit",
  ];
  return [
    rule(cols, { left: B.lt, right: B.rt, label: state.status ? `! ${state.status}` : null }),
    row(` ${bits.join("  ")}`, cols),
  ];
}

/** The always-resident chat bar (FLOWS §6). Its target is stated, never implied. */
export function renderChatBar(state, cols) {
  const target = state.chatTarget === "cto" ? "CTO" : `${state.chatTargetName ?? "worker"} (direct)`;
  const caret = state.focus === "chat" ? ">" : " ";
  return [
    rule(cols, { left: B.lt, right: B.rt }),
    row(`${caret} ${target}: ${state.chatInput ?? ""}${state.focus === "chat" ? "_" : ""}`, cols),
    rule(cols, { left: B.bl, right: B.br }),
  ];
}

/**
 * The whole frame. Returns exactly `rows` lines, each exactly `cols` wide.
 *
 * A too-small terminal gets a message rather than a broken frame: the alternative is arithmetic that
 * goes negative and throws inside a render loop, which takes the whole TUI down for a resize.
 */
/**
 * Where everything IS, in rows and columns. One source of truth for both drawing and clicking.
 *
 * `renderFrame` lays the frame out from this, and `hitTest` reads the same numbers back — so a click
 * cannot land somewhere other than what was drawn, however the layout changes later. Getting this wrong
 * in two places is the standard way mouse support rots.
 */
export function frameGeometry(state, { cols = 100, rows = 30 } = {}) {
  const treeWidth = Math.max(14, Math.min(24, Math.floor(cols * 0.15)));
  const teamBarHeight = 2;
  const footerHeight = 2;
  const chatHeight = 3;
  const requestsHeight = requestsPanelHeight(state, rows);
  // Two lines when a review is in flight for the selected task, none otherwise (see `renderReviewBar`).
  const reviewHeight = state.review ? 2 : 0;
  const paneTop = teamBarHeight + requestsHeight + reviewHeight + 1; // +1 for the divider under the header block
  const paneHeight = Math.max(1, rows - paneTop - footerHeight - chatHeight);

  // Pane columns, mirroring `renderPaneArea`: border, tree, divider, then one or two panes.
  const paneCols = cols - treeWidth - 3;
  const visible = visiblePanes(state);
  const paneColumns = [];
  if (visible.length <= 1) {
    paneColumns.push({ index: 0, colStart: treeWidth + 2, colEnd: treeWidth + 1 + paneCols });
  } else {
    const leftWidth = Math.floor((paneCols - 1) / 2) + (state.focusedPane === 0 && (paneCols - 1) % 2 ? 1 : 0);
    paneColumns.push({ index: 0, colStart: treeWidth + 2, colEnd: treeWidth + 1 + leftWidth });
    paneColumns.push({ index: 1, colStart: treeWidth + 3 + leftWidth, colEnd: cols - 2 });
  }

  return {
    cols, rows, treeWidth,
    teamBar: { top: 0, height: teamBarHeight, chipRow: 1 },
    requests: requestsHeight ? { top: teamBarHeight, height: requestsHeight } : null,
    review: reviewHeight ? { top: teamBarHeight + requestsHeight, height: reviewHeight } : null,
    divider: paneTop - 1,
    paneArea: { top: paneTop, height: paneHeight, tree: { colStart: 1, colEnd: treeWidth }, panes: paneColumns },
    footer: { top: paneTop + paneHeight, height: footerHeight },
    chat: { top: paneTop + paneHeight + footerHeight, height: chatHeight },
  };
}

/**
 * What is at (col, row)? Both 0-based, both in frame coordinates.
 *
 * Returns a TARGET rather than an action, so `state.js` keeps owning what a click MEANS. FLOWS §5's click
 * rows ("click a team", "click a worker in tree", "click the Requests panel then `h`") are then one
 * mapping in the keybinding table rather than terminal-decoding logic that has grown opinions.
 *
 * `null` for dead space, which the caller must treat as "do nothing" — a click that falls through to
 * some default is how a UI ends up switching panes because someone clicked a border.
 */
export function hitTest(state, size, col, row) {
  const g = frameGeometry(state, size);
  if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return null;

  if (row === g.teamBar.chipRow) {
    const { shown } = teamBarChips(state, g.cols);
    const chip = shown.find((c) => col >= c.col && col < c.col + c.width);
    return chip ? { kind: "team", index: chip.index, id: chip.id } : null;
  }

  if (g.requests && row >= g.requests.top && row < g.requests.top + g.requests.height) {
    // The whole panel is one target. FLOWS §6a's interaction is "click into it, press `h` to hide" —
    // the buttons are drawn but nothing produces a request yet, so a click that claimed to Accept one
    // would be a button that lies.
    const requests = state.requests ?? [];
    const bodyTop = g.requests.top + (g.requests.height - 1 >= 2 ? 2 : 1);
    const idx = row - bodyTop + (state.requestScroll ?? 0);
    return { kind: "requests", requestId: requests[idx]?.id ?? null };
  }

  if (g.review && row >= g.review.top && row < g.review.top + g.review.height) {
    // Clicking the review bar focuses the REVIEWER pane, which is what someone reading it wants next. It is
    // a distinct target rather than dead space so the intent is explicit; `state.js` decides what it means.
    return { kind: "reviewBar" };
  }

  if (row >= g.paneArea.top && row < g.paneArea.top + g.paneArea.height) {
    const rowInArea = row - g.paneArea.top;
    if (col >= g.paneArea.tree.colStart && col <= g.paneArea.tree.colEnd) {
      const { rows: treeRowsOut } = renderTree(state, g.treeWidth, g.paneArea.height);
      const node = treeRowsOut[rowInArea + (state.treeScroll ?? 0)];
      return node && node.id !== null ? { kind: "treeRow", id: node.id, nodeKind: node.kind } : null;
    }
    const pane = g.paneArea.panes.find((p) => col >= p.colStart && col <= p.colEnd);
    return pane ? { kind: "pane", index: pane.index } : null;
  }

  if (row >= g.chat.top && row < g.chat.top + g.chat.height) return { kind: "chat" };
  if (row >= g.footer.top && row < g.footer.top + g.footer.height) return { kind: "footer" };
  return null;
}

export function renderFrame(state, { cols = 100, rows = 30 } = {}) {
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    const msg = `terminal too small: need at least ${MIN_COLS}x${MIN_ROWS}, have ${cols}x${rows}`;
    const out = [fit(msg, cols)];
    while (out.length < rows) out.push(fit("", cols));
    return out.slice(0, rows);
  }

  const g = frameGeometry(state, { cols, rows });
  const out = [
    ...renderTeamBar(state, cols),
    ...(g.requests ? renderRequestsPanel(state, cols, g.requests.height) : []),
    ...renderReviewBar(state, cols),
    rule(cols, { left: B.lt, right: B.rt }),
    ...renderPaneArea(state, cols, g.paneArea.height, g.treeWidth),
    ...renderFooter(state, cols),
    ...renderChatBar(state, cols),
  ];
  while (out.length < rows) out.push(row("", cols));
  return out.slice(0, rows);
}
