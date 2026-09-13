# Consolidated review of commits d7c4771, 7b6af0a, 79aa275 — 2026-09-14

**Request changes. Risk: high — the new MCP transport delivers a far wider tool surface to utility roles than
their capability presets allow, and two state machines (pooled-socket lifecycle across `resume`, worktree-claim
recovery across `discardTaskWorktree`) have unrecoverable states reachable by ordinary use.**

Baseline: `codexdoc/review-sol-2026-09-13.md` (all 50 findings fixed or resolved by owner decision) is the
exclusion set — nothing already fixed there is re-reported. Independent pass over the three commits was done
BEFORE reading `codexdoc/review-sol-2026-09-14-commits.md`; sol's 8 findings were then verified one by one
against the real code, with real processes/sockets/git where a claim was about timing or state.

**14 findings survive: 3 high, 6 medium, 4 low, 1 doc-consistency.** 0 of sol's 8 were refuted (2 severity
regrades and 2 sub-claim corrections — see "Refuted from sol's report"). 6 of the survivors are new findings
sol did not report, plus 1 new sub-finding folded into a shared one.

---

## High

### 1. The delivered MCP config hands every utility role leo-mcp's ENTIRE tool surface, bypassing the capability system that is the whole point of the utility lane

*Attribution: mine (new — not in sol's report). Verification: CONFIRMED (real socket `tools/list` against a real
pooled leo-mcp process + code trace of the presets).*

**File/area:** `supervisor/runtime/supervisor.js:1174-1204` (especially `1191`, the delivered proxy entry);
`supervisor/domain/mcp-manifest.js:44-62` (`ROLE_MCP_NEEDS`: `git-push-runner`, `jira-runner`, `slack-runner` all
declare `leo-mcp`); `supervisor/domain/capabilities.js:232-238` (the presets those roles actually get);
`../leo-mcp/mcp/schema.js` + `mcp/tools.js` (`git_push.handler = (args) => runFightLoop(args)`).

**Concrete failure scenario:** measured, not assumed — a real pooled `leo-mcp` server reached over its real Unix
socket advertises **27 tools**:

```
git_push, slack_post, slack_reply, slack_react, slack_update_message, slack_delete_message, slack_dm,
slack_post_as_user, slack_query_messages, slack_get_thread, slack_search, slack_resolve_user, slack_doctor,
slack_schedule_message, slack_delete_scheduled_message, slack_list_scheduled_messages, slack_ask,
slack_progress_start, slack_progress_update, slack_progress_finish, slack_publish_home,
slack_agent_session_create, jira_create_ticket, jira_transition, jira_add_resolution_notes,
jira_add_acceptance_criteria, jira_log_worklog
```

Before `79aa275` this was bookkeeping only. Now a `jira-runner` run — whose principal preset is exactly
`["read:registry", "jira:create"]` — is spawned with a `--mcp-config` entry that reaches all 27, including
`git_push` (leo-mcp's schema accepts an arbitrary absolute `cwd`, `targetBranch`, `openPr`, `maxAttempts`) and
`slack_post_as_user` / `slack_delete_message` / `jira_transition`. A jira-task worker that reads a hostile ticket
description (the classic injection vector for exactly this lane) can call `git_push` with
`cwd: <any repo on this host>, targetBranch: main`, which:

* never passes the supervisor's `gitPush` capability check (`git:push` / `git:push-protected` are not in that
  preset at all),
* never acquires the `git:identity` lease that `gitCreatePush` holds across its whole fight loop,
* never writes the `agent_journal` intent record the utility lane exists to keep,
* and is not bounded by any tool allowlist — `grep -rn "allowedTools\|disallowed"` over `adapters/ runtime/
  domain/` returns **nothing**; `--strict-mcp-config` bounds which SERVERS load, not which tools a loaded server
  exposes.

The only remaining boundary is the harness approval prompt (`adapters/claude-code/adapter.js:264`,
`approvalMode` defaulting to `'host'` → `--permission-prompt-tool stdio` → `tool-approval` asks), i.e. a human
reading a prompt — not the capability system. Nothing in `HANDOFF.md`/`PLAN.md`/`ROADMAP.md` records this
widening as a considered tradeoff.

