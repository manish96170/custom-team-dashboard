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

**Added 2026-09-11, BUILT the same day: the TREE panel gets a show/hide toggle too**, same idea as
section 14.4's Requests panel toggle. Bound to `t` (mnemonic, and unused — checked `tui/state.js`'s
`keyToAction` before picking it). `frameGeometry`'s `treeWidth` is simply 0 when hidden, the pane area
reclaims exactly that width, and `selectedNodeId`/`treeScroll` are untouched — a view change, not a
navigation reset, the same distinction section 7 already draws for "hiding a team/session from the top
bar." Tested in `tui/test/tui.test.js` case 20.

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
- **A task's worktree is shared by every worker assigned to that task — the default is
  ONE worktree per task, not one per session.** Corrected 2026-09-10 from an earlier
  version of this bullet that copied `hydra-acp`'s per-session isolation wholesale; on
  reflection that was wrong for this project's actual shape. A task's coder(s),
  reviewer(s) and lead are reviewing and building on the *same* revision on purpose —
  section 13's quorum counts distinct reviewers looking at one commit, and a shared
  worktree is what lets a resumed/cleared worker (section 7) and a fresh reviewer see
  each other's actual working state without round-tripping it through a handoff first.
  Splitting that by session would recreate, in git, exactly the isolation section 8's
  tier-3 handoff exists to cross *deliberately* — an accident instead of a decision.
  **Correction, 2026-09-10: no new columns needed.** `tasks.worktree_id` and
  `tasks.branch` already exist (migration 0001) and are already the live cwd a task's
  runs spawn into (`runtime/supervisor.js` reads `task.worktree_id` directly as `cwd`).
  This section's job is the *lifecycle* around those existing columns — torn down on
  `discard` after the task reaches a terminal state — not a parallel pair of fields.
  **CORRECTED 2026-09-13 (review-sol-2026-09-13.md finding 37): creation is NOT automatic
  on a task's first `start`.** `createTaskWorktree(taskId, { repoPath, branch })` is an
  explicit API call a caller must make first, requiring `repoPath` (there is no
  repo-path registry — `tasks.repo_id` is unused — so the caller must say where the repo
  lives); `assignTask`/`start` read whatever `tasks.worktree_id` already holds and do not
  create one themselves. A caller relying on the original wording could start a run in
  the wrong cwd (or fail outright) expecting a worktree that was never actually made. Adding one would have repeated the exact
  two-sources-of-truth mistake this project's own HANDOFF already calls out for
  `runs.lifecycle` vs `exit_reason`.
  **A session may explicitly ask for its own separate worktree** — the one case this
  is for is isolated testing/experimentation a worker doesn't want landing in the
  shared tree (a spike, a destructive migration dry run, anything it would need to
  discard without touching what teammates are looking at). That is a request, not a
  default: `requestWorktree(runId, { reason, principal })` in-process (the wire payload is flat —
  `{ runId, reason }`, with `principal` resolved server-side from the caller's token, never taken from
  the request; **corrected 2026-09-13, review-sol-2026-09-13.md finding 43 — this previously showed
  `requestWorktree(runId, reason)`, a bare string second argument that does not match the real options-
  object signature**), which creates a per-run overlay worktree
  off the task's current branch, and the request + its reason is written to the task's
  append-only history log (section 16's "task history, not memory" — the same log,
  not a new one) so it is queryable later: which sessions branched off for isolated
  work, why, and whether the result needs merging back. **This is exactly the kind of
  fact worth also surfacing to agentmemory/claude-mem where installed** (section 2) —
  richer recall of "who tested what in isolation and what came of it" is precisely its
  optional value-add, on top of the mandatory log entry that works with or without it.
  Lifecycle: `start`/`create` and `discard` are supervisor commands
  (`createTaskWorktree`/`discardTaskWorktree`/`requestWorktree`, BUILT 2026-09-10 —
  ROADMAP Phase 7), gated by one capability, `task:worktree`. **`merge` is deliberately
  NOT a supervisor command** — `mergeTask()` already states plainly that it does not
  touch git ("Merging code is the `git-create-push` agent's job"), so the git side of a
  merge is `git-create-push` operating inside the shared worktree after `mergeTask`'s
  approval-gated transition has already happened, per section 6's `merged` gate; this
  section opens no new path to `merged`. `sync` (rebase/merge base updates into the
  shared worktree on request, never silently) is specified but not yet built.
  **CORRECTED 2026-09-13 (review-sol-2026-09-13.md finding 37) — this was aspirational,
  never built: a new worktree starts from COMMITTED branch/HEAD state ONLY.**
  `createTaskWorktree`'s real mechanism is a plain `git worktree add`, which checks out
  the named branch fresh — it does not copy any uncommitted/dirty file from anywhere,
  because there is no "wherever they were" for it to read in the first place (a task has
  no prior worktree to copy FROM the first time one is created). A caller expecting
  in-flight uncommitted work to follow a task into its new shared worktree will not get
  it; only what was already committed to the branch is there.
  Concurrent host-level resources a worktree can't isolate either way — host memory, a
  machine-wide git identity — are still section 20's job, not this bullet's.

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

**This rule is per-supervisor, and that is not enough.** Two sessions can each honour
their own `maxConcurrentSessions` and still take the machine down between them (it
happened: two concurrent webpack builds). Host memory and other machine-wide resources
are arbitrated by **section 20**'s leases, not here.

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

