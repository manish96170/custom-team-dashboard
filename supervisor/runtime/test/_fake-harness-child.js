// _fake-harness-child.js — a real OS process that behaves like a resident harness:
// emits newline-delimited JSON events on stdout, accepts follow-up turns on stdin, and
// stays alive until it is killed.
//
// This exists so the supervisor's integration test can exercise a genuine process
// lifecycle (own process group, real pid/pgid/lstart, real reap, real teardown) without
// depending on `claude` or `opencode` being installed. It makes no claim about either
// harness's behavior — the event shapes are the NORMALIZED ones the adapters produce
// (Group 4's `turn.end.status` contract), which is the contract the supervisor consumes.

import { DELTAS_PER_TURN } from "./_helpers.js";

let turn = 0;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// ── parked requests (Phase 2) ────────────────────────────────────────────────────────
// Mirrors what `claude` 2.1.263 was MEASURED to do (adapters/FINDINGS.md): send a
// `can_use_tool` control request and then do nothing at all until the host answers on
// stdin. The parking is the part that matters — a test where the "harness" carries on
// regardless would prove the round trip works while the real one deadlocks.
let parkedRequestId = null;

function park({ toolName, description, requiresUserInteraction, input, requestId }) {
  parkedRequestId = requestId;
  emit({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      display_name: toolName,
      description: description ?? null,
      input: input ?? {},
      tool_use_id: `toolu-${requestId}`,
      ...(requiresUserInteraction ? { requires_user_interaction: true } : {}),
      permission_suggestions: [{ type: "addRules", destination: "localSettings", rules: [{ toolName, ruleContent: "*" }], behavior: "allow" }],
    },
  });
}

/** The turn resumes only once an answer arrives, and it reports what the answer WAS. */
function onControlResponse(msg) {
  if (msg.response?.request_id !== parkedRequestId) {
    emit({ type: "harness.error", text: `answer for unknown request ${msg.response?.request_id}` });
    return;
  }
  parkedRequestId = null;
  const decision = msg.response.response ?? {};
  const denied = decision.behavior === "deny";
  emit({
    type: "tool.result",
    // The NORMALIZED fields first, because they are the contract the supervisor and the pane
    // actually consume (Group 4's `tool.result` shape: `isError` + `content`). The first version of
    // this fake emitted only `behavior`/`message`, so a denial rendered in a pane as "tool ok" —
    // the same class of defect as finding B4: a fake that diverges from the real adapters lets a
    // consumer be wrong while every test passes.
    isError: denied,
    content: denied ? decision.message : JSON.stringify(decision.updatedInput ?? { ok: true }),
    // ...and the raw decision, kept so a test can assert the deny MESSAGE and the answers map
    // reached the worker rather than only that something arrived.
    behavior: decision.behavior,
    message: decision.message ?? null,
    updatedInput: decision.updatedInput ?? null,
  });
  emit({ type: "turn.end", status: "completed", turn });
}

function runTurn(text) {
  turn += 1;
  emit({ type: "turn.start", turn });
  // Streamed in CHUNKS, not as one delta, because a real harness streams tokens and a consumer that
  // only ever sees one delta per line cannot be tested for how it presents a line that keeps
  // changing. (The pane's first real transcript printed each prose line once per token; a
  // single-delta fake could not have caught that.) The chunks coalesce into the same text, so
  // anything asserting on the finished line is unaffected.
  //
  // EXACTLY `DELTAS_PER_TURN`, always — not "however many a chunk size produces". Several suites do
  // exact per-run event accounting (concurrency's anti-crosstalk and no-loss checks depend on it),
  // and a delta count that varied with the length of the prompt made that arithmetic wrong for some
  // inputs and right for others. If you change this number, change `EVENTS_PER_TURN` in
  // `concurrency.test.js` with it.
  const full = `echo:${text}`;
  for (let i = 0; i < DELTAS_PER_TURN; i += 1) {
    const from = Math.floor((full.length * i) / DELTAS_PER_TURN);
    const to = Math.floor((full.length * (i + 1)) / DELTAS_PER_TURN);
    emit({ type: "assistant.delta", text: full.slice(from, to) });
  }
  emit({ type: "turn.end", status: "completed", turn, tokensIn: 5, tokensOut: 2, cachedTokens: 1 });
}

emit({ type: "session.init", sessionId: `fake-session-${process.pid}` });
runTurn(process.argv[2] ?? "");

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "control_response") onControlResponse(msg);
    else if (msg.type === "control_cancel_request") {
      // Either side may withdraw its own request; there is no reply to a cancel.
      if (msg.request_id === parkedRequestId) parkedRequestId = null;
    } else if (msg.type === "ask") {
      // The test asks the harness to block, rather than the harness deciding to: a test
      // needs the park to happen at a known moment.
      turn += 1;
      emit({ type: "turn.start", turn });
      park(msg);
    } else if (msg.type === "withdraw") {
      // The harness changing its mind (its turn was interrupted, say).
      const requestId = parkedRequestId;
      parkedRequestId = null;
      emit({ type: "control_cancel_request", request_id: requestId });
    } else if (msg.type === "user") runTurn(msg.text ?? "");
    else if (msg.type === "clear") emit({ type: "session.init", sessionId: `fake-session-${process.pid}-cleared` });
    else if (msg.type === "interrupt") emit({ type: "turn.end", status: "aborted", turn });
    // Group 6 needs a run that ends through the ADAPTER'S OWN completion path (the only
    // writer of `finished`) before a crash, so that reconciliation can be shown not to
    // rewrite it. Every other case here keeps the process resident; this one is the
    // deliberate exception, and only on an explicit request.
    else if (msg.type === "exit") process.exit(0);
  }
});

// Stay resident: the supervisor decides when this process ends, and several test cases
// (reap, teardown, orphan reconciliation) depend on it still being alive until then.
setInterval(() => {}, 1 << 30);
