# Build Roadmap

> **STATUS 2026-09-14 — read `HANDOFF.md`'s top header for the full current picture, this is just a
> pointer.** Phases 0a-6 complete and reviewed. Phase 7 (utility framework, resource leases, MCP pooling,
> the utility-task lane) has its LIFECYCLE/FRAMEWORK complete, AND worker-side MCP tool transport is now
> real (review-sol-2026-09-13.md finding 13, fixed 2026-09-14 — `spec.mcpConfig` is genuinely built and
> delivered for any harness that declares `mcpConfigDelivery`, via `runtime/mcp-stdio-proxy.js`; see
> HANDOFF.md's top header for the full mechanism and what's still honestly unverified) — Phase 7 has had
> 24 real
> findings fixed across four independent-review passes (two codex, two `opencode luna` after codex hit a
> multi-day quota wall — see `HANDOFF.md` items 22/24/25 and both `codexdoc/` review files). **All 9
> findings from the `luna` review, and all remaining should-fix findings from the codex review, are now
> fixed** (items 24-25). The utility-task lane's own "not built" gap — a one-call dispatch helper and
> real per-role run instructions — is closed too (item 26). **The OLDER (pre-review) should-fix backlog
> is now FULLY closed, items 27-38** — every directory's list is either fixed (`db/`'s fd leak, `lock/`'s
> two temp-file gaps, `ipc/`'s unsolicited-frame contract, `adapters/`'s entire 5-item list,
> `runtime/`'s iterator-cancellation gap — the last one GENUINELY real, reproduced empirically before
> fixing), correctly deferred by explicit design decision (`runtime/`'s pump-state-retention item), or
> resolved as a stale note / already-decided-elsewhere with no code needed (several `db/`/`adapters/`
> items, and `ipc/`'s `SO_PEERCRED` note — verified NOT to actually need a native addon before writing
> anything, per explicit instruction to check before building). **Phase 8 (CTO) has its first
> schema-only step started** (item 39): `config/harness-defaults.js` now declares the `clearPolicy`
> vocabulary and validates it on load; no decision module reads it yet (that's this checkbox's
> remaining half, not started). `cd supervisor
> && npm test` -> **127 suites, exit 0** at the time, re-verified repeatedly, zero leaked processes each
> time.
>
> **UPDATE, same day — a full review of every uncommitted change, from `opencode`'s `sol` agent
> (GPT-5.6 Sol via Bedrock), found real defects the test suite does not catch: `codexdoc/review-sol-2026-09-13.md`,
> 50 findings (1 critical, 18 high, 15 medium, 12 doc-consistency, 4 low). **The critical finding, 15 of
> the 18 high findings, and ALL 15 medium / 12 doc-consistency / 4 low findings are FIXED** (HANDOFF.md's
> top header has the full list, including two additive migrations — `0015_mcp_pool_lstart.sql`,
> `0016_worktree_claim_token.sql` — and every CODE fix independently verified to fail against the pre-fix
> code first; every DOC fix corrected directly in its own file, cross-checked against current code). One
> finding (12, workers holding `git:identity`) was explicitly reverted after confirming it contradicts
> ~10 pre-existing, deliberately-tested cases — flagged as needing a real design decision, not fixed
> unilaterally. **RESOLVED 2026-09-14 — owner decision: leave finding 12 as-is, no code change.** A plain
> worker acquiring `git:identity` remains intended behavior; the tradeoff the review flagged (nothing
> stops a worker from acquiring `host:heavy-job` or a future sensitive lease kind) is accepted, not fixed.
> **UPDATE, same day, after `7b6af0a` — finding 8 now FULLY closed, across two
> continuations.** Investigated fully first: this codebase has no worker-reassignment mechanism at all
> (confirmed by exhaustive grep), so the review's "reassignment hides an older run" sub-case doesn't apply
> to code that exists today; the wire-`start`-for-a-terminal-task sub-case needs a caller to explicitly
> pass a terminal task's own worktree path, narrower than first assumed. Two real, always-reachable gaps
> WERE found and fixed: (1) `discardTaskWorktree` checked-then-acted with no reservation of its own, so
> two concurrent discards of the same task both passed every check and both ran `git worktree remove
> --force` on the identical directory — fixed by having it claim the worktree slot with the same CAS
> `createTaskWorktree` already uses, releasing on every refusal path (verified against
> `runtime/test/worktree.test.js` case 20, fails pre-fix, passes post-fix); (2) `resume(runId)` had zero
> task-state awareness — it would reopen ANY run regardless of whether its task was already terminal,
> silently reopening a `merged`/`cancelled` task — fixed by refusing with `task-terminal` before ever
> reaching the adapter (verified against case 21, fails pre-fix with the fake harness throwing `Unknown
> runId`, passes post-fix). **UPDATE, same day — finding 13 now FIXED too, owner decision: build the real
> transport rather than deferring.** MEASURED against the installed `claude` CLI first (`claude mcp add
> --help`/`add-json --help`): `--mcp-config` takes a file path or JSON string, three transport types
> (stdio/sse/http), none a Unix socket — so new `runtime/mcp-stdio-proxy.js` is a plain stdio server
> `--mcp-config` spawns that relays bytes to the real pooled server's socket. `mcp-pool.js` now spawns
> every pool as a socket server and returns the real `socketPath`; a new `mcpConfigDelivery` capability
> field gates whether `start()` builds a real `spec.mcpConfig` entry. Verified at three levels including
> a genuine end-to-end round trip (a real leo-mcp process, reached through the exact command `start()`
> built, returning a real `tools/list` result) — full detail in HANDOFF.md. **Every finding from the
> entire 50-finding review is now resolved** — 12 by explicit owner decision (leave as-is), everything
> else fixed. `npm test`: exit 0, twice in a row, no flake. This batch (findings 8 and 13) was committed
> as `79aa275`.
>
> **UPDATE 2026-09-14, after `79aa275` — a THIRD independent review pass, this time cross-checked between
> two independent reviewers before any fix was attempted.** `opencode`'s `sol` reviewed the last three
> commits fresh (`codexdoc/review-sol-2026-09-14-commits.md`, 8 findings); a separate Claude Opus
> (high effort) then did its OWN independent review FIRST, read sol's report only afterward, and verified
> every one of sol's 8 findings against the real code — with a REAL reproduction wherever the claim was
> about timing or state (real sockets, real git, real spawned processes) — before consolidating both into
> `codexdoc/review-consolidated-2026-09-14.md`. **14 survivors (3 high, 6 medium, 4 low, 1 doc-
> consistency); 0 of sol's 8 refuted; 6 new findings sol never reported.** The headline: the MCP transport
> `79aa275` just built delivered a pooled server's ENTIRE tool surface to every attached role — a
> `jira-runner` could reach `git_push` and every Slack tool, bypassing the supervisor's own capability
> checks, lease, and journal entirely. **11 of 14 fixed** (protocol-aware tool allowlisting in
> `mcp-stdio-proxy.js`; `resume()` now re-attaches a fresh MCP socket instead of replaying a torn-down
> one; a crash mid-discard no longer permanently wedges the worktree claim or lets a stale create
> resurrect a deliberately deleted worktree, new migration `0017_worktree_claim_op_and_stamp.sql`; real
> socket-readiness verification instead of `existsSync` alone; a concurrent-attach timing mismatch;
> confirmed-kill-before-drop-ownership teardown everywhere; `chmod 0600` sockets; preflight no longer
> attaches MCP pools at all). **2 deferred by explicit judgment call** (fail-open MCP delivery — the blast
> radius shrank once the tool surface got bounded, so refusing outright is now a real product-scope
> decision, not a clear bug; the sibling-repo-dependent test's silent skip — made loud, not fully closed).
> **1 left alone** (a fail-open git-diff default the code already documents as deliberate). Full detail,
> per finding, in HANDOFF.md's top header. `npm test`: exit 0, twice in a row, no flake. This batch was
> committed and pushed as `0ae6cf2`.


Order matters here — each phase either de-risks an unknown or is a hard dependency for
a later one. Nothing is built yet; this is the sequence we agreed to follow.

**Reordered twice now.** First (2026-09-04, short-form review round): the spawn adapter
was pulled forward into a spike, Slack inbound was demoted to backlog. **Second
(2026-09-04, consolidated review of four full-length independent reviews across two
harnesses — see `arch-reviews-now-not-needed/consolidated-full-review-claude-opus5-medium.md`): that reorder didn't
go far enough.** All three full reviews independently rejected Phase 1 as originally
written — a file-backed JSON registry with no locking, no atomicity, no control plane —
and by extension rejected building CTO/utility-agent orchestration (old Phases 4–5) on
top of a runtime that couldn't yet run anything. This roadmap replaces the phase
structure entirely with the consolidated review's Part I table. **Do not treat "Phase 1"
below as the same Phase 1 from before** — the registry itself changed (SQLite +
supervisor + control socket, PLAN.md section 3–4), not just its position in the list.

Two things carry over unchanged in spirit even though everything moved: **de-risk the
riskiest unknown before building on top of it** (previously "the spawn adapter,"
generalized here to "the whole runtime"), and **Slack inbound stays in backlog** — all
three full reviews independently agreed the original demotion was correct and none
argued for pulling it back in.

## Phase 0a — Contracts (written into PLAN.md before any code) — **COMPLETE**
- [x] Canonical enums for task/worker/run state — done as part of this revision
      (PLAN.md section 3, section 6).
- [x] `workerId` / `runId` / `harnessSessionId` identity split — done (PLAN.md section
      3, section 2).
- [x] Adapter capability matrix shape — done (PLAN.md section 3, section 9).
- [x] Task/team cardinality fixed (a team has many tasks, not one) — done (PLAN.md
      section 5).
- [x] One CTO topology, capability-based authorization replacing the fixed hop-count
      escalation chain — done (PLAN.md section 16).
- [x] Persistence decision: SQLite, single-writer supervisor — done (PLAN.md section 3).
- [x] Repo/worktree identity (`repoId`/`worktreeId`/`branch`/`baseRev`) added to the
      task schema — done (PLAN.md section 3).
- [ ] Nothing left to do here except keep the docs and the code in sync as Phase 0b's
      spike reports back — this phase is "the contracts are written," not "the
      contracts are proven." Proof is Phase 0b.

## Phase 0b — Runtime + packaging spike (the actual gate) — **COMPLETE, gate cleared 2026-09-05**

**Status as of 2026-09-05: all six items proven with real, run code and captured
evidence (`spike-0b/*/`). Gate cleared — Phase 1 can start.**

- [x] **Claude Code**: proven — non-interactive start (`-p --output-format
      stream-json --input-format stream-json --include-partial-messages`), genuine
      streaming, multi-turn (resident process or `--resume`), interrupt (a
      `control_request` stdin message — **not SIGINT, which kills the process**),
      `clearContext` (mints a new `session_id`, no true in-place clear), cwd isolation
      via `spawn(..., {cwd})`, model+effort flags, exit classification via
      `terminal_reason`/`is_error` (not exit code alone), and the approval round-trip
      — proven working via a **synchronous PreToolUse hook**, not an async event. Full
      evidence + working `adapter.js`: `spike-0b/claude-code-adapter/`. PLAN.md
      section 4/7 updated with the real findings.
- [x] **OpenCode**: proven — and it does *not* match Claude Code's shape, confirming
      why this had to be checked independently rather than assumed. **Critical
      finding: OpenCode has two non-interactive tiers that are not interchangeable** —
      the one-shot CLI (`opencode run`) gives batched output with no working
      interrupt at all; streaming, clean interrupt, and approval **only work through
      the resident `opencode serve` HTTP+SSE server**. The supervisor's OpenCode
      adapter must always use `serve`, never spawn `run` per turn. Approval round-trip
      here *is* a genuine async event (`permission.asked` via SSE, answered later via
      a separate call) — the opposite shape from Claude Code's synchronous hook. Full
      evidence + working `adapter.js`: `spike-0b/opencode-adapter/`. PLAN.md section
      4/7 updated with the real findings.
- [x] Write the **mock harness** — done (`spike-0b/mock-harness/`): full adapter
      contract, deterministic per-prompt replay, two concurrent runs proven genuinely
      interleaved with real captured output. Deliberately more capable than either
      real adapter (full `resume`, no caveats) so Phase 4 can build against the ideal
      case — its own README says so explicitly.
- [x] Minimal packaging/daemon-layout probe — done (`spike-0b/packaging-probe/`):
      single-instance lock proven safe under a real 10-way concurrent race, lazy-start
      proven cold and warm, stale-lock-after-`kill -9` recovery proven, graceful
      shutdown on SIGTERM/SIGINT proven. Two real bugs found and fixed by actually
      running the code (a module-import side effect and a stdio-piping hang), not
      caught by inspection alone. **One edge case explicitly flagged as not fully
      exercised**: two clients cold-starting at the exact same instant — the
      underlying lock race is proven safe, but the client's own fallback path through
      that specific race wasn't directly tested end-to-end. Worth a follow-up test
      before treating packaging as fully closed, not blocking for now.
- [x] **Two concurrent *real* sessions** — done (`spike-0b/supervisor-integration/`,
      2026-09-05): a real Claude Code run and a real OpenCode run driven simultaneously
      through an actual supervisor wiring both adapters. Captured log shows genuinely
      interleaved sub-second timestamps and `ps`-confirmed concurrent OS processes —
      not the mock harness's proven-safe plumbing, the real adapters. **Real bug found
      and fixed**: the first attempt hung forever because nothing answered OpenCode's
      `permission.asked` event — fixed by adding a real `answerApproval` supervisor
      command (Claude Code has no equivalent; calling it on a Claude Code run throws
      rather than silently no-op'ing, since that harness's approval is a synchronous
      hook with no event to answer).
- [x] **Restart recovery** — done, and it proved **three outcomes, not two**: a real
      Claude Code run's orphaned child dies on its own (`kill -9` on the supervisor) ->
      reconciled `lost`; a real OpenCode `serve` process *survives* being orphaned
      (it's an HTTP server, not stdin-attached) -> reconciled to a new, honest third
      state, **`orphaned-unmanaged`** (alive, verified, but no adapter handle bound to
      it anymore) — PLAN.md section 4 updated with this three-state model. Neither run
      was ever silently marked `finished`. **New gap surfaced, not yet closed**:
      neither adapter spawns detached with real process-group ownership, so an
      orphaned-unmanaged process isn't automatically killed, just correctly labeled —
      Phase 1 needs to actually own and kill, not just detect.
- [x] Token telemetry — done: Claude Code's `result.usage` (already present, was being
      discarded) now flows into `turn.end`; OpenCode's SSE `step-finish` part (checked
      live, previously undocumented either way) carries the same token shape, added as
      a new `usage` event. Real captured values for both harnesses in the run registry.
- [x] **Update PLAN.md section 3/4/9 if either harness's real behavior doesn't match
      what's written** — done, 2026-09-04/05: section 4's adapter contract, the
      three-state reconciliation model, section 7's clearContext/asks description, and
      the capability matrix are all now the proven values, not the original
      placeholder shape.
- [x] **Gate: do not proceed to Phase 1 until every item above has a working,
      demonstrated answer for both harnesses.** All six proven, 2026-09-05. **Gate
      cleared.** Two things carry forward as known, labeled gaps rather than silent
      debt: process-group ownership/kill-on-lost (Phase 1's job), and the
      two-simultaneous-cold-clients race from the packaging probe (not blocking, worth
      a follow-up test).

## Phase 1 — Supervisor — **COMPLETE 2026-09-06** (all six groups, each independently reviewed)

**Live status lives in `TODO.md`, not in the checkboxes below** (which are the original
design requirements, kept as written for traceability). As of 2026-09-06: **Phase 1 is
complete.** Groups 1-5 are built, tested and independently code-reviewed (`supervisor/db/`,
`lock/`, `ipc/`, `adapters/`, `runtime/`), and **Group 6 — crash/concurrency validation — now
passes, so the Phase 2 gate is cleared.** Group 6 SIGKILLs a real supervisor in its own OS
process under write load and a real `ipc/daemon.js`, then proves recovery (WAL + integrity,
all three reconciliation outcomes, stale lock takeover, socket rebind); it found and fixed one
real defect, a zombie-only process group being reported as having survived a kill. Evidence
and open items: `supervisor/runtime/FINDINGS.md` sections 12-14. Group 6's two findings were
then **decided and shipped** as migration `0003` (2026-09-06, after three independent model
opinions): `orphaned-unmanaged` became a lifecycle state on a still-open row (so a live
unmanaged process stays visible to every boot, with an `orphan_sightings` journal and an
`orphans` command), and unanswered asks on a naturally completed run now get a persisted
five-minute grace before auto-close. Group 5's review (`review-three/`, luna + terra + a Sonnet consolidation, adjudicated
in `review-three/group5-verdicts.md`) found 13 defects, all fixed with regression tests that
were each observed failing against the pre-fix code; 3 findings were rejected and 1 deferred,
with reasons recorded in that file. Two requirements below are
worth calling out as closed, because both were flagged above as gaps carried forward from
Phase 0b: **process-group ownership + kill-on-lost** (both adapters spawn detached with
*verified* `pgid === pid`, plus a real `reap` and `harnessOf` rehydrated from persisted
rows) and **one supervisor-owned event consumer per run** (`supervisor/runtime/event-pump.js`).
Mechanisms and evidence: `supervisor/runtime/FINDINGS.md`.

**13 design requirements below are carried forward from a code review of the spike-0b
implementation itself** (`consolidated-review-claudeopus5-medium--spike-0b.md`,
2026-09-05 — three independent model reviews, 107 raw findings deduplicated to 44,
verdict: request changes). The review's framing, which this list follows: don't fix
spike code as an end in itself — three false claims in the spike's own evidence were
corrected directly in `spike-0b/` (a lock-exclusivity claim, a reconcile log line
claiming an unperformed check, and a SIGINT docstring contradicted by its own captured
log) — everything else is a design requirement Phase 1 inherits by construction if not
built correctly the first time, not a bug to patch in throwaway spike code.

- [ ] Single-instance lock + lazy start by first client (proven in Phase 0b, built for
      real here). **Fix the exclusivity gap found in review**: write the lock payload
      to a temp file first, then `fs.link(tmp, lockPath)` (atomic, fails `EEXIST`) —
      not `open('wx')` followed by a separate write, which leaves a window where the
      lock file exists but is empty and unparseable, making a second process treat a
      live lock as stale.
- [ ] SQLite schema from PLAN.md section 3, in full: `schema_version`, `harnesses`,
      `teams`, `workers`, `runs`, `tasks`, `asks`, `requests`, `integrations` (**ship
      empty and versioned — do not pre-create rows for unbuilt integrations**),
      `event_log` (tiers 1–2 only for now; tier 3 lands in Phase 2 with the vertical
      slice), `transition_journal`, `outbox`.
- [ ] Unix domain socket, typed commands + subscriptions — the one authoritative
      mutation path. Nothing else (TUI, CTO, hooks) gets direct DB access.
- [ ] Migrations story from row one, even if there's only one migration so far.
- [ ] Startup reconciliation: verify PID + process group + start time for every
      `runs` row. **Three outcomes, proven in Phase 0b (PLAN.md section 4) — don't
      regress to two**: process actually gone -> `lost`; process verified alive but no
      adapter handle bound to it -> `orphaned-unmanaged`; adapter's own normal
      completion path -> `finished` (reconciliation never sets this one itself). Close
      open `asks` and surface in the TUI for either of the first two.
- [ ] **Process-group ownership + kill-on-lost — real work here, not carried over from
      Phase 0b.** The spike proved detection (an `orphaned-unmanaged` OpenCode `serve`
      process was correctly identified as still running) but neither adapter spawns
      detached with the supervisor owning the process group, so nothing actually kills
      an orphaned process today — it just sits there consuming resources, correctly
      labeled but unmanaged. Concretely: every child spawns with `detached: true` so it
      leads its own process group (`pgid === pid`, recorded and verified as such, not
      inherited from the supervisor — the spike's stored `pgid` is currently the
      *supervisor's own*, so a naive `kill(-pgid)` on it would kill the supervisor and
      every sibling run, not the one lost run); `DASHBOARD_SPAWN_DEPTH` is set in the
      child's env at spawn time with a hard refusal above a small ceiling (the
      spawn-recursion guard from PLAN.md section 4 has no implementation yet); and a
      real `reap` command is added to the supervisor's command surface (verifies
      pid+pgid+lstart, then kills the process group) plus `harnessOf` routing is
      rehydrated from persisted rows on boot — without both, `orphaned-unmanaged` is a
      dead-end state reachable only by `list`, which defeats the point of having it.