**Suggested fix:** bound the delivered surface per role rather than per server: either mount a role-scoped tool
subset on the pooled server (a `LEO_MCP_TOOLS` allowlist honoured by `server-socket.js`, one pool identity per
role subset — the pool key already hashes config, so per-role configs get their own process), or gate tool names
in `mcp-stdio-proxy.js` against the role's declared needs before relaying. Either way, keep `git_push` out of
every role whose preset lacks `git:push`, and keep the supervisor's own `gitPush` as the only push path so the
lease + journal invariants remain unbypassable.

### 2. Resuming a utility run replays an `--mcp-config` whose pooled socket has already been torn down

*Attribution: both (independently found in my pass; sol finding 1). Verification: CONFIRMED by code trace of all
four legs.*

**File/area:** `supervisor/runtime/supervisor.js:275-288` (`scheduleAttachmentDetach`), `320`, `391`, `481-482`,
`2782` (its callers), `1316-1364` (`resume`); `supervisor/runtime/mcp-pool.js:232-264` (`detach` → `fs.rmSync` of
the socket at `261`); `supervisor/adapters/claude-code/adapter.js:975-976` (`_buildArgs(run.spec)` then
`--resume`).

**Concrete failure scenario:** a `jira-task` run starts with the new JSON `mcpConfig` pointing the proxy at
`/tmp/<poolId>.sock`. The run ends → `closeAndScheduleAsks` → `scheduleAttachmentDetach` → last attachment
detaches → `detach()` kills the pooled process, marks the row `stopped`, and **removes the socket file**. A later
`resume(runId)` passes the terminal-task guard (task still open), calls `adapter.resume`, which rebuilds argv from
the ORIGINAL `run.spec` — including the stale `--mcp-config` JSON with the dead socket path — and nothing in
`resume()` re-attaches the pool, re-spawns it, backfills a new attachment, or rebuilds the config. Generation 2
therefore spawns `mcp-stdio-proxy.js` against a nonexistent socket; the proxy exits non-zero (its own test case 5
proves that is what it does), so the resumed run has no MCP tool at all while its role instructions still tell it
to use leo-mcp, and the run also has zero attachment rows so the bookkeeping no longer reflects reality. No test
covers resume + MCP.

**Suggested fix:** hoist the attach/deliver block into a helper both `start()` and `resume()` use; re-attach every
declared pool before the new generation spawns, persist the new attachment against the run, and hand the adapter
a freshly built config (adapter-side: allow `resume` to take a spec override rather than replaying `run.spec`
verbatim). Add an end-run → pool-drained → resume test that round-trips a real `tools/list` through generation 2.

### 3. A crash mid-discard wedges the worktree slot permanently, and stale-create recovery then resurrects the deliberately deleted worktree

*Attribution: both (I found the discard-side recovery asymmetry independently; sol finding 5 — sol rated medium, I
rate high). Verification: CONFIRMED by a real reproduction with real git, a real DB and the real supervisor.*

