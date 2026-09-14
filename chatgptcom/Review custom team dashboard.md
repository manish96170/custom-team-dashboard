# Review custom team dashboard

## User

[

![Image](/images/ecosystem/apps/github/icon_dark.png)

GitHub](/plugins/plugin_connector_1p_1a69035c238881919c4190932b2df699?plugin_detail_origin=inline_selection_pill) Review this custom-team-dashboard this is a TUI based dashboard from where we manage all the coding ai assistant from the TUI and one can invoke teams on seperate projects/tasks and small global agents which do the stuff like git operations and via mcp hooks like mcp can be hooked up like we have another repo team-slack-bridge for slack operations like message send and listen other history message DM's. custom-team-dashboard we need to review.

## Assistant

I reviewed the current `main` of GitHub repo `manish96170/custom-team-dashboard`, including the latest Phase 7–10 runtime changes, MCP pooling/proxy, supervisor, IPC, TUI, adapters, worktree lifecycle, utility agents, preflight, authorization, and the previous review history.

My overall assessment: **the architecture is substantially stronger than the earlier version, but I would not call it production-ready yet.** The previous 14-finding MCP/worktree review has largely been addressed, including tool allowlisting, MCP fail-closed behavior, resume reattachment, real socket readiness, worktree claim recovery, and sibling-independent MCP tests.

The biggest remaining things I'd have your local AI investigate are below.

## My important findings

### 🔴 1. Preflight cleanup is conceptually right, but process termination isn't confirmed

This is important given exactly what you said about **test sessions not polluting real session history**.

The code already has a good design:

*   preflight uses `ephemeral: true`
    
*   Claude uses `--no-session-persistence`
    
*   OpenCode can discard the harness-side session
    
*   the DB preflight rows are deleted
    
*   `model_health` is retained because that's the useful result
    
*   the preflight run/event history is intentionally removed.
    

That's the right direction.

However, `discardPreflightRun()` calls:

1.  `adapter.stop(runId)`
    
2.  closes the pump
    
3.  calls `adapter.discardSession()`
    
4.  deletes the DB rows
    

There is **no explicit wait/verification that the actual OS process has exited before declaring cleanup complete**. Claude's `stop()` itself sends SIGINT and only schedules a later SIGKILL fallback; it doesn't synchronously mean the process is gone.

So the invariant should be stronger:

> A harness/model connectivity test must leave **zero test processes, zero test DB history, and zero harness-side session artifacts**, unless the harness explicitly has no persistent session mechanism.

I want this covered by a real regression test.

* * *

### 🔴 2. The TUI input decoder is not a real terminal stream parser

This is the most concrete TUI bug I see.

`decodeKey(chunk)` assumes one `data` chunk corresponds to one key:

```
if (s.length === 1) return s;
```

But terminal stdin is a byte stream, not a key-event API.

A single chunk can contain:

```
abc
```

or:

```
ESC [ A
```

or even half of an escape sequence.

Similarly, `decodeMouse()` expects the entire SGR mouse sequence to be in one chunk.

So this can break:

*   pasted text into the chat
    
*   rapid typing
    
*   multiple keys arriving together
    
*   arrow keys split across chunks
    
*   mouse reports split across chunks
    

The state layer is nicely designed around focus and pure actions. The missing piece is a **persistent terminal input parser/buffer** in `app.js`, not a change to the state architecture.

I'd definitely have the local AI build tests for fragmented and coalesced input.

* * *

### 🟠 3. TUI transcript memory is bounded per run, but not globally

The TUI deliberately keeps:

```
MAX_LINES_PER_RUN = 500
```

which is good.

But:

```
const transcripts = new Map()
```

is never cleaned when runs disappear.

So if the dashboard stays open for days and thousands of sessions/tasks are created:

```
run1 -> 500 lines
run2 -> 500 lines
...
run5000 -> 500 lines
```

all remain in memory.

For a dashboard whose purpose is to run **many concurrent agents**, this is worth fixing.

I'd prefer:

*   remove transcript state when the run no longer exists, **or**
    
*   global memory budget, e.g. max 10k/20k lines
    
*   preserve active/pinned runs preferentially
    
*   optionally retain a small recent history for ended runs.
    

* * *

### 🟠 4. `supervisor.js` is now ~269 KB and is becoming the architectural risk

The architecture is logically split into:

*   domain
    
*   DB
    
*   adapters
    
*   runtime
    
*   agents
    
*   TUI
    
*   config
    

which is good.

But `runtime/supervisor.js` itself is enormous — currently around **269 KB**.

It has accumulated:

*   process lifecycle
    
*   asks
    
*   reviews
    
*   MCP
    
*   Slack outbox
    
*   vault projection
    
*   preflight
    
*   worktrees
    
*   leases
    
*   git agent orchestration
    
*   authorization
    
*   CTO logic
    
*   TUI command surface
    
*   reconciliation
    
*   session management
    

The individual mechanisms are mostly separated, but the composition root is becoming a **god object**.

I would not do a giant refactor now. Instead, ask the AI to identify **natural extraction seams**, especially:

```
preflight-service.js
worktree-service.js
run-lifecycle.js
ask-service.js
review-service.js
utility-service.js
authorization/command wiring
```

while keeping `supervisor.js` as the composition root.

The rule should be:

> Don't refactor just to reduce line count. Extract when a subsystem has its own state machine, lifecycle, tests and invariants.

* * *

### 🟠 5. Shared worktree + multiple coding agents deserves another concurrency review

The project intentionally has a **shared task worktree**.

That's powerful, but it means:

```
coder A
coder B
reviewer
git-create-push
```

can potentially operate against the same filesystem.

The git agent itself explicitly acknowledges that default `git add -A` can stage somebody else's changes and provides `paths` to make it safer.

That's a warning sign worth investigating further.

The architecture needs a very clear answer to:

> What prevents two agents from simultaneously modifying the same worktree while one agent is running `git-create-push`?

The existing `git:identity` lease protects the push operation, but **a lease around pushing isn't necessarily a lock around editing**.

I would ask the local AI to model races such as:

```
coder modifies A
reviewer modifies B
git agent stages
coder modifies C during staging
git agent commits
```

and:

```
coder A
coder B
both run formatter
both modify package-lock
git-create-push
```

This is more important than micro-optimizing Node code.

* * *

### 🟠 6. `resetSession` / resume has a possible TOCTOU state transition worth testing

`resume()` checks:

```
task.state
```

and refuses if the task is terminal. Then later it performs the actual reopen.

The DB's `reopenRun()` independently updates the run:

```
WHERE run_id = ? AND ended_at IS NOT NULL
```

but doesn't atomically bind that operation to the task still being non-terminal.

The normal flow is fine, but a concurrent scenario should be tested:

```
T1: resume(run)
T2: approve/merge task
T1: reopenRun(run)
```

The question is whether a terminal task can ever end up with a newly reopened run.

This is exactly the kind of race the project is otherwise very good at preventing, so I'd add a concurrency regression.

* * *

### 🟠 7. MCP proxy should be treated as a security boundary, not merely a transport shim

The new proxy is much better now: it filters `tools/list` and blocks unauthorized `tools/call` names.

However, I would have the AI specifically test:

*   duplicate tool names
    
*   malformed `tools/call`
    
*   missing `params.name`
    
*   JSON-RPC notifications
    
*   JSON-RPC batches
    
*   weird Unicode tool names
    
*   very large MCP frames
    
*   proxy disconnect during request
    
*   pooled server disappearing during an active call
    
*   reconnect attempts
    
*   tool-list mutation after initial discovery
    

The proxy deliberately implements only a subset of JSON-RPC awareness. That's reasonable, but because it is now **the security boundary between an agent and a powerful MCP server**, its assumptions should be explicit and regression-tested.

* * *

### 🟡 8. The CTO is still not actually implemented

This is not a code bug, but it matters for the product definition.

The TUI has:

```
chatTarget: "cto"
```

and the UX is designed around a CTO chat.

But the latest architecture work explicitly says the **real CTO run does not yet exist**; the current implementation has the decision logic but not the actual LLM-backed CTO agent/routing layer.

So today the product is better described as:

> **Supervisor/TUI for orchestrating agents, with CTO UX designed but CTO intelligence not yet wired.**

That's fine if intentional. Just don't let documentation imply that:

```
"tell the CTO: assign X"
```

already works end-to-end.

* * *

## And your test-session requirement

I **agree completely** with your requirement and would make it a formal architectural invariant.

The current preflight work is already moving in exactly that direction, which is good.

I'd make the requirement:

