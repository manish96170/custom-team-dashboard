# TODO — sequenced, with independent-task groups for parallel agents

Source of truth for phase content/detail is `ROADMAP.md` — this file is the
scannable, agent-dispatchable view of the same work. A "Group" is a set of tasks with
no dependency on each other — hand each group to a different agent/session in
parallel. Tasks *within* a group that aren't independent of each other are marked
"(same session as ...)" — don't split those across agents.

## Done

- [x] Phase 0a — Contracts written into PLAN.md (identity split, capability matrix
      shape, task/team cardinality, one-CTO topology, SQLite decision, repo/worktree
      identity). No code — see PLAN.md.
- [x] Phase 0b — Runtime + packaging spike. All six gate items proven with real code
      (`spike-0b/*/`): Claude Code adapter, OpenCode adapter, mock harness, packaging
      probe, real concurrent sessions through a real supervisor, restart recovery
      (discovered the `orphaned-unmanaged` third state). Gate cleared 2026-09-05.
- [x] Spike-0b code review — 3 independent models + 1 consolidator
      (`consolidated-review-claudeopus5-medium--spike-0b.md`). 3 false claims in the
      spike's own evidence corrected in place. 13 design requirements folded into
      Phase 1 below. 2 new review dimensions (`cross-file-consistency`,
      `claims-vs-evidence`) added to PLAN.md section 12.

## Current state — 2026-09-13 (see `HANDOFF.md`'s own top header for the full, current-session detail;
this section is a periodically-refreshed snapshot, not updated every pass)

