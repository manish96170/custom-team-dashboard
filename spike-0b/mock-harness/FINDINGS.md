# mock-harness — FINDINGS

Command run: `node demo.js` (from `spike-0b/mock-harness/`, node v26.6.0).

## Claim being verified

Two concurrent mock runs (`RUN-A`, `RUN-B`) started via `adapter.start()` at
the same time produce genuinely interleaved event streams over `observe()`
— not two sequential streams disguised as concurrent — and both runs can be
independently unblocked via `answerApproval()` and reach `turn.end`
concurrently.

## Actual captured output

```
Started run A: mock-run-35323eba-dcf7-46eb-b07c-fd2c4ab6602f
Started run B: mock-run-9b9d8719-2bf1-4d64-8715-f83e02b82662
--- interleaved event stream below ---

[17:49:16.755] (RUN-A) assistant.delta "I'll trace through "
[17:49:16.835] (RUN-B) assistant.delta "Looking at the request, "
[17:49:16.888] (RUN-B) assistant.delta "I'll start by reading "
[17:49:16.905] (RUN-A) assistant.delta "the call sites "
[17:49:16.970] (RUN-A) assistant.delta "first, then make "
[17:49:17.012] (RUN-B) assistant.delta "the relevant file to "
[17:49:17.110] (RUN-A) assistant.delta "the edit in a "
[17:49:17.120] (RUN-B) assistant.delta "understand the current "
[17:49:17.166] (RUN-A) assistant.delta "way that doesn't "
[17:49:17.184] (RUN-B) assistant.delta "implementation before making any "
[17:49:17.299] (RUN-B) assistant.delta "changes."
[17:49:17.306] (RUN-A) assistant.delta "disturb the existing "
[17:49:17.362] (RUN-B) tool.start Edit {"file_path":"/repo/payments-client/src/index.js","old_string":"foo","new_string":"bar"}
[17:49:17.398] (RUN-A) assistant.delta "tests."
[17:49:17.479] (RUN-B) tool.result Edit completed on /repo/payments-client/src/index.js
[17:49:17.501] (RUN-A) tool.start Read {"file_path":"/repo/checkout-app/src/index.js"}
[17:49:17.568] (RUN-A) tool.result Read completed on /repo/checkout-app/src/index.js
[17:49:17.623] (RUN-B) approval.request [approval-8d44652b-fbea-48b9-a849-8200f12dcec0] Allow writing to file outside the project root?
[17:49:17.672] (RUN-A) approval.request [approval-7f5889f5-9ab4-4bac-a685-293f576be913] Allow writing to file outside the project root?
          (answering approval approval-8d44652b-fbea-48b9-a849-8200f12dcec0 on RUN-B: approve)
[17:49:17.705] (RUN-B) approval.resolved [approval-8d44652b-fbea-48b9-a849-8200f12dcec0] -> approved
[17:49:17.705] (RUN-B) turn.end turn 1
          (answering approval approval-7f5889f5-9ab4-4bac-a685-293f576be913 on RUN-A: approve)
[17:49:17.714] (RUN-A) approval.resolved [approval-7f5889f5-9ab4-4bac-a685-293f576be913] -> approved
[17:49:17.714] (RUN-A) turn.end turn 1

--- both runs reached turn.end; stopping cleanly ---
Done.
```

## What this proves

- **Real interleaving, not sequential-disguised-as-concurrent**: RUN-A and
  RUN-B deltas alternate throughout (`17:49:16.755 A`, `.835 B`, `.888 B`,
  `.905 A`, `.970 A`, `.012 B`, ...) — a sequential implementation would
  finish all of RUN-A's events before starting RUN-B's, or block one run's
  timer loop while the other progresses. Neither happens here; both runs'
  timers are independently scheduled via per-run `setTimeout` and both
  progress in wall-clock time simultaneously.
- **Independent state, no cross-run contamination**: RUN-A's tool call
  (`Read` on `/repo/checkout-app/src/index.js`) and RUN-B's tool call
  (`Edit` on `/repo/payments-client/src/index.js`) never mix — each run's
  `cwd` and canned tool selection stayed scoped to its own `RunState`.
- **Approval blocking works per-run, not globally**: both runs independently
  emit `approval.request` and each blocks (via its own pending-promise map)
  until `answerApproval(runId, approvalId, decision)` is called with that
  run's own `runId` — answering RUN-B's approval did not unblock or affect
  RUN-A, and both reached `turn.end` within ~10ms of each other, driven by
  two separate `setTimeout` callbacks in the demo script, not by one run
  waiting on the other.
- **Determinism**: re-running `node demo.js` multiple times reproduces the
  same message text, same tool calls, and same approval question per run
  (seeded from `spec.prompt`) — only wall-clock timestamps and UUIDs differ
  between runs of the script.

Separately verified (ad hoc script, not shown in demo.js):
- `interrupt(runId)` stops a run's pending timer and the observer sees a
  single terminal `run.interrupted` event with no further events after.
- `clearContext(runId)` returns `{ ok: true, runId, clearedAt }` and resets
  the run's in-memory history.
- `resume(runId)` returns a new, different `runId` and starts a fresh turn
  immediately (this is the intentionally-more-capable-than-real-harnesses
  behavior documented in `README.md` and in a comment in `adapter.js`).
