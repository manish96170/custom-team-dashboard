// app.js — the TUI's I/O half (Phase 4). Terminal in, terminal out, socket in between.
//
// This file does everything `layout.js` and `state.js` deliberately do not: raw-mode stdin, ANSI
// output, resize handling, and talking to the supervisor. It contains no layout arithmetic and no
// keybinding decisions — it decodes bytes into key names, hands them to `keyToAction`, and prints what
// `renderFrame` returns. That split is what makes the other two files testable, so keeping it strict
// is the point rather than an aesthetic.
//
// NO TUI LIBRARY, on purpose. The project's only dependency is `better-sqlite3`, and a dashboard whose
// install story is "and eighteen transitive packages" is a different product. Raw ANSI is a few dozen
// lines and it is the same decision the pane made.
//
// REDRAW IS DIFFED, LINE BY LINE. Repainting the whole screen every tick makes a terminal flicker and
// makes scrollback useless; comparing against the last frame and moving the cursor only to the lines
// that changed does not. `renderFrame` returning fixed-width lines is what makes the comparison sound.

import { renderFrame, hitTest, MIN_COLS, MIN_ROWS } from "./layout.js";
import { initialState, keyToAction, applyAction, withRequests, FOCUS } from "./state.js";
import { paneDefaultFor } from "../domain/workflow-profiles.js";

const ESC = "\x1b";
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR = `${ESC}[2J${ESC}[H`;

/**
 * Decode one chunk of raw stdin into a key name.
 *
 * Only the sequences the keybinding table actually uses. A full terminfo decoder is a project of its
 * own, and every key it would add is one nothing is bound to — whereas getting these six wrong is
 * immediately visible.
 */
export function decodeKey(chunk) {
  const s = chunk.toString("utf8");
  if (s === "\r" || s === "\n") return "return";
  if (s === "\x7f" || s === "\b") return "backspace";
  if (s === "\t") return "tab";
  if (s === ESC) return "escape";
  if (s === "\x03") return "ctrl-c";
  if (s.startsWith(`${ESC}[`)) {
    return { A: "up", B: "down", C: "right", D: "left" }[s[2]] ?? null;
  }
  if (s.length === 1) return s;
  return null;
}

/** SGR mouse reporting: `1006` gives coordinates that keep working past column 223. */
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;

/**
 * Decode an SGR mouse report into a 0-based click, or null.
 *
 * `ESC[<button;col;rowM` is a press and `...m` is a release, both 1-based. Only the PRESS of button 0 is
 * a click here: acting on the release as well would double every click, and acting on button 1/2 would
 * bind the middle and right buttons to whatever the left one does — a UI that responds to a right-click
 * by switching panes feels broken in a way that is hard to describe and easy to avoid.
 *
 * Drag and wheel are deliberately unhandled. FLOWS §5 lists no drag targets ("no drag-and-drop" is
 * stated outright for list management), and a wheel event decoded as a click would scroll the tree by
 * opening whatever is under the pointer.
 */
export function decodeMouse(chunk) {
  const s = chunk.toString("utf8");
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(s);
  if (!m) return null;
  const [, btn, col, row, kind] = m;
  if (kind !== "M" || Number(btn) !== 0) return null;
  return { col: Number(col) - 1, row: Number(row) - 1 };
}