**Phases 0a-6 COMPLETE and reviewed. Phase 7 (authorization gate, resource leases, MCP pooling, the
utility-task lane, `git-create-push`'s full fight loop) has its LIFECYCLE/FRAMEWORK COMPLETE, AND
worker-side MCP tool transport is now real too (`spec.mcpConfig` is genuinely built and delivered for
any harness that declares `mcpConfigDelivery`, via `runtime/mcp-stdio-proxy.js`, with the delivered
tool surface bounded per role — review-sol-2026-09-13.md finding 13, fixed 2026-09-14, then hardened
and bounded further by review-consolidated-2026-09-14.md findings 1-2, 5-7, 12; see `HANDOFF.md`'s top
header for the full mechanism and what's still honestly unverified)**, independently
reviewed multiple times (two codex passes, two `opencode luna` passes — see `HANDOFF.md` items
16/18/22/24/25 for the ~20 real findings those found and fixed), and the OLDER should-fix backlog
predating those reviews is now fully closed or explicitly, correctly deferred (`HANDOFF.md` items
27-38). Phase 8 (CTO) has its first schema-only step started (`clearPolicy` on
`harness-defaults.json` roles, item 39) — the actual decision logic is not built yet.
`cd supervisor && npm test` runs **127 suites, exit 0**, re-verified repeatedly, zero leaked
processes. The specific "113 suites" figure and mutation count below are a HISTORICAL snapshot from
2026-09-09 (Phase 1/early Phase 7), kept for what they document, not as the current count.

**Watch the suite COUNT, not just the exit code.** On 2026-09-08 it dropped from 109 to 104 because 202 files in
this tree were overwritten by an older copy at 17:13:40 (cause never identified — not this session's edits, not
the mutation runner, not git, not OpenCode's snapshots). Four code edits and two days of docs were lost and had
to be rebuilt from `supervisor/runtime/FINDINGS.md`, which survived. Snapshots now live OUTSIDE the tree at
`~/ctd-snapshot-*.tar.gz`. If the count moves for a reason you do not know, look for a restore before a bug.

What exists, end to end: a single-writer SQLite supervisor daemon (migrations 0001-0009) with process-group
ownership and honest three-state reconciliation; two real adapters plus a degraded `wrapper` tier; a runnable
TUI (`node supervisor/tui/cli.js --demo`); all three of PLAN.md Rule 4's summary tiers; the §6 task state
machine ENFORCED; harness/model assignment with idempotency and partial-start compensation; and §13's
configurable reviews with revision-bound per-dimension verdicts, finding verification and a review bar.

Detail for every decision is in `supervisor/runtime/FINDINGS.md` (§1-§37) — read that before changing any of
the mechanisms it describes. `ROADMAP.md` has the per-phase checklists.

### Phase 7 — where it stands (refreshed 2026-09-13 — see `HANDOFF.md`/`ROADMAP.md` for full detail)

- [x] **The authorization gate** (2026-09-09, REVIEWED) — capability-based authorization with a real
      `callerIdentity`, enforced at the socket by `ipc/daemon.js`. Migration 0010, `domain/capabilities.js`,
      `supervisor.authorizedCommandHandlers()`. 22 mutations. `runtime/FINDINGS.md` §38 + §38.7,
      `review-phase7/verdicts.md`.
- [x] **`git-create-push`'s full fight loop** (PLAN.md §8, Rule 2) — real `git` access:
      stage/commit/hook-failure/classify/autofix/re-run, `gitPush`/`gitPushProtected` wire commands, `git:identity`
      lease held across the whole loop. Built item 11; hardened repeatedly since (retry-after-partial-push-failure,
      server-side protected-destination classification, async/non-blocking git calls — `HANDOFF.md` items 21/32).
- [x] **The roster, decided differently than originally planned**: `leo-mcp` (`../leo-mcp/`, private sibling
      repo, item 12) is a real, working, independently-tested MCP server providing Jira/Slack tool access —
      instead of bespoke jira-automation/slack-message agents in THIS repo, since the skills were already
      mature/conversational and `team-slack-bridge` had already grown a full MCP tool surface. **THAT DECISION
      is done, and wiring a dashboard worker session to actually REACH `leo-mcp` is now done too**
      (review-sol-2026-09-13.md finding 13, fixed 2026-09-14 — `spec.mcpConfig` is genuinely built and
      delivered via `runtime/mcp-stdio-proxy.js`, a plain stdio bridge to leo-mcp's real Unix-socket transport,
      since no MCP client contract measured here supports a raw socket directly). The delivered surface is
      also BOUNDED per role, not the pool's entire tool catalog (review-consolidated-2026-09-14.md finding 1:
      `domain/mcp-manifest.js`'s `ROLE_MCP_TOOL_ALLOWLIST`, enforced by the proxy itself). This dashboard's own
      utility-task lane (`git-push-task`/`jira-task`/`awsquery-task`/`slack-task`, item 13) provides the
      role/capability/model machinery + a one-call dispatch helper (`createUtilityTask`, item 26) + real
      per-role run instructions (item 26) on top of it, and `git-push-task`/`jira-task`/`slack-task` all now
      have a real, DELIVERED, bounded tool; `awsquery-task` still has none (it never declares a leo-mcp need —
      its own AWS access is a separately-configured MCP server, not this project's pooled config).
- [~] **Operation-intent journals per utility agent — PRIMITIVE built, not wired into any caller.**
      **CORRECTED 2026-09-13 (review-sol-2026-09-13.md finding 38) — this line previously read `[x]`,
      contradicting `ROADMAP.md`'s own (correct) `[ ]` for the same item.** `agent_journal` +
      `journalHasDone()` exist as a query primitive from the authorization gate, but NO side-effecting
      caller — `git-create-push`, and Jira/Slack have no executable path at all yet — actually writes or
      checks a stable intent key before acting. An append-only journal by itself does not give a retry
      idempotency; a retried git push, Jira ticket, or Slack post can still repeat the real external
      operation. Leave this open until every side-effecting operation records intent and checks a stable
      dedup key before retrying.
- [ ] **A test that drives the INSTALLED session hook against an authorized socket.** Still open. Known gap,
      recorded rather than hidden: mutation **A21** is marked `expectSurvives` because nothing exercises the
      real hook through the gate — `wire.test.js` uses the raw command map, and the slice that runs the hook
      for real costs tokens and sits outside `npm test`. The production fix is in; the regression net is not.
- [ ] **A real sandbox is NOT the gate.** Still true, documented rather than fixed. Workers run as the same
      OS user and can read `owner.token`, so the gate buys attribution, fixed toolsets and an audit trail — not
      confinement (§38.1). If that ever matters, the fix is a separate uid per worker or OS-level confinement.
- [x] **The OLDER should-fix backlog predating Phase 7's reviews** — `HANDOFF.md` items 27-38, fully closed or
      explicitly, correctly deferred across `db/`, `lock/`, `ipc/`, `adapters/` (entirely closed), and
      `runtime/` (one genuinely real fix — adapter-iterator cancellation, reproduced empirically before fixing
      — one deliberately-deferred design tradeoff, one stale note).

Then Phase 8 (CTO — first schema-only step started, item 39: `clearPolicy` vocabulary on
`harness-defaults.json`, no decision logic yet), 9 (Slack outbound), 10 (Slack inbound, gated on §14.6's
fix), 11 (onboarding generalization), 12 (packaging).

### Parallel, in another repo: the Slack bridge

`../team-slack-bridge/PLAN.md` (written 2026-09-09, 682 lines) is a full build plan for the bridge — four
surfaces over one core, a locked-down remote profile, and a 13-step build order with a gate per step. It can be
built in its own session, independently of the phases above, and Phase 9 consumes it.

Three things from it that are OUR work, not the bridge's:
- [ ] Confirm a `requests` row carries `{channel, thread_ts}`, so an accepted review-request can be answered
      back into its originating thread (its open question 5).
- [ ] Keep `slack:post-bot` and `slack:post-as-user` as separately gated paths when the `slack-message` agent is
      built — the preset already holds only the first, and the second is in the sensitive class.
- [ ] The outbox consumer must pass an `idempotencyKey`, because it retries and the bridge de-duplicates on it.

Two things deliberately still open, both named rather than implied:
- **`node-pty` + a real terminal parser** for the `wrapper` tier (PLAN.md §9). Deferred, not dropped: needed
  only for a harness that refuses to run without a tty. Nothing needs it today.
- **A server-initiated ask notification on the wire.** The pane and the TUI poll `asks`; there is no push
  channel yet.

## Phase 1 — COMPLETE (2026-09-06). Detail kept for history; every group was independently reviewed.

### Group 1 — Persistence foundation
*(independent of Groups 2-4; nothing else needs to wait for this to *start*, but
Group 5 needs it *finished*)*
- [x] SQLite schema (WAL mode): `schema_version`, `harnesses`, `teams`, `workers`,
      `runs`, `tasks`, `asks`, `requests`, `integrations` (ship empty/versioned),
      `event_log` (tiers 1-2), `transition_journal`, `outbox`. (PLAN.md section 3)
- [x] Migrations story from row one. (same session as above)
- [x] Atomic persistence by construction — no bare full-file rewrites, no
      O(all runs) rewrite per event. (same session as above)
- [x] Redaction at the write boundary (hash + truncated preview by default, full text
      opt-in only) + state dir `0700` / files `0600`. (same session as above — same
      write path)

### Group 2 — Lock fix
*(independent of everything else; small, self-contained)*
- [x] Fix the lock write-gap found in code review: write payload to a temp file, then
      `fs.link(tmp, lockPath)` — atomic, fails `EEXIST`, no unpopulated-file window.
      (`packaging-probe/lock.js`, carried into the real Phase 1 lock code)

### Group 3 — Wire protocol + daemon resilience
*(independent of Groups 1, 2, 4 — can be built against a stubbed persistence
interface; only needs to integrate with Group 1's real schema before Group 5)*
- [x] Unix domain socket, typed commands + subscriptions — the one authoritative
      mutation path.
- [x] Correlated wire protocol: client-supplied `id` echoed on every response and
      every `observe` stream frame. (same session as above — same protocol surface)
- [x] Daemon must never die from a peer: `error` handlers on every socket and every
      adapter `child.stdin`, top-level `uncaughtException`/`unhandledRejection` net,
      guarded writes, bounded per-connection input buffer. (same session as above)
- [x] `SO_PEERCRED`/`getpeereid` uid check on socket accept — **checkbox corrected 2026-09-13: this
      does NOT mean the OS-level uid check was literally built.** Investigated and re-verified
      (`adapters/claude-code/probe/peercred-probe.mjs`, evidence 17): Node exposes no such API on a
      Unix socket at all, confirmed again on the current Node version. The gap this line was meant
      to close is closed a different, decided way instead — see `ipc/FINDINGS.md`'s entry — so the
      checkbox stays checked for what actually got decided, not for a native addon that was never
      written and is not needed.

### Group 4 — Adapter normalization
*(independent of Groups 1-3 — pure adapter-level code, touches
`spike-0b/claude-code-adapter/` and `spike-0b/opencode-adapter/`, not the supervisor)*
- [x] One normalized `turn.end` event across both harnesses — `status` required field,
      supervisor-side treats unrecognized values as `errored` (fail closed). Fixes the
      Claude-emits-`isError`/OpenCode-emits-`status` divergence found in review.
- [x] Two-level identity for OpenCode: `{ serverPid, sessionId }`, independently
      verified (server liveness + `GET /session/{id}` for session-still-known). Land
      the PLAN.md section 4 model update first (same session), then the adapter change.
- [x] Expose `clearContext`/`resume` cleanly for the supervisor to route to later
      (Group 5 wires the actual routing — this task is just making sure the adapter
      surface is ready). (same session as above two)

## Group 5: Integration — DONE (2026-09-06)

**Reviewed and hardened, 2026-09-06 (round three).** luna + terra reviewed independently,
Claude Sonnet consolidated, verdicts adjudicated in `review-three/group5-verdicts.md`:
13 defects fixed (blocking ones: a failed spawn crashed the daemon; `reap` wrote terminal rows
for kills that failed; `resume()` never re-attached the pump; the identity timeout abandoned
the child; `endRun` had no first-writer-wins guard; eviction mid-fan-out skipped events
silently), 3 rejected with reasons, 1 deferred with a design reason, 1 fixed only as far as the
language allows. New suite: `runtime/test/review-three.test.js` (13 cases), wired into
`npm run test:runtime`; every fix was reverted individually and the protecting case observed
failing.
*(was: hard dependency on Groups 1, 3, and 4; one continuous session, not parallelizable,
because these all touch the same run lifecycle. Built in `supervisor/runtime/`; mechanisms
and mutation evidence in `supervisor/runtime/FINDINGS.md`. `npm run test:runtime`.)*
- [x] Real process-group ownership: every child spawns `detached: true`, leads its own
      process group (`pgid === pid`, recorded and verified as such — not inherited
      from the supervisor, which was the bug found in review). Both adapters route
      through `runtime/spawn.js`, which *kills a child it could not own* rather than
      recording an unverified identity.
- [x] `DASHBOARD_SPAWN_DEPTH` set at spawn time, hard refusal above a small ceiling
      (ceiling 1; a malformed value fails closed *at* the ceiling).
- [x] Real `reap` command (verify pid+pgid+lstart, then kill the process group) +
      `harnessOf` routing rehydrated from persisted rows on boot. `harnessOf` is a
      cache over `runs.harness_id`, not a store, which is what makes a pre-restart run
      routable at all. Two refusals to kill: pid reuse (start-time mismatch) and a
      process group shared with another open run (pooled `opencode serve`).
- [x] One supervisor-owned event consumer per run, independent of whether a client is
      subscribed (`runtime/event-pump.js`) — status/telemetry/persistence derive from
      it; client `observe` connections fan out with per-subscriber cursors and explicit
      `gap` frames on buffer eviction.
- [x] Startup reconciliation, three-state model (`lost` / `orphaned-unmanaged` /
      `finished`) wired to the real schema and the real process-group check.
      `finished` is never written by reconciliation — only by the adapter's completion path.
- [x] Routable `clearContext`/`resume` on the supervisor's actual command surface.
      The adapter's own ack is passed back verbatim rather than flattened: the two
      harnesses' semantics differ and the API does not pretend otherwise.
- [x] Deterministic teardown: dispose both adapters (including pooled OpenCode
      `serve` processes), destroy open sockets rather than waiting, hard timeout
      before `process.exit`. `ipc/daemon.js` is now the real daemon, not a demo.
- [x] Folded in, both deferred Group 3 review items: a peer's `observe` iterator is
      cancelled on disconnect (per-connection `AbortController`), and duplicate
      in-flight correlation IDs are rejected instead of silently overwriting a waiter.

## Group 6: Validation — DONE (2026-09-06)

Four suites in `supervisor/runtime/test/`, wired into `npm run test:crash` and into
`npm test` (58 suites, exit 0). Mechanisms, mutation table and open items:
`supervisor/runtime/FINDINGS.md` sections 12-14.
- [x] Crash tests: `crash-recovery.test.js` SIGKILLs a real supervisor running in its own OS
      process under continuous write load (`_crash-victim.js`), then proves recovery — WAL
      recovery + `integrity_check` + no unparseable payload + nothing committed lost, and all
      three reconciliation outcomes on data written by a process that no longer exists:
      `orphaned-unmanaged` for the detached children that survived, `lost` for the one whose
      process died with it, and `finished` left untouched (never written, never overwritten).
      Open asks on both reconciled runs are closed; the orphans are then really reaped; a
      second reconciliation is a no-op.
- [x] Concurrency tests: `concurrency.test.js` drives everything over the real socket — eight
      concurrent starts (eight distinct verified process groups), concurrent input load with
      per-run event accounting and an anti-crosstalk check, three concurrent observers on a run
      being written to, `stop` racing `reap`, two concurrent reaps, and bounded teardown.
- [x] Daemon-level crash/restart: `daemon-crash.test.js` crashes and restarts the REAL
      `ipc/daemon.js` — stale lock taken over from a dead pid, stale socket rebound, a third
      daemon refused while the live one keeps serving, clean SIGTERM releasing the lock.
- [x] Every test/demo script must assert and fail loudly on a broken claim — never
      exit 0 regardless of outcome (this is how 3 false claims survived spike-0b to
      review; apply it as a standing rule here, not a one-off fix). Held: all 21 cases assert,
      and 12 mutations of the runtime were each observed failing at the case that claims to
      protect them (two of those mutations corrected the *tests*, not the runtime).
- [x] One real defect found and fixed: a process group containing only **zombies** answers
      `kill(-pgid, 0)` with success and `kill(-pgid, SIGTERM)` with **EPERM**, so
      `killProcessGroup` reported a definitively dead group as having "survived the kill" — and
      `reap` gates its terminal write on that flag, so it left the run row open forever.
      `procinfo.isProcessGroupLive()` (zombie-aware) is now consulted at all three decision
      points in the kill path.
- [x] **Gate: Phase 2 (vertical slice, go/no-go for the whole project) does not start
      until Group 6 passes.** Passed — Phase 2 is unblocked.

## Group 6 follow-through — DONE (2026-09-06, migration 0003)

Group 6 surfaced two *decisions* rather than bugs. Both were put to three independent models
(`sol`, `luna`, `terra`), decided, and shipped. Detail: `supervisor/runtime/FINDINGS.md` §13;
contract text: PLAN.md section 4. `npm test` — 25 test files, 58 suites, exit 0.
- [x] **`orphaned-unmanaged` is a lifecycle state, not a terminal outcome.** `runs.lifecycle`
      with `ended_at` left NULL, so a live unmanaged process stays in reconciliation's input set
      and is re-examined (and re-logged) every boot instead of being closed and forgotten. Real
      terminal transitions follow: `lost` when its process dies, `reaped` + `runs.reaped_at`
      when we kill it. Also fixes a side-effect nobody had noticed: a closed orphan row dropped
      out of the shared-process-group refusal, so reaping a sibling on a pooled `opencode serve`
      pgid would silently group-kill the orphan's live session.
- [x] **An append-only `orphan_sightings` journal** (`kind: new | repeat`) — history, never a
      second source of truth, so "we keep getting orphans lately" is a query and a future
      watcher process has something to reason about.
- [x] **The shortcut list**: `supervisor.orphans()` + an `orphans` wire command — every live
      orphan by title, cwd, pid, pgid, first/last seen and sighting count.
- [x] **Unanswered asks on a naturally completed run get a five-minute grace**
      (`asks.auto_close_at`, persisted so a crash mid-grace cannot strand it; swept on boot and
      on a 30s timer). A human answer during the grace wins; the sweep closes as
      `supervisor:auto-close`. Deliberate `stop`/`reap` and reconciliation still close asks
      immediately — and `stop` closes them at all now, which it never did before.
- [x] New suite `runtime/test/asks.test.js` (7 cases) + 9 more mutations (M13-M21), each
      observed failing at the case that protects it. M21 passed at first and had to be
      retargeted — the crash suite could not distinguish "filter by lifecycle" from "every open
      row", because there every open row was an orphan.

## Deferred by decision (2026-09-06)

- [ ] **Obsidian vault projection — after the Phase 2 vertical slice**, not before
      (PLAN.md section 18, ROADMAP Phase 10). Basic tier: per team/task/worker notes whose
      wikilinks make Obsidian's graph view a live team topology diagram, a `Dashboard.md`
      "what is going on right now" file, the live-orphan list beside it, **off by default**.
      Sequenced after the slice so the projector is not rewritten as the workflow changes
      shape; a web view later is a second projection of the same truth, not a second system.
- [ ] **A watcher process for doubted orphans** — reads `orphan_sightings`, logs patterns over
      time, proposes what to do about repeat offenders. Explicitly a side story: the journal it
      would read is already being written.

## Parallel-dispatch summary

**Historical (Phase 1).** Groups 1, 2, 3 and 4 were independent and dispatchable in one batch; Group 5 waited
on 1, 3 and 4 (not 2 — the lock fix is unrelated to the run lifecycle) and had to go to a single session;
Group 6 waited on Group 5. That is how it was actually run.

**For Phase 7 onward**, the same rule applies with different seams: the utility agents (jira, git, slack) are
independent of each other because each one's contract is "a typed command in, a short structured result out"
(PLAN.md §16) — but `callerIdentity`/capability authorization must land FIRST and in one session, because every
one of them is gated by it. Do not hand out the roster before the gate exists; that was the original
sequencing bug this project already hit once, when the assignment-confirmation UI was designed before
`start()` existed for it to call.