**A candidate for Phase 11, not a decision yet: adopt ACP (Agent Client Protocol,
agentclientprotocol.com) as the adapter-facing wire format instead of a bespoke
protocol per harness.** Noticed reviewing `hydra-acp` 2026-09-10 — it drives Claude,
Codex, opencode and others through one client protocol rather than one adapter per CLI.
If a harness already speaks ACP, "onboard it" could become "register something that
speaks the protocol we already support" instead of writing and conformance-testing a
new adapter each time — real leverage against exactly the problem this section exists to
solve. It does **not** replace this section's registration/conformance-suite/tiering
model; ACP would be a *transport* a registered adapter could use, still gated by the
same conformance suite before `active`. Spike before committing: does either current
harness (Claude Code, OpenCode) actually speak ACP today, or would supporting it mean
maintaining a translation shim — which could cost more than the two bespoke adapters it
was meant to replace.

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

**CORRECTED 2026-09-11 — quorum counting distinct reviewers (item 2 above) assumed the caller-supplied
`workerId` on a verdict was trustworthy.** Both codex reviews (`codexdoc/REVIEW-NOTES.md` finding 3) found
that `recordVerdict`'s wire handler accepted a caller-supplied `workerId` without binding it to the
authenticated principal — one authenticated reviewer token could submit verdicts under a second, unrelated
worker's identity and manufacture the two-distinct-reviewer quorum by itself. **Fixed the same day**:
`recordVerdict` now refuses when an authenticated worker-backed principal's own `workerId` disagrees with the
verdict's claimed `workerId`, the same "identity is a registry fact, not a request field" rule already applied
to task/role/dimension; the wire handler now forwards `cmd._principal` through, which it had been dropping.
Proven against the pre-fix code (`runtime/test/review.test.js` case 18). Deferred, real, and NOT fixed: nothing
stops a reviewer from arbitrarily advancing the authoritative round being reviewed — noted as a separate open
concern in the same finding.

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

### 14.4 Requests panel (UI, backlog — layout/toggle/detail-view mechanics now BUILT 2026-09-11)

Top-left of the dashboard, configurable height, Accepted/Declined/Completed buttons
for review-requests plus a separate Team Requests button. Collapsed by default with
zero pending requests. Full wireframe and keybinding in FLOWS.md section 6a/6b.

**Still backlog: the buttons themselves and everything server-side** (a request only exists here once
Slack inbound exists; Accept/Decline have nothing to create/reject yet — see PLAN.md §16.2's neighbor
note). **Built 2026-09-11: the UI mechanics below**, so whoever eventually wires Slack inbound builds
against a real, tested layout instead of the original 12%-strip design:

**Corrected 2026-09-11, before this is ever built — three gaps in the original design:**

1. **Default height raised to ~30% (from ~12%) — BUILT.** `tui/layout.js`'s `requestsPanelHeight`.
2. **An explicit show/hide keybinding, independent of whether anything is pending — BUILT, bound to
   capital `R`.** Lowercase `r` was already taken (toggle all reviewer panes); this codebase's own
   `decodeKey` already returns a shifted letter as a distinct string (verified before picking it — it
   just returns `chunk.toString()` unchanged for one printable character), so `R`/`r` never collide.
   Works from anywhere, toggles both ways (unlike `h`, which only ever hides), and the existing
   auto-reappear-on-a-fresh-non-empty-list rule (`withRequests`) is untouched.
3. **A big request expands to a full detail view — BUILT**, as a new `FOCUS.REQUEST_DETAIL` in
   `tui/state.js` (see FLOWS §6c). Whether a request "fits inline" is computed in `layout.js`'s
   `hitTest` by mirroring `renderRequestsPanel`'s own row construction, so the two can't disagree about
   width — a request that already fits just selects, as before; only a genuinely-too-long one expands.
   Deliberately does NOT snapshot/restore anything: entering/leaving only ever changes `focus`, so
   nothing else needs to change for the layout to come back exactly as it was — the same technique
   `fullscreen`/`reviewersHidden` already use. Accept/Decline (`a`/`d`) hand off to `app.js` as
   `pendingRequestDecision`, mirroring `pendingChat`'s existing split — honestly a status-line no-op
   today, since there is still no wire command to accept a request into a real task (that part is
   still backlog, per above).

Tested in `tui/test/tui.test.js` (cases 20-22, pure state/layout, no terminal) and captured as real
evidence in `tui/evidence/01-demo-frames.txt` / walked through in `TUI-GUIDE.md`.

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

