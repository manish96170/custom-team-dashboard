# Correctness and Architectural Risk Review

> **STALE SNAPSHOT — dated 2026-09-11, NOT regenerated since. Corrected 2026-09-13
> (review-sol-2026-09-13.md finding 45).** Read as a dated historical account; `HANDOFF.md`'s top header
> is the current-state source of truth.

Reviewed 2026-09-11 against the current working tree. This review focuses on
`supervisor/db`, `lock`, `ipc`, `adapters`, `runtime`, `domain`, `pane`, `tui`,
`agents`, and `config`, with special attention to MCP pooling and the utility-task
lane. The existing test suite and handoff report substantial coverage; passing
tests are not treated as proof of contracts that the current production path does
not exercise.

## Findings

### 1. Blocking: the MCP pool is not yet a shared worker connection

`runtime/mcp-pool.js` owns a child process connected by stdio to the supervisor.
`runtime/supervisor.js` puts `{ name, poolId }` entries into `spec.mcpConfig`, but
the Claude worker environment expects MCP configuration paths and emits
`--mcp-config <path>`. A separately spawned worker cannot dial the supervisor's
stdio stream. If it names the same command/configuration, it creates a second
MCP process, defeating pooling. The implementation correctly describes this
limit in `config/mcp-pools.js`, but the field shape can still be mistaken for a
working connection by future callers.

**Impact:** utility starts can report a pool attachment while the worker has no
usable shared MCP channel. A utility capability may therefore look provisioned
without delivering its tool.

**Required direction:** add a real non-stdio transport or an authenticated
supervisor-side broker/proxy, define its per-attachment session semantics, and
make the adapter consume a transport endpoint rather than pool metadata. Until
then, either keep the path explicitly experimental or fail utility starts that
require an unavailable MCP connection instead of starting without the tool.

### 2. Should-fix: declared MCP attachment failure is non-fatal

In `start()`, a missing pool configuration or failed `mcpPool.attach()` is logged
and the run still starts. This preserves supervisor availability, but it creates
a semantic mismatch for a fixed-tool utility role: `git-push-runner`,
`jira-runner`, or `slack-runner` can run without its declared MCP dependency.
There is no structured start result saying that the utility is degraded, and the
bare generic prompt does not explain the missing tool.

**Required direction:** make dependency policy explicit per role. A required MCP
dependency should produce `start-failed` (or a visible degraded start with a
typed reason) rather than a warning-only success. Test both missing config and
spawn failure through the authorized production command path.

### 3. Should-fix: accepted crash window before `run_id` backfill

The attachment must be created before `adapter.start()` so spawn-time config is
available, but the attachment's foreign key cannot receive `run_id` until
`createRun()` commits. A daemon crash in that short interval leaves an open
attachment with `run_id IS NULL`. The current boot pool reconciliation handles
the pool process, but it has no direct run owner to use when cleaning that
attachment.

**Required direction:** add an explicit start-attempt/attachment owner identity,
or make the reservation recoverable by principal plus start generation and age.
At minimum, boot should report and reclaim orphaned null-run attachments rather
than relying on a later full pool lifecycle. The current comment documents this
as an accepted gap; it should remain visible in operational diagnostics.

### 4. Should-fix: pool recovery kills rather than reattaches after daemon restart

`reconcileOnBoot()` intentionally treats every persisted `starting`/`ready` row
as unusable because the in-memory child handle and streams do not survive a
restart. It kills a verified live process and marks it `failed`. This is safe and
honest, but it means a daemon restart interrupts every pooled utility server and
requires the next attach to respawn it.

**Impact:** restart recovery is availability-preserving, not continuity-
preserving. Any in-flight external operation using a pooled server needs its own
retry/receipt story.

**Required direction:** either document this as a deliberate interruption
boundary in the utility contract, or build a reconnectable MCP transport with
server/session identity, health checks, and generation fencing. Do not add a
simple “reuse PID” path without restoring stream ownership and validating start
time/PGID/config identity.

### 5. Blocking before broad utility dispatch: utility work is still only partly composed

The utility profiles and `workRoles` gate are real, and assignment now reaches a
dedicated utility role. However, the lane still lacks meaningful runner
instructions, a convenience dispatch command, durable external operation receipts,
and a complete zero-review completion policy. The generic assignment prompt is
only `Task <id> (<type>), role <role>.` A utility worker therefore does not receive
the operation contract, permitted inputs, expected output, or ambiguity policy
from the dashboard.

**Impact:** the profile/capability machinery can start a process without making
the intended utility operation executable or safely auditable. This is more than
UX: external side effects need idempotency, receipt persistence, and unknown-
outcome reconciliation.