**File/area:** `supervisor/runtime/supervisor.js:3420-3425` (discard refuses on the pending marker with no
recovery), `3436-3449` (discard claims with the same generic marker), `3505-3517` (finalize),
`3234-3251`+`3260-3297` (create's reclaim/adopt/redo); `supervisor/db/index.js:567-586` (`claimTaskWorktreeSlot`),
`621-638` (`reclaimStaleTaskWorktreeClaim` — the ONLY reclaim path, called only from `createTaskWorktree`).

**Reproduced output** (real repo, real `git worktree remove`, real supervisor, crash simulated as the exact row
state a daemon death after claim-and-remove leaves):

```
1. created worktree: .../repo/.git/ctd-worktrees/t1 exists = true
2. crashed discard claimed the slot: true
   worktree really removed from disk: true
   tasks.worktree_id is now: "\0pending-worktree-claim\0"
3. discard immediately: refused = worktree-claim-conflict | discarded = false
3. discard after backdating the claim past the 60s stale window: refused = worktree-claim-conflict | discarded = false
4. create after the stale window: {"taskId":"t1", "worktreeId":".../ctd-worktrees/t1", "branch":"ctd/t1",
   "created":true, "recoveredFromCrashedClaim":true}
   deleted worktree is back on disk: true | task state = merged
```

So: (a) the discard path is permanently wedged — `worktree-claim-conflict` forever, with no stale recovery on the
discard side and no boot recovery anywhere (`reclaimStaleTaskWorktreeClaim` has exactly one caller); (b)
`tasks.worktree_id` stays set to the pending marker, which `assignTask`'s `cwd ?? task.worktree_id` fallback will
happily hand to a real `spawn()`; (c) once the 60s window passes, `createTaskWorktree` reclaims the generic marker,
sees no directory, and runs `git worktree add` — recreating a worktree that a discard had already deleted, on a
`merged` task, and reporting `created: true`. Only manual DB surgery clears (a) and (b).

**Suggested fix:** persist the claim's OPERATION and prior path (`worktree_claim_op = 'create' | 'discard'`, plus
the pre-claim `worktree_id`), let a later discard reclaim a stale *discard* claim, and make create's recovery
refuse — or at minimum not re-add — when the stale claim it inherited was a discard. Add boot-time recovery for
pending claims alongside `reconcileOnBoot`, and crash tests immediately before and after `git worktree remove`.

---

## Medium

### 4. Required MCP delivery fails open: a utility run reports a normal successful start with no usable tool

*Attribution: both (sol finding 2, rated high there; I rate medium — see the correction note). Verification:
CONFIRMED by code; the unsupported-harness half IS covered by a test, contrary to sol's coverage claim.*

**File/area:** `supervisor/runtime/supervisor.js:1180-1201` (`manifest.missing` warn at `1181`, `canDeliver`
warn at `1193`, attach-failure warn at `1199`).

**Concrete failure scenario:** any of "no registered pool config", "harness declares `mcpConfigDelivery: false`",
"pool command/cwd missing", "server never binds within 5s", "attach timed out" produces a `logger.warn` and then
a completely normal `adapter.start()` + `createRun()`. The run's role instructions still tell the worker to use
leo-mcp; the caller/TUI/operator sees an ordinary started run with no degraded marker anywhere in `runs`.

**Suggested fix:** for roles with declared MCP needs, refuse the start (or require an explicit
`allowDegradedMcp: true` from the caller) and persist/surface the degraded state on the run row when it is opted
into. Add missing-command and never-binds tests to go with the existing unsupported-harness case.

### 5. Pool readiness is pathname existence only, so a dead or non-socket endpoint is published `ready` and stays joinable

*Attribution: sol finding 6 (verified and extended by me with two real reproductions). Verification: CONFIRMED.*

**File/area:** `supervisor/runtime/mcp-pool.js:176-185` (`fs.existsSync` as the readiness proof), `187-194`
(`markPoolReady`), `195-214` (the `exit` listener installed only AFTER the row is published);
`supervisor/db/index.js:2036-2039`, `2095` (only `ready` rows are joinable).

**Reproduced, real processes, real sockets:**

```
A (server binds a real socket then exits immediately):
   pool status = ready | pgid alive = false | proxy-style connect -> ECONNREFUSED
   second attach: spawned = false | samePool = true | status = ready  -> joins the dead pool, ECONNREFUSED again
B (server writes a REGULAR FILE at the socket path and stays alive):
   pool status = ready | fs.statSync(path).isSocket() = false | proxy-style connect -> ENOTSOCK
```

The create-then-exit race is real and not merely theoretical: Node does **not** replay `exit` to a listener
attached after the child died — verified directly (`exitCode` = 7 while a late-attached `once('exit')` never
fires) — so the row stays `ready` until the next daemon boot, and every subsequent attacher joins it.

