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
  // `[...s].length` (iterates by CODE POINT), not `s.length` (UTF-16 CODE UNITS): a 4-byte UTF-8
  // character (most emoji) decodes to a UTF-16 SURROGATE PAIR, two code units — `s.length === 1` was
  // false for a single, complete emoji even with no fragmentation involved at all, so it was silently
  // dropped (ChatGPT review, 2026-09-14). A 2-byte UTF-8 character (e.g. "é") was already fine either
  // way, since it fits in one UTF-16 unit.
  if ([...s].length === 1) return s;
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

/**
 * A real terminal-stream parser (ChatGPT review, 2026-09-14 — confirmed real before fixing, not assumed):
 * `decodeKey`/`decodeMouse` above each decode exactly ONE chunk as if it were exactly one complete
 * token. Raw stdin makes no such guarantee — verified directly against the ORIGINAL code before writing
 * this: a single chunk `"abc"` decoded to `null` (silently DROPPED, not three keys); `ESC` alone
 * immediately decoded to `"escape"` even though the very next chunk was `"[A"` (an arrow key whose `ESC`
 * happened to land in a separate `data` event) — and that trailing `"[A"` itself then decoded to `null`
 * and was ALSO dropped. Fast typing, paste, and a slow/fragmenting pipe can all produce exactly these
 * shapes; a real keyboard rarely does, which is why this bug is easy to miss by hand-testing.
 *
 * This buffers bytes ACROSS calls to `feed()` and only emits a decoded event once it has a COMPLETE
 * token, reusing `decodeKey`/`decodeMouse` themselves to decode each complete token (one source of truth
 * for what a token MEANS; this only decides where one token ENDS). A single `feed()` call can emit
 * multiple events (`"jjjj"` -> four key events) or zero (an incomplete sequence, buffered for the next
 * call).
 *
 * A bare `ESC` byte is the one genuinely ambiguous case: it is either a real, standalone Escape keypress,
 * or the start of an arrow/mouse sequence whose remaining bytes have not arrived yet — and there is no
 * way to tell which from the byte alone. Resolved with a short real timer (`escapeTimeoutMs`, default
 * 25ms, comfortably longer than any real escape sequence takes to arrive as one write, per how terminals
 * actually emit them): if nothing else arrives within the window, the buffered ESC is flushed as a real
 * `"escape"` key. This is the same escape-timeout technique real terminal libraries use for the same
 * ambiguity — not invented for this file specifically.
 */