### Harness preflight/test session lifecycle

```
create ephemeral test
        ↓
start harness
        ↓
send minimal probe prompt
        ↓
observe successful/failed turn
        ↓
record ONLY model_health
        ↓
stop process
        ↓
WAIT / VERIFY process is actually dead
        ↓
delete harness-side session if one exists
        ↓
delete run/task/worker/event history
        ↓
verify nothing test-related remains
```

And critically:

**Do not use the normal historical session as the test session.**

For Claude:

```
--no-session-persistence
```

is preferable to deletion.

For OpenCode or another harness where persistence is unavoidable:

```
create
→ test
→ explicitly delete by known session ID
→ verify deletion
```

No enumeration/deletion of unrelated user sessions.

That should also apply to **future harness adapters**, not just Claude/OpenCode.

* * *

# Prompt for your local AI

I've turned the review into a prompt that I would give your local coding agent. It deliberately tells it **not to blindly refactor or change architecture**, and to prove every bug with a regression test first.

Custom Team Dashboard — Deep Code Review & Hardening Prompt

You are reviewing the current `main` branch of:

`manish96170/custom-team-dashboard`

This is a TUI-based supervisor/dashboard for orchestrating many concurrent Claude Code/OpenCode sessions as a virtual engineering team.

The architecture includes:

*   supervisor daemon
    
*   SQLite single-writer persistence
    
*   Unix-socket IPC
    
*   Claude Code and OpenCode adapters
    
*   task/team/worker model
    
*   reviews and approval workflow
    
*   MCP server pooling
    
*   MCP stdio/socket proxy
    
*   capability-based authorization
    
*   utility agents such as git-create-push
    
*   shared task worktrees
    
*   resource leases
    
*   preflight/model health checks
    
*   Slack outbound integration
    
*   Obsidian vault projection
    
*   TUI state/layout/input handling
    

Do a fresh, independent code review of the CURRENT code. Do not assume previous review documents are correct merely because they say something was fixed.

The goal is not simply "npm test passes".

The goal is:

> Find bugs, race conditions, lifecycle leaks, security boundary violations, performance problems, incorrect state transitions, and architecture problems that can appear under real concurrent use.

Do NOT make broad refactors just for aesthetics.

For every finding:

1.  determine whether it is actually a bug;
    
2.  trace the complete execution path;
    
3.  construct a concrete failure scenario;
    
4.  inspect whether an existing test really protects it;
    
5.  if possible, write a regression test that fails against the current code;
    
6.  only then propose/fix the smallest architectural change;
    
7.  rerun the relevant tests;
    
8.  run the full suite afterward.
    

\==================================================

1.  FIRST: ESTABLISH CURRENT BASELINE  
    \==================================================
    

From `supervisor/`:

*   run `npm test`
    
*   record exact suite count
    
*   record failures/flakes
    
*   inspect for leaked processes after tests
    
*   inspect temporary files/socket files left behind
    
*   inspect DB files created during tests
    
*   run the suite twice if practical
    

Do not consider "exit 0" sufficient.

Check:

*   child processes
    
*   MCP processes
    
*   proxy processes
    
*   Unix sockets
    
*   temporary worktrees
    
*   temporary DBs
    
*   harness sessions
    

Also inspect:

*   `git status`
    
*   recent commits
    
*   current documentation claims
    
*   current TODO/ROADMAP/HANDOFF claims
    

The repository contains extensive previous review notes.

Treat them as historical evidence, not as proof.

Re-verify especially:

### MCP

*   role-specific tool allowlisting
    
*   `tools/list` filtering
    
*   `tools/call` blocking
    
*   MCP pool readiness
    
*   pool lifecycle
    
*   pool cleanup
    
*   pool crash handling
    
*   concurrent attachers
    
*   resume reattachment
    
*   fail-closed MCP delivery
    
*   degraded-MCP opt-in
    
*   preflight MCP exclusion
    
*   socket permissions
    
*   stale socket cleanup
    

### Worktrees

*   create/discard races
    
*   stale claim recovery
    
*   crash during create
    
*   crash during discard
    
*   boot recovery
    
*   terminal-task behavior
    
*   shared worktree concurrency
    

### Process ownership

*   detached process groups
    
*   PID reuse
    
*   PGID reuse
    
*   start-time verification
    
*   process death races
    
*   kill confirmation
    