- [ ] **One supervisor-owned event consumer per run**, independent of whether any
      client is currently subscribed. Status transitions, token telemetry, and
      persistence must derive from this internal consumer, not from a client's
      `observe` connection happening to be open — the spike's `list` can report a run
      as `running` forever if nothing ever subscribed to watch it finish. Client
      `observe` connections become fan-out subscribers (per-subscriber cursors) over
      this one real stream, which is also what makes multiple simultaneous observers
      on one run see the same events instead of splitting them nondeterministically.
- [ ] **One normalized `turn.end` event across both harnesses.** The spike's two
      adapters silently diverged — Claude Code emits `isError`, OpenCode emits
      `status`, and the supervisor was written against only the Claude Code shape, so
      every errored/aborted OpenCode turn got recorded as a clean `idle` completion.
      Make `status` the required field on every adapter's `turn.end`; the supervisor
      treats any unrecognized value as `errored` — fail closed, not fail silent-success.
- [ ] **Two-level identity for server-backed harnesses.** OpenCode's `opencode serve`
      is pooled per-cwd and multiplexes many sessions through one process — so every
      run sharing that server currently persists the *same* pid/pgid/lstart, and
      reconciliation/kill-on-lost cannot tell them apart. Model this as
      `{ serverPid, sessionId }` with independent verification of each level (the
      server's own liveness, and separately whether that server still knows this
      session — `GET /session/{id}` is the natural probe). **This needs to land in
      PLAN.md section 4's `workerId`/`runId`/`harnessSessionId` identity split before
      any Phase 1 code is written against the two-part assumption** — the three-way
      split as currently written doesn't yet account for one OS process backing many
      logical runs.