**Suggested fix:** install the exit/error tracking immediately after `spawnManaged` (before the readiness wait),
check `fs.statSync(path).isSocket()` and child liveness before `markPoolReady`, and do one bounded real
`net.connect` handshake as the readiness proof instead of `existsSync`. Add both reproductions above as
regressions.

### 6. Concurrent attachers give up after ~1s while the winning attacher is allowed ~7s

*Attribution: both (independently reproduced by sol and by me). Verification: CONFIRMED by real reproduction.*

**File/area:** `supervisor/runtime/mcp-pool.js:99-137` (50 attempts × 20ms = ~1s for a loser, throw at `137`) vs
`147-148` + `166` + `176-185` (winner: up to 2000ms identity verification + 100 × 50ms socket wait ≈ 7s).

**Concrete failure scenario:** two utility runs of the same role start together on a cold pool. The winner spawns
a server that legitimately needs ~2s to bind; the loser's poll budget expires at ~1s and `attach()` throws
`mcp-pool: attach(<name>) timed out waiting for a joinable or spawnable slot`. `start()` catches that as
finding 4's warning, so the second run proceeds with no MCP tooling while a perfectly healthy pooled server comes
up a second later.

**Suggested fix:** derive the loser's deadline from the same budget the winner has (or wait on a per-pool
readiness promise / DB state transition rather than two independent polls). Add a delayed-bind concurrent attach
test rather than only immediate-listen fixtures.

### 7. Pool teardown paths that clear ownership without confirming death, and that kill only the direct child

*Attribution: both — sol finding 3 covers the attach-failure and `disposeAll` halves; the `spawnOne` half is mine
(new). Verification: CONFIRMED by code; the ignored-kill-outcome paths are inconsistent with the same file's own
finding-22 discipline.*

**File/area:** `supervisor/runtime/mcp-pool.js:118-128` (handle deleted at `118` before the kill, kill outcome at
`122` discarded, `markPoolFailed` at `127` unconditional), `336-358` (`disposeAll` deletes the handle at `339`
before attempting the kill), and — the new half — `168`, `183`, `192` (`spawned.child.kill("SIGKILL")` instead of
`killProcessGroup(pool.pgid)`, with no death verification).

**Concrete failure scenario:** (a) post-spawn attach failure with a kill that returns `{ killed: false }` (EPERM,
or a group that outlives the grace window): the row is marked `failed`, which `claimPoolSlot` treats as
resurrectable, so the next attach spawns a duplicate server beside the survivor — exactly the invariant
`detach()`/`reconcileOnBoot` were fixed to preserve. (b) `disposeAll` drops the handle before the kill, so an
unconfirmed kill at shutdown leaves a detached MCP process with real credentials resident and no handle; the row
is left `ready` (recoverable only at the next boot) and, while `shutdown()` does return `{ poolId, killed }`,
nothing logs or warns about it. (c) `spawnOne`'s three failure paths signal only the direct child: a pool
configured through any wrapper that forks (`npx`, a shell, a supervisor script) leaves the actual server process
resident while the row is marked `failed`, and `spawnManaged` already recorded the pgid that would have killed
the whole group.

**Suggested fix:** one teardown helper used by all four paths: kill by process group, inspect the result, keep the
handle and a non-joinable `teardown-failed` state until death is confirmed, and log/report the unconfirmed case.
Add injected `{ killed: false }` tests for the attach-failure and shutdown paths.

### 8. Preflight — documented as "the tightest environment available… needs no MCP servers" — still attaches pools and delivers a real MCP config, with the host approval path switched off

*Attribution: mine (new). Verification: CONFIRMED by code trace.*

