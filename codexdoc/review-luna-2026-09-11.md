# Luna Review: Uncommitted Phase 7 Changes

> **STALE SNAPSHOT — dated 2026-09-11, NOT regenerated since. Corrected 2026-09-13
> (review-sol-2026-09-13.md finding 45).** Individual findings below carry their own "Fixed 2026-09-1x"
> notes where resolved at the time; the surrounding prose is a dated snapshot. `HANDOFF.md`'s top header
> is the current-state source of truth (all 9 findings here are marked fixed there, per items 22/24).

Reviewed 2026-09-11 from the current working tree. I first read
`codexdoc/review-phase7-uncommitted.md` and `codexdoc/REVIEW-NOTES.md`, then ran
`git --no-pager diff` and `git status --short` in the repository. The review
concentrated on `resource_leases`, the task-worktree claim, MCP pooling and
migration 0013, and utility-task integration into `start()`/`endRun`.

## Findings

### 1. Blocking: MCP config hashing shares processes across different credentials

**Location:** `supervisor/runtime/mcp-pool.js:39`

`hashPoolConfig()` passes only the top-level property names as the
`JSON.stringify` replacer. Nested object keys and values are therefore omitted.
In particular, two pool configurations that differ only in `env` hash to the
same identity. That contradicts the stated `(name, config)` isolation rule and
can put one caller's credential-bearing MCP process in the pool used by another
caller.

**Repro:**

```sh
cd supervisor
node --input-type=module -e '
import { hashPoolConfig } from "./runtime/mcp-pool.js";
const a = hashPoolConfig({command:"node", args:["server.js"], cwd:"/tmp", env:{TOKEN:"one"}});
const b = hashPoolConfig({command:"node", args:["server.js"], cwd:"/tmp", env:{TOKEN:"two"}});
console.log(a, b, a === b);
'
```

Observed output ends in `true`. The same happens for nested configuration
objects with behaviorally different values. Canonicalize the complete
configuration recursively, including an explicit credential-material identity,
without logging or storing plaintext secrets. Add a regression with different
`env` values and different nested settings.

**Fixed 2026-09-11.** `hashPoolConfig` now recursively sorts object keys at every nesting
level via a hand-written canonical stringifier (`JSON.stringify`'s replacer-array form was
the bug: it allow-lists key NAMES at every level, so a nested key like `env.TOKEN` is
dropped unless `"TOKEN"` also happens to be a top-level key). Re-ran the exact repro above
after the fix: `a === b` is now `false`. Regression: `runtime/test/mcp-pool.test.js` case 7
(differing nested `env`, differing nested non-`env` settings, and same-values-different-key-
order all covered). Verified to fail against the pre-fix code before restoring the fix.

### 2. Blocking: the MCP pool is not actually connected to the worker MCP client

**Location:** `supervisor/runtime/supervisor.js:1084-1094`,
`supervisor/config/mcp-pools.js:15-25`

`start()` gives the adapter `mcpConfig` entries such as
`{ name: "leo-mcp", poolId: "mcp-..." }`. Claude Code's adapter contract and
`worker-env.js` expect config file path strings and pass each value directly to
`--mcp-config`; OpenCode rejects per-run `mcpConfig` altogether. The pooled
process itself is spawned with stdio owned by the supervisor and no socket or
proxy is exposed to the worker. Thus the new pool row/attachment bookkeeping is
not a usable shared MCP connection. The fake harness tests only inspect the
spec and never execute either real adapter boundary.

**Repro:**

1. Configure a valid `leo-mcp` pool and start a `git-push-runner` through the
   real Claude adapter.
2. Observe the generated spec contains an object in `mcpConfig`.
3. Trace `settingSourcesArgv()`: it emits `--mcp-config`, followed by that
   object, rather than a readable MCP config path. With OpenCode, the adapter
   rejects the same spec before spawning.
4. Independently inspect the pooled child: its stdin/stdout remain attached to
   `mcp-pool.js`; no worker transport reaches it.

Do not advertise the attachment as a worker MCP capability until there is a
real broker/socket transport and per-attachment authorization. Otherwise fail
the utility start closed instead of starting a run that was declared to have a
tool it cannot use.