**Roster:** (each agent's fixed toolset is also the first candidate for section 21's
MCP pooling + capability router — narrow-by-construction is exactly what makes a fixed
router unambiguous.)
1. **jira-automation agent** — only the `jira-automation` skill + its MCP server.
2. **git-create-push agent** — real `git` access plus `gh`/`glab`, not `gh`/`glab`
   alone (section 8, Rule 2, corrects the original under-scoping). Owns its own
   fight-loop end to end and returns a short structured result, never raw tool output.
   **BUILT, 2026-09-10** (`agents/git-create-push.js`'s pure fight loop + `runtime/supervisor.js`'s
   `gitCreatePush` glue): stage -> commit -> classify (8 classes, pattern-matched from real hook
   output, heuristic documented in code) -> autofix ONLY `format`/`lint-autofixable` via an
   `.git-create-push-autofix.sh` extension point at the repo root (no autofix script -> honestly
   unresolved, never a silent no-op claiming success) -> push, bounded at 3 total commit attempts.
   **Two wire commands, not a runtime flag**: `gitPush` (`git:push`) and `gitPushProtected`
   (`git:push-protected`, SENSITIVE) share one fight loop. `git:identity` (§20) is acquired
   before anything else and released in a `finally`, proven both by a genuine cross-process
   contention test (a real separate OS process holding the lease genuinely blocks a `gitCreatePush`
   call from this process) and by a forced-throw case (a task whose worktree points nowhere still
   releases the lease). **`gh pr create`/`mrUrl` is real and wired (`openPullRequest`, opt-in via
   `runFightLoop`'s `openPr: true`) but deliberately excluded from `npm test`** — needs real
   credentials and network, same class of exclusion as this project's other `real-*.slice.mjs`
   files; `runtime/test/real-git-create-push.slice.mjs` is the manual counterpart. 15 new cases
   across two test files (`agents/test/`, `runtime/test/`), suite 110 -> 112, exit 0, re-verified
   3x.
   **CORRECTED 2026-09-11 — the claim above (bold, now removed) was WRONG and a real bypass:** "which
   one you call IS the protected/non-protected decision" assumed a caller would honestly choose
   `gitPushProtected` for a protected destination — nothing stopped it from calling the cheap `gitPush`
   for the SAME destination instead, since neither command classified the actual branch being pushed to.
   Found independently by both codex reviews (`codexdoc/REVIEW-NOTES.md` finding 2). **Fixed the same
   day**: `gitPush`'s handler now resolves the real destination and refuses server-side, BEFORE the
   fight loop runs, if it matches a configured protected-branch list (`config/protected-branches.js`,
   new — same on-demand/malformed-throws contract as `harness-defaults.js`). `gitPushProtected` needed
   no change — reaching it already required the sensitive approval regardless of destination.
   **Also fixed the same day, a separate finding**: `git add -A` on the task's SHARED worktree staged
   and pushed ANY uncommitted change present, not just the caller's own (`codexdoc/REVIEW-NOTES.md`
   finding 5). `runFightLoop` gained an optional `paths` parameter to stage exactly named files instead
   — **this does not make the default safe**; omitting `paths` still runs `-A` unchanged, and a caller
   on a shared worktree MUST pass explicit paths. Both fixes proven against the pre-fix code
   (`runtime/test/git-create-push.test.js` case 7, `agents/test/git-create-push.test.js` cases 7-8).
3. **slack-message agent** — wraps `team-slack-bridge` (outbound posting/DM; as-user
   and DM-reading are backlog per section 14.5/14.6). **Corrected 2026-09-11 — see §16.1: this
   wraps `leo-mcp`'s mounted Slack tools now, not `team-slack-bridge` directly**, though the
   underlying code is still exactly `team-slack-bridge`'s own, unchanged.
4. **CTO agent** — section 2. Delegates all repository and external side effects;
   performs registry-adjacent actions directly via typed supervisor commands.

### 16.1 `leo-mcp` — why the Jira/Slack roster items changed shape, 2026-09-11

While starting jira-automation/slack-message, checking what already existed changed the plan:
`~/.claude/skills/git-create-push/SKILL.md` and `~/.claude/skills/jira-automation/SKILL.md` are real,
mature, CONVERSATIONAL skills (they ask a human everything up front — commit type, MR method, sprint,
custom fields — then execute); and `team-slack-bridge` (the sibling repo section 14 already depends on)
had, by 2026-09-10, grown a full 21-tool MCP server (`team-slack-bridge/mcp/tools.local.js`) — posting,
DMs, scheduling, search, an idempotency ledger — none of which this document's earlier draft of section
14 had caught up to.

**Building bespoke supervisor-side Jira/Slack agents here would have duplicated real, working code.**
So: **`leo-mcp`** (new standalone sibling repo, `../leo-mcp/`) consolidates the MECHANICAL, deterministic
half of this roster into one MCP server:

- **`git_push`** — the exact fight-loop this section's item 2 already built (`agents/git-create-push.js`),
  ported to `leo-mcp/git/fight-loop.js` as a standalone, dashboard-independent copy. **Deliberate,
  tracked duplication, not an oversight** — this dashboard keeps its own copy for its lease-gated
  automated path (`git:identity` held across the whole call, section 20), and `leo-mcp`'s copy is for
  anyone/anything else that wants the same tool without the dashboard's SQLite/lease/capability system.
  Both copies' header comments point at each other and say so.
- **`slack_*` (21 tools)** — MOUNTED directly from `team-slack-bridge/mcp/tools.local.js`, not
  reimplemented. `leo-mcp` takes a `file:` dependency on `team-slack-bridge` and re-registers its real
  tool objects under one combined `tools/list`, so a caller gets git + Slack (+ Jira, below) over ONE MCP
  connection instead of two or three — the actual point of section 21's pooling reasoning, generalized
  from "don't duplicate copies of the same server" to "don't make a caller connect to N servers when one
  consolidated one will do."
- **`jira_create_ticket`** — a STUB, deliberately. `jira-automation`'s SKILL.md encodes this org's real
  custom-field IDs (sprint, acceptance criteria, area of impact, etc.) as prose, and porting them to code
  is exactly the reliability/token win this consolidation is for — but those IDs were read out of a
  skill file, never verified against a live Jira schema, and a wrong custom-field ID silently corrupts a
  REAL ticket rather than failing loudly. `leo-mcp/jira/tools.js` documents the field map and refuses to
  write anything until a human has checked it against `getJiraIssueTypeMetaWithFields` (the `atlassian`
  MCP already has this) and signed off. Unlike a bad git push (fails locally, nothing lost) or a bad
  Slack message (deletable), this is a different risk class and gets a stub instead of a guess.

