# Custom Team Dashboard — Design Plan

Status: brainstorm, not yet built. This document is the consolidated record of the design
discussion. Nothing here is implemented yet — see ROADMAP.md for build order.

**Revised 2026-09-04 after a consolidated review of four independent AI architecture
reviews** (two review rounds, four models across two harnesses; full text archived in
`arch-reviews-now-not-needed/` — their findings are incorporated below, kept for
reference rather than because anything in them is still outstanding).
The product-design decisions below — clean-vs-kill, no-autonomous-merge,
integrations-as-data, explicit-beats-inferred, the Slack demotion — all survive
**verbatim**; all four reviews independently endorsed them. What did not survive: the
file-backed JSON registry (section 3, below) and the assumption that a "spawn adapter"
and "pane rendering" were minor implementation details. They were the two largest
undesigned load-bearing gaps in the whole plan. This revision replaces the registry
with a supervised runtime (SQLite + a single-writer supervisor + a control-plane
socket) and adds two new architectural pillars — context economy (section 8) and
configurable reviews (section 13) — that no review round surfaced until asked for
explicitly by the author mid-review.

## 1. Problem

Managing 9-10+ concurrent Claude Code / OpenCode sessions across a virtual "team" of
named agents (leads, coders, reviewers, QA) with no single place to see who is doing
what, no shared memory across sessions, and no fast way to jump between them.

**Non-functional targets** (absent from the original plan; all reviews noted this):
CTO steady-state context under ~15k tokens; turn digest ≤150 tokens; task handoff doc
≤1200 tokens; tier-1 raw event retention ~10 MB/session, rotating; target 10 concurrent
sessions on a 16 GB machine.

## 2. Core concepts

- **Team** — a named group of workers with a lead, working on one project/initiative
  (e.g. "Vite Migration", "Biome Lint"). Subteams were named in earlier drafts and never
  designed — **removed from v1**; revisit only if a real need appears.
- **Worker** — a durable identity: nickname, role (lead, coder, reviewer, qa), team.
  Survives context clears and respawns. Distinct from a **run** (see section 3) — the
  worker "Purus" persists across many runs over its lifetime.
- **Task** — the unit of work. Keyed by ticket/slug, not by MR number (MR numbers don't
  exist yet at plan time, and one ticket spans multiple sessions over its lifetime).
  Has a type (dev / review / adhoc), a state (section 6), and an owning repo/worktree
  (section 3) — a `cwd` string alone is not identity.
- **Harness** — the underlying CLI/tool a run executes on (Claude Code, OpenCode, or a
  future one), described by a **capability matrix**, not assumed to behave identically
  to any other harness — see section 9.
- **Supervisor** — a single, long-lived local daemon that owns every managed process:
  argv/cwd/env, the process group, output capture, and lifecycle. It is the only writer
  to the database and the only thing that starts a harness process. Nothing else spawns
  a session directly. See section 3–4 for what it owns and how it's reached.
- **CTO agent** — the top-level coordinator, always resident behind the bottom chat bar.
  Routes work, gives advice (e.g. "clear that session, no need of previous context"),
  and can pick up a small task itself (`source: "manager-direct"`). It is a client of
  the supervisor like everything else — it has no direct database access and no
  standing git/Jira/Slack tool access (section 16). Deterministic roster operations
  (move a worker, rename, pin main, hide a team) are **typed supervisor commands**, not
  a separate agent it delegates to — see section 16's note on this.
- **Memory (claude-mem / agentmemory), optional** — any worker, agent, or global
  utility agent *may* use claude-mem/agentmemory for richer recall, but the plugin core
  never depends on it being present (section 19). When it is used, recall must be
  scoped by **task + worktree together**, not just task — the same ticket can have
  multiple worktrees over time (a fix branch is not the same context as the original
  implementation branch), and answering from the wrong one is exactly the kind of
  cross-contamination that produces a confidently wrong decision. This is a stricter
  scope than the append-only task-history log the global utility agents keep (section
  15) — that log is mandatory and minimal; claude-mem/agentmemory is optional and richer,
  layered on top for whoever chooses to use it.

## 3. Data model & persistence

**The file-backed JSON registry from the original draft is rejected — unanimously, by
every review.** Ten-plus processes (hooks, the supervisor, the CTO, the TUI) writing
concurrently to shared JSON files has no locking, no atomicity, no revisions, and no
recovery story; it will tear on day one, not eventually. This is not a style
preference — it changes what "source of truth" means throughout the rest of this
document. It does **not** change the single-user/local-only architecture (section 15,
17) at all: SQLite is still one file, on one machine, owned by one process.

**Replacement: SQLite (WAL mode), one single-writer supervisor process, one control
socket.** The database is *persistence*. The socket is *messaging*. Confusing the two
was the original design's second-largest hole (no review round separated them either,
until the consolidated pass): a registry that only stores state cannot deliver a
prompt, a cancel, a clear, an approval response, or an ask-reply. Both are required,
and neither substitutes for the other.

```
schema_version(version)

harnesses(id, display_name, heartbeat_mechanism, config_path, status,
          capabilities_json, onboarded_at)
  -- capabilities_json: { residentProcess, resumableTurns, structuredOutput,
  --   interrupt, clearContext, approvalProtocol, modelDiscovery }
  -- see section 9 — a harness's capabilities are declared, never assumed identical

teams(id, name, hidden_from_top_bar)
  -- membership is derived from workers.team_id, never duplicated (§C.9 of the review)

workers(worker_id, nickname, role, team_id, task_id, status, cwd, revision)
  -- durable identity — survives clear/respawn. status: running | idle | blocked |
  -- finished (derived from run + heartbeat observations, never asserted directly —
  -- see section 4's reconciliation rule)

runs(run_id, worker_id, harness_id, harness_session_id, pid, process_group,
     generation, started_at, ended_at, exit_reason, lifecycle, reaped_at)
  -- one immutable process generation. EVERY heartbeat, event, and command carries
  -- run_id, not worker_id. This one rule is what prevents a late heartbeat from a
  -- killed process overwriting the status of the run that replaced it — the schema
  -- literally cannot express that bug once run_id is the join key.

tasks(id, title, aliases_json, team_id, type, state, main_worker_id, source,
      repo_id, worktree_id, branch, base_rev, harness_assignments_json,
      created_at, updated_at, merged_at, revision)
  -- repoId/worktreeId/branch/baseRev replace a bare `cwd` string as task identity —
  -- multiple sessions on one repo need this to not collide.

asks(id, run_id, task_id, question, answer, answered_by, delivered_at, resolved,
     created_at)
  -- see section 7 — this is the approval control plane, not a notification nicety.
  -- Persist the answer before marking resolved, always.

requests(id, type, channel, mentioned_handle, raw_text, slack_permalink, posted_by,
         status, linked_task_id, created_at, updated_at)
  -- Slack inbound only — backlog, see section 14.2 and ROADMAP.

integrations(id, status)
  -- not-configured | configured | active. Ships EMPTY and versioned in Phase 1 of
  -- ROADMAP — rows are added when work on that integration actually begins, never
  -- pre-created. Reconciles the earlier draft's conflict between "referenced
  -- everywhere" and "absent from the schema."

event_log(seq, run_id, tier, type, payload_json, ts)
  -- tier 1 (raw) / tier 2 (turn digest) / tier 3 (task handoff) — see section 8.
  -- Monotonic seq per run. Bounded, rotating. No agent ever reads tier 1 — see
  -- section 8's hard rule.

transition_journal(id, task_id, from_state, to_state, actor, at)
orphan_sightings(id, run_id, seen_at, pid, process_group, proc_lstart, kind, note)
  -- one row every time reconciliation observes a run's process alive with no adapter
  -- handle (migration 0003). A JOURNAL, never state: `runs.lifecycle` is the state, and
  -- nothing reads this table back as truth. It exists so "we keep getting orphans
  -- lately" is a query with a history behind it, and so a future watcher process has
  -- something to reason about rather than a single snapshot.
outbox(id, event_type, payload_json, delivered, created_at)
  -- append-only audit trail + the basis for Slack outbound (section 14.1) and any
  -- future integration that needs "notify me when X changes" without polling.

review_profiles(id, config_json)
review_verdicts(id, task_id, worker_id, slot, round, commit_sha, dimension,
                verdict, findings_json, at)
  -- see section 13 — revision-bound, per-dimension, not a single mutable verdict.
```

