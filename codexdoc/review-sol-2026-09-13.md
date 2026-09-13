# Full Uncommitted-Work Review - 2026-09-13

## Recommendation

**Request changes. Risk: critical.**

The current suite passes, but the uncommitted implementation contains security-boundary violations, data-loss races, lease-consistency failures, unsafe process reconciliation, and UI behavior that can mislead an operator into approving the wrong request. Several Phase 7 completion claims also describe functionality that is not connected to workers yet.

## Findings

### Critical

1. **MCP boot reconciliation can kill an unrelated process after PID or process-group reuse**

   **File/area:** `supervisor/runtime/mcp-pool.js:191-202`

   **What is wrong:** Pool rows persist only PID and PGID. On restart, reconciliation checks that the PID is alive and then signals the stored process group. It discards the process start time returned by `spawnManaged()`, so it cannot prove that the live PID is the process originally created for the pool.

   **Why it matters:** After PID/PGID reuse, boot reconciliation can terminate an unrelated process group. The normal run-reconciliation path already avoids this by checking PID, PGID, and process start time.

   **Suggested fix:** Persist the verified process start time for MCP children and require a full identity match before signaling. On mismatch, mark the row failed without killing anything. Add a PID-reuse regression test using a live process with a different start time.

### High

2. **Ordinary workers can create or forcibly destroy another task's worktree**

   **File/area:** `supervisor/domain/capabilities.js:176-180,207-212`; `supervisor/runtime/supervisor.js:3853-3869`

   **What is wrong:** `createTaskWorktree`, `discardTaskWorktree`, and `requestWorktree` all require the same `task:worktree` capability, which workers and reviewers receive. Only `requestWorktree` checks ownership. The other handlers accept arbitrary task IDs and `discardTaskWorktree` accepts `force: true`.

   **Why it matters:** A compromised worker can create worktrees in another accessible repository or delete another terminal task's dirty worktree.

   **Suggested fix:** Split self-service overlay requests from worktree administration, or enforce task/run ownership in every handler. Reserve forced discard and unrelated-task operations for owner/CTO principals. Add authenticated cross-task negative tests.

3. **One worker can approve another worker's parked tool request**

   **File/area:** `supervisor/runtime/supervisor.js:4010-4039`; `supervisor/domain/capabilities.js:207-212`

   **What is wrong:** The answer handler prevents a worker from answering an ask for its own run, but permits it to answer another worker's ask because normal workers hold `ask:answer`.

   **Why it matters:** A compromised model can approve a peer's side-effecting tool request and bypass the intended human/CTO decision boundary.

   **Suggested fix:** Forbid all worker and utility principals from deciding tool approvals. If automated recovery is required, create a narrowly scoped principal that cannot approve side effects. Add worker-A/worker-B authorization tests.

4. **The Git utility principal is not bound to a delegated task or path set**

   **File/area:** `supervisor/runtime/supervisor.js:3431-3473,3915-3955`; `supervisor/agents/git-create-push.js:201-226,264-267`

   **What is wrong:** `gitPush` and `gitPushProtected` accept any `taskId`; the server does not bind the request to the utility worker's assigned task or a persisted delegation. `paths` is optional and defaults to `git add -A`.

   **Why it matters:** A compromised Git utility runner can select any task worktree, commit all of its changes, and push them to an unprotected branch.

   **Suggested fix:** Persist an immutable delegated task/worktree when creating the utility task and validate it on every push. Require explicit, non-empty paths for shared worktrees and bind task, paths, remote, and destination into the approval record.

5. **A path-scoped Git push still commits unrelated pre-staged changes**

   **File/area:** `supervisor/agents/git-create-push.js:201-208,216-226,264-267`

   **What is wrong:** `paths` limits only the new `git add`; `git commit` still commits everything already present in the index. A focused reproduction with `paths: ["mine.txt"]` committed both `mine.txt` and an unrelated pre-staged `other.txt`.

   **Why it matters:** In a shared worktree, one task can accidentally publish another task's staged work.

   **Suggested fix:** Reject any pre-existing staged path outside the allowed set, or use a dedicated temporary index. Add a regression test with an unrelated path staged before the operation.