**Required direction:** prove one complete local utility task over the authorized
socket: create/resolve task, assign, prepare context, deliver the actual tool,
perform the operation, persist receipt, finish, release resources, and clean up.
Add operation intent before side effect and explicit retry state before Jira or
Slack dispatch.

### 6. Should-fix: the git utility remains unsafe by default on a shared worktree

`runFightLoop()` supports explicit `paths`, which is useful and tested, but
omitting `paths` still runs `git add -A`. The default task worktree is shared by
coders and reviewers, so unrelated dirty files can enter the utility commit.
The `git:identity` lease protects credential state, not repository contents or
the reviewed change set.

**Required direction:** require an explicit change set or a persisted reviewed
commit boundary for shared-task pushes. Verify repository, branch, expected HEAD,
and intended paths server-side. Persist the resulting commit SHA and operation
stage. Treat the current optional `paths` parameter as an escape hatch, not as a
completed safety boundary.

### 7. Should-fix: synchronous git work blocks the supervisor event loop

The fight loop uses synchronous child execution for git, hooks, autofix, and
optional PR work. Multiple attempts can occupy the daemon thread for tens of
seconds. During that period IPC requests, ask handling, lease heartbeats, pool
teardown, and other utility starts cannot progress. The loop also does not renew
its lease while it runs.

**Required direction:** move the operation to a supervised asynchronous child/job
with bounded output, cancellation, heartbeat, and a durable operation record.
Define what happens when the lease expires or the child loses ownership. Do this
before using `host:heavy-job` for real concurrent workloads.

### 8. Should-fix: task/run/worktree lifecycle remains separately stateful

`discardTaskWorktree()` now refuses an open run, and `createTaskWorktree()` has a
deterministic cross-process claim. Those fixes close the previously demonstrated
destructive deletion and duplicate-creation defects. The broader lifecycle is
still not atomic: task transitions, run termination, dirty-tree disposition, and
overlay cleanup are separate operations. `requestWorktree()` returns an overlay
path but does not provide a durable overlay attachment/disposition or move the
running process to it.

**Required direction:** record worktree ownership and overlay lifecycle, verify
all consumers before discard, and define preservation/discard behavior for dirty
changes. Persist task/assignment identity on each run rather than deriving task
membership solely through the worker's current assignment.

### 9. Should-fix: authorization is command-scoped, not complete object scope

Recent fixes bind worker-backed lease and worktree requests to the authenticated
worker run, bind review verdicts to the principal's worker, and classify
protected branch pushes server-side. Those are important corrections. The
capability gate still does not by itself restrict every command to a task, run,
repository, or attachment owned by the caller. The owner/CTO delegation model
also remains intentionally broad.

The review has already identified raw tier-1 transcript exposure through
`tuiSnapshot` to a registry-capable principal and worker self-answer/attribution
policy as open concerns. These are not fixed by adding another capability name.

**Required direction:** separate human transcript reads from agent context reads,
derive answer attribution from the authenticated principal, and add object-level
authorization for utility operations. Bind sensitive approvals to canonical
destination and content/commit identity, not only command arguments.

### 10. Minor: transport and output bounds are incomplete

The IPC server bounds individual frames and tracks sockets, and the event pump
uses a bounded event-count buffer with explicit gap reporting. The remaining
bounds are not byte bounds: socket write queues, completed-run state, adapter
event logs, persistent raw history, and full TUI snapshot enumeration can still
grow or do work proportional to historical state.

**Required direction:** add byte budgets, paginated snapshots, retention/redaction
at ingestion, and one shared client transport contract that rejects all pending
requests exactly once on close, timeout, malformed input, or overflow.

## Positive Invariants Worth Preserving

- Pool identity is `(name, config_hash)`, and concurrent claimers cannot create two rows for one configuration.
- Attachment-derived counts make pool refcount recoverable after a crash.
- `draining` is not joinable, closing the last-detach/new-attach race at the database decision point.
- Pool processes use verified PID/PGID ownership and zombie-aware kill checks.
- Utility role capability presets are narrow and tested negatively against other role capabilities.
- Assignment claims idempotency before spawning and keeps successful partial starts.
- Run terminal writes are first-writer-wins; deliberate terminal intent prevents a derived stream error from hiding the cause.
- Lease renewal no longer resurrects an expired lease, and terminal run cleanup releases leases transactionally.
- Standalone pane authentication now uses the same owner-token mechanism as the TUI.

## Verification Gaps

The MCP tests prove database races, real pool spawn/kill, concurrent same-config
sharing, and detach on run end/lost reconciliation. They do not prove a real
Claude/OpenCode worker can connect to the pooled process, because the required
non-stdio transport is absent. The utility wiring tests use the fake harness and
skip when the sibling `leo-mcp` repository is unavailable. Real external Jira,
Slack, AWS, and PR operations remain outside the normal suite and need receipt-
aware integration tests before being enabled.