**Identity split (adopted verbatim from the strongest single contribution across all
four reviews):** `workerId` (durable — survives clear/respawn) / `runId` (one process
generation) / `harnessSessionId` (the harness's own conversation identity) are three
different things and the schema keeps them separate. Collapsing them was the original
draft's `sessions.json` design, and it cannot express "the same worker, respawned" or
"which specific process generation sent this heartbeat" — both matter once ten workers
are running concurrently and any one of them can die and restart.

**Gap found by the spike-0b code review (2026-09-05,
`consolidated-review-claudeopus5-medium--spike-0b.md`, finding S4) — this three-way
split assumes one OS process backs one `runId`, and that's false for at least one
harness.** `opencode serve` is pooled per-cwd and multiplexes many logical sessions
through a single process, so every run sharing that server ends up with the *same*
pid/pgid/lstart — the identity model has no way to distinguish them, which breaks both
reconciliation (can't tell runs apart) and any future per-run kill (would kill every
sibling sharing that server). **Resolution: for server-backed harnesses, `runId`
resolves to a two-level identity, `{ serverPid, sessionId }`, verified independently at
each level** — the server's own liveness (PID/pgid/lstart, as already designed), and
separately whether that server still recognizes this specific session (a liveness
probe against the harness's own API, e.g. `GET /session/{id}` for OpenCode). Resident
single-process-per-run harnesses (Claude Code, as currently proven) don't need the
second level at all — this is additive per-harness, declared via the capability
matrix, not a change to the model for harnesses that don't need it. Land this before
Phase 1 writes reconciliation code against the one-process-per-run assumption.

**JSON files still exist — as exports, never as truth.** Anything that benefits from a
flat file (the Obsidian vault projection, section 18; a debug dump) is generated *from*
SQLite by a one-way projector. Nothing reads a JSON file back as authoritative state.

**One explicit exception, stated here so it doesn't read as a contradiction elsewhere:
user-authored input config is read directly, not exported.** `harness-defaults.json`
(section 11), `slack-config.json` (section 14.1), and `review-profiles.json` (section
12) are files a human edits by hand — they are input, not runtime state, so "SQLite is
the only truth" doesn't apply to them the way it applies to `workers`/`runs`/`tasks`.
Two different shapes, so the schema above isn't inconsistent about which is which:
- `review-profiles.json` is imported into the `review_profiles` table on supervisor
  startup/file-change (that table exists specifically to hold it) — SQLite is truth
  for *that copy* once imported, and re-editing the JSON re-imports it.
- `harness-defaults.json` and `slack-config.json` have no corresponding table and are
  read straight from disk by the supervisor at startup or on-demand — they're
  low-write-contention config, not multi-writer runtime state, so there's no torn-write
  risk the SQLite move was solving for in the first place.

`asks` entries, in full:
```jsonc
{ "id": "ask_001", "runId": "run_purus_04", "taskId": "vite-migrate-checkout-app",
  "question": "...", "answer": null, "answeredBy": null, "deliveredAt": null,
  "resolved": false, "createdAt": "<iso-timestamp>" }
```

## 4. Control plane & runtime

The supervisor is one long-lived local daemon. Everything else — the TUI, the CTO
agent, hooks, global utility agents — is a **client** of it, over a Unix domain socket
at a fixed per-user path, speaking newline-delimited JSON requests/responses plus a
subscribe channel for streamed events. This is the single authoritative command path
for every mutation; nothing else talks to SQLite directly.

**Per-harness adapter contract** (implementations differ; the interface doesn't
promise uniformity it can't deliver):
```
start(spec) -> runId
sendInput(runId, input) -> void
observe(runId) -> AsyncIterable<Event>      // subscribe to this run's output
interrupt(runId) -> void
clearContext(runId) -> ack                   // may mean different things per harness —
                                              -- Phase 0b must prove both, not assume
resume(runId) -> runId | unsupported         // only if capabilities.resumableTurns
stop(runId) -> void
```

The supervisor launches each harness process with explicit argv/cwd/env — never shell
interpolation — owns its process group, assigns the durable `runId`, captures output,
and emits normalized lifecycle events into `event_log`. Claude Code and OpenCode may
differ internally (flags, model selection, resume behavior, output format); those
differences stay inside each adapter and are declared via the `capabilities_json`
column on `harnesses`, never assumed identical by callers. Do not promise session
resumption in the shared interface unless both harnesses actually support it.

**Proven per-harness reality (Phase 0b spike, 2026-09-04 — see
`spike-0b/claude-code-adapter/` and `spike-0b/opencode-adapter/` for full evidence).
This replaces every assumption above with what's actually true:**

- **Claude Code**: non-interactive via `-p --output-format stream-json --input-format
  stream-json --include-partial-messages`. Genuine incremental streaming
  (`text_delta`/`tool_use`/`tool_result`). Multi-turn via a **resident process** kept
  alive on stdin (preferred) or cross-process `--resume <session_id>`. `interrupt` is a
  `{"type":"control_request","request":{"subtype":"interrupt"}}` stdin message — plain
  **SIGINT kills the whole process**, it is not a usable interrupt. `clearContext` has
  no in-place operation — sending `/clear` mints a brand-new `session_id` (the old one
  is permanently stale) but can be sent to an already-resident process, no new OS spawn
  needed. cwd isolation is via `spawn(cmd, args, {cwd})`, not a CLI flag. Exit code
  alone cannot distinguish outcomes (interrupt also exits 0) — read `terminal_reason`/
  `is_error`/`api_error_status` from the final `result` record.
- **OpenCode**: has **two non-interactive tiers that are not interchangeable — this is
  the single most important finding of the spike.** The one-shot CLI (`opencode run
  --format json`) gives batched, not streamed, output, and has **no working
  interrupt** (`SIGINT` is silently swallowed and the turn completes anyway; `SIGTERM`
  kills it with zero salvageable output). All three of streaming, clean interrupt, and
  programmatic approval **only work through the resident `opencode serve` HTTP+SSE
  server** — the supervisor's OpenCode adapter must always run `serve`, never spawn
  `run` per turn, or it silently loses streaming/interrupt/approval with no error
  telling you so. Through `serve`: true per-token streaming (SSE
  `message.part.delta`), multi-turn via `--session`/same-session reprompt, clean
  interrupt via `POST /session/{id}/abort`, cwd isolation via `--dir` (CLI) or
  spawn-time cwd (`serve`). `clearContext` has no true analog either — the closest,
  `/session/{id}/summarize`, compacts history into a summary but does not erase it;
  old messages stay listable.
- **The approval protocol is not just different in mechanism between the two
  harnesses — it is a different *shape* of protocol, and every design assuming a
  single `approval.request` → `answerApproval(runId, decision)` pattern across both
  harnesses is wrong for at least one of them:**
  - **Claude Code = synchronous callback.** The only mechanism is a **PreToolUse
    hook** — a subprocess that runs per tool call and must return its allow/deny
    decision *before the tool call proceeds*. There is no "event fires, something
    answers it whenever" primitive — headless prompts auto-deny by default with no
    hang and no callback for deferred answering. To route this to a human, the hook
    subprocess itself must block on a synchronous call out to the supervisor (e.g. its
    own HTTP long-poll) and wait for the answer before returning. **The thing that
    waits is the hook process, not the run.**
  - **OpenCode = genuine async event, but only via `serve`.** A `permission.asked` SSE
    event actually pauses tool execution and is answered later via a separate call
    (`POST /session/{id}/permissions/{id}`) — proven twice (raw curl and through the
    adapter). This is the shape the original design assumed — and it's only true for
    one of the two harnesses.
  - **Practical consequence**: the `asks` table/UI (section 7) must support both
    shapes. For OpenCode, an `ask` row can sit `pending` indefinitely, exactly as
    designed. For Claude Code, the PreToolUse hook process is *itself* the thing
    blocking — the supervisor's hook-side code must resolve the decision synchronously
    (poll or long-poll its own control channel) rather than assume it can create an
    `ask` row and walk away. Document this per-adapter, don't paper over it with one
    shared description.
- **Capability matrix, filled in with proven values** (not the placeholder shape from
  the original draft):
  ```
  claude-code: { residentProcess: true, resumableTurns: true (cross-process resume,
    or same-process follow-up), structuredOutput: true, interrupt: "control-request"
    (NOT SIGINT), clearContext: "new-session-id" (no true in-place clear),
    approvalProtocol: "sync-hook-callback", modelDiscovery: true }
  opencode:    { residentProcess: true (serve mode only — one-shot CLI is a degraded
    path, see above), resumableTurns: true, structuredOutput: true (serve only),
    interrupt: "http-abort" (serve only; SIGINT/SIGTERM unusable on one-shot CLI),
    clearContext: "summarize-only" (compacts, does not erase),
    approvalProtocol: "async-event" (serve only), modelDiscovery: true }
  ```

**Ownership vs. packaging.** A supervisor is a resident daemon with a socket and a PID
file; a Claude Code plugin contributes hooks/skills/an MCP server, all short-lived,
invoked by a host process. These are in tension and nobody in the original draft
resolved who starts the supervisor, who restarts it after a crash or reboot, or what
happens if two dashboards launch at once. **Resolution: a single-instance lock file,
lazy-started by the first client that needs it.** No launchd job, no background
surprise, and "nothing is running" is the correct degraded state when nobody's using
the dashboard. The plugin is a *client bundle* around a daemon, not a pure plugin —
worth stating plainly rather than letting section 17 imply otherwise.

**Mock harness — built and proven (`spike-0b/mock-harness/`, 2026-09-04).** Implements
the full adapter contract with deterministic per-prompt event replay (50-150ms delta
pacing, not synchronous), isolated per-run state, and a working `answerApproval`. Two
concurrent runs proven genuinely interleaved with real captured output, not sequential.
Deliberately **more capable than either real adapter** — full `resume` support with no
caveats — specifically so Phase 4's TUI can be built against the ideal case and degrade
gracefully once it's wired to real harnesses; its own README says so explicitly, so
nobody mistakes its behavior for a promise about Claude Code or OpenCode.

**Spawn recursion guard.** A worker's process can itself spawn subagents, or — worse —
re-invoke the dashboard's own spawn path and create runs the supervisor half-knows
about. Set a `DASHBOARD_SPAWN_DEPTH` env var on every managed process; hard cap at 1 for
dashboard-managed runs; in-harness subagents are never promoted to registry rows. Cheap
to add now, unpleasant to retrofit once it's happened once.

**Startup reconciliation (the reconciliation rule) — now proven with real crash tests,
and it has three outcomes, not two.** `status` on a `workers`/`runs` row is never
asserted directly — it's derived, and on supervisor startup that derivation must be
re-verified rather than trusted from before the restart. Concretely: for every `runs`
row not already terminal, verify PID + process group + start time actually match a
live process. **"Not already terminal" means `ended_at IS NULL`** — which, since
migration 0003, deliberately includes rows marked `lifecycle = 'orphaned-unmanaged'`
(see that bullet below), so a live unmanaged process is re-examined on every boot
instead of being examined exactly once and then forgotten. Phase 0b's supervisor-integration spike (`spike-0b/supervisor-integration/`,
2026-09-04) proved this needs a genuine **third** bucket, discovered while testing, not
designed in advance:
- **`lost`** — the process is actually gone (verification fails outright). Proven with
  a real Claude Code run: its child process dies on its own once the supervisor that
  held its stdin pipe is `kill -9`'d.
- **`orphaned-unmanaged`** — the process is verified *still alive* (PID + start time
  match), but no adapter handle is bound to it anymore. Proven with a real OpenCode
  run: `opencode serve` is an HTTP server, not a stdin-attached process, so it survives
  its parent supervisor dying — reconciliation must not conflate "still running" with
  "still ours." Treating this as `lost` would be dishonest (it's not gone); treating it
  as `finished` would be worse (it's not done, and nobody's watching it either).
  **This one is a lifecycle STATE, not a terminal outcome** (migration 0003, decided
  2026-09-06 after Group 6): it is written to `runs.lifecycle` and the row keeps
  `ended_at IS NULL`, because the process has not ended. Its terminal write comes later,
  when something real happens — `lost` once the process dies, `reaped` once we kill it
  (`runs.reaped_at` records that we were the cause). Originally this *was* written as
  `ended_at` + `exit_reason`, and Group 6's daemon-crash test showed what that cost: a
  closed row is invisible to reconciliation's own input set, so a live unmanaged process
  was examined once, closed, and then never mentioned again by any later boot — while
  still consuming CPU and tokens, and while silently dropping out of the shared-process-group
  refusal that protects pooled `opencode serve` siblings. Every sighting also appends to
  `orphan_sightings` (a journal, never state), so "we keep getting orphans lately" is a
  query, and `supervisor.orphans()` lists the live ones by title, pid and age.
- **`finished`** — only ever set by the adapter's own normal completion path, never by
  reconciliation. Reconciliation's job is to catch everything that *isn't* this.

Any row landing in `lost` or `orphaned-unmanaged` closes its open `asks` and surfaces
in the TUI rather than looking like ordinary completion — an unmanaged run cannot answer
its own question, so leaving the ask open blocks a task forever. This runs before any
lifecycle status is trusted anywhere else in the system.

**Every terminal path deals with asks, and they are deliberately not identical** (migration
0003; before it, only reconciliation and `reap` touched `asks` at all, and a normally
finished run left its unanswered question open forever):

- **the run ended by itself** (`finished` / `errored` / `interrupted`) — its unanswered asks
  get a **five-minute grace** (`asks.auto_close_at`) and stay answerable, because a run
  finishing does not mean the human who was asked has walked away. A sweep closes them
  afterwards as `supervisor:auto-close`, distinguishable from a human answer; an answer that
  lands during the grace wins outright. The deadline is *persisted*, not an in-memory timer,
  and `boot()` sweeps — a supervisor that crashes mid-grace must not strand the ask, which is
  the same failure this replaces.
- **we ended it deliberately** (`stop` / `reap`) or **reconciliation derived it**
  (`lost` / `orphaned-unmanaged`) — asks close immediately. A human is already acting, or
  nothing is left that could answer. Note the decision is made on the *reason*, not on which
  code path wrote the row: killing a run ends its adapter stream, so the terminal write
  frequently comes from the event pump's completion hook carrying the deliberate intent.

**Gap closed in Group 5** (was: "neither adapter currently spawns its child detached with
the supervisor owning the process group"). Both adapters now spawn through
`supervisor/runtime/spawn.js` with `detached: true`, and ownership is *verified* — the
child's pgid is read back from the OS and must equal its own pid, or the child is killed
and the spawn rejected. On top of that ownership sit the two things that make
`orphaned-unmanaged` actionable rather than merely honest: a real `reap` (verify
pid + pgid + start time, then kill the process group) and `harnessOf` routing rehydrated
from persisted rows on boot, so a run created before a restart can still be acted on.

Two refusals to kill are part of the contract, not caveats: a start-time mismatch means
pid reuse (`lost`, kill nothing), and a process group shared with another open run — the
pooled `opencode serve` case — is never group-killed, only session-ended. See
`supervisor/runtime/FINDINGS.md` for mechanisms and the mutation evidence behind each.

## 5. Pane rendering & layout

**Pane transport is settled: normalized event transcripts, not a terminal passthrough.**
The original draft left this as an open decision; it is not a paper choice, and the
argument that settles it is one no review round made explicitly: **the CTO has to read
the panes.** Section 2 and section 7 require the coordinator to reason about what its
team is doing and to surface blocked workers machine-legibly (`asks`). A framebuffer of
ANSI cells is the wrong substrate for that; a sequenced event log (`assistant.delta`,
`tool.start`, `tool.result`, `approval.request`, `turn.end`) is exactly right — and per
section 8, it's the only substrate on which context economy is achievable at all.
Claude Code already emits structured streaming output; screen-scraping a terminal that
offers a documented event stream would be strictly worse.

- **Primary adapter**: normalized event transcripts, replayed by cursor when a pane is
  switched to, subscribed live thereafter. Approval prompts are a first-class event
  type (`approval.request`) with a typed response routed back over the control socket
  — this is what makes interactive input actually work without a terminal.
- **Degraded adapter**: `node-pty` + a terminal parser, for a harness with no
  structured output at all — this is the `wrapper` tier defined in section 9, extended
  here to cover pane output as well as liveness/heartbeat.
- **tmux is not core transport.** Rejected: a hard external runtime dependency, opaque
  process ownership, no programmatic replay. Acceptable only as an optional manual
  debug-attach, never as how panes render by default.
- **Cost, stated honestly**: panes will not look pixel-identical to a native CLI —
  messages, tool calls, diffs, and approvals are rendered, not passed through. That's
  the right trade because the alternative produces a pretty pane the rest of the system
  (the CTO, in particular) can't reason about.

```
+- TEAMS (online) --------------------------------------------- <- -> -+
|  [Vite Migration]  [Biome Lint]  [Stripe Fix]  [Checkout] ...       |
+-----------+-----------------------------------------------------------+
| TREE 15%  |  PANE AREA                                               |
| > team    |  +-------------------+---------------------------+      |
|   lead    |  |  DEV PANE          |  REVIEW PANE (toggleable) |      |
|   |-dev   |  |  (last-active dev  |  Parent reviewer or       |      |
|   |-rev1  |  |   session, or      |  Reviewer 1 / Reviewer 2  |      |
|   `-rev2  |  |   pinned "main")   |  (pick via bottom toggle) |      |
|           |  +-------------------+---------------------------+      |
+-----------+-----------------------------------------------------------+
| [1] rev1  [2] rev2  [p] parent-rev  [r] all-rev  [f] fullscreen      |
| [g] group/split   [h/l] switch team   [d] direct-chat  [/] focus chat|
+-------------------------------------------------------------------------+
| > (CTO chat -- always resident)                                       |
+-------------------------------------------------------------------------+
```

**Team↔task cardinality**: a team has *many* tasks, not one. "Click a team" resolves to
a selected task within it (the tree should show task nodes, not just members), not "the
one task this team is doing" — the original layout implied the latter and it doesn't
hold once a team has more than one thing in flight.

Click behavior:
- Click a **worker** -> opens their pane directly.
- Click a **task node** -> smart default from task type: dev task shows last-active dev
  run (by most-recent-message, unless pinned); review task shows dev pane + one
  reviewer pane.
- Click a worker, then press `m` -> pins its run as `mainWorkerId` for that task
  (overrides the most-recent-message default until unpinned).

## 6. Task state machine

```
created -> starting -> planning -> implementing -> awaiting-review -> fixing -> approved -> merged
              |                          |
              v                          v
         start-failed                blocked  (only implementing generates an ask)

planning / implementing / awaiting-review / fixing -> failed     (a run can error at any in-flight state)
planning / implementing / awaiting-review / fixing -> cancelled  (an explicit stop can happen at any in-flight state)
```

- `created` — the task row exists; no run has been spawned yet (section 11).
- `starting` — spawn requested; not yet confirmed live. **This state did not exist in
  the original draft**, which had no way to represent "we tried to start this and don't
  know yet" — every review flagged the state machine as having no failure states.
- `start-failed` — the adapter reported a spawn failure (bad cwd, harness not found,
  resource limit). Surfaced to the human, not silently retried.
- `blocked` — an unresolved `ask` exists for this task's active run. Enters
  automatically when an `ask` is created (section 7), clears automatically when
  answered. **Only reachable from `implementing`** — planning and awaiting-review are
  human/CTO-paced states that don't generate approval-style asks the same way an
  actively-working run does; if that assumption turns out wrong once real usage exists,
  widen it then rather than pre-designing for a case with no evidence yet.
- `failed` / `cancelled` — terminal-ish states for a run that errored out or was
  explicitly stopped. Unlike `blocked`, these are reachable from **any** in-flight
  state (`planning`, `implementing`, `awaiting-review`, `fixing`) — a run can crash
  during planning just as easily as during implementation, and an explicit cancel can
  happen at any point a human decides to stop. Both can transition back to `created`
  (a fresh attempt) via an explicit human/CTO action, never automatically.
- `awaiting-review` requires N reviewer verdicts (default 2 + optional parent) before
  advancing — see section 13 for how verdicts are now scoped (revision-bound,
  per-dimension) rather than a single mutable field.
- `merged` requires an explicit human/senior approval gate — **no autonomous merges**,
  even with all reviews green. This is a hard rule, not a default that can be silently
  skipped.

**Deliberately not adding yet**: `superseded`, `reopened`, `merge-rejected`. One review
round's completeness pass proposed nine additional states; correct in isolation, but
adopting all of them before a runtime exists to test any of them produces a large
schema for a system that cannot run. Add the rest only when a real flow needs them —
sequencing matters more than completeness at this stage.

Every transition needs a named actor and a guard, recorded in `transition_journal`
(section 3) — not just a diagram edge. This is also what makes double-transitions from
a duplicate hook or a retried command detectable: check the journal before applying,
not after.

## 7. Session lifecycle & escalation rules

- **"Clean yourself"** (ambiguous casual phrasing) always means a **soft context
  clear** — worker identity and its task assignment persist, anything already written
  to agentmemory/claude-mem survives, only in-head conversation resets. `clearContext`
  is a real, tested adapter capability per harness (section 4), and Phase 0b proved
  it means genuinely different things: on Claude Code, sending `/clear` mints a brand
  new `session_id` (the old one is permanently stale, though no new OS process is
  needed if the run is already resident); on OpenCode, there's no true in-place clear
  at all — the closest operation (`/session/{id}/summarize`) compacts history into a
  summary but old messages stay listable, they're not erased. "Clear" is not one
  operation with two implementations — it's two different actual behaviors, and the UI
  should not imply otherwise.
- **Kill + respawn** (destructive — loses anything not yet persisted) only happens on
  an explicit, unambiguous instruction (e.g. "kill and restart Purus"), never inferred
  from a loose paraphrase.
- **Hiding a team/session** from the top bar (via chat, e.g. "hide Vite Migration") is a
  view filter only — `hiddenFromTopBar: true` — never a delete.
- **Escalation ("ask") is the approval control plane, not a notification nicety — this
  is the single most consequential correction in this revision.** Every review found
  that a headless coding session hits a tool-permission decision within minutes, and
  the original draft scheduled `asks` at ROADMAP Phase 9, six phases after workers that
  would already be blocked on it. `asks` now belongs in the first vertical slice
  (ROADMAP Phase 2), not deferred. A worker blocked or needing input writes an `ask` row
  (section 3: `id`, `runId`, `question`, `answer`, `answeredBy`, `deliveredAt`,
  `resolved`) instead of stalling silently; the task's state flips to `blocked`
  (section 6); the tree UI shows a badge; CTO/lead answers over the control socket,
  which persists the answer *before* marking resolved (ordering matters — a crash
  between those two steps must not lose the answer).
  **Phase 0b proved the two harnesses need this handled differently, not identically
  (section 4):** on OpenCode, a `permission.asked` event genuinely pauses and an `ask`
  row can sit `pending` indefinitely exactly as designed above. On Claude Code, there
  is no such event — the only mechanism is a PreToolUse hook subprocess that must
  itself resolve the decision *before returning*, so the supervisor's Claude Code
  adapter has to make that hook synchronously poll/long-poll the control socket for an
  answer rather than assume it can write a pending `ask` row and move on. Same `asks`
  table, same UI, different plumbing underneath per adapter.
- **Manager-direct**: the CTO can pick up a small task itself instead of delegating,
  and logs it the same way (`source: "manager-direct"`). No work happens outside the
  database, regardless of who did it or how it was triggered.

## 8. Context economy & token architecture

**This is a missing architectural pillar in the original draft, not an optimization to
add later — no review round named it until asked for explicitly.** The dashboard's
actual value proposition is that real work happens in a worker whose context stays
clean; everything that would pollute that context — plumbing, retries, re-reads, raw
transcripts — has to live somewhere else by construction, not by discipline.

**Rule 1 — one job per worker; the worker doing the job never does the plumbing.** A
coder writes code. It does not run the push, fight lint, open the MR, or file the
ticket — those leave as typed commands with structured results (section 16), not as
conversation. This is section 16's real justification, stated in the right order:
context economy first, auditability second.

**Rule 2 — the fight-loop belongs to the agent that owns the tool.** The
`git-create-push` agent's contract:
```ts
push(taskId, runId, worktreeId, intent): {
  status: 'pushed' | 'blocked' | 'failed',
  mrUrl?: string,
  attempts: Attempt[],              // internal — never returned to the caller's context
  unresolved?: { class: FailureClass, oneParagraphDiagnosis: string, files: string[] }
}
```
It owns the whole loop: stage -> commit -> pre-commit hooks -> on failure, classify
(`format` | `lint-autofixable` | `lint-semantic` | `typecheck` | `test` | `hook-other` |
`conflict` | `protected-branch`) -> auto-fix **only** the mechanically fixable classes,
bounded at N attempts -> re-run. Anything semantic returns as one paragraph plus a file
list, never as raw tool output — the coder receives five lines where it would otherwise
receive four hundred. This requires the agent to hold real `git` access, not only
`gh`/`glab` (the original section 16 roster under-scoped this), plus a hard scope check
— repo root, expected branch, task-owned worktree, intended file set — before staging
anything.

**Rule 3 — a file-digest cache, with one inviolable rule.** Ten workers on one repo
re-reading the same twenty files is pure waste; serving a *cached copy* as the basis for
an edit produces confidently wrong diffs, which cost far more than the tokens saved.
```
file_digest(repoId, path, mtime, size, sha256, summary, symbolMap, lastReadBy, lastReadAt)
```
Workers call `describe(repoId, path)` for cheap orientation (summary + symbol map).
**Inviolable: the cache serves orientation, never an edit basis** — immediately before
an Edit/Write, the real file is re-read. This is a guardrail (section 19), not a
suggestion. Invalidation: `mtime`+`size` verified by hash, plus any `tool.result` event
showing a write to that path, plus a git HEAD change in that worktree. Lives in the
supervisor's own SQLite, not in claude-mem — a token-savings layer that only works when
an optional plugin happens to be installed would violate section 2's rule that
claude-mem/agentmemory is never a hard dependency. Honest expectation: the win is
cross-session repeat orientation, not within-session (a harness already caches reads
inside one context window) — measure before claiming a number (Rule 8).

**Rule 4 — summaries, not transcripts, cross a worker boundary.** Three tiers over the
same `event_log` (section 3):

| Tier | Content | Retention | Who reads it |
|---|---|---|---|
| 1 — raw events | `assistant.delta`, `tool.start/result`, `approval.request`, `turn.end` | bounded, rotating | **humans only**, via panes |
| 2 — turn digest | ≤150 tokens per turn, written at `turn.end`; **extractive by default**, model-backed digester injectable | per task | a resumed worker, for current state only, and tier 3's `Assumptions` |
| 3 — task handoff | rolling ~1 page: goal, decisions, assumptions, artifacts, blockers, current diff shape | per task, regenerated on transition | CTO, leads, reviewers, any new/cleared worker |

**Hard rule: no agent ever reads tier 1.** Without it, the CTO's context explodes at
roughly three concurrent workers, and the dashboard becomes unusable exactly at the
scale section 1 targets. Tier 3 is also the mandatory shared task memory section 1's
problem statement promised — derived from the transition journal plus per-turn digests,
not separately maintained by hand.

**Rule 5 — clearing becomes routine because tier 3 makes it cheap.** Section 7 gets
clean-vs-kill right as policy but originally treated clearing as an intervention. With
tier 3 handoffs, a soft clear costs one page of reload, so it becomes the default
rhythm:
```jsonc
// harness-defaults.json — new field per role
"coder":     { "clearPolicy": "on-state-transition" },
"reviewer1": { "clearPolicy": "per-review-round" },   // aligns with revision-bound verdicts, section 13
"cto":       { "clearPolicy": "on-demand" },
"utility":   { "clearPolicy": "always" }              // one operation per invocation, state in its journal
```

**Rule 6 — the CTO must be cheap and mostly deterministic.** It is resident, so its
model is a standing cost. Every registry query/mutation expressible as a typed command
*is* a command (section 4, section 16) — the model is invoked for routing and advice,
not bookkeeping. `cto: { harnessId, model, effort }` in `harness-defaults.json` defaults
to a cheap model, with the ability to escalate a single decision to a stronger one
rather than running a high-effort model resident all day.

**Rule 7 — admission control.** `maxConcurrentSessions`, a launch throttle, and
per-role defaults biased toward cheaper models with explicit opt-in required for
expensive ones. This is an operational limit, not accounting — it does not touch
section 19's no-cost-tracking non-goal.

**Rule 8 — measure before you optimize.** Emit `tokensIn`/`tokensOut`/`cachedTokens`
per turn into `event_log` from the earliest runtime spike onward (harnesses already
report this). Without a baseline, Rules 3 and 4 are folklore, not engineering. This is
telemetry, not budget tracking — still consistent with section 19.

## 9. Cross-tool / harness onboarding

Claude Code and OpenCode both have native, real hook/plugin systems capable of
heartbeating worker status + task context (confirmed — no log-tailing hacks needed for
either).

**Runtime code-generation for a new harness is rejected — moved to backlog.** The
original design had an LLM research a new CLI's extensibility surface and generate
adapter config that the system then executes, with no review, provenance, sandbox, or
rollback step. That's a real security shape problem, not just a maturity gap: executing
LLM-authored adapter code against a live supervisor is exactly the kind of
unreviewed-code-execution surface the rest of this design is careful about everywhere
else (secrets, DM-reading, as-user posting).

**v1 replacement: register an already-installed, versioned adapter that declares a
capability matrix and passes conformance tests**, rather than generating one at
runtime:
1. Adapter ships as a versioned package declaring
   `{ residentProcess, resumableTurns, structuredOutput, interrupt, clearContext,
   approvalProtocol, modelDiscovery }` (section 3/4).
2. A conformance suite runs against it (start, stream, interrupt, clear, exit
   detection) — pass/fail, not "probably works."
3. Only on passing does `harnesses.status` flip to `active`.
4. No conformance suite and no declared capability matrix at all -> falls back to the
   **`wrapper` tier**, defined here as the canonical degraded mode: the harness is
   driven via `node-pty` + a terminal parser instead of its own structured event
   stream, for both liveness/heartbeat purposes and pane output (section 5 extends this
   same tier to cover rendering, rather than defining a second one). A `wrapper`-tier
   harness is always explicitly marked as such in the UI — never silently treated as
   equivalent to a real, conformance-passing adapter.

**THE `wrapper` TIER IS BUILT, 2026-09-08** (`adapters/wrapper/adapter.js`; record in
`supervisor/runtime/FINDINGS.md` section 36) — with **one documented deviation from this section**: it is
driven by **pipes and line-splitting with ANSI stripped, not `node-pty` and a terminal parser**. Reasons, in
the order that decided it: `node-pty` is a native build dependency and this project has exactly one
dependency on purpose; there are zero harnesses today that need a tty (both real adapters emit structured
events); and a pty buys exactly two things over pipes — a harness that REFUSES to run without one, and
cursor addressing, which is output a pane discards anyway. `node-pty` is deferred, not dropped: the day a
harness genuinely demands a tty, the parser gets written against that harness's real output rather than
against a guess.

The tier's constraints are DECLARED rather than discovered, and the conformance suite checks them: no turn
boundaries except process exit (`residentProcess: 'one-shot'`), no approvals (`approvalProtocol: false`), no
clear, no resume, and `interrupt: 'process'` — section 7's clean-vs-kill landing on kill. Every event carries
`degraded: true` and every pane is marked, which is this section's "never silently treated as equivalent"
made mechanical.

**And building it corrected this section's own tier logic.** The verdict was derived from whether the
conformance checks passed, which covers the two cases named above (no matrix; a matrix whose claims do not
hold) and gets a third exactly backwards: a degraded driver that tells the truth passes every check, so it
would have been marked `active`. A harness is now `wrapper` tier whenever it declares
`structuredOutput: 'terminal'`, however well it behaves — honesty in the declaration must not be what costs
an adapter its accurate label.

Runtime research-and-generate (the original flow: CTO command -> research pass ->
generated adapter config) stays as a **backlog** idea, gated behind whatever
review/sandbox/rollback story would make it safe — not v1.

## 10. Direct-message / adhoc sessions

- Toggling a worker's pane (click header or a keybind) switches the bottom bar's target
  from "CTO chat" to "direct chat with that worker" — label changes visibly
  (`> Purus (direct)`) so input is never accidentally misdirected.
- A one-off task with a single worker and no reviewers is just `type: "adhoc"` in the
  task schema — not a separate subsystem.
- Uses the same `start`/`sendInput` supervisor contract as everything else (section 4)
  — there is no separate "adhoc spawn path." This was the original draft's single
  riskiest undesigned gap (named a "spawn adapter" with no mechanism); it is now just
  the supervisor's normal `start()` call, proven in ROADMAP Phase 0b before anything
  depends on it.
- Every adhoc/DM'd task still writes a real task row (`source: "direct-message"`) —
  nothing is untracked just because it skipped CTO routing.

## 11. Harness & model assignment

A general mechanism, not Slack-specific — it fires anywhere a task is about to get a
run started: accepting a request (section 14.2/14.4, backlog), starting a new team, or
clicking to start work from the left panel.

- **A task exists before it runs.** `created` (section 6) — the task row exists, shows
  in the left tree immediately, with no run started yet, until the assignment step
  below completes.
- **Defaults are per-role, configurable, global with optional per-team override**:
```jsonc
// harness-defaults.json
{
  "global": {
    "coder":         { "harnessId": "claude-code", "model": "sonnet",  "effort": "medium" },
    "reviewer1":      { "harnessId": "claude-code", "model": "sonnet",  "effort": "medium" },
    "reviewer2":      { "harnessId": "opencode",    "model": "gpt-5.6", "effort": "medium" },
    "parentReviewer": { "harnessId": "claude-code", "model": "opus",    "effort": "high" },
    "cto":            { "harnessId": "claude-code", "model": "haiku",   "effort": "low" }
  },
  "perTeam": {
    "vite-migration": { "reviewer2": { "harnessId": "opencode", "model": "gpt-5.6" } }
  }
}
```
**BUILT 2026-09-08** (`config/harness-defaults.js`, `domain/assignment.js`,
`supervisor.assignTask()` / `assignmentPreview()`; record in `supervisor/runtime/FINDINGS.md` section 35).
Three things this section did not specify, decided while building and recorded here rather than left in
code: the file's **absence is normal and its malformation is fatal** (a fresh install has no file; a typo
must not be silently dropped); per-team overrides **merge per field**, since a partial override is the only
kind anyone writes; and a **partial start keeps what worked** rather than being all-or-nothing, with the
failed role recorded as retryable and surfaced in the tier-3 handoff's Blockers — and if NOTHING starts, the
task lands in `start-failed` rather than sitting in `starting`. Assignment does **not** create workers: a
worker is a persistent named identity (section 1), so a role with no worker is reported as unfillable rather
than filled by an invented name.

- **Assignment step**: for each role the task needs, the UI shows the configured
  default harness/model pre-filled. One click confirms and calls the supervisor's
  `start()` (section 4) — this now has a real implementation to call into, fixing the
  original sequencing bug where the assignment-confirmation UI was designed before
  anything existed for it to invoke. Changing the dropdown before confirming overrides
  the default for this one task instance only; it does not rewrite the stored default.
  Recorded on the task as `harness_assignments_json` (section 3) once confirmed.
- **One picker, one config source, everywhere.** Requests-panel accept (backlog),
  "start a new team," and left-panel click-to-start all go through this same mechanism.
- **Live effort/variant change, mid-session, not just at assignment time.** Claude
  Code calls this "effort" (its own `/effort` command; low/medium/high/max) and
  OpenCode calls the same concept "variant" (its `--variant` flag; high/max/minimal,
  provider-specific values). This is exactly the kind of harness-terminology
  difference the capability matrix (section 9) exists to absorb — the UI shows one
  generic control, the adapter translates to whichever term/values its harness
  actually uses. Click a worker in the tree, then a keybinding (FLOWS.md section 5)
  opens a quick picker scoped to that one run; selecting a value calls the
  supervisor, which routes it through the correct harness-specific mechanism
  (Claude Code's `/effort`-equivalent command on the resident process, OpenCode's
  `--variant` — noting section 0b's spike only proved the flag is *accepted* without
  error, not that it changes model behavior; confirm that properly before relying on
  it). Same override rule as the assignment step above: this changes the one running
  instance, not the stored `harness-defaults.json` default, unless the user
  explicitly asks to update the default too.

## 12. Model health, fallback & preferences

**This section exists because of a real incident during this project's own build,
not a hypothetical.** While building Phase 1 and running it through independent code
review, the review pipeline hit exactly the failure modes this section now designs
for: a model invocation hung for 17 minutes with no output (a permission prompt with
nowhere to go, no TTY attached); a model failed immediately with "no payment method";
a *different, correctly-routed* invocation of the same logical model crashed on a
provider-side SDK schema gap (Bedrock's redacted-reasoning content blocks, unhandled
by the installed `@ai-sdk/amazon-bedrock` version); and the same model that failed
came back working minutes later with no code change at all. None of this was
predictable in advance, all of it was silent until someone went looking, and the
dashboard's whole premise — many concurrent harness/model combinations — makes this
*more* likely to happen, not less, the more it's actually used. A production dashboard
cannot treat "the model call failed" as an unhandled edge case.

### 12.1 Preflight: verify before committing real work

Before a harness/model combination is used for a real task in a session — not once at
install time, but the first time *this session* is about to rely on it — send a
trivial, cheap prompt ("reply hi") and confirm a real response comes back. This is
conversational, not a hidden background check: the CTO can do this explicitly and say
so ("confirmed Sol is responding") the same way a human would sanity-check a tool
before depending on it. Cheap enough to do liberally; the cost of skipping it is
committing a real review/coding task to a model that turns out to be unreachable.

This is the same conformance-check instinct as section 9's harness onboarding
(start/stream/interrupt/clear/exit-detect before trusting an adapter) — applied one
level up, to the model behind an already-trusted adapter, because the adapter working
doesn't mean the specific model+provider combination behind it is reachable *right
now*.

**`--auto` (OpenCode's auto-approve-permissions flag): required for non-interactive
utility calls, forbidden as a default for real worker sessions.** Discovered directly
this session — a non-interactive `opencode run` with no TTY attached hangs forever
with zero output on its first permission prompt, because there's nowhere for the
prompt to go. `--auto` fixes that. But blanket-approving every permission is exactly
what section 7's `asks` control plane exists to prevent for real work. The policy,
not a judgment call per invocation:
- **Preflight checks and narrow utility/review calls** (this subsection; the review
  pipeline that found this bug in the first place) — always pass `--auto`. These are
  bounded, low-risk, and there's no human attached to answer a prompt anyway.
- **Real worker sessions doing actual team tasks** — never `--auto`. Permission
  decisions must route through the real mechanism (OpenCode's async
  `permission.asked` event, Claude Code's synchronous PreToolUse hook — section 4) so
  `asks` actually governs what happens. Silently defaulting to `--auto` here would
  make the whole approval design decorative.
- Tested order for any *new* non-interactive invocation type added later: try without
  `--auto` first only if a real approval route is wired up; otherwise use `--auto`
  from the start rather than discovering the hang the hard way again.

### 12.2 Mid-session failover — silent, not disruptive

A model that worked five minutes ago failing now (rate limit, billing, a provider-side
bug) must not stall or visibly break the task in progress. Concretely:

- **Failure classification matters.** Distinguish provider-unavailable errors
  (billing, quota/rate-limit, auth, a known SDK/schema crash) from real task failures
  (the model actually tried and got something wrong). Only the former triggers
  failover — the latter is a real result and must surface normally, not be silently
  retried into a different model that might paper over an actual bug.
- **Each role's config carries a fallback chain, not just one model** — extending
  `harness-defaults.json` from section 11:
  ```jsonc
  {
    "global": {
      "reviewer1": {
        "primary": { "harnessId": "opencode", "model": "sol" },
        "fallback": [
          { "harnessId": "opencode", "model": "big-pickle" },
          { "harnessId": "opencode", "model": "luna" }
        ],
        "preferFreeOnFallback": true
      }
    }
  }
  ```
- **On a classified provider-unavailable failure, the supervisor advances to the next
  fallback entry automatically and continues the task** — no user-facing interruption
  mid-session. The switch is logged (`transition_journal` / tier-2 digest, section 8)
  so it's visible in the record afterward, but it does not block or prompt in the
  moment. This is the same "explicit beats inferred, but don't make the human do
  bookkeeping a machine can do reliably" balance struck everywhere else in this
  design — the *decision* of which models are acceptable substitutes is explicit
  (the user configured the fallback chain), but *invoking* that decision is automatic.
- **`preferFreeOnFallback`**: when true, order the fallback chain to prefer models the
  user has marked as free/cheap over ones marked expensive, before falling back to
  whatever's next in the explicit list order. This is what makes "just don't spend a
  lot if my first choice is down" a real, honored preference rather than something
  the user has to notice and fix manually after the fact.

### 12.3 User preferences: denylist, per-section defaults, settings surface

Three distinct preference types, all attaching to `harness-defaults.json` (or a
sibling config it references) rather than inventing a new file per preference:

- **Denylist**: "don't use `claude-fable` — it's large and expensive." A model on the
  denylist is never selected as primary or fallback, for anyone, until removed.
  Expressed conversationally to the CTO ("don't use Fable, it's expensive") and
  persisted the same way any other CTO-issued config change is (section 2 — the CTO
  is a client of the supervisor like everything else, it doesn't get to silently
  decide this on its own).
- **Per-section defaults**: not just per-role (reviewer1/coder/cto, as in section 11)
  but per-*task-category* — Review, Code/implementation, and Global (small
  utility-agent tasks like `git-create-push`, section 16) each get their own default
  harness/model, settable independently. A cheap model is fine for "push this branch";
  a stronger one may be warranted for "review this diff."
- **Settings surface**: a dedicated icon (top-right of the TUI, FLOWS.md section 6) —
  not buried in chat — where the user manages this list directly: harness/model per
  section, the denylist, and global preferences like the worktrees base folder path
  (referenced by `git-create-push` and any future worktree-creating logic, section 4).
  Chat remains a valid way to *state* a preference ("don't use Fable"); the settings
  panel is where you go to *see and edit* the whole set at once, the same
  read/edit-surface split as the Requests panel (section 14.4) has for triage.

### 12.4 Session ID visibility — a gap found by living with this exact problem

While running this project's own build through multiple concurrent background agents,
Manish had to hunt for an agent/task ID buried in tool output to check on or resume a
specific piece of work, because nothing surfaced it directly. **The dashboard must not
reproduce this on its own users.** Concretely: every worker/task node in the left tree
(FLOWS.md section 6, PLAN section 5) displays its `run_id` directly, not just on
hover or in a detail pane — copyable, and clickable to open that exact session in
another pane/tab. "Which session is this" should never require reading a transcript
to find out.

## 13. Configurable reviews

All four reviews independently found the original review model rigid: hardcoded
reviewer slots, verdicts that outlive the commit they judged, undefined quorum,
undefined precedence when verdicts disagree. Fixing that and making reviews
*configurable* turn out to be the same change.

```jsonc
// review-profiles.json
{
  "schemaVersion": 1,
  "profiles": {
    "default": {
      "dimensions": [
        { "id": "correctness",    "blocking": true,  "prompt": "..." },
        { "id": "security",       "blocking": true,  "prompt": "..." },
        { "id": "tests",          "blocking": true,  "prompt": "..." },
        { "id": "simplification", "blocking": false, "prompt": "..." },
        { "id": "performance",    "blocking": false, "prompt": "..." }
      ],
      "quorum": { "required": 2, "parentCounts": false, "parentRequired": false },
      "changeRequestBlocks": true,   // any current-round change request blocks approval
      "revisionBound": true,          // approvals die when the commit changes
      "verifyFindings": true,         // adversarial second pass per finding, before it
                                       // ever reaches the coder
      "effort": "medium",
      "modelDiversity": "require-distinct-harness"
    },
    "hotfix":    { "extends": "default", "quorum": { "required": 1 },
                   "dimensions": ["correctness", "security"], "effort": "high" },
    "docs-only": { "extends": "default", "quorum": { "required": 1 },
                   "dimensions": ["correctness"], "verifyFindings": false, "effort": "low" }
  },
  "perTeam": { "vite-migration": "default" },
  "perPath": [ { "glob": "packages/payments/**", "profile": "payments-strict" } ]
}
```

**Verdicts are revision-bound and per-dimension**, not one mutable field:
```jsonc
{ "reviewerId": "sess_qa1", "slot": "reviewer1", "round": 2, "commitSha": "abc123",
  "dimension": "correctness", "verdict": "approved" | "changes-requested" | "abstain",
  "findings": [ { "file": "...", "line": 42, "summary": "...", "verdict": "CONFIRMED" } ],
  "at": "<iso>" }
```
A task reaches `approved` (section 6) only when every **blocking** dimension has ≥1
current-round approval, quorum is met, and there are **zero** current-round change
requests. This single rule resolves the reviewer-slot-count-vs-schema mismatch the
original draft had (text promised "N reviewers"; the schema hardcoded three).

**Model diversity is a feature, not an accident.** `harness-defaults.json` already puts
reviewer2 on a different harness/model than reviewer1 (section 11) — promote that to a
validated profile property (`modelDiversity: "require-distinct-harness"`). The evidence
for this is the review process that produced this very revision: four models on two
harnesses produced four materially different, individually valuable reviews, and the
highest-value individual findings each appeared in exactly one of them. Homogeneous
reviewers would have missed them.

**BUILT 2026-09-09** (`migration 0009`, `config/review-profiles.js`, `domain/review.js`,
`supervisor.recordVerdict()` / `reviewStatus()` / `approveTask()` / `reviewFindings()`; record in
`supervisor/runtime/FINDINGS.md` section 37). The rule above is enforced in ONE place — `approveTask()` is the
only path that may make the `awaiting-review -> approved` transition, because `recordTransition` will
otherwise take it from anybody who passes two verdicts, which is the state the state machine itself was in
before Phase 5.

Five things this section did not specify, decided while building and recorded here rather than left in code:

1. **The `revisionBound` asymmetry.** A stale APPROVAL dies with its commit; a stale CHANGE REQUEST does not,
   because nobody has said it was fixed. Symmetric treatment lets an obsolete approval and an obsolete
   objection cancel out, and the task approves on the strength of two opinions about code that no longer
   exists. `revisionBound: false` weakens the commit check only — a round boundary is absolute either way.
2. **Quorum counts distinct reviewers, not verdicts**, and `parentRequired` is a separate condition from
   `parentCounts` ("the parent must weigh in, and its opinion is not one of the N" is a real combination).
3. **`extends` is a small language, not a merge.** A `dimensions` list of bare id strings SELECTS from the
   parent's, keeping each one's `blocking` and `prompt`; `quorum` merges per field. A selected dimension the
   parent does not define is an ERROR — tolerating it would let a config typo review nothing at all, at which
   point every blocking dimension is trivially satisfied.
4. **`review_profiles` is content-addressed.** Each resolved profile is stored under a hash and every verdict
   records the `(profile_id, profile_hash)` it was judged under, so editing a profile cannot silently rewrite
   the meaning of judgements already recorded. That is why this file is imported into a table while
   `harness-defaults.json` is read from disk: a verdict is read through its profile, an assignment is not.
5. **The default finding verifier confirms nothing.** With no model configured a finding is `unverified` and
   is delivered LABELLED — calling it confirmed would be a lie, and dropping it would lose a real finding to a
   missing configuration.

**Two-stage review.** `verifyFindings: true` runs each finding through an adversarial
verification pass before it reaches the coder — findings that fail verification never
arrive. This is both a quality gain and a token saving (section 8): the coder receives
a ranked list of confirmed findings with `file:line`, not a review transcript. Store
findings so a re-review can diff against the previous round instead of re-deriving it —
round 3's second pass should cost a fraction of round 3's first.

## 14. Slack integration

Two separate integrations, different cost and different maturity:

- **Outbound** (cheap, v1 candidate): task state transition to `approved`/`merged`
  fires a webhook posting a summary to a configured channel, via the `outbox` table
  (section 3) — a consumer with dedup + retry + failure isolation, not a direct
  synchronous call from the state machine.
- **Inbound** (backlog — see ROADMAP): a Slack bot/app subscribed to mentions and
  configured channels. **Marked provisional, not settled architecture** — the review
  found a real mechanical bug in its password gate (section 14.5) that needs fixing
  before this is built, not after.

### 14.1 Identity & channel configuration (no hardcoded handles)

"Manish" and any specific channel name are the *running example* throughout this doc,
not hardcoded defaults. At setup, the plugin asks every user configuring it:
*"give me your name, Slack handle, and Jira handle"* — this builds the identity-mapping
table each install actually uses. Watched channels are configurable per install, not
baked in:
```jsonc
// slack-config.json — per install, per user, never shipped with real values (section 15)
{
  "users": [ { "name": "...", "slackHandle": "@...", "jiraHandle": "..." } ],
  "watchedChannels": [ { "channel": "#your-mr-channel", "purpose": "review-request" } ]
}
```
Bot Token Scopes needed (`chat:write`, `chat:write.customize`, `im:write`,
`channels:read`, `channels:history`, `groups:read`, `groups:history`, `users:read`; add
`im:read`/`im:history` only if inbound DM-reading is actually enabled) live in
`team-slack-bridge`'s README alongside its setup steps — cite that file for the
current list rather than duplicating it here where it can drift out of sync. (This
repo no longer has its own `slack/` folder — an earlier, pre-extraction copy was
removed 2026-09-04 once confirmed redundant with `team-slack-bridge`, which is a strict
superset including fixes, like the `conversations.list` form-encoding bug, that were
never backported to the old copy. Section 15's roster wraps `team-slack-bridge`
directly.)

### 14.2 Inbound triggers -> requests, not silent auto-action (backlog)

A mention in a watched channel never silently spawns a task on its own — it becomes a
**request** in a triage queue (`requests` table, section 3), same "explicit beats
inferred" principle as clean-vs-kill (section 7) and no-autonomous-merge (section 6):
an inbound Slack ping is a *proposal*, not an instruction that executes itself.

**Self-DM exception, two gates.** Gate 1: the message arrives in the owner's own DM
with the bot *and* the sender is that same owner (a genuine "note to myself," not
someone else DMing on their behalf) — this alone means there's no other party
proposing work to triage, so it bypasses the Requests panel and creates the task
directly (`source: "slack-inbound-self"`), landing in `created` (section 6), still
waiting on harness/model assignment (section 11). It does **not** spawn a run on its
own. Gate 2, layered on top: the message must *also* contain a whole-word trigger
phrase — **"start right now"**, **"start right away"**, **srn**, or **sra** (never a
substring match, so "sra" in "extras" never fires) — before it also auto-applies
default harness/model and starts immediately, skipping the assignment-confirmation
step. Anything that isn't this exact self-DM shape — a channel mention, or a DM from
anyone else — goes through the full pending/accept/decline flow regardless of wording.

Two request types: **review-request** (tag the configured handle in the MR channel;
accept spins up a task with `source: "slack-inbound"`, decline moves to declined,
complete is a separate explicit step after accept) and **team-request** (sprint
changes, ticket-ID asks, reassignment — bucketed separately; resolution logic
intentionally left open, "more we can leverage later").

**THE BRIDGE HAS A BUILD PLAN AS OF 2026-09-09**: `../team-slack-bridge/PLAN.md`. It was written against this
section, so this section stays authoritative for *what the dashboard needs*; that file is authoritative for *how
the bridge is built*. Three of its decisions constrain us and are worth knowing here:

1. **One core, four surfaces** — direct CLI, an MCP server, a Claude Code skill, and this dashboard's
   `slack-message` utility agent (§16). Our agent is a thin caller over the same functions everyone else uses.
2. **A hosted/remote instance is channel-post only, locked by construction** — no user tokens, no DM paths, no
   listener, and no `chat:write.customize` (custom `username`/`icon_*` is visual impersonation that survives
   having no user tokens). So **as-user posting and DM-reading are LOCAL-ONLY capabilities**, permanently. That
   is consistent with §14.5 keeping as-user on backlog behind a real `callerIdentity`, and it means the hosted
   surface can never reach the capability our sensitive class exists to gate.
3. **The inbound listener is local-only too**, because it acts on one specific owner's intent — which is exactly
   what §14.2's two gates encode.

### 14.3 Deferred: message/thread query (architect the seam now, build later)

A **read/query** capability — "show me messages from the last 30 minutes," "show me
the whole thread for X" — is a third mode alongside outbound (post) and inbound
(event-triggered requests): a synchronous pull, initiated by a human asking the CTO or
slack-message agent a question. Belongs on the slack-message global utility agent
(section 16) as an added method later (`queryMessages`, `getThread`), not a new agent —
the scopes it needs are already in the Bot Token Scopes list (section 14.1). No schema
changes needed to defer this.

### 14.4 Requests panel (UI, backlog)

Top-left of the dashboard, configurable height (default ~12%), Accepted/Declined/
Completed buttons for review-requests plus a separate Team Requests button. Collapsed
by default with zero pending requests. Full wireframe and keybinding in FLOWS.md
section 6a/6b.

### 14.5 Identity-bound authorization for as-user posting

**Corrected framing.** The original draft claimed cross-user impersonation was
"structurally impossible" on a single-user local install. That overstates it: local-only
(section 15, 17) removes *multi-tenant token sharing*, but it does not by itself
establish *authorization* — another local process, or another agent session on the same
machine, could still invoke the posting path if nothing checks who's actually asking,
and the original CLI (`slack/post.js --as-user`) accepted that flag with no provenance
check at all.

**Corrected rule: the multi-tenant impersonation path is eliminated by the local-only
architecture; local authorization is still required and is a separate mechanism.**
`callerIdentity` is an authenticated principal minted at ingress — the foreground TUI
user, or a socket peer credential — and propagated through any delegation, never a name
typed in a prompt. The `slack-message` agent only uses a person's user token when
`requestedPersonName == callerIdentity` by that definition, checked as a hard equality,
never left to the caller's honesty. Naming a person is necessary but not sufficient —
it's an argument, not a security control.

**v1 posts as the bot only; as-user posting moves to backlog** until the
`callerIdentity` mechanism above actually exists — cheaper and safer than shipping a
check that's easy to describe correctly and easy to implement incorrectly. Refusals are
logged, never silently dropped, to the agent's append-only task-history log (section 16).

### 14.6 Local gate on DM-reading — the original mechanism doesn't work (backlog)

**The password gate as originally specified is non-functional, not merely unbuilt.**
It was designed to run "before any code path calls `im.history`/`conversations.history`"
— but that's a **pull** check, and Slack delivers DMs via an event subscription — a
**push**. The gate never sits on the path it's meant to protect. Separately, on the
threat-model side: if the password is stored so background processing can proceed
unattended, it's just another local secret, not proof of a human being present; if it's
entered per-read, unattended self-DM auto-start (section 14.2's gate 2) cannot work at
all — the two goals contradict each other as specified.

**Replacement, once this is actually built (still backlog):** (a) DM-reading is off
unless explicitly enabled — no default-on path at all; (b) the token lives in the OS
credential store, not a plaintext local file; (c) if presence is genuinely wanted, a
foreground unlock with an expiry that *prohibits* unattended auto-start while locked,
rather than a password that either blocks automation or doesn't prove anything. The
fails-closed principle is kept; the mechanism that was supposed to implement it is
retired. Section 13.2's `sra`/`srn` auto-start needs this resolved before it can work as
designed — noted explicitly in ROADMAP.

## 15. Secrets & per-user configuration (applies to Slack and anything similar)

This repo is going to be public. That changes a rule from "good practice" to
"non-negotiable":

- **No token, credential, or account-specific value ever ships in the repo.** Only
  `*.env.example` files with empty values are committed. Real `.env` files are
  git-ignored at the project root — checked before writing a single line of
  integration code, not after. This extends to the SQLite database file, the event
  log, and any future vault projection (section 18) — all git-ignored by construction,
  and redacted at the integration boundary before anything is written, not by
  remembering to scrub it later. `.env`-only redaction was the original gap: the event
  log will contain API responses and stack traces that can themselves carry secrets.
- **Every installer configures their own account.** The Slack integration (and any
  future integration shaped like it — Jira, other webhooks) is per-install: each
  person's bot token, workspace, and default channel are theirs, set up via their own
  `.env`, not inherited from whoever wrote the plugin.
- **Default identity is always the least-surprising one.** Slack posts default to "as
  the bot," never "as a specific person" (section 14.5 — and as-user is backlog until
  its authorization mechanism exists at all).

## 16. Global utility agents

Distinct from **workers** (coders/reviewers/leads doing actual feature work), **global
utility agents** are narrow, single-purpose agents that perform one class of
side-effecting action on request, with deliberately minimal tool access. They exist so
that (a) the capability to push code, file a Jira ticket, or post to Slack isn't
duplicated into every worker's toolset, and (b) each one is small enough to reason
about and audit on its own — this is section 8's Rule 1, restated as an agent boundary.

**Roster:**
1. **jira-automation agent** — only the `jira-automation` skill + its MCP server.
2. **git-create-push agent** — real `git` access plus `gh`/`glab`, not `gh`/`glab`
   alone (section 8, Rule 2, corrects the original under-scoping). Owns its own
   fight-loop end to end and returns a short structured result, never raw tool output.
3. **slack-message agent** — wraps `team-slack-bridge` (outbound posting/DM; as-user
   and DM-reading are backlog per section 14.5/14.6).
4. **CTO agent** — section 2. Delegates all repository and external side effects;
   performs registry-adjacent actions directly via typed supervisor commands.

**The list-management agent from the original draft is deleted as an AI agent.** Its
job — move a worker between teams, rename, pin a main session, hide a team — is a set
of deterministic mutations with no judgment involved. Making it a separate agent
invocation added a whole context window and a whole class of "the agent hallucinated a
roster edit" for zero benefit. **Replacement: typed supervisor commands**
(`moveWorker`, `renameWorker`, `hideTeam`, `pinMain`) that the CTO calls directly and
validates the result of — the CTO's own natural-language understanding does the
translation; the mutation itself is deterministic and un-hallucinatable by construction.

**Escalation is capability-based authorization, not a fixed hop-count topology.** The
original design required every action to travel worker -> lead -> CTO -> the
responsible utility agent, unconditionally. Two costs that weren't priced in: it adds
model calls to routine, low-risk actions for no clear security benefit (context economy
again — section 8), and a hop with no return path is a deadlock waiting to happen.
**Replacement:** every caller carries an immutable principal (the same `callerIdentity`
from section 14.5) and a set of capabilities. Direct invocation of a utility agent is
allowed when the caller holds the capability for that action. CTO approval is required
only for an explicitly enumerated sensitive class — push to a protected branch, as-user
posting (backlog), a merge. The underlying intents from the original design are kept
exactly: fixed toolsets (a jira-automation agent never picks up git access "just this
once"), never-guess-an-underspecified-task (a request missing a team/task is rejected
back to the caller, not interpreted charitably), no skip-level *authority* grants. Only
the mandatory hop *count* is dropped.

**THE GATE IS BUILT, 2026-09-09** (`migration 0010`, `domain/capabilities.js`,
`supervisor.authorizedCommandHandlers()`, served by `ipc/daemon.js`; record in
`supervisor/runtime/FINDINGS.md` section 38). Two things this section specified that had to change on contact
with measurement, both recorded rather than quietly adjusted:

1. **There is no socket peer credential.** Section 14.5 names one; pure Node does not expose it (evidence 17 —
   `remoteAddress` is undefined and the libuv handle offers only bind/listen/connect/open/fchmod), and a native
   module was rejected for the same reason `node-pty` was. A principal is therefore filesystem permissions
   (which USER — the state dir is 0700) plus a supervisor-minted token (which PRINCIPAL), with only the token's
   sha256 stored.
2. **This is authorization, not confinement.** Workers run as the same user, so a worker that reads the owner's
   token holds the owner's authority, and a token in a child's environment is inherited by its descendants —
   so a worker principal identifies a run AND everything it spawns. What the gate buys is attribution, fixed
   toolsets, refusal of underspecified requests, and an audit trail. A sandbox is a separate uid per worker or
   OS-level confinement, and is not claimed here.

It **fails closed**: a command with no declared capability is refused, so a new command is unreachable until
someone classifies it. And section 6's merge gate turns out to be this section's sensitive class: `mergeTask`
requires a second principal's approval bound to the exact arguments, single-use and expiring, so
`humanApproved` is justified by a recorded artifact rather than by a caller's boolean. Self-approval is refused,
which is what keeps a CTO merge requiring the human.

- **Task history, not memory.** Each global agent keeps an append-only log of what it
  did and for whom/which task — a jira-automation agent checks "did I already file
  this ticket" against its own log, not a large context window. Context stays small
  because the log is a file/table, not conversation memory.
- **Context economy is the point, not a side effect** (section 8, Rule 1). None of
  these agents need much context to do their one job well; that's why they're built
  this way.

**The roster is not fixed forever — integrations are onboarded as data**, the same way
harnesses are (section 9). Slack is the first optional integration agent; email, Google
Drive, and Microsoft OneDrive are known future ones, added as a row in `integrations`
(section 3, ships empty in Phase 1) plus a new narrow agent, never a change to the CTO,
the supervisor, or any existing agent.

- **No integration is ever a hard dependency, anywhere in the core system.** The
  supervisor, CTO, and TUI must all behave correctly with *zero* integrations
  configured — an unconfigured integration is a silent no-op at startup. **An explicit
  invocation of an unconfigured integration returns `integration_unavailable`**, rather
  than silently vanishing — "graceful no-op" applies to ambient absence, not to a
  direct ask that deserves a real answer.
- Each integration gets its own subfolder mirroring `team-slack-bridge`'s shape: its
  own `.env.example`, README, git-ignored `.env`, and a narrow wrapping agent.
- A team with no Slack workspace, no shared Drive, and no email automation runs the
  entire dashboard — workers, supervisor, CTO, TUI — with none of these optional agents
  beyond jira-automation/git-create-push (which aren't optional in the same sense —
  they wrap capabilities assumed for any engineering team).

## 17. Distribution

- Ship as a **Claude Code plugin** (marketplace.json + plugin.json + skills + hooks +
  MCP server) that bundles/installs the supervisor daemon described in section 4 —
  see section 4's note on the plugin-vs-daemon boundary and the single-instance-lock,
  lazy-start resolution.
- The plugin also ships the **OpenCode-side plugin files** so a single install covers
  both harnesses.
- Open-sourcing is the same artifact — a plugin is just a git repo with a manifest.
- New harnesses are onboarded as data (section 9), not new plugin releases.
- **Every install is single-user and local-only — no networked or hosted deployment,
  ever.** This is a standing design decision. Section 13.5 was corrected to not overstate
  what this guarantees (it removes multi-tenant token sharing; it does not by itself
  establish local authorization) — the guarantee itself is unchanged.

## 18. Obsidian vault projection (backlog, cheap once the supervisor exists)

Not a new subsystem — the natural consumer of a decision section 3 already forces: once
SQLite is truth, JSON/markdown exports are *projections*, and a markdown projection with
YAML frontmatter is an Obsidian vault.

**The one rule that decides whether this succeeds or becomes a maintenance sink: the
vault is strictly read-only and strictly derived.** One `vault-projector` subscribes to
supervisor events, debounced (~1s), and writes files. Nothing ever reads the vault back
as truth. Bidirectional sync is how every project of this shape dies of conflict
resolution — if presentation-field editing (title, tags, notes) is ever wanted, it's an
explicit file-watcher command path, never state transitions or assignments.

**Timing decided 2026-09-06: after the Phase 2 vertical slice, not before.** The basic tier
is what gives a picture *outside* the terminal — a `Dashboard.md` (the "what is going on right
now" file), per-entity notes whose wikilinks make Obsidian's graph view a live team topology
diagram, and the live-orphan list from section 4 alongside it, so unmanaged processes are
visible to a human without a TUI. It is deliberately sequenced *after* the vertical slice
because projecting a workflow that is still changing shape means rewriting the projector; and
because the same rule ("SQLite is truth, exports are projections") is what makes a later web
view a second projection rather than a second system. **Off by default**, switched on when a
view is wanted and off again when it is not — while off, nothing writes to the vault at all.

- **Basic** (~a day, right after the first vertical slice works): one file per
  team/task/worker, YAML frontmatter mirroring the schema, wikilinks between them (a
  task links `[[Purus]]`, a worker links `[[vite-migrate-checkout-app]]`). Buys
  Obsidian's graph view as a live team topology diagram and backlinks as "everything
  that touched this task" for free. A `Dashboard.md` with Dataview queries (tasks
  grouped by state, workers with open asks, tasks stale for >N hours) is a usable
  read-only dashboard for the months before the TUI is good.
- **Mid** (after the TUI works): tier-3 handoff docs and tier-2 digests (section 8) as
  notes; auto-generated daily timelines from `transition_journal`. Keep tier-1
  transcripts **out** of the indexed vault or cap them hard — Obsidian's indexer
  thrashes on high-frequency appends, which is the usual reason this pattern gets
  abandoned.
- **Advanced** (only if the earlier tiers earned it): a read-only Kanban over task
  state, per-team Dataview views, narrow presentation-field write-back as described
  above.

Non-negotiables: git-ignored, redacted before write (section 15), never inside a synced
folder without explicit opt-in, and fully disable-able — the same rule section 19
already applies to claude-mem/agentmemory and every optional integration.

## 19. Explicit non-goals / guardrails

- No budget/cost-tracking layer (unlike Paperclip) — not a design goal for this tool.
  Admission control and model-cost defaults (section 8, Rules 6–7) are operational
  limits, not accounting, and do not violate this.
- No autonomous merge-to-main, ever, regardless of review state.
- No drag-and-drop UI — reassignment is a chat command (`move Purus -> team-2`), not a
  mouse gesture, to keep this buildable as a keyboard-driven TUI.
- No right-click — replaced by keybindings throughout (see FLOWS.md).
- **claude-mem/agentmemory integration is not a hard dependency.** It's an optional
  convenience layer Manish is choosing to use for his own setup (section 2) — the
  plugin must work fully for anyone who has neither installed. The file-digest cache
  (section 8, Rule 3) lives in the supervisor's own database for exactly this reason —
  it must not require an optional plugin to function.
- **No optional integration (Slack, email, Google Drive, OneDrive, or anything added
  later) is ever a hard dependency, for the same reason.** Absence at startup is a
  silent no-op; an explicit invocation of an unconfigured one returns
  `integration_unavailable` rather than vanishing (section 16).
- **The file-digest cache never serves as an edit basis** (section 8, Rule 3) — the
  real file is always re-read immediately before an Edit/Write, no exceptions.
- **A finding never counts against a different revision than the one it was raised
  against** (section 13) — verdicts are revision-bound, always.
- **Any DM-reading capability is backlog until the local gate actually works**
  (section 14.6) — the originally specified password gate was mechanically incapable of
  protecting the path it targeted; nothing ships here until that's genuinely fixed, not
  worked around.
- **As-user posting requires a real `callerIdentity`, not a caller-supplied name**
  (section 14.5) — naming a person is not authorization; v1 posts as the bot only.
