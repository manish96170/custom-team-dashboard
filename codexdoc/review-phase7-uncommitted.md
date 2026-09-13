# Phase 7 uncommitted implementation review

> **STALE SNAPSHOT — dated 2026-09-11, NOT regenerated since. Corrected 2026-09-13
> (review-sol-2026-09-13.md finding 45).** "Do not build further on this version yet" and every finding
> below describe the tree as it was on 2026-09-11 — every finding this file raised was fixed the same
> day (`HANDOFF.md` item 24). `HANDOFF.md`'s top header is the current-state source of truth.

Reviewed the working tree on 2026-09-11. I ran `git --no-pager diff` and `git status --short`, then inspected the relevant tracked changes, untracked implementations, migrations, tests, and existing lifecycle/authorization callers. Scope: migrations 0011/0012, task worktrees, resource leases, and release-on-end. The later git agent, utility lane, TUI, and documentation changes are excluded from the findings.

**Do not build further resource coordination on this version yet.** Initial lease acquisition serializes correctly, but renewal breaks exclusivity, worktree creation has no cross-process ownership claim, and terminal task state does not make forced worktree deletion safe. Authentication and command capability mapping work; run-scoped authorization and lifecycle validation are incomplete.

Severity: **blocking** means an exclusivity/core-contract violation or destructive safety failure; **should-fix** means an important recoverable correctness or authorization defect. Findings below include concrete reproductions and the change needed.

## Findings

1. **blocking — `supervisor/db/index.js:1738`: renewal resurrects an expired lease after a replacement holder has acquired the resource.**

   Acquire exclusive `git:identity` for A with a past expiry, leave it unswept, and acquire it for B. B correctly succeeds because acquisition ignores expired rows. Now renew A: the update checks only `released_at IS NULL`, so it succeeds too. My probe returned `renewed: true` and **two active exclusive leases**. The counted resource can exceed capacity by the same sequence. This requires no simultaneous calls; separate processes can produce precisely this ordering, so the initial acquire transaction cannot prevent it.

   Make renewal conditional on the existing lease still being unexpired at renewal time, atomically with the update. An expired lease must be reacquired through admission control; it must never be revived by ID. Add both the ordered expiry/replacement/renew case and a real process race between renewal and replacement acquisition. Callers must treat failed renewal as loss of authority to continue protected work.

   **Fixed 2026-09-11.** `renewLeaseRow` (`supervisor/db/index.js`) now requires `ttl_expires_at >= now` in the same conditional UPDATE, atomically with the check. An expired lease can no longer be renewed by ID; the caller must reacquire through `tryAcquireLease`. Regression: `supervisor/db/test/leases.test.js` case 10 (expire A, acquire B, attempt to renew A — renewal fails, B remains sole holder), verified to fail against the pre-fix code.