*   orphan detection
    
*   adopted sessions
    
*   supervisor crash/restart
    

If a previous finding really is fixed, do not report it again.

This is a hard product requirement.

When testing whether a harness/model connection works, the system may create a temporary run/session.

That test session MUST NOT become normal historical work.

Desired lifecycle:

```
create ephemeral test
      ↓
start harness
      ↓
send minimal probe prompt
      ↓
observe result
      ↓
persist only model_health
      ↓
stop process
      ↓
VERIFY process is actually dead
      ↓
delete harness-side test session if persistence occurred
      ↓
delete test run/task/worker/event history
      ↓
verify nothing test-related remains
```

For Claude Code:

*   prefer `--no-session-persistence` where supported.
    

For OpenCode/other persistent harnesses:

*   use the exact known session ID created by this preflight;
    
*   delete only that session;
    
*   never enumerate and delete arbitrary sessions;
    
*   verify deletion.
    

IMPORTANT:

`adapter.stop()` returning is NOT automatically proof that the OS process has exited.

Review `discardPreflightRun()` carefully.

The current code appears to:

*   stop the adapter
    
*   close the pump
    
*   discard the harness session
    
*   delete DB rows
    

but you must verify whether the underlying process is actually dead before cleanup is reported as complete.

Construct a real test:

1.  start preflight;
    
2.  make the harness take enough time to expose cleanup timing;
    
3.  finish/timeout;
    
4.  invoke cleanup;
    
5.  verify the process is gone;
    
6.  verify no run remains;
    
7.  verify no event history remains;
    
8.  verify no harness session remains;
    
9.  verify no MCP pool remains attached;
    
10.  verify no test socket remains.
     

If cleanup can return successfully while a process/session is still alive, fix it.

The invariant should be:

> A successful preflight cleanup means there is no remaining test process and no remaining test session artifact.

Also test cleanup on:

*   successful probe
    
*   model error
    
*   timeout
    
*   spawn failure
    
*   process crash
    
*   supervisor shutdown
    
*   supervisor crash/restart
    
*   adapter `stop()` failure
    
*   adapter `discardSession()` failure
    

The useful model-health result must survive even if cleanup fails.

Review:

`supervisor/tui/app.js`

especially:

*   `decodeKey`
    
*   `decodeMouse`
    
*   `onInputData`
    

The current decoder appears to assume one stdin `data` chunk represents one complete key/event.

That is not a valid terminal-stream assumption.

Test:

### Coalesced input

A single chunk containing:

```
abc
```

must become three printable characters when chat has focus.

### Fragmented escape sequence

For example:

```
ESC
[A
```

arriving in separate chunks must become `up`.

### Coalesced escape sequence

A complete:

```
ESC[A
```

must become `up`.

### Multiple keys

A single chunk:

```
jjjj
```

must perform four navigation actions.

### Mouse fragmentation

A complete SGR mouse event split across multiple chunks must still decode correctly.

### Chat

Pasted text must not accidentally execute global keybindings.

### UTF-8

Multi-byte characters split across chunks must not become corrupted.

Do not solve this by making `decodeKey()` itself globally stateful.

Prefer a small dedicated terminal input parser with an internal buffer/state machine, keeping `state.js` pure.

Add tests first.

Review:

`transcripts = new Map()`

and:

`MAX_LINES_PER_RUN = 500`

The per-run limit is good, but determine whether the map can grow indefinitely as thousands of runs come and go.

Test a long-lived TUI with many historical runs.

Determine:

*   when transcript state is removed;
    
*   whether ended/deleted/preflight runs remain in memory;
    
*   whether a run that disappears from the supervisor snapshot remains in memory;
    
*   whether the dashboard has a global memory bound.
    

Propose a bounded strategy.

Possible acceptable approaches:

*   remove transcripts for runs no longer visible/known;
    
*   global maximum line budget;
    
*   LRU retention;
    
*   special retention for currently selected/pinned runs.
    

Do not destroy useful active-session transcript state.

This is a major area.

The architecture intentionally allows multiple workers to operate against one shared task worktree.

Review races such as:

```
coder A modifies file A
coder B modifies file B
reviewer modifies file C
git-create-push stages
coder A modifies file D during staging
git-create-push commits
```

Also:

```
coder A runs formatter
coder B runs formatter
both modify package-lock.json
git-create-push stages/commits
```