- [ ] **The daemon must never die from a peer.** Every socket and every adapter
      `child.stdin` gets an `error` handler (an `ECONNRESET` from a killed client, or an
      `EPIPE` from writing to a dead child's stdin, is currently an unhandled
      `EventEmitter` error that crashes the whole supervisor — proven in the spike by
      simple sequences like start -> stop -> sendInput). Add a top-level
      `uncaughtException`/`unhandledRejection` net as a backstop, guard every
      `socket.write`/`stdin.write` against a destroyed stream, and cap per-connection
      buffered input so one client without a trailing newline can't grow memory
      unboundedly.
- [ ] **Correlated wire protocol.** Every command gets a client-supplied `id`, echoed
      on its response and on every `observe` stream frame belonging to it. The spike's
      protocol has no correlation at all — fine only because its own clients never
      pipeline; expensive to retrofit once Phase 1 writes a real client against the
      wire format, so do it now while the format is still young.
- [ ] **Deterministic teardown.** `shutdown()` must dispose both adapters (including
      the pooled OpenCode `serve` processes, which nothing currently kills — every
      supervisor lifecycle today leaks a `serve` process per cwd plus every live
      `claude` child), destroy all open sockets rather than waiting for them to close
      naturally (an open `observe` connection — the *normal* case for an in-progress
      run — currently hangs graceful shutdown indefinitely), and enforce a hard
      timeout before `process.exit`. This closes the loop with the reap/process-group
      item above: clean shutdown should not be the thing manufacturing orphans.
- [ ] **Redaction and file permissions at the write boundary.** Prompts are currently
      persisted verbatim to a plain-permission file — real prompts routinely contain
      pasted tokens, connection strings, and customer data. Persist a hash plus a
      truncated preview by default (full text only behind an explicit opt-in), create
      the state directory `0700` and its files `0600`, and add a `SO_PEERCRED`/
      `getpeereid` uid check on socket accept — the local-process threat model already
      has stronger primitives available to it, but "any local process can start
      token-burning runs" shouldn't be free.
- [ ] **Routable `clearContext` and `resume`.** Both are implemented in the spike's
      adapters but never exposed through the supervisor's command surface, so neither
      is reachable by anything other than a standalone test. Section 8's `clearPolicy`
      (per-role automatic clearing) cannot exist until these are callable commands.
- [ ] **Atomic, non-amplifying persistence** (a smaller concern once SQLite lands, but
      the discipline carries forward): no bare full-file rewrite on every streamed
      event — either the SQLite write path is naturally transactional from the start,
      or if any interim flat-file persistence is still in play, it must be
      temp-file-plus-rename, never truncate-in-place, and a single token-usage event
      must not trigger an O(all runs) rewrite.
- [ ] **Proof scripts must assert, not just print.** The spike's own demo/prove
      scripts exit 0 regardless of what actually happened, which is how three false
      claims (a lock-exclusivity guarantee, a reconcile log line, a SIGINT docstring)
      survived into `FINDINGS.md` and code comments until an external review caught
      them. Every Phase 1 test/demo script must fail loudly (non-zero exit, clear
      message) when its own claim doesn't hold — this is a testing standard for the
      rest of the project, not a one-off spike cleanup.