6. **Protected-branch authorization has a check-to-push race**

   **File/area:** `supervisor/agents/git-create-push.js:178-190,242-245,303-307`; caller in `supervisor/runtime/supervisor.js:3431-3473`

   **What is wrong:** The caller classifies the current branch before entering `runFightLoop`, while the loop resolves it again before pushing when no explicit target is supplied. Another process can switch the shared worktree from a feature branch to `main` between those checks.

   **Why it matters:** A request authorized only for `gitPush` can end up pushing a protected branch without the second signature.

   **Suggested fix:** Acquire the lease first, resolve and classify one immutable destination, authorize that exact destination, and push an explicit refspec. Add a deterministic branch-switch regression test.

7. **Worktree dirty detection fails open and can delete uncommitted work**

   **File/area:** `supervisor/runtime/supervisor.js:3263-3274,3312-3328`

   **What is wrong:** `worktreeHasUncommittedChanges()` returns `false` if `git status --porcelain` errors or times out. The caller interprets that as clean and runs `git worktree remove --force`.

   **Why it matters:** Permissions failures, repository corruption, transient I/O errors, or a timeout authorize destructive deletion when cleanliness was never established.

   **Suggested fix:** Return clean, dirty, or error. Refuse removal on error unless the caller explicitly requested force, and return the Git diagnostic. Test both failure and timeout paths.

8. **Worktree removal races with start, resume, and worker reassignment**

   **File/area:** `supervisor/runtime/supervisor.js:1087-1250,1294-1321,2382-2402,3277-3335`

   **What is wrong:** The terminal-task guard protects assignment only. Wire-exposed `start` can still launch an assigned worker for a terminal task, and `resume` can reopen an old run after discard has checked for open runs. The open-run lookup joins through the worker's current assignment, so reassignment can hide an older run still using the worktree.

   **Why it matters:** A process can begin using a worktree immediately before it is forcibly removed, causing data loss and invalid live CWDs.

   **Suggested fix:** Persist a per-task filesystem lifecycle state such as `discarding`, acquire it atomically before checking runs, and make start/resume/assign/create refuse while held. Store immutable task/worktree attribution on each run. Add deterministic start/discard and resume/discard race tests.

9. **Stale worktree claims have no claimant identity and can be finalized by the loser**

   **File/area:** `supervisor/db/index.js:585-624`; callers at `supervisor/runtime/supervisor.js:3181-3247`

   **What is wrong:** Every claimant writes the same pending sentinel. Reclaiming a stale claim updates only the timestamp, so the original claimant can return later and still finalize the row. Runtime callers also ignore `{ finalized: false }`.

   **Why it matters:** Two processes can perform Git work for one task, and a stale loser can overwrite the recovered winner's worktree binding. This was reproduced directly.

   **Suggested fix:** Persist a random claim token or generation. Require it in reclaim, finalize, and release predicates, and check every finalize/release result before reporting success.

10. **Lease renewal can resurrect an already expired lease after SQLite lock wait**

   **File/area:** `supervisor/db/index.js:1917-1925`

   **What is wrong:** `renewLeaseRow()` calculates `ts` and the new expiry before executing the write. If SQLite waits behind another writer, the predicate compares against stale pre-wait time. A focused reproduction renewed a 300 ms lease after it had been expired for more than 500 ms.

   **Why it matters:** An old holder can regain a resource after expiry and race a replacement holder, defeating exclusivity.

   **Suggested fix:** Obtain the write lock first, then compute time and conditionally update in the same transaction, or use SQLite's current time consistently in the statement. Add a cross-process lock-contention test.

11. **Active leases can mix incompatible policies for the same resource**

   **File/area:** `supervisor/db/index.js:1828-1871`; `supervisor/db/migrations/0011_leases_and_mcp_pool.sql:44-66`

   **What is wrong:** Admission uses only the incoming request's `kind` and `capacity`; it does not verify that active rows for the resource use the same policy. A reproduction admitted counted leases alongside an active exclusive lease.

   **Why it matters:** Reloading `resources.json` while a lease is active can immediately defeat the existing holder's exclusivity guarantee.

   **Suggested fix:** Store one authoritative policy per resource, or reject acquisition when any active row has a different kind/capacity. Defer policy changes until active leases drain. Add a configuration-reload test.