**File/area:** `supervisor/runtime/supervisor.js:1174-1205` (no `spec.isPreflight` guard on the MCP block) vs
`1563-1579` (the preflight spec's own stated intent, with `approvalMode: "off"`);
`supervisor/adapters/claude-code/adapter.js:234`, `264`, `998` (`approvalMode: 'off'` skips both
`_sendInitialize` and `--permission-prompt-tool stdio`).

**Concrete failure scenario:** `preflight({ harnessId: "claude-code", workerId: <a jira-runner worker> })` builds
a spec whose comment says a reachability check "needs no MCP servers", but `start()` keys the MCP block on the
WORKER'S ROLE alone. So a preflight spawns/attaches the pooled leo-mcp process, builds a real `mcpConfig`, and
runs it with the host approval round trip disabled — the one configuration in the tree where the 27-tool surface
of finding 1 has no approval prompt in front of it. It also spawns a real pooled server (and pays its teardown)
for a check whose entire design constraint is being cheap.

**Suggested fix:** skip the MCP attach/deliver block entirely when `spec.isPreflight === true` (assert it in
`preflight`'s own test), and treat "deliver `mcpConfig` while `approvalMode: 'off'`" as a refusable combination in
`worker-env.js`, next to the existing `envProfile: 'inherit'` refusal.

### 9. The only end-to-end proof that MCP delivery works silently disappears when the sibling repo is absent, while `npm test` still reports green

*Attribution: mine (new). Verification: CONFIRMED by code.*

**File/area:** `supervisor/runtime/test/mcp-pool-wiring.test.js:38-43`
(`if (!LEO_MCP_AVAILABLE) { console.log("SKIP: ..."); process.exit(0); }`).

**Concrete failure scenario:** `../leo-mcp` is a private sibling repo. On any checkout or CI runner without it,
all 7 wiring cases — including case 7, the only test that spawns the real proxy with the exact argv `start()`
builds and round-trips a real `tools/list` — exit 0 with one SKIP line. The suite is still "green", and
`TODO.md`'s own "watch the suite COUNT, not just the exit code" rule does not catch it because the file still
counts as a passing suite. The feature's entire integration coverage is therefore conditional on one developer's
directory layout. (On this machine the sibling IS present, so the cases really ran — see Verification.)

**Suggested fix:** keep the leo-mcp cases as-is, but add a sibling-independent end-to-end case using a local
minimal socket-transport MCP server fixture in this repo (the proxy relays bytes and never parses the protocol, so
a small fixture is sufficient), and make the skip loud — non-zero, or an explicitly reported "skipped suite" count
the runner surfaces.

---

## Low

### 10. The new proxy relay tests can hang the whole suite instead of failing

*Attribution: sol finding 7. Verification: CONFIRMED — and the repo already has a bounded helper the test did not
use.*

**File/area:** `supervisor/runtime/test/mcp-stdio-proxy.test.js:59-61`, `67-69` (`setInterval` polls with no
deadline and no rejection path); `supervisor/runtime/test/_helpers.js:31-41` (`runTest` imposes no timeout) and
`47-48` (`waitFor({ timeoutMs })`, the existing bounded helper).

**Concrete failure scenario:** a transport regression that connects but stops forwarding one direction leaves
both promises pending forever; `finally` never runs, so the live proxy and the listening server keep the process
alive and `npm test` hangs rather than failing — the worst outcome for the one test that guards the only genuinely
new code in this feature.

**Suggested fix:** use the file's own `waitForEvent`-style deadline (or `_helpers.js`'s `waitFor`) for both
assertions, and force-kill every spawned proxy in `finally`.

### 11. Stale-claim recovery is keyed on `tasks.updated_at`, which unrelated task writes refresh

*Attribution: mine (new). Verification: CONFIRMED by code.*

**File/area:** `supervisor/db/index.js:621-638` (`row.updated_at >= staleBeforeIso` → `not-stale`);
`supervisor/runtime/supervisor.js:3142` (`STALE_WORKTREE_CLAIM_MS`), `3244-3245`.

**Concrete failure scenario:** `updated_at` is the task row's general-purpose stamp, not a claim stamp. Any
unrelated write to that task (a state transition, a title/branch update, any `UPDATE tasks SET ... updated_at`)
pushes the 60s staleness window out again, so a genuinely crashed claim can stay unrecoverable indefinitely while
the daemon keeps refusing every caller with `worktree-claim-pending` / `worktree-claim-conflict`.

**Suggested fix:** stamp the claim itself (`worktree_claim_at`, written by `claimTaskWorktreeSlot` and refreshed
only by `reclaimStaleTaskWorktreeClaim`) and compare against that.

### 12. Pool socket files are removed only by the happy-path `detach()`, and are created world-connectable

*Attribution: mine (new). Verification: CONFIRMED by code; permission impact measured on this platform.*

**File/area:** `supervisor/runtime/mcp-pool.js:150-152` (`socketPathFor` → `os.tmpdir()`), `261` (the only
`rmSync` on teardown), `336-358` (`disposeAll` removes nothing), `162` (spawn-time best-effort remove);
`../leo-mcp/mcp/server-socket.js:73` (`listen` with no `chmod`).

**Concrete failure scenario:** shutdown, boot reconciliation, spawn failure and the attach-failure path all leave
`<poolId>.sock` behind in the temp dir; since pool ids are stable per `(name, configHash)`, the litter is bounded
but permanent, and a stale file is exactly the input that makes finding 5's `existsSync` readiness check lie.
Separately, a Node Unix socket is created mode `0755` (measured), so on any platform where the temp dir is shared
— `TMPDIR=/tmp` on Linux/CI — any local user can connect to a pooled server holding real Jira/Slack/git
credentials and drive the full 27-tool surface, with no peer-credential check anywhere. On macOS, the target
platform, `os.tmpdir()` is the per-user `/var/folders/.../T` at mode `700` (measured), which mitigates the
cross-user half there but not on Linux/CI.

**Suggested fix:** remove the socket file on every teardown path (including `disposeAll` and `reconcileOnBoot`),
and place the socket in the supervisor's own state dir with `0700` on the directory (or `chmod 0600` the socket
after `listen`) so the isolation is asserted rather than inherited from the platform's temp-dir policy.