- [x] Crash/concurrency tests: kill the supervisor under load, confirm no torn writes,
      confirm reconciliation on restart actually runs and produces the right one of the
      three outcomes above (not just "some non-`finished` state"). **Done 2026-09-06
      (Group 6)**: `runtime/test/crash-recovery.test.js` (SIGKILL of a real supervisor
      process mid-load, all three outcomes distinguished on real processes),
      `runtime/test/concurrency.test.js` (eight concurrent runs over the real socket,
      raced terminal writers), `runtime/test/daemon-crash.test.js` (the real daemon
      crashed and restarted: stale lock takeover, socket rebind, second daemon refused).
      `npm run test:crash`; evidence in `runtime/FINDINGS.md` section 12.

## Phase 2 — Vertical slice, one harness — **go/no-go gate: DECIDED GO 2026-09-07**
- [x] spawn -> live pane -> send input -> **approval round-trip via `asks`** -> cancel -> kill supervisor ->
      restart -> recover. All built and mutation-verified. The approval round trip is the load-bearing one
      (`runtime/FINDINGS.md` §17-18): an answer is durable BEFORE it is delivered, a retry cannot deliver it
      to a process that was replaced (generation-pinned), and a harness that withdraws its own request is
      handled rather than left parked.
- [x] **A live pane** — `supervisor/pane/`, a plain socket client with no database handle. Rendering is a pure
      function, replay is by cursor, gaps are announced, and what a run is blocked on comes from `asks` rather
      than from the transcript (§19).
- [x] **Real-harness crash recovery** — proven against the real `claude` CLI, not the fake: a SIGKILLed
      supervisor's child is reconciled honestly, and `finished` is only ever written by the adapter's own
      completion path.