12. **Workers can acquire and indefinitely renew the global Git identity lease**

   **File/area:** `supervisor/domain/capabilities.js:181-184,207-212`; resource lease handlers in `supervisor/runtime/supervisor.js`

   **What is wrong:** A generic `resource:lease` capability is granted to workers/reviewers for heavy jobs, but it authorizes every resource. A worker can acquire `git:identity` without a run and repeatedly renew it.

   **Why it matters:** Any worker can deny all utility pushes even though normal workers intentionally have no `git:*` capabilities.

   **Suggested fix:** Use resource-specific capabilities or enforce principal/resource policy: workers may acquire only `host:heavy-job`, for their own run, and never `git:identity`. Add negative acquire/renew tests.

13. **MCP pooling does not provide a usable tool connection to utility workers**

   **File/area:** `supervisor/runtime/supervisor.js:1133-1183`; `supervisor/domain/mcp-manifest.js:26-51`; `supervisor/domain/utility-instructions.js:29-45`

   **What is wrong:** The manager spawns and records a pool attachment, but stdin/stdout are never connected to the adapter and `spec.mcpConfig` is deliberately left unset. Jira and Slack prompts still instruct workers to use `leo-mcp`; `awsquery-runner` similarly has no delivered AWS tool.

   **Why it matters:** Utility runs can enter `planning` and appear ready while having no channel to perform their advertised operation. Current tests prove bookkeeping, not tool availability.

   **Suggested fix:** Deliver a real adapter-supported multiplexed transport and fail start/assignment when required tooling cannot be provided. Until then, do not expose these utility types as runnable. Add real-adapter tool discovery/invocation tests.

14. **Concurrent callers can attach to an MCP pool before its process is ready**

   **File/area:** `supervisor/db/index.js:2067-2082`; `supervisor/runtime/mcp-pool.js:80-83`

   **What is wrong:** `attachToPool()` considers both `starting` and `ready` rows joinable. A second caller can receive a successful attachment before the winning caller has finished spawn and verification. This ordering was reproduced.

   **Why it matters:** A caller is told the pool is usable before PID, transport, and health are established; later spawn failure silently invalidates an attachment already reported as successful.

   **Suggested fix:** Attach only to `ready`. Wait/retry on `starting` and propagate a transition to `failed`. Add delayed-success and failed-spawn concurrency tests.

15. **Post-spawn MCP attachment failure leaks the child process**

   **File/area:** `supervisor/runtime/mcp-pool.js:90-105`

   **What is wrong:** After `spawnOne()` succeeds, failure of the subsequent attachment insert marks the row failed but does not kill the process or remove the live handle.

   **Why it matters:** Invalid run/principal references or database errors leave an untracked resident process; later resurrection can create a duplicate server.

   **Suggested fix:** On post-spawn failure, terminate the verified process group, remove the live handle only after confirmed death, and then persist failure. Add a forced attachment-insert failure test.

16. **Overlapping TUI refreshes can regress state and duplicate transcript events**

   **File/area:** `supervisor/tui/app.js:135-188,385-389`

   **What is wrong:** `setInterval(refresh, refreshMs)` starts asynchronous refreshes without serialization. Requests can use the same cursor and responses are applied in completion order with no generation check. A reproduction left an older team snapshot active and transcript order `new, old`.

   **Why it matters:** The operator can see stale tasks/runs and duplicated or reordered evidence.

   **Suggested fix:** Make refresh single-flight or discard stale generations. Apply cursor and snapshot changes atomically. Add a deferred-response test in which request 2 completes before request 1.

17. **Request text is rendered as unsanitized terminal control input**

   **File/area:** `supervisor/tui/layout.js:166-194`; source at `supervisor/runtime/supervisor.js:2939-2952`

   **What is wrong:** The detail view writes external `raw_text` directly to terminal output. `JSON.stringify` protects the compact panel, but the new full detail view does not escape ESC, OSC, carriage return, BEL, or other controls.

   **Why it matters:** A request can clear/reposition the display, spoof controls, alter terminal state, or trigger terminal-specific OSC behavior.

   **Suggested fix:** Establish one terminal-safe rendering boundary for all external text. Strip or visibly escape C0/C1 and ANSI/OSC sequences before wrapping. Add ESC, CR, BEL, OSC, tab, and newline tests.

