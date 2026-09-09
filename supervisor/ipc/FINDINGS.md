# Findings — Phase 1 Group 3: Wire protocol + daemon resilience

(Written by the parent session — the subagent that did this work was blocked by tool
policy from writing this file itself; this is its report, verbatim.)

## Built (`supervisor/ipc/`)

`supervisor/db/` and `supervisor/lock/` were only imported from (`daemon.js`, one
function: `acquireLock`), never edited — verified by mtimes predating everything
created here.

- `protocol.js` — wire protocol + bounded `LineFramer`.
- `server.js` — `createIpcServer`.
- `safety.js` — process-level `uncaughtException`/`unhandledRejection` backstop.
- `mock-adapter.js` + `persistence-stub.js` — documented stubs matching the real
  `supervisor/db/index.js` and future normalized-adapter shapes.
- `client.js` — test client.
- `daemon.js` — optional composition demo wiring in the real lock module.
- `paths.js`, and four adversarial tests under `test/`.

**Wire protocol** (documented in full at the top of `protocol.js`): request
`{id, cmd, ...params}`; response `{id, ok, ...}` or `{id, ok:false, error}`; observe
stream frames `{id, event}` / `{id, ok:true, done:true}` — `id` is caller-supplied and
echoed on everything, closing review finding S10.

## Proven with real evidence

All four tests pass, exit 0, and a deliberately-broken assertion was verified to exit
1 — no rubber-stamping the test harness itself.

- `test/correlation.test.js` — pipelines commands and two concurrent `observe`
  subscriptions on one connection; every response/frame correctly tagged by `id`.
- `test/resilience-peer-crash.test.js` — spawns a **real separate OS process**, has it
  queue unread backlog, then sends **real SIGKILL**. Server survived with a genuine
  `EPIPE` caught by the per-socket `error` handler, zero events reached the top-level
  safety net, and the same server pid answered a fresh ping afterward.
- `test/bounded-buffer.test.js` — proves the bound at the `LineFramer` unit level
  (256KB pushed with no newline against a 64KB cap → overflow) and at the socket level
  (real flood, connection genuinely destroyed, tracked-socket set drops to 0).
- `test/teardown.test.js` — opens a long-lived `observe` connection and proves
  `shutdown()` resolves in ~1-6ms via force-close, plus an independent control test
  showing a bare `server.close()` genuinely hangs (800ms probe, no resolution) against
  the identical connection shape — so the claim it fixes is verified, not assumed.

## Code-review round two (2026-09-05): three blocking bugs, FIXED

`review-two/group3-ipc-luna.md` found that this module's bounded-buffer claim above
was materially weaker than advertised. All three blocking findings are now fixed,
each with a deterministic regression test in `test/bounded-buffer.test.js` that was
verified to FAIL against the pre-fix code (not just pass against the new code):

1. **A complete oversized line bypassed the cap entirely** (`protocol.js`). The cap
   was only ever measured against the *unterminated remainder*, so
   `push(<maxBytes+1 bytes> + "\n")` returned `overflow: false` and handed the whole
   oversized line to `JSON.parse`. `LineFramer` now enforces `maxBytes` as a
   per-line cap on every line, terminated or not.
2. **Overflow did not guarantee prompt closure** (`server.js`). The destroy was
   chained off the overflow frame's write callback, which can stay pending
   indefinitely against a peer that isn't draining — leaving the connection open
   exactly when it most needs to be gone. The write is now best-effort with a
   bounded `OVERFLOW_CLOSE_GRACE_MS` (50ms) timer that cuts regardless, and the
   socket is `pause()`d immediately.
3. **Buffering could grow past the bound before the check ran** (`protocol.js` +
   `server.js`). `Buffer.concat` appended the whole incoming chunk *before* the size
   check, and the server had no flag to stop processing later chunks. The framer now
   scans the chunk in place and refuses to retain anything oversized; overflow is
   terminal (the framer is poisoned — emits nothing, retains nothing, keeps
   reporting overflow); and the server sets a per-connection `overflowed` flag that
   short-circuits every subsequent `data` event.

Also fixed from the same review: **finding 7 (minor)** — a successful `listen()`
left its one-shot `error`-rejecting listener attached forever; it's now removed on
success.

**Behavior change worth knowing:** `MAX_LINE_BYTES` (256 KiB) now caps *complete*
commands too, where previously any size was accepted as long as it ended in a
newline. That is the intended fix, but it means a single command carrying a payload
over 256 KiB (a very large `sendInput` prompt, say) is now refused with the
connection closed. If a real caller needs more, raise `maxLineBytes` deliberately at
the `createIpcServer` call site rather than by weakening the cap.

Still open from that review (should-fix, not blocking, NOT yet fixed):

- Duplicate correlation IDs are accepted; the client's `pending` map overwrites the
  first waiter, so one promise can hang. Needs per-connection in-flight-id rejection
  server-side, or uniqueness enforcement in `client.js`.
- Closing a peer does not cancel its active `observe` iterator — `adapter.observe()`
  stays blocked and its listener stays registered, so peer churn leaks
  subscriptions. This one is best fixed as part of Group 5's teardown wiring, which
  already owns one-consumer-per-run.
- Unsolicited frames (overflow notice, shutdown notice) use `id: null`, which is
  inconsistent with the "every frame echoes the request id" claim above.

## Honest caveats captured during testing

1. On macOS, a killed peer with no unread backlog produces a clean `close`, not an
   `error` — genuine `EPIPE`/RST requires real backpressure, which the test builds
   deliberately.
2. Under an aggressive flood, the overflow error frame isn't always delivered before
   the connection is cut (OS-level RST-discard), though the bound and the actual
   disconnection are always proven regardless.

## Stub boundary — RESOLVED in Group 5, differently than expected

The plan was to swap the `persistence` and `adapter` constructor arguments for the real
modules. That is *not* what happened, and the actual answer is better: `server.js` gained a
`commands` map (`cmd` name -> handler), and `supervisor/runtime/supervisor.js` injects its
whole command surface through it. So this file now dispatches without knowing what a run or
a database is, and the persistence/adapter arguments never became load-bearing.

`persistence-stub.js` and `mock-adapter.js` survive only as `createIpcServer` **defaults**,
so `ipc/test/` can keep exercising wire behavior with no database and no harness installed.
Both headers now say so. Nothing in the production path (`ipc/daemon.js`) reaches them.

## Two Group-5 changes to this directory

Both were should-fix items from review round two, deferred to Group 5 and now closed. Full
detail and the mutation evidence live in `supervisor/runtime/FINDINGS.md`.

1. **Duplicate in-flight correlation IDs are refused.** Each connection tracks its
   in-flight ids; a second command reusing one gets an error naming the command still
   running. The *client's* `pending` map is still last-writer-wins, so this server-side
   refusal is what actually protects a caller — worth knowing if you touch `client.js`.
2. **A peer's `observe` iterator is cancelled on disconnect.** Each connection owns an
   `AbortController` aborted in `socket.on("close")`, passed to handlers as `ctx.signal`.
   The shape underneath this changed too: an `observe` connection is no longer the run's
   event *consumer* (the supervisor's pump is), so a disconnect can no longer stop a run.

## Open item, not implemented

`SO_PEERCRED`/`getpeereid` uid-check on socket accept (listed in TODO.md Group 3) —
Node has no built-in API for it. Flagged for a follow-up (likely a small native
addon or a documented deferral), not silently dropped.