### 13. `changedPathsFor` / `currentHeadFor` fail open, silently downgrading the one review profile someone explicitly made stricter

*Attribution: mine (new; code in `7b6af0a`). Verification: CONFIRMED by code — and the code documents this as
deliberate, so this is a narrow objection, not a claim that it was overlooked.*

**File/area:** `supervisor/runtime/supervisor.js:2004-2010` (`reviewProfileForTask`), `2019-2029`
(`currentHeadFor` → `catch { return null; }`), `2038-2048` (`changedPathsFor` → `catch { return []; }`).

**Concrete failure scenario:** a `git diff` failure (permissions, a half-removed worktree, a 10s timeout on a slow
disk, a missing `base_rev`) yields `[]`, which `profileForReview` reads as "no paths matched", so a `perPath` rule
whose whole purpose is "`packages/payments/**` is stricter than the team default" quietly does not apply and the
weaker profile governs the quorum. The returned `reason`/`paths` do not distinguish "nothing changed" from "git
could not answer", so no operator sees the downgrade.

**Suggested fix:** keep the fail-open default, but distinguish the two cases (`pathsUnknown: true`) and either
surface it on the review profile the verdict is recorded against or refuse only when the configured profile
actually contains `perPath` rules.

---

## Documentation consistency

### 14. The current docs simultaneously say MCP delivery is fixed, absent, and uncommitted

*Attribution: sol finding 8 (I found the stale `mcp-manifest.js` header independently). Verification: CONFIRMED at
every cited location.*