18. **A disappearing request silently changes an open detail view to another request**

   **File/area:** `supervisor/tui/state.js:451-463`

   **What is wrong:** If the selected request disappears while others remain, `withRequests()` selects the first remaining request but leaves focus in `REQUEST_DETAIL`.

   **Why it matters:** The detail content changes under the operator; the next accept/decline action can target a request they did not open.

   **Suggested fix:** If the selected ID disappears, close detail and return to the requests list with an explanatory status. Add a two-request regression test.

19. **Claude code-0/no-result exits are falsely reported as completed**

   **File/area:** `supervisor/adapters/claude-code/adapter.js:403-425`

   **What is wrong:** The new protocol rule says an exit without a `result` record is failure, but fallback status still returns `completed` for exit code 0. The code also overwrites an explicit `stopped` state before checking it, so a deliberate stop can become `error` instead of `aborted`.

   **Why it matters:** The event pump records incorrect terminal status and can treat protocol failure as successful task completion.

   **Suggested fix:** Preserve pre-exit intent. Report `aborted` for an explicit stop and `error` for every other no-result exit, including code 0. Test both cases.

### Medium

20. **Preflight deletion is blocked by new lease and MCP foreign keys**

   **File/area:** `supervisor/db/index.js:714-742`; FKs in migrations `0011` and `0013`

   **What is wrong:** `deletePreflightRun()` deletes events, asks, and orphan sightings only. Released `resource_leases` and detached `mcp_pool_attachments` still reference the run and cause `FOREIGN KEY constraint failed`. This was reproduced.

   **Why it matters:** Completed preflight history cannot be cleaned up and can be retried/logged indefinitely.

   **Suggested fix:** Define retention explicitly: delete dependent history in the transaction, null the run reference, or use an intentional `ON DELETE` action. Test released leases and detached attachments.

21. **IPC shutdown can drop its notice and leave requests pending forever**

   **File/area:** `supervisor/ipc/server.js:345-351`; `supervisor/ipc/client.js:28-54,86-88`; `supervisor/ipc/test/teardown.test.js:63-72`

   **What is wrong:** The server queues a notice then immediately calls `socket.destroy()`, which does not guarantee delivery. The client does not settle entries in `pending` on close/error, and a notice does not settle them either.

   **Why it matters:** Shutdown notice delivery is nondeterministic and ordinary `send()` promises can hang forever.

   **Suggested fix:** Use `socket.end(encodedNotice)` with a bounded forced-destroy timer. Reject all pending operations on close/error and clear handlers. Replace timing sleeps with a deterministic close/notice race test.

22. **MCP teardown records success even if the process survives, and graceful shutdown does not drain pools**

   **File/area:** `supervisor/runtime/mcp-pool.js:159-174,191-207`; `supervisor/runtime/supervisor.js:2764-2812`

   **What is wrong:** Detach/reconciliation ignore `{ killed: false }`, clear handles, and mark rows stopped/failed. Separately, supervisor shutdown disposes adapters and closes the DB without a pool-wide disposal phase.

   **Why it matters:** Surviving children become untracked, duplicate pools can spawn, and exit handlers can run against a closed database.

   **Suggested fix:** Keep a draining/error state and live handle until death is confirmed. Add bounded `disposeAll()` before database close and test both failed kill and graceful shutdown.

23. **Synchronous worktree commands can freeze the whole daemon for tens of seconds**

   **File/area:** `supervisor/runtime/supervisor.js:3110-3127,3142-3218,3266-3274,3323-3326,3392-3395`

   **What is wrong:** Worktree creation/status/removal use `execFileSync`; pending-claim polling uses `sleepSync`. Individual Git attempts can block for 30 seconds.

   **Why it matters:** The daemon cannot service approvals, sockets, lease renewals, event persistence, or child cleanup while blocked.

   **Suggested fix:** Convert Git operations and polling to asynchronous calls and serialize only per task. Add an event-loop responsiveness test around a deliberately slow Git process.

24. **TUI Accept/Decline reports success without performing any mutation**

   **File/area:** `supervisor/tui/app.js:353-365`

   **What is wrong:** The UI says `accepted <id>` or `declined <id>`, clears the pending handoff, and closes detail, but sends no supervisor command. The request remains pending on refresh.

   **Why it matters:** The operator receives a false success indication for a decision that was not persisted.

   **Suggested fix:** Implement an authenticated decision command, or disable these controls and avoid past-tense success wording. Add an app-level command/result test.

