# Codebase review

> **STALE SNAPSHOT — dated 2026-09-11, NOT regenerated since. Corrected 2026-09-13
> (review-sol-2026-09-13.md finding 45).** Findings below carry their own "Fixed 2026-09-1x" notes where
> resolved at the time, but the surrounding prose (utility assignment rejected, synchronous Git
> execution, etc.) is a dated snapshot, not current-tree fact. `HANDOFF.md`'s top header is the
> current-state source of truth.

Reviewed 2026-09-11, working tree based on `d7c4771`, including existing uncommitted changes. No implementation files were changed for this review. The architecture account is in [ARCHITECTURE.md](ARCHITECTURE.md).

The strongest parts are the explicit process-ownership model, conservative orphan handling, single-consumer event pump, transactional state journal, command capability registry, and serialized review evaluation. The main risk before adding integrations is that individually sound primitives are not yet composed into complete authorization and lifecycle boundaries. A new dispatcher would inherit these gaps and give them externally visible consequences.

## Evidence and limits

I read HANDOFF first, PLAN's 21 sections, ROADMAP, and the implementation under db/lock/ipc/adapters/runtime/domain/pane/tui, plus the new agent/resource code and relevant tests. Existing findings files were treated as leads, not proof.

`npm test` in `supervisor/` passed **twice** under Node v26.6.0. Each successful run printed 113 `PASS:` lines and zero `FAIL` lines; the package script invokes 57 test entrypoints. These counts are output/entrypoint counts, not an assertion count. An initial sandboxed attempt could not bind local sockets (`EPERM`); rerunning with local execution permission passed. Real-model slices, external pushes, and mutation runners were not rerun.

[evidence/reproduce.mjs](evidence/reproduce.mjs) is a separate executable set of probes using temporary SQLite databases, synthetic principals, temporary real git worktrees, a local bare git remote, and an authorized Unix socket. It ran successfully after correcting the probe's snapshot assertion to inspect both persisted and provisional transcripts. It performs no model calls or external network operations and cleans up temporary fixtures.

Run it from the repository root with `node codexdoc/evidence/reproduce.mjs`. **It asserts the observed defects, not the desired corrected behavior.** After repairs, replace these assertions with regression expectations; do not add this unchanged to the green test suite. A source-traced concern below is explicitly distinguished from a reproduced one. The worktree-discard fixture has an open run row, not a live OS worker.

Severity: **blocking** means an authorization, exclusivity, or data-preservation contract fails and should stop expansion of the affected path. **should-fix** means a functional or robustness defect that needs repair but is not itself equivalent to data loss. **minor** is documentation/observability drift. This is a focused whole-system review, not a claim that every possible race was exhausted.

## Findings

1. **blocking — `supervisor/db/index.js:1734` — An expired lease can be renewed into a second exclusive holder.** Acquire A, let its TTL expire without sweeping, acquire B for the same exclusive resource, then renew A. Renewal only checks `released_at IS NULL`; it does not require the old expiry to remain live. The probe observes two active claims. This breaks the central safety property of `git:identity`, not just prompt scheduling. Make renewal conditional on the old expiry within the same serialized database decision, reject invalid/nonpositive TTLs, and return an explicit lost-lease outcome. Add a generation/fencing mechanism where the protected operation can honor one; a TTL alone cannot stop a stale process from continuing its side effect.

   **Fixed 2026-09-11.** Same fix as `review-phase7-uncommitted.md` finding 1 — `renewLeaseRow` now requires `ttl_expires_at >= now`, atomically with the update. Regression: `supervisor/db/test/leases.test.js` case 10, verified to fail pre-fix. The generation/fencing suggestion is noted but not built — a TTL-based lease with admission-controlled renewal is the fix implemented; fencing the protected OPERATION itself (so a stale process's side effect is rejected even if it never asked to renew) is a larger change, deferred.

2. **blocking — `supervisor/runtime/supervisor.js:3373` — The caller chooses whether a push needs the protected-branch signature.** `gitPush` and `gitPushProtected` forward the same destination arguments to the same function. The probe first sees protected-command refusal without a signature, then successfully pushes those same arguments to `main` through ordinary `gitPush`. A permissive local bare remote demonstrates the application gate failure; a remote server may independently reject it, but that is not this gate enforcing its promise. Resolve canonical repository, remote URL, destination ref, expected source SHA, and destination policy server-side before choosing the capability/signature requirement. Sign and validate that concrete operation; do not trust the command name as a declaration that the destination is safe.

   **Fixed 2026-09-11.** `gitPush`'s wire handler (`supervisor/runtime/supervisor.js`) now resolves the actual destination server-side (`agents/git-create-push.js`'s new `resolvePushDestination`) and refuses BEFORE calling the fight loop if it matches a configured protected-branch list (`config/protected-branches.js`, new, same on-demand/malformed-throws pattern as `harness-defaults.js`/`resources.js`). `gitPushProtected` needs no equivalent check — reaching its handler already required the sensitive approval regardless of destination. Regression: `supervisor/runtime/test/git-create-push.test.js` case 7 (a `gitPush` aimed at `main` is refused server-side with no approval involved at all; a non-protected destination still works via the cheap path; `gitPushProtected` against `main` is unaffected), verified to fail against the pre-fix code. Not built: canonicalizing the repository/remote URL or binding to an expected source SHA — the fix compares the resolved branch NAME against a declared list, which is real but narrower than full destination-policy resolution.

