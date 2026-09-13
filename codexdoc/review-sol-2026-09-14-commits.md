# Review of commits d7c4771, 7b6af0a, and 79aa275 - 2026-09-14

## Recommendation

**Request changes. Risk: high.**

The prior `codexdoc/review-sol-2026-09-13.md` findings were treated as the exclusion baseline. The findings below are new defects in the subsequent fixes or concrete gaps those fix-verification passes did not cover.

## Findings

### High

1. **Resuming a utility run reuses an MCP config whose pooled socket has already been torn down**

   **File/area:** `supervisor/runtime/supervisor.js:473-483,1316-1363`; `supervisor/adapters/claude-code/adapter.js:965-994`; `supervisor/runtime/mcp-pool.js:232-261`

   **Concrete failure scenario:** A Claude Code Jira/Slack utility run starts with the new JSON `mcpConfig`, which points its proxy at the pool socket. When the run ends, `closeAndScheduleAsks()` detaches its last attachment; `detach()` stops the pooled process and removes the socket file. A later `resume(runId)` calls only `adapter.resume(runId)`. The adapter rebuilds argv from the original `run.spec`, including the old socket path, but the supervisor neither reattaches the pool nor updates the config. The resumed Claude process therefore spawns a proxy against a nonexistent socket and continues without the required MCP tool. No MCP wiring test exercises resume.

   **Suggested fix:** Make resume re-establish every declared MCP attachment before spawning the new generation, backfill the new attachment to the run, and provide the adapter with a freshly built config/socket path. Add a natural-end -> pool-drained -> resume integration test that invokes `tools/list` through the resumed generation.

2. **Required MCP delivery still fails open, so utility runs can report a successful start with no advertised tool**

   **File/area:** `supervisor/runtime/supervisor.js:1174-1204`

   **Concrete failure scenario:** If the configured pool command/cwd is missing, the server never creates its socket, or the selected harness declares `mcpConfigDelivery: false`, `start()` only logs a warning. It still calls `adapter.start()` and persists a normal run. Jira and Slack instructions then tell the worker to use `leo-mcp`, even though the run has no usable MCP config. This preserves the operational failure that finding 13's suggested fix explicitly required the new transport work to fail closed on; the new happy-path round-trip test does not cover any unavailable-delivery path.

   **Suggested fix:** For roles with declared MCP needs, refuse start/assignment unless every required pool is attached and the selected harness can deliver the resulting config. If degraded execution is intentionally supported, make it an explicit caller opt-in and persist/surface the degraded state rather than returning an ordinary successful start. Add missing-command, socket-timeout, and unsupported-harness tests.

3. **MCP cleanup marks a pool dead and drops its handle even when process-group termination was not confirmed**

   **File/area:** `supervisor/runtime/mcp-pool.js:113-128,336-355`

   **Concrete failure scenario:** In the post-spawn attachment-failure path, `killProcessGroup()` may resolve with `{ killed: false }`; the code ignores that result, deletes `liveChildren`, and marks the row `failed`. A later attach can then spawn a duplicate beside the surviving process. The new `disposeAll()` path similarly deletes the handle before attempting the kill; when the kill is unconfirmed it leaves a detached MCP process alive after graceful supervisor shutdown. These paths recreate the exact ownership invariant that the normal `detach()` and boot reconciliation fixes now correctly preserve.

   **Suggested fix:** Inspect every kill result. Retain the live handle and a non-joinable `draining`/`teardown-failed` row until death is confirmed; only then delete the handle and mark `failed` or `stopped`. Make shutdown report an unconfirmed teardown and add injected `{ killed: false }` tests for both paths.

### Medium

4. **Concurrent attachers time out before the new socket-readiness budget can expire**

   **File/area:** `supervisor/runtime/mcp-pool.js:99-137,147-184`

   **Concrete failure scenario:** The winning caller is allowed up to 5 seconds for a server to create its socket (`100 * 50ms`), but every losing concurrent caller polls only about 1 second (`50 * 20ms`). A repository-local real-process reproduction with a valid socket server that listened after 2 seconds produced one successful attachment at about 2.1 seconds and one rejection at about 1 second: `mcp-pool: attach(slow) timed out waiting for a joinable or spawnable slot`. Through `supervisor.start()`, that loser is then caught by the fail-open path and starts without its tool.

   **Suggested fix:** Use one shared readiness deadline at least as long as the spawn/socket-health deadline, or wait on a per-pool readiness promise/state transition instead of independent short polling. Add a delayed-success concurrent attach test, not only immediate-listen fixtures.