25. **Request detail can hide content required for an informed decision**

   **File/area:** `supervisor/tui/layout.js:166-196`

   **What is wrong:** `wrapText()` does not split tokens wider than the screen, and `body.slice(0, bodyBudget)` silently drops messages taller than the viewport.

   **Why it matters:** URLs, hashes, stack traces, and long requests can be incomplete immediately before the operator accepts or declines them.

   **Suggested fix:** Hard-wrap long tokens, add scrolling, and show explicit continuation indicators. Test a 2,000-character token and a multi-screen message.

26. **Request panel visibility and focus can become internally inconsistent**

   **File/area:** `supervisor/tui/state.js:291-317,451-460`

   **What is wrong:** Hiding Requests while in detail leaves detail focus; Escape then focuses the hidden panel. Also, toggling `R` with zero requests is undone by the next empty snapshot, despite the test/guide claiming it works regardless of pending count.

   **Why it matters:** Keyboard actions can target an invisible component, and a documented toggle reverses on the next poll.

   **Suggested fix:** Separate explicit visibility preference from batch dismissal and return to tree/pane when detail closes into a hidden panel. Add `detail -> R -> Escape` and zero-pending refresh tests.

27. **Request keyboard selection can move completely off-screen**

   **File/area:** `supervisor/tui/state.js:424-431`; `supervisor/tui/layout.js:145-153`

   **What is wrong:** Up/down changes the selected request but never adjusts `requestScroll`.

   **Why it matters:** Return can open a request the operator cannot see, increasing the risk of acting on the wrong item.

   **Suggested fix:** Keep scroll synchronized with selection and visible capacity. Test navigation with more requests than fit in the panel.

28. **TUI capture failure leaks resources and can corrupt later captures**

   **File/area:** `supervisor/tui/capture-frames.mjs:33-125,248-255`

   **What is wrong:** Cleanup runs only on the successful path. A timeout, render exception, or failed assertion skips harness, socket, DB, and state-directory teardown.

   **Why it matters:** Failed captures can leave processes and sockets alive; a later run can delete a directory still used by the previous process.

   **Suggested fix:** Wrap the complete lifecycle in `try/finally`, dispose in reverse order, and set `process.exitCode`. Add an injected-failure cleanup test.

29. **TUI width calculations are not terminal-cell aware**

   **File/area:** `supervisor/tui/layout.js:27-32` and fit/wrap calculations throughout

   **What is wrong:** JavaScript `.length` measures UTF-16 code units, not display cells. Emoji, CJK, combining characters, and surrogate pairs render at different widths.

   **Why it matters:** Borders, hit targets, and repaint regions drift and can leave terminal artifacts.

   **Suggested fix:** Sanitize first, then use one terminal-cell-width function for fit, wrap, chip geometry, and hit testing. Add wide/combining-character frame tests.

30. **TUI stop leaks listeners and may leave the client open**

   **File/area:** `supervisor/tui/app.js:369-402`

   **What is wrong:** Anonymous input/resize listeners cannot be removed and `client.close()` is not called.

   **Why it matters:** Restarting or embedding the TUI accumulates listeners and can repaint after stop or retain a socket.

   **Suggested fix:** Retain named handlers, remove them in `stop()`, and call `client.close?.()`. Test listener counts and post-stop resize behavior.

31. **Protected-branch configuration silently accepts misspelled policy keys**

   **File/area:** `supervisor/config/protected-branches.js:26-53`

   **What is wrong:** Unknown top-level keys are ignored. For example, `branch` instead of `branches` silently falls back to `main`/`master`.

   **Why it matters:** An administrator can believe `production` is protected when it is not, allowing ordinary `gitPush` authorization.

   **Suggested fix:** Reject unknown keys and require a valid `branches` array when the file exists. Test misspellings, extras, duplicates, and blank names.

32. **MCP and resource configuration defer malformed data to unsafe runtime behavior**

   **File/area:** `supervisor/config/mcp-pools.js:70-87`; `supervisor/config/resources.js:68-105`

   **What is wrong:** MCP `args`, `env`, and `cwd` shapes are not fully validated. Resource arrays and unknown/misspelled keys are accepted and silently fall back to defaults.

   **Why it matters:** Configuration mistakes become late spawn failures or weaker host-resource policy rather than fail-loud startup errors.

   **Suggested fix:** Validate exact top-level key sets and field types. Require string arrays/values and plain objects where applicable. Add malformed-shape tests.

