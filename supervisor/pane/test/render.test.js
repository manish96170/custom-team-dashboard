// render.test.js — the transcript rendering rules, with no socket and no process.
//
// Rendering is pure here on purpose (`pane/render.js` holds no I/O), which is what makes these
// rules assertable at all. The three that are design decisions rather than formatting — an unknown
// event is shown rather than dropped, a gap is loud, and only deltas coalesce — are cases 1, 2 and
// 3, because each of them is the kind of thing a later "tidy-up" silently reverses.

import assert from "node:assert/strict";
import { createTranscriptRenderer } from "../render.js";
import { runTest } from "../../runtime/test/_helpers.js";

/** Colour off throughout: a test that asserts escape codes tests the styler, not the rules. */
const renderer = () => createTranscriptRenderer({ color: false });

await runTest("pane transcript rendering", async () => {
  // ── 1. an unrecognised event is SHOWN, never dropped ────────────────────────────
  // The harness event set grows by design — the CLI's own docs say consumers should ignore what
  // they do not recognise — but in a pane a human is using to understand what a worker did,
  // "ignore" must not mean "hide". The seq is included for exactly these, because it is the only
  // way to go find the event in `event_log`.
  {
    const r = renderer();
    const produced = r.frame({ type: "harness.control-request.unhandled", subtype: "keepalive", requestId: "r1" }, { seq: 42 });
    assert.equal(produced.length, 1);
    assert.match(produced[0], /harness\.control-request\.unhandled/, "the type is visible");
    assert.match(produced[0], /keepalive/, "and so is its payload");
    assert.match(produced[0], /seq 42/, "with the sequence number, so it can be found in event_log");

    // Including something that is not an event at all — a pane must not throw on a bad frame.
    const bad = r.frame(null, { seq: 43 });
    assert.equal(bad.length, 1);
    assert.match(bad[0], /unrenderable/);
    assert.doesNotThrow(() => r.frame({ noTypeField: true }, { seq: 44 }));
    console.log("  1. an unknown event renders with its payload and seq; a malformed frame does not throw");
  }

  // ── 2. a gap is loud ───────────────────────────────────────────────────────────
  // The event pump's guarantee is that eviction is never silent. A pane that skipped evicted
  // events quietly would throw that guarantee away at the last hop, which is the hop a human sees.
  {
    const r = renderer();
    const produced = r.gap({ gap: 17, fromSeq: 100 });
    assert.equal(produced.length, 1);
    assert.match(produced[0], /17 event\(s\) were evicted/);
    assert.match(produced[0], /seq 100/);
    console.log("  2. a gap frame says how many events were lost and where the stream resumes");
  }

  // ── 3. deltas coalesce; nothing else does ──────────────────────────────────────
  {
    const r = renderer();
    r.frame({ type: "assistant.delta", text: "Hello" }, { seq: 1 });
    r.frame({ type: "assistant.delta", text: ", world" }, { seq: 2 });
    r.frame({ type: "assistant.delta", text: "." }, { seq: 3 });
    const afterProse = r.all();
    assert.equal(afterProse.length, 1, `three deltas must be one line, got ${JSON.stringify(afterProse)}`);
    assert.match(afterProse[0], /assistant Hello, world\./);

    // A discrete event closes the prose line rather than appending to it.
    r.frame({ type: "tool.start", toolName: "Bash", input: { command: "ls -la" } }, { seq: 4 });
    const lines = r.all();
    assert.equal(lines[1], "", "the prose line is closed with a blank line before the next row");
    assert.match(lines[2], /→ tool Bash ls -la/, "and the tool call is its own row naming the command");
    console.log("  3. consecutive deltas became one prose line; a tool call started a new row");
  }

  // ── 4. the thinking channel is off by default ──────────────────────────────────
  // It is the model's scratch space, it is long, and a pane that shows it by default buries the
  // answer. Opt-in, not opt-out.
  {
    const off = renderer();
    off.frame({ type: "assistant.delta", text: "hmm, let me think", channel: "thinking" }, { seq: 1 });
    assert.deepEqual(off.all(), [], "thinking is not rendered by default");

    const on = createTranscriptRenderer({ color: false, showThinking: true });
    on.frame({ type: "assistant.delta", text: "hmm", channel: "thinking" }, { seq: 1 });
    assert.equal(on.all().length, 1, "and is rendered when asked for");
    console.log("  4. thinking deltas are hidden by default and shown with showThinking");
  }

  // ── 5. an approval renders as a stop, with what to do about it ─────────────────
  // Section 5 calls approval a first-class pane event. The worker is genuinely stopped, so the
  // pane says so and says what unblocks it — a stalled transcript with no explanation is the
  // failure this rendering exists to avoid.
  {
    const r = renderer();
    r.frame(
      {
        type: "approval.request",
        toolName: "Bash",
        displayName: "Bash",
        description: "git push --force",
        input: { command: "git push --force origin main" },
      },
      { seq: 5 },
    );
    const text = r.text();
    assert.match(text, /APPROVAL NEEDED/);
    assert.match(text, /git push --force origin main/, "the exact command is shown — you cannot approve what you cannot read");
    // The harness's description and the input's most useful field are often the same string (for
    // WebFetch both are the URL), and printing both made the real transcript stutter. Here they
    // differ, so both appear; the next assertion covers the case where they do not.
    assert.match(text, /git push --force$/m, "the harness's own one-line description is shown too");
    assert.match(text, /the worker is waiting/, "and the pane says the worker is stopped");
    assert.match(text, /\/allow, \/deny <reason>/, "with the commands that unblock it");
    // ...and when the description and the input say the same thing, it is said once.
    const dup = renderer();
    dup.frame(
      { type: "approval.request", toolName: "WebFetch", description: "https://example.com", input: { url: "https://example.com" } },
      { seq: 5 },
    );
    const dupLines = dup.all().filter((l) => l.includes("https://example.com"));
    assert.equal(dupLines.length, 1, `the URL should appear once, got ${JSON.stringify(dupLines)}`);
    console.log("  5. an approval renders as a stop, showing the exact call once, and how to answer it");
  }

  // ── 6. a question renders its options ──────────────────────────────────────────
  {
    const r = renderer();
    r.frame(
      {
        type: "approval.request",
        toolName: "AskUserQuestion",
        requiresUserInteraction: true,
        input: { questions: [{ question: "Tabs or spaces?", options: [{ label: "Spaces" }, { label: "Tabs" }] }] },
      },
      { seq: 6 },
    );
    const text = r.text();
    assert.match(text, /QUESTION/, "a question is labelled differently from an approval");
    assert.match(text, /Tabs or spaces\?/);
    assert.match(text, /· Spaces/);
    assert.match(text, /· Tabs/);
    console.log("  6. a question renders its text and every option");
  }

  // ── 7. an auto-denial is visibly NOT a live request ────────────────────────────
  // The harness refused this itself (a working-directory rule, a sandbox) and the decision cannot
  // be changed. Rendering it like a live request would offer a button for a settled outcome.
  {
    const r = renderer();
    r.frame({ type: "approval.auto-denied", toolName: "Read", reason: "Path is outside allowed working directories" }, { seq: 7 });
    const text = r.text();
    assert.match(text, /refused by the harness/);
    assert.doesNotMatch(text, /the worker is waiting/, "an auto-denial must not claim the worker is waiting for us");
    assert.doesNotMatch(text, /\/allow/, "and must not offer a decision that cannot be made");
    console.log("  7. an auto-denial reads as already-decided, with no approve affordance");
  }

  // ── 8. a turn end carries the cost and token counts ────────────────────────────
  // PLAN.md section 8 makes token accounting an architectural pillar, so the pane shows it rather
  // than making a human query the database for what a turn cost.
  {
    const r = renderer();
    r.frame({ type: "turn.end", status: "completed", costUsd: 0.2161212, tokensIn: 6, tokensOut: 491, cachedTokens: 38896 }, { seq: 8 });
    const line = r.all()[0];
    assert.match(line, /turn completed/);
    assert.match(line, /\$0\.2161/);
    assert.match(line, /in:6 out:491 cached:38896/);

    const failed = renderer();
    failed.frame({ type: "turn.end", status: "error" }, { seq: 9 });
    assert.match(failed.all()[0], /turn error/);
    const aborted = renderer();
    aborted.frame({ type: "turn.end", isError: false }, { seq: 10 });
    assert.match(aborted.all()[0], /turn completed/, "a turn.end with no status falls back to the derived isError");
    console.log("  8. turn.end shows status, cost and tokens, and tolerates a missing status field");
  }

  // ── 9. a failed tool result is distinguishable from a successful one ───────────
  {
    const r = renderer();
    r.frame({ type: "tool.result", isError: false, content: "ok" }, { seq: 11 });
    r.frame({ type: "tool.result", isError: true, content: "Not permitted for this worker." }, { seq: 12 });
    const [ok, failed] = r.all();
    assert.match(ok, /← tool ok/);
    assert.match(failed, /← tool failed/);
    assert.match(failed, /Not permitted for this worker\./, "the harness's reason is shown, not swallowed");
    console.log("  9. tool success and failure are visually distinct, and the failure reason is shown");
  }

  // ── 10. long and multi-line values are flattened to one row ────────────────────
  // One event is one row, however the harness formatted it: a tool result carrying a whole file
  // must not be able to push the rest of the transcript off the screen.
  {
    const r = renderer();
    r.frame({ type: "tool.result", isError: false, content: `line1\nline2\n${"x".repeat(500)}` }, { seq: 13 });
    const line = r.all()[0];
    assert.equal(line.split("\n").length, 1, "no embedded newlines");
    assert.ok(line.length < 220, `the row is bounded, got ${line.length} chars`);
    assert.match(line, /…$/, "and truncation is visible rather than silent");
    console.log("  10. a huge multi-line tool result became one bounded row, marked as truncated");
  }
});