**What stays a skill, not an MCP tool, and why:** both `git-create-push` and `jira-automation`'s
conversational halves — asking a human for a ticket number, drafting a summary from a diff, deciding
whether to open an MR — are JUDGMENT, which an MCP tool call (deterministic args in, deterministic
result out) cannot do. Those skills keep existing, unchanged, for a human's own interactive use; they are
candidates to eventually CALL `leo-mcp`'s tools for their mechanical steps instead of shelling out to
`git`/`gh`/`glab` themselves, so the conventions live in one place — not done yet, noted as a follow-up in
`leo-mcp`'s own README.

**Later, not now: ACP.** If `leo-mcp` is fronted by ACP instead of/alongside raw MCP, every harness
(Claude Code, Codex, OpenCode) could attach to the SAME resident process rather than each spawning its
own MCP client connection — the load-reduction case for consolidation, one level up. Flagged in section
9's own ACP note and `leo-mcp`'s README; not started.

### 16.2 The utility-task lane — do-and-forget sessions for narrow mechanical jobs

Added 2026-09-11, **BUILT the same day** (`domain/workflow-profiles.js`, `config/harness-defaults.js`,
`domain/capabilities.js`'s new `utility:awsquery` preset, `runtime/supervisor.js`'s `ensureWorkerPrincipal`
role->preset lookup; `runtime/test/utility-task-lane.test.js`, 4 cases, `npm test` exit 0 at 113 suites).
Not a new subsystem — a named configuration of things this document already specifies, so the pattern is
deliberate rather than reinvented per role each time someone wants a fifth one of these.

**CORRECTED 2026-09-11, same day: the lane was built but UNREACHABLE.** Two independent codex reviews
(`codexdoc/REVIEW-NOTES.md` finding 7) found that `domain/assignment.js`'s `isActionable` only ever
recognized `role === "coder" || role === "parentReviewer"` as "there is work to do" — a hardcode that
predates this section and had never heard of the four roles above, so `assignTask` refused every one of
these task types even with a correctly-configured worker present. Testing `rolesFor`/`ensureWorkerPrincipal`
in isolation (the paragraph above) was NOT sufficient evidence the lane worked; it never exercised
`assignTask` itself. **Fixed the same day**: `workflow-profiles.js` profiles now each declare their own
`workRoles` (which of their roles count as work-bearing), and `isActionable` looks that up per task type
instead of a hardcoded pair of names — so a fifth role added later declares its own answer rather than
silently falling through a condition nobody remembered to extend. Proven with a real end-to-end
`assignTask()` call that actually starts a run (`runtime/test/assignment.test.js` case 11), not just the
pieces in isolation.

**The shape:** a `type: "adhoc"` task (section 10 — single worker, no reviewer ceremony, the SAME
`start()`/`sendInput()` contract as everything else) whose worker is one of a small set of narrow
roles — `git-push-runner`, `jira-runner`, `awsquery-runner`, `slack-runner` are the first four, one per
skill/MCP surface this document already has (`git-create-push`/`jira-automation` skills, `awsquery`
skill, `leo-mcp`/`team-slack-bridge`). Each role:

- **Is single-purpose by construction**, the same "fixed toolset" discipline section 16's roster already
  keeps — a `git-push-runner` never picks up Jira access "just this once."
