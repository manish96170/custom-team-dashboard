# Handoff — custom-team-dashboard (updated 2026-09-09, twenty-first pass: PHASES 0-6 COMPLETE AND REVIEWED, and PHASE 7's AUTHORIZATION GATE is built and reviewed. Rule 4 has all three summary tiers; the TUI is finished and runnable; §6's state machine, §13's review rule and §16's capability gate are all ENFORCED rather than described. 113 suites, 13 mutation harnesses, 185 mutations, all green. Two independent reviews (sol) found the same failure shape seven times — a correct mechanism whose SEAM was never exercised — and the five rules that came out of that are in FINDINGS §37.10 and §38.7. Next: Phase 7's roster.. NOT YET IN GIT — the plan is a PRIVATE repo on manish96170, and pushing needs an account switch plus the owner's go-ahead: see 'PUSHING THIS REPO'. The Slack bridge now has its own build plan in ../team-slack-bridge/PLAN.md.)

Read this first in a new session. It tells you what's real, what's fixed, what's
still broken, and exactly what to do next, without re-reading the whole prior
conversation.

## What this project is

A session-orchestration dashboard for running many concurrent Claude Code / OpenCode
sessions as a virtual team (leads, coders, reviewers, QA), with a single-writer
SQLite-backed supervisor daemon as the runtime. Full design: `PLAN.md` (19 sections),
`FLOWS.md` (diagrams + keybindings), `ROADMAP.md` (phased build order), `TODO.md`
(the Group 1-6 breakdown). All are up to date and internally consistent.

## Run the tests first

```
cd supervisor && npm test
```

That now runs everything — `test:db`, `test:lock`, `test:ipc`, `test:adapters`, `test:runtime`, `test:pane`,
`test:crash`, `test:tui`, `test:domain` (individually runnable too). As of this handoff **113 suites pass,
exit 0**, and all thirteen mutation harnesses are at 100% (**185 mutations**: worker-env 22, approval 14,
preflight 10, handoff 14, conformance 9, adoption 12, task-states 8, turn-digest 10, TUI 16, assignment 11,
wrapper 10, review 27, auth 22 — each observed failing BY ASSERTION at the case that protects it).

**The daemon now enforces authorization**, so any client — including a test — must present a principal token.
The owner's is written to the state dir as `owner.token` (0600) by `boot()`. `ping` is the one command that
needs none. If a request comes back with `refused: "unauthorized"`, that is the gate working, not a bug.

Re-run it twice before believing a green result: round three's `endRun` fix exposed a race that only showed up
on about one run in three. If they don't pass on a clean checkout, fix that before building anything new.

