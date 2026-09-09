# supervisor/runtime — findings (Phase 1, Group 5: integration)

What this directory is: the layer that makes the supervisor a *supervisor* rather than a
collection of working parts. Groups 1-4 built a database, a lock, a socket protocol, and
two harness adapters, each correct in isolation. Group 5 is the composition, plus the
lifecycle work that only becomes possible once real processes and a real schema are on
both ends of it.

Files: `procinfo.js` (OS process identity), `spawn.js` (managed spawn + group kill),
`event-pump.js` (one consumer per run, fan-out to many), `reconcile.js` (startup
reconciliation + `reap`), `supervisor.js` (composition root and command surface).

Everything below is a mechanism plus how it was verified. Where a claim is a measurement,
the number is from this machine (darwin 25.6.0, Node on `process.execPath`), not an estimate.

---

## 1. The gap this closed, stated exactly

PLAN.md said, verbatim, under reconciliation:

> **Known gap, explicitly not yet closed**: neither adapter currently spawns its child
> detached with the supervisor owning the process group — which is *why*
> `orphaned-unmanaged` processes [...] keep running, unmanaged and unkilled.

That gap had a second half nobody had named: even with ownership fixed, `orphaned-unmanaged`
was a **dead-end state reachable only by `list`**. There was no `reap`, and routing lived
only in memory, so a run created before a restart could be *described* and never *acted on*.
Both halves are closed here, and the closing order matters — ownership first (`spawn.js`),
then the two things that consume it (`reconcile.js`, `supervisor.js`).

## 2. Process-group ownership is verified, not assumed

`spawnManaged()` spawns with `detached: true` and then reads the child's own pgid back out
of the OS (`ps -o pid=,pgid=,lstart=`). It resolves only when `pgid === pid`; when it does
not, **it kills the child it could not own** and rejects. The supervisor never records an
unverified identity: an unverified row keeps NULL pid/pgid/lstart rather than being filled
in with what we asked for, because a pid recorded without a verified start time is a pid a
later `reap` would kill on pid alone.

Measured, `runtime/test/integration.test.js` case 1: the spawned child's persisted
`process_group` equals its own pid, does not equal the supervisor's pid, and its persisted
`proc_lstart` is byte-identical to what `ps` reports for it afterwards.

## 3. `proc_lstart` is the pid-reuse guard, and it earns its column

pids roll over. A recorded pid that is alive again as an unrelated process verifies *live*
on pid alone — so a supervisor that reaps on pid alone eventually kills a stranger's
process. `reconcile.js` refuses: a start-time mismatch classifies the run `lost` and kills
nothing.

Verified by `reconcile.test.js` case 3, which persists a deliberately wrong
`lstart` ("Mon Jan  1 00:00:00 2001") against a **real live pid** and asserts that the live
process is still running after the reap attempt. Mutation-checked: deleting the lstart
comparison makes that case fail with "a start-time mismatch is a different process".

## 4. Two refusals to kill, both load-bearing

1. **pid reuse** (above).
2. **shared process group.** `opencode serve` is pooled per cwd (adapter finding S4), so
   several runs legitimately record the same pgid. Killing that group to end one run kills
   its siblings. `reap` asks the *database* — not adapter memory — whether any other open
   run shares the pgid (`listOpenRunsSharingProcessGroup`), and if so kills nothing,
   ending only that session via the adapter. The query is deliberately answered from the
   database because after a restart the adapters hold no handles at all, which is exactly
   when a reap is most likely to be attempted.

`reconcile.test.js` case 6 puts two open runs on one real pgid, asserts the reap is
refused, asserts the sibling stays open and the process survives, then asserts the reap
succeeds once the run is exclusive. Removing the shared-group check makes it fail with
"reap must refuse to kill a shared process group".

## 5. `finished` is never written by reconciliation

Three outcomes, not two: `lost`, `orphaned-unmanaged`, `finished`. The first two are the
only ones reconciliation may write; `finished` comes solely from the adapter's own
completion path (`supervisor.js`'s `onEnd` hook). `classifyRun` returns `outcome: null`
for a live run that still has a handle, which keeps "reconciliation never ends a healthy
run" an explicit branch rather than an emergent property.

`reconcile.test.js` case 7 asserts the reconciled reasons are exactly
`["lost", "orphaned-unmanaged"]` and that `reconcileRun(db, id, { exitReason: "finished" })`
throws.

## 6. The event pump: one consumer per run, whatever the clients do

The pre-Group-5 model consumed the adapter stream from inside the `observe` command
handler, which produced three concrete defects:

- **nothing was persisted unless a client happened to be watching.** A run nobody
  observed left an empty `event_log`.
- **two clients meant two adapter consumers**, so every event was persisted twice — and
  against Claude Code's single shared read cursor, the two consumers *split* the stream
  between them instead of each seeing all of it.
- **a disconnecting client tore down the run's only consumer**, losing everything after it.

`event-pump.js` inverts this: the supervisor attaches one consumer per run at `start()`,
persists each event exactly once, and `subscribe()` hands each client its own cursor over
a bounded buffer. Buffer eviction is reported as an explicit `{ gap, fromSeq }` frame
rather than a silent hole. Derived status fails closed: an unrecognized `turn.end.status`
derives `"error"`, never "probably fine".

Measured, `integration.test.js` cases 2 and 3: four events persisted with **zero**
subscribers; then two concurrent `observe` clients each replay all four, id-correlated,
while `event_log` still holds exactly four rows.

The mutation that proves case 3 is the interesting one — reverting the `observe` handler to
consume the adapter directly (the old model) makes `event_log` hold **12** rows for the
same four events.

## 7. Routing survives a restart because it is a cache, not a store

`harnessOf(runId)` reads memory first and falls through to the `runs.harness_id` column. On
boot, routing is rehydrated from `listOpenRuns()` **before** reconciliation runs, because
reconciliation's `hasHandle` check routes through `harnessOf`.

`integration.test.js` case 8 simulates a crash the only honest way: the fake adapter's
`_forgetAllHandles()` drops every handle **without killing anything**, which is precisely
what a supervisor crash looks like from the database's point of view (rows open, processes
alive). A second `createSupervisor` over the same database then routes a run it never
started, classifies the survivor `orphaned-unmanaged`, and *reaps it* — the dead-end state,
finally not a dead end. Making `harnessOf` memory-only makes that case fail.

## 8. Teardown is bounded at every step

Order matters: stop consuming (so no event arrives mid-dispose), then kill the harness
processes including pooled `opencode serve` servers, then close the database last so the
disposal path can still write. Every step is raced against a hard timer. Sockets are
**destroyed**, never waited on — Group 3 proved (finding S11) that `server.close()`'s
default wait-for-natural-close hangs forever against a long-lived `observe` stream.
`disposeServer` also deletes the pool entry *before* killing, so a concurrent `start()`
cannot be handed a server that is already being killed.

Measured, `integration.test.js` case 9, with an open `observe` subscription held: teardown
completed in **2056 ms** (dominated by the deliberate `graceMs` before SIGKILL escalation),
no socket left tracked, and the harness process group verifiably gone.

## 9. How the tests were verified (there is no "pre-fix" version)

The standing project rule is that a regression test must be *observed* failing against the
broken code. Group 5's code is all new, so there is nothing to revert to — the equivalent
discipline is **mutation testing**: break each mechanism deliberately, one at a time, and
confirm the test that claims to protect it fails, *and fails at the right assertion*.

Integration test, 7 mutations, all caught:

| Mutation | Caught by | Symptom |
| --- | --- | --- |
| child inherits the supervisor's process group | case 1 | "must lead its OWN process group" |
| no supervisor-owned consumer | case 2 | timed out waiting for `turn.end` with no subscriber |
| each subscriber consumes the adapter itself (old model) | case 3 | `event_log` has 12 rows, not 4 |
| duplicate in-flight correlation id accepted | case 4 | timed out waiting for the rejection |
| `harnessOf` memory-only | case 8 | "must be rehydrated from runs.harness_id" |
| teardown skips adapter disposal | case 9 | harness process outlived the supervisor |
| teardown notifies but never destroys sockets | case 9 | shutdown hit its hard timeout |

Earlier in the group: 4 mutations of the pump (shared cursor, silent eviction, fail-open
status, unbounded `closeAll`) and 4 of reconcile (no lstart check, no shared-group refusal,
orphan conflated with lost, asks left open) — all caught.

One methodological note worth keeping: the first attempt at mutation-checking the pump's
`closeAll` bound used `timeout(1)`, which **does not exist on macOS**, so the check
silently proved nothing. Replaced with `perl -e 'alarm shift; exec @ARGV'`. Relatedly, a
hung top-level `await` surfaces as **Node exit 13 with no PASS line** — a real failure, but
one that looks nothing like an assertion error.

A second note: one mutation (renaming `forceCloseAll`) was "caught" for the wrong reason —
a ReferenceError, not the behavior under test. Re-done as a behavioral mutation (notify but
never `destroy()`), which fails on the hard-timeout assertion as intended. A mutation that
crashes the module proves nothing about the test.

## 10. Deliberate asymmetries, kept visible

`processIdentity()` reports `ownership: 'run-owned'` for Claude Code and `'shared-server'`
for OpenCode, and `clearContext`/`resume` pass the adapter's own ack back **verbatim**
rather than flattening it to a boolean. Claude Code's clear mints a new session id;
OpenCode's only summarizes. These are not equivalent operations and the API does not
pretend they are.

## 11. Review round three: 13 defects found by other models, and fixed (2026-09-06)

Group 5 was reviewed by `luna` and `terra` independently, then consolidated by Claude Sonnet,
then adjudicated here. Full reasoning — including what was rejected and why — is
`review-three/group5-verdicts.md`; the raw reviews and the consolidation sit beside it. What
changed in this directory:

- **`spawn.js`** — a `'error'` listener on the child (a failed spawn crashed the whole daemon:
  reproduced with `command: "definitely-not-a-command"`), and the identity-capture timeout now
  **kills** the child instead of abandoning it. Abandoning manufactured the exact orphan this
  module exists to prevent: no pid recorded → `classifyRun` says `lost` without asking the OS
  → `reap` short-circuits on the NULL pid → a live process group nothing can find.
- **`reconcile.js`** — `reap` no longer writes a terminal row on an outcome it didn't achieve.
  Three gates now: a failed group kill leaves the row **open**; the shared-group branch closes
  the row only when `adapterStop` actually succeeded; and a **third refusal** was added for an
  *incomplete* recorded identity. That third one is not hypothetical — schema v1
  (`0001_initial.sql`) had `pid` and `process_group` and no `proc_lstart` column, so every
  pre-0002 row can verify on pid alone, which is the pid-reuse footgun by another road. Both
  reviewers and the consolidator got that one wrong in opposite directions; see the verdicts.
- **`event-pump.js`** — gap frames are re-checked *inside* the fan-out loop (a subscriber
  parked at a `yield` while eviction passed its cursor silently skipped events; the outer-loop
  check cannot catch it, because by then the cursor has caught up); `bufferLimit` is validated
  at construction; `closeAll`'s timer is cleared (an abandoned one held the event loop open for
  its full budget — measured 3058 ms → 44 ms); `closeRun` invokes the source's `return()`; and
  `resetRun()` exists for the resume path.
- **`supervisor.js`** — `resume()` re-attaches the pump and bumps `runs.generation` (without
  it, a resumed process's events were consumed by nobody: `attach()` is a no-op once
  `state.consumer` is set); `reap()` closes the pump only when the run actually ended; and
  `shutdown()` gives adapter disposal its **own** budget instead of whatever the pump wait
  left, so the step that kills harness processes cannot be skipped before `closeDb()`.
- **`db/index.js`** — `endRun` is first-writer-wins in SQL (`WHERE ended_at IS NULL`), matching
  `reconcileRun`, plus `bumpRunGeneration`.

**The `endRun` guard exposed a decision nobody had made.** With it in place,
`integration.test.js` case 7 went flaky: the kill makes the adapter stream end, the pump
derives `error` → `"errored"`, and that raced reap's truthful `"reaped"`. The old unguarded
UPDATE hid it by usually overwriting the hook. `supervisor.js` now holds an explicit
`terminalIntent` for the duration of a deliberate `stop`/`reap`, and `onEnd` prefers it over
the derived status — deliberate cause beats derived consequence. The map save/restores rather
than set/deletes, because the two nest (`reap` holds `"reaped"` while ending one session of a
shared group with an inner `"stopped"`).

Verification: `runtime/test/review-three.test.js`, 13 cases, and **each fix was reverted
individually and the case that protects it observed failing** — table in the verdicts file.
One revert was discarded as invalid first (case 3 reused a shared-pgid fixture, so the wrong
refusal answered), which is the same trap as Group 5's ReferenceError mutation.

Two test seams were added deliberately and are visible in the signatures:
`reap({ killGroup })` and `spawnManaged({ identityTimeoutMs, readProc })`, both defaulting to
the real implementations. The branches they reach are otherwise unreachable from a test: the
only pgid a normal user is guaranteed EPERM on is 1, and `process.kill(-1, sig)` is a
broadcast to every process the user owns.

### Partially fixed, stated as such

`closeRun` cancelling the adapter iterator is **as complete as the language allows**.
`iterator.return()` is the cancellation contract and is now invoked, but `return()` on an async
*generator* suspended inside an `await` (rather than at a `yield`) is queued until the
generator resumes — so a generator blocked forever on a socket read cannot be cancelled at
all. Found the honest way: the first version of test case 8 used a generator and timed out
*with the fix applied*. Closing this fully needs an `AbortSignal` parameter on both adapters'
`observe()`, which is a Group 4 surface change.

## 12. Group 6: crash & concurrency validation (2026-09-06)

Three suites, wired into `npm run test:crash` (and into `npm test`). All three assert on every
claim; none of them can exit 0 with a broken one.

| Suite | What makes it real | Cases |
|---|---|---|
| `test/crash-recovery.test.js` + `test/_crash-victim.js` | a **separate OS process** running a real supervisor under continuous write load, killed with **SIGKILL** — no `finally`, no `closeDb`, no adapter disposal, an un-checkpointed WAL left on disk; its detached children survive it | 8 |
| `test/concurrency.test.js` | eight concurrent starts, concurrent input load across all of them, three concurrent observers on a run being written to, and deliberately raced terminal writers — all over the **real socket**, which is the authoritative mutation path | 7 |
| `test/daemon-crash.test.js` | the **real `ipc/daemon.js`**: real single-instance lock, real socket, crashed and restarted, with a third daemon started against the live one | 6 |

Three things the crash suite proves that the in-process restart test (section 9, integration
case 8) structurally cannot: that a SIGKILLed writer leaves a recoverable database (WAL
recovery, `integrity_check`, no unparseable payload, nothing committed lost), that the lock
and socket are recovered by the *next* daemon rather than by a cooperative teardown, and that
the three-outcome model holds on data written by a process that no longer exists.

**Deliberate scope note:** the daemon suite seeds its runs directly into the database with
real detached children instead of starting them through the real adapters, so it needs neither
`claude` nor `opencode` installed. That is also the interesting case — a daemon reaping a run
it holds no handle for is the `orphaned-unmanaged` path end to end.

### The defect Group 6 found: a zombie-only process group was reported as "survived the kill"

Found by case 5 (two concurrent reaps of one run), not predicted. Mechanism, measured on
macOS 25.6:

* a process that has exited but not yet been waited for is a **zombie**; `ps -o stat=` shows `Z`
* `kill(-pgid, 0)` on a group of nothing but zombies **succeeds** — so `isProcessGroupAlive()`
  says "alive"
* `kill(-pgid, SIGTERM)` on that same group returns **EPERM**, not ESRCH

`killProcessGroup` therefore returned `{ killed: false, note: "EPERM" }` for a group that was
definitively dead. That is not cosmetic: round three made `reap` gate its terminal write on
exactly this flag, so reap logged "process group SURVIVED the kill", left the run row open, and
went on offering to reap a process that no longer existed. The escalation loop had the same
bug from the other side — it would burn the entire `graceMs` waiting for a zombie to disappear
and then SIGKILL nothing.

Fixed by teaching the primitives that a zombie is not running: `procinfo.listProcessGroupStates()`
and `procinfo.isProcessGroupLive()` (portable `ps -A` + pgid filter — BSD's `ps -g` selects by
process group but procps' `-g` selects by *group name*, so the `-g` form silently answers a
different question on Linux), consulted by `killProcessGroup` at all three decision points.
`isProcessGroupAlive()` is unchanged and now documents that it counts zombies, because it is
still the right cheap first question.

The pre-fix behavior was observed failing directly (`reaped: false, note: "EPERM"`). But case 5
only reaches the zombie window when the few milliseconds before libuv waits happen to overlap
the second reap — re-running the mutation proved that, by passing. So **case 6 is the
deterministic form**: a `perl` parent never waits for its child, so the zombie persists as long
as the test needs it, and the case asserts all three measurements above before calling
`killProcessGroup`. A test that only sometimes exercises its mechanism is the trap this project
has already hit twice (Group 5's ReferenceError mutation, round three's shared-pgid fixture).

### Mutation evidence

There is no "pre-fix" version of a validation suite, so the same rule as section 9 applies:
break the mechanism, watch the case that claims to protect it fail. Every mutation below was
applied to the *runtime*, not the test, and reverted afterwards.

| # | Mutation | Caught by |
|---|---|---|
| M1 | `classifyRun` returns `lost` for a live, unmanaged process | crash 3 (orphan set) |
| M2 | `reconcileOnBoot` stops closing open asks | crash 6 |
| M3 | reconciliation examines closed rows too (`listOpenRuns` → all rows) | crash 8 (idempotency) |
| M3b | M3 **plus** dropping `reconcileRun`'s `ended_at IS NULL` guard | crash 4 — the pre-crash `finished` run is re-classified `lost` |
| M4 | `recordEvent` truncates `payload_json` (a simulated torn write) | crash 2 |
| M5 | `endRun` loses its first-writer-wins guard | concurrency 4 (reason became `finished`) |
| M6 | the pump's `onEnd` ignores `terminalIntent` | concurrency 4 (reason became `errored`) |
| M7 | `spawnManaged` spawns without `detached: true` | concurrency 1 |
| M8 | `isProcessGroupLive` counts zombies as live (the pre-fix answer) | concurrency 6 |
| M9 | the daemon unlinks the socket *before* acquiring the lock | daemon 5 (a fresh connection fails) |
| M10 | `lock.js` treats every recorded pid as live (no stale takeover) | daemon 4 |
| M11 | the pump skips persisting one event type | concurrency 2 |
| M12 | subscribers start at the live edge instead of the buffer | concurrency 3 |