33. **OpenCode stderr byte limits are not actually byte limits**

   **File/area:** `supervisor/adapters/opencode/adapter.js:78-102`; `supervisor/adapters/opencode/test/stderr-ring.test.mjs`

   **What is wrong:** Truncation subtracts `.length` and uses string slicing, both UTF-16 code-unit operations. The ring also retains one oversized entry. A 1,024-byte ring retained 2,038 bytes of emoji input.

   **Why it matters:** Diagnostic memory can exceed the configured bound, especially with multibyte output.

   **Suggested fix:** Truncate buffers by UTF-8 byte count while preserving valid encoding, count suffix bytes, validate a positive integer limit, and test multibyte/small budgets.

34. **Lock cleanup can mask the primary acquisition failure**

   **File/area:** `supervisor/lock/lock.js:223-242`

   **What is wrong:** If write/link fails and the `finally` unlink also fails, the cleanup exception replaces the original error.

   **Why it matters:** Operators and retry logic see the wrong root cause.

   **Suggested fix:** Preserve the primary exception and attach/log cleanup failure separately. Test simultaneous write and unlink failure.

### Documentation And Delivery Consistency

35. **Phase 7 and Jira/Slack utility execution are documented as complete although workers receive no MCP tool**

   **File/area:** `HANDOFF.md:264-269,1327-1328`; `ROADMAP.md:3-10`; `TODO.md:27-28,63-68`

   **What is wrong:** The docs call Phase 7 functionally complete and Jira/Slack usable. The implementation explicitly omits `spec.mcpConfig` and provides only supervisor-side pool bookkeeping (`supervisor/runtime/supervisor.js:1133-1183`).

   **Why it matters:** Maintainers can schedule utility work that starts successfully but cannot perform its operation.

   **Suggested fix:** Describe Phase 7 as lifecycle/framework complete but worker transport incomplete. Keep Jira/Slack execution open until a real adapter can discover and invoke the pooled tool.

36. **Git identity switching is promised but not implemented**

   **File/area:** `PLAN.md:1601-1606,1686-1688`; completion claims in `ROADMAP.md:479-489` and `TODO.md:59-62`

   **What is wrong:** PLAN says the lease covers `switch -> push -> restore`, but runtime only acquires `git:identity`, invokes `git push`, and releases it. There is no `gh auth switch`, account selection/verification, or restoration.

   **Why it matters:** Serialization does not ensure that the push uses the intended identity.

   **Suggested fix:** Document account selection as an external precondition, or implement and test switch/verify/restore inside the leased section.

37. **PLAN promises automatic shared-worktree creation and dirty-state copying that do not exist**

   **File/area:** `PLAN.md:560-565,589-591`

   **What is wrong:** Assignment uses an already recorded `worktree_id`; it does not create one. Worktree creation is an explicit API call and starts from committed branch/HEAD state without copying dirty files.

   **Why it matters:** A caller relying on the plan can start in the wrong CWD or lose expected uncommitted context.

   **Suggested fix:** State that creation is an explicit prerequisite requiring `repoPath` and starts from committed state, or implement the promised behavior with tests.

38. **TODO closes operation-intent deduplication although no side-effecting path uses it**

   **File/area:** `TODO.md:69-70`; contradictory open item in `ROADMAP.md:616-617`; intended behavior in `PLAN.md:1469-1472`

   **What is wrong:** `journalHasDone` exists as a query primitive, but Git/Jira/Slack execution does not write/check a stable intent before acting. Jira/Slack do not have executable paths at all.

   **Why it matters:** Retries can repeat external operations; an append-only journal alone does not provide idempotency.

   **Suggested fix:** Mark the item partial/open until every side-effecting operation records intent and checks a stable deduplication key before retry.

39. **PLAN documents automatic heavy-job waiting that is only an immediate caller-managed refusal API**

   **File/area:** `PLAN.md:1686-1697`

   **What is wrong:** No build/test task path automatically acquires `host:heavy-job`. Contention returns `{ granted: false }`; there is no idle pane state, wait/resume loop, or eventual blocker handoff.

   **Why it matters:** The primitive does not prevent the concurrent-heavy-job incident described by the plan.

   **Suggested fix:** Mark automatic acquisition and waiting as future work and describe the current API accurately.