**File/area:** `ROADMAP.md:53-64` ("This latest batch (findings 8 and 13) is **not yet committed** — check
`git status`", though it is commit `79aa275`), `ROADMAP.md:505-511` ("still have no DELIVERED MCP transport"),
`ROADMAP.md:645-655` ("`start()` no longer sets `spec.mcpConfig` at all … a worker getting an actual usable MCP
connection from it is not"), `ROADMAP.md:663-670` ("**Not wired into `spec.mcpConfig` at all**");
`PLAN.md:1845-1852` (same claim in §21.1, plus "everything EXCEPT a worker actually receiving a usable MCP
connection"), `PLAN.md:1879-1883` (§21.2 "Not wired into an actual spawned worker's `spec.mcpConfig` in this
pass"); `TODO.md:27-31` and `TODO.md:66-76` ("`spec.mcpConfig` deliberately unset", "only `git-push-task` has a
real, DELIVERED tool"); `HANDOFF.md:322-334` (a "**Not yet actioned**" heading whose first bullet is "Finding 8
(high, NOW FULLY FIXED)"); `supervisor/domain/mcp-manifest.js:26-34` (header still says it "did NOT end up wiring
the result into `spec.mcpConfig`" and that a usable connection "is still not" real).

**Concrete failure scenario:** a maintainer cannot tell from the docs whether delivery exists, whether it is
committed, or whether `spec.mcpConfig` is set — and the module header a reader hits first while editing the
manifest actively contradicts the code beneath it.

**Suggested fix:** update the current-state sections of `ROADMAP.md`, `PLAN.md`, `TODO.md`, `HANDOFF.md` and the
`mcp-manifest.js` header in one pass; mark the historical narrative explicitly superseded; record `79aa275` as
the closing commit; and document the limitations that are actually real today — fail-open startup (finding 4),
Claude-Code-only delivery, no resume re-attachment (finding 2), the unbounded delivered tool surface (finding 1),
and no project-owned AWS MCP pool.

---

## Refuted from sol's report

**None of sol's 8 findings were refuted.** Every one reproduced or verified at the cited location; I checked each
against the real code rather than the diff, and reproduced findings 4, 5 and 6 with real processes/git/sockets.
Two corrections that do not change the finding's existence:

1. **Finding 2's coverage claim is partly inaccurate.** Sol writes that "the new happy-path round-trip test does
   not cover any unavailable-delivery path". `runtime/test/mcp-pool-wiring.test.js` case 1 does cover the
   unsupported-harness path (a fake harness with `mcpConfigDelivery: false` attaches a real pool row and asserts
   `spec.mcpConfig` is NOT set while the run starts normally) — it just encodes the fail-open behaviour as
   intended. The missing-command and never-binds paths are genuinely uncovered. **Severity regraded high →
   medium**: the posture is explicitly documented in the code, warned about in the log, and produces a visibly
   tool-less run rather than a silently wrong action.
2. **Finding 3's shutdown half is partly reported already.** `shutdown()` does capture
   `result.mcpPool = [{ poolId, killed }]`, so an unconfirmed kill is present in the returned shutdown result —
   nothing logs or warns about it, and the handle is still dropped before the kill, so the defect stands. Also,
   the attach-failure path's `{ killed: false }` window needs a genuine kill failure (EPERM/survival past the
   grace window), which is rare for a same-user child; I therefore regraded **high → medium**, while adding the
   more reachable `spawnOne` direct-child-only kills as part of the same finding.

Two severity **upgrades** in the other direction: sol's finding 5 is high, not medium (reproduction shows a
permanently wedged discard path plus reversal of a completed deletion, recoverable only by manual DB edits), and
sol's finding 6 keeps medium but with materially stronger evidence than the report claims (both the dead-server
and regular-file variants reproduced, plus proof that Node never replays a missed `exit`).

### Hypotheses of my own that I checked and dropped (recorded so they are not re-investigated)

* **`mcp-stdio-proxy.js` truncating a large response on `socket.on("close") → process.exit(0)`.** Attempted a real
  reproduction with a multi-megabyte payload and a server closing immediately after writing; pipe backpressure
  means `close` does not fire until stdout has drained, and the bytes arrived complete. Not reproducible — not a
  finding.
* **Pooled children losing `PATH` because `mcp-pool.js` passes `env: { ...config.env, LEO_MCP_SOCKET_PATH }`.**
  `runtime/spawn.js`'s `childSpawnEnv` merges `process.env` underneath the extras, so the child does inherit
  `PATH`. Refuted.
* **`attachToPool` handing out a null `socketPath` from a `starting` row.** Only `ready` rows are joinable
  (`db/index.js:2095` publishes `socket_path` in the same statement that sets `ready`), so a joined row always
  carries a path. Refuted — the real defect there is finding 5 (the path may be published for a dead/non-socket
  endpoint), not a null.

