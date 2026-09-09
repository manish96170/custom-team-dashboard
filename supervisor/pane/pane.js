// pane.js — one run's live pane: attach over the control socket, replay by cursor, stay
// subscribed, and answer what the worker is blocked on.
//
// This is the reader half of PLAN.md section 5, and it is deliberately a CLIENT: it holds no
// database handle and spawns nothing. Everything it does goes through the wire protocol, which is
// what makes it the same shape as the future TUI pane rather than a privileged debug tool.
//
// The supervisor already did the hard half. `observe` gives per-subscriber cursors and explicit
// `gap` frames, so this is a consumer of an existing contract:
//
//   observe(runId, fromSeq) -> { id, seq, event } | { id, gap, fromSeq } | { id, ok, done }
//
// Two properties worth stating because they are easy to lose:
//
//  - **Replay is by cursor, not "from the beginning".** `fromSeq` is the last seq this pane
//    rendered, so re-attaching after a disconnect resumes rather than duplicating — which is
//    exactly what section 5 means by "replayed by cursor when a pane is switched to".
//  - **A parked worker is surfaced from `asks`, not inferred from the transcript.** The
//    `approval.request` event says a request happened; the `asks` table says whether it is still
//    outstanding and whether it can still be answered (the harness may have withdrawn it, or the
//    process may have been replaced). A pane that offered an approve button off the event alone
//    would let a human answer into a void.

import { connect } from "../ipc/client.js";
import { defaultSockPath, defaultStateDir } from "../ipc/paths.js";
import { createTranscriptRenderer } from "./render.js";

/**
 * Attach to a run.
 *
 * @param {{
 *   runId: string,
 *   sockPath?: string,
 *   fromSeq?: number,
 *   color?: boolean,
 *   showThinking?: boolean,
 *   timestamps?: boolean,
 *   out?: (line: string) => void,
 *   askPollMs?: number,
 * }} opts
 */