export function createInputDecoder({ onEvent, escapeTimeoutMs = 25 } = {}) {
  let buf = Buffer.alloc(0);
  let escapeTimer = null;

  function clearEscapeTimer() {
    if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = null; }
  }

  /** UTF-8 lead-byte -> total byte length of the character it starts (1 for plain ASCII / continuation
   *  garbage, which is treated as its own 1-byte "character" rather than blocking forever on a byte
   *  sequence that will never complete). */
  function utf8CharLength(byte) {
    if ((byte & 0xe0) === 0xc0) return 2;
    if ((byte & 0xf0) === 0xe0) return 3;
    if ((byte & 0xf8) === 0xf0) return 4;
    return 1;
  }

  const MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
  // A mouse report still being written: `ESC[<` plus digits/semicolons and no terminator yet.
  const MOUSE_PREFIX_RE = /^\x1b\[<[\d;]*$/;
  // A runaway, never-terminating "mouse-shaped" prefix must not buffer forever — a real SGR report is
  // always short (button/col/row are all well under this many digits).
  const MOUSE_PREFIX_MAX_LEN = 32;

  function tryFlush() {
    for (;;) {
      if (buf.length === 0) return;
      if (buf[0] !== 0x1b) {
        // A plain byte, or the lead byte of a (possibly still-arriving) multi-byte UTF-8 character.
        const need = utf8CharLength(buf[0]);
        if (buf.length < need) return; // incomplete multi-byte character — wait for the rest
        const token = buf.slice(0, need);
        buf = buf.slice(need);
        const key = decodeKey(token);
        if (key !== null) onEvent({ type: "key", key });
        continue;
      }

      // buf[0] === ESC from here on.
      const lookahead = buf.slice(0, Math.min(buf.length, MOUSE_PREFIX_MAX_LEN)).toString("latin1");
      const mouseMatch = MOUSE_RE.exec(lookahead);
      if (mouseMatch) {
        const token = buf.slice(0, mouseMatch[0].length);
        buf = buf.slice(mouseMatch[0].length);
        clearEscapeTimer();
        const click = decodeMouse(token);
        if (click) onEvent({ type: "mouse", click });
        continue;
      }
      if (MOUSE_PREFIX_RE.test(lookahead) && lookahead.length < MOUSE_PREFIX_MAX_LEN) {
        return; // a mouse report is still being written — wait for the rest, no timeout needed: a real
        // terminal writes an SGR report as one burst, and this shape can ONLY be a forming mouse report.
      }
      if (buf.length >= 3 && buf[1] === 0x5b /* '[' */) {
        // A complete `ESC[X` — an arrow key if X is A-D, otherwise an unrecognized 3-byte sequence
        // (dropped, matching the ORIGINAL decodeKey's own `?? null` for any other letter here).
        const token = buf.slice(0, 3);
        buf = buf.slice(3);
        clearEscapeTimer();
        const key = decodeKey(token);
        if (key !== null) onEvent({ type: "key", key });
        continue;
      }
      if (buf.length === 2 && buf[1] === 0x5b) {
        return; // `ESC[` so far — could still become an arrow key or the start of a mouse report; wait.
      }
      if (buf.length === 1) {
        // A bare ESC — genuinely ambiguous (see the function's own header comment). Wait briefly for
        // more bytes; if none arrive, it really was a standalone Escape keypress.
        if (!escapeTimer) {
          escapeTimer = setTimeout(() => {
            escapeTimer = null;
            if (buf.length >= 1 && buf[0] === 0x1b) {
              buf = buf.slice(1);
              onEvent({ type: "key", key: "escape" });
              tryFlush();
            }
          }, escapeTimeoutMs);
        }
        return;
      }
      // `ESC` followed by something other than `[` — not one of the six sequences this project decodes
      // (Alt+key and similar are out of scope, same as the original decoder). Consume just the ESC byte
      // as a standalone Escape keypress and let whatever follows decode as its own token on the next
      // loop iteration, rather than getting stuck on bytes this parser does not understand.
      buf = buf.slice(1);
      clearEscapeTimer();
      onEvent({ type: "key", key: "escape" });
    }
  }

  return {
    feed(chunk) {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      tryFlush();
    },
    /** For tests and `stop()`: cancel a pending escape-disambiguation timer so it can't fire after the
     *  app has already torn down (and so a test doesn't have to wait out the real timeout to exit). */
    dispose() { clearEscapeTimer(); },
  };
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
  const transcripts = new Map();  // runId -> { lines: string[], cursor: number, provisional: string|null, touchedAt: number }

  /** Rule 4 tier 1 is bounded everywhere else; a client that accumulates for hours must bound it too. */
  const MAX_LINES_PER_RUN = 500;

  // ChatGPT review, 2026-09-14 — confirmed real before fixing: `transcripts` was NEVER pruned, so a
  // long-lived TUI session accumulated one entry (up to `MAX_LINES_PER_RUN` lines each) per run for
  // EVERY run the server has ever reported, forever — `tuiSnapshot`'s own handler
  // (`runtime/supervisor.js`) sends every run system-wide on every tick via `listRunsForDisplay`, with no
  // per-tick filtering by visibility, so this Map's growth tracks the WHOLE system's run history, not
  // just what this TUI instance has shown on screen.
  //
  // Two distinct kinds of staleness, both handled:
  //   * a run whose DB ROW IS GONE (a preflight, cleaned up after its probe — normal runs are never
  //     deleted, PLAN.md's "task history, not memory") no longer appears in `snap.runs` at all. Its
  //     transcript entry is pure dead weight and is dropped outright — `pruneTranscripts` below.
  //   * a normal run that ended keeps existing (and keeps being reported) forever, so the Map can still
  //     grow without bound purely from the passage of time. Bounded with a GLOBAL cap
  //     (`MAX_TRACKED_RUNS`) plus touch-order eviction: `touchedAt` is bumped both when new data arrives
  //     (`transcriptFor`) and when a pane actually DISPLAYS the run (`linesFor`) — so a run currently on
  //     screen is touched every single tick and is therefore always the LAST thing evicted, never the
  //     first, with no separate "is this pinned/selected" bookkeeping needed.
  const MAX_TRACKED_RUNS = 200;
  let touchCounter = 0;

  function transcriptFor(runId) {
    let t = transcripts.get(runId);
    if (!t) { t = { lines: [], cursor: 0, provisional: null, touchedAt: 0 }; transcripts.set(runId, t); }
    t.touchedAt = touchCounter += 1;
    return t;
  }

  /** Drop transcript entries for runs the server no longer reports at all, then enforce the global cap
   *  by evicting the LEAST recently touched entries first. `currentRunIds` is the full run-id set from
   *  the LATEST snapshot — `snap.runs`, not `snap.transcripts` (which is empty for a caller lacking
   *  `observe:run`, and would wrongly prune everything for such a caller otherwise). */
  function pruneTranscripts(currentRunIds) {
    for (const runId of transcripts.keys()) {
      if (!currentRunIds.has(runId)) transcripts.delete(runId);
    }
    const over = transcripts.size - MAX_TRACKED_RUNS;
    if (over > 0) {
      const oldest = [...transcripts.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
      for (const [runId] of oldest.slice(0, over)) transcripts.delete(runId);
    }
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
        pruneTranscripts(new Set((snap.runs ?? []).map((r) => r.runId)));
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

  /** What a pane shows: everything settled, plus the line still being written. Reading counts as
   *  activity for `pruneTranscripts`'s eviction order — a run actually on screen must never be the
   *  first thing dropped just because it has gone quiet. */
  function linesFor(runId) {
    const t = transcripts.get(runId);
    if (!t) return [];
    t.touchedAt = touchCounter += 1;
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
  // ChatGPT review, 2026-09-14: raw stdin is a byte STREAM, not a one-chunk-per-key API — `createInputDecoder`
  // (above) buffers across chunks and only emits a decoded event once it has a complete token. Replaces
  // the old `decodeMouse(chunk) then decodeKey(chunk)` pair, which assumed the whole chunk was exactly
  // one token (confirmed real before fixing: a chunk `"abc"` decoded to `null` and was silently dropped
  // entirely, and a fragmented arrow key — `ESC` in one chunk, `"[A"` in the next — decoded to `"escape"`
  // plus a second dropped chunk, never `"up"`).
  const inputDecoder = createInputDecoder({
    onEvent: (evt) => {
      if (evt.type === "mouse") { handleClick(evt.click); return; }
      handleKey(evt.key).then(() => { if (state.quit) stop(); });
    },
  });
  function onInputData(chunk) {
    inputDecoder.feed(chunk);
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
    // A pending escape-disambiguation timer must not fire after teardown — it would call `handleKey`
    // against a `state`/`client` this app no longer owns, and it is also the one thing that would
    // otherwise keep a test (or a real process) alive past `stop()`.
    inputDecoder.dispose();
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