And:

```
reviewer starts
coder resets/clears context
git-create-push starts
worktree is discarded
```

Determine exactly what is protected by:

*   resource leases
    
*   worktree claims
    
*   git
    
*   task state
    
*   process lifecycle
    

Do NOT assume a push lease is equivalent to an edit lock.

If concurrent modification is intentionally allowed, document why and what correctness guarantees exist.

If not, identify the missing synchronization mechanism.

The git-create-push implementation explicitly warns that default `git add -A` can stage changes from other workers.

Determine whether the architecture can accidentally commit another worker's changes.

This needs regression tests.

Review:

`resume()`

and:

`reopenRun()`

Current logic checks task state before reopening the run.

Investigate this race:

```
T1: resume(run)
T2: approve/merge/cancel task
T1: reopenRun(run)
```

Determine whether a terminal task can ever end up with a reopened/live run.

Do not rely only on sequential tests.

Create a deterministic concurrency test using barriers/hooks/injected delays.

If necessary, make the DB operation atomically verify the task's current state.

Preserve the existing invariant:

> A terminal task must never acquire/reopen an active run.

Review:

`supervisor/runtime/mcp-stdio-proxy.js`

This is now a security boundary, not merely a transport helper.

Test:

*   unauthorized `tools/call`
    
*   authorized `tools/call`
    
*   missing tool name
    
*   malformed params
    
*   malformed JSON
    
*   notifications
    
*   JSON-RPC responses
    
*   `tools/list`
    
*   duplicate tool names
    
*   unexpected tool metadata
    
*   very large messages
    
*   fragmented JSON frames
    
*   multiple JSON messages in one chunk
    
*   socket disconnect during request
    
*   pooled server crash
    
*   proxy crash
    
*   pool restart
    
*   stale socket
    
*   socket replacement/race
    
*   malicious tool name values
    
*   Unicode tool names
    
*   JSON-RPC batch messages if the supported protocol permits them
    

Verify that the proxy cannot accidentally forward a disallowed tool through any alternate message shape.

Determine whether "no --allow-tools" should really remain a permissive fallback.

If this script is only intended to be invoked by the supervisor, strongly consider making the secure behavior the default rather than preserving a potentially unsafe unrestricted fallback.

Do not change this without checking all existing callers/tests.

Review the complete pool state machine:

```
absent
  ↓
starting
  ↓
ready
  ↓
draining
  ↓
stopped/failed
```

Test:

*   two simultaneous attachers
    
*   10+ simultaneous attachers
    
*   first spawner crashes
    
*   first spawner starts slowly
    
*   socket appears late
    
*   socket appears as regular file
    
*   server binds then immediately exits
    
*   detach during attach
    
*   last detach while another attach is racing
    
*   supervisor shutdown during spawn
    
*   supervisor crash during spawn
    
*   supervisor restart
    
*   stale socket
    
*   stale DB row
    
*   kill failure
    
*   kill timeout
    
*   child process forks descendants
    

Every state transition should have one authoritative owner.

A pool must never be marked dead while its process is still alive.

A pool must never be joinable while its socket is not actually usable.

A pool must never have live credentials in an unmanaged process after cleanup is reported successful.

Review:

`runtime/spawn.js`  
`runtime/reconcile.js`  
`runtime/procinfo.js`

Pay special attention to:

*   PID reuse
    
*   PGID reuse
    
*   process group ownership
    
*   detached children
    
*   forked descendants
    
*   child exits during identity verification
    
*   identity timeout
    
*   SIGTERM/SIGKILL races
    
*   concurrent reaps
    
*   supervisor shutdown
    
*   child already exited
    
*   child spawned through `npx`, shell, wrapper, or another process manager
    

Important question:

If identity verification times out and the code only kills the direct child by PID, can descendants survive?

The intended invariant is:

> If the supervisor reports that it cleaned up a managed process, no descendant belonging to that process group remains alive.

Prove that with a test involving a child that forks another process.

Review:

`supervisor/ipc/server.js`  
`supervisor/ipc/protocol.js`

Existing line-size protection is good.

Now inspect:

*   maximum number of concurrent commands per connection;
    
*   maximum number of active `observe` streams;
    
*   response buffering/backpressure;
    
*   slow clients;
    
*   many unique correlation IDs;
    
*   one connection flooding commands;
    