export async function attachPane({
  runId,
  sockPath = defaultSockPath(defaultStateDir()),
  fromSeq = 0,
  color = true,
  showThinking = false,
  timestamps = false,
  out = (line) => process.stdout.write(`${line}\n`),
  askPollMs = 700,
} = {}) {
  if (!runId) throw new Error("attachPane: runId is required");

  const client = await connect(sockPath);
  const renderer = createTranscriptRenderer({ color, showThinking, timestamps });

  // `out(line, { replacesPrevious })` — and the second argument is the whole point.
  //
  // A coalesced `assistant.delta` returns the WHOLE line so far, not the new fragment, because that
  // is what a pane needs to redraw. An append-only consumer that ignores this prints the line once
  // per token: the real captured transcript read "assistant The", "assistant The page", "assistant
  // The page title"... which is correct data rendered wrongly. The renderer's contract is "here is
  // the current state of this line"; deciding how to present a changing line is the consumer's job,
  // so the pane tells the consumer WHICH it is getting rather than leaving it to guess.
  let renderedCount = 0;
  const write = (produced) => {
    const totalNow = renderer.all().length;
    const replacesPrevious = produced.length === 1 && totalNow === renderedCount;
    renderedCount = totalNow;
    for (const line of produced) out(line, { replacesPrevious });
  };

  // The pane's replay cursor. Updated only from frames it has actually rendered, so a crash
  // mid-render re-reads that event rather than skipping it.
  let cursor = fromSeq;
  let done = false;
  let doneReason = null;

  const status = await client.send("status", { runId });
  if (!status.ok) {
    client.close();
    throw new Error(`attachPane: ${status.error}`);
  }
  write(renderer.note(`attached to ${runId} (${status.status?.harnessId ?? "?"}), replaying from seq ${cursor}`));

  // ── the observe subscription ─────────────────────────────────────────────────────────
  const observeId = `pane-${runId}-${Date.now()}`;
  const streamEnded = new Promise((resolve) => {
    client.onStream(observeId, (frame) => {
      if (frame.gap) {
        write(renderer.gap(frame));
        if (typeof frame.fromSeq === "number") cursor = frame.fromSeq;
        return;
      }
      if (frame.event) {
        write(renderer.frame(frame.event, { seq: frame.seq }));
        if (typeof frame.seq === "number") cursor = frame.seq;
        return;
      }
      if (frame.done || frame.ok === false) {
        done = true;
        doneReason = frame.ok === false ? frame.error : "the run's stream ended";
        write(renderer.note(doneReason));
        resolve();
      }
    });
  });
  client.socket.write(`${JSON.stringify({ id: observeId, cmd: "observe", runId, fromSeq: cursor })}\n`);

  // ── what the worker is blocked on ────────────────────────────────────────────────────
  // Polled rather than pushed, and that is a real limitation rather than a preference: the wire
  // protocol has no server-initiated ask notification yet, so a pane learns about a parked
  // request from the transcript immediately and from `asks` within one poll. The poll is what
  // makes `answerable` (and therefore the prompt) correct; the event alone cannot say whether the
  // request is still outstanding. A push channel is the obvious later improvement.
  let pending = [];
  const refreshAsks = async () => {
    const reply = await client.send("asks", { runId });
    if (!reply.ok) return;
    const before = pending.map((a) => a.askId).join(",");
    pending = reply.asks ?? [];
    const after = pending.map((a) => a.askId).join(",");
    if (after !== before && pending.length > 0) {
      const a = pending[0];
      write(
        renderer.note(
          `blocked: ${a.question}${a.answerable === false ? " (no longer answerable — the harness withdrew it or the process was replaced)" : ""}`,
        ),
      );
    }
  };
  await refreshAsks();
  const askTimer = setInterval(() => {
    refreshAsks().catch(() => {});
  }, askPollMs);
  askTimer.unref?.();

  /**
   * Answer whatever this run is blocked on.
   *
   * `allow` / `deny` decide a tool approval; `answers` answers a question. The pane deliberately
   * does NOT invent a decision when the ask is a question and the operator typed prose — the
   * supervisor refuses that (a question must be answered by the exact question text), and
   * papering over it here would produce the "the user did not answer the questions" outcome that
   * looks like the human ignoring the worker.
   */
  async function answer({ allow, answers, text } = {}) {
    await refreshAsks();
    const ask = pending[0];
    if (!ask) return { ok: false, error: "nothing is waiting on an answer for this run" };
    if (ask.answerable === false) {
      return { ok: false, error: `ask ${ask.askId} can no longer be answered (the request is gone)` };
    }

    const params = { askId: ask.askId, answeredBy: "pane" };
    if (ask.kind === "question" && allow !== false) {
      // One question, one typed line: map it onto the exact question text for the operator, which
      // is the only shape the harness accepts.
      const questions = ask.payload?.input?.questions ?? [];
      if (answers) params.answers = answers;
      else if (questions.length === 1 && text) params.answers = { [questions[0].question]: text };
      else if (!text) return { ok: false, error: "this is a question — answer it with /answer <text>" };
      else {
        return {
          ok: false,
          error: `this ask has ${questions.length} questions; answer it with an explicit map rather than one line`,
        };
      }
    } else {
      params.allow = allow !== false;
      if (text) params.answer = text;
    }

    const reply = await client.send("answerAsk", params);
    if (!reply.ok) return { ok: false, error: reply.error };
    if (!reply.answered) return { ok: false, error: reply.reason };
    // `answered` and `delivered` are different facts and the pane says so: an answer that was
    // recorded but never reached the worker means the worker is still parked.
    write(
      renderer.note(
        reply.delivered
          ? `answer delivered (${reply.decision})`
          : `answer recorded but NOT delivered (${reply.reason ?? "unknown"}) — the worker may still be waiting`,
      ),
    );
    await refreshAsks();
    return { ok: true, ...reply };
  }

  async function sendInput(text) {
    const reply = await client.send("sendInput", { runId, input: text });
    if (!reply.ok) write(renderer.note(`sendInput failed: ${reply.error}`));
    return reply;
  }

  async function interrupt() {
    const reply = await client.send("interrupt", { runId });
    write(renderer.note(reply.ok ? "interrupt sent" : `interrupt failed: ${reply.error}`));
    return reply;
  }

  function detach() {
    clearInterval(askTimer);
    client.close();
  }

  return {
    runId,
    client,
    renderer,
    answer,
    sendInput,
    interrupt,
    detach,
    refreshAsks,
    get cursor() {
      return cursor;
    },
    get pending() {
      return [...pending];
    },
    get done() {
      return done;
    },
    get doneReason() {
      return doneReason;
    },
    streamEnded,
    transcript: () => renderer.text(),
  };
}

/**
 * The line-oriented command grammar an operator types into a pane.
 *
 * Parsed here rather than in the CLI so the mapping from what a human types to what the
 * supervisor is asked is testable without a terminal. Anything that is not a slash command is a
 * message to the worker — which is the right default for a pane whose main use is talking to it.
 */
export function parsePaneCommand(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "noop" };
  if (!trimmed.startsWith("/")) return { kind: "input", text: trimmed };

  const [word, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (word) {
    case "allow":
      return { kind: "answer", allow: true, text: arg || undefined };
    case "deny":
      // A denial without a reason is allowed but discouraged: the message reaches the model
      // verbatim, so an empty one tells the worker nothing about what to do instead.
      return { kind: "answer", allow: false, text: arg || undefined };
    case "answer":
      return arg ? { kind: "answer", text: arg } : { kind: "error", error: "/answer needs some text" };
    case "interrupt":
      return { kind: "interrupt" };
    case "asks":
      return { kind: "asks" };
    case "detach":
    case "quit":
      return { kind: "detach" };
    case "help":
      return { kind: "help" };
    default:
      return { kind: "error", error: `unknown command /${word} — try /help` };
  }
}

export const PANE_HELP = [
  "  <text>            send a message to the worker",
  "  /allow            approve what the worker is blocked on",
  "  /deny <reason>    refuse it — the reason reaches the model verbatim",
  "  /answer <text>    answer a question the worker asked",
  "  /asks             list what this run is blocked on",
  "  /interrupt        cancel the in-flight turn (the process stays alive)",
  "  /detach           leave the pane; the run keeps going",
];