2. **blocking — `supervisor/runtime/supervisor.js:2789`, `:2816`: the shared task worktree has no cross-process claim, and both creators can report success.**

   Two processes read the same task with `worktree_id = NULL`. Each calls `createTaskWorktree` with a different valid `repoPath`, which the API currently accepts. Git creates a worktree in each independent repository; both unconditional task updates succeed. Both callers receive `created: true`, but only the last path remains registered. A caller can begin work in the losing tree while later workers attach to the winning tree.

   I reproduced this using **two real Node processes, separate SQLite connections, and real Git repositories**, with a barrier immediately after each task SELECT to force the vulnerable schedule. Both returned different paths with `created: true`; the database retained only one. With identical repo/path arguments, Git normally prevents the second physical creation, but the loser returns a Git failure instead of the promised idempotent result. Git's per-repository locks do not enforce the per-task database invariant.

   Claim the task's worktree operation before running Git using cross-process coordination, bind that claim to the canonical repository/path/branch, and make losers observe the claimed operation/result. Coordinate discard and task restart against the same ownership mechanism. A conditional final UPDATE alone is insufficient unless the losing Git side effect is safely reconciled. Add real process races with both matching and conflicting arguments; `runtime/test/worktree.test.js` currently makes only sequential API calls.

   **Deferred, out of scope for this pass.** `createTaskWorktree` still has no cross-process claim mechanism. Needs a conditional-UPDATE reservation pattern (claim the task's worktree slot before running git, bind the claim to the canonical repo/path/branch) — a bigger change than this pass's scope.

   **Fixed 2026-09-11.** `db/index.js` gained `claimTaskWorktreeSlot`/`finalizeTaskWorktreeSlot`/`releaseTaskWorktreeClaim` — a compare-and-swap claim (`WORKTREE_CLAIM_PENDING` marker, atomic `BEGIN IMMEDIATE`) that `createTaskWorktree` (`runtime/supervisor.js`) now takes BEFORE running any git command; a caller that loses the claim polls (bounded, ~2s) for the winner's real result instead of racing it. Regression: `runtime/test/worktree.test.js` case 9 (6 real processes racing the full `createTaskWorktree` call — integration-level, but NOTE: measured to pass 3/3 times against the pre-fix code too, since local git is fast enough that natural OS scheduling rarely produces the actual overlap) plus case 10, which FORCES the vulnerable interleaving deterministically with two barriers (one after the read, one before the claim attempt), matching this finding's own reproduction technique exactly ("a barrier immediately after each task SELECT to force the vulnerable schedule") — verified case 10 fails against a deliberately-broken CAS condition (8/8 "won" instead of 1/8) and passes with the real fix. Case 9 is kept as a real-world integration check despite not being deterministic; case 10 is what actually proves the mechanism.

3. **blocking — `supervisor/runtime/supervisor.js:2834`, `:2849`: terminal task state permits forced deletion underneath an open run, including its uncommitted files.**

   Have an open run assigned to a task's shared worktree, leave uncommitted files there, and move the task to `cancelled`, `failed`, or `merged`. Task state and run termination are separate: for example, `mergeTask` records the state transition without stopping runs. `discardTaskWorktree` checks only `isTerminal(task.state)`, then executes `git worktree remove --force`. My fixture retained **one open run**, returned successful discard, and deleted its uncommitted file. A worker token could perform this on another terminal task as well, consistent with the deliberately broad capability grant.

   The non-terminal check is therefore not the safety backstop described by the new capability comment. Refuse removal while runs still use the tree, coordinate that check against new starts/restarts across processes, and avoid unconditional forced deletion of dirty worktrees. If destructive cleanup is needed, distinguish it explicitly from ordinary cleanup. Test a terminal task with a still-live worker and a discard-versus-restart race. The probe used an open run row rather than spawning a harness process; the existing merge path confirms that terminal task state does not imply process termination.

   **Fixed 2026-09-11.** `discardTaskWorktree` (`supervisor/runtime/supervisor.js`) now also refuses when any run joined via `workers.task_id` has `ended_at IS NULL`, regardless of the task's own terminal state. Regression: `supervisor/runtime/test/worktree.test.js` case 7 (terminal task + open run refuses discard; discard succeeds once the run ends), verified to fail against the pre-fix code.

4. **should-fix — `supervisor/runtime/supervisor.js:3043`, `:2882`: authenticated callers can bind operations to another worker's run.**

   `acquireLease` derives the principal from authentication but accepts `runId` unchanged. `requestWorktree` similarly looks up any supplied run; its `principal` is used only for journaling. Neither checks the run's worker against the authenticated principal's `workerId`.

   Through `authorizedCommandHandlers`, my worker-A token acquired a lease associated with worker B's run. Ending B released A's lease while A remained the principal that had been granted it. The same A token successfully created an overlay for B's run. This is distinct from the explicitly chosen coarse create/discard capability: the run APIs describe ownership by the requesting run, but do not enforce that association.

   For worker-backed principals, resolve or validate the run from the authenticated worker identity; define any owner/CTO delegation separately. Keep principal-only leases available for genuine non-run callers. Cover a valid token targeting a foreign run, not just an invalid token or a forged `_principal` field. Wrong-principal release/renew checks themselves are present and work.

   **Deferred, out of scope for this pass.** `acquireLease`/`requestWorktree` still don't bind a worker-backed principal's own run identity. Needs an owner/CTO-delegation design decision (is a principal ever allowed to act on another run's behalf, and under what capability) before it can be closed safely — noted as a follow-up, not attempted here. (Note: the SIBLING finding for `recordVerdict`'s worker identity — REVIEW-NOTES.md finding 3 — WAS fixed this pass; this is the narrower, still-open case for leases/worktrees specifically.)

   **Fixed 2026-09-11.** Both `acquireLease` and `requestWorktree` (`runtime/supervisor.js`) now refuse when a WORKER-backed principal (one with a `workerId`) supplies a `runId` that resolves to a different worker (`db/index.js`'s new `workerIdForRun`) — same "identity is a registry fact, not a request field" boundary already applied to `recordVerdict`. A principal with no `workerId` (owner/CTO) remains unrestricted; the owner/CTO-delegation question is still not decided, deliberately. Regression: `runtime/test/leases.test.js` case 8 reproduces the review's exact scenario (worker A acquires a lease naming worker B's run — refused; A's own unrelated lease survives B's run ending); `runtime/test/worktree.test.js` case 8 covers the same shape for `requestWorktree`. Both verified to fail against the pre-fix code (impersonation succeeded, `refused` was `undefined`).

5. **should-fix — `supervisor/db/index.js:1690`: acquisition accepts already-ended runs, so release-on-end is not a stable lifecycle invariant.**

   End run R, then acquire a lease with `holderRunId: R`. The foreign key verifies existence only, so acquisition succeeds. A repeated `endRun(R)` returns zero and does not release it. I reproduced a successful grant for an ended run followed by `endRun = 0` with the lease still held. An acquire racing just after another process completes `endRun` yields the same state. Worker calls can also omit `runId` entirely, so their leases are not automatically associated with their run at all.

   Check that a supplied run is open inside the acquisition transaction, serialized with terminal cleanup. For worker-backed wire requests, require/derive the current run rather than defaulting to an unassociated claim. Retain nullable run ownership for explicitly non-run principals. Add a real end-versus-acquire race asserting that no active claim can remain attached to a closed run.

   **Fixed 2026-09-11.** `tryAcquireLease` (`supervisor/db/index.js`) now checks, inside the same transaction as the capacity count, that a supplied `holderRunId` is not already ended (`runs.ended_at IS NULL`); refuses with a named reason otherwise. Regression: `supervisor/db/test/leases.test.js` case 11 (end a run, then attempt to acquire a lease for it — refused), verified to fail against the pre-fix code.

6. **should-fix — `supervisor/db/index.js:263`, `:272`: ending the run and releasing its leases are separate commits, and retry cannot repair a partial failure.**

   The runs UPDATE commits before `releaseLeasesForRun`. A process death or SQL error between them leaves an ended run with live claims. Since cleanup runs only when the first UPDATE changes one row, retrying `endRun` skips it permanently until TTL expiry. I injected a temporary SQLite trigger that aborts the lease UPDATE: `endRun` threw, the run remained ended, and after removing the trigger a retry returned zero with the lease still held.

   Put the winning terminal update and its lease releases in one transaction while preserving first-writer-wins behavior. Pair this with the acquire validation above; atomic cleanup alone cannot stop a later grant to an ended run. Test rollback on cleanup failure and a process crash at the commit boundary. This is recoverable through TTL, so I classify it below an exclusivity violation.

   **Fixed 2026-09-11.** `endRun` (`supervisor/db/index.js`) now wraps the terminal UPDATE and `releaseLeasesForRun` in one `db.transaction()` — a thrown error in the release step rolls back the run's own `ended_at` too, so a partial failure can never leave an ended run with orphaned leases (or, conversely, a rolled-back run whose leases were still released). Regression: `supervisor/db/test/leases.test.js` case 12 (an injected trigger aborts the lease-release UPDATE — both writes roll back together; a clean retry then succeeds), verified to fail against the pre-fix code.

7. **should-fix — `supervisor/db/index.js:1670`, `:1736`; `supervisor/runtime/supervisor.js:3349`: invalid lease durations can return success without granting a usable lease.**

   The wire accepts any integer `ttlMs`, including negative values, and the DB API performs no duration validation. An authenticated acquire with `ttlMs: -1` returned `ok: true`, but `listActiveLeases` immediately returned zero holders. Another caller can acquire immediately although the first caller has just been told it holds the resource. Renewal accepts the same invalid durations. Very large caller-controlled durations also undermine the intended short crash-recovery window.

   Validate a finite positive integer duration in the DB primitive as well as the wire boundary, and enforce a documented maximum if bounded crash recovery is part of the contract. Compute the production timestamp/expiry after acquiring the write lock: currently it is computed before `.immediate()`, so lock waiting can consume a short TTL before the grant is inserted. Add negative/zero/out-of-range input tests and a short-TTL acquisition behind a held SQLite write lock.

   **Deferred, out of scope for this pass.** Invalid (negative/zero/oversized) `ttlMs` values still are not validated in `tryAcquireLease`/`renewLeaseRow` or at the wire boundary. Small but not urgent relative to the blocking findings; noted as a follow-up.

8. **should-fix — `supervisor/runtime/supervisor.js:2800`, `:2806`, `:2903`: worktree retries do not recover completed Git side effects.**

   If `git worktree add` succeeds and the process dies before the task UPDATE, the next create sees a null task pointer. Both attempted Git commands fail because the worktree already exists, leaving a real tree that the API cannot register. I reproduced the exact on-disk/DB state by creating the expected Git worktree without updating the task row; retry returned `git-worktree-add-failed`. Likewise, a successful `requestWorktree` followed by a retry for the same run always fails because it unconditionally creates the same branch/path. I reproduced that through the authorization wrapper. A lost socket response is enough to trigger this overlay failure.

   Reconcile an existing Git worktree against the claimed repository, path, and branch before deciding whether to attach, return the existing result, or refuse a mismatch. Persist/recover overlay ownership sufficiently to make its retry safe too. Cover creation interrupted between Git and SQLite, repeated overlay requests, and discard interrupted after Git removal but before clearing the task pointer. Do not trust directory existence alone as proof of matching ownership.

   **Deferred, out of scope for this pass.** Worktree/overlay creation still can't reconcile a completed git side effect against a lost DB write (crash between `git worktree add` and the task UPDATE). Needs a reconciliation step comparing the claimed repo/path/branch against what's actually on disk before deciding whether to attach, return-existing, or refuse — a bigger change than this pass's scope.

9. **should-fix — `supervisor/db/index.js:272` (new cleanup integration), with `:812` and `supervisor/runtime/reconcile.js:135`: reconciliation closes runs without releasing their leases.**

   A run holding an unexpired lease is marked `lost` on restart through `reconcileRun`, which directly writes `ended_at` rather than calling `endRun`. This path closes asks, but not leases. My direct reproduction acquired a run-bound lease, called `reconcileRun(..., { exitReason: 'lost' })`, and observed the claim still held. The boot sweep removes only expired leases, so it does not resolve this immediately.

   Share atomic terminal lease cleanup with `reconcileRun` while preserving its `reconciled_at` semantics. Keep verified-live orphaned runs distinct; they must not be treated as lost merely to free resources. Add a restart/reconciliation test with a newly acquired, unexpired lease. This is a bounded availability/completeness gap under the default TTL, not a claim that restart permanently deadlocks the resource.

   **Fixed 2026-09-11.** `reconcileRun` (`supervisor/db/index.js`) now releases the reconciled run's leases in the same transaction as its terminal write, mirroring `endRun`'s fix — `reconciled_at` semantics are unchanged, only the lease cleanup is new. Regression: `supervisor/db/test/leases.test.js` case 13 (a run reconciled to `lost` while holding a lease — the lease is released, tagged `lost`), verified to fail against the pre-fix code.

## Schema and authorization assessment

Migrations 0011 and 0012 apply successfully from scratch and from their tested predecessor schemas. Reusing `tasks.worktree_id` and `tasks.branch` avoids duplicate task-worktree state. One row per lease claim accommodates counted resources, and the `(name, config_hash)` unique index provides a valid database identity constraint for `mcp_pool`. I found no separate blocking migration defect. Pool process creation, attachment, refcount updates, and crash recovery are not implemented by this schema and are not claimed as reviewed runtime behavior.

All six new commands have capability mappings. The daemon installs `authorizedCommandHandlers`, tokens resolve to database principals, revoked/missing-capability callers are refused by the existing gate, and the wrapper overwrites caller-supplied `_principal`. Release and renew compare the stored holder principal. These are real protections. They do not provide the missing run association and lifecycle guards identified above. I have not treated the deliberate single `task:worktree` or single `resource:lease` capability as a defect merely because it is coarse.

The host-memory path refuses below the configured free-memory percentage and returns the sampled numbers; the targeted mocked-memory cases pass. The acquire lock proves capacity arbitration among processes sharing the database, not a reservation of future RAM or coordination with programs that do not use this supervisor. These limits should remain explicit when building callers.

## Verification and regression gaps

The following existing test files passed:

- `supervisor/db/test/leases.test.js` — including eight real processes racing exclusive and counted acquisition.
- `supervisor/runtime/test/worktree.test.js` — real Git, but sequential lifecycle tests, not concurrent supervisor callers.
- `supervisor/runtime/test/leases.test.js`.
- `supervisor/db/test/migration-0011.test.js` and `migration-0012.test.js`.
- `supervisor/runtime/test/authorization.test.js` and `supervisor/domain/test/capabilities.test.js`.

The first socket authorization attempt encountered sandbox `listen EPERM`; it passed when rerun with permission to bind its temporary local Unix socket. I did not run the full unrelated application suite.

Additional probes used throwaway databases and local Git repositories; no remote Git operations or application-code changes were made. Observed outcomes included two active exclusive leases after renewal, both process-racing worktree creators succeeding, foreign-run lease/overlay grants, grant-after-end, deletion with an open run, invalid-TTL success, failed end cleanup surviving retry, unrecoverable worktree retry, and lost-run cleanup omission. The worktree race used a barrier after the real SELECT to force a legal interleaving; Git and SQLite were not mocked. The end cleanup probe used an injected SQL failure rather than a timed SIGKILL.

The dedicated runtime lease test's case 7 mints a no-capability principal but sends a token whose hash does not resolve to it. It therefore tests an unauthenticated denial, not a valid principal lacking the capability; it also does not exercise the claimed forged-principal case. Expand these targeted tests alongside the fixes. Green initial-acquire races and command-map coverage do not establish correctness of expiry, end-versus-acquire, worktree ownership, or run-scoped authorization.