*   one connection consuming all supervisor attention;
    
*   long-lived observe streams;
    
*   socket disconnect during handler execution.
    

A local Unix socket is still a security boundary.

Determine whether one authenticated principal can create an unbounded number of expensive concurrent operations.

If limits are required, make them explicit and test them.

Review:

`domain/capabilities.js`

and all wire command registration.

Verify:

*   every wire command has exactly one declared capability;
    
*   no command accidentally bypasses `authorizedCommandHandlers()`;
    
*   new commands fail closed;
    
*   principal identity always comes from authenticated state;
    
*   request arguments cannot choose their own capability;
    
*   sensitive approvals are bound to exact arguments;
    
*   worker cannot impersonate another worker;
    
*   utility roles cannot access unrelated MCP tools;
    
*   CTO cannot accidentally gain repository/external side effects;
    
*   owner-only capabilities really are owner-only.
    

Construct malicious requests rather than only normal requests.

Review:

`supervisor/agents/git-create-push.js`

Pay special attention to:

*   `git add -A`
    
*   explicit paths
    
*   path traversal
    
*   target branch handling
    
*   remote handling
    
*   protected branches
    
*   concurrent changes
    
*   failed commit
    
*   commit succeeds / push fails
    
*   push succeeds / PR creation fails
    
*   remote unreachable
    
*   remote divergence
    
*   retry behavior
    
*   autofix scripts
    
*   autofix script timeout
    
*   autofix script modifying unexpected files
    
*   infinite fixer behavior
    
*   partial staged state
    
*   stale worktree
    
*   concurrent git operations
    

The fight loop must never claim a successful push if it cannot prove it.

It must never silently lose a commit.

It must never push unrelated worker changes simply because they happen to exist in the shared worktree.

Review:

*   review rounds
    
*   revision binding
    
*   quorum
    
*   distinct reviewer counting
    
*   adversarial finding verification
    
*   changed-path profile selection
    
*   current HEAD resolution
    
*   git diff failure
    
*   review after new commit
    
*   stale reviewer verdict
    
*   reviewer reassignment if/when supported
    

Pay special attention to any "fail open" behavior.

A failure to determine which files changed should not accidentally weaken a deliberately stricter review profile unless that is an explicit product decision.

Review:

`runtime/slack-outbox.js`

Verify:

*   idempotency
    
*   crash between send and mark-delivered
    
*   duplicate delivery
    
*   bridge failure
    
*   bridge timeout
    
*   Slack unavailable
    
*   malformed bridge response
    
*   process killed while draining
    
*   concurrent drainers
    
*   ordering requirements
    
*   permanent vs transient failures
    

The dashboard must never create duplicate Slack actions simply because it crashed after the external action but before recording delivery.

Review:

`runtime/vault-projector.js`

Verify:

*   no credentials
    
*   no prompt text
    
*   no raw transcripts
    
*   no secrets
    
*   no accidental `SELECT *`
    
*   deletion of stale notes
    
*   concurrent projection scheduling
    
*   shutdown while projection is pending
    
*   filesystem errors
    
*   symlink/path traversal
    
*   synced-folder protection
    
*   vault path escaping
    
*   partial writes/corrupt markdown
    

The vault must remain strictly derived and never become a second source of truth.

Do a dedicated performance pass.

Find unnecessary:

*   synchronous filesystem calls in hot paths
    
*   synchronous git operations
    
*   synchronous DB operations around long-running work
    
*   repeated full-table queries
    
*   repeated process inspection
    
*   duplicate config loads
    
*   duplicate MCP discovery
    
*   unnecessary TUI redraws
    
*   overlapping refreshes
    
*   sequential operations that could safely run concurrently
    

But DO NOT parallelize operations that have correctness dependencies.

For each proposed parallelization:

1.  identify current ordering dependency;
    
2.  prove operations are independent;
    
3.  add concurrency test;
    
4.  benchmark before/after.
    

Focus on real latency:

*   starting an agent
    
*   attaching MCP
    
*   TUI refresh
    
*   review execution
    
*   git-create-push
    
*   task assignment
    
*   shutdown
    

Review the ~269KB `runtime/supervisor.js`.

Do not perform a cosmetic refactor.

Instead identify natural extraction seams.

Potential candidates:

*   preflight lifecycle
    
*   worktree lifecycle
    