- **Defaults to a cheap model and `clearPolicy: "always"`** (section 8, Rules 5-6, already specified —
  `"utility": { "clearPolicy": "always" }` is the literal example already in that section). One
  operation per invocation; state lives in the task's worktree/handoff/journal, never in the session's
  own head. This is what "do and forget" is INTENDED to mean concretely: the session clearing itself
  costs nothing to reload because there was never anything worth keeping in it past the one operation.
  **CORRECTED 2026-09-13 (review-sol-2026-09-13.md finding 40) — this describes the TARGET behavior, not
  current behavior.** `clearPolicy` is declared and validated on every role in
  `config/harness-defaults.js` (schema-only, `HANDOFF.md`'s item 39), but nothing in the runtime reads
  that field to actually call `clearContext()`/`resume()` at any point — a utility session does NOT
  self-clear today, regardless of what its `clearPolicy` says. The decision module described here
  (`domain/clear-policy.js`) does not exist yet.
- **Delivers into the task's shared worktree** (section 7) when the job is git-shaped; a query-shaped job
  (`awsquery-runner`) has no worktree to deliver into and just returns its answer.
- **Never guesses on ambiguity — writes an `ask` instead, every time, no exception.** This is section 7's
  existing `asks` mechanism, not new mechanism: "what region," "that table doesn't match any known
  pattern," "which repo" all become a `blocked` task with a concrete question, answerable from the tree
  UI without interrupting whichever session asked for the work. The hard rule this section adds is
  specifically that a utility-task role has NO fallback interpretation to reach for — an under-specified
  request is always a question, never a best guess, because the whole point of a narrow role is that it
  has no judgment to spend guessing with.
- **Is dispatched BY another session, not run inline**, which is the actual token-economy point: a
  parent session that needs "what AWS region is this deployed to" delegates a small, cheap,
  clears-itself-after task instead of spending its own context running the query and reading raw output.
  The parent gets back a short structured answer (or an `ask` it can itself relay/answer), never the
  small session's own transcript — tier 1/tier 2's existing "no agent reads tier 1" rule (section 8)
  applies to a utility-task worker exactly as it does to any other.

**Nothing here changes `harness-defaults.json`'s shape** (section 3/11) — these are just four more role
keys with a cheap-model, always-clear default, the same file every other role's default already lives
in.

**Later, not now: a genuinely small resident model for this lane specifically.** The four roles above
are mechanical enough that a 3-4B-parameter local model could plausibly run them (git push, ticket
create, a scoped AWS read, a Slack post — Rule 6's "cheap and mostly deterministic" pushed further than
the CTO). Not evaluated yet, and not required for the pattern above to work today with a normal
harness/model at low effort — this is a future `harness-defaults.json` value once a viable local model
for the deployment machine is chosen, not an architecture change.

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
- **A resource lease is arbitration between cooperating sessions, never a guarantee**
  (section 20) — it cannot constrain a process the supervisor did not start, and a
  design that assumes otherwise is wrong in exactly the way section 38.1 is careful
  not to be about authorization.
- **MCP pooling and the lazy tool router (section 21) are optimizations with a
  fallback, not new hard dependencies.** A server that can't be pooled spawns
  per-session exactly as today; a session with no router still works, it just carries
  every configured server's full schema like it does now. Neither is allowed to become
  something the plugin breaks without, same rule as every optional integration.

## 20. Host resource arbitration & exclusive external resources

Everything above arbitrates *tokens* and *state*. Two failures on 2026-09-09 were about
neither: they were two sessions competing for one **machine**.

1. **Host memory.** Two independent AI sessions each started a webpack build. Both were
   individually reasonable; together they exhausted host memory. Section 8's Rule 7
   admission control could not prevent it, because `maxConcurrentSessions` is enforced
   per supervisor and each session's view of "how much is running" stops at itself.
2. **Git identity.** This machine has two GitHub accounts and **one** global credential
   state — `gh auth switch` rewrites shared config and HTTPS auth resolves through a
   single keychain entry (see the git section of HANDOFF). Two sessions pushing
   concurrently can therefore push as the wrong account, or one can flip the account out
   from under the other mid-push. Serializing pushes is not politeness; it is the only
   way the account a push lands under is knowable.

Both are the same shape: a scarce resource that lives **outside** any one run, contended
by parties that cannot see each other.

### 20.1 The primitive: a lease over a named resource

**BUILT, 2026-09-10.** One table, `resource_leases` (migration 0011, `release_reason`
added by migration 0012), and three supervisor commands — `acquireLease` /
`releaseLease` / `renewLease` (a third beyond this section's original pair, for a live
holder to push its TTL out) — gated by one capability, `resource:lease`, per section 16.
`config/resources.js` reads `resources.json` on demand, same contract as
`harness-defaults.js` (missing file -> built-in defaults, malformed file -> throws
loudly), with `git:identity` (exclusive) and `host:heavy-job` (counted, capacity 1,
`memoryHeadroomPercent: 15` default) as the built-ins. **Proven concurrently, not just
sequentially**: 8 real OS processes race an exclusive lease and a capacity-3 counted one
(`db/test/leases.test.js`), using `BEGIN IMMEDIATE` — the same mechanism
`db/migrate.js` already uses for its own schema-version race — because a plain
transaction only escalates to a write lock at the FIRST WRITE, which is too late for a
check-then-insert. Full record: ROADMAP Phase 7.

**CORRECTED 2026-09-11 — "proven concurrently" covered ACQUISITION, not the whole lease lifecycle, and
two independent codex reviews found real exclusivity/lifecycle gaps the initial acquire race did not
exercise** (`codexdoc/review-phase7-uncommitted.md`, `codexdoc/REVIEW-NOTES.md`, both finding 1 — the
same bug found twice, independently). **`renewLease` could resurrect an EXPIRED lease after a
replacement holder had already acquired the resource** — renewal checked only `released_at IS NULL`,
not that the TTL was still live, so a stale process's renewal could produce two active exclusive
holders. **Fixed the same day**: renewal is now conditional on `ttl_expires_at >= now`, atomically with
the update; an expired lease is never revived by ID and must go through normal admission control.
Two related lifecycle gaps fixed alongside it: **acquisition now refuses a `holderRunId` that has
already ended** (a lease could otherwise be granted for a closed run and never get released), and
**`endRun`/`reconcileRun` now release a run's leases in the SAME transaction as its terminal write**
(previously two separate statements — a crash or thrown error between them left an ended run with live
claims, unrecoverable by a retry). All three proven with real reproductions, verified to fail against
the pre-fix code (`db/test/leases.test.js` cases 10-13). **Two more fixed 2026-09-11**:
`createTaskWorktree`'s cross-process creation race (§7 below) is closed with a compare-and-swap claim,
and a worker-backed principal's `acquireLease`/`requestWorktree` now refuses a `runId` that resolves to
a DIFFERENT worker (`db/index.js`'s `workerIdForRun`) — owner/CTO principals remain unrestricted, that
delegation question is still not decided.
**A second, independent review (`codexdoc/review-luna-2026-09-11.md`) found the same TTL gap this note
used to list as deferred, plus a lock-timing detail — both fixed the same day.** `MAX_LEASE_TTL_MS` (30
minutes) and a shared `validateTtlMs` now reject a non-finite-positive-integer or over-max `ttlMs` in
BOTH `tryAcquireLease`/`renewLeaseRow` (throws — an in-process caller bypassing the wire layer is still
refused) AND the `acquireLease`/`renewLease` wire handlers (a clean `{ok:false}`, not an exception, for
ordinary wire traffic). `tryAcquireLease`'s expiry is now computed INSIDE its `BEGIN IMMEDIATE`
transaction rather than before it, so write-lock wait time can no longer eat into a short TTL before the
row is inserted. Proven with the exact `ttlMs: -1` → `granted: true` repro from the review, verified to
fail against the pre-fix code (`runtime/test/leases.test.js` case 9). See the codex files for the full,
still-growing fixed/deferred record — this note is not a substitute for reading them.

- **Two kinds.** *Exclusive* (one holder) and *counted* (a semaphore with a configured
  capacity). A resource is declared, not invented by its caller.
- **A lease is claimed before the side effect**, never after — the same rule the
  assignment path's idempotency keys already follow, and it must be tested
  concurrently, because a sequential pair of calls passes even when the claim is in the
  wrong place.
- **TTL plus heartbeat, persisted.** A holder SIGKILLed mid-lease must expire, not
  deadlock the queue. Same reasoning as `asks.auto_close_at` (section 4): an in-memory
  timer dies with exactly the process whose death is the failure being handled.
- **Visible, decided as a non-blocking refusal rather than a true FIFO queue.**
  Corrected 2026-09-10 on contact with the build: this is a multi-process daemon with no
  in-process wait to hold a caller's connection on, so `acquireLease` is a synchronous
  check-and-claim that REFUSES immediately and names every current holder
  (`blockedBy: [{leaseId, principalId, runId, reason, acquiredAt}, ...]`) rather than
  making the caller hang. There is deliberately no "position in line" — a `counted`
  resource is a semaphore, not a mutex queue, so "3rd in line" is not a well-defined
  question when up to `capacity` holders can be admitted in any order the moment one
  releases. "Nothing is happening" is still not an acceptable rendering of a wait — a
  caller sees exactly who to wait behind, just not a promised order.

Declared resources for v1:

```jsonc
// resources.json
{
  "host:heavy-job": { "kind": "counted", "capacity": 1 },   // builds, full suites, mutation runs
  "git:identity":   { "kind": "exclusive" }                 // one push at a time, machine-wide
}
```

`host:heavy-job` is claimed by anything a role declares heavy — a build, a full test
suite, a mutation run. `git:identity` is *designed* to be held across the **whole**
switch → push → restore triple, never across the push alone: the switch is the part that races.

**CORRECTED 2026-09-13 (review-sol-2026-09-13.md finding 36) — only the middle third of that triple is
actually built.** `git-create-push` (item 11, §16) acquires `git:identity`, runs `git push`, and
releases it — there is no `gh auth switch` call, no account selection/verification, and no restoration
of a prior identity anywhere in the fight loop. Serializing the push under the lease still prevents two
pushes from racing EACH OTHER, but it does not itself guarantee a push used the INTENDED account — that
still depends on whatever account `gh`/HTTPS auth already resolves to at push time, which this mechanism
does not select or verify. Treat account selection as an external precondition the operator/caller must
already have correct, not something this lease enforces.

### 20.2 Waiting is a pause, not a kill

Section 7's clean-vs-kill distinction governs here too. A worker that cannot get a lease
stays alive and idle with its task state unchanged; its pane says which resource it is
waiting for and who holds it. No silent retry loop, and never a kill-and-respawn — the
worker did nothing wrong, and killing it is how a queue becomes a work-loss mechanism.
When the lease is granted the worker resumes; if the wait exceeds its budget the result
is a blocker in the tier-3 handoff, which is a retryable state, not a failure.

**CORRECTED 2026-09-13 (review-sol-2026-09-13.md finding 39) — this whole subsection describes INTENDED
behavior; NONE of the automatic waiting it describes is built.** `acquireLease('host:heavy-job', ...)`
is the only real primitive: on contention it returns `{ granted: false, blockedBy: [...] }` immediately
and synchronously — there is no build/test task path that automatically retries it, no idle-pane state a
worker enters while waiting, no wait/resume loop, and no automatic handoff into a tier-3 blocker when a
wait exceeds a budget. A caller that wants any of that behavior has to build it itself on top of the
refusal today; this primitive alone does not prevent the concurrent-heavy-job incident this section's own
motivation describes. Treat every sentence above as the target shape for a not-yet-built consumer, not a
description of what `acquireLease` does now.

### 20.3 The supervisor cannot arbitrate what it did not start

This is the honest limit, and it is the same limit section 38.1 states about
authorization. A session a human started in another terminal, or another tool's build,
holds no lease and respects none. So:

- **Observe, don't assume. BUILT, 2026-09-10** (`runtime/supervisor.js`'s `acquireLease`):
  `os.freemem()`/`os.totalmem()` sampled on every `acquireLease('host:heavy-job')` call,
  REFUSING (not granting-with-a-warning — decided, and why: a resource named specifically
  to prevent an OOM incident that still granted under pressure would defeat its own
  purpose) below the configured headroom, with the sampled `{freeBytes, totalBytes,
  freePercent, headroomPercent}` surfaced on BOTH the grant and the refusal — a human
  sees the number, not just a pass/fail, either way. **Not built**: periodic re-sampling
  of a lease already held (only the moment of acquisition is checked today) — a real gap,
  not silently dropped: a long-held `host:heavy-job` lease that outlives a memory
  squeeze arriving mid-hold gets no warning until its next renew. Platform note: plain
  `os.freemem()`/`os.totalmem()` were used rather than macOS `vm_stat`'s richer breakdown
  — Node has no cross-platform binding for the latter, and adding a native one was
  rejected for the same reason `node-pty` was (section 9): this project has exactly one
  dependency on purpose.
- **When an unmanaged process is in the way, the answer is an `ask`.** The human is
  asked to pause the other sessions, as a machine-legible blocker on the task (section
  3's `asks`), not as a line buried in a pane. That ask is answerable, auto-closable,
  and queryable like every other one. **Not built**: `acquireLease` refusing/warning does
  not yet CREATE an `ask` row automatically — a caller (or a future CTO) has to do that
  itself today. The primitive exists; the wiring from "lease refused" to "ask raised" does
  not.
- **An adopted run can be asked to yield; it cannot be reaped for a lease.**
  `runs.started_by` already makes the distinction, and "the supervisor only kills what
  it started" is not negotiable for a resource dispute.

### 20.4 What this is not

Not accounting — section 19's existing carve-out for Rule 7's operational limits covers
it, and nothing here measures cost. Not a sandbox, and not a guarantee: a lease keeps
two *cooperating* sessions from colliding. A determined one, or a human with a terminal,
is outside its reach — which is why 20.3 exists rather than being a caveat.

## 21. MCP server pooling & lazy tool discovery

A second host-resource problem, distinct from section 20's leases but living beside
them: **every session that uses an MCP-backed tool spins its own copy of that MCP
server**, harness-native (Claude Code, OpenCode each launch their configured servers
per session) with no sharing. Ten concurrent workers each touching Jira duplicates ten
Jira MCP server processes for one logical service — the same host-memory failure mode
as section 20's webpack incident, just from configuration instead of a build. Separately,
and independently worth fixing even on one session: **every MCP server a session is
configured with puts its full tool schema set in front of the model up front**, whether
or not that turn needs any of it — the same tokens-vs-work tradeoff section 8 already
treats as a first-class problem for the transcript, just unaddressed for tool schemas.

### 21.1 Pooling — one resident process per distinct MCP server config

**BUILT 2026-09-11** (`runtime/mcp-pool.js`, migration 0013 adding `mcp_pool.status`/`.pgid` and a new
`mcp_pool_attachments` table, `db/index.js`'s `claimPoolSlot`/`attachToPool`/`detachAndMaybeDrain`/
`markPoolReady`/`markPoolFailed`/`markPoolStopped`/`listLivePoolRows`; `runtime/test/mcp-pool.test.js`,
6 cases). One resident process per distinct `(name, config_hash)` — spawned on first attach, torn down
by the LAST detach (never mid-use), and RESURRECTED (same row, same identity) on the next attach after
a full drain rather than inserting a new row, which the unique index on `(name, config_hash)` would
have refused anyway.

**Refcount is DERIVED from attachment rows, not a bare integer** — `codexdoc/REVIEW-NOTES.md`'s "Before
MCP pooling and lazy discovery" section named this explicitly ("a lone integer cannot explain a crash
between attach and increment"), and migration 0011's original `refcount` column is kept but unused for
exactly that reason.

**The last-detach-vs-new-attach race the same review section calls out** is closed by construction, not
by care: `attachToPool` only ever joins a row whose status is `starting`/`ready` (never `draining`), and
`detachAndMaybeDrain` flips `draining` atomically inside the SAME `BEGIN IMMEDIATE` transaction as its
"any attachments left" count — so a concurrent attach either committed its attachment row before the
drain decision ran (correctly NOT drained) or runs after `draining` committed (correctly refused, and
falls through to spawning a fresh cycle). Proved four ways: a deterministic interleaving test (manually
driving the two DB calls to the exact decision point, not a timing-dependent race), a real 8-process
race of the DB primitives alone, a 6-worker concurrent-async race of the FULL manager (real spawn/kill)
within one process, and boot-time reconciliation killing a real orphaned-but-alive process from a
"previous boot" it holds no in-memory handle for.

**One thing this manager does NOT solve, written down rather than discovered later**: a pooled process
serving multiple attachers gets ONE environment/credential set, fixed at spawn — it cannot hand a
different credential to each attacher, the same limitation OpenCode's own private `opencode serve` pool
already has. Only pool configurations whose credential/isolation semantics genuinely permit sharing.

**This generalizes `team-slack-bridge`'s own plan** (its MCP surface is one of four surfaces over one
core, per section 14) rather than replacing it — `leo-mcp` (section 16.1's new sibling repo, which
already mounts `team-slack-bridge`'s tools) is the first real pooled config; `gitnexus`/`aws-mcp`/
`agentmemory` are candidates for the same treatment once measured. **Fallback, not requirement:** an
MCP server that cannot be pooled falls back to today's per-session spawn — pooling is an optimization
layered on top of what already works, per section 19's rule for every optional integration, not a new
hard dependency the plugin breaks without.
**Wired into `start()`/`endRun` 2026-09-11 — the supervisor-side half is done.** A utility-task-lane
role that declares an MCP need (`domain/mcp-manifest.js`'s `ROLE_MCP_NEEDS`) now attaches BEFORE its
adapter spawns (`config/mcp-pools.js` resolves the pool's spawn config; `leo-mcp` is the real, working
first entry), and is detached when its run ends — normally (`endRun`, `releaseSession`) or via
boot-time reconciliation's `lost` path, matching the exact atomic-decision-then-async-teardown split
leases already use. Proved with 6 real cases (`runtime/test/mcp-pool-wiring.test.js`): a real
pool+attachment row exists after start; ending a run detaches it; a non-utility-task role is completely
untouched; two CONCURRENT utility-task runs of the same role share exactly one pool row with two
attachments; a run reconciled to `lost` gets its attachment detached by boot reconciliation; an
`adapter.start()` throw before a runId exists still detaches whatever was attached, not just a
`createRun()` failure.
**Corrected 2026-09-11 (found by an independent review, `codexdoc/review-luna-2026-09-11.md` finding
2) — an earlier version of this wiring ALSO put the pool-attachment marker onto `spec.mcpConfig` and
handed it to the real adapter. That was not merely "not yet shared" as first written here — checked
against the adapter's own `StartSpec` typedef (`mcpConfig?: string|string[]`, a real config FILE PATH
per entry) and `worker-env.js`'s argv builder, it would have pushed a non-string object into a real
`spawn()`'s argv the moment a utility-task role ever ran through the actual Claude Code adapter; OpenCode's
adapter would have thrown outright on the same value. Neither existing test caught it because both used
the fake harness, which never validates argv shape.** `start()` no longer sets `spec.mcpConfig` at all
for a utility-task role. `leo-mcp` gained a non-stdio (Unix socket) transport the same day
(`mcp/server-socket.js`) — a real, useful step, but it does not by itself answer whether Claude Code's
`--mcp-config` accepts anything other than a stdio command or an SSE/HTTP url, and nothing has measured
that yet; building a "real" config value here without measuring it first would have been another guess,
not a fix. **What's real today: the attach/detach lifecycle, the one-process-per-config guarantee, dead
processes no longer leaking stale attachments (see below) — everything EXCEPT a worker actually
receiving a usable MCP connection from it.** `config/mcp-pools.js` and `domain/mcp-manifest.js`'s own
header comments were corrected to stop describing a lever (`configPathFor`) that was never built.
**Also fixed the same day**: `hashPoolConfig` used to hash only top-level key NAMES (a `JSON.stringify`
replacer-array quirk), so two configs differing only in a nested `env` credential hashed identically —
closed with a real recursive canonical stringifier. And a dead pooled process used to leave its
attachment row live forever, blocking a resurrected replacement's own teardown — `markPoolFailed` now
closes every live attachment for that pool atomically with the failure write, proved with a real killed
child process.

### 21.2 Lazy discovery — don't put every tool's schema in front of every turn

**Investigated 2026-09-11, and the investigation changed the scope, honestly.** The original framing
assumed a harness-level "defer tool schemas until asked for by name" mechanism (modeled on this very
project's own `ToolSearch`-shaped deferred tools) might exist to hook into for a spawned worker session.
Checked against the real code before designing anything: `adapters/claude-code/worker-env.js` (measured
against the real `claude` CLI) shows the ONLY control this codebase has over a spawned session's MCP
tooling is `spec.mcpConfig` — an explicit file list, combined with `--strict-mcp-config` so nothing
outside it loads. **There is no per-turn, ask-for-it-by-name deferral available inside a spawned
session for arbitrary MCP servers** — that is a property of THIS session's own harness driving itself,
not something a sub-session's `--mcp-config` can opt into. OpenCode's adapter has no equivalent either.
**This is an honest ceiling on what's possible today, not a gap in what got built.**

**What's actually buildable given that ceiling, and BUILT**: `domain/mcp-manifest.js`'s `manifestForRole`
(pure, 4 test cases) computes the MINIMAL `spec.mcpConfig` set a role needs, by declared pool name
(section 21.1's pooled identities) — narrower than "every configured server," even though it is not
per-turn lazy discovery. A role absent from the declared map needs none; a declared pool name with no
registered config path is reported `missing`, never silently dropped, the same "never guess an
underspecified request" discipline section 16.2's utility-task lane already applies one layer up.
**Not wired into an actual spawned worker's `spec.mcpConfig` in this pass** — that needs a real decision
about where role->manifest resolution happens in the assignment path (`domain/assignment.js` /
`runtime/supervisor.js`'s `assignTask`), which is future work, not a design gap in this module.

**The pooled MCP layer (21.1) and the manifest module (21.2) are complementary, not the same
mechanism** — pooling saves host processes/RAM; a minimal manifest saves prompt tokens by bounding
which servers a role's `--mcp-config` ever names — and either can ship without the other, which is
exactly what happened here.

### 21.3 Where this lands

Utility agents (section 16) are the first and cleanest candidates: each already has a
**fixed, narrow toolset by construction** (jira-automation only ever needs its skill +
server; git-create-push only ever needs git/`gh`/`glab`), so a fixed capability router
per agent is a direct fit with no discovery ambiguity to design around. Workers are the
harder case — their tool needs vary by task — and come after, once the pattern is proven
on the roster. Neither depends on section 20's leases; they can build in either order,
though both are host-resource problems worth solving in the same pass as Phase 7's
roster work, since utility agents are exactly where the duplicate-MCP-process and
full-schema-dump costs are most avoidable.