3. **blocking — `supervisor/runtime/supervisor.js:3270` — One reviewer token can manufacture the distinct-reviewer quorum.** The wire handler accepts a supplied `workerId`; `recordVerdict` verifies that worker's task and reviewer role but never binds it to the authenticated principal. The probe uses one authenticated reviewer to submit all required dimensions under two valid worker identities, and review evaluation approves with two distinct reviewers. Derive worker identity from the principal. If an owner needs an import/delegation operation, make that an explicit separately audited capability. Also prevent a reviewer from arbitrarily advancing the authoritative round; the orchestrator should establish the round and revision being reviewed.

   **Fixed 2026-09-11.** `recordVerdict` (`supervisor/runtime/supervisor.js`) now refuses when an authenticated worker-backed principal's `workerId` disagrees with the request's claimed `workerId` — the same "identity is a registry fact, not a request field" pattern the function already applied to task membership/role/dimension, extended to cover the principal itself. The wire handler now forwards `cmd._principal` through, which it previously dropped entirely. Regression: `supervisor/runtime/test/review.test.js` case 18 (one reviewer token cannot submit under a second worker's identity to manufacture quorum; two genuinely distinct reviewer tokens still can and still approve), verified to fail against the pre-fix code. Not built: preventing a reviewer from advancing the authoritative round arbitrarily — noted as a separate, still-open concern.

4. **blocking — `supervisor/runtime/supervisor.js:2830` — Terminal task state permits forced deletion of a dirty worktree while a run remains open.** Mark a task cancelled through legal transitions, retain an open associated run row, modify its worktree, then call discard. The probe confirms removal of the dirty tree and an unchanged open run. It does not start an OS worker; the missing live-run check is visible in the implementation. In a real worker case, that path can still be in use. Reserve teardown, stop/reconcile every consumer, verify no live owner, and require a recoverable disposition for dirty changes before removal. Terminal task state alone is not a filesystem-lifecycle lock.

   **Fixed 2026-09-11.** Same fix as `review-phase7-uncommitted.md` finding 3 — `discardTaskWorktree` now refuses when any run joined via the task is still open, regardless of the task's own terminal state. Regression: `supervisor/runtime/test/worktree.test.js` case 7, verified to fail pre-fix.

5. **blocking — `supervisor/agents/git-create-push.js:170` — The git utility stages and publishes unrelated changes in the shared worktree.** The successful protected-bypass fixture also places an unrelated file in the worktree; `git add -A` includes it in the resulting pushed commit. On a shared task tree, another worker's partial changes can therefore be included without a reviewed file/SHA boundary. The identity lease does not freeze repository writes. Define the utility's input as a concrete reviewed commit or explicit staged change set, verify repository/branch/HEAD, and coordinate all writers before commit creation. Preserve the actual commit SHA in durable task operation state.

   **Partially addressed 2026-09-11 — the tool now exists, the default did not change.** `runFightLoop` (`agents/git-create-push.js`) gained an optional `paths` parameter: when given, stages exactly those paths (`git add -- <paths>`) instead of `-A`. Omitting `paths` still runs `-A` unchanged — this does NOT make the default safe, and the code says so in its own comment. A caller operating on a shared worktree MUST pass explicit paths to avoid this finding; nothing forces that yet. Regression: `agents/test/git-create-push.test.js` cases 7-8 (explicit paths stage only those files and leave an unrelated uncommitted file untouched; malformed `paths` is rejected rather than silently falling back to `-A`), verified to fail against the pre-fix code. Preserving the actual commit SHA in durable task state, and verifying repo/branch/HEAD before commit, are not built.

6. **should-fix — `supervisor/runtime/supervisor.js:3428` — Ask answers can be self-issued and recorded as human answers.** A normal worker preset has `ask:answer`; the wire handler forwards caller arguments to `answerAsk`, whose attribution defaults to `human`. The probe answers the worker's own ask and records that human attribution. This fixture inserts a synthetic `tool-approval` ask in SQLite and answers it through the authorized handler; it does not claim to have delivered an answer to a parked real Claude request. Nevertheless, the shared command needs an explicit policy for question versus approval, permitted answerer, and task/run scope. Derive audit identity from `_principal` and prevent ordinary workers from granting themselves decisions reserved for a human/CTO.

   **Fixed 2026-09-11.** The `answerAsk` wire handler (`runtime/supervisor.js`) now refuses when an
   authenticated worker-backed principal's `workerId` owns the ask's run — same cross-run ownership
   boundary `requestWorktree`/`acquireLease` already draw — with an explicit error naming the run and
   saying the decision is reserved for a human/CTO. Attribution is now DERIVED from `cmd._principal`
   (`"human"` for the owner, the principal's own id otherwise), ignoring whatever `answeredBy` the
   caller supplied, for any authenticated caller; a caller with no principal at all (the unauthenticated
   in-process path several existing tests use directly) is unaffected, same "no principal is
   unrestricted" boundary used elsewhere. Regression: `runtime/test/authorization.test.js` case 14 — a
   worker's own token is refused answering its own parked ask, and the owner's real answer is stored as
   `"human"` even though the wire request itself claimed `answeredBy: "totally-not-human"`. Verified to
   fail against the pre-fix code (reproduced both the self-answer succeeding and the attribution being
   whatever the caller claimed) before restoring the fix.

7. **should-fix — `supervisor/domain/assignment.js:163` — All four utility task profiles are refused before launch.** With a correctly named worker present, assignment of git-push-task, jira-task, awsquery-task, and slack-task reports that nobody can do the work because `isActionable` only accepts coder or parentReviewer. The probe reproduces each refusal. Make work-bearing roles/profile requirements explicit rather than expanding a hardcoded condition indefinitely. Test actual `assignTask`, not only profile resolution. The lane also needs meaningful instruction/tool provisioning; fixing this predicate alone will start a worker with only a task/type/role sentence.

   **Fixed 2026-09-11.** `isActionable` (`domain/assignment.js`) now looks up which roles are "work-bearing" from the CURRENT task-type profile (`domain/workflow-profiles.js`'s new `workRoles` field, explicit per profile) instead of a hardcoded `role === "coder" || role === "parentReviewer"` check. All nine profiles (including the four utility-task-lane ones) now declare their own `workRoles`. Regression: `runtime/test/assignment.test.js` case 11 — a real `assignTask()` call for a `git-push-task` actually starts a run end-to-end (not just `rolesFor`/`ensureWorkerPrincipal` tested in isolation, which is what the first pass of this lane incorrectly treated as sufficient), verified to fail against the pre-fix code. The lane's meaningful instruction/tool provisioning (beyond a bare task/type/role sentence) remains unbuilt, as this finding itself notes.

8. **should-fix — `supervisor/runtime/supervisor.js:2013` — Zero-review workflow profiles do not imply zero-review approval.** An adhoc profile requests zero reviews, but the approval probe still requires the default quorum of two. Approval consults review configuration independently of task workflow requirements. Choose one resolved per-task execution/review contract and persist it with the task. Reconcile the review-only path too: assignment uses `parentReviewer`, while `recordVerdict` accepts only the exact `reviewer` role. These are integration defects in existing profiles, not reasons to redesign configurable reviews.

   **Deferred, out of scope for this pass.**

9. **should-fix — `supervisor/runtime/supervisor.js:3165` — A registry reader receives raw transcripts through `tuiSnapshot`.** The probe uses a registry-only utility principal and retrieves a raw marker from the TUI snapshot. This contradicts the tier-1 human-only context boundary and bypasses any assumption that withholding `observe:run` withholds transcript access. Split human transcript reads from registry/agent context reads, scope results to permitted tasks, and apply the check in the producer, not merely in UI rendering. Review other raw observation paths for the same policy. This also matters before sending task context to Jira or Slack.

   **Fixed 2026-09-11, the transcript-leak half.** `tuiSnapshot`'s handler now computes
   `canObserveTranscripts` (true only if there is no principal at all — the unauthenticated in-process
   path, unaffected on purpose — or the authenticated principal holds `observe:run`) and only populates
   `transcripts`/`provisional`/`cursors`/`gaps` when true, checked in the PRODUCER before any of those
   fields are built, not left to a client to withhold. Regression: `runtime/test/authorization.test.js`
   case 13 — a `utility:jira` principal (holds `read:registry`, not `observe:run`) gets `ok:true` but an
   EMPTY transcript for a run with real recorded content, while the owner (holds `observe:run`) still
   gets the real content through the same command. Verified to fail against the pre-fix code (the real
   text appeared in the registry-only principal's response) before restoring the fix. **Not done**:
   per-task result scoping (the finding's "scope results to permitted tasks") and a review of other raw
   observation paths for the same policy — this fix closes the transcript field specifically, not a
   general audit of every field `tuiSnapshot` returns.

10. **should-fix — `supervisor/pane/pane.js:54` and `supervisor/ipc/client.js:1` — Standalone pane attachment fails against the real authorization boundary.** The probe launches an authorized socket server and attempts `attachPane`; the first command fails with “no token sent.” The shared client does not inject a principal token, whereas the TUI has its own authenticated client. Existing raw-handler pane tests miss this integration. Share an authenticated transport or explicitly supply credentials through the pane entrypoint, and keep an end-to-end test using the daemon's wrapped handlers.

    **Fixed 2026-09-11.** `ipc/client.js`'s `connect()` now takes an optional `token` and sends it on
    every request (a caller-supplied `token` in a specific call still wins). `pane/pane.js`'s
    `attachPane` reads `stateDir/owner.token` by default — the same file/mechanism `tui/cli.js`'s own
    client already used — with an explicit `token` option to override it; `pane/cli.js`'s `--list`
    path (which went through the same tokenless client) got the identical fix. New
    `pane/test/pane-auth.test.js` (3 cases) proves it against the REAL `authorizedCommandHandlers()`
    gate, not the raw map the existing pane tests use: attach with no explicit token succeeds by
    reading `owner.token` itself; a bogus token is refused; an explicit token overrides the default.

   **Deferred, out of scope for this pass.**

11. **should-fix — `supervisor/agents/git-create-push.js:175` — A push failure cannot be retried after a successful commit.** Commit succeeds, push fails, destination is repaired, then the same job is retried. The probe sees “nothing was staged to commit” and exits before pushing the already-created commit. Persist the commit/push/PR stages with operation identity and the exact resulting SHA, then resume the incomplete stage. Treat a connection failure after remote acceptance as an unknown outcome to reconcile, not permission to create another commit or duplicate PR.

   **Fixed 2026-09-11.** Scoped to detecting-and-resuming, not the full persisted-operation-identity design
   this finding sketches (no new durable "commit/push/PR stage" record was added — see below for why that's
   an honest partial fix, not the whole finding). When staging finds nothing new, `runFightLoop` now asks the
   REMOTE directly (`git ls-remote`, never a possibly-stale local remote-tracking branch) whether local HEAD
   already matches its tip. If it does, behavior is unchanged — the original honest "nothing was staged to
   commit" failure. If it does NOT (local ahead — this finding's exact scenario, remote branch missing
   entirely, local behind, or diverged), the old "nothing to commit" short-circuit is skipped and the push
   step runs directly against the commit that's already there, rather than reporting a false negative.
   Divergence (local behind, or diverged from the remote) is never silently resolved by force-pushing or
   otherwise — the REAL `git push` naturally refuses a non-fast-forward update, and that genuine refusal is
   what gets classified and reported, so a real divergence still surfaces as an honest failure, never a
   fabricated success. New cases 9-12 in `agents/test/git-create-push.test.js`: (9) the finding's exact
   reproduction — commit succeeds, push fails because the remote doesn't exist yet, remote is then created
   ("destination is repaired"), retry succeeds and pushes the SAME commit with no duplicate; (10) nothing new
   to stage plus a remote branch that doesn't exist at all yet still pushes (this fix's case (a)); (11) local
   HEAD behind the remote after a second clone pushed in between — refuses, and the remote's real history is
   confirmed untouched, no force-push (case (b)); (12) genuinely nothing to do — local HEAD already matches
   the remote — confirmed byte-for-byte unchanged from the pre-fix behavior (case (c)). All 12 cases in the
   file pass, including the original 8. `npm test`: exit 0, 117 suites, re-verified 3x total.
   **What this does NOT do, honestly**: it does not persist commit/push/PR stage identity or the exact
   resulting SHA in any durable store, and it does not reconcile an "unknown outcome" (e.g. a push that the
   network dropped after the remote actually accepted it, so the local process never saw success) — those
   need the durable operation-record design the finding's own text describes, which is a bigger change
   (new state, a caller-visible operation-identity concept) than the specific "retry after successful commit"
   bug this pass closed. `runFightLoop` remains stateless between calls; this fix only makes it correctly
   RE-DERIVE the right thing to do next time from git's own state, which happens to cover this finding's
   exact reproduction and its named edge cases, but not persistent tracking of an in-flight PR or a genuinely
   ambiguous network outcome.

12. **should-fix — `supervisor/runtime/supervisor.js:2933` and `supervisor/agents/git-create-push.js:66` — The git fight loop blocks the daemon event loop.** Source-traced: git, hooks/autofix, and optional PR commands use synchronous child execution, with individual timeouts up to 30 seconds and multiple attempts. During those calls the same Node thread cannot service socket commands, asks, digests, sweep timers, or other holders' heartbeats. The loop itself does not renew its lease. Move work into a supervised asynchronous child/job and retain a durable operation record. Cancellation, output limits, heartbeat loss, and teardown must remain responsive while hooks are slow. This is particularly important before `host:heavy-job` coordinates multiple real jobs.

    **Fixed 2026-09-11, the event-loop-blocking half.** `agents/git-create-push.js`'s every git/autofix/
    `gh pr create` call now goes through `execFile` (promisified), not `execFileSync` — libuv waits on
    the child without blocking the Node event loop, so socket commands, asks, digests, and sweep timers
    keep running while a slow hook does. `run()`, `tryAutofix()`, `remoteHeadSha()`,
    `resolvePushDestination()`, `runFightLoop()` and `openPullRequest()` are all `async` now; the exact
    sequence and meaning of each git call is UNCHANGED, only how each one is awaited. `runtime/
    supervisor.js`'s `gitCreatePush()` and its two wire handlers (`gitPush`/`gitPushProtected`) now
    `await` accordingly. Regression: `runtime/test/git-create-push.test.js` case 7 — a real pre-commit
    hook that sleeps 1s, with a concurrent `setInterval(10ms)` ticker running alongside
    `gitCreatePush()`; the fixed code logs 100+ ticks during that second, the pre-fix (`execFileSync`)
    code logs 0. Verified to fail against the pre-fix code (reverted `run()` to `execFileSync` only,
    confirmed 0 ticks) before restoring the fix. **Not done**: a durable operation record, cancellation,
    output limits, heartbeat/lease renewal during the call, and moving the work to a genuinely separate
    supervised child process — this fix removes the SPECIFIC blocking mechanism the finding measured
    (`execFileSync`'s full-process block), it does not build the larger job-supervision design the
    finding's text sketches around it.

   **Deferred, out of scope for this pass.** Needs supervised async child execution — a bigger change than this pass's scope.

13. **should-fix — `supervisor/db/index.js:798` — Reconciliation closes a run without releasing its leases.** Normal `endRun` releases them; `reconcileRun` writes terminal state through a separate update. The probe confirms a lease remains held after reconciliation. TTL eventually recovers it, so this is a bounded availability defect rather than permanent exclusivity failure. Centralize terminalization and lease cleanup in one transaction, including reconciliation, and distinguish expired, lost, deliberately stopped, and completed release reasons. The current endRun update and release should also be atomic together.

   **Fixed 2026-09-11.** Same fix as `review-phase7-uncommitted.md` finding 9 — `reconcileRun` now releases the reconciled run's leases in the same transaction as its terminal write. Regression: `supervisor/db/test/leases.test.js` case 13, verified to fail pre-fix. The broader "distinguish expired/lost/stopped/completed release reasons" and "endRun update+release atomic together" halves of this finding ARE also done — see finding 1's/`review-phase7-uncommitted.md` finding 6's fix (`endRun`'s own atomicity).

14. **should-fix — `supervisor/runtime/supervisor.js:2781` — Worktree creation does not carry the task's uncommitted work or establish its base revision.** The probe confirms a source uncommitted file remains in the original checkout and is absent from the created tree. This preserves the original but does not implement PLAN's copy-and-continue promise. Either implement a controlled dirty-state transfer with explicit conflict handling, or make clean committed input the documented prerequisite and reject ambiguous starts. Record base SHA and canonical repository identity. Add the worktree step to assignment before any worker starts; currently a missing worktree falls back to another cwd.

   **Deferred, out of scope for this pass.**

15. **should-fix — `supervisor/tui/app.js:243` — Restarted workers display the first historical run.** `rows.find` chooses the first matching worker, while stored runs arrive in historical ascending order. The fixture supplies an old ended run followed by a replacement and the pane selects `old`. Prefer the current live generation, otherwise the newest ended run; retain explicit history selection separately. Avoid labelling every ended run as crashed when it may have completed normally.

    **Fixed 2026-09-11, both halves now.** The run-SELECTION half: `forWorker` in `tui/app.js` filters
    to all of a worker's runs, prefers one with `endedAt` null (live) regardless of array position, and
    among ended-only runs picks the one with the latest `lastEventAt` rather than array order. New case
    9 in `runtime/test/tui-replay.test.js` reproduces exactly this review's fixture shape (old ended run
    listed first, live replacement second) plus the ended-only tiebreak case.
    The labelling half (initially left open in the same pass, then closed in a follow-up): `buildPanes`'s
    `status` assignment used to be the literal string `"crashed"` for ANY ended run regardless of
    `exitReason` — a run that finished cleanly was still classified `crashed` internally, even though
    `renderPaneBody`'s on-screen text already named the real reason. Renamed the status to the neutral
    `"ended"` (`tui/app.js`, `tui/layout.js`'s matching render branch, both updated together), with the
    render text and marker made reason-neutral too (a plain `■` instead of `✖`, which read as an error
    regardless of reason). Regression: `tui/test/tui.test.js` now covers both a deliberate `reaped` exit
    and a genuine `errored` one under the same neutral status, plus an explicit
    `assert.doesNotMatch(..., /crashed/i)`; `runtime/test/tui-replay.test.js` case 9 asserts a
    normally-`finished` run's pane status is `"ended"`, never `"crashed"`.

16. **should-fix — `supervisor/domain/task-states.js` and `supervisor/runtime/supervisor.js:806` — Ask lifecycle and task lifecycle are not connected.** The probe inserts an ask row on an implementing task and sees it remain implementing. Separately, source tracing finds no runtime caller of `autoBlockTarget`; the state engine's blocking helper is not wired into the runtime ask path; answering does not automatically drive recovery either. Wire a transactional task transition when the first relevant blocking ask opens and when the last closes, respecting task phase and terminal state. Keep this distinct from the answer-authorization repair above. Apply the same explicit policy to run loss/failure rather than expecting a state-machine definition to orchestrate itself.

    **Fixed 2026-09-11.** Two hooks in `runtime/supervisor.js`: `syncBlockedOnAskOpened(taskId)` runs
    right after `recordApprovalAsk` actually creates a new ask row, calling `autoBlockTarget` and
    `recordTransition` to move an `implementing` task to `blocked`. `reconcileAutoBlockedTasks()` runs
    after EVERY ask-closing path this file has (`answerAsk`, both `closeOpenAsksForRun` call sites, the
    grace-expiry sweep, `withdrawApprovalAsk`, `reap`, and boot/on-demand `reconcileOnBoot`) — rather
    than threading "was this the last open ask" through each call site individually, it re-queries every
    currently-`blocked` task (a small set) and unblocks any that no longer have one open. Also applies to
    run loss/failure, per the finding's own closing sentence, since `reap`/`reconcileOnBoot` both close
    asks for lost/reaped runs and both now call the same reconcile. Regression:
    `runtime/test/approval.test.js` case 16 — a task walked to `implementing`, a real parked request
    creates a real ask (auto-blocks the task), answering it (the LAST open ask) auto-unblocks it back to
    `implementing`. Verified BOTH directions to fail independently against the pre-fix code (removed each
    hook in turn) before restoring the fix.

   **Deferred, out of scope for this pass.**

## Architectural risks to address while closing those findings

**Assignment concurrency and crash recovery.** A matching idempotency key is useful but is not a per-task or per-worker reservation. Different keys can race; a persisted in-progress claim can survive a daemon death without a completion/recovery path. Before autonomous dispatch, persist an assignment attempt with reserved slots and a reconciliation outcome, and test death before spawn, after spawn but before persistence, and during partial startup. Avoid rotating one worker's credentials underneath another concurrently starting run.

**Run provenance and continuation.** Historical events derive task attribution from the worker's current `task_id`; persist task/assignment identity on each run before enabling worker reassignment. Separate process lifetime, turn lifetime, and logical run status explicitly. Source tracing shows terminal pump completion and resident processes can coexist; add a two-turn test through the production command path proving that follow-up input remains observed and persisted after the first result. Do not infer it from adapter-only send-input tests. Restart recovery should be documented as orphan detection where real reattachment is unavailable.

**Review evidence should be frozen at an operation boundary.** Path-based profile selection depends on a usable base revision and git diff; failure currently falls back to no changed paths. Missing revision evidence should not silently weaken a stricter path policy. Persist resolved profile hash, authoritative round, and reviewed SHA. A merge transition should validate the same SHA or explicitly request a new review. Current state-only merge is acceptable as a primitive if named/documented honestly, but is not proof that reviewed code was merged.

**Approval signatures need identity and action scope.** A different principal with `approve:sensitive` is not necessarily a human. Decide which issuers are legitimate for protected pushes and future as-user messages. Bind request signatures to canonical destination and concrete content/commit hashes, and verify those again just before the side effect. Preserve the consumed approval ID in the operation record. Worktree and resource commands also need task/run ownership checks; a class capability should not implicitly grant control over every task in the database.

**Fixed 2026-09-11, the "task/run ownership checks" half only.** `acquireLease`/`requestWorktree` now bind a worker-backed principal to its own run identity (see `review-phase7-uncommitted.md` finding 4's fix). The rest of this paragraph — approval-issuer legitimacy, binding a signature to canonical destination/content hashes, preserving the consumed approval ID in a durable operation record — remains open.

**Memory/output bounds and secrets.** The pump's event-count ring does not cap event bytes, socket queues, completed-run state, adapter `_eventLog`, or persistent raw history. TUI polling enumerates all historical runs and performs transcript queries for each, even though cursors bound incremental payloads. Raw event persistence currently lacks a systematic redaction boundary. Introduce byte budgets, retention policy, paginated snapshots, bounded diagnostic tails, and redaction at ingestion and external-dispatch output. Preserve useful evidence while making raw reads explicitly privileged. Review terminal escape handling when harness text becomes TUI content.

**Transport close behavior.** The general IPC client does not reliably reject all pending requests on close/overflow. The TUI's separate request helper can clear its timeout on close without rejecting the promise. Consolidate transport semantics: every pending operation must resolve or reject exactly once on reply, timeout, abort, malformed frame, or disconnect. Keep per-peer queue limits and implement write backpressure. Do not introduce a third subtly different client for the tool router.

**Overlay lifecycle.** `requestWorktree` records a reason and returns an overlay path but has no durable attachment/cleanup record. It does not change the running worker's cwd. Deriving git branch/path names directly from harness run IDs also needs normalization, particularly OpenCode IDs containing URLs. Track overlay ownership and disposition explicitly, and test standard repositories, linked worktrees, cancellation, and restart recovery. Shared worktrees remain viable, but the git writer/cleanup operations require actual coordination with their users.

## Before MCP pooling and lazy discovery

Do not treat the new `mcp_pool` table as a process manager waiting only for a spawn call. Start with an independently testable manager whose durable state represents process identity, lifecycle generation, configuration/credential identity, and individual client attachments. Derive refcounts from attachment records or reconcile them transactionally; a lone integer cannot explain a crash between attach and increment.

Define a lifecycle such as starting → ready → draining → stopped/failed, with a reservation preventing last-detach teardown from racing a new attach. Record process start-time/PGID evidence and verify ownership before kill. Reconcile crashes and stale sockets at boot. Spawn and health-check asynchronously so the daemon remains responsive. Apply leases to actual expensive startup/work, and specify who renews them and what loss means.

Pool only configurations whose credential and isolation semantics permit sharing. A per-worker token in a pooled process environment is already known not to work in the OpenCode arrangement. Give each caller an authenticated attachment/session and enforce authorization at the proxy/dispatch boundary. Establish the transport's actual multi-client behavior in tests before reusing a process; some integrations will need a broker or dedicated process. Configuration hashing must include all behaviorally relevant settings and an identity for secret material without storing plaintext secrets in logs or hash previews.

For discovery, separate catalog metadata from execution authority. A tool name or discovered schema is not a capability grant. Resolve a stable server/tool/version identity, validate arguments, reauthorize the caller at invocation, and audit a bounded/redacted result. Treat tool descriptions and returned content as untrusted input. Cache per permitted catalog/configuration identity, invalidate on server/config changes, and fail closed when a tool disappears or changes schema. This is a proposed implementation contract, not a claim that such a router exists today.

Useful acceptance tests are: two callers share one eligible server; one caller cannot borrow another's credentials; crash at every attach/detach boundary; stale PID reuse; last detach versus new attach; oversized output; hung initialization; lease expiry mid-job; and tool-catalog invalidation without execution under stale authority. Reuse the runtime's ownership principles but do not couple the new manager to OpenCode's private in-memory server pool.

## Before Jira and Slack dispatch

First prove one complete utility task: create/resolve task → prepare worktree where applicable → reserve worker → start with meaningful instructions → deliver permitted tools → run operation → persist external receipt → complete without development review quorum → close/release/clean up. Today profiles, capabilities, and tables do not establish that chain.

Use the existing outbox/requests concepts as durable workflow records with explicit attempt and receipt state, rather than treating an adapter response as the whole transaction. Authorization and approval should reference concrete issue/project/channel/recipient identity and payload hash. Preserve remote IDs and reconcile ambiguous outcomes before retrying, especially a timeout after successful publication. A local SQLite transaction cannot atomically commit an external post; model that uncertainty directly.

Inbound messages should become attributable requests with a clear accept/reject/dispatch action. They must not silently become privileged instructions. Outbound bot posting and as-user posting need distinct credentials and policies, and any required human approval must be derived from authenticated identity, not a caller's `answeredBy` field. Give utility runs only the task context needed for the action; do not forward a TUI snapshot as convenient context.

## Suggested next build order

1. Repair lease renewal, push destination classification, reviewer identity binding, and safe worktree discard. Add failing regression tests against the authorized boundary and real local git fixtures.
2. Repair utility assignment, zero-review completion, answer attribution, and standalone pane authentication. Prove a complete local git utility task with durable retry state and no unrelated staging.
3. Move git operations out of the daemon event loop; unify terminalization/lease cleanup and transport disconnect handling. Establish bounded output and principled run/task provenance before adding more long-lived processes.
4. Build the MCP manager with crash/attachment tests, then the per-caller discovery/execution router. Keep process pooling and catalog laziness separately testable.
5. Add one external dispatcher at a time with receipt reconciliation and explicit approval scope. Only then expand inbound automation and the requests panel.

This keeps the current architecture and closes its actual seams. It does not require replacing SQLite, introducing a distributed broker, or rebuilding the terminal interface. The project needs stronger end-to-end invariants more urgently than it needs another abstraction layer.