*   run lifecycle
    
*   ask management
    
*   review orchestration
    
*   utility task orchestration
    
*   command authorization wiring
    

For each candidate explain:

*   state owned
    
*   dependencies
    
*   public interface
    
*   tests
    
*   whether extraction reduces coupling or merely moves code around
    

Only extract if the boundary is genuinely useful.

Verify current reality of the CTO layer.

The TUI currently has a CTO chat concept, but the current roadmap/review indicates the actual CTO LLM run/routing layer is not yet instantiated.

Do not accidentally make documentation claim that natural-language CTO routing is fully implemented.

Clearly separate:

*   TUI chat UX
    
*   typed supervisor commands
    
*   CTO decision logic
    
*   actual CTO model execution
    
*   natural-language routing
    

Do not build the CTO unless this review task specifically requires it.

Check:

*   README.md
    
*   PLAN.md
    
*   ROADMAP.md
    
*   TODO.md
    
*   HANDOFF.md
    
*   TUI-GUIDE.md
    
*   runtime/FINDINGS.md
    

Look for statements that contradict current code.

Especially:

*   MCP is fixed vs not implemented
    
*   CTO exists vs doesn't exist
    
*   preflight cleanup
    
*   Slack outbound
    
*   Obsidian projection
    
*   worktree lifecycle
    
*   utility agents
    
*   current phase status
    

Historical findings should remain useful but clearly marked as historical/superseded.

The project has a large test suite.

Do not measure quality by test count.

Look for:

*   tests that only assert exit 0
    
*   tests that silently skip
    
*   tests without timeouts
    
*   tests leaking processes
    
*   tests depending on developer-local sibling repos
    
*   tests that don't actually exercise the real path
    
*   tests that prove happy path only
    
*   sequential tests where race behavior matters
    
*   mocks that bypass the important boundary
    

For every important state machine, require:

*   happy path
    
*   failure path
    
*   timeout
    
*   crash
    
*   concurrent path
    
*   restart/recovery path
    

Use real processes where process ownership is the thing being tested.

Use fixtures where external sibling repositories should not be required.

Produce a review with:

### A. Executive summary

*   overall architecture health
    
*   production-readiness assessment
    
*   biggest risks
    

### B. Findings

For every real finding:

*   severity: Critical / High / Medium / Low
    
*   file
    
*   function/area
    
*   exact failure scenario
    
*   why existing tests don't catch it
    
*   recommended fix
    
*   regression test
    
*   whether it is a correctness, security, reliability, performance, or maintainability issue
    

Do NOT report speculative issues as bugs.

### C. Confirmed-good areas

Explicitly list areas that you inspected and found sound.

This prevents repeatedly reopening already-fixed issues.

### D. Product gaps vs code bugs

Separate:

*   actual bugs
    
*   missing features
    
*   intentional design tradeoffs
    
*   documentation problems
    

Do not mix them.

### E. Prioritized implementation plan

Group fixes:

1.  must fix before real use
    
2.  should fix before wider use
    
3.  performance/hardening
    
4.  architecture cleanup
    
5.  future product features
    

### F. Regression-test plan

List exact tests to add.

### G. Final verification

After fixes:

*   full `npm test`
    
*   relevant targeted tests
    
*   process-leak check
    
*   socket-leak check
    
*   test-session cleanup check
    
*   concurrent stress checks
    
*   git diff/status
    

Do not claim success unless the actual commands support it.

IMPORTANT:

Do not blindly trust comments saying "verified" or previous review files saying "fixed".

Trace the current code.

For every important finding, prefer a reproducible test over an argument from inspection.

### Bottom line

I would **not restart the architecture**. The supervisor + SQLite + adapters + capability layer + MCP pool direction is solid. The project has also done something I particularly like: many previous race findings were turned into explicit state/invariant tests rather than just comments. The DB is also correctly locked down to `0700`/`0600`, and WAL/concurrency handling is thoughtfully implemented.

My priority order now would be:

**1\. Preflight/test-session cleanup guarantee → 2. TUI stream parser → 3. shared-worktree concurrency → 4. process/MCP teardown stress → 5. resume/task race → 6. TUI memory → 7. supervisor extraction.**

And I would **not spend time optimizing tiny synchronous operations yet**. The dangerous problems here are lifecycle/concurrency problems, not raw CPU performance.