---

## Verification — what was actually run, not just read

* **Baseline suite green.** `npm test` from `supervisor/`: **exit 0, 144 PASS lines, no SKIP lines** (the
  `../leo-mcp` sibling is present on this machine, so the wiring cases really executed). Nothing in this review
  edited any file except this report.
* **Read in full first:** `codexdoc/review-sol-2026-09-13.md` (539 lines, the exclusion baseline) — and none of my
  new findings appear in it (`changedPathsFor`, `currentHeadFor`, `updated_at`, `LEO_MCP_AVAILABLE`, tool-surface
  bounding all return no matches there). Then the current code of `runtime/mcp-pool.js` (all 361 lines),
  `runtime/mcp-stdio-proxy.js`, `runtime/supervisor.js` (start/resume/worktree/shutdown regions),
  `adapters/claude-code/adapter.js` (capabilities, `_buildArgs`, `resume`), `worker-env.js`, `db/index.js`
  (worktree-claim and pool primitives — read with `grep -an`, the file has non-UTF-8 bytes so plain `grep -n`
  silently matches nothing), `conformance/matrix.js`, `config/mcp-pools.js`, `domain/{mcp-manifest,capabilities}.js`,
  the three new/changed test files, and `HANDOFF.md`/`ROADMAP.md`/`PLAN.md`/`TODO.md` at every cited line. Sol's
  report was read only after my own findings were written down.
* **Real leo-mcp tool surface (finding 1).** Spawned the real `mcp/server-socket.js` from the sibling repo,
  connected to its real Unix socket, sent a real `tools/list`: **27 tools**, listed verbatim in finding 1,
  including `git_push` (arbitrary absolute `cwd`, `targetBranch`, `openPr`) whose handler is
  `runFightLoop(args)` with no principal awareness. Cross-checked against `domain/capabilities.js:232-238`'s
  presets and a tree-wide `grep` proving no tool allowlist exists anywhere.
* **Real crashed-discard reproduction (finding 3).** Real `git init`/`worktree add`/`worktree remove`, real
  SQLite, real `createSupervisor` + fake harness; simulated the crash as the exact row state a claim-then-remove
  death leaves. Output quoted in finding 3: discard refused twice (including after backdating past the 60s
  window), then `createTaskWorktree` returned `created: true, recoveredFromCrashedClaim: true` and `git worktree
  list` showed the deleted worktree back on disk for a `merged` task.
* **Real pool-readiness reproductions (finding 5).** (a) a server that binds a real socket then exits: row
  `ready`, `pgid` not alive, proxy-style `net.connect` → `ECONNREFUSED`, and a **second** `attach()` joined the
  same dead row (`spawned: false`, `samePool: true`) and got `ECONNREFUSED` too. (b) a "server" that writes a
  regular file at the socket path and stays alive: row `ready`, `isSocket() === false`, connect → `ENOTSOCK`.
  (c) independent proof that Node never replays a missed `exit`: `child.exitCode === 7` while a listener attached
  600ms after death never fired.
* **Concurrent-attach budget mismatch (finding 6).** Reproduced independently of sol with a real delayed-bind
  socket server: the winner attached at ~2.1s, the loser rejected at ~1s with
  `mcp-pool: attach(...) timed out waiting for a joinable or spawnable slot`.
* **Socket permissions (finding 12).** Measured on this host: a Node Unix socket is created mode `0755`;
  `os.tmpdir()` here is `/var/folders/.../T` at mode `700`. Reported with that platform mitigation stated rather
  than as a blanket cross-user exposure.
* **Not verified / explicitly out of reach:** whether Claude Code auto-approves MCP tool calls when
  `approvalMode: 'off'` removes `--permission-prompt-tool` (finding 8 is stated as an environment/intent
  contradiction plus a disabled approval round trip, not as a proven auto-approval); and the exact behaviour of a
  real `claude` session against a dead proxy (finding 2 is traced through code plus the proxy's own
  exit-non-zero-on-dead-socket test, not through a live billed session).
