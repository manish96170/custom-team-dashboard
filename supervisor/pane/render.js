// render.js — normalized events in, transcript lines out. No I/O, no state beyond what a
// caller hands it, so the rendering rules can be tested without a socket or a process.
//
// PLAN.md section 5 settles the transport: **normalized event transcripts, not terminal
// passthrough**, because the CTO has to READ the panes and a framebuffer of ANSI cells is the
// wrong substrate for that. This file is the consequence of that decision. It renders the
// adapters' normalized contract (`assistant.delta`, `tool.start`, `tool.result`,
// `approval.request`, `turn.end`, ...), and it is the one place that decides what a human sees.
//
// Three rules it follows, each of which is a design decision rather than a formatting choice:
//
//  1. **An unknown event type is shown, never dropped.** The event contract grows — the CLI's own
//     docs say "consumers should ignore types and subtypes they do not recognize: the set grows
//     over time" — but *ignore* must not mean *hide* in a pane a human is using to understand
//     what a worker did. An unrecognised event renders as a dim, honest one-liner.
//  2. **A gap is loud.** The event pump guarantees eviction is never silent; a pane that quietly
//     skipped evicted events would throw that guarantee away at the last hop.
//  3. **Deltas coalesce, everything else does not.** `assistant.delta` is a token stream and must
//     read as prose, so consecutive deltas append to an open line. Every other event is a discrete
//     row, because "what did it do" is the question the transcript exists to answer.

/** ANSI, kept in one place and switchable off so a test asserts text rather than escape codes. */
const STYLES = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  blue: "[34m",
  magenta: "[35m",
  cyan: "[36m",
};

export function createStyler({ color = true } = {}) {
  if (!color) {
    const plain = new Proxy({}, { get: () => (s) => String(s) });
    return plain;
  }
  return new Proxy(
    {},
    {
      get: (_t, key) => (s) => `${STYLES[key] ?? ""}${s}${STYLES.reset}`,
    },
  );
}

/** Collapse whitespace so one event is one row, however the harness formatted it. */
function oneLine(value, max = 160) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The most useful single field of a tool's input, so a row reads like the call it is. */
function describeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of ["command", "file_path", "path", "url", "pattern", "query", "prompt"]) {
    if (typeof input[key] === "string" && input[key].length > 0) return oneLine(input[key], 100);
  }
  return oneLine(input, 100);
}

/**
 * A rendering session. Holds only what coalescing needs: whether an assistant line is open.
 *
 * `emit` receives finished lines. Returning lines rather than writing them is what lets the
 * tests assert the transcript exactly, and what will let a future TUI put them in a pane
 * instead of on stdout.
 */