5. **A crash during discard leaves an unrecoverable generic claim that stale-create recovery can use to recreate the deleted worktree**

   **File/area:** `supervisor/runtime/supervisor.js:3234-3297,3415-3517`

   **Concrete failure scenario:** `discardTaskWorktree()` now writes the same generic `WORKTREE_CLAIM_PENDING` marker used by creation. If the daemon crashes after claiming, every later discard returns `worktree-claim-conflict`; discard has no stale-claim recovery. After 60 seconds, `createTaskWorktree()` is allowed to reclaim that marker. If the old discard had already completed `git worktree remove` before crashing but had not finalized the row, creation sees no directory and runs `git worktree add`, reversing the requested deletion. The double-discard test covers only two calls that both settle normally.

   **Suggested fix:** Persist the claim operation (`create` or `discard`) and original path/intent, implement stale-discard recovery (including boot recovery), and let a later discard reclaim a stale discard claim. Add process-crash tests immediately before and after `git worktree remove` and before finalization.

6. **Pool readiness checks only pathname existence and can publish a non-listening or already-dead server**

   **File/area:** `supervisor/runtime/mcp-pool.js:154-195`

   **Concrete failure scenario:** `spawnOne()` treats `fs.existsSync(socketPath)` as proof that the socket is "ACTUALLY listening." A misconfigured process can create a regular file there and remain alive, or create a Unix socket and exit before the `exit` listener is installed. In the latter race the already-emitted exit event is not replayed, so the row can remain `ready`; attach succeeds, but every proxy receives `ENOTSOCK`, `ECONNREFUSED`, or a dead endpoint.

   **Suggested fix:** Install child exit/error tracking immediately after spawn, check liveness before publishing, verify the path is a socket, and perform a bounded real connection/health handshake before `markPoolReady()`. Add regular-file and create-then-exit regressions.

### Low

7. **The new proxy relay tests can hang forever instead of failing**

   **File/area:** `supervisor/runtime/test/mcp-stdio-proxy.test.js:59-75`

   **Concrete failure scenario:** Both relay assertions wait with `setInterval()` and have no deadline or rejection path. If the proxy connects but one direction stops forwarding, the test never reaches `finally`; the live proxy and socket can also keep `server.close()` pending. A transport regression can therefore hang the entire suite rather than produce a failed test.

   **Suggested fix:** Replace both polling promises with bounded event/deadline helpers, clear timers on every outcome, retain every spawned proxy, and force-terminate it in `finally`.

### Documentation Consistency

8. **Current documentation simultaneously says MCP delivery is fixed, absent, and uncommitted**

   **File/area:** `HANDOFF.md:322-334`; `ROADMAP.md:53-64,505-513,645-670`; `PLAN.md:1839-1854,1881-1883`; `supervisor/domain/mcp-manifest.js:26-34`; `TODO.md:27-31,66-76`

   **Concrete failure scenario:** The new top-level status says finding 13 is fixed and every review finding is resolved, but later current-state sections still say `start()` never sets `spec.mcpConfig`, workers receive no usable MCP connection, and role manifests are not wired. `ROADMAP.md` also says the findings 8/13 batch is not committed even though it is commit `79aa275`, while `HANDOFF.md` introduces fixed findings under a "Not yet actioned" heading. A maintainer cannot tell which delivery state or commit state is authoritative.

   **Suggested fix:** Update the current-state portions of `HANDOFF.md`, `ROADMAP.md`, `PLAN.md`, `TODO.md`, and the manifest header together. Mark historical descriptions explicitly as superseded, record `79aa275` as the closing commit, and document the actual remaining limitations: fail-open startup, Claude-only config delivery, no resume reattachment, and no delivered project-owned AWS MCP pool.

## Verification

- Read `codexdoc/review-sol-2026-09-13.md` first and excluded its already-reported findings from this report.
- Reviewed the complete `79aa275` diff and the affected runtime, adapter, configuration, tests, and current documentation inside this repository only.
- `npm test` from `supervisor/` passed in full.
- `git diff 7b6af0a^ 79aa275 --check` reported only the pre-existing `TUI-GUIDE.md` blank-line-at-EOF warning; `git diff --check` on the otherwise-clean current worktree passed.
- A real delayed Unix-socket server reproduced finding 4: one concurrent attach fulfilled after approximately 2.1 seconds while the other rejected with the pool attach timeout.
- Per the scope limit, no sibling repository was read. Statements about `leo-mcp` framing/socket behavior are treated only as declarations made by comments and tests in this repository, not independently verified claims about that sibling.