export function createTuiApp({
  client,                 // { request(cmd), close() } — the socket, injected so tests need none
  out = process.stdout,
  input = process.stdin,
  refreshMs = 700,
} = {}) {
  let state = initialState();
  let lastFrame = [];
  let timer = null;
  let stopped = false;

  /**
   * The replay cursors, and the transcript accumulated per run — FLOWS §5's "replayed by cursor when a
   * pane is switched to".
   *
   * Held HERE rather than in `state` because they are not layout input: the layout reads `panes[].lines`.
   * Keeping them out of the state object also keeps `state.js` pure and keeps the frame comparison in
   * `paint()` honest — a growing transcript buffer in state would make every tick look like a change.
   */
  const transcripts = new Map();  // runId -> { lines: string[], cursor: number, provisional: string|null }

  /** Rule 4 tier 1 is bounded everywhere else; a client that accumulates for hours must bound it too. */
  const MAX_LINES_PER_RUN = 500;

  function transcriptFor(runId) {
    let t = transcripts.get(runId);
    if (!t) { t = { lines: [], cursor: 0, provisional: null }; transcripts.set(runId, t); }
    return t;
  }

  // `out.columns` is undefined when stdout is a pipe rather than a TTY, so COLUMNS/LINES are honoured
  // as a fallback. That is not only for tests: it is how a TUI piped through anything renders at the
  // right width instead of silently defaulting to 100 and looking broken.
  const size = () => ({
    cols: Math.max(1, out.columns || Number(process.env.COLUMNS) || 100),
    rows: Math.max(1, out.rows || Number(process.env.LINES) || 30),
  });

  function paint() {
    const frame = renderFrame(state, size());
    // Full repaint when the geometry changed; a diff against a differently-shaped frame would leave
    // fragments of the old one behind.
    if (lastFrame.length !== frame.length || (lastFrame[0]?.length ?? -1) !== (frame[0]?.length ?? -1)) {
      out.write(CLEAR);
      lastFrame = [];
    }
    let buf = "";
    for (let i = 0; i < frame.length; i += 1) {
      if (frame[i] === lastFrame[i]) continue;
      buf += `${ESC}[${i + 1};1H${frame[i]}`;
    }
    if (buf) out.write(buf);
    lastFrame = frame;
  }

  /**
   * Pull the world from the supervisor.
   *
   * Everything here is a READ. The TUI is a client like the pane and the hooks (PLAN.md section 4);
   * it never touches SQLite, and every mutation goes back as a command.
   */
  // review-sol-2026-09-13.md finding 16: `setInterval(refresh, refreshMs)` starts a new async refresh on
  // every tick with no serialization against the previous one. If a round trip ever took longer than
  // `refreshMs` (a slow network tick, a GC pause), two requests were in flight sharing the same captured
  // cursors, and whichever RESPONSE happened to arrive and apply LAST won — regardless of which request
  // was actually newer — so an older snapshot could overwrite a newer one (a regressed team/task view,
  // reordered or duplicated transcript lines). Made single-flight: a refresh already in progress makes
  // the next tick a no-op rather than starting an overlapping second request.
  let refreshInFlight = false;
  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      // ONE round trip, not two. Two reads per tick is two chances to render half of one instant and
      // half of the next — teams from before a change and runs from after it.
      //
      // The cursors go WITH that one request, so replay stays a property of the same snapshot rather
      // than a second, separately-timed read.
      const cursors = {};
      for (const [runId, t] of transcripts) cursors[runId] = t.cursor;
      const snap = await client.request({ cmd: "tuiSnapshot", cursors });
      if (snap?.ok) {
        applyTranscripts(snap);
        state = {
          ...state,
          teams: snap.teams ?? [],
          tasks: snap.tasks ?? [],
          workers: snap.workers ?? [],
        };
        // Through `withRequests`, not by assignment: it owns the two rules an assignment would lose
        // (an empty list un-hides the panel; a vanished selection is dropped).
        state = withRequests(state, snap.requests ?? []);
        // First load: select something IN THE ACTIVE TEAM. Selecting `tasks[0]` globally was a real
        // bug caught by looking at the demo — teams are ordered by name and tasks by creation, so the
        // tree showed one team while the panes showed another team's workers. The tree filters by team
        // and the panes filter by selection, so a selection outside the active team makes them disagree.
        if (!state.selectedNodeId) {
          const team = state.teams[state.activeTeamIndex];
          const first = state.tasks.find((t) => !team || t.teamId === team.id);
          if (first) state.selectedNodeId = first.id;
        }
        // The pane layout follows the SELECTED TASK'S TYPE (FLOWS §5's "smart default from task type"),
        // resolved through the workflow profile so the type -> layout mapping has one home
        // (domain/workflow-profiles.js) rather than one per consumer.
        const selectedWorker = state.workers.find((w) => w.workerId === state.selectedNodeId);
        const selectedTaskId = selectedWorker ? selectedWorker.taskId : state.selectedNodeId;
        const selectedTask = state.tasks.find((t) => t.id === selectedTaskId);
        state.paneLayout = paneDefaultFor(selectedTask?.type);
        // The review bar's input (PLAN.md §13). `?? null` matters: a task whose review finished must clear
        // the bar rather than keep showing the last evaluation, which would be a stale claim about a state
        // the system has left.
        state.review = (selectedTaskId && snap.reviews?.[selectedTaskId]) ?? null;
        state.panes = buildPanes(state, snap);
        // Clear ONLY the unreachable notice, which this successful round trip has just disproved. The
        // other statuses are answers to something the user did ("sent to w1", "unpinned"), and wiping
        // those on the next tick — up to 700ms later — meant a message could vanish before it was read.
        if (typeof state.status === "string" && state.status.startsWith("supervisor unreachable")) {
          state.status = null;
        }
      }
    } catch (err) {
      state = { ...state, status: `supervisor unreachable: ${err.message}` };
    } finally {
      refreshInFlight = false;
    }
    paint();
  }

  /**
   * Fold one snapshot's incremental transcript into the accumulated buffers.
   *
   * Three things happen here, and each is a decision:
   *
   *   * **Append, never replace.** The whole point of the cursor is that a pane keeps what it has
   *     already seen; re-reading a fixed window would show a run's last 60 events forever and lose
   *     everything before them.
   *   * **A gap is announced.** When more events arrived than the server would return in one slice, the
   *     count is written into the transcript as a line. A pane that silently skips events shows a hole
   *     that looks exactly like a worker having said nothing — the wording deliberately matches
   *     `pane/render.js`'s gap note, since it is the same fact.
   *   * **Provisional prose is REPLACED.** The last line of a mid-turn poll is unfinished, so it is kept
   *     separately and re-rendered each tick until the server declares it settled.
   */
  function applyTranscripts(snapshot) {
    for (const [runId, lines] of Object.entries(snapshot.transcripts ?? {})) {
      const t = transcriptFor(runId);
      const skipped = snapshot.gaps?.[runId] ?? 0;
      if (skipped) {
        t.lines.push(`⚠ ${skipped} event(s) were not replayed into this pane (resuming at seq ${t.cursor})`);
      }
      if (lines.length) t.lines.push(...lines);
      if (t.lines.length > MAX_LINES_PER_RUN) t.lines = t.lines.slice(-MAX_LINES_PER_RUN);
      // `?? null`, not `|| null`: an absent key and a settled line are different, and the second must
      // clear the provisional line rather than leave the last fragment on screen.
      t.provisional = snapshot.provisional?.[runId] ?? null;
      const next = snapshot.cursors?.[runId];
      if (Number.isInteger(next) && next > t.cursor) t.cursor = next;
    }
  }

  /** What a pane shows: everything settled, plus the line still being written. */
  function linesFor(runId) {
    const t = transcripts.get(runId);
    if (!t) return [];
    return t.provisional ? [...t.lines, t.provisional] : t.lines;
  }

  /**
   * Turn runs into panes.
   *
   * The three non-running pane states come from the ROW, not from guesswork: a closed row is
   * `ended` with its own `exit_reason`, an adopted or un-streamed run is `stale`, and a run with no
   * events yet is `empty`. Every one of those is a thing the pane must SAY rather than render blank
   * (see layout.js).
   *
   * Corrected 2026-09-11 (`codexdoc/REVIEW-NOTES.md` finding 15's second half, missed in this file's
   * first fix pass): this status used to be the literal string `"crashed"` for EVERY ended run,
   * regardless of `exitReason` — so a run that finished normally, or was deliberately stopped, was
   * unconditionally labelled as having crashed. The row already carries the real reason
   * (`exitReason`), and `layout.js` already renders it in the message — the bug was the STATUS NAME
   * itself asserting a failure that the reason might contradict. `ended` is neutral; the message still
   * names the specific reason either way.
   */
  function buildPanes(prev, snapshot) {
    const rows = snapshot.runs ?? [];
    const selected = prev.selectedNodeId;
    const workers = snapshot.workers ?? [];
    const pinned = prev.pinnedWorkerId;

    // Fixed 2026-09-11 (`codexdoc/REVIEW-NOTES.md` finding 15): this used to be a bare `rows.find(...)`,
    // which picks whichever run for this worker happens to come FIRST in `rows`' own order — and
    // `listRunsForDisplay` returns runs in roughly historical/ascending order, so a worker's OLD ended
    // run was shown even after it had a live replacement. The actual rule: prefer the LIVE run
    // (`endedAt` null) if one exists; otherwise the NEWEST ended one, by `lastEventAt` (which the
    // `runs` projection above already falls back to `started_at` for, so this never compares against
    // `undefined`) — not simply array position either way.
    const forWorker = (workerId) => {
      const candidates = rows.filter((r) => r.workerId === workerId);
      if (!candidates.length) return null;
      const live = candidates.find((r) => !r.endedAt);
      if (live) return live;
      return [...candidates].sort((a, b) => String(b.lastEventAt ?? "").localeCompare(String(a.lastEventAt ?? "")))[0];
    };
    const paneFor = (worker, role, slot) => {
      const run = forWorker(worker.workerId);
      // From the ACCUMULATED buffer, not from this snapshot's slice: the slice is only what is new
      // since the cursor, so rendering it directly would make a pane blank whenever nothing happened
      // in the last tick.
      const lines = linesFor(run?.runId).slice(-40);
      let status = "running";
      if (!run) status = "empty";
      else if (run.endedAt) status = "ended";
      else if (run.controllable === false || run.lifecycle === "adopted") status = "stale";
      else if (!lines.length) status = "empty";
      return {
        role, slot,
        title: `${worker.nickname} (${worker.role})${run ? ` — ${run.runId.slice(0, 8)}` : ""}`,
        // PLAN.md §9's rule, carried into the pane: a wrapper-tier run is ALWAYS marked. The flag comes
        // from the harness's conformance verdict via the snapshot, not from anything the TUI decides.
        degraded: run?.degraded === true,
        harnessId: run?.harnessId ?? null,
        pinned: pinned === worker.workerId,
        status,
        exitReason: run?.exitReason ?? null,
        lines,
        blockedOn: (snapshot.asks ?? []).find((a) => a.runId === run?.runId)?.question ?? null,
      };
    };

    // Which task is in view: the selected node, or its parent if a worker is selected.
    const selectedWorker = workers.find((w) => w.workerId === selected);
    const taskId = selectedWorker ? selectedWorker.taskId : selected;
    const members = workers.filter((w) => w.taskId === taskId);
    if (!members.length) return [];

    // The dev pane: the pinned worker if there is one, else the MOST RECENTLY ACTIVE dev worker —
    // FLOWS §5's "last-active dev run (by most-recent-message, unless pinned)".
    //
    // "Most recently active" was previously "the first worker whose role is coder", which is the same
    // answer whenever a task has one coder and a silently wrong one when it has two: the pane would show
    // whichever coder the registry happened to list first, indefinitely, while the other one worked.
    // `lastEventAt` comes from the snapshot (max tier-1 `ts` per run) precisely so this is a fact rather
    // than an ordering accident.
    const activityOf = (workerId) => forWorker(workerId)?.lastEventAt ?? "";
    const devCandidates = members.filter((w) => w.role !== "reviewer");
    const byActivity = [...(devCandidates.length ? devCandidates : members)]
      .sort((a, b) => String(activityOf(b.workerId)).localeCompare(String(activityOf(a.workerId))));
    const dev = members.find((w) => w.workerId === pinned) ?? byActivity[0] ?? members[0];
    const panes = [paneFor(dev, "dev", null)];
    const reviewers = members.filter((w) => w.role === "reviewer" && w.workerId !== dev.workerId);
    reviewers.forEach((w, i) => panes.push(paneFor(w, "reviewer", i === 0 ? "parent" : `rev${i}`)));
    return panes;
  }

  /**
   * A click at (col, row). Resolved against the layout, then handed to the pure state layer.
   *
   * `hitTest` is called with the SAME size `paint()` renders at, which is why the geometry lives in
   * `layout.js` rather than here: a click resolved against different arithmetic than the frame was drawn
   * with lands on the wrong thing, and the bug presents as "the mouse is off by one row".
   */
  async function handleClick({ col, row }) {
    const target = hitTest(state, size(), col, row);
    if (!target) return;
    const before = state;
    state = applyAction(state, { type: "click", target });
    if (state !== before) paint();
  }

  async function handleKey(key) {
    if (key === "ctrl-c") { state = { ...state, quit: true }; return; }
    const before = state;
    state = applyAction(state, keyToAction(key, state));

    // Chat submission is the one action with a side effect, and it is performed HERE because
    // `state.js` is pure. `pendingChat` is the handoff.
    if (state.pendingChat) {
      const { target, text } = state.pendingChat;
      state = { ...state, pendingChat: null };
      if (text.trim()) {
        try {
          // Routed as a command like everything else. A TUI that wrote to the database directly would
          // break the single-writer rule the whole architecture rests on.
          const res = await client.request({ cmd: "tuiChat", target, text });
          state = { ...state, status: res?.ok ? `sent to ${target}` : `not sent: ${res?.error ?? "refused"}` };
        } catch (err) {
          state = { ...state, status: `not sent: ${err.message}` };
        }
      }
    }

    // Accept/Decline from the Request Detail view (PLAN.md §14.4 correction 3 / FLOWS §6c), added
    // 2026-09-11 — same `pendingX` handoff shape as `pendingChat` above. Honestly a no-op past the
    // status line: there is no wire command yet for "accept this request into a real task" — §14.4's
    // own note says so explicitly ("none of this is built" server-side; `hitTest`'s comment on the
    // panel's own click target says the same). This closes the UI round-trip without pretending the
    // backend half exists.
    // review-sol-2026-09-13.md finding 24: the status message used to LEAD with "accepted"/"declined"
    // — past-tense success wording, with the "not yet wired" caveat only tacked on afterward. An
    // operator scanning the status line (not reading the whole sentence) reads a real decision as
    // recorded; it is not — the request stays pending, unchanged, on the very next refresh. Reworded
    // to never claim the decision happened at all.
    if (state.pendingRequestDecision) {
      const { requestId, decision } = state.pendingRequestDecision;
      state = {
        ...state, pendingRequestDecision: null,
        status: `${decision} on ${requestId} not recorded — no backend command exists yet to act on a request (PLAN.md §14.4, backlog)`,
      };
    }
    if (state !== before) paint();
  }

  // review-sol-2026-09-13.md finding 30: these used to be anonymous inline listeners passed straight to
  // `input.on("data", ...)`/`out.on("resize", ...)`, with no reference kept — `stop()` had no way to
  // remove them. Restarting or embedding this TUI (each `start()` adding another pair with no way to
  // undo the previous ones) accumulated listeners without bound, and a stopped app could keep repainting
  // on a resize event nobody meant to still be listening for. Named here so `stop()` can `off()` them.
  function onInputData(chunk) {
    // Mouse FIRST: an SGR report starts with `ESC[`, so `decodeKey` would otherwise read `ESC[<...`
    // as an unrecognised arrow key and drop it — silently, which is the worst of the three outcomes.
    const click = decodeMouse(chunk);
    if (click) { handleClick(click); return; }
    const key = decodeKey(chunk);
    if (key === null) return;
    handleKey(key).then(() => { if (state.quit) stop(); });
  }
  function onResize() { lastFrame = []; paint(); }

  async function start() {
    if (input.isTTY) { input.setRawMode?.(true); }
    input.resume?.();
    out.write(ALT_SCREEN_ON + HIDE_CURSOR + MOUSE_ON + CLEAR);

    input.on("data", onInputData);
    out.on?.("resize", onResize);

    await refresh();
    timer = setInterval(refresh, refreshMs);
    // Bookkeeping must not be the reason a process refuses to exit — the same rule the supervisor's
    // ask sweep follows.
    timer.unref?.();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    input.off?.("data", onInputData);
    out.off?.("resize", onResize);
    // Restore the terminal on EVERY exit path. A TUI that leaves raw mode on, the cursor hidden, or
    // MOUSE REPORTING ON makes the user's shell appear broken — mouse reporting is the worst of the
    // three, because the shell then prints escape sequences whenever the user moves the pointer.
    out.write(MOUSE_OFF + SHOW_CURSOR + ALT_SCREEN_OFF);
    if (input.isTTY) input.setRawMode?.(false);
    input.pause?.();
    // finding 30's other half: the socket client was never closed on stop(), leaking it past this app's
    // own lifetime.
    client.close?.();
  }

  return {
    start,
    stop,
    paint,
    refresh,
    handleKey,
    handleClick,
    /** For tests and the demo: the accumulated transcripts, which are deliberately not part of `state`. */
    transcriptState: () => new Map([...transcripts].map(([k, v]) => [k, { ...v, lines: [...v.lines] }])),
    get state() { return state; },
    set state(v) { state = v; },
  };
}