- [x] **The worker environment decision** — measured on the real CLI, reviewed by three models, then FLIPPED
      by owner decision: repo config (which EXECUTES a repo's committed hooks) is now OFF by default
      (§20, §31). Confirmed: 0 hooks, 0 MCP servers, all 24 built-in tools.
- [x] **Preflight session cleanup** — `migration 0005`, verified against the real CLI: a reachability check
      leaves no run row, no events, and no session in the harness's own store (§23).
- [x] **Tier-3 handoff doc generated at least once** — `migration 0006`, `handoff/generate.js`. Deterministic
      and free, six sections, per-section limits, truncation stated in the document. **It corrected PLAN.md
      §8**: tier 3 cannot live in `event_log`, which is run-scoped and NOT NULL, while a handoff is
      task-scoped (§24).
- [x] **Tier-2 per-turn digests — Rule 4 is now complete** (2026-09-08, §33). Extractive by default rather
      than model-written, a documented deviation: a model call per turn sits on the most frequent event in the
      system, a generated summary can be checked for shape but never content, and an extractive digest cannot
      state a decision nobody made. Tier 3's `Assumptions` section now QUOTES those digests, attributed and
      de-duplicated, and distinguishes its two kinds of empty.
- [x] **The gate itself** — `runtime/test/real-phase2-gate.slice.mjs` walks the whole workflow in one
      continuous run against the real CLI, 7/7. It found a defect that 98 green suites and 64 caught
      mutations had all missed: `recordTransition` journalled a transition without moving `tasks.state`
      (§25). **GO recorded 2026-09-07** on that evidence.

## Phase 3 — Second harness + adoption — **COMPLETE 2026-09-07**
- [x] **The adapter boundary holds for a second, independently-implemented harness.** Proven by the
      capability matrix, where three fields carry SEMANTICS as strings rather than booleans because the two
      adapters genuinely differ: `clearContext: erase|compact` (Claude Code erases, OpenCode compacts — same
      name, opposite meaning, and Rule 5's cost model is only true of one), `approvalProtocol: host|observe-only`,
      `residentProcess: per-run|pooled` (§26).
- [x] **Conformance suite runs against both adapters** — declaration plus verification, per-check pass/fail,
      and only on passing does `harnesses.status` flip to `active`.
- [x] **Hook-based adoption of externally-started sessions** — `migration 0007`/`0008`,
      `hooks/claude-session-hook.mjs`, proven against a real `claude` session adopting itself. The danger this
      needed its own lifecycle value for: an adopted session is structurally identical to an orphan, and the
      supervisor must never be able to kill a process it did not start. `reap` refuses it, reconciliation
      skips the orphan branch, and `runs.started_by` makes "the supervisor only kills what it started" an
      explicit, queryable fact (§27).
- [x] **The review of Phases 3-5 found a LETHAL defect in the safety path** and it is fixed: adoption was
      non-atomic, so a crash between `createRun` and `markRunAdopted` left a row the reaper would kill
      (§30). Verified to kill the process before the fix.

## Phase 4 — TUI against the mock harness — **COMPLETE 2026-09-08**
- [x] Top team bar, task-node tree (not member-node — PLAN.md §5's cardinality fix), panes, focus model, full
      keyboard navigation, stale/crashed/empty pane states. `layout.js` and `state.js` are PURE (state ->
      lines, key -> action -> state), which is what makes a TUI testable at all (§28).
- [x] Deterministic and cheap against the mock harness — `node supervisor/tui/cli.js --demo` starts a real
      supervisor, real pump and real socket with a fake harness in one process. **It immediately found three
      integration bugs every unit test passed through.**
- [x] **Replay-on-switch** (2026-09-08, §34) — `tuiSnapshot` takes `cursors: { runId -> lastSeq }` and returns
      only what is new, plus a gap COUNT the pane prints and a `provisional` flag for prose still being
      written. The window-re-read it replaced was indistinguishable from replay on any run shorter than 60
      events, which is every run in every suite here.
- [x] **Mouse/click bindings** — SGR reporting, and one `frameGeometry` for drawing AND hit-testing, because
      two copies of that arithmetic is how mouse support rots. Press of button 0 only.
- [x] **The Requests panel** (FLOWS §6a) — built and read-only ON THE TUI SIDE (Accept/Decline are drawn
      but inert): the Slack **inbound** path that would fill it is still backlog, so there is nothing yet
      for the buttons to act on. **Clarified 2026-09-13 (review-sol-2026-09-13.md finding 42) — this
      "read-only" describes the TUI panel/inbound gap only, NOT the `utility:slack` role's own
      capability**, which is a separate thing and is NOT read-only: `domain/capabilities.js` grants
      `utility:slack` the `slack:post-bot` (send) capability; `utility:awsquery` is the actually
      read-only-by-design role (`read:registry` only, no side-effecting capability at all). Absent at
      zero pending, `h` hides it while focused.
- [x] **A defect found by looking rather than testing**: `state.status` — including `supervisor unreachable`
      on every failed round trip — was rendered by NOTHING. Frames are now captured by a committed script
      (`tui/capture-frames.mjs`) so looking stays one command.
- [x] **Requests panel layout/toggle/detail-view mechanics — BUILT 2026-09-11** (PLAN.md §14.4/§5
      corrections; the buttons themselves and everything server-side stay backlog, unchanged — see
      the item above). Default height raised to ~30%; `R` toggles the panel from anywhere regardless
      of pending count; `t` toggles the TREE panel the same way; a request too long to fit inline
      expands to a full-width Request Detail view (`FOCUS.REQUEST_DETAIL`) that replaces the tree +
      pane area, with `[a] Accept`/`[d] Decline`/`esc` — closing it restores the layout exactly, since
      entering/leaving only ever changes `focus`. 3 new pure cases in `tui/test/tui.test.js` (20-22),
      5 new captured scenes in `tui/evidence/01-demo-frames.txt`, `TUI-GUIDE.md` steps 16-20.
- [x] **Two should-fix findings from `codexdoc/REVIEW-NOTES.md` fixed the same day**: finding 10
      (standalone `attachPane`/`pane/cli.js --list` sent no principal token, refused by the real
      authorization gate — `ipc/client.js`'s `connect()` now carries one, `pane/pane.js` reads
      `owner.token` by default same as `tui/cli.js` already did; new `pane/test/pane-auth.test.js`, 3
      cases against the REAL authorized socket) and finding 15 (a restarted worker's pane showed its
      OLD ended run instead of its live replacement — `tui/app.js`'s `forWorker` now prefers live over
      ended regardless of array position, and newest-by-`lastEventAt` among ended-only runs; new case
      9 in `runtime/test/tui-replay.test.js`). Finding 15's SECOND half was left open at the time this
      bullet was first written, then **CLOSED the same day (HANDOFF.md item 20)** — `buildPanes` now
      uses the neutral `status: "ended"` for every ended run, never `"crashed"`, regardless of
      `exitReason`. **CORRECTED 2026-09-13 (review-sol-2026-09-13.md finding 42): this bullet's original
      wording still said "still open, not fixed" and named the field `"crashed"` — both stale.**
      `npm test`: exit 0, **117 suites**, re-verified 3x, zero leaked processes each time.

## Phase 5 — Domain — **COMPLETE 2026-09-08**
- [x] **The full failure/cancel state set from PLAN.md §6 is built AND ENFORCED** — `domain/task-states.js`
      (pure, data-driven) with `recordTransition` refusing anything illegal. Until this, any string was a
      state and the diagram constrained nothing: the project's own tests had drifted to `in-progress` /
      `in-review`, names appearing nowhere in the design. The guards that cannot be skipped: **no autonomous
      merges**, returning from a failure is explicit, `blocked` only from `implementing` and only when an ask
      is really open (§29).
- [x] **Task-type workflow profiles** — `domain/workflow-profiles.js`: per type, which roles a task needs, how
      many reviewer verdicts `approved` requires, and which pane layout is the default. **It adds no state
      machine edges** — an `adhoc` task (§10: one worker, no reviewers) reaches `approved` with ZERO required
      verdicts, which is a guard parameter rather than a second diagram. An unprofiled type gets the STRICTER
      default (§35).
- [x] **Harness/model assignment** (PLAN.md §11) — `config/harness-defaults.js` reads the hand-edited file
      with §11's own table as the built-in fallback. **Loud on a typo, quiet on absence**; per-team overrides
      merge PER FIELD, since a partial override is the only kind anyone writes.
- [x] **Assignment service: idempotency keys and partial-start compensation** — the key is claimed BEFORE any
      spawn, and the test fires two confirms CONCURRENTLY because a sequential pair passes even when the claim
      is in the wrong place. Compensation: **keep what worked**, record the failed role as retryable, and if
      NOTHING started land in `start-failed` rather than sitting in `starting`. The keep-vs-kill fork went to
      two independent models, which both chose keep with the same caveat — and it holds structurally, since
      `approved` needs the profile's verdicts and `merged` needs a human.
- [x] **"Most-recent-message" default + click-then-`m` pin override** (PLAN.md §5) — the dev pane follows the
      most recently active dev run, and a pin beats recency until unpinned. It previously showed "the first
      worker whose role is coder": the same answer with one coder, silently wrong with two.

## Phase 6 — Reviews — **COMPLETE 2026-09-09**
- [x] **`review-profiles.json`** (PLAN.md §13): dimensions, blocking flags, quorum, revision-bound and
      per-dimension verdicts — `migration 0009`, `config/review-profiles.js`, `domain/review.js`. The rule is
      enforced in ONE place (`approveTask`), because `recordTransition` would otherwise take
      `awaiting-review -> approved` from anybody who passes two verdicts. Three conditions, reported
      separately with reasons: every blocking dimension approved, quorum met (counting DISTINCT REVIEWERS),
      zero current-round change requests — including on non-blocking dimensions.
      **The asymmetry worth knowing**: a stale approval dies with its commit, a stale change request does not,
      because nobody said it was fixed (§37).
- [x] **Finding verification** — the adversarial second pass runs BEFORE storage, so a REFUTED finding never
      reaches the coder. The default verifier confirms nothing: with no model configured a finding is
      `unverified` and delivered LABELLED, because calling it confirmed would be a lie and dropping it would
      lose a real finding to a missing configuration. What the coder gets is ranked, `file:line`, and diffed
      against the previous round.
- [x] **Review-pane wiring** — the toggles (`1`/`2`/`p`/`r`, dev-pane auto-expand) landed in Phase 4; Phase 6
      added the **review bar**, one line showing WHICH of §13's three conditions is short. `awaiting-review`
      as a glyph answers none of them: a reviewer can have approved everything while quorum is one short, and
      that looks identical to nobody having looked.
- [x] **Model diversity is validated** (§13's `require-distinct-harness`) — checked at assignment, reported
      rather than refused, and surfaced in the handoff's Blockers so it cannot be missed.
- [x] **REVIEWED by `opencode --agent sol --variant medium`, 2026-09-09** — 6 blocking, 4 should-fix, 2
      refuted; every finding accepted and ten fixed, each blocking one reproduced against the pre-fix code
      first. `review-phase6/verdicts.md`, `runtime/FINDINGS.md` §37.10. **Three of the six blocking findings
      were mechanisms built, documented and never consulted**: content-addressed profiles that nothing read,
      a rule whose identity inputs came off the socket, and a guard whose round and commit were the caller's
      to choose. Mutations 15 -> 27, all caught; suite 111, exit 0.

## Phase 7 — Utility framework + git agent  **(the gate is done, 2026-09-09)**
- [x] **Capability-based authorization** (PLAN.md §16) with a real `callerIdentity` principal — done
      2026-09-09. `migration 0010` (principals, agent journal, sensitive approvals),
      `domain/capabilities.js`, and `supervisor.authorizedCommandHandlers()`, which `ipc/daemon.js` serves.
      **Measured first, and it changed the design**: there is NO socket peer credential available from pure
      Node (evidence 17), so a principal is filesystem permissions (which user) plus a supervisor-minted token
      (which principal) — and §38.1 states the limit that follows, since same-uid workers can read the owner's
      token. It buys attribution, fixed toolsets and an audit trail, not a sandbox.
      **Fails closed**: a command with no declared capability is refused, and the coverage case enumerates the
      real handler map — which immediately found two stale policy entries. `merged` now needs a second
      principal's approval bound to its exact arguments, single-use and expiring, so §6's "explicit human
      approval" is an artifact rather than a boolean. 9 pure + 9 wired cases (one spawns the REAL daemon),
      16 mutations. `runtime/FINDINGS.md` §38.
- [x] **REVIEWED by `opencode --agent sol --variant medium`, 2026-09-09** — 2 blocking, 2 should-fix, 3 notes;
      all seven accepted and fixed, mutations 16 -> 22. `review-phase7/verdicts.md`, `runtime/FINDINGS.md`
      §38.7. **Both blocking findings were seams**: a worker only got a credential on its FIRST run (rotation
      fixed it), and the installed session hook could not authenticate at all — so adoption failed silently in
      production while every adoption test passed against the raw command map. A fifth review rule came out of
      it: *a mechanism that works on the first call, or through the test's own harness, is not a mechanism that
      works.*
- [ ] **A real sandbox is NOT this** — named so it is not mistaken for done. Workers run as the same user, so a
      worker that reads `owner.token` holds the owner's authority. If that ever matters, the fix is a separate
      uid per worker or OS-level confinement, not more capability checks.
- [x] **Stand up the roster — decided differently, and built.** `git-create-push`'s full fight loop is
      DONE (item 11 in this file, `HANDOFF.md` items 21/32). `jira-automation`/`slack-message` were
      superseded by `leo-mcp` (a real MCP server, `../leo-mcp/`, `HANDOFF.md` item 12) plus this
      dashboard's own utility-task lane (`git-push-task`/`jira-task`/`awsquery-task`/`slack-task`,
      `HANDOFF.md` item 13) — role/capability/model machinery and real per-role dispatch/instructions ARE
      built (item 26). **SUPERSEDED 2026-09-14**: jira-task/slack-task now have a real, DELIVERED, bounded
      MCP transport too (finding 13, fixed; see top of `HANDOFF.md`) — awsquery-task still has none, but
      because it never declares a leo-mcp need at all (its AWS access is a separate, unrelated MCP server),
      not because delivery is missing. CTO (Phase 8) has only its schema-only first step (item 39).
      **CORRECTED 2026-09-13 (review-sol-2026-09-13.md finding 42): this line previously read `[ ]`
      unconditionally, implying none of "utility prompts/dispatch" existed — stale.**
      **List-management is not on this roster** — it's typed supervisor commands
      (`moveWorker`, `renameWorker`, `hideTeam`, `pinMain`) the CTO calls directly, not
      a separate agent (PLAN.md section 16).
      **Corrected 2026-09-11 — the roster's shape changed, not just its status.** `leo-mcp`
      (`../leo-mcp/`, new standalone sibling repo, decided after reviewing what already existed:
      the `git-create-push`/`jira-automation` Claude Code skills and `team-slack-bridge`'s own
      21-tool MCP server) is now where the Slack and Jira MECHANICS live, consolidated into one
      MCP server instead of three. See PLAN.md §16.1 for the full split of what's dashboard-code
      vs. leo-mcp vs. still-a-skill.
- [x] **PLAN.md §16.2, the utility-task lane — BUILT 2026-09-11.** The dashboard-side half of the
      roster: four `type: "adhoc"`-shaped task types (`git-push-task`/`jira-task`/`awsquery-task`/
      `slack-task`), each a single worker in a role (`git-push-runner`/`jira-runner`/`awsquery-runner`/
      `slack-runner`) with its own cheap-model default and its own fixed UTILITY capability preset
      (`utility:git`/`utility:jira`/`utility:awsquery`/`utility:slack` — the last one new, `read:registry`
      only, since a pure AWS read query has no dashboard side effect to gate). `ensureWorkerPrincipal`
      mints these `kind: "utility"`, matching migration 0010's own description of that kind. 4 new test
      cases (`runtime/test/utility-task-lane.test.js`) including a NEGATIVE check that a role does NOT
      also hold another role's capabilities. `npm test`: exit 0, **113 suites**, re-verified 3x.
      **Not done**: the runner's own prompt/instructions text, and any dispatch convenience beyond the
      same `createTask`/`assignTask` calls every other task type already uses.
- [x] **`git-create-push` gets its full fight-loop — DONE 2026-09-10** (PLAN.md section 8, Rule 2;
      §16's roster; the first real consumer of both the worktree lifecycle and resource leases).
      `agents/git-create-push.js` (pure, no db) + `runtime/supervisor.js`'s `gitCreatePush` glue:
      real `git` access, stage/commit/hook-failure/classify (8 classes)/autofix (format +
      lint-autofixable only, via a repo-provided `.git-create-push-autofix.sh`)/re-run bounded at 3
      attempts, returning the exact `{status, attempts, unresolved?}` contract — never raw tool
      output. Two wire commands (`gitPush`/`git:push`, `gitPushProtected`/`git:push-protected`
      SENSITIVE) sharing one loop, `git:identity` held across the whole call and released in a
      `finally` (proven by real cross-process contention AND a forced-throw case). `gh pr
      create`/`mrUrl` is real but opt-in and excluded from `npm test` (real credentials/network) —
      `runtime/test/real-git-create-push.slice.mjs` is the manual counterpart, same pattern as this
      project's other `real-*.slice.mjs` files. 15 new cases, suite 110 -> 112, exit 0, re-verified 3x.
- [x] **Schema landed 2026-09-10, migration 0011** (`db/migrations/0011_leases_and_mcp_pool.sql`) —
      `resource_leases`: one row per active CLAIM, not one row per resource, so a `counted` lease at
      capacity > 1 can have multiple concurrent holders (`released_at IS NULL` = still held, same
      convention `runs`/`asks` already use); indexed for "who holds X now" and "find expired leases."
      Verified: `npm test` exit 0, tested both fresh-db and upgrading from schema version 10.
- [x] **`acquireLease`/`releaseLease`/`renewLease` BUILT and tested, 2026-09-10** (PLAN.md section 20;
      `runtime/supervisor.js`, `db/index.js`'s `tryAcquireLease` et al., `config/resources.js` for
      `resources.json`, migration 0012 adding `resource_leases.release_reason`). `git:identity`
      (exclusive) and `host:heavy-job` (counted, capacity 1, `memoryHeadroomPercent: 15` default) ship
      as built-in declared resources. **Claim-before-side-effect, proven CONCURRENTLY**: 8 real OS
      processes race an exclusive lease (`db/test/leases.test.js` case 1, exactly 1 granted) and a
      capacity-3 counted lease (case 2, exactly 3 granted) via `BEGIN IMMEDIATE` — a plain
      `db.transaction()` only escalates to a write lock at the first write, which is too late for a
      check-then-insert. TTL+heartbeat persisted, swept on the SAME timer `asks.auto_close_at` already
      uses rather than a second mechanism, `release_reason` distinguishes a sweep from a holder's own
      release (same shape as `asks.answered_by = 'supervisor:auto-close'`). Gated by one new capability
      `resource:lease` (not per-resource — the capability model gates commands, not arguments, outside
      the sensitive-approval mechanism, checked before deciding). **§20.2's queue visibility, decided**:
      no FIFO "position" concept — a `counted` resource is a semaphore, not a mutex queue, so "3rd in
      line" isn't well-defined when up to `capacity` holders can be admitted in any order; a refusal
      names every current holder (`blockedBy`) instead. 8 pure + 7 wired test cases, 0 mutations (no
      pre-fix state for brand-new code; the concurrent-process race stands in, same as Group 5's
      standing rule). **Flaked once on a re-run** (`runtime/test/leases.test.js`'s "healthy host" case
      depended on real ambient free memory, which briefly dropped under 15% from something else running
      on the machine) — fixed by mocking `os.freemem`/`os.totalmem` in both directions rather than
      relying on the real host being "healthy"; re-verified clean across 3 consecutive full-suite runs
      afterward. `npm test`: 110 suites, exit 0.
- [x] **A blocked lease is a non-blocking refusal naming the holder, matching §20.2's spirit** — there is
      no in-process blocking wait to pause on (`acquireLease` is a synchronous check-and-claim in a
      multi-process daemon), so "pause, don't kill" is satisfied by the CALLER (not yet built —
      `git-create-push`) choosing to retry or surface `blockedBy` to a human rather than killing anything
      on a refusal. Nothing here kills a worker on a lease refusal; there is no code path that could.
- [x] **`host:heavy-job`'s memory-pressure check is BUILT, 2026-09-10** (PLAN.md §20.3) — reversing the
      "not built yet" note from earlier the same day. `os.freemem()`/`os.totalmem()` sampled on every
      `acquireLease('host:heavy-job')` call (not periodically while held — see below), refusing below
      the configured headroom and surfacing the sampled numbers in BOTH the grant and the refusal object
      (`{freeBytes, totalBytes, freePercent, headroomPercent}`), per §20.3's "a human sees the number,
      not just a refusal." **Not built**: periodic re-sampling of a lease already held (only the acquire
      moment is checked) — noted as open, not silently dropped.
- [x] **Per-task shared git worktree, with an explicit opt-out for isolated testing — BUILT 2026-09-10**
      (PLAN.md §7). `createTaskWorktree(taskId, { repoPath, branch })` (idempotent — a real `git worktree
      add`, `repoPath` caller-supplied since `tasks.repo_id` is unused with no registry to look it up),
      `discardTaskWorktree(taskId)` (refuses on a non-terminal task via `domain/task-states.js`'s
      `isTerminal`, else `git worktree remove` + clears `tasks.worktree_id`/`branch`), and
      `requestWorktree(runId, { reason })` (refuses with no `reason`; creates a SEPARATE overlay worktree
      off the task's current HEAD on branch `ctd-overlay/<taskId>/<runId>` — a top-level ref namespace,
      not nested under the task's own `ctd/<taskId>` branch, because git refs can't have a ref be both a
      leaf and a path segment; hit that collision once while building this). All three gated by one new
      capability `task:worktree`, granted to `worker`/`reviewer`/`cto` (owner has everything) — deliberately
      coarse: a worker can technically also create/discard the shared worktree, not just request its own
      overlay, documented as a tradeoff in `domain/capabilities.js` rather than split further. No schema
      addition was needed — confirmed 2026-09-10, `tasks.worktree_id`/`tasks.branch` already existed
      (migration 0001) and are already the live cwd a task's runs spawn into
      (`runtime/supervisor.js`'s `cwd ?? task.worktree_id`); this item was the *lifecycle*, not new fields.
      `requestWorktree`'s reason is written to `agent_journal` (§16's existing "task history, not memory"
      log — reused, not a new table), mirroring `grantApproval`'s own pattern of a second, human-readable
      journal entry alongside the wrapper's generic one; worth also surfacing to agentmemory/claude-mem
      where installed, per §2, as richer optional recall on top of the mandatory entry.
      **`merge` is NOT a supervisor command** — `mergeTask()` already explicitly does not touch git ("Merging
      code is the `git-create-push` agent's job"), so PLAN.md §7's "merge" lifecycle step is
      `git-create-push` operating inside the shared worktree after `mergeTask`'s approval-gated transition,
      not something built here. `sync` (rebase base updates into the shared worktree on request) is also not
      built yet — deferred, not forgotten.
      **CORRECTED 2026-09-11 — the non-terminal check above was not the safety backstop it looked like.**
      Both codex reviews (`codexdoc/REVIEW-NOTES.md`/`review-phase7-uncommitted.md` finding 4/3) found that
      task state and run termination are separate — `mergeTask`/cancel/fail transitions record the state
      change without stopping any run still using the tree — so a terminal task could still have an open run,
      and `discardTaskWorktree` would force-delete the dirty tree out from under it. **Fixed the same day**:
      `discardTaskWorktree` now also refuses when any run joined via `workers.task_id` has `ended_at IS NULL`,
      regardless of the task's own terminal state. Proven against the pre-fix code (`runtime/test/worktree.test.js`
      case 7 — terminal task + open run refuses; discard succeeds once the run ends). **Both remaining
      deferred items fixed 2026-09-11**: `createTaskWorktree` now claims the slot with a compare-and-swap
      (`WORKTREE_CLAIM_PENDING` marker, `BEGIN IMMEDIATE`) before running any git command — proven with a
      deterministic two-barrier real-process test (`worktree.test.js` case 10; the first, non-deterministic
      version, case 9, passed 3/3 times against the UNFIXED code, worth remembering); and
      `acquireLease`/`requestWorktree` now refuse a worker-backed principal's `runId` that resolves to a
      different worker (case 8 in both `leases.test.js` and `worktree.test.js`).
      Tests: `runtime/test/worktree.test.js`, 6 cases, real `git worktree add`/`remove` against a throwaway
      repo in `os.tmpdir()` (no mocked git) — idempotent create, discard refuses non-terminal / actually
      removes once terminal, requestWorktree refuses with no reason / creates a genuinely separate directory,
      capability+coverage wiring. `npm test`: exit 0, 107 suites (was 106; `domain/test/capabilities.test.js`
      also updated — its own allow-listed-domains assertion needed `"task"` added for `worker`/`reviewer`,
      the deliberate consequence of this capability grant, not a workaround).
- [x] **MCP server pooling — BUILT 2026-09-11** (PLAN.md §21.1). `runtime/mcp-pool.js` + migration 0013
      (`mcp_pool.status`/`.pgid`, new `mcp_pool_attachments` table — refcount DERIVED from attachment
      rows, not migration 0011's original bare integer, per `codexdoc/REVIEW-NOTES.md`'s explicit
      warning against exactly that). One resident process per `(name, config_hash)`, resurrected (same
      row) after a full drain rather than re-inserted. The last-detach-vs-new-attach race is closed by
      construction (attach only joins `starting`/`ready`, never `draining`) and proved 4 ways:
      deterministic interleaving, a real 8-process DB-primitive race, a 6-worker concurrent-async race
      of the full manager with real spawn/kill, and boot reconciliation killing a real orphan from a
      "previous boot." `leo-mcp` (§16.1) is the first real pooled config. `runtime/test/mcp-pool.test.js`,
      6 cases (a 7th and 8th added 2026-09-11 in the fix pass below). **Wired end-to-end 2026-09-11**:
      `start()` attaches a utility-task role to its declared pool(s) before spawning; `endRun`/
      `releaseSession`/boot reconciliation's `lost` path detach on the way out. 6 cases in
      `runtime/test/mcp-pool-wiring.test.js` (a real pool+attachment row after start; detach-on-end; a
      non-utility role untouched; two concurrent same-role runs sharing one pool row; a lost run's
      attachment cleaned up by reconciliation; an `adapter.start()` throw before a runId exists still
      detaching).
      **Corrected 2026-09-11, by an independent review (`codexdoc/review-luna-2026-09-11.md` finding
      2) — the wiring above briefly ALSO built `spec.mcpConfig` from the attachment and handed it to the
      real adapter. That was worse than "not yet shared": the adapter's own `StartSpec` typedef declares
      `mcpConfig` as `string | string[]` (a real config file path), so a non-string marker object would
      have been pushed into a real `spawn()`'s argv. `start()` no longer sets `spec.mcpConfig` at all —
      the attach/detach bookkeeping is real and tested; a worker getting an actual usable MCP connection
      from it is not, and won't be until `--mcp-config`'s real accepted value shapes are measured against
      the real CLI (leo-mcp's new socket transport, below, doesn't by itself answer that).**
      **SUPERSEDED 2026-09-14 (review-sol-2026-09-13.md finding 13, then review-consolidated-2026-09-14.md
      findings 1-2, 5-7, 12) — that measurement is now done, and delivery is real.** `claude mcp add-json
      --help` confirms `--mcp-config` accepts a real JSON string; `runtime/mcp-stdio-proxy.js` is the
      plain-stdio bridge to leo-mcp's socket this note said would still be needed. `mcp-pool.js`'s spawn
      path also got real readiness verification (a connect handshake + `isSocket()` check, not
      `existsSync` alone), a fixed concurrent-attach timing mismatch, confirmed-kill-before-drop-ownership
      teardown everywhere, and `chmod 0600` sockets. The delivered surface is bounded per role
      (`ROLE_MCP_TOOL_ALLOWLIST`, below) rather than the pool's whole tool catalog. `resume()` now
      re-attaches for a fresh generation instead of replaying a torn-down socket. Full detail in
      `HANDOFF.md`'s top header.
      **Two more real bugs fixed in the same pass**: `hashPoolConfig` used to hash only top-level key
      NAMES (a `JSON.stringify` replacer-array quirk), so two configs differing only in a nested `env`
      credential hashed identically — closed with a real recursive canonical stringifier
      (`mcp-pool.test.js` case 7). A dead pooled process used to leave its attachment row live forever,
      blocking a resurrected replacement's own teardown — `markPoolFailed` now closes every live
      attachment atomically with the failure write (`mcp-pool.test.js` case 8, a real killed child
      process). All four fixes verified to fail against the pre-fix code first.
- [x] **Lazy capability router — BUILT 2026-09-11, scope corrected by investigation** (PLAN.md §21.2).
      Checked first whether a harness-level "defer tool schemas" mechanism exists for a spawned worker
      session (modeled on this project's own deferred-tool pattern) — it does NOT: `worker-env.js`
      shows `spec.mcpConfig` (an explicit file list + `--strict-mcp-config`) is the only lever this
      codebase has, with no per-turn ask-for-it-by-name deferral available. Built what IS buildable
      given that ceiling: `domain/mcp-manifest.js`'s `manifestForRole` (pure, 4 cases) computes the
      MINIMAL `--mcp-config` set a role would need by declared pool name — narrower than "every
      configured server," honestly not per-turn lazy discovery. **Not wired into `spec.mcpConfig` at
      all** (corrected above alongside §21.1) — this module's output was briefly wired in, found to hand
      the adapter a malformed value, and removed; `manifestForRole` itself stays correct and tested, its
      integration point is just not `spec.mcpConfig` until a real config-value shape is measured.
      **SUPERSEDED 2026-09-14**: it is wired in now (see §21.1's own superseded note, above) — `start()`
      and `resume()` both resolve the manifest and build a real `spec.mcpConfig`. This module also now
      exports `ROLE_MCP_TOOL_ALLOWLIST` (review-consolidated-2026-09-14.md finding 1), a second bound this
      original design didn't anticipate: which of a pool's OWN tools reach the harness, not just which
      pool.
- [ ] Operation-intent-before-side-effect journals for every utility agent (append-only
      task-history log, checked before acting — "did I already file this ticket").
- [ ] slack-message agent posts as the bot only (PLAN.md section 14.5) — as-user
      posting stays backlog until `callerIdentity` genuinely exists to gate it.

## Phase 8 — CTO
- [ ] Typed commands first — every registry query/mutation expressible as a command
      *is* one; the model is invoked for routing and advice only (PLAN.md section 8,
      Rule 6).
- [ ] Cheap resident model by default (`cto` role in `harness-defaults.json`), with
      single-decision escalation to a stronger model rather than running high-effort
      resident all day.
- [x] Clear policies per role (PLAN.md section 8, Rule 5) — **SCHEMA done 2026-09-13 (item 39);
      DECISION LOGIC built 2026-09-14.** `domain/clear-policy.js` is the pure decision half (a
      `decideClear({clearPolicy, trigger, clearContextCapability})` function, unit-tested against all
      four policies × all four triggers), wired into `runtime/supervisor.js` at the REAL trigger call
      sites this runtime actually implements — found by reading the code, not invented:
      `on-state-transition`/`per-review-round` both fire from `approveTaskLocked`'s success path
      (the same moment it already regenerates a tier-3 handoff — Rule 5's own argument is that
      clearing is cheap BECAUSE that handoff exists), `on-state-transition` fires once more from
      `mergeTask`, and `always` fires from the pump's own `turn.end` event (verified first that a
      utility run is NOT structurally one-shot — nothing stops an operator calling `resume()`/
      `sendInput()` on one a second time, so this could not be skipped as already-satisfied).
      `on-demand` needed no automatic wiring — the `clearContext(runId)` wire command already IS
      "on demand". One deliberately-NOT-wired site, documented in place: `assignTask`'s own
      handoff-triggering transition always follows a brand-new spawn, so there is never anything to
      clear there. And one policy this runtime cannot yet trigger automatically: `per-review-round`'s
      OTHER half (a change-request round concluding) has no real event to hook, since nothing drives
      `awaiting-review` -> `fixing` automatically today — wiring it is future work once that
      transition itself exists, not a gap in this module. Every automatic clear call is fire-and-forget
      and gated on the target adapter's own `capabilities().clearContext`, never fatal to the
      transition/verdict/turn it is attached to. Verified: `domain/test/clear-policy.test.js` (8 pure
      cases) plus `runtime/test/clear-policy.test.js` (3 real-process wiring cases — a coder's and a
      reviewer's run genuinely cleared on approval, a bystander's unrelated run never touched, a
      utility run cleared on its own turn.end, a no-`clearContext`-capability harness never called at
      all); the wiring case was confirmed to fail (timeout) against the pre-wiring code before being
      restored. Full `npm test`: exit 0, twice in a row.
- [ ] Wire the "clean vs. kill" distinction (PLAN.md section 7) as an explicit rule the
      CTO follows, never inferred from a loose paraphrase.

## Phase 9 — Slack outbound
*(**The bridge now has its own build plan**: `../team-slack-bridge/PLAN.md`, written 2026-09-09, 682 lines. It
covers four surfaces over one core — direct CLI, MCP server, Claude Code skill, and this dashboard's
`slack-message` agent — plus a **locked-down remote profile**. Read it before starting this phase; it is where
the Slack-side decisions now live, and it was written against PLAN.md §14 so the two do not drift.)*
- [ ] Bot-only posting (PLAN.md section 14.5).
- [ ] `outbox` table consumer (PLAN.md section 3) with dedup + retry + failure
      isolation — not a direct synchronous call from the state machine.
- [ ] Task state transition to `approved`/`merged` posts a summary to a configured
      channel via `team-slack-bridge`.
- [ ] **The bridge must be idempotent, because this consumer retries.** Its plan §4.1 adds an
      `idempotencyKey` + local ledger for exactly this reason: without it, our retry is a duplicate-message
      generator. Same lesson as the assignment path — claim the key BEFORE the side effect.
- [ ] **Two separately-callable posting paths, never one function with a boolean.** Our capability vocabulary
      already has `slack:post-bot` and `slack:post-as-user`, and the second is in the SENSITIVE class needing a
      second signature. A capability that cannot be granted separately cannot be gated separately.
- [ ] **A `requests` row must carry `{channel, thread_ts}`** so an accepted review-request can be answered back
      into its originating thread. Open question 5 in the bridge's plan; confirm our schema records it and add
      it if not.

## Phase 10 — Obsidian vault projection
*(timing confirmed 2026-09-06: after the Phase 2 vertical slice. Wanted early for a picture
outside the terminal — graph view as team topology, a `Dashboard.md` status file, live orphans
listed beside it, off by default — but sequenced after the slice so the projector is not
rewritten while the workflow is still changing shape. See PLAN.md section 18.)*
- [ ] Read-only, strictly derived `vault-projector` (PLAN.md section 18) — basic tier:
      one file per team/task/worker with frontmatter + wikilinks.
- [ ] Confirm the non-negotiables: git-ignored, redacted before write, never inside a
      synced folder without explicit opt-in, fully disable-able.

## Phase 11 — Conservative harness onboarding
- [ ] Register pre-installed, versioned adapters that declare a capability matrix and
      pass the conformance suite (PLAN.md section 9) — no runtime adapter generation.
- [ ] Turn "onboard agy" into this repeatable registration flow (FLOWS.md diagram 4).
- [ ] **Spike, before committing: does ACP (Agent Client Protocol) replace bespoke per-harness
      adapters** (PLAN.md section 9, added 2026-09-10 after reviewing `hydra-acp`). Check whether
      either current harness speaks ACP today; if not, weigh a translation shim's cost against the two
      adapters it would replace. If it clears that bar, ACP is a *transport* — still registered and
      conformance-tested exactly per section 9, not a bypass of that model.

## Phase 12 — Release hardening
- [ ] Crash injection testing, migration testing, install/update/uninstall flows,
      permissions review, secret scanning across the database, event log, and any
      vault projection.
- [ ] Package as a Claude Code plugin (`marketplace.json`, `plugin.json`, skills,
      hooks, MCP server) bundling the supervisor + both harness adapters. **Packaging
      is a release gate here, not a first test** — Phase 0b already proved the
      daemon-layout model works; this phase hardens and ships it.
- [ ] Same artifact doubles as the open-source repo — no separate packaging step.

## Backlog — deferred, but architected for (do not build yet)

- **Slack inbound** — provisional, not settled architecture (marked so by the
  consolidated review, PLAN.md section 14 intro). Onboarding step (name + Slack handle
  + Jira handle -> `slack-config.json`, PLAN.md section 14.1), configurable watched
  channels, mentions creating a `requests` row (never auto-spawning, PLAN.md section
  14.2), the Requests panel UI (FLOWS.md 6a/6b), the two-gate self-DM exception
  (PLAN.md section 14.2). **Blocked on section 14.6's local DM-reading gate actually
  being fixed** — the originally specified password mechanism is mechanically
  non-functional (checks a pull path; Slack delivers via push) and must be replaced
  (OS credential store + explicit enablement + a foreground-unlock model, not a
  password that either blocks automation or proves nothing) before gate 2's auto-start
  can ship at all.
- **As-user Slack posting** — backlog until `callerIdentity` (PLAN.md section 14.5, an
  authenticated principal minted at ingress) actually exists. Naming a person in a
  request was never sufficient authorization; v1 ships bot-only.
- Slack message/thread query ("last 30 minutes," "show me the thread") — a read
  capability on the slack-message agent (PLAN.md section 14.3). Add as a method on the
  existing agent when actually prioritized.
- **Email integration agent** — same skeleton as Slack. Not started.
- **Google Drive integration agent** — same skeleton. Not started.
- **Microsoft OneDrive integration agent** — same skeleton. Not started.
- For all three above: add a row to `integrations` (PLAN.md section 16) when work
  actually begins — do not pre-create rows for integrations nobody's building yet.
- **Runtime harness adapter generation** (research-and-codegen for a brand-new CLI) —
  rejected for v1 on security-shape grounds (PLAN.md section 9: executing
  LLM-generated adapter code against a live supervisor with no review/sandbox/rollback
  step). Backlog until that story exists.
- **Full state-machine completeness** (`superseded`, `reopened`, `merge-rejected`, and
  the rest of a larger proposed state set) — deliberately deferred (PLAN.md section 6)
  until a real flow needs each one; adding all of them now would be schema for a
  system that can't run yet.
- Obsidian vault mid/advanced tiers (transcript notes, daily timelines, Kanban,
  presentation-field write-back) — PLAN.md section 18. Basic tier is Phase 10; the rest
  waits until the basic tier has earned it.

## Guardrails to re-check at every phase
- No autonomous merge, ever (Phase 5+, once task states include `approved`/`merged`).
- No drag-and-drop, no right-click — everything above should be reachable by keybinding
  or typed command (Phase 4+).
- No silent work — every task source (adhoc, direct-message, manager-direct, and
  Slack-originated sources if/when built) must land in the database the same way as
  CTO-routed work, starting with Phase 2's vertical slice.
- No scope creep on the global utility agents (Phase 7) — fixed toolsets, capability-
  based authorization, never guess an underspecified task.
- **The file-digest cache never serves as an edit basis** (PLAN.md section 8, Rule 3) —
  re-read the real file immediately before every Edit/Write, no exceptions, from
  whichever phase first introduces the cache.
- **No agent ever reads tier-1 raw events** (PLAN.md section 8, Rule 4) — only tier-2
  digests and tier-3 handoff docs cross a worker boundary. This is what keeps the CTO's
  context from exploding once more than a couple of workers are running.
- Don't let a phase's design assumptions outrun what's actually been proven — Phase 0b
  exists specifically to stop that from happening again, this time for the whole
  runtime rather than one adapter.