40. **Utility sessions are described as self-clearing although `clearPolicy` has no runtime consumer**

   **File/area:** `PLAN.md:1391-1409`; caveats already present in `HANDOFF.md:15-34`, `ROADMAP.md:628-636`, `TODO.md:32-33`

   **What is wrong:** Configuration declares/validates `clearPolicy`, but runtime never reads it to clear or resume a session.

   **Why it matters:** The documented context-economy behavior does not occur.

   **Suggested fix:** Describe it as an intended policy only, or implement the lifecycle consumer and tests.

41. **Requests auto-reappearance is overstated**

   **File/area:** `FLOWS.md:121,182-186`; related claims in `PLAN.md:1179-1180` and `TUI-GUIDE.md:58-69,281-290`

   **What is wrong:** `withRequests()` clears hidden state only after the list becomes empty. If A remains pending while B arrives, the hidden panel stays hidden.

   **Why it matters:** A new request can remain invisible despite the documented alerting guarantee.

   **Suggested fix:** Document the actual empty-then-new-batch behavior or unhide when a newly observed request ID arrives.

42. **ROADMAP's current Phase 7 record contains mutually stale status claims**

   **File/area:** `ROADMAP.md:377-380,472-478`

   **What is wrong:** It says ended runs display as `crashed`, utility prompts/dispatch are undone, and ambiguously calls Slack read-only. Current code uses `ended`, implements utility prompts/dispatch, and gives `utility:slack` a posting capability while `utility:awsquery` is read-only.

   **Why it matters:** The roadmap cannot be used as a reliable current handoff record.

   **Suggested fix:** Mark obsolete entries historical and correct the role/capability names.

43. **PLAN gives the wrong in-process `requestWorktree` signature**

   **File/area:** `PLAN.md:572`

   **What is wrong:** It documents `requestWorktree(runId, reason)`, while the method expects `requestWorktree(runId, { reason, principal })`.

   **Why it matters:** A caller following PLAN passes a string where object destructuring is expected and loses the reason.

   **Suggested fix:** Document the in-process options object and separately show the wire payload.

44. **TUI-GUIDE's focus and demonstration claims do not match the implementation or frames**

   **File/area:** `TUI-GUIDE.md:149-152,294-333,376-431,508-543,763-767,844-848,887-893,928-929`

   **What is wrong:** `t`/`R` do not toggle while chat has focus; several examples claim two panes while showing one; reviewer hide/fullscreen/tab frames do not demonstrate a visual change; the chat sequence escapes and opens a task instead of sending; request-detail global keys remain active despite claims that pane/tree keys do nothing.

   **Why it matters:** The screen guide teaches incorrect keyboard behavior and claims evidence for interactions it does not exercise.

   **Suggested fix:** Correct the focus rules, use a task with two actual panes for hide/fullscreen/tab captures, add a send-while-chat-focused scene, and document or disable global key fallthrough in detail view.

45. **Existing untracked architecture/review evidence is stale and internally contradictory**

   **File/area:** `codexdoc/ARCHITECTURE.md`; `codexdoc/ARCHITECTURE-luna-2026-09-11.md`; `codexdoc/REVIEW-NOTES.md`; `codexdoc/REVIEW-NOTES-luna-2026-09-11.md`; `codexdoc/review-luna-2026-09-11.md`; `codexdoc/review-phase7-uncommitted.md`

   **What is wrong:** These documents mix pre-fix findings with current-state claims. Examples include migrations ending at 0012, utility assignment being rejected, synchronous Git execution, MCP metadata being delivered in `spec.mcpConfig`, and the same issue being labeled both deferred and fixed.

   **Why it matters:** Readers cannot distinguish open risks from historical findings and may rely on obsolete architecture.

   **Suggested fix:** Mark each file as a dated pre-fix snapshot or regenerate it from the current tree. Normalize findings to one explicit status (`OPEN`, `PARTIAL`, `FIXED`, or `SUPERSEDED`).

46. **The existing reproduction script is stale, exits early, and can touch default user credentials**

   **File/area:** `codexdoc/evidence/reproduce.mjs:56-173`; claim in `codexdoc/REVIEW-NOTES.md:13-15`

   **What is wrong:** It exits at a now-fixed reviewer identity guard, contains assertions for fixed behavior, calls async `runFightLoop()` without `await`, and invokes `attachPane()` without fixture state/token so it reads the default `owner.token`.

   **Why it matters:** It no longer proves the documented defects, can race cleanup, and can send an unrelated real token to a temporary fixture server.

   **Suggested fix:** Rewrite it as current regression tests using awaited calls, exact refusal assertions, and fixture-local credentials, or archive it explicitly as non-executable historical evidence.