Two of these corrected the *tests* rather than the runtime, which is the point of doing them:

* M3 was expected to be caught by the `finished`-row case and was caught by the idempotency
  case instead — so the guard that actually protects `finished` is `reconcileRun`'s
  `AND ended_at IS NULL`, not `listOpenRuns`. M3b shows what it takes to break it.
* M9 passed at first because the case checked an **already-connected** client. An established
  Unix-socket connection survives its path being unlinked, so that assertion could never have
  caught it; the case now opens a fresh connection, which is what a TUI client would do next.

One assertion was also corrected against the design: case 5 originally required that exactly
one of two concurrent reaps close the row. Neither did — killing the child ends its stream, so
the pump's `onEnd` hook can land the terminal write first, carrying the deliberate `reaped`
intent. The invariant is "closed once, with the deliberate reason", not "closed by reap".

## 13. Both Group 6 findings, decided and closed (migration 0003, 2026-09-06)

Group 6 surfaced two questions rather than bugs, so they were put to three independent models
(`sol`, `luna`, `terra` via Bedrock) and then decided. All three picked the same shape for the
first, for the same reason, and it is what shipped.

### `orphaned-unmanaged` is now a lifecycle state, not a terminal outcome

The problem: reconciliation wrote `ended_at` + `exit_reason = 'orphaned-unmanaged'` for a
process it had *just verified to be running*. Its own input set is `WHERE ended_at IS NULL`, so
that row could never be examined again — a live, unmanaged process was classified exactly once
and then invisible to every later boot, still consuming CPU and tokens. Two further costs found
while fixing it:

* the closed row dropped out of `listOpenRunsSharingProcessGroup`, so reaping a *sibling* run on
  a pooled `opencode serve` pgid would group-kill the orphan's still-live session, unnoticed
* history could not tell a reaped orphan from one still running: `reap` deliberately does not
  overwrite `exit_reason` on an already-closed row, so nothing recorded that the kill happened.
  "List the orphans nobody has dealt with" was not a query anyone could write

What shipped (migration `0003_run_lifecycle_and_orphans.sql`):

| Change | Why |
|---|---|
| `runs.lifecycle` (`'managed'` \| `'orphaned-unmanaged'`), `ended_at` stays NULL | `ended_at` now means what it says: execution actually ended. An orphan has not ended, so it stays in reconciliation's input set and is re-examined every boot |
| `runs.reaped_at` | "the row was closed" and "we killed the process" are different facts |
| `orphan_sightings` (append-only, `kind: new \| repeat`) | a journal, never state — so "we keep getting orphans lately" has a history behind it, and a future watcher process has something to reason about. Nothing reads it back as truth |
| `supervisor.orphans()` + an `orphans` wire command | the shortcut: every live orphan by title, cwd, pid, pgid, first/last seen, sighting count |
| `reconcileOnBoot` returns `stillOrphaned` separately from `orphaned` | a repeat sighting is not a new one, and `daemon.js` counts BOTH in its boot summary — reporting only new ones would print "0 orphaned-unmanaged" over a live orphan, the same invisibility bug one layer up (found by `daemon-crash` case 4 failing) |

Terminal transitions are now real: an orphan becomes `lost` when its process dies (`crash-recovery`
case 8) or `reaped` + `reaped_at` when we kill it (case 9). PLAN.md section 4's three sentences
were amended to match — the definition of "not already terminal", the `orphaned-unmanaged`
bullet, and the asks sentence.

### Unanswered asks on a naturally completed run get a five-minute grace

Before: `closeOpenAsksForRun` was called by reconciliation and by `reap`. Not by `stop` — which
touched `runs` and ignored `asks` entirely — and not by the completion path, so a run that
finished normally left its approval question open forever, blocking its task.

The rule now, and the reason it is keyed on the *reason* rather than the code path: killing a
run ends its adapter stream, so the terminal write frequently comes from the pump's `onEnd` hook
carrying the deliberate intent (Group 6, concurrency case 5), which means "who wrote the row"
answers nothing.

* **run ended by itself** (`finished` / `errored` / `interrupted`) → `asks.auto_close_at =
  now + 5 minutes`, ask stays answerable; a human answer during the grace wins; the sweep then
  closes it as `supervisor:auto-close`, distinguishable from a human answer
* **we ended it** (`stop` / `reap`) or **reconciliation derived it** (`lost` /
  `orphaned-unmanaged`) → closed immediately: a human is already acting, or nothing is left that
  could answer

The deadline is **persisted, not an in-memory timer**, and `boot()` sweeps as well as the 30s
interval — a supervisor SIGKILLed mid-grace must not strand the ask, which is the very failure
being fixed (`asks` case 4 rewrites a deadline into the past and proves a brand-new supervisor's
boot honours it). `endRun` + the ask bookkeeping are one `db.transaction()`.

Implementing this exposed a defect in the first version of the fix: the hook scheduled a grace
for *every* reason, so a reaped run's ask sat open for five minutes despite the run being dead.
Caught by `asks` case 5, which is why that case exists.

### Mutation evidence for 0003

| # | Mutation | Caught by |
|---|---|---|
| M13 | `markRunOrphaned` also writes `ended_at` (the pre-0003 behavior) | crash-recovery 3 |
| M14 | reconciliation stops appending sightings | crash-recovery 3 |
| M15 | `endRun` ignores `reapedAt` | crash-recovery 9 |
| M16 | the grace is given for every reason, including `stop`/`reap` | asks 5 |
| M17 | `scheduleAskAutoClose` loses its `auto_close_at IS NULL` guard | asks 7 |
| M18 | the sweep loses its `resolved = 0` guard | asks 2 (a human answer was overwritten) |
| M19 | `boot()` stops sweeping | asks 4 |
| M20 | `daemon.js` omits `stillOrphaned` from its summary | daemon-crash 4 |
| M21 | the orphan view filters only on "row is open", ignoring `lifecycle` | concurrency 1 — **after** it was retargeted |

M21 is the one worth keeping: it *passed* at first. In the crash suite every open row happens to
be an orphan, so nothing there could distinguish "filter by lifecycle" from "every open run".
The assertion that kills it had to go where healthy managed runs exist — eight of them, in
concurrency case 1. Same lesson as the zombie case in section 12: a suite can assert a property
it never actually exercises.

## 15. Migration 0003's own code review (2026-09-07)

Three independent reviews (`luna`, `terra`, `sol`), same prompt, no shared context.
**`review-0003/verdicts.md` is the authoritative record** — what was fixed, what was refuted, and
which stated mechanisms were wrong. Result: **11 fixed, 1 refuted, 1 accepted as narrow and made
visible, 3 test claims corrected.** Regression suite: `runtime/test/review-0003.test.js` (7 cases)
plus 2 new `asks` cases, every one written against the pre-fix code and observed failing.

The three that mattered most, all reproduced before being fixed:

1. **`resume()` left the run row terminal** — so a resumed, genuinely live process was invisible:
   `listOpenRuns()` could not see it, reconciliation never examined it, `list()` never showed it,
   and generation 2's own completion write was rejected by `endRun`'s guard (which also meant its
   asks were never scheduled). The same invisible-orphan class of bug 0003 was written to remove,
   arriving by a different road. `reopenRun()` fixes it.
2. **`start()` spawned before persisting** — an unknown `workerId` tripped the `runs.worker_id`
   foreign key and left a detached child running with *no row at all*. An error path manufacturing
   the exact orphan this module exists to prevent. There is now a compensating `adapter.stop()`.
3. **`answerAsk()` had no `resolved = 0` guard** — found by all three reviewers. Every other
   closing statement in `db/index.js` is guarded; this one was not, so an answer arriving *after*
   the grace expired rewrote `supervisor:auto-close` into a human answer. "An answer during the
   grace wins" only means something if an answer after it does not.

Plus: the shared-group reap path never closed asks; a successful kill could fail to record
`reaped_at` (two verified paths); `reconcileRun` could still write the old terminal orphan form;
two reconciliation write-pairs were not transactions; the sightings journal and its read were
unbounded; and an ask created after its run ended was unreachable by every mechanism forever.

**One reviewer claim was refuted and produced a better finding.** luna's "orphans sharing a pgid
are permanently unreapable" did not reproduce as written — the first reap's `adapterStop` silently
"succeeded" against an adapter holding no handle, closing the row and letting a later reap kill
the group. That silent success was a worse defect than the one claimed, and it is adapter-specific:
Claude Code's `stop()` **throws** for an unknown runId (genuine deadlock), OpenCode's returns
**silently** (row closed over a live session). Both are handled now: `sessionEnded` requires a
handle, and an all-orphan group is killable, so the deadlock has an exit.

**The mutation harness itself lied once**, which is worth more than any single finding: a shell
helper verified "did this mutation apply?" with `grep -F "$replacement"`, and for a multi-line
replacement `grep -F` matches when *any* line matches — so an unapplied mutation looked applied,
its test passed, and the result read as "this fix is not load-bearing". Caught by probing the
supposedly-mutated file and finding it unchanged. The harness is now a script that asserts the
pattern occurs exactly once and that the file actually changed. A mutation test that cannot fail
proves as little as an assertion that cannot fail.

## 16. Still open

- ~~**The state directory is not one directory.**~~ **Fixed 2026-09-07.** `supervisor/paths.js` is
  now the single resolver: database, socket and lock all live under one root
  (`SUPERVISOR_STATE_DIR`, default `~/.custom-team-dashboard/supervisor/`), with `CTD_STATE_DIR`
  kept working as a legacy alias. The lock moved rather than the database — a lock is ephemeral, a
  database is a migration. `acquireLock` carries a **transitional** refusal: a LIVE pid holding the
  old `~/.local/state/...` lock still blocks startup, because otherwise the tidy-up itself would
  permit two supervisors each holding a lock the other cannot see. Delete that check once no
  pre-2026-09-07 daemon can still be running. Evidence: `lock/test/state-dir-unified.test.js`, and
  `runtime/test/daemon-crash.test.js` now needs only ONE env var, which is what proves it.
- **The reap TOCTOU window** (accepted as narrow, not fixed): the sibling check is a point-in-time
  read and the kill takes up to `graceMs`, so a run can be recorded onto that pgid mid-kill. The
  correct fix is a reservation at the adapter's pooling boundary — Phase 2 work, with the pooling.
  Meanwhile it is no longer silent: reap re-reads the sibling set after a successful kill and
  returns `collateralRisk`, asserted by `review-0003.test.js` case 7.
- **A v1-shaped run row (pid, no `proc_lstart`) can become an orphan that cannot be reaped.**
  `verifyProcIdentity` does not compare fields it was not given, so such a row verifies alive;
  `reap` then refuses it (correctly — killing on pid alone is the pid-reuse footgun) and does not
  mark it lost, so it reappears every boot. No real database has that shape (0002 shipped with
  Group 5, before any real use), so rather than invent a force-kill the orphan view now reports
  `identityComplete: false` (`review-0003.test.js` case 5).
- `ipc/persistence-stub.js` and `ipc/mock-adapter.js` remain as `createIpcServer`
  *defaults*, now annotated as test fixtures rather than integration placeholders. They
  exist so `ipc/test/` can exercise wire behavior with no database and no harness
  installed. Nothing in the production path reaches them.
- **Pump state for completed runs is never released** (review round three, deferred with a
  reason). `stateOf()` entries are created on first attach and removed only by `closeAll()`.
  Not fixed yet because the obvious fix breaks a contract: that state is what `status()` and
  `list()` read for `derived`, and PLAN.md section 4 says status and token telemetry are
  *derived, never asserted* — deleting the entry on completion makes a just-finished run report
  `derived: null`. The correct fix is bounded retention (drop the buffer at completion, keep the
  counters, evict those only once replay from `event_log` exists), and replay is Group 6 work.
- **Full iterator cancellation** needs an `AbortSignal` on both adapters' `observe()` (see
  section 11, "Partially fixed").
- Crash/concurrency validation (Group 6) is what actually gates Phase 2: the supervisor is
  now killable in interesting ways, which it was not before.

## 17. Phase 2: the approval round trip (2026-09-07)

The first piece of Phase 2's vertical slice, and the piece ROADMAP called its risky part.
**Read `../adapters/FINDINGS.md` first** — it records the measurements this is built on, and
one of them corrects PLAN.md rather than adding to it.

### What changed, and where