**Watch the suite COUNT, not just the exit code.** On 2026-09-08 it silently dropped from 109 to 104 because
202 files in this tree were overwritten at 17:13:40 by an older copy (cause unidentified — not this session's
edits, not the mutation runner, not git, not OpenCode's snapshot repos). Four code edits and two days of doc
updates were lost; the code was re-applied and re-verified, the docs were rebuilt from
`supervisor/runtime/FINDINGS.md`, which survived. A snapshot now lives OUTSIDE the tree at
`~/ctd-snapshot-*.tar.gz`. If the count moves without a reason you know, look for a restore before looking
for a bug.

Five things are deliberately NOT in `npm test` because they cost real money and need the network:
`runtime/test/real-claude-approval.slice.mjs`, `real-claude-crash.slice.mjs`, `real-claude-preflight.slice.mjs`,
`real-claude-adoption.slice.mjs`, `real-phase2-gate.slice.mjs`, plus `pane/test/real-pane.slice.mjs` and
`adapters/claude-code/probe/*-probe.mjs`. Run those by hand when touching the approval path, the recovery
path, adoption or the pane. **One exception worth knowing: `probe/worker-env-probe.mjs` and
`probe/hook-axis-control.mjs` are cheap** — the first makes no observable model call at all.

`test:runtime` and `test:crash` are the slow ones (~15s and ~60s): they spawn real detached
OS processes, kill real process groups, SIGKILL a real supervisor and a real daemon, and
include deliberate grace periods before SIGKILL escalation. Slow is the point — the
alternative proves nothing.

## Where we actually are

**Phase 0a + 0b: fully done.** Contracts written, runtime spiked and proven with real
code (`spike-0b/*/`), reviewed by three independent models, corrections applied. Gate
cleared.

**Phase 1: COMPLETE.** All six groups built, tested and independently code-reviewed (round three: 13 defects
fixed, 3 rejected with reasons, 1 deferred with a design reason). Group 6 — crash/concurrency validation —
found and fixed one real defect of its own (a zombie-only process group reported as having survived a kill).

**Phases 2, 3, 4, 5 and 6: COMPLETE.** Per-phase checklists are in `ROADMAP.md`; every decision and every
defect found along the way is in `supervisor/runtime/FINDINGS.md` §17-§37. The short version:

| Phase | What landed | Record |
|---|---|---|
| 2 — vertical slice (**gate: GO 2026-09-07**) | approval round trip, live pane, real-harness crash recovery, worker-env decision, preflight cleanup, tier-3 handoff, tier-2 digests | §17-§25, §31, §33 |
| 3 — second harness + adoption | capability matrix with semantics-carrying fields, conformance suite, hook adoption of human-started sessions, `started_by` provenance | §26, §27, §30 |
| 4 — TUI | pure layout/state + I/O split, replay by cursor, mouse, Requests panel, a rendered status line | §28, §34 |
| 5 — domain | §6 state machine ENFORCED, task-type workflow profiles, harness/model assignment with idempotency and partial-start compensation | §29, §35 |
| 7 — authorization gate (REVIEWED) | capability-based authorization: principals with hashed tokens, a command->capability policy that FAILS CLOSED, an append-only agent journal recording allows and refusals, and a sensitive class bound to argument hashes | §38 |
| 6 — reviews | `review-profiles.json` -> `review_profiles` (content-addressed), revision-bound per-dimension verdicts, finding verification, review bar, validated model diversity | §37 |
| — | the `wrapper` tier: pipes, not `node-pty` — and it corrected §9's own tier logic | §36 |

**Phase 7 (utility framework + git agent) is the next thing to build.** `callerIdentity`/capability
authorization must land first and in one session: every utility agent is gated by it, and handing out the
roster before the gate exists is the same sequencing bug this project already hit once.

| Group | Directory | Status |
|---|---|---|
| 1 — Persistence | `supervisor/db/` | Built, tested, reviewed. All 3 blocking bugs fixed (`createAsk` column count; concurrent-startup WAL/`SQLITE_BUSY`; unserialized migrations) + 2 new regression tests |
| 2 — Lock fix | `supervisor/lock/` | Built, tested, reviewed. Blocking TOCTOU fixed + deterministic regression test added |
| 3 — Wire protocol | `supervisor/ipc/` | Built, tested, reviewed. All 3 blocking bugs fixed + regression tests |
| 4 — Adapters | `supervisor/adapters/` | Built, tested, reviewed. Blocking SSE race fixed + regression test |
| 5 — Integration | `supervisor/runtime/` | Built, tested (5 test files: 8 pump cases, 7 reconcile cases, 9 end-to-end integration cases, 13 round-three regression cases, plus process-group ownership), mutation-verified with 15 mutations, **reviewed by luna + terra + a Sonnet consolidation; 13 defects fixed, each fix reverted and observed failing**. See `review-three/group5-verdicts.md` |
| 6 — Validation | `supervisor/runtime/test/` | Built and passing (4 suites, 30 cases: `crash-recovery`, `concurrency`, `daemon-crash`, `asks`), 21 runtime mutations each observed failing at the case that protects them. Found + fixed 1 real defect (zombie-only process group) and shipped both of its design findings as migration 0003. `npm run test:crash`. **Phase 2 gate cleared** |

Every fix listed above has a regression test that was **explicitly verified to FAIL
against the pre-fix code** (each fix was temporarily reverted and the test re-run), so
none of them are tautological. That verification step is worth keeping as a habit —
it's what distinguishes these from the spike-0b claims that didn't survive review.

## What to keep, if Phases 2-6 are ever refactored

The load-bearing invariants, in one place. Each of these is enforced by a test AND by a mutation, and each one
is a thing a reasonable person would simplify away:

- **`merged` needs an explicit human approval.** No number of green reviews is one. PLAN.md §6 calls it "a hard
  rule, not a default that can be silently skipped", and it survives every profile — including an `adhoc`
  task, which needs zero reviewer verdicts and still cannot merge itself.
- **`approveTask()` is the only path to `approved`.** `recordTransition` will otherwise take the transition
  from anybody who passes two verdicts. A rule nothing enforces is a comment — Phase 5 learned this about the
  state machine, Phase 6 about the review rule.
- **Verdicts are revision-bound, and the asymmetry is deliberate:** a stale approval dies with its commit, a
  stale change request does not, because nobody said it was fixed.
- **Quorum counts distinct reviewers, not verdicts.** One thorough reviewer is not two reviewers.
- **The supervisor only kills what it started.** `reap` refuses an adopted run, reconciliation skips the orphan
  branch for it, and `runs.started_by` makes that queryable instead of implicit in three mechanisms.
- **A clear is not a kill.** `clearContext` erases on Claude Code and COMPACTS on OpenCode — same method name,
  opposite meaning, which is why the capability matrix carries semantics as strings rather than booleans.
- **No agent reads tier 1.** Tier 2 digests and tier-3 handoffs are what cross a worker boundary. Tier 2 is
  extractive by default and states no assumptions; tier 3 QUOTES tier 2 and never infers.
- **Findings are verified before storage, and an unverified finding says so.** With no verifier configured a
  finding is `unverified` and still delivered — calling it confirmed is a lie, dropping it loses real work.
- **A wrapper-tier run is always marked**, in the pane header, in the pane body, and as `degraded: true` on
  every event. `structuredOutput: 'terminal'` means wrapper tier however well the adapter behaves.
- **Partial starts keep what worked.** The coder that started is not killed because a reviewer did not; the
  failed role becomes a retryable blocker in the handoff. If NOTHING starts, the task lands in `start-failed`
  and never sits in `starting`.
- **Repo config is OFF by default.** `'project'` — which executes a repo's committed hooks — is opt-in per run
  or per session, and an invalid session value throws rather than silently running with it off.
- **Nothing the authorization decision reads comes from the request.** The capability set is a property of the
  principal row, resolved from a token hash. A request that names its own capabilities is refused exactly like
  one that does not — and the test has to ATTEMPT that escalation, or the mutation survives.
- **The gate fails closed.** A command with no declared capability is refused, and `ipc/server.js`'s demo
  `switch` is no longer a fallback for a real command surface (it was an authorization bypass, since the
  wrapper wraps the map and cannot wrap a case statement).
- **`merged` needs a second signature bound to the arguments.** Self-approval is refused, so a CTO merge still
  requires the human. That is §6's gate as an artifact rather than a boolean.
- **Authorization is not a sandbox.** Workers run as the same user and can read the owner's token; §38.1 says so
  explicitly. Do not let a future note claim otherwise.
- **Every idempotency key is claimed before the side effect**, not after. And test it concurrently: a
  sequential pair of calls passes even when the claim is in the wrong place.

## Group 1's two blocking migration bugs are now FIXED (2026-09-05, third pass)

The previous handoff opened with "fix these before Group 5." Done. Group 5 is now
unblocked. Details in `supervisor/db/FINDINGS.md`; the short version:

1. **Concurrent-startup `SQLITE_BUSY`** — `busy_timeout` now goes first, but that alone
   was *not* the fix. SQLite needs exclusive access to convert a db to WAL and does not
   invoke the busy handler for that conversion, so no timeout can absorb it;
   `journal_mode = WAL` is now retried in `setWalMode()` (`db/index.js`), treating "some
   other process already made it WAL" as success. Reverting only the pragma *ordering*
   made no test fail — worth knowing, because the review's stated mechanism was
   incomplete even though the bug was real. Another instance of "verify the mechanism,
   not just the conclusion."
2. **Unserialized migrations** — each migration now runs in a `BEGIN IMMEDIATE`
   transaction that takes the write lock *before* re-reading `schema_version`
   (`db/migrate.js`), so the loser skips instead of re-running the DDL.

Two new tests, both wired into `npm run test:db`, both verified to fail against the
pre-fix code: `db/test/wal-conversion.test.js` (deterministic, 3/3 pre-fix failures) and
`db/test/concurrent-startup.test.js` (8 processes racing a fresh state dir, 6/6 pre-fix
failures). The latter alternates barrier-synchronized and staggered child arrival on
purpose — measured: barrier rounds catch the migration race but hide the WAL one, and
staggered rounds do the reverse. Don't "simplify" that away.

## Group 5 is done (2026-09-06, fourth pass)

Built in `supervisor/runtime/`: `procinfo.js`, `spawn.js`, `event-pump.js`,
`reconcile.js`, `supervisor.js`. `ipc/daemon.js` is now the real daemon — it opens the
real database, registers both real adapters, boots (routing rehydrated, then
reconciliation), serves `supervisor.commandHandlers()`, and tears down bounded on either
signal. Smoke-verified end to end: boots, answers `ping`/`list`, exits clean on SIGTERM
with no surviving children.

**Read `supervisor/runtime/FINDINGS.md` before touching any of it.** The three things
worth knowing up front:

1. **PLAN.md's "Known gap, explicitly not yet closed" is closed.** Both adapters spawn
   detached and ownership is *verified* — `spawnManaged` reads the child's pgid back from
   the OS and kills a child it could not own rather than recording an unverified identity.
2. **`orphaned-unmanaged` is no longer a dead end.** Real `reap` (verify pid + pgid +
   lstart, then kill the group) plus `harnessOf` as a *cache over `runs.harness_id`*, so a
   run created before a restart is routable. Two refusals to kill are contract, not
   caveat: pid reuse, and a group shared with another open run (pooled `opencode serve`).
3. **The event pump replaced client-driven consumption**, which had three real defects:
   nothing persisted unless a client watched; two clients meant double-persist *and* a
   split stream; a disconnecting client took the only consumer with it.

Both deferred Group 3 review items are folded in and closed: per-connection
`AbortController` cancels a peer's `observe` iterator on disconnect, and duplicate
in-flight correlation IDs are rejected rather than silently overwriting a waiter.

**How Group 5's tests were verified.** There is no "pre-fix" version of new code, so the
standing "verified to FAIL" rule was satisfied by **mutation testing**: 15 mutations total
(7 integration, 4 pump, 4 reconcile), each breaking one mechanism, each confirmed to fail
*at the assertion that claims to protect it*. The table is in `runtime/FINDINGS.md`. Two
methodology notes from doing it: `timeout(1)` does not exist on macOS (use
`perl -e 'alarm shift; exec @ARGV'`) and a hung top-level `await` shows up as Node exit 13
with no PASS line. Also — one mutation was initially "caught" for the wrong reason (a
ReferenceError, not the behavior), so it was re-done behaviorally. A mutation that crashes
the module proves nothing.

## Group 5's review is done (round three, 2026-09-06, fifth pass)

`luna` and `terra` reviewed `supervisor/runtime/` independently (9 findings each), Claude
Sonnet consolidated them into 15 unique findings (deduping, correcting mechanisms, adding 2
neither reviewer found), and every mechanism was then re-verified here against the source
before anything was changed. **`review-three/group5-verdicts.md` is the file to read** — it
records what was fixed, what was rejected, and why, and it overrides the consolidation where
they disagree.

Result: **13 fixed, 3 rejected, 1 deferred, 1 fixed only partially and labelled as such.**
The six that mattered most:

1. **A failed spawn crashed the whole daemon** — no `'error'` listener on the child. Any typo
   in a command string, or a bad cwd, took the supervisor down. Reproduced before fixing.
2. **`reap` wrote terminal rows for outcomes it hadn't achieved** — a group that survived the
   kill still got `exit_reason = "reaped"`, and a shared-group reap closed the row even when
   `adapterStop` threw. Both produce a live process with no open row and no handle: nothing
   would ever reap it again, and the shared-group case makes a later reap of the *sibling*
   kill the group and take the still-live session with it.
3. **`resume()` never re-attached the pump** — `attach()` is a no-op once `state.consumer` is
   set, so a resumed process's events were consumed by nobody: `event_log` stopped growing and
   `observe` reported a live run as finished. Now resets pump state and bumps
   `runs.generation`.
4. **The identity-capture timeout abandoned the child** instead of killing it, manufacturing
   the exact orphan `spawn.js` exists to prevent (no pid recorded → classified `lost` without
   asking the OS → `reap` short-circuits on the NULL pid).
5. **`endRun` had no `WHERE ended_at IS NULL`** while `reconcileRun` did, so two concurrent
   terminal writers clobbered each other's `exit_reason`. Fixing it immediately exposed a real
   ordering question the unguarded UPDATE had been hiding — see below.
6. **A subscriber parked mid-fan-out could silently skip evicted events**, breaking the pump's
   documented "eviction is never silent" guarantee. The outer-loop gap check cannot catch it.

**The one thing to understand before touching terminal writes:** `endRun` is now
first-writer-wins, and a *deliberate* cause has to outrank a *derived* one. When the
supervisor kills a run, the adapter stream ends because of the kill, so the pump derives
`error` → `"errored"` and races reap's truthful `"reaped"`. `supervisor.js` therefore holds a
`terminalIntent` for the duration of a deliberate `stop`/`reap`, and the pump's `onEnd` hook
prefers it. The map save/restores rather than set/deletes because the two nest (`reap` holds
`"reaped"` while ending one session of a shared group with an inner `"stopped"`). Don't
"simplify" that to a `set`/`delete` pair.

Two findings are worth carrying forward as review-quality lessons, both in the verdicts file:

- luna's "incomplete identity is reapable" was **rejected by the consolidator as unreachable
  in code — and both were wrong**. Schema v1 (`0001_initial.sql`) has `pid` and
  `process_group` and no `proc_lstart` column at all, so every pre-0002 row has exactly that
  shape. `reap` now has a third refusal for it. Found by reading the migrations, not the
  reviews.
- terra's mechanism for the shutdown race ("waits up to 2 seconds") was **arithmetically
  wrong** (`Math.min(2000, timeoutMs)` clamps to the caller's budget); the defect was real for
  a different reason. Acting on the stated mechanism would have changed nothing.

Verification, per the standing rule: `runtime/test/review-three.test.js` has 13 cases and
**every fix was reverted individually and the protecting case observed failing**, with the
mechanism the finding describes (table in the verdicts file). One revert was discarded as
invalid first — case 3 reused a shared-pgid fixture, so the wrong refusal answered and the
case "failed" for the wrong reason. Same trap as Group 5's ReferenceError mutation.

## Group 6 is done, and Phase 1 with it (2026-09-06, sixth pass)

Three suites in `supervisor/runtime/test/`, `npm run test:crash`, all wired into `npm test`:

1. **`crash-recovery.test.js`** — `_crash-victim.js` runs a real supervisor in its **own OS
   process** with real detached children and a continuous write load, and is killed with
   **SIGKILL**: no `finally`, no `closeDb()`, no adapter disposal, no lock release, an
   un-checkpointed WAL left on disk. Then: `integrity_check` ok, no unparseable
   `payload_json`, nothing committed lost, every run row obeying its terminal-state
   invariants — and all three reconciliation outcomes distinguished on data written by a
   process that no longer exists (`orphaned-unmanaged` for the children that survived, `lost`
   for the one whose process died with the crash, `finished` neither written nor overwritten).
   Open asks closed, orphans then actually reaped, second reconciliation a no-op.
2. **`concurrency.test.js`** — everything over the real socket, because that is where
   concurrency actually arrives: eight concurrent starts (eight distinct *verified* process
   groups), concurrent load with exact per-run event accounting plus an anti-crosstalk check,
   three concurrent observers on a run being written to, `stop` racing `reap`, two concurrent
   reaps, bounded teardown with nothing surviving.
3. **`daemon-crash.test.js`** — the **real `ipc/daemon.js`**, not a supervisor composed in a
   test: it crashes and restarts, so the stale lock (held by a dead pid) is taken over, the
   stale socket file is rebound, a third daemon started against the live one is refused and
   leaves it serving, and SIGTERM releases the lock with no harness process left behind.

**The one defect Group 6 found, and it is worth knowing about before you touch any kill
path:** a process group whose members have all exited but not yet been waited for contains only
**zombies**, and on macOS `kill(-pgid, 0)` on such a group *succeeds* while
`kill(-pgid, SIGTERM)` returns **EPERM**. So `killProcessGroup` reported a definitively dead
group as `killed: false` — and round three had just made `reap` gate its terminal write on
exactly that flag, so reap logged "process group SURVIVED the kill" and left the run row open
forever for a process that no longer existed. Fixed with `procinfo.isProcessGroupLive()`
(zombie-aware, portable `ps -A` + pgid filter — BSD `ps -g` selects by process group, procps
`-g` selects by *group name*, so `-g` silently asks a different question on Linux), consulted at
all three decision points in the kill path. `isProcessGroupAlive()` is unchanged and now says
in its docstring that it counts zombies.

That defect was found by the concurrent-double-reap case *by luck* — the zombie window is a few
milliseconds — which the mutation run proved by passing. So there is now a **deterministic**
case for it (a `perl` parent never waits for its child, so the zombie persists). Same lesson as
Group 5's ReferenceError mutation and round three's shared-pgid fixture: a test that only
sometimes exercises its mechanism has not proven it.

**Mutation evidence, and two tests it corrected.** 12 mutations of the runtime, each observed
failing at the case that claims to protect it (full table in `runtime/FINDINGS.md` section 12).
Two of them fixed the *tests*: one assertion checked an already-connected socket client, which
can never catch the socket file being unlinked (an established Unix-socket connection survives
that), and one expected `finished` to be protected by `listOpenRuns` when the guard that
actually protects it is `reconcileRun`'s `AND ended_at IS NULL`. A third was corrected against
the design: two concurrent reaps need not be the writer that closes the row — the pump's
`onEnd` hook can land first, carrying the deliberate `reaped` intent. The invariant is "closed
once, with the deliberate reason", not "closed by reap".

## Group 6's two findings are decided and shipped (migration 0003, 2026-09-06, seventh pass)

Group 6 surfaced two questions rather than bugs. Both went to three independent models
(`sol`, `luna`, `terra` via Bedrock — note `sol` **does** work; the `@ai-sdk/amazon-bedrock`
`reasoningContent.redactedContent` crash only fires when Bedrock actually returns a
redacted-thinking block, so the old "sol is broken" note was too strong). **All three
independently chose the same shape for the first finding**, and that is what shipped.

**Read `supervisor/runtime/FINDINGS.md` section 13 for the full record.** The short version:

1. **`orphaned-unmanaged` is now a lifecycle STATE, not a terminal outcome.** It goes in
   `runs.lifecycle` and the row keeps `ended_at IS NULL`, because the process has not ended.
   Before this, reconciliation closed the row of a process it had *just verified to be running* —
   and since its own input set is `WHERE ended_at IS NULL`, that live unmanaged process was
   classified once and then invisible to every later boot, still burning CPU and tokens. Now it is
   re-examined every boot, and gets a real terminal write when something real happens: `lost`
   when its process dies, `reaped` + `runs.reaped_at` when we kill it.
2. **A side-effect nobody had noticed, fixed by the same change:** a closed orphan row dropped out
   of `listOpenRunsSharingProcessGroup`, so reaping a *sibling* run on a pooled `opencode serve`
   pgid would group-kill the orphan's still-live session, silently. An unreaped orphan now keeps
   protecting its own process group. `reconcile.test.js` case 6 asserts this directly.
3. **`orphan_sightings`** — an append-only journal (`kind: new | repeat`), one row each time
   reconciliation sees a live unmanaged process. **A log, never state**: `runs.lifecycle` is the
   state and nothing reads the journal back as truth. It exists so "we keep getting orphans
   lately" is a query with history behind it, and so a future watcher process has something to
   reason about.
4. **The shortcut list** — `supervisor.orphans()` and an `orphans` wire command: every live orphan
   by title, cwd, pid, pgid, first/last seen, sighting count. That query was impossible before.
5. **Unanswered asks on a naturally completed run get a five-minute grace.** `asks.auto_close_at`,
   **persisted** rather than an in-memory timer, swept on `boot()` and on a 30s interval — a
   supervisor SIGKILLed mid-grace must not strand the ask, which is the very failure being fixed.
   A human answer during the grace wins; the sweep closes as `supervisor:auto-close`, which is
   distinguishable from a human answer.
6. **Deliberate `stop`/`reap` and reconciliation still close asks immediately** — a human is
   already acting, or nothing is left that could answer. Note `stop` never closed asks *at all*
   before; it was the one terminal path that touched `runs` and ignored `asks`.

**The subtlety to understand before touching any of this:** the grace-vs-immediate decision is
keyed on the *terminal reason*, never on which function wrote the row. Killing a run ends its
adapter stream, so the terminal write frequently comes from the pump's `onEnd` hook carrying the
deliberate intent (Group 6, concurrency case 5) — "who wrote it" answers nothing. The first
version of this fix scheduled a grace for every reason, so a reaped run's ask sat open for five
minutes; `asks` case 5 exists because of that.

**PLAN.md section 4 changed**, in three places, all deliberately: the definition of "not already
terminal" (now explicitly `ended_at IS NULL`, which includes orphan rows), the
`orphaned-unmanaged` bullet, and the asks sentence (which now spells out the per-reason policy).
Section 3's schema block gained `runs.lifecycle`, `runs.reaped_at` and `orphan_sightings`.

**Mutation evidence: 9 more (M13-M21), table in FINDINGS §13.** M21 is the one to remember — it
**passed** at first, because in the crash suite every open row happens to be an orphan, so nothing
there could tell "filter by lifecycle" from "every open run". The assertion that kills it had to
move to where healthy managed runs exist (concurrency case 1, eight of them). Third time this
project has hit that trap; the pattern is now explicit in FINDINGS.

## Deferred by decision, not by omission

- **Obsidian vault projection: after the Phase 2 vertical slice** (PLAN.md section 18, ROADMAP
  Phase 10 — both now say so). The basic tier is what gives a picture outside the terminal:
  per team/task/worker notes whose wikilinks make Obsidian's graph view a live team topology
  diagram, a `Dashboard.md` "what is going on right now" file, the live-orphan list beside it,
  **off by default** so nothing writes to the vault unless it is switched on. Sequenced after the
  slice so the projector is not rewritten while the workflow is still changing shape; a web view
  later is a second projection of the same truth, not a second system.
- **A watcher process for "doubted" orphans** — reads `orphan_sightings`, spots repeat offenders,
  proposes what to do. Explicitly a side story; the journal it would read is already being written.

## Immediate next steps, in order

0. **Both Phase 6 and Phase 7's gate have been reviewed** (`review-phase6/verdicts.md`,
   `review-phase7/verdicts.md`). Between them sol found the same failure shape seven times and not one logic
   error in a rule: **a correct mechanism whose seam was never exercised.** The five rules that came out of it are
   in `runtime/FINDINGS.md` §37.10 and §38.7 — read those before writing the rest of Phase 7's roster, because
   utility agents are all seam.
1. ~~**Get Phase 6 reviewed.**~~ **DONE 2026-09-09** — `opencode --agent sol --variant medium`: 6 blocking,
   4 should-fix, 2 refuted, all accepted, ten fixed, each blocking one reproduced first
   (`review-phase6/verdicts.md`). Read §37.10's four rules before Phase 7's authorization work — three of the
   six blocking findings were mechanisms that had been built, documented and never consulted, and an auth
   system has exactly that shape.
1. **(superseded, kept for the reasoning) Get each phase reviewed.** Every phase that got an independent review found real defects in it, including
   one lethal one in the adoption safety path (§30). Phase 6 decides whether code merges reviewed, so it is
   the worst place to skip that step. The 15 review mutations are the floor, not the ceiling — hand
   `domain/review.js`, `config/review-profiles.js`, `migration 0009` and the supervisor's review surface to
   two models on two harnesses (which is what §13's own `modelDiversity` rule is about).
2. **Phase 7 — the roster.** The gate is DONE and reviewed, so this is unblocked: jira-automation,
   git-create-push and slack-message agents, each a narrow principal whose FIXED toolset already exists as a
   preset in `domain/capabilities.js` and is already enforced. Then `git-create-push`'s full fight loop (§8,
   Rule 2) — real `git` access, stage/commit/hook-failure/classify/autofix/re-run, returning a short structured
   result and never raw tool output to the caller. The per-agent operation journal they need is already written
   for them: `agent_journal` records every allow and refusal, and `journalHasDone()` answers "did I already file
   this ticket".
   **Start by reading §37.10 and §38.7's five rules.** A utility agent is almost entirely seam, and seams are
   where both reviews found everything.
   **One known gap to close in the same stretch:** nothing drives the INSTALLED session hook through the
   authorized socket (mutation **A21** is marked `expectSurvives` for that reason). The hook's fix is in
   production; the regression net is missing.
3. **Unify the state directory before anything ships.** `lock/lock.js` reads `CTD_STATE_DIR`
   (`~/.local/state/custom-team-dashboard/`) while `db/paths.js` and `ipc/paths.js` read
   `SUPERVISOR_STATE_DIR` (`~/.custom-team-dashboard/supervisor/`). Both work, and `daemon-crash.test.js` has
   to set both, which is the tell. Small, mechanical, and it has now survived five phases.
4. **Find out what overwrote this tree on 2026-09-08 at 17:13:40**, or it will happen again. 202 files were
   replaced by an older copy — including `.obsidian/*.json`, which suggests something that treats this
   directory as a unit (a vault sync, or an editor writing a bundle) rather than a code tool. Ruled out: the
   mutation runner, the test suites, git (this tree is untracked), and OpenCode's snapshot repos. Until it is
   identified, `~/ctd-snapshot-*.tar.gz` is the fallback and the suite COUNT is the canary.
5. **Consider `git init` here.** The tree is untracked inside a `workspace` repo that ignores it, so there is
   no way to see what a restore changed, and no way to get it back. That is the durable fix for item 4 rather
   than a workaround for it.

## Open should-fix items, by directory (nothing here is silently dropped)

**`supervisor/db/`** — `event_log`/`outbox` redaction gap; missing `requests` writer;
`openDb()` error-path handle leak; no affected-row-count checks on writes. (The
unvalidated `busyTimeoutMs` PRAGMA interpolation was fixed alongside the WAL work.)

**`supervisor/lock/`** — temp-file leak if `fs.writeFile` fails mid-write; orphaned
lock if `fs.link()` succeeds but temp cleanup then fails.

**`supervisor/ipc/`** — ~~duplicate correlation IDs are accepted~~ **fixed in Group 5**
(server-side: a second command reusing an in-flight id on the same connection is refused
with an explanatory error; note the *client's* `pending` map is still last-writer-wins, so
the server's refusal is what protects you); ~~`observe` iterator not cancelled on peer
close~~ **fixed in Group 5** (per-connection `AbortController`); unsolicited frames (overflow/shutdown notices)
use `id: null`, inconsistent with the "every frame echoes its request id" claim;
`SO_PEERCRED`/`getpeereid` uid check on accept is still unimplemented (Node has no
built-in API — needs a small native addon or a documented deferral).

**`supervisor/runtime/`** — (both Group 6 findings that used to be listed here are **closed** as
of migration 0003 — see `runtime/FINDINGS.md` section 13.) Still open: pump state for
completed runs is never released (deferred on
purpose: that state is what `status()`/`list()` read for `derived`, so dropping it on
completion makes a just-finished run report `derived: null`; correct fix is bounded retention
once replay from `event_log` exists, which is Group 6); full adapter-iterator cancellation
needs an `AbortSignal` on both adapters' `observe()` — `iterator.return()` is invoked now, but
`return()` on an async generator suspended inside an `await` is queued until it resumes, so a
generator blocked on a socket read cannot be cancelled at all. Also: the state directory is
not one directory: `lock/lock.js` reads `CTD_STATE_DIR` and defaults its lock to
`~/.local/state/custom-team-dashboard/supervisor.lock`, while `db/paths.js` and `ipc/paths.js`
read `SUPERVISOR_STATE_DIR` and put the socket and database under
`~/.custom-team-dashboard/supervisor/`. Both work; they just disagree about where "state" lives
— `runtime/test/daemon-crash.test.js` has to set BOTH env vars to keep a test out of the
developer's real state dir, which is the tell. Left alone deliberately in Group 5
(`lock/lock.js` owns lock semantics and Group 5 doesn't reimplement or relocate them), but
it should be one root before anything ships.

**`supervisor/adapters/`** — OpenCode abort can emit two terminal events
(`session.error` then `session.idle`, both mapped to `turn.end`); a Claude Code
process exiting with no `result` object produces no `turn.end` at all; the stderr ring
is bounded by line *count* not bytes, so one huge line is unbounded;
`server.instance.disposed` maps to `null`, so a disposed server produces no terminal
event and can hang `observe()`; `verifyRunIdentity()`'s HTTP-unavailable fallback can
false-positive `sessionKnown:true`; `clearContext`/`resume` have compatible signatures
but **incompatible semantics** between harnesses (the older "confirmed consistent"
claim was about signatures only).

## One behavior change to be aware of (`supervisor/ipc/`)

`MAX_LINE_BYTES` (256 KiB) is now a cap on **every** wire command, not just on
unterminated ones. Previously a command of any size was accepted as long as it ended
in a newline — that was the blocking bug. Consequence: a single command carrying a
payload over 256 KiB (a very large `sendInput` prompt, or a big `echo`) is now refused
and its connection closed. If a real caller legitimately needs more, raise
`maxLineBytes` deliberately at the `createIpcServer` call site — do not weaken the cap
itself. Nothing in the current code sends anything near 256 KiB, so this is a
forward-looking note, not a present problem.

## PUSHING THIS REPO — read before running any git command

**Nothing in this repo has ever been committed.** It is untracked inside `workspace`, which is itself a git repo
that ignores it. Every safety net so far is a tarball outside the tree (`~/ctd-snapshot-*.tar.gz`).

**The plan, agreed with the owner 2026-09-09:** this becomes a **private repo on the personal account
`manish96170`**. It has NOT been created or pushed yet.

**Do not commit or push without asking the owner first.** Three reasons, all real:

1. **An account switch is required.** `anchor-mani` is the active `gh` account and owns the product repo
   (`a work-account product repo`); `manish96170` is the personal account. Git over HTTPS authenticates as
   whichever account is ACTIVE, so a push under `anchor-mani` would land in the wrong place with the wrong
   identity. Sequence: `gh auth switch --user manish96170`, create the repo **private**, push, then
   `gh auth switch --user anchor-mani` to restore the default, because all product-repo work expects it.
2. **Another session is watching git continuously** for this purpose. An unannounced commit here will be seen by
   it, and coordination beats surprising it.
3. **A first commit is a decision about what ships.** Decide before it, not after: `supervisor/node_modules`
   must be ignored; `.DS_Store` files exist in this tree and should be; nothing in `probe/evidence/` or the
   review folders contains a credential (worth one grep before the first commit rather than a rewrite after);
   and `owner.token` / `state.sqlite3` live in the STATE dir, not the repo, so they are not at risk — confirm
   that is still true if the state dir ever moves.

**Once it is a git repo, the 2026-09-08 overwrite becomes a one-command recovery instead of a rebuild.** That is
the actual argument for doing it.

## Known environment issues (don't rediscover these)

- **This tree was overwritten by an older copy on 2026-09-08 at 17:13:40** — 202 files, `.obsidian/*.json`
  included. Cause unidentified; ruled out the mutation runner, the suites, git (untracked) and OpenCode's
  snapshot repos. Symptom to watch: the `npm test` suite COUNT dropping for no reason you know. Fallback:
  `~/ctd-snapshot-*.tar.gz`, kept outside the tree.

- **`opencode run` needs `--auto`** when run non-interactively with no TTY, or
  permission prompts hang forever with zero output and zero indication why.
- **Keep `opencode run` prompts SHORT, single-line, and ASCII.** A long multi-line
  prompt piped in via `nohup ... "$(cat file)"` produced banner-only output and
  exit 0 — looks like success, contains nothing. The same question as one compact
  single-line prompt in the foreground worked immediately. Also never tell the model
  to "read PLAN.md in full" for context (1140+ lines) — inline the 2-3 relevant
  sentences instead. Both of these have now bitten multiple times.
- **Model agent aliases live in `~/.config/opencode/opencode.json`.** Verified
  working: `luna` (`openai.gpt-5.6-luna`) and `terra` (`openai.gpt-5.6-terra`), both
  via `opencode run --agent <name> --variant medium --auto`. `sol`
  (`global.openai.gpt-5.6-sol`) **works, but is fragile** — corrected 2026-09-06 after using it
  successfully: the installed `@ai-sdk/amazon-bedrock` has no case for Bedrock's
  `reasoningContent.redactedContent` block shape, so a call crashes **only when that response
  actually contains a redacted-extended-thinking block**, not every time. The earlier "sol is
  broken, don't use it" note was too strong. Not fixable via CLI flags when it does hit. The "no payment method" error
  people hit on `opencode/gpt-5.6-sol` is a different, unrelated red herring (that's
  the OpenCode Zen catalog model, not the Bedrock one).
- **Backgrounded `opencode run` calls can silently stall if the laptop sleeps** — CPU
  time flatlines but the process isn't dead. Check `ps -o pid,etime,time` and compare
  CPU-time deltas across two checks a few minutes apart before concluding it's stuck.
- **The `Agent`/subagent tool may be unavailable in this repo's sessions.** It failed
  with `teammateMode is set to "iterm2" but the it2 CLI is not reachable` (fix would be
  `pip install it2` + enable iTerm2's Python API, or change `teammateMode`). Even when
  it does work, subagents have twice proven unreliable for long-running backgrounded
  shell commands — they start one, stop watching, and report "completed" with no
  result. **Prefer `Bash` with `run_in_background: true` directly.**
- **Subagents are blocked by tool policy from writing files named `FINDINGS.md`** or
  other report-shaped filenames. They'll return the content in their final report; the
  orchestrator has to materialize the file.

## Sibling repos worth knowing about

- **`../team-slack-bridge/`** — the Slack integration this project's §14 and §16 depend on. It now has its own
  build plan (`PLAN.md`, 2026-09-09, 682 lines): one core, four surfaces (direct CLI / MCP server / Claude Code
  skill / this dashboard's `slack-message` agent), and a **remote profile locked down by construction** — no user
  tokens, no DM paths, no listener, no `chat:write.customize`. As-user posting and DM-reading are therefore
  LOCAL-ONLY, permanently, which is consistent with our sensitive class gating them. Nothing there has been
  committed either.
- **`../slack-bots/yadavbot/`** — a Slack-provided Bolt sample ("Casey"). It is the working reference for Socket
  Mode, the event-subscription set, and a complete app manifest. The bridge's plan §3 says exactly what to lift
  and what to leave.

## Doc map

- `PLAN.md` — full design, 19 sections. Section 12 ("Model health, fallback &
  preferences") documents the model-reliability incidents above and the design
  response (preflight checks, silent mid-session failover, denylist, per-section model
  defaults, settings UI, session-ID visibility).
- `ROADMAP.md` — phased build order; Phase 1's checklist has Group 5's requirements
  spelled out in detail, traced to specific review findings.
- `TODO.md` — the Group 1-6 breakdown with independent-vs-dependent grouping.
- `FLOWS.md` — diagrams + full keybinding table.
- `supervisor/` — the real Phase 1 code, now complete. Each subdirectory (`db/`, `lock/`,
  `ipc/`, `adapters/`, `runtime/`) has its own `FINDINGS.md` with what's built, proven, fixed, and open.
  Those are the authoritative per-group record; read the relevant one before touching
  that directory. `runtime/FINDINGS.md` sections 12-13 are Group 6: the crash/concurrency
  suites, their mutation table, and what is still open after them.
- `review-two/` — cross-model code review for Groups 1-4. `CONSOLIDATED-SUMMARY.md`
  first; drill into `group*-*.md` only for a specific finding's repro.
- `review-three/` — cross-model code review for Group 5. **`group5-verdicts.md` first** (what
  was fixed, rejected, deferred, and why — it overrides the consolidation); then
  `group5-consolidated.md`, then the raw `group5-runtime-{luna,terra}.md`.
- `spike-0b/` — throwaway Phase 0b proof-of-concept. Don't build on it;
  `supervisor/` is the real implementation.
- `arch-reviews-now-not-needed/` — archived architecture reviews, already incorporated.
- `team-slack-bridge/` — separate standalone sibling repo, not part of this codebase.

## Review-quality note worth carrying forward

Two review claims from round two turned out to be **wrong about their reasoning while
right about the bug**, and one reviewer rationale was simply false:

- luna claimed the Group 4 SSE race was hidden because the fake test server "replays
  historical events to late subscribers." It does not — `fake-opencode-server.mjs`
  pushes to an `eventQueue` that is **never read anywhere**. Independently confirmed by
  a second model (`terra`) tracing every read of that array. What actually hid the bug
  was localhost subscription latency being too small to lose the race. The bug itself
  was real and is fixed.
- Every group's own `FINDINGS.md` overclaimed something, consistently: "fully proven"
  usually meant "the test I wrote passes," not "I checked every path." This recurred
  at the real-build stage after also happening in spike-0b, so treat it as a durable
  pattern — see PLAN.md section 12's `claims-vs-evidence` review dimension.

Practical upshot: **verify a reviewer's mechanism, not just its conclusion**, and make
every regression test fail against the pre-fix code before believing it.

## What NOT to do

- Don't re-run Groups 1-6's builds from scratch — they're done, tested, and reviewed.
- Don't "simplify" `runs.lifecycle` back into `exit_reason`. They answer different questions —
  "how did this run end" versus "was its process ever observed running unmanaged" — and collapsing
  them is exactly the bug migration 0003 fixed: a closed row is invisible to reconciliation's own
  input set. A row reconciled straight to `lost` keeps `lifecycle: 'managed'`, and that is correct.
- Don't turn `orphan_sightings` into a state table. It is append-only history; the moment
  something reads it back as truth there are two sources of truth for one process.
- Don't replace `asks.auto_close_at` with an in-memory timer. The whole point is that a supervisor
  killed mid-grace still honours the deadline on its next boot.
- Don't "simplify" `killProcessGroup` back to signal-only checks. The `ps`-based
  zombie check looks redundant next to `kill(-pgid, 0)` and is not: a zombie-only group
  answers the cheap check with "alive" and the actual SIGTERM with EPERM, and `reap` gates a
  terminal database write on the difference (`runtime/FINDINGS.md` section 12).
- Don't replace `runtime/test/_crash-victim.js` with an in-process simulation. Catching a
  signal is exactly what a crash does not do; `integration.test.js` case 8 already covers the
  cooperative "handles are gone" shape, and it cannot cover a WAL that was never checkpointed.
- Don't re-open the round-three findings that were rejected. The reasons are written down in
  `review-three/group5-verdicts.md`, including two cases where a reviewer was right about the
  bug and wrong about the mechanism, and one where the "fix" was impossible as written.
- Don't "simplify" the runtime tests by replacing real spawned processes with mocks. The
  entire point of Group 5 is OS process ownership; `ipc/mock-adapter.js` and
  `ipc/persistence-stub.js` remain only as `createIpcServer` defaults for `ipc/test/`,
  and are annotated as such.
- Don't re-litigate architecture already settled in PLAN.md (single-writer supervisor,
  SQLite not JSON, event-transcript pane rendering, capability-based auth) — these
  went through multiple independent-model reviews.
- Don't assume a long-running background `opencode` call is stuck without checking
  CPU-time deltas first.