export function createTranscriptRenderer({ color = true, showThinking = false, timestamps = false } = {}) {
  const s = createStyler({ color });
  let openAssistantLine = false;
  const lines = [];

  const push = (line) => {
    if (openAssistantLine) {
      // Close the coalesced prose line before starting a discrete row.
      lines.push("");
      openAssistantLine = false;
    }
    lines.push(line);
  };

  const stamp = () => (timestamps ? s.dim(`${new Date().toISOString().slice(11, 19)} `) : "");

  /**
   * Render one frame. `seq` is the pump's sequence number, kept out of the visible line but
   * used by the caller as its replay cursor.
   *
   * Returns the lines produced by THIS frame, so a caller can stream them; the full transcript
   * is also available from `all()`.
   */
  function frame(event, { seq } = {}) {
    const before = lines.length;
    const beforeOpen = openAssistantLine;
    render(event, seq);
    const produced = lines.slice(before);
    // A coalesced delta appends to the last line rather than adding one, so report that line.
    if (produced.length === 0 && openAssistantLine && beforeOpen) return [lines[lines.length - 1]];
    return produced;
  }

  function render(event, seq) {
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      push(s.dim(`${stamp()}· unrenderable frame ${oneLine(event, 80)}`));
      return;
    }

    switch (event.type) {
      case "session.init":
        push(`${stamp()}${s.dim("· session")} ${s.dim(event.claudeSessionId ?? event.sessionId ?? "")}`);
        return;

      case "turn.start":
        push(`${stamp()}${s.dim(`· turn ${event.turn ?? ""} started`)}`);
        return;

      case "assistant.delta": {
        // The thinking channel is off by default: it is the model's scratch space, it is long,
        // and a pane that shows it by default buries the actual answer.
        if (event.channel === "thinking" && !showThinking) return;
        const text = typeof event.text === "string" ? event.text : "";
        if (text.length === 0) return;
        if (openAssistantLine) {
          lines[lines.length - 1] += text;
        } else {
          lines.push(`${stamp()}${s.cyan("assistant")} ${text}`);
          openAssistantLine = true;
        }
        return;
      }

      case "tool.start":
        push(`${stamp()}${s.blue("→ tool")} ${s.bold(event.toolName ?? "?")} ${s.dim(describeToolInput(event.input))}`.trimEnd());
        return;

      case "tool.result": {
        const failed = !!event.isError;
        const label = failed ? s.red("← tool failed") : s.green("← tool ok");
        push(`${stamp()}${label} ${s.dim(oneLine(event.content))}`.trimEnd());
        return;
      }

      // ── the approval channel, which section 5 calls a first-class pane event ──────────
      case "approval.request": {
        const kind = event.requiresUserInteraction ? "QUESTION" : "APPROVAL NEEDED";
        push(`${stamp()}${s.yellow(`⏸ ${kind}`)} ${s.bold(event.displayName ?? event.toolName ?? "?")}`);
        // The harness's one-line description and the most useful field of the input are often the
        // SAME string — for WebFetch both are the URL — and printing both made the real transcript
        // read as a stutter. Show the description, and the input only when it adds something.
        const described = event.description ? oneLine(event.description) : null;
        if (described) push(`   ${s.dim(described)}`);
        if (event.requiresUserInteraction) {
          for (const q of event.input?.questions ?? []) {
            push(`   ${s.bold(oneLine(q?.question ?? "", 120))}`);
            for (const opt of q?.options ?? []) push(`     ${s.dim("·")} ${oneLine(opt?.label ?? "", 60)}`);
          }
        } else {
          const detail = describeToolInput(event.input);
          if (detail && detail !== described) push(`   ${s.dim(detail)}`);
        }
        // The worker is stopped until someone acts, so the pane says what to do rather than
        // leaving a human to infer it from a stalled transcript.
        push(`   ${s.dim("the worker is waiting — /allow, /deny <reason>, or /answer <text>")}`);
        return;
      }

      case "approval.answered":
        push(`${stamp()}${s.yellow("▶ answered")} ${s.dim(`${event.toolName ?? ""} ${event.behavior ?? ""}`)}`.trimEnd());
        return;

      case "approval.withdrawn":
        push(`${stamp()}${s.dim(`▶ the harness withdrew its request (${event.reason ?? "withdrawn"})`)}`);
        return;

      case "approval.auto-denied":
        // Distinct from a live request on purpose: this decision has already been made by the
        // harness itself and cannot be changed, so the pane must not imply a button.
        push(`${stamp()}${s.red("✗ refused by the harness")} ${s.dim(oneLine(event.reason ?? event.decisionReasonType ?? ""))}`);
        return;

      case "turn.end": {
        const status = event.status ?? (event.isError ? "error" : "completed");
        const colour = status === "completed" ? s.green : status === "aborted" ? s.yellow : s.red;
        const cost = typeof event.costUsd === "number" ? ` $${event.costUsd.toFixed(4)}` : "";
        const tokens =
          event.tokensIn != null || event.tokensOut != null
            ? ` ${s.dim(`in:${event.tokensIn ?? "?"} out:${event.tokensOut ?? "?"}${event.cachedTokens ? ` cached:${event.cachedTokens}` : ""}`)}`
            : "";
        push(`${stamp()}${colour(`■ turn ${status}`)}${cost}${tokens}`);
        return;
      }

      case "process.exit":
        push(`${stamp()}${s.dim(`· process exited (code ${event.code ?? "null"}${event.signal ? `, ${event.signal}` : ""})`)}`);
        return;

      case "stderr":
        push(`${stamp()}${s.red("stderr")} ${s.dim(oneLine(event.data))}`);
        return;

      case "process.error":
      case "stdin.error":
        push(`${stamp()}${s.red(`! ${event.type}`)} ${s.dim(oneLine(event.error))}`);
        return;

      default:
        // Rule 1: shown, not dropped. `seq` is included here and nowhere else — for an event we
        // cannot render meaningfully, the sequence number is the thing that makes it findable in
        // `event_log`.
        push(`${stamp()}${s.dim(`· ${event.type}`)} ${s.dim(oneLine(stripKnownKeys(event), 100))}${seq != null ? s.dim(` [seq ${seq}]`) : ""}`);
        return;
    }
  }

  /** A gap frame from the pump: events were evicted before this subscriber read them. */
  function gap({ gap: missing, fromSeq }) {
    push(s.yellow(`⚠ ${missing} event(s) were evicted before this pane read them (resuming at seq ${fromSeq})`));
    return [lines[lines.length - 1]];
  }

  function note(text) {
    push(s.dim(`· ${text}`));
    return [lines[lines.length - 1]];
  }

  return {
    frame,
    gap,
    note,
    all: () => [...lines],
    /** Plain text, for a test or a handoff document. */
    text: () => lines.join("\n"),
  };
}

/** Everything except the envelope keys, so an unknown event's payload is what gets shown. */
function stripKnownKeys(event) {
  const { type, runId, ...rest } = event;
  return Object.keys(rest).length > 0 ? rest : type;
}