- `db/migrations/0004_asks_round_trip.sql` — a table rebuild of `asks` (SQLite cannot ALTER a
  column's nullability). `task_id` becomes nullable; `kind`, `payload_json`,
  `harness_request_id`, `harness_tool_use_id`, `generation`, `answer_json`, `decision`,
  `answered_at` and `delivery_error` are added. Safe inside `migrate.js`'s `BEGIN IMMEDIATE`
  **because nothing references `asks`** — do not copy the pattern onto a referenced table
  without re-checking that.
- `db/index.js` — `getAsk`, `listPendingAsks`, `listUndeliveredAnswers`, `markAskDelivered`,
  `withdrawAsk`, `taskIdForRun`; `createAsk`/`answerAsk` extended; the two closing paths
  (`closeOpenAsksForRun`, `sweepExpiredAsks`) now write `answered_at` instead of stamping a
  `delivered_at` for a delivery that never happened.
- `adapters/claude-code/adapter.js` — the host side of the control channel:
  `--permission-prompt-tool stdio`, an `initialize` greeting, `_parkedRequests`,
  `approval.request` / `approval.withdrawn` / `approval.answered` events, `answerApproval()`,
  `pendingApprovals()`. The old after-the-fact `permission_denied` mapping is renamed to
  `approval.auto-denied`, because a UI that showed it beside a live request would offer a
  button for a decision already made.
- `runtime/supervisor.js` — the pump's `onEvent` hook turns a parked request into an ask,
  `answerAsk()` persists then delivers, `deliverPendingAnswers()` retries on boot, `asks()`
  lists what is blocked, plus `asks` and `answerAsk` wire commands.

### The four decisions worth understanding before touching this

1. **Answered and delivered are separate facts, in that order.** PLAN.md section 7 requires
   the answer to be durable before anything acts on it. So `answerAsk` writes the row, and
   delivery is a second, failable step: a failure records `delivery_error` and leaves the row
   in `listUndeliveredAnswers` rather than marking it delivered. The queue excludes runs that
   have ended and requests the harness withdrew, so it drains instead of accumulating rows
   nobody can act on — the same self-draining discipline 0003 had to learn for orphans.
2. **A parked approval is NOT terminal.** The run keeps `ended_at IS NULL` because it is
   waiting, not finished. Closing it would be migration 0003's invisible-orphan bug arriving
   by a third route (after `resume()` and `start()`'s error path). Mutation M6 exists for it.
3. **A tool approval is never answered by guessing.** No boolean, no decision: `answerAsk`
   throws and the ask stays answerable. This is the one default that would quietly defeat the
   entire control plane, and it is the kind of default added later to make a caller tidier.
4. **An ask that cannot be recorded gets the request DENIED.** The pump treats an `onEvent`
   throw as non-fatal — correctly, one bad event must not kill a stream — but a parked
   request has no deadline of its own, so logging and moving on would leave a worker stopped
   forever with nothing in the database to say why. The fallback returns control to the worker
   with a readable reason.

### Deliberately not done

- **No deadline on a parked approval on a LIVE run.** `asks.auto_close_at` is only set when a
  run ends by itself; a live parked request waits for a human indefinitely, which is what
  PLAN.md section 7 asks for. Now that the harness is known to impose no deadline either
  (measured), this is a real product decision rather than an accident — if it should change,
  change it deliberately.
- **`request_user_dialog` is not implemented and `supportedDialogKinds` is not declared.**
  See `../adapters/FINDINGS.md`: `AskUserQuestion` does not use it, the only kind that exists
  is `refusal_fallback_prompt`, and an undeclared kind degrades to the behavior we already
  have.

### Evidence

- `runtime/test/approval.test.js` — 8 cases against the fake harness, which **parks for
  real** (emits nothing until answered), because a fake that carried on regardless would let
  every case pass while the real CLI deadlocked.
- `runtime/test/_mutate-approval.mjs` — **8 mutations, all 8 caught by an assertion**, each at
  the case that claims to protect it. Two notes from running it:
  - The harness's first "crash vs assertion" discriminator was wrong: it treated "no case line
    printed" as a crash, but a case prints its line only *after* its assertions, so a mutation
    caught by case 1 looked like a crash. It now keys on the failure being an `AssertionError`
    — which is the distinction that actually matters (Group 5's ReferenceError lesson).
  - M7 and M8 initially survived and were nearly recorded as "not covered". Both are now
    covered instead — a new case 7 for the refuse-to-guess guard, and four new cases in
    `adapters/claude-code/test/` for the adapter-level guards the fake harness cannot see
    (it has its own copy of them).
- `runtime/test/real-claude-approval.slice.mjs` — the same round trip against the **real
  `claude` CLI** through the real supervisor: allow (the tool actually ran), `sendInput` for a
  second turn on the same resident process, deny (the operator's reason reached the model
  verbatim), a two-row audit trail with `answered_at <= delivered_at`, and a teardown that
  left no process group. Not in `npm test` — real tokens, real network. Captured run:
  `adapters/claude-code/probe/evidence/06-real-slice-through-supervisor.txt`.

### Three things the real-harness run taught that the fake could not

Each cost a failed run, and each was a defect in the TEST rather than in the code — worth
recording because all three are traps for the next real-harness test:

1. **A denied model works around the refusal.** The first version answered only the request it
   expected; the denial said "use the vendored copy in ./docs instead", so the model reached
   for Bash to go looking, parked a second request, and nothing was listening. Two fixes: the
   script now runs a standing operator loop that answers *every* ask (which is also the more
   faithful model of a human watching a pane), and a refusal must not suggest an alternative —
   a refusal that offers a workaround is an instruction, not a refusal.
2. **Allow before deny.** With deny first, the second turn never parked anything: a model that
   has just been refused reasonably stops trying that tool. The legs had to be ordered so each
   one can actually happen.
3. **A policy set after the loop starts is a race.** The loop's first pass answered with the
   placeholder default, and the assertion then failed on a message the operator never sent —
   which read exactly like a protocol bug for several minutes.

## 18. Phase 2's approval round trip was reviewed, and it needed it (2026-09-07)

Three independent models (`sol`, `terra` via Bedrock at `--variant medium`, then a Claude Sonnet
high-effort consolidation) reviewed the section-17 work. **`review-phase2/verdicts.md` is the file
to read** — it records every verdict and overrides the raw reviews and the consolidation where they
disagree. **12 defects fixed, 1 narrowed with its reachability corrected, 1 consolidator judgement
overruled, 2 defects found by neither model, 3 test-coverage gaps closed.**

The five worth knowing before touching this code:

1. **The unique guard on a parked request spanned process generations.** Keyed on
   `(run_id, harness_request_id)`, it reserved a request id for the whole life of a *logical* run, so
   a resumed process reusing an id collided with the old generation's row, the `UNIQUE` was swallowed
   as a benign pump redelivery, and the new worker was parked forever with no ask row anyone could
   answer. Now `(run_id, COALESCE(generation, -1), harness_request_id)` — `COALESCE` because SQLite
   treats NULLs as distinct in a unique index, which would have left the least-carefully-written rows
   as the only unguarded ones.
2. **A queued stdin write was reported as a completed delivery.** `stdin.write()` is asynchronous, so
   `delivered_at` could be stamped for an answer the CLI never received, with the later `EPIPE`
   arriving as an unrelated diagnostic. `_writeControl` now resolves from the write callback and
   `answerApproval` is async; the parked entry is dropped only after the write is accepted, so a
   failed write leaves the request still answerable.
3. **The redelivery queue could not end, and defaulted to allow.** A reconciled orphan keeps
   `ended_at IS NULL` by design (0003), so its supervisor-closed asks satisfied the queue's predicate
   and were retried on every boot forever — and `deliverAnswer` mapped every decision that was not
   exactly `"deny"` to an **allow**, so such a row would have handed a parked worker an approval
   nobody gave. There is now `asks.delivery_abandoned_at` for "retrying cannot fix this", and
   delivery requires `decision IN ('allow','deny','answered')` in two independent places.
4. **An answer racing a harness withdrawal stranded the row.** The adapter drops the parked entry the
   instant the cancel arrives, so an answer in that window persists and then fails delivery — and
   `withdrawAsk`'s `resolved = 0` guard matched nothing. It now abandons the *delivery* of an
   already-answered row while keeping the human's decision, which is what actually happened.
5. **`resume()`'s event replay created phantom asks — found by neither reviewer.** `pump.resetRun()` +
   `attach()` starts a fresh `observe()`, and both adapters yield from the start of their buffered
   log, so the entire history is replayed. The generation was being read from the run row rather than
   the event, so replayed requests were stamped with whatever generation was current and a resumed
   run showed as blocked on tool calls that had long since completed. Fixed twice over: the generation
   comes from the event, and `stillParked()` refuses to record an ask for a request nothing is waiting
   on. **Anything that reads the pump's event stream must assume replay.**

### Three lessons bigger than the findings

- **A review can only find defects in the files it is given.** The consolidation independently found
  the missing event-shape validation and rated it LOW, reasoning that the CLI would not emit a
  request without an id. True for Claude Code — and `adapters/opencode/adapter.js` already emits
  `approval.request` with a completely different shape, by default, because its config sets
  bash/edit/write to `ask`. That is Group 4's finding B4 again (two adapters diverging on one event
  contract, the supervisor reading one shape against both), and the mis-rating was caused by our
  `PROMPT.txt` listing six files and omitting the other adapter. **When a change touches a shared
  contract, every implementation of that contract goes in the file list.**
- **Overlapping guards make a suite look stronger than it is.** Two of the new cases initially passed
  with their own mechanism removed, because a *different* guard was quietly doing the work
  (`stillParked` and the unique index masked the shape check; taking the generation from the event
  masked the replay guard). Only running the mutations exposed that. Both cases were rewritten to
  reach the state where one guard alone can act.
- **`ps` is a test.** The adapter suite had leaked 29 detached `fake-claude.mjs` processes, the oldest
  running over fifteen hours, on a project whose entire subject is process ownership — because nothing
  ever checked. `stop()`'s SIGKILL escalation is a 3-second timer and the test process exits first.
  The suite now calls `disposeAll()` and asserts no survivor.

  Measured afterwards, one suite at a time: the `runtime/test/` suites do **not** leak when they
  complete. Every other stray seen while building Phase 2 came from a run that was **cut short**, and
  the second way to cut one short is worth writing down because it is a reflex: **piping a test
  through `head` kills it with SIGPIPE before its `finally` runs.** Measured on `concurrency.test.js`
  — a complete run adds 0 survivors, `| head -4` adds 7, and `| tail -N` adds 0 because tail reads to
  the end. The mutation harness's own timeout does the same thing. So before concluding a suite leaks,
  check how the run you are looking at ended.

### Evidence

15 cases in `runtime/test/approval.test.js`; **14 mutations, all caught by an assertion at the case
that protects them** (`runtime/test/_mutate-approval.mjs`, which keys "caught" on an
`AssertionError` rather than on how far the test got — a mutation that crashes the module proves
nothing); 11 cases in the Claude Code adapter suite; the 0004 upgrade-path test; and the real-CLI
slice re-run after every fix
(`adapters/claude-code/probe/evidence/07-real-slice-after-review-fixes.txt`).

## 19. Phase 2: the live pane (2026-09-07)

The reader half of the slice. `supervisor/pane/` — `render.js` (pure), `pane.js` (the client),
`cli.js` (a terminal entry point), plus `test/` and `evidence/`.

**It is a plain socket client.** No database handle, nothing spawned: everything it does goes through
the wire protocol. That is what makes it the same shape as the future TUI pane rather than a
privileged debug tool, and it is why the supervisor had to own the event consumer in the first place
(Group 5) — a pane can attach, detach and reattach while the run keeps working, and two panes can
watch one run because `observe` fans out with a cursor each.

**Rendering is pure, which is the only reason its rules are testable.** `render.js` takes events and
returns lines; it holds no I/O and no socket. Three of its rules are design decisions rather than
formatting, and each is the kind of thing a later tidy-up silently reverses — so each has a case and a
mutation:

1. **An unknown event type is shown, never dropped.** The harness event set grows by design and the
   CLI's own docs say consumers should ignore what they do not recognise — but in a pane a human uses
   to understand what a worker did, *ignore* must not mean *hide*. Unknown events render with their
   payload and their `seq`, the latter being the only way to find them in `event_log`.
2. **A gap is loud.** The pump guarantees eviction is never silent; a pane that quietly skipped
   evicted events would throw that guarantee away at the last hop, the one a human sees.
3. **Only `assistant.delta` coalesces.** Token deltas append to an open prose line so they read as
   prose; every other event is a discrete row, because "what did it do" is the question a transcript
   exists to answer.

**Two things the pane deliberately does NOT infer.** It reads what a run is blocked on from `asks`
rather than from the transcript, because the event says a request happened while the table says
whether it is still outstanding and still `answerable` — a pane that offered an approve button off the
event alone would let a human answer into a void. And it reports `answered` and `delivered`
separately, because an answer that was recorded but never reached the worker means the worker is still
parked.

**Known limitation, stated rather than hidden:** the pane POLLS `asks`. The wire protocol has no
server-initiated ask notification, so a pane learns about a parked request from the transcript
immediately and from `asks` within one poll interval. A push channel is the obvious improvement and
is not in this slice.

### Evidence

- `pane/test/render.test.js` — 10 cases over the rendering rules, no socket, no process.
- `pane/test/pane-e2e.test.js` — 8 cases over a **real Unix socket** with a real supervisor and real
  child processes: replay-on-attach, typed input, the approval round trip through the pane's own
  command grammar, a question answered by one typed line, detach/re-attach **by cursor**, two panes on
  one run, `/interrupt` cancelling a turn without killing the process, and refusals for malformed
  commands.
- `pane/test/_mutate-pane.mjs` — 7 mutations: 6 caught at the case that protects them, 1 recorded as
  surviving with the reason written down (the pane's `answerable` check is a UX guard in front of the
  supervisor-level guard that `approval.test.js` case 12 already proves; isolating it would need a
  flaky socket race).
- `pane/test/real-pane.slice.mjs` — **not in `npm test`** (real tokens): the real `ipc/daemon.js` in
  its own process, a real `claude` run, an approval allowed and then one denied through the pane, and
  detach/re-attach. Captured: `pane/evidence/01-real-pane-slice.txt`.

The mutation machinery moved to `runtime/test/_mutate-runner.mjs` so the approval and pane harnesses
share it — the apply-exactly-once and caught-means-`AssertionError` checks are the part that has
already lied once, and one copy is easier to keep honest.

### One thing the real run taught, which no unit test could

The captured transcript shows the worker volunteering a note about an MCP server needing
authorization — **the spawned session had loaded the developer's entire global Claude Code
configuration**: MCP servers, `SessionStart` hooks, skills, plugins. See `adapters/FINDINGS.md` for
why that is three separate problems (tokens, behaviour, reproducibility) and for the flags that would
let a dashboard-managed worker declare its environment instead of inheriting one. Not fixed here: it
is a design decision, and the slice's job was to surface it.

## 20. Phase 2: the worker-environment decision, and two things it taught the test harness (2026-09-07)

The decision itself is recorded in **`adapters/FINDINGS.md`** ("the environment decision, measured")
and implemented in `adapters/claude-code/worker-env.js`. Two findings belong here instead, because
they are about the runtime and about how this project verifies things.

### 20.1 `start()` leaked a registration on a SYNCHRONOUS spawn refusal

`spawnManaged` can throw **synchronously**: `childSpawnEnv` refuses to spawn past
`MAX_SPAWN_DEPTH` *before* `spawn()` is ever called. `start()` registered the run in the adapter's
`runs` map first, so that throw left an entry with **no child and no process** — unreachable and never
disposed, because a `start()` that throws never returned its runId to anyone. Same defect class as
review-0003's `start()` finding (a spawn preceding its row, leaving a live child with no row), arriving
from the opposite direction: a row-shaped entry with no child.

Fixed with a `try`/`catch` that deletes the registration and rethrows. **An asynchronous spawn failure
is deliberately NOT caught there**: ENOENT on the command and EACCES on the cwd arrive as an `'error'`
event, which `_adoptChild` already installs a listener for (findings S6/S7 — a missing listener took
the whole daemon down). Those runs are real, registered, and reported through the event stream.

Found by a mutation that was aimed at something else, which is the more useful half of the story.

### 20.2 A mutation claimed to protect an ordering that is NOT OBSERVABLE

`worker.env` is emitted before `spawnManaged` so it reads as the transcript's first line. Mutation E12
originally moved it *after* the spawn and claimed to break "worker.env is the first event" — and it
**PASSED**. The reason: a failed spawn arrives **asynchronously**, so the event log gets `worker.env`
either way and the ordering has no observable consequence. The emit position is a readability choice,
and is now labelled as one in both the test and the code rather than being implied to be a guarded
invariant.

That is the fourth time this project has hit "a test that does not exercise the mechanism it names"
(Group 5's ReferenceError mutation, round three's shared-pgid fixture, M21's all-orphan crash suite,
now this). The difference this time is that chasing the passing mutation found the real defect in
20.1, which nothing had been looking for.

### 20.3 The mutation runner could not attribute a failure to a case, for half the suites

`_mutate-runner.mjs` located the broken case by scanning for the last `^  N.` line printed. That works
for the numbered suites (`approval.test.js` and friends) and is **meaningless for the adapter-style
suites**, which print `PASS: <name>` / `FAIL: <name>` — `lastCase` is always 0 there, so every result
read "test FAILED at case 1" and a mutation was reported OK on the strength of the suite failing
*anywhere*. Given this project's own history, that is precisely the gap that lets a mutation pass for
the wrong reason and be recorded as evidence.

A mutation may now name **`breaksCase`**: the exact case name the suite prints. When present, the
runner requires the failure to be attributed to **that** case and says so explicitly when it is not
("NOT at the named case ... which proves nothing"). All 12 environment mutations name one and all 12
are attributed. The guard was itself verified by pointing a mutation at a case it does not break and
confirming the run reports `PROBLEM` — otherwise the new check would be exactly the kind of
never-exercised assertion it exists to catch. Backwards compatible: numbered suites still report
`at case N`, verified against `_mutate-approval.mjs`.

## 21. Phase 2: crash / restart / recover against the REAL harness (2026-09-07)

`runtime/test/real-claude-crash.slice.mjs` + `runtime/test/_real-claude-crash-victim.mjs`.
**Not in `npm test`** — real tokens, real network, a logged-in `claude`. Evidence:
`adapters/claude-code/probe/evidence/10-real-claude-crash-recovery.txt`. Green on three
consecutive runs, 7/7 cases, 0 survivors.

This was the last open item on Phase 2's slice. Group 6 already proved crash recovery
deterministically against the fake harness *and* a real daemon; the only thing missing was
whether a **real third-party CLI** behaves the way the recovery path assumes when its parent is
SIGKILLed. Measured, it does:

1. **The real `claude` process survives its supervisor's SIGKILL**, still leading its own
   process group, with `pgid === pid` and an `lstart` that matches what was recorded before the
   crash. That last check is the one that matters: it distinguishes "our process is still alive"
   from "some process now has that pid", which is the distinction `reap` refuses to guess at.
2. **A fresh supervisor classifies it `orphaned-unmanaged` and leaves the row OPEN**
   (`ended_at IS NULL`, no `exit_reason`), journalling a `new` sighting. Migration 0003's
   behaviour, now observed on a process the supervisor genuinely never owned rather than on a
   fake one.
3. **Reaping it really kills the real CLI** — and the kill needed the escalation path: run one
   recorded `"note": "EPERM"` with `escalated: true`. That is the Group 6 zombie finding
   appearing unprompted in a real run, which is the best possible evidence that
   `isProcessGroupLive`'s `ps`-based check is not redundant with `kill(-pgid, 0)`.
4. **The honest limit is now TESTED rather than asserted.** The worker is deliberately PARKED on
   an approval at crash time, so its `can_use_tool` request is blocked on a stdin whose write end
   died with its parent. Nobody can ever answer it — not the restarted supervisor, not a human.
   Reconciliation closes it as `answered_by = 'supervisor:reconciliation'`, `decision = 'closed'`,
   `delivered_at = NULL`. Case 4 asserts the **reason**, not just that it closed: "closed" alone
   would also be true of a bug that closed asks it could still have delivered, and `decision`
   must never be one of the three deliverable values.
5. **Item 2's environment pin holds on the real CLI**, which is the confirmation the probe alone
   could not give: the real session reported **0 MCP servers, 24 tools, 41 slash commands**
   against a developer global config carrying 6 MCP servers, 110 tools and 97 commands. To make
   that checkable, `session.init` now records what the CLI reports it actually loaded, alongside
   the `worker.env` event recording what we asked for. Two different facts, and the pair is the
   point: the declaration is intent, `session.init` is outcome, and only the outcome can reveal a
   flag that silently stopped working. Counts rather than lists for tools/commands/agents —
   24 tool names in every transcript is the context-economy problem one layer down — but MCP
   servers are named, because there should normally be none.

**Four bugs were in the test rather than the product, and all four would have read as product
bugs.** Worth listing, because each is a shape that recurs: `waitFor`'s option is `pollMs` and
passing `intervalMs` is silently ignored (the wait still works, so nothing complains);
`listOrphanSightings` takes `runId` **positionally**, so an options object would have been bound
as a parameter; `supervisor` exposes no `reconcile()` at all (reconciliation is something
`boot()` does); and the WAL assertion guessed the database filename (`supervisor.db` — it is
`state.sqlite3`), which failed in a way indistinguishable from "recovery left no WAL". The
filename now comes from `paths.js` and the failure message lists the directory contents.

**And one bug in the victim that would have quietly voided the whole slice:** the write load was
hand-rolled SQL computing a *per-run* `event_log.seq`, but `seq` is a **global**
`INTEGER PRIMARY KEY AUTOINCREMENT` and `tier` is `NOT NULL`. The victim would have died of its
own constraint violation immediately after printing its seed line, so the "crash under load"
would have been a crash under nothing — and the run would still have looked green for cases 2-7.
It writes through `recordEvent` now. The assertion that catches it is
`victim.signalCode === 'SIGKILL'`: a victim that exits on its own did not get killed, and that
has to be a failure rather than a detail.

## 22. Item 2 and the crash slice were reviewed, and the review found a defect in the evidence itself (2026-09-07)

Three models: `opencode/big-pickle` (medium) and `luna` (medium) independently, then `sol` at
**high** effort given both reviews AND the code, asked to add its own findings, dedupe, correct
mechanisms and re-rank. **`review-phase2-item2/verdicts.md` is the file to read** — it overrides the
raw reviews and the consolidation where they disagree.

**11 findings, all confirmed (one mechanism-corrected). 10 fixed, 1 accepted as a stated
precondition. Five came from the consolidator that neither reviewer found.**

### 22.1 The finding that invalidated the evidence for everything else

`_mutate-runner.mjs` treated **any** `FAIL:` line as an assertion failure, and the adapter-style
suites print `FAIL: <case>` for every caught exception. So a mutation that made the code throw an
ordinary runtime error was reported as *"caught by the assertion that protects it"*. This is
`breaksCase` — added in this same change, one level down, for this same reason — being defeated one
level up.

Verified rather than accepted: mutation E8 made `readFileSync` propagate `EISDIR`, and the suite
output contained **no `AssertionError` at all**, yet the run said `OK`.

**The scope was far wider than the cited mutation.** Requiring a real `AssertionError` dropped the
**pre-existing approval harness from 14/14 to 9/14** — five mutations already recorded as evidence
in sections 17-18 were failing by `TypeError` or by a `waitFor` timeout.

The root cause was one line, and the fix is the generalisable part: **`_helpers.js`'s `waitFor` now
throws an `AssertionError` on timeout** instead of a plain `Error`, because a timeout in a test *is*
an assertion failure — "this never became true". Four of the five were timeouts. Plus one real
guard in `approval.test.js` case 4, which dereferenced `updatedInput.answers` without first
asserting `updatedInput` existed.

All harnesses pass under the strict rule: **16/16** environment, **14/14** approval, **8/8** pane.
Those counts now mean what the sentences beside them claim.

### 22.2 The traceability guard was misdirecting

`projectSettingsChain` walked to the filesystem root and so recorded `$HOME/.claude/settings.json`
— which **is** the user source, and is provably not loaded under `--setting-sources=project`. In
this repo it was the **only** entry recorded on every run. A guard built to stop an investigation
being misdirected was doing the misdirecting. Fixed with an injectable user-scope boundary.

Also fixed in the same function: a relative `cwd` stopped the walk after one directory
(`parse(".").root` is `""` and `dirname(".")` is `"."`) and wrote relative paths into an audit
record; and a depth-bounded walk now **records that it was truncated**, because a short list
otherwise looks exactly like "this worker has no project settings".

### 22.3 A negative assertion needs a positive control

The environment pin has **two independent axes** and only one was observable: the slice asserted
`mcpServers` was empty, so a regression that dropped `--setting-sources=project` while keeping
`--strict-mcp-config` would have restored the developer's global hooks and stayed green.

Fixed with a `harness.hook` event and an assertion that zero hooks fire. But "0 hooks" is
indistinguishable from "hooks are never recorded", so it also needed a **positive control**:
`probe/hook-axis-control.mjs` measures `envProfile: 'inherit'` → **2 hooks, 6 MCP servers, 110
tools** against `'project'` → **0, 0, 24** (`evidence/11-hook-axis-positive-control.txt`). The fake
binary now emits hook events too, so the *mapping* is regression-tested with no tokens.

**Fifth occurrence of this shape in this project** (Group 5's ReferenceError mutation, round three's
shared-pgid fixture, M21's all-orphan crash suite, E12's unobservable ordering, now this).

### 22.4 Two claims narrowed rather than defended

Both were cases where the code was fine and the *sentence next to it* was too strong:

- **The probe is not provably free.** Its guard skipped `stream_event` before checking for model
  output, and assistant deltas ride inside those frames (luna). sol's correction is the load-bearing
  half: moving the check still would not prove no request was **sent**. The guard is fixed and
  widened, and the header now claims "no observable model call", not a billing guarantee — which
  **refutes** big-pickle's positive claim that the existing tripwire established freeness.
- **A non-empty WAL does not prove a mid-statement kill.** The victim's INSERTs are synchronous
  with a 5ms sleep between them, so SIGKILL very often lands in the sleep. What it proves is
  committed frames left un-checkpointed — no clean shutdown ran — which is the state recovery must
  handle. SQLite's atomicity was never under test.

### 22.5 The one finding not fixed, and why

`--setting-sources=project` **loads and executes** a repo's committed hooks before the worker's
first turn. Both reviewers rated this blocking.

Verdict: keep `project` as the default and make the precondition **explicit**. It is the same
bargain a developer already makes by running `claude` in that directory, and the dashboard does not
widen it for repos you work in — but it is a real boundary, and pointing the dashboard at an
untrusted checkout falls outside it. `worker-env.js`'s header now states the precondition and names
the mitigation (`envProfile: 'none'`, measured, one field away).

**Explicitly not claimed: that the settings digest mitigates this.** It is forensics, not a control.
Both reviewers were right to insist on separating them, and conflating them would be the more
dangerous error. This is a product decision, flagged for the owner rather than settled here.

### 22.6 Process notes

- **The consolidator needed the code, not just the two reviews.** Five of eleven findings were its
  own, including 22.1. A consolidation pass that only reconciles two documents would not have found
  them.
- **A refuted positive claim is a finding.** big-pickle asserted the probe's guard established zero
  cost; sol refuted it. A review that only collects defects keeps the false reassurance.
- **The OpenCode adapter's lack of environment pinning was deliberately NOT called a defect** by
  two of three models, on the grounds that nobody has measured whether OpenCode has an equivalent
  mechanism. That is the right call and the right question — it is why the file was in the review
  scope — and it is now an open item rather than a fix.

## 23. Preflight session cleanup (PLAN.md 12.1) — built 2026-09-07

`migration 0005`, `supervisor.preflight()`, `db.deletePreflightRun()`,
`runtime/test/preflight.test.js` (9 cases), `runtime/test/_mutate-preflight.mjs` (10 mutations, all
observed failing at the case that protects them), and
`runtime/test/real-claude-preflight.slice.mjs` (6 cases against the real CLI, **not** in
`npm test`; evidence `adapters/claude-code/probe/evidence/13-real-claude-preflight.txt`).

### 23.1 The requirement pulls in two opposite directions at once

A preflight row must be **invisible to every human-facing view** and **visible to
reconciliation**, and getting it backwards in either direction is a real bug:

- visible to humans → "who did what" becomes twenty sessions saying "hi", which is the history
  pollution the whole feature exists to prevent;
- hidden from reconciliation → a crashed preflight leaks a live process nobody can see or reap,
  which is **strictly worse** than the pollution.

So `listOpenRuns` (reconciliation's input) deliberately **includes** preflights and
`listRunsForDisplay` excludes them. `preflight.test.js` case 2 asserts both directions on the same
row, and mutation **P1** ("filter them out of `listOpenRuns` too, for consistency") is the most
inviting wrong simplification in the feature — it reads as tidiness and it leaks processes.

The exclusion is a **read-time filter**, not something that becomes true once the row is deleted:
twenty in-flight "hi" sessions pollute a team view exactly as effectively as twenty finished ones.

### 23.2 `is_preflight` is set at INSERT time, and is a column rather than a `lifecycle` value

Set at insert because a preflight SIGKILLed before its cleanup has to be recognisable as one by the
reconciliation that finds it, and **nothing can set a flag after a SIGKILL**.

A column rather than a `runs.lifecycle` value because the two questions are orthogonal:
`lifecycle` answers "was this process ever observed running unmanaged", and a preflight can
perfectly well be orphaned and needs reaping as one. Folding them together would recreate exactly
the mistake migration 0003 fixed, where one column answered two questions and the second was lost.

### 23.3 `deletePreflightRun` is the only destructive delete in this codebase

Everything else here **closes** rows and keeps them. This one removes them. So:

- it **refuses a non-preflight run**, loudly, and re-reads `is_preflight` *inside* the transaction —
  checked in the database rather than trusted from the caller, because the caller is what would be
  wrong;
- one transaction, children before parents, or the foreign keys reject it — and a half-deleted run
  with orphaned `event_log` rows would be both unreadable and undeletable;
- **not** `transition_journal`: it is keyed by `task_id`, not `run_id`. An earlier draft deleted from
  it by `run_id` and failed with "no such column", which was the schema refusing a delete that would
  have been wrong even if it had parsed — task history does not belong to a run.

The verdict is recorded **before** cleanup runs, so a cleanup failure cannot cost the verdict. The
verdict is the point of the check; tidying up is bookkeeping and must not outrank it (mutation P6).
And cleanup runs on **every** path — an unreachable model is the case most likely to be re-checked
repeatedly, so leaking history there would be worst (mutation P7).

### 23.4 The two measured facts that shaped it, taken BEFORE it was built

- **Claude Code: `--no-session-persistence`** (`spec.ephemeral`). The harness never writes a session
  at all, so there is nothing to delete on that side. **Not writing beats deleting**: a delete can
  fail, and a SIGKILL between the check and its cleanup pre-empts the delete entirely — which is
  exactly the case a preflight has to survive, since it is designed to be run liberally. Verified
  against the real CLI: **747 session files before, 747 after**. The flag is opt-in because an
  ephemeral session cannot be RESUMED — correct for a preflight, wrong for a worker.
- **OpenCode: `discardSession()`, deleting BY THE ID IT CREATED.** No equivalent flag exists, so the
  session is always written and must be removed afterwards. There is deliberately no bulk form,
  because **OpenCode's session store is global, not per-directory** — a server started in a fresh
  empty directory lists sessions belonging to other projects, so anything that enumerated to decide
  what to clean could delete another project's history. It resolves with an outcome instead of
  throwing: cleanup failing must not turn "the model is reachable" into an error.

A preflight also runs with the tightest environment available (`envProfile: 'none'`, PLAN.md 4.1):
answering "ok" needs no MCP servers, hooks or skills, and each is pure cost on a check whose whole
point is being cheap.

### 23.5 The defect the real harness found that the fake could not

The first real-CLI run logged, on every preflight:

```
[pump] recordEvent failed for run <id> (non-fatal): FOREIGN KEY constraint failed
```

The pump keeps consuming the adapter's stream, and the tail of that stream arrived **after** the
rows were deleted — so every event it then persisted violated `event_log.run_id`. Non-fatal, nothing
broke, and a warning on every single check. **Log noise that is expected is log noise nobody reads.**

Fixed by calling `pump.closeRun(runId)` **before** the delete (the same call `stop`/`reap` already
use). The ordering is load-bearing, not tidy.

**Two things about testing it are worth carrying forward.** First, the obvious assertion does not
work: the FK warning needs a still-streaming process to appear at all, so against the fake harness it
never fires and an "expect no FK error" test would pass with the ordering broken. Second,
`pump.has()` stays **true** after `closeRun` **by design** — the state is retained because
`derived()` reads it for `status()`/`list()` (see §16's open items), so `has()` answers "is this run
known", not "is it still consuming". Case 9 therefore asserts the pump's `closed` flag, which is
what the consumer loop actually checks before persisting each event. Mutation **P10** confirms it.

### 23.6 Two mutations are attributed to an earlier case than their label first claimed

P4 (children not deleted) and P8 (flag never set) both fail at **case 1**, not at cases 6 and 2 as
first written. Both are legitimate: with the event rows left behind the `runs` DELETE hits the
foreign key and the transaction rolls back, and an unmarked row makes `deletePreflightRun` refuse —
so case 1's `cleanup.deleted` is already false in each. Case 1 is simply the **earliest** case that
depends on those mechanisms. The labels were corrected rather than the tests changed to force the
attribution, which is the same call made in §22.4: when the code is right and the sentence beside it
is wrong, fix the sentence.

Also worth noting: **the mutation harness refused an ambiguous pattern** for P10, because
`pump.closeRun(runId)` occurs three times in `supervisor.js`. That refusal is the "grep lied once"
guard from the 0003 review doing its job.

### 23.7 A test bug that only surfaced because 0005 exists

`db/test/asks-round-trip.test.js` built its "pre-0004" database by copying every migration
**except** 0004. That was indistinguishable from the intent while 0004 was the newest migration —
and then 0005 landed, the "pre-0004" database came up at version 5, and the test failed for a reason
that had nothing to do with 0004. The filter now selects migrations with `version < 4`, and its
"0004 and only 0004 was pending" assertion is now "0004 was pending, and applied first", which does
not have to be revisited every time a migration is added.

## 24. The tier-3 task handoff (PLAN.md section 8, Rule 4) — built 2026-09-07

`migration 0006`, `handoff/generate.js`, `supervisor.taskHandoff()`,
`runtime/test/handoff.test.js` (9 cases, and it prints a real generated document),
`runtime/test/_mutate-handoff.mjs` (10 mutations, all observed failing by assertion at the case that
protects them). This was Phase 2's last build item.

### 24.1 A CORRECTION to PLAN.md section 8: tier 3 cannot live in `event_log`

Rule 4 says "three tiers over the same `event_log`". That is right for tiers 1 and 2 and **wrong for
tier 3**, and the schema says so out loud:

```
event_log.run_id  TEXT NOT NULL REFERENCES runs(run_id)
```

`event_log` is **run-scoped and NOT NULL**. A tier-3 handoff is **task-scoped** by Rule 4's own
definition — "per task, regenerated on transition", read by "CTO, leads, reviewers, any new/cleared
worker", none of whom are asking about one run. A task outlives every individual run on it, which is
the entire reason a handoff is worth writing.

Attaching it to "the task's most recent run" would have worked mechanically and been wrong twice: a
task with no runs yet could have no handoff, and **deleting a run would delete task knowledge** —
which is not hypothetical, because migration 0005's `deletePreflightRun` deletes `event_log` rows by
`run_id`. So tier 3 gets `task_handoffs` (migration 0006). PLAN.md section 8 has been corrected.

### 24.2 It makes NO model call, and that is a design choice with three reasons

Rule 4 says tier 2 is written "by the cheapest available model". True of tier 2 — but a tier-3
document assembled from structured facts does not need one:

1. **It is testable.** A generator whose output depends on a model can be checked for shape but never
   for content, and the requirement was "prove the mechanism, not just the schema".
2. **It is free, so it can run on every transition.** Rule 5's whole premise is that clearing becomes
   routine *because* tier 3 is cheap. A model call per transition is a recurring cost on the most
   frequent event in the system.
3. **It cannot hallucinate.** A handoff that invents a decision is worse than no handoff, because its
   readers are **agents that will act on it**.

### 24.3 The two ways a summary fails are both silent, so both are tested as negatives

- **`Assumptions` is left EMPTY, with a stated reason.** Nothing in the schema records an assumption,
  so anything written there would be invented. Case 4 asserts the section explains its own emptiness
  *and* contains no inferred language (`likely`, `probably`, `I assume`). Mutation H1 fills it with a
  plausible-sounding inference and is caught.
- **Truncation is stated in the document.** A handoff cut to the budget that *looks* complete makes
  its reader treat a missing blocker as an absent one — it silently converts "there is more you
  cannot see" into "there is nothing more". Mutations H2 (silent cut) and H3 (no budget at all) are
  both caught at case 5.

### 24.4 Bounded per section, not only globally

`SECTION_LIMITS` caps each list separately, because a global cap alone lets one long section starve
the others: a task with 200 transitions would push its **blockers** off the end of the page, and
blockers are the most actionable content in the document — an unresolved ask means a worker is
stopped right now.

Blockers come from structured rows (`asks`, `runs.lifecycle`), never from transcript text. An
orphaned process is listed as a blocker with its pid, because it is the one blocker with an **ongoing
cost** in tokens and CPU.

### 24.5 Where it reads tier 1, and why that is not a violation

Rule 4's hard rule is "**no agent** ever reads tier 1". The generator is code, and the thing that
turns tier 1 into a summary must by definition read it. What it does with it is the point: it
**counts and classifies** (`N tier-1 event(s), including M error event(s)`) and never copies
transcript text into the document. `runs`, `asks` and `transition_journal` are structured rows, so
most of the generator touches no transcript at all.

Preflight runs are **excluded** (migration 0005): a handoff is the most human-facing document in the
system, so "who did what" must not become twenty sessions saying "ok". Mutation H6.

### 24.6 Appends, unlike `model_health` which replaces

Rule 4 regenerates on transition, and keeping the previous document is what makes a regeneration
reviewable — "the goal changed between these two" is worth being able to ask. That is the **opposite**
call from migration 0005's `model_health`, which correctly replaces, and the difference is that a
handoff has historical value while "is this model usable right now" does not. Mutation H9.

`sources_json` records what the document was **built from** — transition and run counts, the ask ids,
whether the diff was readable. "Which asks did this see" is the first question anyone asks of a summary
they do not trust, and a summary nobody can audit is one nobody should act on. Mutation H8.

### 24.7 A git failure degrades to a note, and one mutation had to be met halfway

`diffShape()` never throws: a task with no worktree, a stale `base_rev`, or no git at all produces a
note explaining why, not an exception. Letting it throw would lose the **other five sections** to a
failure in the least important one — the blockers matter more than the diff.

Mutation H7 (let the git failure propagate) initially failed **by crash rather than by assertion**,
which under the tightened rule from §22.1 proves nothing. Fixed in the test, not the harness: case 9
now calls the generator inside a `try`/`catch` and uses `assert.fail`, so "the error escaped" is an
assertion failure. Same shape as mutation E8 in §22 — when a mechanism is "this must NOT throw", the
test has to catch the throw rather than letting it end the suite.

## 25. The Phase 2 gate, run end-to-end — and the defect it found (2026-09-07)

`runtime/test/real-phase2-gate.slice.mjs`, 7 cases against the real `claude` CLI, **not** in
`npm test`. Evidence: `adapters/claude-code/probe/evidence/14-real-phase2-gate.txt`.

ROADMAP's Phase 2 ends with "if this phase doesn't work end-to-end, stop and reassess before writing
anything else". Every piece was already proven in isolation — approval round trip, live pane, crash
recovery, worker environment, preflight cleanup, tier-3 handoff. **A gate is not a list of passing
parts.** Nothing had asked whether they hold together as one story, so this walks the actual
workflow in order: check the model is reachable and leave nothing behind → put a worker on a task →
it blocks on a tool → the handoff a lead would read SHOWS that block → a human answers → the tool
runs and a second turn lands → the task moves state → the final handoff says nothing is blocked →
nothing survives.

**Case 4 is the case that could not exist in any single-feature slice.** The approval subsystem
creates a live block; the handoff subsystem, which knows nothing about approvals, has to report it as
the thing to act on. That is composition, and it is the only thing a gate adds over its parts.

**What it deliberately does NOT re-prove:** supervisor crash and recovery. §21's slice covers that in
7 cases against the real CLI. Re-running it here needs a second OS process (the claude adapter has no
`_forgetAllHandles` seam — that is fake-harness-only) and would spend real tokens re-proving a green
result. Stating the boundary beats implying coverage the script does not have.

### 25.1 It found a defect on its first run, and the defect was two sources of truth

The generated handoff said:

```
**Fetch the example.com title** — a feature, currently `created`.
...
## Decisions
- `in-progress` → `in-review` by **gate-coder** ...
- `created` → `in-progress` by **gate-coder** ...
```

The Goal said `created`; its own Decisions list said the task had reached `in-review`. Cause:
**`recordTransition` appended to `transition_journal` and nothing anywhere updated `tasks.state`** —
there was no `UPDATE tasks` in `db/index.js` at all, so the column was written once by `createTask`
and never again. The journal and the column could disagree indefinitely. Same shape as the bug
migration 0003 fixed: one fact with two homes.

Fixed by making a transition **move the task and journal the move in one transaction**, which is what
a transition *is*. `fromState` is optional but **checked when given** — a caller saying
"in-progress → in-review" is asserting what it believed the current state was, and honouring that
when it is stale is a lost update. What is deliberately **not** validated is whether the transition
is *legal*: which states may follow which is PLAN.md section 6's state machine and Phase 5's job.
Refusing a stale `fromState` is concurrency control, not policy.

### 25.2 The assertion that should have caught it was vacuous, and that is the more useful lesson

`handoff.test.js` case 6 asserted `h.doc.includes("in-review")` — searching the **whole document**.
It passed, because the new state also appears in the journal-derived Decisions list. The Goal being
wrong was invisible to a test that claimed to check exactly that.

Both the unit suite and the gate now assert against the **named section** that is supposed to carry
the fact (`section(doc, "## Goal")`). Mutation **H11** removes the state update and is caught at
case 2 — *earlier* than the case written for it, because the narrowed Goal assertion now fires at the
first handoff. Before the narrowing, neither case caught it at all. Mutation **H12** accepts a stale
`fromState`.

**Sixth occurrence of this shape in this project** (Group 5's ReferenceError mutation, round three's
shared-pgid fixture, M21's all-orphan crash suite, E12's unobservable ordering, §22.3's absent-hook
assertion, now this). The pattern is consistent enough to state as a rule: **an assertion that
searches a whole artifact for a value proves only that the value appears somewhere.** If a fact is
supposed to live in a particular place, assert against that place.

And the meta-lesson about gates: this defect survived 98 green suites and 64 caught mutations. It was
only visible when the subsystems were composed and a human-readable artifact was printed and *read*.
Printing the document at the end of the run is not decoration — it is what made the contradiction
obvious.

## 26. Phase 3: harness onboarding by conformance — and the answer to "one interface, N implementations" (2026-09-07)

`conformance/matrix.js`, `conformance/suite.js`, `conformance/run.mjs`, `supervisor.onboardHarness()`,
`runtime/test/conformance.test.js` (8 cases, free), `runtime/test/_mutate-conformance.mjs`
(9 mutations, all caught by assertion). Evidence for the real run:
`adapters/claude-code/probe/evidence/15-conformance-both-adapters.txt`.

PLAN.md section 9 replaced runtime code-generation for new harnesses with: declare a capability
matrix, pass a conformance suite over start/stream/interrupt/clear/exit-detection, and only then flip
`harnesses.status` to `active`. Building it answers Phase 3's real question.

### 26.1 The answer: honest, but ONLY because the interface carries the semantics that differ

Both real adapters reach the `active` tier against their real harnesses. But writing the matrix found
**three divergences a boolean matrix would have hidden**, and two of them change how code above the
adapter boundary must behave:

| field | claude-code | opencode | why a boolean would have been a lie |
|---|---|---|---|
| `clearContext` | `erase` (`/clear` — history gone) | `compact` (`/summarize` — history retained, reduced) | PLAN.md §8 Rule 5 prices routine clearing at "one page of reload". True of an erase; **false of a compact**, which reduces context rather than resetting it. A `clearPolicy: on-state-transition` means two different things depending on the harness, and nothing could see it. |
| `approvalProtocol` | `host` (parks on us, acts on the answer) | `observe-only` (reports the request, **cannot be answered**) | A worker on opencode CAN park and an `asks` row IS created, but there is no `answerApproval` to deliver to. The whole approval control plane is Claude-Code-only. |
| `residentProcess` | `per-run` | `pooled` (one server per cwd, runs multiplexed) | Already known — it is why opencode refuses a per-run environment declaration (§20) — but now it is declared rather than folklore. |

So: **"one interface, N implementations" is honest when the interface describes what implementations
actually differ about, and aspirational when it papers over it.** Both adapters implement the same
method names; two of those names mean different things. The fix was not to change either adapter — both
are correct for their harness — but to make the contract able to say so.

`opencode`'s `clearContext` had been admitting this to itself all along: its return value is
`{ ack: true, semantics: 'compacted-not-erased' }`. Nothing read it.

### 26.2 `observe-only` is a real state, and the suite must not punish honesty

The supervisor was already safe here: the delivery path checks
`typeof adapter.answerApproval !== "function"` and **abandons** the answer with a reason rather than
stamping `delivered_at` (a Phase 2 review fix). What was missing was the *declaration* — an operator
could reasonably expect the approval UI to work on that harness.

`requiredMethods()` therefore requires `answerApproval`/`pendingApprovals` **only** for
`approvalProtocol: 'host'`. Mutation **C5** makes any permission-reporting harness require them, and
it is the most interesting mutation in the set: it would make opencode's candid declaration FAIL
conformance while a dishonest `approvalProtocol: false` passed. **The incentive would run backwards** —
a conformance system that punishes accuracy teaches adapters to overclaim, which is the exact thing
section 9 chose declaration-plus-verification to avoid.

### 26.3 What the checks are actually for, and the three outcomes that matter

`matrix:methods` answers "does the declaration name methods that exist" from the declaration alone —
cheap, no harness. The behavioural checks answer "does what it declared actually happen". The
distinction is load-bearing and cases 4 and 5 separate them: a capability **declared but not
implemented** is caught by the cheap cross-check, while one **declared, present, and broken** (a
`clearContext` that acknowledges nothing) is only caught by running it. That is what section 9's
"pass/fail, not 'probably works'" means.

Third outcome: **present but undeclared → `warn`, never `fail`.** Doing more than you promise is a
documentation bug — the supervisor will never reach for the capability — and failing it would block a
working harness over a stale comment. Mutation C8.

The `clear` check verifies the **ack**, not the semantics: nothing observable from a single call
distinguishes an erase from a compact, and guessing would be worse than trusting a declaration a human
wrote and a reader can check against the adapter's own code. Stated in the suite rather than left as
an apparent gap.

### 26.4 Two notes on the mutation set

Most ways a conformance system breaks make it **more permissive**, and a rubber stamp still passes
every happy-path test — so most of these mutations attack the **refusals**, which is where a gate's
value lives. C2 (`const failed = []`) is the whole onboarding step turned decorative in one line.

**C7 — boolean-ifying `clearContext` — fails at case 1, not at the cases written for it**, because it
invalidates the *fake* harness's declaration too and the very first onboarding fails. That is the
mutation's reach rather than a mis-attribution, and it is the most direct demonstration available that
the field's semantics are load-bearing: removing them breaks every adapter in the project at once.

### 26.5 Still open in Phase 3

- **The `wrapper` tier is classified but not implemented.** A harness that fails conformance is
  correctly marked `wrapper` and persisted as such; what does not exist is section 9's actual degraded
  driver (`node-pty` + a terminal parser for liveness and pane output). Classifying without
  implementing is the right order — nothing can be driven in a mode nothing has asked for yet — but
  the tier currently means "do not trust this" rather than "drive it this way".
- **Hook-based adoption of externally-started sessions** (Phase 3's third item) is untouched.
- `modelDiscovery` is `false` on both adapters, honestly: both underlying tools can list models and
  neither adapter surfaces it. That is a real capability the supervisor cannot reach, which matters for
  §12's failover.

## 27. Phase 3: adopting a session a HUMAN started (2026-09-07)

`migration 0007`, `supervisor.adoptSession()/releaseSession()/adoptedSessions()`,
`hooks/claude-session-hook.mjs`, `runtime/test/adoption.test.js` (8 cases),
`runtime/test/_mutate-adoption.mjs` (8 mutations, all caught by assertion),
`runtime/test/real-claude-adoption.slice.mjs` (7 cases against the real CLI, **not** in `npm test`;
evidence `adapters/claude-code/probe/evidence/16-real-claude-adoption.txt`). Phase 3's third and
last item.

### 27.1 The danger: an adopted session is indistinguishable from an orphan

A session a person started is structurally identical to migration 0003's `orphaned-unmanaged` — a
live process the supervisor did not spawn and holds no handle for. Recorded that way, every mechanism
built for orphans applies to it: reconciliation journals a sighting on every boot,
`supervisor.orphans()` offers it up for cleanup, and **`reap` group-kills**. That is somebody's live
session, mid-sentence.

The OS cannot tell these apart. An unowned live process is a *problem* when we lost it and somebody's
deliberate work when they started it, and only a record of **how it arrived** distinguishes them —
which is why `lifecycle = 'adopted'` is a column and not an inference.

Two guards, and they are the only mutations in this project whose real-world failure mode is
"somebody's work is terminated":

- **`reap` refuses an adopted run** (`refused: "adopted"`). Every other refusal in that function is
  about not killing the WRONG process; this one is about not killing a RIGHT process we were never
  asked to own. `force: true` exists because a stale adopted row is a real situation and refusing
  forever would make it unresolvable — it is opt-in and not plumbed through the wire command.
- **Reconciliation skips the orphan branch** for adopted rows but *keeps* the `lost` branch: an
  adopted session whose process is gone IS finished, and leaving the row open forever would be the
  invisible-orphan bug in reverse. That is also the backstop for a hook that never fired, which is
  what a crashed terminal produces.

### 27.2 Adoption buys VISIBILITY, not control — and says so

There is no stdio, so no `observe()`, no `sendInput`, no `interrupt`, no approval round trip. A
session started by hand answers its own permission prompts in its own terminal, where the person
already is. `adoptedSessions()` therefore reports `controllable: false` on every row: a UI shown a
controllable-looking run would offer buttons that silently do nothing, which is the same class of
overclaim as declaring `approvalProtocol: 'host'` on a harness that cannot answer (§26).

### 27.3 Measured facts about the hook, three of which corrected an assumption

A Claude Code `SessionStart` hook receives on stdin:
`{ session_id, cwd, source, transcript_path, hook_event_name }`.

1. **No pid.** The pid comes from the environment instead: the CLI sets **`CLAUDE_PID`**, and `$PPID`
   is the same value because the hook is a direct child of `claude`. Both verified; `CLAUDE_PID` is
   preferred because it does not depend on shell nesting. The reported pid is then **verified against
   the OS** (`readProcInfo`) rather than trusted — a pid alone is not an identity, and pgid plus start
   time are what make later pid-reuse detectable. The real slice asserts `ps` shows that pid as the
   `claude` process itself, not a hook shell.
2. **`--settings` hooks fire regardless of `--setting-sources`.** Assumed, then measured across four
   flag combinations including `--setting-sources=` (empty): the hook fired in all of them. Worth
   recording because the opposite assumption is plausible — `--setting-sources=` *does* suppress
   project- and user-defined hooks — and it is what makes it possible to install this hook for a
   session without touching any settings file.
3. **`transcript_path` at `SessionStart` is PROSPECTIVE.** The file does not exist yet; the path is
   where the transcript *will* be written. An adopting supervisor must not treat it as readable at
   adoption time. The first version of the real slice asserted `existsSync` immediately and failed for
   exactly that reason; it now waits for the file to appear (measured: ~3s, 11KB after one turn),
   which is what the claim "the only route to an adopted session's events" actually needs.

### 27.4 The hook must never break the user's session

It runs inside somebody's interactive `claude`. **Every path exits 0**, nothing goes to stdout (a
hook's stdout can be injected into the session's context), and diagnostics are stderr-only behind
`CTD_HOOK_DEBUG`. No supervisor running is the **common** case, not an error — most people's `claude`
sessions have nothing to do with the dashboard. Mutation A6 makes it exit non-zero: harmless in a
test, and in the world it means installing this dashboard becomes a reason for a terminal to
misbehave.

It is also a **socket client** and never writes SQLite (PLAN.md section 4). That is precisely what
removes the write-conflict class ROADMAP flagged in the original hook design.

`CTD_ADOPT_WORKER_ID` is required and deliberately not defaulted: guessing would attach somebody's
exploratory session to an arbitrary worker's history, and a wrong attribution is worse than no
adoption.

### 27.5 Three defects found while building it, all in the tests

- **The test suite group-killed itself.** Case 4 force-reaps, `reap` group-kills, and the bystander
  process was spawned with `execFile` — so it sat in the TEST RUNNER's process group and the reap
  killed the test process: **exit 144, no output, nothing to debug from**. This is exactly the defect
  `runtime/spawn.js` exists to prevent one layer down ("a child inheriting the supervisor's group
  means kill-this-run's-group means kill-the-supervisor"), reproduced by hand. Bystanders are
  `detached` now, and `assertOwnGroup()` asserts `pgid === pid` before anything can kill anything.
- **`createIpcServer`'s option is `commands`, not `commandHandlers`.** Passing the wrong key is
  silent in the worst way: the server starts fine, every command falls through to the built-in demo
  cases, and the hook got back `unknown cmd: adoptSession`. **The deterministic suite never caught
  this because it calls `supervisor.adoptSession()` directly** — the wire path has exactly one test,
  and it is the real slice.
- **A repeat adoption threw instead of resolving.** Removing the idempotency check let migration
  0007's `UNIQUE` index reject the duplicate — good defence in depth, but it surfaced as a SQLite
  constraint error, and a hook needs a clean answer rather than an exception. The check in
  `adoptSession` is the interface; the index is the safety net. Case 1 now asserts the repeat resolves
  rather than throws (which also turned mutation A5 from a crash into an assertion failure).

## 28. Phase 4: the TUI (2026-09-07)

`tui/layout.js`, `tui/state.js`, `tui/app.js`, `tui/cli.js`, `tui/test/tui.test.js` (11 cases, free),
`migration 0008` (run provenance, below). Frames: `tui/evidence/01-demo-frames.txt`.
**Run it: `node supervisor/tui/cli.js --demo`.**

### 28.1 The decision everything else follows: rendering is a PURE function

`renderFrame(state, size)` takes a plain object and returns an array of strings. No terminal, no
socket, no clock. `state.js` is the same: `keyToAction(key, state)` and `applyAction(state, action)`,
both pure. `app.js` holds all the I/O and contains no layout arithmetic and no keybinding decisions.

That split is what makes a TUI testable at all. "The dev pane expands when reviewers are hidden" and
"a crashed pane says so" are ordinary string assertions — no pty, no screenshots, no human squinting
at a terminal. A UI that can only be checked by looking at it is a UI nobody can regression-test, and
this project's whole method is the opposite of that.

Splitting `keyToAction` from `applyAction` also makes FLOWS §5 testable *as a table*: "when you press
this and the situation is this, it does this" is literally (situation -> action) then (action -> state).

### 28.2 Two invariants worth stating

- **Every line is exactly `cols` wide.** `app.js` diffs frame against frame and repositions the cursor
  only for changed lines; a line shorter than the previous frame's leaves the old characters on screen,
  and the bug presents as corrupted *state* rather than a missing space. Asserted at four terminal
  sizes.
- **Keys are scoped by focus, not global.** FLOWS §5 relies on this (`h` moves the team bar AND hides
  the Requests panel when that panel is focused — a collision only if keys are global). The sharpest
  case is the chat bar: while focus is `chat`, letters must be TEXT. A chat box where typing "fq"
  toggles fullscreen and quits is not a chat box, and case 7 asserts exactly that.

### 28.3 The three non-running pane states each SAY which one they are

`empty`, `crashed` (with its `exit_reason`), `stale` (an adopted session — visible, not controllable).
A blank pane is the most confusing thing a dashboard can show, because all three look identical unless
each one says which it is. Derived from the ROW, never guessed.

### 28.4 `--demo` is the phase's own instruction made runnable, and it earned its keep immediately

ROADMAP Phase 4: "deterministic and cheap because it's built against Phase 0b's mock harness — no
tokens burned iterating on layout." Demo mode starts a real supervisor, a real event pump, a real
socket and a fake harness in one process, with two teams, three tasks and five workers.

**Looking at the rendered frames found three bugs that every unit test passed through:**

1. **Panes could never match a run to its worker.** `list()`'s projection has no `workerId` and no
   `endedAt`, so `buildPanes` fell through to "empty" for every pane. Fixed by having `tuiSnapshot`
   carry its own run projection rather than widening `list()`, whose contract several callers depend on.
2. **The tree and the panes disagreed about which team was in view.** The initial selection was
   `tasks[0]` globally; teams are ordered by name and tasks by creation, so the tree showed one team's
   task while the panes showed another team's workers. The tree filters by team and the panes filter by
   selection, so a selection outside the active team makes them contradict each other.
3. **Prose rendered one fragment per line** ("echo:dem" / "o work f" / "or w-lint") because each
   `assistant.delta` became its own row. Consecutive deltas are now coalesced — the same rule the pane
   follows (§19), and for the same reason.

None of those is a layout defect, which is why the layout tests were green. They are integration
defects between four correct pieces, and the only thing that surfaces them is rendering the thing and
reading it. Worth remembering the next time a "just look at it" step feels like it is not real work.

A fourth, smaller one: the demo used `mkdtemp` per run, and **36 state directories accumulated** while
capturing frames for these docs — a demo people are meant to run repeatedly must not leave a directory
behind each time it is SIGKILLed. It now reuses one fixed path and recreates it on start.

### 28.5 No TUI library

Raw ANSI, a few dozen lines. The project's only dependency is `better-sqlite3`, and a dashboard whose
install story is "and eighteen transitive packages" is a different product. The same call the pane made.

### 28.6 The chat bar is wired to a recipient that does not exist, and REFUSES

`tuiChat` returns an error for the CTO target, naming Phase 6. Direct-to-worker chat works (it goes
through `sendInput`). A chat box that silently swallowed messages would be worse than one that says
what is missing — the same principle as `approvalProtocol: 'observe-only'` (§26).

### 28.7 Run provenance (migration 0008), from the owner's question about orphan safety

The concern was that a session started outside the dashboard could be stopped by the orphan mechanism.
**Checked before building: that specific fear does not reproduce.** A hand-started session has **no
`runs` row**, and both dangerous paths are row-driven — `reconcileOnBoot` reads `listOpenRuns` and
`reap` needs a runId from `getRun` — so a process the dashboard never knew about cannot be named by
either. Group-kill cannot leak into one either: `spawnManaged` gives every child its own process group,
and `reap` already refuses a pgid shared with another open run. Migration 0007 covers the one
externally-started case that *does* get a row.

So `runs.started_by` is not a new safety mechanism. It makes an invariant that was **implicit in three
separate mechanisms** into one explicit, queryable fact: **the supervisor only ever kills a process it
started itself.** `'dashboard'` is the only reapable value; `'hook'` and `'preflight'` are not. An
invariant nothing can state is an invariant nothing can test, and `adoption.test.js` case 9 now asserts
it directly — including that an unstated origin defaults to `'dashboard'`, because a default of
`'unknown'` would quietly move rows *out* of the reapable set and fail in the safe direction where
nothing would notice.

## 29. Phase 5: the task state machine is now enforced (2026-09-07)

`domain/task-states.js` (pure), enforced by `db/index.js`'s `recordTransition`,
`domain/test/task-states.test.js` (11 cases, free), `runtime/test/_mutate-taskstates.mjs`
(8 mutations, all caught by assertion at their named case).

### 29.1 The diagram was documentation, and the drift proves it

Before this, `recordTransition` accepted **any string** as a state and checked only that the caller's
`fromState` was not stale (§25.1). So PLAN.md section 6's diagram constrained nothing — and the
project's own tests, the gate slice and the TUI demo had all drifted to `in-progress` / `in-review`,
names that appear **nowhere** in the design. **A state machine nothing enforces is a naming
convention.** Enforcing it broke exactly one suite and three callers, all of which were wrong, and all
of which now walk the real path (`created → starting → planning → implementing → awaiting-review →
approved → merged`).

The module is pure and data-driven — edges in a table, guards as predicates over `(from, to, context)` —
so the whole of section 6 is assertable without a database, including the guards. Section 6's closing
line is that "every transition needs a named actor and a guard, recorded in `transition_journal` — not
just a diagram edge"; `actor` is now required by the guard rather than by the writer, so the two cannot
drift apart.

### 29.2 The guards that cannot be skipped, and why they need mutations rather than trust

**Every one of these fails in the permissive direction, which means the happy path keeps working when
they stop applying.** That is the whole argument for mutating them:

- **NO AUTONOMOUS MERGES.** Section 6 calls this "a hard rule, not a default that can be silently
  skipped": `merged` requires `humanApproved: true`. Green reviews are explicitly *not* approval — case
  5 asserts that `reviewerVerdicts: 99` is still refused. Mutation T1 removes the gate and nothing on
  the happy path notices, because a flow that legitimately passes the flag keeps working.
- **Returning from a failure is explicit, never automatic** (section 6's words). Without it, `failed →
  created` becomes a retry loop that re-runs a task nobody asked to re-run, burning tokens per pass.
- **`blocked` is reachable only from `implementing`**, and section 6 is explicit that widening it should
  wait for evidence — "rather than pre-designing for a case with no evidence yet". Mutation T4 does the
  widening, which is the change the design warns against.
- **`blocked` must match reality in both directions**: it cannot be entered with no open ask, and cannot
  be left while one is open. Otherwise the state is a claim the UI then displays.
- **A no-op transition is refused.** Section 6 wants the journal to make "double-transitions from a
  duplicate hook or a retried command detectable", and a no-op entry is precisely the duplicate that
  would then be indistinguishable from a real move.

`approved` checks the reviewer-verdict count **only when the caller supplies one** — section 13 owns
verdict counting (revision-bound, per-dimension), and duplicating that here would give two answers to
one question.

### 29.3 A coherence check on the table, which is cheap and catches the typo

Case 11 walks the edges: every edge must point at a real state, every state must be reachable from
`created`, and no state may be both in-flight and terminal. That catches the kind of typo that would
otherwise present as a mysteriously unreachable state months later.

### 29.4 The test harness had the §22.1 defect again, in a new file

The two Phase 4/5 suites printed `PASS <name>` and only `err.message`. Consequence: the mutation runner
saw no numbered `  N.` lines *and* no `AssertionError` string, so **all eight mutations reported as
"crashed — proves nothing"** while actually being caught. Third time this project has hit the same
shape (§22.1, §22.3, now here).

Fixed by printing numbered pass lines, the whole error object, and `FAIL: <name>` in the form
`breaksCase` matches. And a second, subtler correction: these suites **keep running after a failure**,
so the runner's "last numbered line printed is the last case that passed" heuristic overshoots (it
reported "case 12" for an 11-case file). Named-case attribution is the reliable mechanism for this
shape, and the numbered heuristic is only sound for suites that stop at the first failure. Worth
knowing before writing the next suite.

Two setup walks also had to learn to assert rather than crash (`handoff.test.js`, and the same pattern
in the gate slice): each step passes the state the previous one should have produced, so a regression
that journals without moving `tasks.state` throws in setup, *before* any case — which the harness
credits to nothing. `assert.fail` with an explanation is the fix.

## 30. Phases 3-5 were reviewed, and the review found a lethal defect in the safety feature (2026-09-08)

`opencode/big-pickle`, variant medium. **`review-phase345/verdicts.md` is the file to read.**
**2 defects, both confirmed and fixed. 3 notes, 2 fixed. 1 finding the reviewer self-refuted correctly.**

### 30.1 The adoption crash window — and why my first reproduction understated it

`adoptSession` did `createRun(...)` then `markRunAdopted(...)` as **two statements, no transaction**.
`createRun` defaults `lifecycle` to `'managed'` (0003), so a crash between them left an open row with
`started_by = 'hook'`, a verified pid, no handle, and `lifecycle = 'managed'` — which reconciliation
reads as an orphan and `reap` then kills, **because the adopted refusal keyed on `lifecycle`**, which
that row no longer had.

**My first reproduction showed the process surviving, and downgrading the finding on that basis would
have been easy and wrong.** It survived only because `createRun` does not record `proc_lstart`, so
reap's *incomplete-identity* refusal fired first — an accident of a **different guard**. With
`proc_lstart` filled in: `reaped: true`, and the process was **dead**.

The standing rule ("verify the mechanism, not the conclusion") usually catches reviewers overstating.
This is the inverse case and worth remembering: **verification can also reveal that your reproduction
was too weak.** One guard accidentally covering another is not defence in depth; it is a single point of
failure with a spare part nobody chose.

**Root cause, stated plainly: the guard was `lifecycle`-keyed while the claimed invariant is
provenance-keyed.** §28.7's "only `'dashboard'` is reapable" was prose; the mechanism said something
narrower. Both are now the same thing:

1. **Adoption is one transaction** — the window does not exist.
2. **The reap refusal keys on `started_by` as well as `lifecycle`** — it holds even for a malformed row
   no code path can produce any more. *A guard that only holds because the write path is correct is not
   a guard.*

`adoption.test.js` case 10 hand-builds the lethal row; mutations A1 and **A10** are caught. **A11**
(remove the transaction) is declared `expectSurvives: true` with its reason — the transaction's value is
only observable when a process dies *between* the writes, which needs a separate OS process, and an
honest "not catchable here" beats a contrived assertion that appears to catch it.

### 30.2 The same defect, twice, one function apart

`tuiChat`'s direct-worker lookup used `list()`, whose projection has **neither `workerId` nor
`endedAt`** — so every direct message was refused. That is **the identical defect I had already found
and fixed for the TUI's panes** (§28.4), missed one function away, with the same cause and the same fix.

It also corrects §28.6, which said "this bar is wired, its recipient is not". True of the CTO target;
it read as though the worker target worked. It did not.

### 30.3 The pattern both defects share, and what to do about it

**Both lived in the wire command handlers, which have no tests.** Between this and §27.5's
`commands`-vs-`commandHandlers` — where the deterministic suite missed it because it calls
`supervisor.adoptSession()` directly — that is **twice in two phases, same blind spot**.

The suites test the supervisor's *functions* exhaustively and the pure modules exhaustively. Almost
nothing exercises the socket, and the socket is what every real client actually uses: the pane, the
hooks, the TUI. **A dedicated wire-surface suite belongs before the next phase adds more commands.**

### 30.4 The notes, all real

- **The adopted `lost` branch used bare pid liveness**, so a reused pid keeps a finished adopted row open
  forever and the backstop never fires. Fails safe (never kills) but never closes. Now uses
  `verifyProcIdentity`.
- **Conformance's `interrupt: 'process'` branch passed unconditionally** — a harness could declare it, do
  nothing, and be certified. Unreachable today (both adapters declare `'turn'`), which is exactly why it
  needed fixing rather than trusting: an unexercised branch that asserts nothing will be wrong the first
  time it runs.
- An exact-array assertion on `verdict.warnings` would break on any future warning. Relaxed to
  `includes`.

### 30.5 The reviewer self-refuted a finding, correctly

`findAdoptedRun` has no `ended_at` filter, so a released-then-re-adopted session id would find the closed
row. The reviewer checked reachability, concluded it is not a real flow, and **recorded it rather than
reporting it**. That is the right instinct — and "not reachable in today's flows" is a statement about
today's flows, so it stays visible here.

### 30.6 A flake found while re-verifying, and fixed rather than re-run

`real-claude-preflight.slice.mjs` case 3 compared a **machine-wide** count of the CLI's session files
before and after. Any other `claude` writing a session during the slice changes that count — observed
once, with the adoption slice running concurrently, reporting `1/6 FAILED` on a slice that passes.

Now scoped to the run's own working directory: the CLI encodes the cwd into its project directory name,
so counting only that subtree is precise and immune to unrelated sessions (measured 0 -> 0, twice).
**A test that fails because of something else on the machine teaches people to re-run it**, and a suite
whose failures are sometimes meaningless is a suite whose failures get ignored.

## 31. Repo config is OFF by default (owner decision, 2026-09-08)

`envProfile` now defaults to **`'none'`** (`--setting-sources= --strict-mcp-config`). `'project'` — the
option that **loads and executes** a repo's committed `.claude/settings.json`, hooks included, before the
worker's first turn — is opt-in.

**The decision, and why it overrides the earlier reasoning.** The default was `'project'` because a
repo's config is checked into git, reviewed like code, identical on every machine, and therefore real
signal (§20). Two of three independent reviewers rated that **blocking** anyway (§22.5), and it was kept
with the precondition merely written down. The owner's call is the stronger form of the reviewers'
point: **anything that executes repo-controlled code is off unless someone turns it on.**

That is right, and the earlier position was wrong in a specific way worth naming: it weighed the *value*
of repo conventions against the *cost* of losing them, and never weighed the asymmetry. Turning the
option on costs one field. Leaving it on by mistake runs somebody else's code with the supervisor's
ambient environment before anything the dashboard mediates — and **a hook only has to run once**. A
default whose failure mode is unrecoverable should not be chosen on the strength of its convenience.

**Two levels, both explicit:**

| level | how |
|---|---|
| one run | `spec.envProfile = 'project'` |
| one session | `CTD_WORKER_ENV_PROFILE=project` — that supervisor process only |

A run's own declaration beats the session switch: the narrower statement is the more specific intent.

**The session switch is read at CALL time, and an invalid value THROWS.** Reading it at import would
silently ignore a caller who set it late — the kind of switch people reasonably believe they have used.
And falling back to the safe default on a typo is the friendlier-looking choice and the wrong one:
whoever wrote `CTD_WORKER_ENV_PROFILE=projekt` intended to turn something **on**, so running with it off
is exactly the intent-versus-reality mismatch the `worker.env` record exists to catch. Mutations **E21**
(default back to `project`) and **E22** (silent fallback) are both caught.

**No capability is lost.** Measured on the real CLI, and re-confirmed after the flip: `'none'` gives
**0 hooks, 0 MCP servers, and the full 24-tool built-in set**. A worker loses the repo's conventions,
not its ability to work. The control probe now covers all three profiles
(`probe/evidence/11-hook-axis-positive-control.txt`), because the default is the row people will
actually rely on and the previous version did not test it.

## 32. The wire surface has a suite now, and it found the gap in its own coverage claim (2026-09-08)

`runtime/test/wire.test.js`, 7 cases over a real socket, in `npm test`. Mutation **A12**.

Three defects had lived in `supervisor.commandHandlers()` — code with no test at all (§27.5, §28.4,
§30.2). The blind spot is structural: the deterministic suites call supervisor **functions** directly,
and every real client — the pane, the hooks, the TUI — addresses them **by name over the socket**. A
function that works in-process and fails when addressed by name is invisible to all of them.

### 32.1 The coverage claim was overstated, and a mutation proved it

Case 1 enumerates `commandHandlers()` and asserts every name is reachable. I described that as
"self-maintaining coverage that cannot go stale". **It cannot see a command that was never registered**:
delete a handler and it vanishes from `Object.keys()` too, so the loop reports full coverage of a
smaller surface. That is precisely the shape of §27.5's defect — so case 1 alone would not have caught
the thing it was written for.

Found by mutation A12 (unregister `adoptSession`), which **case 1 passed** and only case 5 caught. Case
1 now also checks a **REQUIRED list** of the commands real clients address by name, grouped by which
client depends on each. That half does need maintenance when a client starts using a new command — and
that is the right place for the burden, because it is a statement about what the clients depend on
rather than about what happens to exist.

**Two halves, neither sufficient alone.** Worth stating because "enumerate the thing and assert over it"
feels airtight and quietly assumes the enumeration is itself complete.

### 32.2 A coverage probe mutates state, by definition

Case 1 sends **every** command, and the map contains `stop`, `reap`, `interrupt` and `clearContext`. The
first version aimed the probe at the run the later cases depend on and killed it — case 4 then failed
with "no open run for worker w1", which reads *exactly* like the `tuiChat` defect it was written to
catch. A false positive that mimics the real defect is worse than a plain failure, because it invites
the wrong fix.

The probe now has a disposable run and worker of its own. Anything that exercises a whole command
surface needs a target it is allowed to destroy.

### 32.3 What the suite asserts beyond reachability

`tuiSnapshot`'s **shape**, not just its `ok` — §28.4 and §30.2 were both a missing field in a
projection, so `runs[].workerId` is asserted by name. Reply-id echo, since correlation is what makes one
socket usable by one client. An unknown command refused **by name**. And that a malformed frame does not
take the server down, because a client sending nonsense must not be able to end the session for
everyone else.

## 33. Tier 2 exists, and the assertion that proved it was vacuous first (2026-09-08)

Rule 4's missing middle is built: `domain/turn-digest.js` (pure), wired into the supervisor at
`turn.end`, and read by tier 3's `Assumptions` section — which had been empty-by-design since the day it
was written, waiting for exactly this (§24).

### 33.1 The deviation from Rule 4, stated up front

Rule 4's table says a digest is written "by the cheapest available model". The DEFAULT here is
**extractive and model-free**; a model-backed digester is an injected option (`createSupervisor({
digester })`). Three reasons, the third decisive:

1. **Cost.** A digest per turn is a model call on the most frequent event in the system. Rule 5's premise
   is that clearing is cheap *because* tier 3 exists; making tier 2 expensive moves the cost rather than
   removing it.
2. **Testability.** A summary written by a model can be checked for shape but never for content.
3. **It cannot invent.** An extractive digest quotes; a generated one can state a decision nobody made.
   Its reader is a **resumed worker that will act on it** — the same argument that keeps tier 3
   deterministic.

So the default states **no assumptions at all**, and that is the honest answer rather than a gap: nothing
in a transcript is *labelled* an assumption, so anything in that field would be inferred. Filling it is
precisely what a model is for, which makes it the clean seam between the two digesters.

### 33.2 `turnIndex` is not a turn's identity, and the fix was wrong once too

Replay is normal: after `resume()` the pump re-observes and **re-persists the whole buffered log**
(seq is only meaningful within a generation), so one real turn occupies two slices of `event_log`. An
index-keyed digest is therefore written twice, and the duplicate reaches tier 3 as a *second worker
stating the same assumption* — duplication that **inflates evidence**, which is worse than duplication
that merely wastes rows.

So digests are keyed on content as well (`turnKey`). The first version hashed the **whole slice**, and it
did not work: the replay seam prefixes the slice with the previous session's trailing events, so the
replayed copy hashes differently. `turnKey` now hashes the turn *proper* — the events at and after the
last `turn.start`. Its known false negative is stated rather than hidden: two genuinely identical turns
share a key, so the second is not digested, and its digest would have been identical anyway.

### 33.3 The vacuous assertion, for the seventh time

The wiring case asserted **"all digest keys are distinct"**. It passed while `echo:first` was digested
twice — because a duplicate that gets past a key-based guard does so *precisely by having a different
key*. The assertion could only ever fail when the mechanism it was checking was already working.

Caught by printing the digests rather than by the assertion. It now asserts on **content** (no two
digests share a summary; the pre-resume digest still has exactly one), and mutation **D9** keeps the
whole-slice version dead. Same lesson as §24.3 and §27.2, in a new costume: *an assertion phrased in
terms of the mechanism's own output can be satisfied by the failure it is meant to catch.*

### 33.4 A failed digest costs a digest

Tier 2 is a convenience for whoever reads the run later; tier 1 is the record of what happened. Every
digest failure is caught and logged as non-fatal, and the wiring suite proves the run keeps persisting
and keeps working afterwards. Mutation **D7** turns a digest failure into a closed event stream, which is
the plausible version of getting this wrong.

### 33.5 Both kinds of empty

Tier 3's `Assumptions` now distinguishes "**no turn has been digested**" from "**N turns were digested
and none stated an assumption**". They look identical in a document that says only "none", and a reader
acts differently on each: the first means the source is missing and someone should go and look, the
second means there is nothing to look at. `sources` records both numbers for the same reason. Mutation
**H14** collapses them.

Coverage: `domain/test/turn-digest.test.js` (11 pure cases), `runtime/test/turn-digest-wiring.test.js`
(6 cases against a real child process), `runtime/test/_mutate-turndigest.mjs` (10/10), and
`_mutate-handoff.mjs` grew H13/H14 for the tier-3 half (14/14).

## 34. Phase 4 is finished, and the thing that found the last defect was reading a frame (2026-09-08)

Replay by cursor, the mouse, and the Requests panel — the three items ROADMAP had left open on the TUI.

### 34.1 "Replay" was a window, and that is invisible

The TUI re-read the last 60 tier-1 events every tick and called it a transcript. FLOWS §5 asks for
"replayed by cursor when a pane is switched to", and the two are indistinguishable on any run shorter
than 60 events — which is every run in every suite here. That is the whole reason it survived a phase.

`tuiSnapshot` now takes `cursors: { runId -> lastSeq }` and returns only what is new. Two properties came
with it that a window cannot have:

* **A gap is a NUMBER.** When more arrived than one slice returns, the count of what was skipped comes
  back and the client writes it into the transcript. A pane that silently skips events shows a hole that
  looks exactly like a worker having said nothing — the same argument behind the pump's `gap` frames.
* **Unfinished prose is PROVISIONAL.** `assistant.delta` events coalesce into one line, and a poll can
  land mid-turn. Committing that would print half a sentence as a finished line and the rest as a second
  line next tick — §28's "one fragment per line" defect from a new direction, this time into an
  append-only client buffer where the wrong version stays. So the cursor stops at the last event that is
  not part of a trailing run of deltas, and the client replaces that line until it settles.

Tier-2 digests are excluded from the projection. They share `event_log` (Rule 4), so the tier filter is
the only thing separating "raw events for humans" from "summaries for agents", and a pane would otherwise
show a paraphrase of the transcript printed directly above it.

### 34.2 One arithmetic for drawing and for clicking

`frameGeometry(state, size)` returns every row range and column range, `renderFrame` lays the frame out
from it, and `hitTest` reads the same numbers back. Two copies — one to draw, one to hit-test — is the
standard way mouse support rots, and the symptom ("clicking a request selects the one below it") reads as
a mouse problem rather than as a duplicated calculation. Mutation **U8** keeps the duplicate dead.

The test does not assert that `hitTest` agrees with `frameGeometry`; they are the same arithmetic, so that
would be vacuous. It finds the frame row that actually contains the drawn text and clicks THAT.

Only the press of button 0 is a click. A release counted as a second click is invisible for selection and
wrong for anything that toggles; a wheel event decoded as a click would scroll the tree by opening
whatever is under the pointer.

### 34.3 The Requests panel exists; the thing that fills it does not

The panel is built and READ-ONLY, reading `requests` where status is `pending`. The Slack inbound path
that creates those rows is still backlog (PLAN.md §14.4), so the four buttons are drawn and inert — a
button that claimed to Accept a request nothing can produce would be a lie about what exists, whereas a
panel that is real the day rows appear costs one query.

`h` hides it **while it is focused**, and moves across the team bar everywhere else. That is FLOWS §5's
opening rule doing real work: the same key, two meanings, no collision, because the lookup is scoped by
focus. Mutation **U7** makes `h` global again and the suite catches it on the team-navigation half.

An empty list CLEARS `requestsHidden`. Without that, hiding one batch would silently swallow every future
request and §6a's "appears the moment one lands" would be false — with no indication anything had been
suppressed.

### 34.4 The defect a test would not have found

`state.status` was written by half the actions in `state.js` — and by `refresh()` on every failed round
trip, as `supervisor unreachable: <reason>` — and **rendered by nothing**. A dashboard whose daemon had
died looked exactly like one whose workers were quiet. The system knew what was wrong and did not say.

Found by reading `tui/evidence/01-demo-frames.txt`, which is the third time looking at this UI has found
something the suites passed through (§28 found three). The frames are now captured by a committed script,
`tui/capture-frames.mjs`, because that only keeps happening if looking is one command.

The status line lives in the footer's rule so it costs no vertical space, which meant `rule()` had to
start truncating its label: an over-long message returned a line WIDER than `cols` and broke the redraw
contract — and only ever would have done so once something else had already gone wrong, since the long
messages are the error ones. Mutations **U11** and **U12**.

Coverage: `tui/test/tui.test.js` (17 pure cases), `runtime/test/tui-replay.test.js` (6 cases over a real
socket), `runtime/test/_mutate-tui.mjs` (13/13).

## 35. Phase 5 is finished: profiles, assignment, and a fork put to two models (2026-09-08)

The four items ROADMAP had left open on the domain layer.

### 35.1 Profiles that change behaviour without adding a diagram

`domain/workflow-profiles.js` answers three questions per task type: which roles the task needs, how many
reviewer verdicts `approved` requires, and which pane layout is the smart default. All three were already
in PLAN.md — §11's "each role the task needs", §13's quorum, §5's "smart default from task type" — and none
of them existed anywhere in code, so every task got identical treatment and the differences lived in prose.

**It adds no state machine edges, and that restraint is the point.** It would be easy to give `adhoc` a
profile that skips `awaiting-review`, and §6 warns against exactly that class of change: `superseded`,
`reopened` and `merge-rejected` are named as NOT yet added because "adopting all of them before a runtime
exists to test any of them produces a large schema for a system that cannot run". Per-type edges would be
the same mistake with a different label — one diagram becomes four, each with its own untested corners.

So the profile's only connection to the machine is a GUARD PARAMETER: `requiredVerdicts`, which
`canTransition` already accepted. An `adhoc` task has no reviewers (§10) and therefore needs zero verdicts;
a `feature` task needs two; **an unprofiled type gets the stricter default**, because a type nobody has
thought about yet should not be the one that reaches `approved` unreviewed (mutation **N8**).

And no reviewers still means no autonomous merge. §6 calls the human gate "a hard rule, not a default that
can be silently skipped", and no profile touches it — asserted directly, because "zero required verdicts"
is exactly the shape of thing that invites a shortcut.

### 35.2 Loud on a typo, quiet on absence

`harness-defaults.json` is PLAN.md §3's stated exception to "SQLite is the only truth": user-authored input,
read straight from disk. Two opposite behaviours, both deliberate:

* **A missing file is normal.** Nothing ships one, so the first assignment on a fresh install has no file.
  PLAN.md §11's own table is the built-in fallback, and the resolution records `source: "built-in"` so a
  human can tell "what I configured" from "what nobody configured".
* **A malformed file throws.** Someone who wrote `"modell": "opus"` intended to change something, and
  running with their intent silently dropped is §31's intent-versus-reality mismatch in the file a human is
  most likely to typo. Mutation **N3**.

Per-team overrides merge **per field**. Whole-slot replacement passes every test written with a full
override and blanks the harness on a partial one — and a partial override is the only kind anyone writes,
since the point of overriding one field is not restating the other two. Mutation **N2**.

Reviewer slots are ordered by nickname, not by registry order, because which reviewer is `reviewer2` decides
which HARNESS they run on — §11's own example puts reviewer2 on OpenCode. An unstable order would swap two
reviewers' harnesses between assignments for no visible reason, and the two reviewers exist precisely
because different harnesses catch different things. Mutation **N9**.

### 35.3 The idempotency key has to be claimed before the spawn, and my first test could not tell

The key is written BEFORE any process starts. The duplicate-start window is the gap between the first
`await` and the write, so a claim that lands after the spawns leaves it wide open.

**The first version of the test asserted this and did not test it.** Two SEQUENTIAL confirms prove only that
a finished assignment is remembered — true even with the claim in the wrong place, because by then the
record exists. Mutation **N1** moved the claim below the spawns and the test passed. It now fires two
confirms CONCURRENTLY and asserts that exactly one of them started anything.

That is the fourth vacuous assertion this project has caught (§24.3, §27.2, §33.3, here), and the pattern is
now stable enough to state as a rule: **if a mutation of the mechanism leaves the test green, the test is
about something else.** A mutation harness is not only a regression net; it is the only reliable way to find
out whether an assertion exercises what it names.

### 35.4 Keep what worked — a fork, put to two models

When the coder starts and a reviewer does not: (A) kill the coder and mark the task `start-failed`, or (B)
keep the coder, move the task on, record the failed role as retryable.

**B.** Two independent models (`luna`, `terra`, via OpenCode) were asked, because this is a judgement rather
than a fact, and both chose B with the same caveat: partial startup must never silently become a completed
task. It cannot here, and not by convention — `approved` needs the profile's reviewer verdicts and `merged`
needs an explicit human approval. Killing a working coder because a reviewer failed to spawn throws away
real work to preserve a symmetry nothing needs, and the reviewer is retryable in one command.

Mutation **N4** reverses it, and note how defensible the mutant sounds. That is why it is a mutation rather
than a paragraph.

When NOTHING starts, the task goes to `start-failed` (mutation **N5**). `starting` is the worst of the three
states to be wrong about: it says a process is coming up, so anything watching waits for a report that will
never arrive.

And a failed role appears in the tier-3 handoff's **Blockers**, with "retry the assignment" next to it.
Recording a failure nobody surfaces is how "the task is not stuck in `starting` forever" quietly becomes
"the task is short a reviewer forever" instead. Mutation **N10**.

### 35.5 A coverage probe needs every target to be expendable

`wire.test.js` case 1 sends every command in the map, and `assignTask` transitions task state — so the probe
left the shared task in `start-failed` and case 6's `created -> starting` failed. §32.2 already recorded the
disposable-run version of this lesson; the general form is that **a probe over a whole command surface needs
every target it touches to be expendable, not just the ones that were obvious when it was written.**

Coverage: `runtime/test/assignment.test.js` (10 cases), `runtime/test/_mutate-assignment.mjs` (11/11),
plus `tui/test/tui.test.js` case 18 and `runtime/test/tui-replay.test.js` case 7 for the pane default.

## 36. The wrapper tier is built, and it found the flaw in its own gatekeeper (2026-09-08)

PLAN.md §9's `wrapper` tier — the canonical degraded mode for a harness with no structured output — existed
as classification with nothing behind it. `adapters/wrapper/adapter.js` is now the driver.

### 36.1 Pipes, not node-pty, and why that is a decision rather than a shortcut

§9 specifies "`node-pty` + a terminal parser". This is pipes, line-splitting, and ANSI **stripped rather
than interpreted**. Three facts decided it:

* `node-pty` is a **native build dependency**. This project has exactly one dependency on purpose.
* **Zero harnesses need it.** Both real adapters emit structured events (`stream-json`, `sse`). The tier is
  for a hypothetical third CLI.
* A pty buys exactly two things over pipes: a harness that **refuses to run without a tty**, and cursor
  addressing (progress bars, alternate screens) — which is output a pane discards anyway.

TODO's own instruction was to *decide whether the tier was wanted at all* before building a terminal-parsing
path, so the decision was the deliverable. It was put to two independent models with three options (add
node-pty now / pipes now and defer / build nothing); both chose pipes-and-defer, both for the dependency
reason, and both made the same point about building nothing: **a documented tier that nothing exercises
hides its architectural gaps until integration pressure arrives.** That turned out to be literally true —
see §36.2, found within an hour of starting.

`node-pty` is deferred, not dropped. The day a harness demands a tty, the parser gets written against that
harness's real output instead of a guess.

### 36.2 A degraded adapter that tells the truth was marked `active`

`verdict()` derived the tier from whether the conformance checks passed. That reads correctly for the two
situations §9 names — no capability matrix, or a matrix whose claims do not hold — and gets a third exactly
backwards:

**A degraded driver that declares itself honestly passes every check.** `adapters/wrapper` declares
`structuredOutput: 'terminal'`, implements precisely what it declares, and would have been flipped to
`active`. The mechanism whose entire purpose is to stop a degraded harness being "silently treated as
equivalent to a real, conformance-passing adapter" would have done exactly that — to the one adapter that is
degraded *by definition*.

So `wrapper` is now also reached by declaring `structuredOutput: 'terminal'`, whatever the checks say.
**Honesty in a declaration must not be what costs an adapter its accurate label.** `passed` stays true for a
conforming wrapper, because "does what it says" and "is degraded" are different facts and collapsing them
would make a conforming wrapper indistinguishable from a broken adapter in every report and log (mutations
**W1**, **W2**).

### 36.3 What the tier refuses to invent

* **No turn boundaries except process exit.** Nothing in raw terminal text marks a turn. Mutation **W4**
  guesses one from `/done|complete|finished/` — and the first version of the test PASSED it, because the
  fixture's output contained no word a naive parser would take for a boundary. The fixture now contains the
  bait ("Done. Build complete.") on purpose. *A negative assertion needs the thing it forbids to be present
  in the input, or it proves only that the input was harmless.* That is the fifth vacuous assertion this
  project has caught (§24.3, §27.2, §33.3, §35.3, here).
  The stakes are concrete: tier-2 digests are written at `turn.end`, so an invented boundary produces a
  summary of half a turn which a resumed worker reads as the state of the work.
* **No approvals.** `approvalProtocol: false`, and `answerApproval` genuinely does not exist — which is what
  stops an `ask` being created that nothing can ever answer.
* **No clear, no resume.** Both need harness-side state this driver knows nothing about.
* **No guessed command.** `spec.command` is required. A default would turn a misconfiguration into a harness
  that appears to start and produces no output — indistinguishable from a quiet harness, diagnosed by nobody
  (mutation **W9**).

### 36.4 Marked twice, and flagged on the data

§9: a wrapper-tier harness "is always explicitly marked as such in the UI". The pane says `[wrapper tier]`
in its header AND carries a body line naming what is missing — twice, because a narrow split pane truncates
the header, and the mark is the difference between "the worker said this" and "this is raw terminal output
nobody parsed".

Every event also carries `degraded: true`. The pane mark is a UI decision any other consumer can miss; the
flag travels with the data (mutation **W10**). And the flag the TUI reads comes from `harnesses.status`,
which the conformance verdict wrote — so the mark follows the measurement rather than a second list somebody
maintains (mutation **W8**).

What it does exactly as well as a real adapter, and the reason it is safe to run: its own **process group**,
via `spawnManaged`. A wrapper-tier run is reapable by verified identity like any other.

Coverage: `runtime/test/wrapper-tier.test.js` (8 cases, including a real `/bin/sh` run and a real reap),
`runtime/test/_mutate-wrapper.mjs` (10/10).

### 36.5 An edit that vanished, and why it is recorded here

Partway through Phase 6, four of this section's changes were **gone from disk**: the `verdict()` rule above,
the snapshot's `harnessTier`/`degraded` fields, and both TUI marks — while every file that had been *created*
in the same stretch (the adapter, its suite, its mutation harness) was intact, as were all the changes from
the phases before it. `npm test` reported 104 suites instead of 109 and `wrapper-tier` case 4 failed on
exactly the assertion §36.2 describes.

The cause was outside this session's edits (the mutation runner restores from original bytes per mutation and
had already completed cleanly; nothing here rewrites those files). It is written down because of what caught
it: **the suite count.** A number that had been 109 for three commits' worth of work read 104, which is a
question worth asking rather than a rounding error. Re-applied and re-verified. Worth watching for a sync,
backup or editor process that restores tracked-looking files under this tree.

## 37. Phase 6: reviews are configurable, and the rule is enforced rather than described (2026-09-09)

`migration 0009`, `config/review-profiles.js`, `domain/review.js`, and the supervisor's review surface.
Section 13 of PLAN.md exists because all four independent reviews of that document found the original review
model rigid in the same four ways: hardcoded reviewer slots, verdicts that outlive the commit they judged,
undefined quorum, undefined precedence when verdicts disagree. This is the fix, and every part of it is
mutation-verified (15/15).

### 37.1 The rule, and why it is three separate conditions

> "A task reaches `approved` only when every **blocking** dimension has ≥1 current-round approval, quorum is
> met, and there are **zero** current-round change requests."

Evaluated and REPORTED as three independent clauses, because each fails differently and "not approved" is not
an actionable answer. `evaluateReview()` returns reasons: *"blocking dimension "security" has no approval for
this revision"*, *"quorum not met: 1 of 2 distinct reviewer(s)"*. A pane can print those; a boolean sends
somebody to read the verdict table by hand.

Three things that look like the same knob and are not:

* **Quorum counts DISTINCT REVIEWERS, not verdicts.** One reviewer approving five dimensions has not met a
  quorum of two, and counting rows says it has (mutation **R1**). Invisible in any test with two cooperating
  reviewers — it only shows up when one reviewer is thorough.
* **Every blocking dimension needs its own approval.** "Some blocking dimension is approved" ships code where
  correctness was checked and security was never looked at (mutation **R2**).
* **`parentRequired` is not `parentCounts`.** "The parent must weigh in, and its opinion is not one of the N"
  is a coherent, deliberate combination, so they are separate conditions with separate refusals.

And a change request on a **non-blocking** dimension still blocks while `changeRequestBlocks` is on — the flag
says "any current-round change request". "Non-blocking" describes whether an approval is *required* there, not
whether an objection counts (mutation **R5**).

### 37.2 The asymmetry in `revisionBound`, which is the part nobody expects

"Approvals die when the commit changes." So a stale approval is dropped — but a stale **change request is
kept**, because nobody has said it was fixed. Treating them symmetrically lets an obsolete approval and an
obsolete objection cancel out, and the task approves on the strength of two opinions about code that no longer
exists (mutations **R3**, **R4**).

`revisionBound: false` weakens the commit check and NOT the round check. A verdict from round 1 says nothing
about round 2 under any profile.

### 37.3 A profile is a small language, and its typos decide whether code merges reviewed

Section 13's own example makes `hotfix` extend `default` and then override `dimensions` with **bare id
strings** (`["correctness", "security"]`), so resolution is not a merge: a string list selects from the
parent's dimensions, keeping each one's `blocking` and `prompt`. Resolved once at import, so no consumer can
read `blocking` off a string.

Same asymmetry as `harness-defaults.json` — **loud on a typo, quiet on absence** — with higher stakes:

* A **missing file is normal** (nothing ships one); PLAN.md §13's own table is the built-in default.
* A **selected dimension the parent does not define is an error.** Tolerating it makes the profile review
  fewer dimensions than its author wrote, and in the limit review *nothing* — at which point every blocking
  dimension is trivially satisfied and the task approves with no review at all. A silent config typo becoming
  "approve everything" is the worst failure available in that file (mutation **R11**).
* **Quorum merges per field.** `hotfix` overrides only `required`; whole-object replacement drops
  `parentCounts`, and `undefined` is falsy in the same direction, which is exactly why it survives casual
  testing (mutation **R12**).
* A `perPath` rule naming an undefined profile is refused — section 13's own example names `payments-strict`
  without defining it, and a path rule pointing at a missing profile silently applies no extra strictness,
  which is the opposite of what it was written for.
* **perPath beats perTeam beats default**, because a path is the narrower statement: a team profile is a
  habit, `packages/payments/**` is a property of the code being changed (mutation **R13**).

### 37.4 Why `review_profiles` is a table when `harness-defaults.json` is not

PLAN.md §3 draws that distinction and it looked arbitrary until this was built. The reason is **durability of
judgement**: a stored verdict says "correctness was approved" and means nothing without knowing whether
correctness was blocking at the time and what quorum was in force. Reading the current file would answer with
today's config, so editing a profile would silently rewrite the meaning of every verdict already recorded —
"verdicts that outlive the thing they judged", arriving from the config side.

So each resolved profile is stored under a **content hash**, every verdict records the `(profile_id,
profile_hash)` it was judged under, and re-import is `INSERT OR IGNORE`: an identical re-import writes nothing
and does not move `imported_at`, while an edit adds a row beside the old one (mutation **R9**).

An assignment's harness/model choice needs none of that: it is an input to a process, not a lens through which
a stored judgement is read.

### 37.5 A verdict is five columns of identity, and a revision replaces its own row

`(task_id, round, commit_sha, worker_id, dimension)` is UNIQUE, and a reviewer revising its own opinion
UPSERTs. Appending instead leaves "which of these two is current" unanswerable from the data — and since the
rule counts current-round verdicts, a reviewer who requested changes and then approved would have both on
record, with the change request blocking forever (mutation **R10**).

`worker_id` rather than `run_id` on purpose: §3's identity split means a reviewer that was cleared or
respawned mid-round keeps its verdicts.

### 37.6 The verification pass, and the honest default

§13: `verifyFindings: true` runs each finding through an adversarial pass "before it ever reaches the coder —
findings that fail verification never arrive". So verification happens **before storage**: a finding stored as
confirmed and filtered later is one query away from a coder anyway (mutation **R7**).

**The default verifier confirms nothing, and that is the boundary rather than a stub.** Deciding whether a
finding is real means reading the code, which needs a model. With none configured a finding is `unverified`
and is **delivered, labelled**. The two alternatives are both worse: calling it CONFIRMED is a lie (nothing
checked it, mutation **R8**), and dropping it loses a real finding to a missing configuration. Same shape as
the tier-2 digester's `source` field — injectable, free by default, labelled so a reader always knows which
they have. A verifier that throws keeps the finding with the failure as its note.

What the coder gets is §13's deliverable: **ranked, `file:line`, REFUTED absent.** And findings are stored so
a re-review diffs against the previous round rather than re-deriving it — identity is `file:line:summary`
normalised, because a reworded or re-verified finding is plainly the same finding and a stricter identity
reports every persisting one as new, which costs *more* than re-deriving and leaves `resolved` — the only
evidence a round achieved anything — permanently empty (mutation **R14**).

### 37.7 `approveTask` is the only path, for the reason Phase 5 already learned

`recordTransition` will happily take `awaiting-review -> approved` from anybody who passes two verdicts. So
the rule is enforced in one place, and the test asserts both halves: the refusal carries reasons AND the task
did not move. Mutation **R6** evaluates the rule and transitions anyway — the exact shape of the pre-Phase-5
state machine, where `canTransition` computed a verdict nothing consulted. A rule nothing enforces is a
comment.

And §6's hard rule is untouched: an approved review is still not a merge. `merged` needs an explicit human
approval, and no number of green reviews is one.

### 37.8 Model diversity, promoted from habit to validated property

§13 asks for `modelDiversity: "require-distinct-harness"` to be validated, on unusually direct evidence: the
four reviews that produced PLAN.md's own revision ran on two harnesses, and "the highest-value individual
findings each appeared in exactly one of them".

Checked at assignment time and **reported, not refused** — two reviewers on one harness is a weaker review,
not an unsafe one, and blocking real work over a configuration problem is the wrong trade. It is impossible to
miss, though: it takes the same route to the tier-3 handoff's **Blockers** that a failed role takes, with
"reassign a reviewer to another harness" next to it (mutation **R15**).

### 37.9 The review bar: what ROADMAP's "review-pane wiring" actually needed

The toggles ROADMAP names (`1`/`2`/`p`/`r`, dev-pane auto-expand) were built in Phase 4. What was missing is
the thing a human needs from a review — **which of the three conditions is short**. `awaiting-review` as a
state glyph answers none of them: a reviewer can have approved everything while quorum is one short, and that
is indistinguishable from nobody having looked.

So one line, only while a review is in flight, showing the verdict first and then per-dimension state plus
quorum (`corr ok · secu 1chg · test - · quorum 1/2 · 1 finding(s)`). Words rather than ticks, because at the
60-column minimum words survive truncation more legibly than symbols. Clicking it shows the reviewers.

Three things this cost, each caught by its own mutation: the bar must be **absent** when no review is in
flight (**U14**) — an empty bar reads as "a review exists with no verdicts", which is a different and more
alarming state; the geometry must **move by exactly the bar's height** or every click below it lands two rows
off (**U15**); and it must **clear** when the review ends (**U16**), because a stale "blocked" on an approved
task is the kind of wrong that gets acted on. U16 needed a two-tick client harness to catch — it was briefly
recorded as a known coverage gap, then closed rather than left documented.

The UI reads the EVALUATED rule from the snapshot. A dashboard that re-evaluated §13 for itself is how it
comes to disagree with the system it is displaying.

Coverage: `domain/test/review.test.js` (11 pure cases), `runtime/test/review.test.js` (11 cases including a
real socket), `runtime/test/_mutate-review.mjs` (15/15), plus `tui/test/tui.test.js` case 19 and
`runtime/test/tui-replay.test.js` case 8.

### 37.10 The Phase 6 review, and the pattern in what it found (2026-09-09)

Reviewed by `opencode --agent sol --variant medium` (Bedrock `gpt-5.6-sol`). **6 blocking, 4 should-fix, 2
refuted; every finding accepted, ten fixed, and each blocking one REPRODUCED against the pre-fix code before
being changed.** Full record: `review-phase6/verdicts.md`.

**The pattern, and it is the most useful thing to carry forward: three of the six blocking findings were
mechanisms that had been built, documented, and never actually consulted.**

* Migration 0009 content-addresses every profile and stamps every verdict with the hash it was judged under —
  and `reviewStatus()` selected the profile from the *current file* and ignored both. §37.4 above explains at
  length why that protection matters. It was not connected to anything. Loosening a profile made an
  insufficient set of verdicts approve a task.
* `evaluateReview` counts distinct `workerId`s and treats `slot === "parent"` as the parent's approval — and
  `recordVerdict` took both off the socket without checking that the worker was even on the task. The rule was
  right; its input was forged. Quorum of two was reachable with one reviewer plus any stranger.
* `approveTask` took `round` and `commitSha` as arguments and passed them into the guard, so the caller chose
  which reality the rule was applied to. A green round 1 could be approved while round 2 held a change request.

None of those is a logic error. Each is a **seam** — the place where a correct mechanism meets its caller —
and a seam is invisible to a test written by whoever built the mechanism, because that test asserts what the
code was *meant* to do. Two more of the six were of the same family: verification happened before storage but
the diff shipped what verification had rejected, and the write path was async while the approval path was not.

Practical rules this produced, worth applying to Phase 7's authorization work, where the same shape is even
more dangerous:

1. **Anything the rule counts must not be supplied by the caller.** If a field decides authority, derive it.
2. **A protection that is stored but never read is worse than one that is absent**, because the document says
   you are covered. Ask of every stored field: what reads it?
3. **An async write path and a synchronous decision path cannot both be right about the same state.** Serialize
   them, or the guarantee is "usually".
4. **Filter at every exit, not the obvious one.** `ranked` excluded REFUTED findings; `diff` did not; both go
   over the same socket.

Sol also caught two tests making claims they did not test (a "rewording" that was only a re-casing, and a
verification-order case that could not observe order) and one mutation whose stated rationale was wrong (R9).
Those are corrected in place — the mutation count went 15 -> 27, and the four new PROBLEM results the additions
produced were themselves two stale patterns and two missing assertions, all fixed.

## 38. Phase 7's gate: capability-based authorization, and what a principal can honestly be (2026-09-09)

`migration 0010`, `domain/capabilities.js`, and the supervisor's `authorizedCommandHandlers()`. Section 16
replaced the original fixed hop chain (worker -> lead -> CTO -> utility agent) with "every caller carries an
immutable principal and a set of capabilities", and this is that. It lands FIRST in Phase 7 because every
utility agent is gated by it — handing out the roster before the gate exists is the sequencing bug this project
already hit once, when the assignment UI was designed before `start()` existed to call.

### 38.1 There is no socket peer credential, and that changes the design

Section 14.5 specifies the principal as "minted at ingress — the foreground TUI user, or a socket peer
credential". **Measured before designing anything**
(`adapters/claude-code/probe/peercred-probe.mjs`, evidence 17): on a Unix-domain socket Node exposes
`remoteAddress: undefined` and a libuv handle with `bind, listen, connect, open, fchmod` — nothing about uid,
gid or pid. Adding a native module for `LOCAL_PEERCRED` was rejected for the same reason `node-pty` was: one
dependency, on purpose.

So a principal is two things stacked, and each proves something different:

1. **Filesystem permissions.** The state dir is 0700 and the socket is inside it, so only the local user can
   connect. That authenticates the USER and nothing finer.
2. **A token the supervisor mints**, delivered by a channel it controls — the owner's in a 0600 file, a
   worker's in its spawn environment. That says WHICH principal.

**The honest limit, stated because everything above inherits it:** workers run as the same user, so a worker
that reads `owner.token` holds the owner's authority. The same-uid boundary is the real one; this layer buys
attribution, structural limits (fixed toolsets, no charitable interpretation) and an audit trail — **not a
sandbox**. A real sandbox is a separate uid per worker or OS-level confinement, and that is a different piece of
work. An environment variable is also inherited by descendants, so a worker principal identifies a RUN AND
EVERYTHING IT SPAWNS.

### 38.2 Two properties made structural, because §37.10 said what happens otherwise

The Phase 6 review found three defects of one shape: a mechanism built, documented, never consulted, with the
inputs its decision depended on taken from the caller. Authorization is that shape by construction, so:

* **Nothing the decision reads comes from the request.** `authorize()` takes a principal OBJECT resolved from a
  token hash; the capability set is a property of that row. Mutation **A2** lets a request carry its own
  capabilities — the same defect as Phase 6's forged `workerId` — and it survived until case 4 was made to
  ATTEMPT the escalation. A test that never tries cannot catch it.
* **It fails closed.** A command absent from `COMMAND_CAPABILITIES` is refused, so a new command is unreachable
  until someone classifies it (mutation **A3**). The coverage case enumerates the real handler map and asserts
  the policy covers it — and immediately found two STALE entries for commands that were never on the wire,
  which is the other half of fail-closed being useful: a policy naming things that do not exist is a policy
  nobody can trust to be complete.

### 38.3 The hole the wrapper could not close by itself

`ipc/server.js` had a built-in `switch` implementing `start`, `stop`, `sendInput`, `observe` and `list` against
the mock adapter, reached whenever a command was absent from the supplied map. As a fallback it was two
problems at once:

* §27.5's defect made silent — a misregistered command answered plausibly by a mock instead of "unknown cmd".
* **An authorization bypass.** `authorizedCommandHandlers()` wraps the MAP; it cannot wrap a case statement
  inside the server. Any command missing from the map would have been served with no principal at all.

Fixed: when a real command surface is supplied, an unregistered command is refused. `ping` is the one
exception — a liveness probe carries no state, and the daemon's crash tests need it before they hold a token.
Mutation **A12** restores the fallback and case 9 catches it.

### 38.4 §6's merge gate and §16's sensitive class are the same mechanism

`merged` "requires an explicit human/senior approval gate" (§6), enforced until now by a `humanApproved: true`
boolean a caller passed — a promise, not evidence. `task:merge` is in §16's sensitive class, so `mergeTask`
requires a second principal's approval **bound to the exact arguments**, single-use, expiring, recorded with
who granted it. `humanApproved` is now justified by that artifact.

The CTO holds `task:merge` AND `approve:sensitive`, which is not a contradiction: **self-approval is refused**,
so a CTO merge still needs the human's signature. Mutation **A5** removes that check — and it survived at first,
because an earlier edit had spliced other content into the case and silently deleted the assertion. The harness
caught what reading the file did not.

### 38.5 A guard that is not load-bearing yet, and how to say so

The `consumed_at IS NULL` guard in `consumeSensitiveApproval` is measured to be **unobservable today**:
`findSensitiveApproval` and `consumeSensitiveApproval` are synchronous and adjacent in the wrapper, so nothing
can interleave, and the read filter already refuses a replay. Rather than delete it or pretend a test covers it,
there are now two mutations: **A6** removes the guard and is marked `expectSurvives` with the reason, and
**A6b** inserts an await into that window *and* removes the guard — which is exactly the refactor a future
maintainer makes without thinking — and case 7 catches that.

Case 7 also had to move IN-PROCESS to be able to see it at all: two real socket connections do not interleave
inside the decision window, because the server finishes dispatching one frame before the next arrives. **The
socket is the trust boundary; the race is intra-process.** And the case had to settle rejections into values,
because a double-spend crashes in the state machine ("already in merged") and a crash proves nothing.

### 38.6 Delivery depends on a declared capability

A worker's token goes in its spawn environment — which works for a `per-run` harness and CANNOT work for a
`pooled` one, where one `opencode serve` is shared by every run in a cwd and the second run would inherit the
first one's credential. `residentProcess` carries its value as a string for exactly this class of reason
(adapters/FINDINGS.md), so `start()` consults it and records `principalDelivery: "undeliverable-pooled"` rather
than silently handing over the wrong identity.

Writing that found a second thing: **the real `claude-code` adapter passed no `env` to `spawnManaged` at all.**
The token would have reached the fake harness in tests and nothing in production — "built, documented, never
consulted" on the very first use of the channel. Both real adapters and the fake now pass `spec.env`, and the
fake keeps `spec` so a test can assert what was delivered.

Coverage: `domain/test/capabilities.test.js` (9 pure cases), `runtime/test/authorization.test.js` (9 cases,
including the REAL spawned daemon refusing an unauthenticated command), `runtime/test/_mutate-auth.mjs`
(16/16). `daemon-crash.test.js` now authenticates like any other client, which is itself evidence the gate is
on the path that matters.

### 38.7 The Phase 7 gate was reviewed, and both blocking findings were seams (2026-09-09)

Reviewed by `opencode --agent sol --variant medium`: **2 blocking, 2 should-fix, 3 notes; all seven accepted and
fixed.** Mutations 16 -> 22. Full record: `review-phase7/verdicts.md`.

Both blocking findings were mechanisms that worked **once, or on one path**:

* **A worker only got a credential on its first run.** `ensureWorkerPrincipal` returned the existing principal
  with no token — only a hash is stored, so there was nothing to re-deliver — and every subsequent run launched
  with no `CTD_PRINCIPAL_TOKEN`. Authorization worked for exactly one run per worker, and case 4 could not see it
  because it starts each worker once. Fixed by ROTATING the token per run: one durable principal (§3's identity
  split), one working credential per run, and the previous run's token dies with the process it was issued to.
* **The installed session hook could not authenticate.** `adoptSession` needs `session:adopt`, the hook sent no
  credential, the real daemon serves the authorized map — and the hook exits 0 on every path by design, so
  adoption failed SILENTLY in production while every adoption test passed against the raw command map.

The should-fixes were the same rule as §37.10's first, one layer up: **what gets WRITTEN must not come from the
request either.** The wrapper resolved a principal and then handed the raw command to the handler, which took
`actor` from the payload — so a CTO merge was recorded as the owner's, and any string a caller sent became an
identity in the transition journal. And `findSensitiveApproval` let a newer short-TTL approval mask an older
valid one, refusing an action as expired while a good approval sat beside it.

**A fifth rule for the list in §37.10:** *a mechanism that works on the first call, or through the test's own
harness, is not a mechanism that works.* Every seam needs exercising on the path production takes — which is why
`authorization.test.js` case 9 spawns the real daemon, and why case 10 now starts the same worker twice.

Two things worth keeping from how this review went:

1. **The argument-hash binding shielded a defect by accident.** `mergeTask` is sensitive, so adding `actor` to
   the payload changes the hash and the approval stops covering the request — which means the actor-substitution
   mutation was unobservable there. It had to be aimed at `assignTask`, which takes an actor and needs no
   approval. A protection in one place can hide a hole in another.
2. **One finding is recorded as a KNOWN GAP rather than closed.** Mutation **A21** (the hook sends no token) is
   marked `expectSurvives`: the production fix is in, but no suite drives the installed hook against an
   authorized socket — `wire.test.js` uses the raw map and the slice that runs the hook for real costs tokens
   and lives outside `npm test`. Saying that is better than a green harness that implies otherwise.