**Fixed 2026-09-11 — took the "fail closed on the marker" option, not the
"build a real transport" one, and verified the reason against the adapter's
own contract rather than guessing.** Checked `adapters/claude-code/adapter.js`'s
`StartSpec` typedef directly: `mcpConfig?: string|string[]` — a real config FILE
PATH per entry, confirming this finding's read of `worker-env.js` exactly.
`runtime/supervisor.js`'s `start()` no longer sets `spec.mcpConfig` at all for a
utility-task role — the attach/detach LIFECYCLE still runs for real (a genuine
pool row + attachment exists, proven in `mcp-pool-wiring.test.js`), but nothing
resembling a usable MCP config reaches the adapter. `leo-mcp` gained a non-stdio
(Unix socket) transport the same day, but that alone doesn't answer whether
Claude Code's `--mcp-config` accepts anything other than a stdio-command or an
SSE/HTTP url entry — nothing in this repo has measured that, so building a
"real" config here would still have been a guess, not a fix. `config/mcp-pools.js`
and `domain/mcp-manifest.js`'s header comments were corrected to stop describing
a `configPathFor` lever that was never built. Regression:
`runtime/test/mcp-pool-wiring.test.js` case 1 now asserts `spec.mcpConfig` is
`undefined` (previously asserted the opposite — the pre-fix assertion was
itself proof of the bug once this finding's contract-check made it visible).

### 3. Blocking: dead MCP processes leave live attachments and prevent safe teardown

**Location:** `supervisor/runtime/mcp-pool.js:113-119`, `:159-170`,
`supervisor/db/index.js:1959-1961`

When a pooled child exits unexpectedly, the exit handler marks the pool
`failed` but does not detach its attachment rows. Boot reconciliation does the
same after killing an orphan. A later attach resurrects the same pool row and
adds a new attachment while the old attachment still counts as live. Detaching
the new client then sees a nonzero count and does not drain the process. A
stale attachment can therefore leak the replacement process indefinitely; a
crash in the pre-run-ID backfill window makes the same problem permanent
because the row has `run_id = NULL` and can never be found by run cleanup.

**Repro:**

1. Attach to a long-lived pool and retain the returned attachment ID.
2. Kill the pooled child outside `pool.detach()`; wait for its exit handler.
3. Verify the row is `failed` but the original attachment still has
   `detached_at IS NULL`.
4. Attach again. The row is resurrected and a second live attachment is added.
5. Detach the second attachment. `shouldTeardown` is false because the first
   stale row remains live, and the replacement child remains running.
6. Repeat with a SIGKILL between `createRun()` and `setAttachmentRunId()`;
   the orphaned attachment has no run owner for `endRun` or reconciliation to
   release.

Process generation and attachment ownership must be reconciled together. On
failure, atomically close attachments for that generation or invalidate the
   pool row so they cannot count against a resurrected process. The
   pre-run-ID path needs a durable start/attachment operation or a transaction
   that can be recovered after restart.

**Fixed 2026-09-11, the failure-atomicity half.** `db/index.js`'s `markPoolFailed`
now closes every live attachment for that pool row in the SAME transaction as
the `failed` write (one commit, not two a crash could split — same discipline
already applied to `endRun`/leases). Called from all 3 sites that mark a pool
failed (the `attach()` catch path, the exit handler, and boot reconciliation),
so a resurrected pool's own later `detach()` is never blocked by a ghost
attachment. Regression: `runtime/test/mcp-pool.test.js` case 8 — a real child
killed outside `detach()`, confirms the stale attachment is closed, then proves
the REPLACEMENT process's own last detach correctly triggers teardown (the
exact failure mode described above). Verified to fail against the pre-fix code.
**The pre-run-ID / SIGKILL-between-createRun()-and-setAttachmentRunId() half is
not separately addressed here** — that window is documented elsewhere
(`setAttachmentRunId`'s own doc comment) as an accepted sub-millisecond gap; this
fix closes the "attachment outlives its dead process" failure mode, not that gap.

### 4. Should-fix: `start()` leaks MCP attachments when adapter startup throws

**Location:** `supervisor/runtime/supervisor.js:1084-1097`

MCP attachments are created before `adapter.start(spec)`, but the cleanup
`try/catch` begins only after `adapter.start()` returns a run ID. If adapter
startup throws, none of the attachment IDs are detached. The pool process and
attachment remain live even though no `runs` row exists. The existing cleanup
test covers a failure in `createRun()`, not a failure from `adapter.start()`.

**Repro:**

1. Use a valid temporary `mcp-pools.json` entry whose command is a long-lived
   local Node process.
2. Use an adapter whose `start()` throws after the supervisor has attached to
   the pool.
3. Call `supervisor.start()` and catch the error.
4. Query `mcp_pool_attachments`: the attachment remains open, and the pool
   child remains live.

Put the adapter start call inside the same compensation scope as `createRun`,
or detach all pre-run attachments in a `finally` whenever no run was
successfully persisted. This must also handle a synchronous throw before a
run ID is available.

**Fixed 2026-09-11.** `runtime/supervisor.js`'s `start()` had NO try/catch at all around
`adapter.start(spec)` — a throw there propagated straight out with no cleanup path for the
attachment(s) made just before it. Now wrapped: any throw detaches every `mcpAttachmentIds`
entry (fire-and-forget, same convention the `createRun`-failure path just below it already
uses) before re-throwing. Regression: `runtime/test/mcp-pool-wiring.test.js` case 6 (a fake
harness configured to throw on `start`, a real prior attach to leo-mcp, confirms the
attachment is detached with `run_id` still null). Verified to fail against the pre-fix code.
**One flake caught by this project's own "re-run before believing green" rule while adding
the test**: case 6 passed standalone every time but crashed the WHOLE node process under
full-suite load (`TypeError: The database connection is not open`) — the fire-and-forget
detach's real process kill, and the spawned child's own separate async `'exit'` handler, could
both still be settling after the test's assertions passed, racing the test's own `finally`
closing the database. Fixed by having the test wait for the pool to reach a terminal status
plus a short settle buffer before `finally` runs, not by changing the fire-and-forget
convention itself. Re-verified: 3 clean full-suite runs after the test fix.

### 5. Blocking: the worktree claim does not bind the result to requested repo/branch

**Location:** `supervisor/runtime/supervisor.js:2946-2948`, `:2962-2993`

The CAS marker prevents two callers from running Git simultaneously, but an
existing result is returned solely by checking that its path exists. The
caller-provided `repoPath` and `branch` are not compared with the registered
worktree's canonical repository and branch. A conflicting caller can therefore
receive `{ created: false }` for a worktree in a different repository or on a
different branch, then operate under a false assumption about what it claimed.
The losing side of the pending-claim poll has the same problem.

**Repro:**

1. Create task `t`.
2. Call `createTaskWorktree("t", { repoPath: repoA, branch: "ctd/a" })`.
3. Call it again with `{ repoPath: repoB, branch: "ctd/b" }`.
4. Observe success returning repoA's path and branch, without refusing the
   mismatch. Run the two calls in separate processes to show the same result
   across the CAS boundary.

Persist and compare canonical repository identity, path, and branch as part of
the reservation/result. A mismatch must be refused, not silently treated as
idempotent success.

**Fixed 2026-09-11.** Migration 0014 adds `tasks.worktree_repo_path`, set at CLAIM time (not just
finalize) by `claimTaskWorktreeSlot`/`db/index.js` — so the mismatch check applies to the
still-pending side of the CAS, not only an already-finalized worktree, closing exactly the "losing
side of the pending-claim poll has the same problem" half of this finding. `createTaskWorktree`
canonicalizes `repoPath` via `path.resolve` once up front and compares it (and, if the caller
supplied one, `branch`) against the persisted value on every path through the function, refusing
with `worktree-repo-mismatch`/`worktree-branch-mismatch` rather than returning `{ created: false }`
for a different caller's worktree. Regression: `runtime/test/worktree.test.js` case 11 — a
conflicting `repoPath` and a conflicting `branch`, both against an already-finalized worktree and
against a still-pending claim (asserted to refuse in well under the poll budget, not after waiting
it out). Verified to fail against the pre-fix code (temporarily disabled both mismatch checks;
case 11 failed exactly as this finding's repro describes) before restoring the fix.

### 6. Blocking: a crashed worktree creator leaves a permanent pending marker

**Location:** `supervisor/runtime/supervisor.js:2949-2959`,
`supervisor/db/index.js` worktree claim helpers

`WORKTREE_CLAIM_PENDING` has no owner, timestamp, generation, or recovery
operation. If the winning process dies after claiming and before
`finalizeTaskWorktreeSlot()` or `releaseTaskWorktreeClaim()`, every later
caller waits about two seconds and returns `worktree-claim-pending` forever.
The CAS closes the simultaneous Git race, but it converts a process crash into
an availability deadlock.

**Repro:**

1. Start a real process calling `createTaskWorktree()`.
2. Kill it after `claimTaskWorktreeSlot()` commits and before the final task
   update (a barrier in the child around the Git call makes this deterministic).
3. Query `tasks.worktree_id`; it is `WORKTREE_CLAIM_PENDING`.
4. Retry from a fresh process; it times out/refuses every time, even if no Git
   worktree exists.

Store a claim owner and start time and implement a validated stale-claim
recovery/reconciliation path. If Git may already have completed, recovery must
inspect the canonical repo/branch before clearing or adopting the marker.

**Fixed 2026-09-11.** New `reclaimStaleTaskWorktreeClaim` (`db/index.js`) atomically reclaims a
`WORKTREE_CLAIM_PENDING` row once it has sat unfinalized past `STALE_WORKTREE_CLAIM_MS` (60s,
deliberately far above a real `git worktree add`'s own 30s timeout — this is "the claimant
probably crashed," not "the claimant is slow"), refreshing `updated_at` inside the same `BEGIN
IMMEDIATE` a concurrent reclaimer's own read would see, so only one recoverer ever wins. The
recoverer then inspects the deterministic `.git/ctd-worktrees/<taskId>` path on disk before acting:
if a real linked worktree is already there (the dead claimant's git call landed before it died),
it ADOPTS the existing worktree via `finalizeTaskWorktreeSlot` rather than redoing the work; if
nothing is there, it runs the real `git worktree add` itself. Finding 5's repo/branch identity,
persisted at claim time, is checked before ever reaching the stale-recovery branch, so a reclaim can
never adopt or redo work under a caller-supplied repo/branch that disagrees with the original
claim. Regression: `runtime/test/worktree.test.js` case 12 — both the "redo" and "adopt" shapes,
simulated by claiming directly via `claimTaskWorktreeSlot` and backdating `updated_at` rather than
actually sleeping 60s. Verified to fail against the pre-fix code (forced `reclaimStaleTaskWorktreeClaim`
to always report `reclaimed: false`; case 12 reproduced this finding's exact permanent-deadlock
symptom, `worktree-claim-pending` forever) before restoring the fix.

### 7. Blocking: discard-versus-start is still a check-then-delete race

**Location:** `supervisor/runtime/supervisor.js:3028-3046`,
`assignTask()` at `:2273-2350`

The new open-run check is correct for the point-in-time state it observes, but
it is not coordinated with starting a new run. `discardTaskWorktree()` checks
for open runs, then performs `git worktree remove --force`; `assignTask()` can
start a run for the same terminal task without acquiring a shared teardown
reservation. A start that lands between those operations can be deleted
underneath a live worker. `assignTask()` also has no terminal-task rejection.

**Repro:**

1. Put a task in `merged`, with a valid shared worktree and an assigned idle
   worker.
2. Pause `discardTaskWorktree()` after its open-run SELECT.
3. Call `assignTask()` for the same task from another process and let its
   `start()` complete.
4. Resume discard. It removes the worktree despite the newly open run.

Use one task/worktree lifecycle reservation for create, discard, assignment,
and restart. Reject assignment to terminal tasks unless an explicit reopen
transition exists; otherwise the current open-run check cannot be a safety
boundary.

**Fixed 2026-09-11, the practical half this finding itself names as sufficient (its second
sentence), not the general unified-reservation redesign (its first).** `assignTask()` now refuses
outright when `isTerminal(task.state)` — there is no reopen transition anywhere in this codebase, so
a terminal task can no longer grow a brand-new open run under any caller, which is the only way
`assignTask()` could ever have raced `discardTaskWorktree()`'s open-run check in the first place;
the repro (assign a `merged` task while discard is mid-flight) is no longer reachable because the
assign half of it is refused before it ever calls `start()`. **Deliberately not built**: a single
shared lifecycle reservation spanning create/discard/assign/restart, which would also matter for a
future "reopen a terminal task" transition that does not exist today — tracked as still open should
that transition ever get built. Regression: `runtime/test/worktree.test.js` case 13 — `assignTask`
against a `merged` task refuses with `task-terminal` and starts nothing. Verified to fail against
the pre-fix code (temporarily disabled the guard; case 13 reproduced a real `start-failed` plan
attempt against the terminal task) before restoring the fix.

### 8. Should-fix: forced discard still destroys cleanly-unowned uncommitted work

**Location:** `supervisor/runtime/supervisor.js:3044-3053`

The prior review's open-run case is fixed, and the targeted case passes, but
the operation still unconditionally runs `git worktree remove --force`. A
terminal task with no open run and an uncommitted file is reported as
successfully discarded and the file is deleted. The new check protects live
workers, not data preservation.

**Repro:**

1. Create a task worktree and write an uncommitted file into it.
2. Move the task to `cancelled`, `failed`, or `merged`; ensure no run is open.
3. Call `discardTaskWorktree()`.
4. Observe `{ discarded: true }` and that the uncommitted file is gone.

Make destructive cleanup explicit, or refuse dirty trees and require an
archive/commit/disposition. If force removal is retained, require a separate
capability and durable audit record rather than treating it as ordinary
cleanup.

**Fixed 2026-09-11, the "refuse dirty trees" option.** `discardTaskWorktree` now runs `git status
--porcelain` against the worktree before removing it; a non-empty result refuses with
`worktree-dirty` unless the caller explicitly passes `{ force: true }` (wired through the
`discardTaskWorktree` wire command as `cmd.force === true`, so a caller cannot get force behavior
by accident). **Not built**: a separate capability or durable audit record for the forced path — the
existing `task:worktree` capability and the generic `agent_journal` entry every command already
gets cover it, and this finding's own text treats a dedicated capability as an alternative to the
refuse-by-default behavior ("if force removal is retained"), not an additional requirement once it
is. Regression: `runtime/test/worktree.test.js` case 14 — an uncommitted file blocks a default
discard, and `force: true` still removes it. Verified to fail against the pre-fix code (temporarily
disabled the dirty check; case 14 reproduced this finding's exact repro, `{ discarded: true }` with
the uncommitted file silently gone) before restoring the fix.

### 9. Should-fix: invalid lease TTLs still produce false successful grants

**Location:** `supervisor/db/index.js:1753-1755`, `:1842-1848`,
`supervisor/runtime/supervisor.js:3574-3576`

The prior review correctly fixed renewal of an already expired lease, but the
TTL input remains unchecked. A negative or zero `ttlMs` can be accepted and
returned as `granted: true` even though the lease is immediately inactive.
The same issue exists for renewal, and a caller can provide an arbitrarily long
TTL that defeats the intended crash-recovery bound. The wire handler only
checks that the value is an integer; the DB primitive is also callable directly.

**Repro:**

1. Call authorized `acquireLease` with `ttlMs: -1` for `git:identity`.
2. Observe `ok: true`/`granted: true`.
3. Immediately call `listActiveLeases()` or acquire the same resource from a
   second principal; the first claim is absent/nonblocking.

Reject finite positive integers in both DB primitives and the wire path, apply
a documented maximum, and calculate expiry after the write lock is acquired
so lock wait time cannot consume a short TTL before insertion.

**Fixed 2026-09-11, all three asks.** New `MAX_LEASE_TTL_MS` (30 minutes) and a
shared `validateTtlMs` helper in `db/index.js`, used by both `tryAcquireLease`
and `renewLeaseRow` — a negative, zero, or over-max `ttlMs` throws at that layer.
The wire handlers (`acquireLease`/`renewLease` in `runtime/supervisor.js`) ALSO
validate before ever calling those primitives, returning a clean `{ok:false}`
refusal instead of letting an exception surface for ordinary wire traffic —
defense in depth, not reliance on one layer. `tryAcquireLease`'s expiry timestamp
is now computed INSIDE its `BEGIN IMMEDIATE` transaction, not before it, so
write-lock wait time can no longer eat into a short TTL before the row is
inserted (`renewLeaseRow` is a single UPDATE with no separate read-then-write
step, so it had no equivalent lock-wait gap to close). Regression:
`runtime/test/leases.test.js` case 9 — negative/zero/over-max all refused
cleanly at the wire layer with `git:identity` confirmed to remain unacquired
after each attempt, a valid TTL still works at both acquire and renew, and the
DB primitives independently throw for an in-process caller that bypasses the
wire layer. Verified to fail against the pre-fix code (reproduced the exact
`ttlMs: -1` → `granted: true` scenario from this finding's own repro) before
restoring the fix.

## Fixes that held up

The following prior fixes were confirmed by source inspection and targeted
tests, and I found no contrary result in this pass:

- `renewLeaseRow()` checks the old expiry in the same conditional update.
- `tryAcquireLease()` refuses a supplied run that is already ended.
- `endRun()` atomically updates the run and releases its leases.
- `reconcileRun()` releases leases while terminalizing a lost run.
- The worktree CAS permits only one concurrent Git creator for the same stale
  task slot.
- `discardTaskWorktree()` refuses when an associated worker run is currently
  open.
- Worker-backed principals cannot name another worker's run in lease or
  overlay requests.

Those tests prove the individual mechanisms, not the lifecycle and generation
boundaries above.

## Verification

Passed targeted commands:

```text
node db/test/leases.test.js
node runtime/test/worktree.test.js
node runtime/test/mcp-pool.test.js
node runtime/test/utility-task-lane.test.js
node runtime/test/mcp-pool-wiring.test.js
```

The MCP wiring suite is built around the fake harness and therefore does not
validate the real adapter's `mcpConfig` contract. The worktree suite validates
matching concurrent callers, not conflicting repo/branch arguments or a
creator killed after the claim. The MCP pool suite has no credential-varying
hash test, no crashed-child attachment test, and no attachment created before
run-ID backfill crash test.