### Low

47. **Migration upgrade coverage stops short of migrations 0013 and 0014**

   **File/area:** `supervisor/db/test/migrations.test.js`; `supervisor/db/test/migration-0011.test.js`; `supervisor/db/test/migration-0012.test.js`

   **What is wrong:** There are no populated 0012-to-0013 or 0013-to-0014 upgrade fixtures; the generic table list omits `mcp_pool_attachments`; lifecycle backfill and new foreign keys are not asserted.

   **Why it matters:** Fresh-database tests can pass while real upgrades fail or persist invalid states.

   **Suggested fix:** Add populated prior-version fixtures and assert tables, columns, indexes, FKs, lifecycle backfill, and worktree claim binding.

48. **Request timestamps use a field name the runtime does not supply**

   **File/area:** `supervisor/tui/layout.js:183`; runtime projection at `supervisor/runtime/supervisor.js:2944-2952`

   **What is wrong:** Layout reads `postedAt`/`at`, while the snapshot supplies `createdAt`.

   **Why it matters:** Real request details omit available timestamp data.

   **Suggested fix:** Read `createdAt` and add a snapshot-shaped fixture.

49. **IPC peer-credential rationale overstates macOS/BSD process identity**

   **File/area:** `supervisor/ipc/FINDINGS.md:154-160`; similar wording in `HANDOFF.md:36-54`

   **What is wrong:** Linux `SO_PEERCRED` can expose PID, but macOS/BSD `getpeereid` exposes effective UID/GID and cannot distinguish same-user processes. The `0700` state directory already enforces the cross-user boundary.

   **Why it matters:** The decision may remain valid, but its threat-model rationale is technically inaccurate.

   **Suggested fix:** State that peer credentials duplicate the cross-user UID boundary; only some platforms expose PID, which would still need trusted process binding.

50. **Two root artifacts are empty and appear accidental**

   **File/area:** `2026-09-11.md`; `Untitled.canvas`

   **What is wrong:** The markdown file is zero bytes and the canvas contains only `{}`.

   **Why it matters:** They add unreviewable, unnamed artifacts with no apparent project purpose.

   **Suggested fix:** Populate and rename them for an explicit purpose or omit them from the change.

## Verification

- `git status --short`, `git diff --stat`, `git diff --name-status`, and the complete tracked/untracked file inventory were reviewed.
- `npm test` from `supervisor/` passed: 127 suites, exit 0.
- Focused subsystem commands passed: `npm run test:adapters`, `npm run test:domain`, `npm run test:agents`, `npm run test:db`, `npm run test:lock`, `npm run test:ipc`, and `npm run test:tui`.
- Focused runtime worktree, lease, MCP pool, utility lane, and Git push tests passed.
- `git diff --check` passed.
- `node tui/capture-frames.mjs` passed and reproduced the checked-in evidence.
- `node codexdoc/evidence/reproduce.mjs` failed early at a now-fixed reviewer-identity guard, confirming that the script is stale.
- Targeted reproductions confirmed findings 5, 9, 10, 11, 14, 16, 18, 20, 26, 27, and 33.
- The real GitHub slice was not run because it requires external credentials/network access and creates a real branch/PR.

## Coverage

Reviewed every modified or untracked file reported by `git status --short`, including:

- Root documentation and artifacts: `FLOWS.md`, `HANDOFF.md`, `PLAN.md`, `ROADMAP.md`, `TODO.md`, `TUI-GUIDE.md`, `2026-09-11.md`, and `Untitled.canvas`.
- All changed/new files under `supervisor/adapters`, `supervisor/agents`, `supervisor/config`, `supervisor/db`, `supervisor/domain`, `supervisor/ipc`, `supervisor/lock`, `supervisor/pane`, `supervisor/runtime`, and `supervisor/tui`, including tests, race helpers, migrations, and evidence.
- Existing untracked material under `codexdoc/`, including architecture notes, prior reviews, and `codexdoc/evidence/reproduce.mjs`.
