# mock-harness

A canned event-stream replay adapter for the custom-team-dashboard's
Phase 0b harness spike (see `PLAN.md` section 4 for the adapter contract and
event model). It implements the same interface every real harness adapter
(Claude Code, OpenCode) must implement, but never invokes a real CLI:

```
start(spec) -> runId
sendInput(runId, input) -> void
observe(runId) -> AsyncIterable<Event>
interrupt(runId) -> void
clearContext(runId) -> ack
resume(runId) -> runId | unsupported
stop(runId) -> void
answerApproval(runId, approvalId, decision) -> void   // typed response for approval.request
```

## Why this exists

Every TUI iteration against a real harness (Phase 4) burns tokens and real
wall-clock seconds. This adapter replays a deterministic, canned event
sequence on a realistic timer instead, so the TUI can be built and iterated
on for free and without waiting on a real process. It is genuinely-useful
infrastructure, not a throwaway stub — it proves the same multi-run
concurrency properties the real adapters need (see `FINDINGS.md`).

## Usage

```js
const { MockHarnessAdapter } = require('./adapter');

const adapter = new MockHarnessAdapter({
  deltaDelayRange: [50, 150], // ms between assistant.delta events
  approvalChance: 0.3,        // probability [0,1] a turn includes an approval.request
});

const runId = adapter.start({
  prompt: 'Fix the flaky checkout test',
  cwd: '/repo/checkout-app',
  // optional: forceApproval: true | false — override approvalChance for this run
  // optional: seed: <number> — override the prompt-derived deterministic seed
});

for await (const event of adapter.observe(runId)) {
  if (event.type === 'approval.request') {
    adapter.answerApproval(runId, event.approvalId, 'approved');
  }
  if (event.type === 'turn.end') break;
}

adapter.stop(runId);
```

Event sequence per turn: a few `assistant.delta` events (word-chunked, 50-150ms
apart by default), one `tool.start`/`tool.result` pair, an optional
`approval.request` -> `approval.resolved` pair (the run blocks until
`answerApproval` is called, same as a real harness would), then `turn.end`.

Determinism: the event sequence (which message template, which tool, which
approval question, chunk sizes, per-delta delay) is seeded from
`spec.prompt` text (or an explicit `spec.seed`), so the same prompt always
replays the same canned sequence — useful for reproducible TUI test fixtures.

### Multiple concurrent runs

Each `start()` call gets its own independent `runId`, its own timer set,
its own subscriber list, and its own "conversation so far" history. Two
concurrent runs' event streams do not interfere with each other — see
`demo.js` and `FINDINGS.md` for captured proof of real interleaving (not
sequential execution disguised as concurrent).

### interrupt / clearContext / resume / stop

- `interrupt(runId)` stops that run's pending timers immediately and emits a
  final `run.interrupted` event on that run's stream(s). No more events
  follow for that run afterward.
- `clearContext(runId)` resets the mock's in-memory "conversation so far"
  array for that run and returns `{ ok: true, runId, clearedAt }`.
- `resume(runId)` — see the important caveat below.
- `stop(runId)` stops timers, emits `run.stopped`, and closes every active
  subscriber (`observe()` iterator) for that run.

## Deliberately more capable than a real harness — read before relying on this

**`resume()` in this mock always succeeds** and returns a new `runId` that
carries forward the previous run's history. This is intentional: a mock has
no real limitation forcing it to fail, so it's built to the *ideal* case —
full resumability — precisely so the Phase 4 TUI can be developed against
that ideal case first, and made to gracefully degrade later once the real
capability matrix (`harnesses.capabilities_json`, PLAN.md section 3/9) comes
back from the two real-harness spikes running in parallel with this one
(`claude-code-adapter/`, `opencode-adapter/`).

**Do not treat any behavior of this mock as a promise about real harness
behavior.** In particular:
- Claude Code and OpenCode may not both support `resume` the same way (or at
  all) — this is exactly what those spikes are proving.
- `clearContext` may mean a different operation on each real harness (PLAN.md
  section 7) — the mock's "wipe an array" implementation is a stand-in, not
  evidence either real harness behaves this way.
- Real approval protocols, tool-call shapes, and event timing will differ
  from this mock's canned templates.

Build the TUI against this mock for speed; validate the TUI's behavior
against each real adapter (per its own capability declaration) before
calling any harness-specific interaction done.

## Files

- `adapter.js` — the `MockHarnessAdapter` class implementing the full interface.
- `demo.js` — starts two concurrent runs, prints interleaved labeled events,
  answers an `approval.request` on each, and stops both cleanly.
- `FINDINGS.md` — actual captured output from running `demo.js`, as evidence
  the concurrency claim holds (not just written but observed).

Run the demo with:

```
node demo.js
```
