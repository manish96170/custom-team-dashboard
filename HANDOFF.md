# Handoff — custom-team-dashboard (updated 2026-09-14, forty-eighth pass — read this
whole header before doing anything else in a fresh session).

**Forty-sixth pass, same day (2026-09-13) — a full review of every uncommitted/untracked change,
commissioned from `opencode`'s `sol` agent (GPT-5.6 Sol via Bedrock — see
`~/.config/opencode/opencode.json`), full report at `codexdoc/review-sol-2026-09-13.md` (50 findings, 1
critical + 18 high + 15 medium + 12 doc-consistency + 4 low). **This pass fixed the critical finding, 15
of the 18 high findings, ALL 15 medium findings, ALL 12 doc-consistency findings, and ALL 4 low
findings** — every CODE fix verified to fail against the pre-fix code before the fix was restored (this
file's own standing rule); every DOC fix is a text correction, cross-checked against the actual current
code before being written. **This entire body of work (everything since the initial commit — Phase 7,
Phase 8's schema step, and this whole review response) was committed and pushed to `origin/main` the
same day** (`7b6af0a`) — the repo's long-standing "nothing committed this session" note from earlier
passes no longer applies as of this commit.
`npm test`: exit 0, all suites, throughout and after every fix below. Several `FAIL`s were hit mid-session
in `runtime/test/concurrency.test.js` and `runtime/test/mcp-pool.test.js` — both real-OS-process suites
already documented elsewhere in this file as occasionally flaky under load; every one passed clean
standalone and on an immediate full-suite re-run, none touched by this pass's edits.

**Doc-consistency (findings 35-46) are corrected directly in `PLAN.md`/`ROADMAP.md`/`TODO.md`/
`FLOWS.md`/`TUI-GUIDE.md`/`codexdoc/*.md` themselves** — each correction is inline, dated 2026-09-13,
citing the finding number, at the exact claim that was wrong; not reproduced here since the point is to
fix the claim where a reader will actually see it. The short version of what changed: Phase 7's
"functionally complete" language corrected everywhere to distinguish lifecycle/framework (done) from
worker-side MCP tool transport (not done, finding 13); git identity's "switch→push→restore" corrected to
what's actually built (acquire→push→release only); worktree creation/dirty-copy claims corrected to match
`createTaskWorktree`'s real explicit-call, committed-state-only behavior; the operation-intent-journal
item's contradictory `[x]`/`[ ]` across TODO.md/ROADMAP.md resolved to `[~]` (primitive built, unused);
`§20.2`'s automatic-heavy-job-wait language marked as target-not-current behavior; `clearPolicy`'s
self-clearing language marked schema-only; Requests-panel auto-reappearance corrected to its real
empty-then-new-batch rule (not "every new arrival"); stale ROADMAP status lines (the old `"crashed"`
label, the utility-roster `[ ]` that undersold what's built) corrected; `requestWorktree`'s documented
signature fixed to match the real options-object call; TUI-GUIDE's chat-focus key-fallthrough and
Request-Detail global-key claims corrected against the actual `keyToAction` code; all 6 dated
`codexdoc/*.md` review/architecture files got a "STALE SNAPSHOT" banner pointing to this file's own top
header as the current-state source of truth; `codexdoc/evidence/reproduce.mjs` marked archived,
non-executable historical evidence (it exits early at a now-fixed guard and would assert the WRONG,
pre-fix behavior if run).

**Fixed this pass:**
- **Finding 1 (CRITICAL) — MCP boot reconciliation could kill an unrelated process after PID/PGID
  reuse.** `mcp_pool` never persisted a process start time, so `reconcileOnBoot` verified only pid+pgid
  before signaling a process group — the exact gap `runs.proc_lstart` (migration 0002) already closed for
  regular runs. Fixed: new migration `0015_mcp_pool_lstart.sql` adds `mcp_pool.lstart`; `markPoolReady`
  persists it; `reconcileOnBoot` now calls `procinfo.js`'s `verifyProcIdentity()` (pid+pgid+lstart, all
  three) instead of a bare `isPidAlive` check, and refuses to kill on any mismatch rather than guessing.
  `runtime/test/mcp-pool.test.js` case 9 (new): a real live process recorded with a deliberately wrong
  `lstart` is left alone, not killed.
- **Finding 14 (high) — `attachToPool` used to consider a `starting` row joinable**, so a second caller
  could be told "attached" before spawn/verification had even finished. Fixed: only `ready` is joinable
  now; the claimer's own retry-join loop (unchanged) is the only path that ever observes `starting`.
  `mcp-pool.test.js` case 10 (new).
- **Finding 15 (high) — a post-spawn attachment-insert failure leaked the real child process.** The
  process was already spawned and marked `ready` in the DB by the time `attachToPool`'s retry-join could
  fail; the old code called `markPoolFailed` (DB-only) without killing the process or clearing the
  in-memory handle. Fixed in `runtime/mcp-pool.js`'s `attach()`: the catch block now kills the verified
  process group (or the bare child) and deletes the `liveChildren` entry before marking the row failed.
- **Finding 10 (high) — `renewLeaseRow` could resurrect an already-expired lease.** `ts` was computed
  BEFORE the UPDATE ran; if the write had to wait behind another writer (SQLite's busy handler), real
  wall-clock time could advance past the lease's `ttl_expires_at` during that wait, but the WHERE clause
  still compared against the stale pre-wait `ts`. Fixed: `ts`/`ttlExpiresAt` are now computed INSIDE a
  `BEGIN IMMEDIATE` transaction, so "now" is read only after the write lock is actually held — same fix
  `claimPoolSlot`/`db/migrate.js` already use for this exact class of gap. New case 14 in
  `db/test/leases.test.js`: a real second OS process holds the write lock for 600ms while a 200ms-TTL
  lease's renew call blocks on it; reproduced failing pre-fix (renewed a lease already expired ~400ms),
  passing after.
- **Finding 3 (high) — a worker could decide a DIFFERENT worker's parked tool-approval ask.** The
  existing self-run check (item 14 in an earlier pass) only stopped a worker answering its OWN ask.
  Fixed in `answerAsk`'s wire handler: any `kind: "worker"`/`"utility"` principal is now refused on an
  ask whose `kind` is `"tool-approval"` (the side-effecting decision `ask:answer`'s own preset comment
  already says is "reserved for a human/CTO"), regardless of whose run raised it — a plain `"question"`
  ask remains answerable cross-worker, unchanged. New case 15 in `runtime/test/authorization.test.js`.
- **Finding 2 (high) — no ownership check at all on `createTaskWorktree`/`discardTaskWorktree`.** Any
  worker's token could create or force-discard ANOTHER task's shared worktree; `force: true` was
  reachable by a worker/reviewer principal at all. Fixed: both now take an optional `principal` and
  refuse with `not-your-task` when a worker-backed principal names a task it is not currently assigned
  to (`workers.task_id`), and `discardTaskWorktree` refuses `force: true` outright from any
  worker/reviewer principal (owner/CTO only). New cases 15-16 in `runtime/test/worktree.test.js`.
- **Finding 7 (high) — `worktreeHasUncommittedChanges` failed OPEN.** A `git status` error or timeout
  returned `false` (= clean), and the caller then ran `git worktree remove --force` on that unverified
  "clean" verdict. Fixed: renamed to `worktreeStatus`, returns `clean`/`dirty`/`error` as distinct
  outcomes; `discardTaskWorktree` refuses removal on `error` (`worktree-status-unknown`) exactly like it
  already refused on `dirty`. New case 17 in `worktree.test.js`.
- **Finding 5 (high) — a path-scoped git push still committed unrelated PRE-STAGED changes.** `paths`
  scoped only `git add`; `git commit` with no pathspec commits the WHOLE index regardless, so anything
  already staged before the call (a different task's change, on the shared worktree `paths` exists to
  protect) rode along anyway. Fixed in `agents/git-create-push.js`: when `paths` is given, `git commit`
  now also takes `-- <paths>` (git's own "partial commit" form — commits only the named paths regardless
  of what else is staged). New case in `agents/test/git-create-push.test.js`.
- **Finding 17 (high) — the TUI Request Detail view rendered external text as raw, unescaped terminal
  control input.** ESC/OSC/CR/BEL bytes in a request's `raw_text` could clear/reposition the terminal or
  spoof its own controls; the compact panel happened to be safe only because it wraps text in
  `JSON.stringify` for unrelated cosmetic reasons. Fixed at `tui/layout.js`'s own single I/O boundary —
  `row()` — so every caller is covered, not just the detail view: control characters (`\x00`-`\x1f`,
  `\x7f`-`\x9f`) are replaced with the Unicode replacement character before fitting. New case 23 in
  `tui/test/tui.test.js`.
- **Finding 19 (high) — the Claude Code adapter's no-result fallback read `run.status` AFTER its own
  overwrite.** Two bugs from the same root cause: (a) exit code 0 with no `result` line produced
  `fallbackStatus: 'completed'`, directly contradicting this same function's own comment ("still does NOT
  mean the turn completed... always reported as an error, regardless of exit code"); (b) a deliberate
  `stop()` (which sets `run.status = 'stopped'` before the process actually dies) was clobbered by the
  same overwrite, making the fallback's own `'stopped'` branch dead code — a real abort was misreported
  as a raw error. Fixed: the PRIOR status is captured before the overwrite and is what the fallback now
  checks. New fake-binary mode `crash-clean-exit` and two new cases in
  `adapters/claude-code/test/test-claude-code-adapter.mjs`.
- **Finding 18 (high) — a disappearing request silently swapped the OPEN Request Detail view to a
  different request.** `withRequests()` retargeted `selectedRequestId` to whatever request happened to be
  first once the previously-selected one vanished, but left `focus` at `REQUEST_DETAIL` — so the screen
  content changed to a request the operator never opened, and the next Accept/Decline would act on it.
  Fixed in `tui/state.js`: detail view now closes back to the list in that case, same as the
  already-existing "nothing left at all" branch. New case 24 in `tui/test/tui.test.js`.
- **Finding 11 (high) — active leases could mix incompatible policies for the same resource.**
  `tryAcquireLease`'s `active.length >= limit` check used only the INCOMING call's own kind/capacity, with
  no check that active rows for the resource were admitted under the same policy — a `counted, capacity 3`
  request could be admitted alongside an active EXCLUSIVE holder (1 active row is "under" a limit of 3),
  defeating the exclusive holder's whole guarantee. Fixed in `db/index.js`: refuses outright when any
  active row's kind/capacity disagrees with the incoming request, before the count check. New case 15 in
  `db/test/leases.test.js`.
- **Finding 6 (high) — protected-branch classification had a check-to-push TOCTOU race.** `gitPush`
  classified a destination branch once, then passed the CALLER's original (often `null`) `targetBranch`
  onward to `gitCreatePush`/`runFightLoop`, which re-derives the worktree's current branch INDEPENDENTLY
  at push time when given `null`. Anything that switched the checked-out branch in between meant the
  authorization decision was made about a branch name that was no longer the one actually pushed. Fixed:
  the classified destination is now PINNED as the explicit `targetBranch` passed onward, so the push step
  never re-derives it. New mechanism-level case in `agents/test/git-create-push.test.js` proves an explicit
  `targetBranch` always wins as the remote destination regardless of what the local checked-out branch
  becomes later — this proves the primitive the fix depends on, not a live timing race in the wire
  handler itself (that race is real but not practically reproducible deterministically without adding a
  test-only seam to production code, which was not done).
- **Finding 4 (high) — neither git command bound the caller to a task at all.** `gitPush`/
  `gitPushProtected` accepted ANY `taskId` from ANY caller, including the git-utility runner itself (if its
  token leaked or its model was compromised) — nothing stopped it naming a different task's worktree than
  the one it was actually dispatched to work on. Fixed: both handlers now refuse a worker/utility principal
  whose `workers.task_id` disagrees with the named `taskId`; owner/CTO (no `workerId`) remain unrestricted.
  New case 9 in `runtime/test/git-create-push.test.js`, using a REAL worker-backed `utility:git` principal
  (`ensureWorkerPrincipal`, the actual production path — the file's existing `gitAgent` fixture is a
  standalone `mintNamedPrincipal` with no `workerId` and was therefore already unrestricted, which is why
  this gap wasn't caught by the existing suite).
- **Finding 9 (high) — stale worktree claims had no claimant identity, so a stale (merely slow, not
  actually dead) claimant could finalize/release a claim AFTER a reclaim had already taken it over,
  overwriting the real winner's result with its own stale one.** `reclaimStaleTaskWorktreeClaim` only
  bumped `updated_at`; the pending marker text itself never changed identity, so `finalizeTaskWorktreeSlot`/
  `releaseTaskWorktreeClaim`'s `WHERE worktree_id = PENDING` check could not tell the two apart. Fixed: new
  migration `0016_worktree_claim_token.sql` adds `tasks.worktree_claim_token`; every claim AND every
  reclaim mints a fresh random token, and finalize/release now require an exact match — a stale token can
  no longer resolve a claim it no longer owns. Also closed finding 9's other half (`{ finalized: false }`
  was silently ignored by every caller): all three `createTaskWorktree` call sites now check it and return
  an honest `worktree-claim-superseded` refusal rather than reporting success for a write that did not
  land. New case 18 in `runtime/test/worktree.test.js` — ORDER MATTERS in this test (the stale claimant
  finalizes FIRST, exactly matching the real vulnerability; the reverse order is already guarded by the
  pre-existing pending-marker check and would prove nothing).
- **Finding 16 (high) — overlapping TUI refreshes could regress state or duplicate/reorder transcript
  events.** `setInterval(refresh, refreshMs)` started a new async refresh every tick with no serialization;
  if a round trip ever took longer than `refreshMs`, two requests could be in flight, and whichever
  RESPONSE happened to apply LAST won regardless of which request was actually newer. Fixed in
  `tui/app.js`: `refresh()` is now single-flight (a tick landing mid-flight is a no-op), released in a
  `finally` so a later, non-overlapping call still goes through normally. New case 10 in
  `runtime/test/tui-replay.test.js`, with a scripted client whose response is genuinely slow (`await
  sleep(80)`) so a second `refresh()` call really does land mid-flight, not just in theory.
- **Finding 48 (low) — a request's timestamp used a field name the runtime never supplies.**
  `tui/layout.js` read `postedAt`/`at`; `pendingRequests()` in `runtime/supervisor.js` only ever produces
  `createdAt`. Fixed: reads `createdAt`. New case in `tui/test/tui.test.js`.

**Fixed in a second follow-up continuation (5 more medium findings — 22, 23, 24, 27, 30 — plus all 12
doc-consistency findings, 35-46, corrected directly in their own files):**
- **Finding 22 — MCP pool teardown/reconciliation ignored `killProcessGroup`'s return value, and
  graceful shutdown never disposed pooled processes at all.** `detach()`/`reconcileOnBoot()`
  unconditionally marked a row `stopped`/`failed` even when the kill genuinely failed (`{ killed: false }`
  — e.g. `EPERM`), so the DB claimed a process was gone while it kept running, and a later `attach()`
  could spawn a genuine duplicate. Separately, `runtime/supervisor.js`'s `shutdown()` disposed harness
  adapters but never touched the MCP pool manager — a pooled process (e.g. `leo-mcp`) stayed running
  after the daemon exited, and its own `exit` handler could fire later and try to write to an
  already-closed DB (a crash class this file's own comments already flagged as having happened before).
  Fixed: both call sites now check the real kill outcome before marking anything dead; a new
  `mcpPool.disposeAll()` kills every live pooled process for real and is called by `shutdown()` BEFORE
  `closeDb()`. New case 11 in `runtime/test/mcp-pool.test.js` (real spawn + real kill, no mocking); the
  genuine-kill-failure branch (an EPERM/wrong-UID scenario) was reasoned through against the code rather
  than reproduced live — safely constructing an unkillable process in a test isn't practical without
  risking test infrastructure, and is noted as a real, if narrow, verification gap.
- **Finding 23 — the worktree lifecycle ran every git call through `execFileSync`, blocking the WHOLE
  daemon event loop for as long as the child ran (a real `git worktree add`/`remove` can take up to its
  own internal timeout) — not just that call's own logic, every socket command/ask/digest/lease-renewal
  timer on the same process stalled too.** Fixed: `createTaskWorktree`/`discardTaskWorktree`/
  `requestWorktree`/`worktreeStatus`/`repoRootFromWorktree`/`runGitWorktreeAdd` all converted to `async`
  using a promisified `execFileAsync` (the same fix `agents/git-create-push.js` already applies to its
  own git calls); the pending-claim poll loop's `sleepSync` replaced with a real `await`ed `setTimeout`.
  ~40 test call sites across `runtime/test/worktree.test.js`, `runtime/test/git-create-push.test.js`, and
  `runtime/test/_worktree-race-child.js` updated to `await` the now-async calls. New case 19 in
  `worktree.test.js`, reusing the same real-slow-git-process technique `git-create-push.test.js` case 7
  already established (there via a slow pre-commit hook; here via a slow `git` prepended to `PATH`, since
  worktree operations don't go through hooks at all) — confirmed 0 event-loop ticks pre-fix, 149+ post-fix.
- **Finding 24 — the TUI's Accept/Decline status message led with past-tense success wording**
  (`"accepted <id>"`/`"declined <id>"`), with "not yet wired to task creation" only tacked on afterward —
  an operator scanning just the start of the line reads a real decision as recorded, when the request
  stays pending, unchanged, on the very next refresh. Fixed in `tui/app.js`: reworded to never claim a
  decision happened (`"<decision> on <id> not recorded — no backend command exists yet..."`). New case 11
  in `runtime/test/tui-replay.test.js`.
- **Finding 30 — `tui/app.js`'s `stop()` never removed its `input`/`out` listeners (anonymous inline
  callbacks, nothing to remove) and never closed the socket client.** Restarting or embedding the TUI
  accumulated listeners without bound; a stopped app's socket connection outlived it. Fixed: the two
  listeners are now named functions, removed in `stop()` via `off()`; `client.close?.()` is now called.
  New case 12 in `tui-replay.test.js`, using real `EventEmitter` fixtures (not the usual no-op stubs) to
  actually prove removal, not just that `stop()` didn't throw.
- **Finding 27 — Requests panel keyboard selection (`requestUp`/`requestDown`) could move the selection
  off-screen**, since `state.js` moves `selectedRequestId` but is pure and has no idea how many rows are
  actually visible, so it never adjusted `requestScroll` — `return` could then open a request the operator
  could not see on screen. Fixed in `tui/layout.js`: a new shared `effectiveRequestScroll()` helper nudges
  the scroll just enough to keep the selection visible, used by BOTH `renderRequestsPanel` and `hitTest` so
  a click always resolves to the row actually drawn (the same "hit-test and render must agree" discipline
  `teamBarChips`'s own windowing already follows). New case 26 in `tui/test/tui.test.js`. Note: `tui/state.js`'s
  `treeUp`/`treeDown` has the exact same latent gap (never touches `treeScroll` either) — NOT fixed here,
  since the review did not flag the tree specifically; worth a follow-up pass if it matters in practice.

**Fixed in a THIRD follow-up continuation — the last 5 medium findings (25, 26, 28, 29, 32), closing all
15 of 15:**
- **Finding 25 — the Request Detail view could hide content required for an informed decision.**
  `wrapText()` never split a single token wider than the viewport (a long URL/hash/stack-trace line), so
  `row()`'s own `fit()` truncated the rest with an ellipsis, silently; separately, `body.slice(0,
  bodyBudget)` dropped every line past the viewport with no indication at all. Fixed in `tui/layout.js`:
  `wrapText` now hard-splits an over-wide token into `width`-sized chunks before line-wrapping; a message
  taller than the viewport now reserves its last visible line for an explicit `"… (N more line(s) not
  shown)"` indicator instead of silently losing its tail. Two new cases in `tui/test/tui.test.js`.
- **Finding 26 — Request panel visibility and focus could become internally inconsistent.**
  `closeRequestDetail` set focus to `REQUESTS` unconditionally, but the panel could have been hidden
  (`R`) WHILE the detail view was open — `toggleRequestsHidden` only redirects focus away from `REQUESTS`
  when focus was ALREADY there at the moment of hiding, so it had no way to know detail was open instead.
  `escape` then left focus on a panel that isn't drawn at all. Fixed in `tui/state.js`: routes to `TREE`
  instead when the panel is actually hidden. New case in `tui.test.js`. (The second half of this finding —
  toggling `R` at zero pending being "undone" by the next empty snapshot — was assessed as having no
  observable consequence: at zero pending there is nothing to hide anyway, and a later real arrival is
  already covered by finding 41's documented empty-then-new-batch rule. Not changed.)
- **Finding 28 — `tui/capture-frames.mjs` only tore down its real harness/socket/DB/state-directory
  resources on the SUCCESS path.** A timeout, a render exception, or a failed assertion anywhere in the
  ~150-line capture body skipped every teardown step, leaving real processes/sockets alive and a state
  directory a LATER run could delete out from under a still-live previous process. Fixed: the whole
  capture body now runs inside `try { ... } catch { ...; process.exitCode = 1; } finally { ...teardown...
  }`, with `db`/`supervisor`/`harness`/`ipc` hoisted so `finally` can reach whichever ones got created
  regardless of how far setup got. Verified both ways by hand (not `npm test`-wired — this file is
  explicitly not a test, per its own header): the success path still reproduces the committed
  `tui/evidence/01-demo-frames.txt` byte-for-byte; an injected mid-script throw still exits 1 with the
  state directory removed and no stray processes, confirmed via `ps`.
- **Finding 29 — every width calculation in `tui/layout.js` used `.length` (UTF-16 code units), not
  terminal display cells** — a CJK character or most emoji occupy 2 terminal columns but 1-2 UTF-16 code
  units; a combining diacritic is a separate code unit but 0 columns. Fixed: new `charWidth`/`cellWidth`
  primitives (an approximation of the real Unicode East Asian Width property — the same approach every
  "string-width" npm package takes, not exhaustive without a dependency this project deliberately doesn't
  have) wired into `fit()`, the single shared boundary most rendering in this file already goes through
  via `row()`. **Scope note: `fit()` only.** `wrapText`'s word-splitting and `teamBarChips`'s budget
  arithmetic still reason in code units — a smaller residual gap left for a follow-up pass rather than
  blocking this one. New case in `tui.test.js` (a CJK string, an all-wide-character overflow, and a
  decomposed combining-mark string, asserting exact cell-width padding/truncation).
- **Finding 32 — `config/mcp-pools.js`/`resources.js` deferred malformed data to unsafe runtime
  behavior**, contradicting their own stated "malformed -> THROWS" contract. `mcp-pools.js`'s
  `args`/`env`/`cwd` had no shape check at all (a non-array `args`, a non-string `env` value, a non-string
  `cwd` all passed through silently, surfacing later as a confusing `spawnManaged` failure);
  `resources.js` accepted any top-level key, so a misspelled `"resource"` (missing the `s`) silently fell
  back to the built-in defaults exactly like `protected-branches.js`'s finding-31 bug. Fixed: both files
  now validate every field's real shape / reject unknown top-level keys, throwing with a message naming
  the bad key/value. Two new dedicated test files — `config/test/resources.test.js` (5 cases),
  `config/test/mcp-pools.test.js` (9 cases) — neither module had ANY test coverage before this pass,
  wired into the same `npm run test:config` finding 31 already added.

**A newly-observed flake, unrelated to any fix in this pass**: `runtime/test/mcp-pool.test.js`'s case 5
("6 concurrent async workers... race attach/detach") failed intermittently across ~5 consecutive
standalone runs (roughly 2 of 5) with `Error: mcp-pool: pool ... was no longer 'starting' when spawn
completed` — a real, pre-existing race in that test's own concurrency, not touched by this session's
`mcp-pool.js` edits (finding 22's fix is a different code path). Noted rather than investigated further,
matching this file's own standing practice for flakes outside the current task's scope; worth a dedicated
look in a future pass.
- **Finding 34 — a lock-cleanup failure could replace the PRIMARY acquisition error.** A JS `finally`
  block that throws REPLACES whatever exception was already propagating from `try`/`catch` — so a real
  root cause (disk full on `writeFile`) followed by a real cleanup failure (the temp file's own unlink
  also failing) meant the caller only ever saw the cleanup error. Fixed in `lock/lock.js`: the primary
  error is captured in a variable and rethrown AFTER the `finally` block entirely, with any cleanup
  failure attached as `.cleanupError` context rather than thrown directly. New case 3 in
  `lock/test/cleanup-failure.test.js`.
- **Finding 31 — `protected-branches.json` silently accepted a misspelled or unknown top-level key**
  (`"branch"` instead of `"branches"`), falling straight through to the built-in default with no
  indication the file's real content was never read — an administrator could believe a destination was
  protected when `gitPush` would authorize it anyway. Fixed in `config/protected-branches.js`: rejects
  any unknown top-level key, requires `branches` when the file exists at all, and rejects empty/duplicate
  entries. New dedicated test file `config/test/protected-branches.test.js` (7 cases — this module had
  no test coverage at all before), wired into a new `npm run test:config`.
- **Finding 33 — the OpenCode adapter's stderr ring truncated by UTF-16 code units while measuring its
  budget in bytes.** A multibyte character (an emoji is 4 UTF-8 bytes, 2 UTF-16 code units) meant "keep N
  code units" retained roughly double the intended byte budget (the review's own repro: a 1,024-byte ring
  retained 2,038 bytes of emoji input). Fixed in `adapters/opencode/adapter.js`'s `StderrRing`: truncates
  real UTF-8 bytes via a `Buffer`, then shrinks further a character at a time to absorb the case where
  the UTF-8 decoder's replacement character (U+FFFD, 3 bytes) is itself larger than the partial bytes it
  replaced at the cut boundary. Also validates `maxBytes` is a positive integer at construction. Two new
  cases in `adapters/opencode/test/stderr-ring.test.mjs`.
- **Finding 20 — `deletePreflightRun()` didn't account for migrations 0011/0013's newer FOREIGN KEY
  references.** `resource_leases.holder_run_id` and `mcp_pool_attachments.run_id` both reference
  `runs(run_id)` with no `ON DELETE` action; a preflight run that had ever acquired a lease or attached
  to a pooled MCP server made the delete fail with a real `FOREIGN KEY constraint failed` (reproduced).
  Fixed: both dependent tables are now purged in the same transaction, before the run row itself. New
  case 10 in `runtime/test/preflight.test.js`.
- **Finding 21 — IPC shutdown-notice delivery was nondeterministic, and a request in flight when the
  connection died could hang its caller's promise forever.** `ipc/server.js`'s `forceCloseAll` used to
  `socket.write(notice)` immediately followed by `socket.destroy()` — `destroy()` does not wait for a
  just-queued write to flush, so the notice's actual delivery was a race. Separately, `ipc/client.js`'s
  `pending` map was settled ONLY by a matching response frame; a connection that closed/errored with a
  request still in flight left that request's promise unsettled forever, with nothing else that could
  ever resolve it. Fixed: the server now uses `socket.end(encodedNotice)` (queues, flushes, then
  half-closes) with a bounded 200ms forced-`destroy()` fallback; the client now settles every pending
  request with an honest failure on `close`/`error`. New case in `ipc/test/teardown.test.js` (reusing
  that file's own already-in-flight `observe` request, which used to hang this exact way).

**Explicitly decided, not a bug — finding 12 ("workers can acquire and indefinitely renew the global git
identity lease").** The suggested fix (block a plain `kind: "worker"` principal from acquiring anything
but `host:heavy-job`) was implemented, then reverted after it broke ~10 pre-existing, deliberately-written
cases in `runtime/test/leases.test.js` that exercise a plain worker acquiring `git:identity` as INTENDED
behavior (not an oversight the review discovered — a documented, tested design tradeoff). This needed a
real product/design decision (a resource-specific capability model, per the review's own alternate
suggestion, would touch already-settled test contracts) rather than a unilateral change — so it was
escalated. **Decision (2026-09-14, owner): leave as-is, no code change.** A plain worker acquiring
`git:identity` remains intended behavior; the review's concern (nothing stops a worker from acquiring
`host:heavy-job` or a future sensitive lease kind it shouldn't need) is accepted as a known, deliberate
tradeoff rather than something to fix now — revisit only if a real incident or a new lease kind makes the
blanket "any worker can acquire any lease" rule actually costly.

**Every finding below is FIXED or explicitly resolved — nothing from `codexdoc/review-sol-2026-09-13.md`
remains open.** (Heading corrected 2026-09-14, review-consolidated-2026-09-14.md finding 14: this used to
say "Not yet actioned" while every bullet under it already said FIXED — a maintainer reading only the
heading would have believed the opposite of what the bullets themselves said.)
- **Finding 8 (high, NOW FULLY FIXED across two continuations).** Investigated fully before touching
  anything: this codebase has **no worker-reassignment mechanism at all** —
  `grep -a -n "UPDATE workers SET task_id"` across the whole tree returns nothing; `workers.task_id` is
  set once and never changed at runtime — so the review's "reassignment can hide an older run" sub-case
  does not apply to the code as it actually exists today (it may have been a hypothetical against a
  future feature). The wire-exposed `start`-for-a-terminal-task sub-case is also narrower than it first
  reads: `start()` never looks up a task's worktree itself, so this requires a caller to explicitly pass a
  terminal task's own worktree path as `spec.cwd`, bypassing `assignTask`'s existing terminal-task refusal
  — not something normal `start` usage triggers.
  Two real, always-reachable gaps WERE found and fixed:
  1. `discardTaskWorktree` read `task.worktree_id` once and then ran its open-run check, its clean/dirty
     check, and `git worktree remove --force` with **no reservation of its own** — two concurrent
     `discardTaskWorktree` calls on the same task (an operator double-click, a retried request) both
     passed every check and both ran `git worktree remove --force` on the identical directory with zero
     coordination. Fixed by having `discardTaskWorktree` claim the worktree slot with the exact same CAS
     `createTaskWorktree` already uses (`claimTaskWorktreeSlot`/`finalizeTaskWorktreeSlot`/
     `releaseTaskWorktreeClaim`, flipping `tasks.worktree_id` to the pending marker for the duration)
     before any of its checks, releasing on every refusal path and finalizing to `NULL` only on real
     success. Free second benefit: while a discard holds the claim, `assignTask`'s `cwd: task.worktree_id`
     resolution reads the pending-marker string instead of a real path, so a `start` racing a discard now
     fails loudly (bad `cwd`) instead of silently writing into a directory mid-removal. Verified: reverting
     the claim makes new case 20 in `runtime/test/worktree.test.js` fail deterministically (both
     concurrent calls report `discarded: true` pre-fix; exactly one does post-fix, the other refused
     `worktree-claim-conflict`).
  2. `resume(runId)` had zero task-state awareness at all — it would reopen ANY run by id regardless of
     whether its task was already terminal, silently giving a `merged`/`cancelled` task a fresh open run
     with no coordination against `discardTaskWorktree`'s own "terminal + zero open runs" invariant (and,
     worse, against a worktree that may already have been discarded). Fixed by looking up the run's task
     via the existing `taskIdForRun` and refusing with `{ok:false, refused:"task-terminal"}` before ever
     reaching the adapter — mirroring `assignTask`'s own terminal-task refusal for a NEW run, now closed
     for reopening an OLD one. A run with no task at all (a preflight) is unaffected. Verified: reverting
     just this block makes new case 21 in `runtime/test/worktree.test.js` fail pre-fix (the fake harness
     throws `Unknown runId` instead of a clean refusal, since it never reaches its own bookkeeping);
     restored, passes cleanly post-fix.
  Full `npm test` exit 0 after both fixes (one standalone mcp-pool re-run needed due to the pre-existing,
  already-documented intermittent flake in that suite — confirmed clean, unrelated to this work).
- **Finding 13 (high, NOW FIXED, 2026-09-14 — owner decision: build the real transport rather than
  deferring or gating).** Previously: MCP pooling spawned and recorded a pool attachment, but
  stdin/stdout were never connected to the adapter, `spec.mcpConfig` was deliberately left unset, and
  Jira/Slack utility prompts fell back to instructing workers to use `leo-mcp` directly.
  MEASURED, not guessed, per this project's own rule: `claude mcp add --help` / `claude mcp add-json
  --help` (run directly against the installed `claude` CLI) confirm `--mcp-config` accepts a real JSON
  FILE PATH or a literal JSON STRING, and exactly three transport types (`stdio`, `sse`, `http`) — none
  of which describe a raw Unix socket. So the fix is not "point `--mcp-config` at the pool's socket" —
  new `runtime/mcp-stdio-proxy.js` is a tiny script that `--mcp-config` spawns as an ORDINARY stdio
  server (fully within the one transport type actually verified) and that does nothing but relay bytes
  to and from the real pooled server's socket; no protocol parsing, since both ends already speak the
  same newline-delimited JSON-RPC framing.
  Wiring, end to end: `runtime/mcp-pool.js`'s `spawnOne` now spawns every registered pool config as a
  socket-transport server (`LEO_MCP_SOCKET_PATH` env var, leo-mcp's own convention; polls for the socket
  file to actually exist before marking the row ready, same "verify against the real OS" discipline used
  elsewhere in this file) and `attach()` now returns the real `socketPath`. `config/mcp-pools.js`'s
  built-in `leo-mcp` entry now spawns `mcp/server-socket.js` (the socket transport) instead of
  `server.js` (stdio). A new capability field, `mcpConfigDelivery` (`conformance/matrix.js`,
  `'file-or-json-string'` for claude-code, `false` for opencode — MEASURED per-adapter, not assumed),
  gates whether `runtime/supervisor.js`'s `start()` builds a real `spec.mcpConfig` entry at all:
  `{"mcpServers":{"<pool>":{"command":<node>,"args":[mcp-stdio-proxy.js,"--socket",<realSocketPath>]}}}`,
  a JSON STRING per the measured contract, pushed straight into the existing `--mcp-config` argv path.
  Verified at three levels: (1) `runtime/test/mcp-stdio-proxy.test.js`, 5 cases, the proxy against a real
  throwaway Unix socket server — exact bytes relayed both ways, clean shutdown on stdin end, non-zero
  exit on a missing flag or a dead socket; (2) `runtime/test/mcp-pool.test.js`'s existing 11 cases,
  updated so every real spawned fixture actually opens a socket (the new convention `spawnOne` now
  requires); (3) new case 7 in `runtime/test/mcp-pool-wiring.test.js` — a REAL leo-mcp process, spawned
  by the real pool manager, reached through the EXACT command+args `start()` built, returning a REAL
  `tools/list` JSON-RPC result. Reverting `MCP_STDIO_PROXY_PATH`'s export makes that case fail with a
  real `SyntaxError` (not a silent pass); restored. Full `npm test` exit 0, twice in a row (no flake).
  **Honest residual gap**: this proves the chain up to and including a real MCP server response through
  a real proxy process — it has NOT been probed against the actual `claude` CLI subprocess spawning that
  exact `--mcp-config` JSON string live (that would need a real `claude --print` invocation, heavier
  manual verification not done this pass). The schema itself is measured, not guessed; the live
  first-hand fire-through-`claude`-itself step is the one thing still unverified.
- **Medium — ALL 15 of 15 fixed.** Every medium finding from `codexdoc/review-sol-2026-09-13.md` is now
  closed (20-34); see the three "Fixed in a ... follow-up continuation" sections above for the full list
  and mechanism per finding.
- **Doc-consistency — ALL 12 (35-46) fixed. Low — ALL 4 of 4 fixed.** Closed in a fourth follow-up
  continuation, same day:
  - **Finding 47** — migration-upgrade test coverage stopped short of 0013-0016 (only 0011/0012 had a
    dedicated upgrade test, and the generic `migrations.test.js` only ever checked a FRESH database).
    New `db/test/migration-0013-to-0016.test.js`: populates real rows at schema version 0012 (an
    `mcp_pool` row in its pre-0013 shape, a task), upgrades to latest, and asserts the DOCUMENTED
    backfill defaults land correctly (`mcp_pool.status = 'starting'`, not NULL; `pgid`/`lstart`/
    `worktree_repo_path`/`worktree_claim_token` genuinely NULL, not guessed), the new
    `mcp_pool_attachments` table exists and genuinely enforces its FK against `runs` (a bad `run_id`
    insert is asserted to throw), and `PRAGMA integrity_check` still reports `ok` after the full upgrade.
    Also added the missing `mcp_pool_attachments` to `migrations.test.js`'s own generic table list.
  - **Finding 49** — `ipc/FINDINGS.md`'s peer-credential rationale conflated Linux `SO_PEERCRED`
    (exposes pid+uid+gid) with macOS/BSD `getpeereid` (uid/gid ONLY, no pid) as if a native addon would
    buy the same same-user-process disambiguation on both platforms. Corrected: on macOS/BSD, a native
    addon's uid/gid check would be REDUNDANT with the `0700` state-directory check already in place;
    only Linux's `SO_PEERCRED` would add anything (pid-level disambiguation) beyond what this project
    already has — and that disambiguation is explicitly out of scope for a single-user tool either way.
  - **Finding 50** — two accidental empty root files, `2026-09-11.md` (0 bytes) and `Untitled.canvas`
    (`{}`), never had a known purpose and were never tracked in git. Deleted, per the review's own
    suggested resolution ("give them a purpose or omit them").
- **Every one of the review's 50 findings is now resolved.** Finding 13 (MCP transport delivery) is now
  FIXED, not deferred — see above. Finding 12 (workers holding `git:identity`) is explicitly RESOLVED —
  owner decision 2026-09-14: leave as-is, no code change. Every other finding across every severity tier
  — the critical finding, all 18 high, all 15 medium, all 12 doc-consistency, all 4 low — is fixed.

Read `codexdoc/review-sol-2026-09-13.md` directly for full file:line detail on every item above before
starting the next pass — this summary is deliberately compressed. New migrations this pass:
`0015_mcp_pool_lstart.sql`, `0016_worktree_claim_token.sql` — both additive (`ALTER TABLE ... ADD COLUMN`),
no backfill needed, no existing test's schema assumptions broken (verified: full `npm test` exit 0 after
each).

## Forty-seventh pass, 2026-09-14 — a THIRD independent review, cross-checked and consolidated, then fixed

After commit `79aa275` (finding 8 + 13's fixes, above), a fresh review pass was commissioned against
just the last three commits: `opencode`'s `sol` agent again (`codexdoc/review-sol-2026-09-14-commits.md`,
8 findings), then an independent Claude Opus (high effort) pass that did its OWN review first — before
reading sol's report — and only then cross-verified sol's 8 findings against the real code one by one,
consolidating both into `codexdoc/review-consolidated-2026-09-14.md`. **Result: 14 survivors (3 high, 6
medium, 4 low, 1 doc-consistency), 0 of sol's 8 refuted (2 severity regrades, 2 sub-claim corrections), 6
new findings sol did not report.** Every finding was independently verified with a REAL reproduction
(real sockets, real git, real spawned processes) before being trusted, per this file's own standing rule.

**Fixed, all verified to fail against the pre-fix code first, full `npm test` exit 0 (twice, no flake):**

- **Finding 1 (high) — the delivered MCP config handed every utility role leo-mcp's ENTIRE 27-tool
  surface, not just what its own capability preset implies.** Measured with a real socket connection to
  a real pooled leo-mcp process: `git_push` (arbitrary absolute `cwd`/`targetBranch`, bypassing the
  supervisor's own `gitPush` capability check, its `git:identity` lease, and its `agent_journal` record
  entirely) and every Slack/Jira tool were reachable by ANY role that attached to the pool — a
  `jira-runner`, whose preset is exactly `["read:registry", "jira:create"]`, could reach all 27. Fixed by
  making `runtime/mcp-stdio-proxy.js` protocol-aware: it now parses the newline-delimited JSON-RPC frames
  leo-mcp already speaks in both directions, filters `tools/list` RESPONSES down to a per-role allowlist
  (`domain/mcp-manifest.js`'s new `ROLE_MCP_TOOL_ALLOWLIST` — grounded in each role's own capability
  preset and instruction text, not invented: `git-push-runner` → `git_push` only, `jira-runner` →
  `jira_create_ticket` only, `slack-runner` → posting tools only, no delete/search/admin/DM), and refuses
  a disallowed `tools/call` REQUEST directly (a real JSON-RPC error, never forwarded to the real server).
  `runtime/supervisor.js`'s `start()`/`resume()` always pass `--allow-tools` for every pool they attach.
  9 new cases in `runtime/test/mcp-stdio-proxy.test.js` prove the filtering against a real socket server.
- **Finding 2 (high) — resume() replayed a torn-down MCP socket, silently leaving a resumed utility run
  with no tool at all.** `detach()` (called when a run ends) kills the pooled process and removes its
  socket file; `resume()` used to call `adapter.resume(runId)` with nothing else, and the adapter rebuilds
  its argv from the run's OWN captured `spec` — still naming the dead socket. Fixed by extracting the
  attach-and-build-config logic `start()` already had into a shared `attachMcpPoolsForRole` helper,
  calling it again in `resume()` for a genuinely fresh attachment/socket, and giving the claude-code
  adapter's `resume(runId, { specOverride })` a way to receive it for the new generation rather than
  trusting `run.spec` to still be valid. New case 8 in `runtime/test/mcp-pool-wiring.test.js`: a real run,
  ended for real (socket confirmed gone from disk), resumed, and the NEW generation's fresh socket
  round-trips a real `tools/list` through the real pooled leo-mcp process.
- **Finding 3 (high) — a crash mid-discard permanently wedged the worktree claim, and stale-claim
  recovery on the CREATE side then resurrected the deliberately deleted worktree.** Reproduced exactly as
  the review found it: claim, real `git worktree remove`, crash before finalize — `discardTaskWorktree`
  refused `worktree-claim-conflict` forever (no stale recovery existed on the discard side at all), and
  once the claim went stale, `createTaskWorktree`'s OWN recovery saw "no directory" and ran `git worktree
  add`, undoing a completed deletion on a `merged` task. Fixed with new migration
  `0017_worktree_claim_op_and_stamp.sql`: `tasks.worktree_claim_op` ('create'|'discard') records which
  operation owns a pending claim, so create's recovery now refuses to resurrect when the reclaimed op was
  a discard with no directory left (`{ok:false, refused:"worktree-was-discarded"}`); and
  `discardTaskWorktree` itself now gets stale-claim recovery too, so a crashed discard is no longer
  permanently wedged. Same migration adds `tasks.worktree_claim_at` for finding 11 (below). New cases
  22-23 in `runtime/test/worktree.test.js`.
- **Finding 5 (medium) — pool readiness was `fs.existsSync` alone, which cannot tell a live socket from a
  dead one or a regular file.** Reproduced both: a server that binds a real socket then exits immediately
  (file exists, nothing listening — `ECONNREFUSED`), and a "server" that writes a plain file at the
  socket path and stays alive (`existsSync` true, `isSocket()` false — `ENOTSOCK`); both used to be
  published `ready` and joinable. Fixed: `spawnOne` now installs its exit listener immediately (Node does
  not replay a missed `exit` to a late listener — verified directly), checks `isSocket()`, and performs a
  real bounded `net.connect` handshake as the actual readiness proof. New cases 12a/12b in
  `runtime/test/mcp-pool.test.js`.
- **Finding 6 (medium) — a concurrent attach LOSER's wait budget (~1s) was shorter than the WINNER's own
  spawn budget (~7s: identity verification + socket wait).** Reproduced with a real 2s-delayed-bind
  server: the winner attached at ~2.1s while the loser had already thrown at ~1s. Fixed: the loser's
  budget is now derived from the same `IDENTITY_TIMEOUT_MS` (newly exported from `spawn.js`) plus the
  socket-wait budget the winner actually uses. New case 13 in `mcp-pool.test.js`.
- **Finding 7 (medium) — several teardown paths dropped ownership of a live handle before confirming the
  kill, or killed only the direct child rather than its process group.** `disposeAll` deleted the
  `liveChildren` handle BEFORE attempting the kill (an unconfirmed kill left a real, credentialed process
  resident with nothing tracking it); `spawnOne`'s three internal failure branches killed only
  `spawned.child` rather than the verified process group. Fixed: `disposeAll` now matches `detach()`'s
  existing discipline (handle stays live until the kill is CONFIRMED); `spawnOne`'s failure branches kill
  by `identity.pgid` via `killProcessGroup` once identity is verified.
- **Finding 8 (high sub-scope; medium overall — see finding 1) — `preflight` attached real MCP pools and
  delivered a real config even though its own spec's intent is "needs no MCP servers", with the host
  approval round trip disabled.** Fixed: `start()` now skips the entire MCP attach/deliver block outright
  when `spec.isPreflight === true`.
- **Finding 10 (low) — the new proxy relay tests could hang the whole `npm test` run forever instead of
  failing**, via a bare `setInterval` poll with no deadline. Fixed alongside finding 1's test rewrite: a
  bounded `waitForBuffer` helper (real timer, real rejection) replaces every unbounded poll; every
  spawned proxy is force-killed in `finally`.
- **Finding 11 (medium) — stale-claim recovery compared against `tasks.updated_at`, which ANY unrelated
  write to the task refreshed, pushing the staleness window out indefinitely.** Fixed in the same
  migration as finding 3: `tasks.worktree_claim_at`, written only by the claim/reclaim functions
  themselves, is what staleness is judged against now.
- **Finding 12 (low) — pool sockets were created mode `0755` (world-connectable wherever the temp dir is
  shared, e.g. `TMPDIR=/tmp` on Linux/CI) and only cleaned up on the happy-path `detach()`.** Fixed:
  `spawnOne` now `chmod 0600`s the socket once verified; `disposeAll` and `reconcileOnBoot`'s confirmed-
  kill path now also remove the socket file, matching `detach()`'s existing cleanup.
- **Finding 14 (doc-consistency) — the docs simultaneously said MCP delivery was fixed, absent, and
  uncommitted.** `PLAN.md` §21.1/§21.2, `TODO.md`, `ROADMAP.md`, and `domain/mcp-manifest.js`'s own module
  header all corrected in place with dated SUPERSEDED notes, and this file's own stale "Not yet actioned"
  heading (above) fixed too.

**Deferred, by explicit judgment call, not fixed unilaterally:**
- **Finding 4 (medium) — required MCP delivery still fails open** (a role with a declared need but no
  deliverable pool still gets an ordinary successful start, just with no tool). After finding 1's fix,
  the blast radius of failing open is far smaller (no tool vs. no bounded tool, not the full 27-tool
  surface) — refusing the start outright is a real product-scope decision (would need an explicit
  `allowDegradedMcp` opt-in and touches existing tests that assume a normal successful start for a
  utility role), not a clear bug fix. Flagged for a real decision, same posture as findings 12/13 from
  the earlier review.
- **Finding 9 (medium) — the only end-to-end proof that MCP delivery works (`mcp-pool-wiring.test.js`
  case 7) silently disappears when the private `../leo-mcp` sibling repo is absent**, with `npm test`
  still reporting green. A full sibling-independent fixture reproducing leo-mcp's own tool surface was
  judged out of scope for this pass; the skip message was made loud (a hard-to-miss stderr banner) as the
  minimum honest fix, but the underlying coverage gap (this suite's cases are conditional on one
  developer's directory layout) is not closed.
- **Finding 13 (low) — `changedPathsFor`/`currentHeadFor` fail open on a `git diff` error**, which the
  code's own comments already document as deliberate. Not touched — the review's own report treats this
  as a narrow objection about not DISTINGUISHING "nothing changed" from "git could not answer," not a
  claim that the fail-open default itself was an oversight.

**Every one of THIS review's 14 findings is now resolved** — 11 fixed, 2 deferred by explicit judgment
call (findings 4, 9), 1 left alone as already-deliberate (finding 13). New migration this pass:
`0017_worktree_claim_op_and_stamp.sql` (additive, no backfill needed). Committed and pushed as `0ae6cf2`.

**IMPORTANT META-NOTE for whoever reads this next**: this pass's own conversation context was
compacted/rewound partway through — items 27-38 below were done and documented BEFORE the rewind
(verified after the fact: every file the numbered list below claims was edited was re-checked
against `git status`/`git diff` and the real, current `npm test` result, not just trusted from
memory). Item 39 is the one piece of work that happened in the rewound stretch and had NOT yet
been written up anywhere — found by diffing file modification times against what the numbered
list already covered, then verified against the actual current code before writing anything below.
If a future pass finds another gap like this, the same technique works: `git status`/`git diff`
plus a re-run of `npm test` is ground truth; a summary of what was "decided" is not, once its own
turn is gone.

**Item 39, same session (2026-09-13) — `config/harness-defaults.js`'s new `clearPolicy` schema
(Phase 8's first step, added in the rewound stretch) had a real, silent validation gap when this
pass re-audited it — fixed.** `clearPolicy` (PLAN.md §8 Rule 5's vocabulary — `on-state-transition`
/ `per-review-round` / `on-demand` / `always`) was added as a field on every `BUILT_IN_DEFAULTS`
role entry and accepted as a known config key (`ASSIGNMENT_KEYS`), but its VALUE was never checked
against `CLEAR_POLICIES` — a typo (`"clearPolicy": "on-demandd"`) passed silently, contradicting
this same file's own stated design rule ("A MALFORMED file THROWS"). Also corrected a misleading
comment that referenced `domain/clear-policy.js` in the present tense ("is what actually DECIDES")
— that module does not exist; nothing anywhere reads `clearPolicy` to actually call
`clearContext()`. Fixed: added the missing value validation (throws, names the bad value and the
valid list, same pattern every other field in this file already uses); corrected the comment to
say plainly that this is schema-only, Phase 8's first step, with the decision module still to be
built. New case in `runtime/test/assignment.test.js`'s existing "malformed config" test (an
unrecognized `clearPolicy` value throws; a recognized one loads through unchanged). Verified to
fail against the pre-fix code (the bad value loaded with no error) before restoring the fix.
`npm test`: exit 0, **127 suites** (unchanged — a new case in an existing file), re-verified 2x.
**This is schema-only — Phase 8's actual clear-policy DECISION LOGIC (a `domain/clear-policy.js`
that reads this field and calls `clearContext()`/`resume()` at the right moment) is still not
built.** ROADMAP.md's Phase 8 checklist marks this checkbox `[~]` (partial) rather than `[x]`, for
exactly that reason.

**Item 38, same session (2026-09-13) — the LAST OLDER should-fix backlog item, resolved as
DECIDED, no code written.** Before writing anything for `ipc/`'s "SO_PEERCRED uid check," stopped
and asked whether it was actually required, per explicit instruction. It is not: re-ran the
2026-09-09 probe live on the current Node version and confirmed Node genuinely exposes no
peer-credential API on a Unix socket (not just trusted the old evidence file) — a real addon would
be needed for the literal ask. But the GAP that check exists to close is already closed, and was
already decided and written down BEFORE this backlog note existed (`runtime/supervisor.js`'s own
§14.5/migration 0010 commentary): the state directory's `0700` permission gates which OS user can
reach the socket at all, and every command additionally requires a minted, hashed,
capability-scoped token — together a STRICTLY finer-grained boundary than a raw uid check would
have been. Building a native addon (real per-platform code — Linux's `SO_PEERCRED` and macOS/BSD's
`getpeereid` are different APIs) would add real, ongoing engineering weight to re-close a gap
already closed, for a threat model (a shared multi-user host) this project's own documentation
already says is explicitly NOT its current target. **Corrected the documentation instead of
building anything**: `ipc/FINDINGS.md`'s "open item, not implemented" section rewritten to state
the actual decision and point at where it already lives; `TODO.md`'s misleading `[x]` (which read
as if a native addon had been built) annotated with what was actually decided; `HANDOFF.md`'s own
backlog note corrected. **The OLDER should-fix backlog list is now fully closed or explicitly,
correctly deferred — nothing pending action remains in it.** Full detail below, at item 38's own
entry.

**Item 36, same session (2026-09-13)**: checked `supervisor/runtime/`'s "state directory is not
one directory" backlog note — STALE, already fully resolved, no code change. `paths.js` is (and
already was) the single canonical resolver; `db/paths.js`/`ipc/paths.js` are thin re-export shims
over it; `lock/lock.js` calls `stateDir()`/`lockPath()` from the SAME module; and
`runtime/test/daemon-crash.test.js` already sets only `SUPERVISOR_STATE_DIR` (deletes
`CTD_STATE_DIR` explicitly, with a comment noting it "used to have to set two" — past tense). Same
pattern as items 30 and 33's stale-note resolutions.

**Item 37, right after — a genuinely real, previously-unverified bug, fixed 2026-09-13.**
`supervisor/runtime/`'s "full adapter-iterator cancellation needs an AbortSignal" backlog note
turned out NOT to be stale — reproduced it empirically (a minimal standalone repro of the exact
`while (true) { await X }`-with-no-yield-between-awaits loop shape both real adapters' `observe()`
used, confirmed the JS engine genuinely never delivers a queued `.return()` while that loop keeps
re-entering the same await — proven, not assumed, before writing any fix) against BOTH real
adapters (`adapters/opencode/adapter.js`, `adapters/claude-code/adapter.js`), not just the
synthetic iterator `runtime/test/review-three.test.js`'s existing case 8 already covers. Fixed in
both: `observe()` now returns a THIN WRAPPER around the real generator whose `.return()`
intercepts the pump's cancellation call — marks a new `run._cancelled` flag and wakes the wait
immediately, so the generator's OWN code executes a genuine, synchronous `return;` statement on its
very next tick (needing no generator-protocol delivery of an externally-queued completion at all).
`_cancelled` is reset on `resume()` for the Claude Code adapter (a resumed run is a NEW process, not
the same cancelled observer). New `FAKE_CLAUDE_MODE=stall` (never emits a result, never exits —
genuinely, permanently mid-turn) and new cases in both adapters' test files, each proving a
genuinely-parked `next()` settles well within the 200ms safety-net window once `.return()` is
called — verified to fail against the pre-fix code in BOTH adapters (1000ms+ timeout, confirmed
independently for each) before restoring the fix. `npm test`: exit 0, **127 suites** (two new cases
in existing files), re-verified 2x, zero leaked processes. Full detail below, at item 37's own entry.

**Item 35, same session (2026-09-13) — CLOSES `supervisor/adapters/`'s ENTIRE backlog list.** The
last item, `verifyRunIdentity()`'s HTTP-unavailable fallback false-positiving `sessionKnown:true`:
`entry.sessionsKnown` (the OpenCode adapter's local cache, consulted only when the real `GET
/session/{id}` call itself fails) was add-only — `discardSession()` deleted the session on the real
server but never removed it from this local cache, so a LATER identity check landing during a
transient HTTP outage fell back to the stale cache and reported a genuinely-deleted session as
still known. Fixed: `discardSession()` now calls `entry?.sessionsKnown.delete(sessionID)` the
instant the real server confirms the session is gone (200 or 404). New `DELETE /session/:id`
handler in the fake OpenCode test server (didn't exist before — `discardSession()` had no way to
succeed against it at all) and a new case in `test-opencode-adapter.mjs`: discards a real session,
then forces the exact failure mode (`run.baseUrl` pointed at an unreachable port so the HTTP call
fails while the real server process stays alive, `serverAlive: true`) and asserts `sessionKnown`
correctly comes back `false`. Verified to fail against the pre-fix code (`sessionKnown: true` for
an already-discarded session) before restoring the fix. `npm test`: exit 0, **125 suites** (one new
case in an existing file), re-verified 2x. Full detail below, at item 35's own entry. **Every item
in `supervisor/adapters/`'s should-fix backlog is now closed** (5 fixed — items 30-32/34-35 — plus
item 33's stale-note resolution, no code change).

**Item 34, same session (2026-09-13)**: the eighth item off the OLDER should-fix backlog —
`supervisor/adapters/claude-code/adapter.js`'s `turn.end` was ONLY emitted from a parsed `type:
'result'` stdout line, so a process that crashed, was killed, or otherwise died mid-turn without
ever printing one left NO `turn.end` in the run's event log at all. `observe()` itself still
terminates fine (its exit check is `run.status`-based, set independently by the `exit` handler,
not `turn.end`-based) — but `runtime/event-pump.js`'s `updateDerived` only marks a run's derived
status terminal ON a real `turn.end` event, so a silently-dead run's derived status stayed
whatever it was before, never actually recorded as terminal at that layer — the SAME class of gap
items 31/32 just closed for the OpenCode adapter. Fixed with the identical pattern: new
`Run._turnEnded` flag, set when the real `result`-driven `turn.end` fires, reset at the top of
`_sendUserMessage` (covers both `sendInput` and `clearContext`'s `/clear`); the `child.on('exit',
...)` handler now synthesizes a fallback `turn.end` if none was ever emitted, mapped onto the same
`'completed'|'error'|'aborted'` vocabulary every other `turn.end` uses (a clean exit code alone
does NOT mean `'completed'` here — the JSON protocol's own `result` line never arrived, so this is
always `'error'` unless the run was already known `'stopped'`/`'interrupted'`, in which case it's
`'aborted'`). New `FAKE_CLAUDE_MODE=crash` in the fake test binary (prints the usual delta, then
exits nonzero with NO result line — the exact on-wire shape a real crash leaves) plus a new case in
`adapters/claude-code/test/test-claude-code-adapter.mjs`. Verified to fail against the pre-fix code
(the drain loop received `process.exit` and nothing else — no `turn.end` at all) before restoring
the fix. `npm test`: exit 0, **124 suites** (one new case in an existing file), re-verified 2x. Full
detail below, at item 34's own entry.

**Item 33, right after item 32**: checked `clearContext`/`resume`'s "incompatible semantics between
harnesses" backlog note — already resolved, no code change needed. `conformance/matrix.js` +
both adapters' `capabilities().clearContext` already declare the real erase-vs-compact difference as
an explicit string, checked by `conformance/suite.js`. The backlog line was stale, same shape as
item 30's db/ row-count-check finding. `supervisor/adapters/`'s backlog is now down to 2 items: Claude
Code's silent-exit no-`turn.end` gap, and `verifyRunIdentity()`'s HTTP-fallback false-positive.

**Item 32, same session (2026-09-13)**: the sixth item off the OLDER should-fix backlog —
`supervisor/adapters/opencode/adapter.js`'s OpenCode abort emits BOTH `session.error`
(MessageAbortedError) AND `session.idle` for the SAME logical turn ending (measured behavior, per
`interrupt()`'s own doc comment) — both map to `turn.end`, so an aborted run got TWO terminal events
in its log, and `runtime/event-pump.js`'s `updateDerived` (plain last-wins overwrite of
`derived.terminalStatus`) silently reported the run as cleanly `completed` (from the later
`session.idle`) instead of `aborted` (the true, earlier reason). Fixed with a new `Run` flag,
`_turnEndedForCurrentTurn`: set the first time a real `turn.end` is emitted for the current turn,
reset at the start of each new turn (`sendInput()`); `_demuxOneEvent`'s per-session branch now
suppresses (with a stderr-ring diagnostic breadcrumb, not silent) any SECOND `turn.end` for a turn
already ended. Also applied consistently to the two other `turn.end`-emitting sites (a rejected
`prompt_async`, and item 31's `server.instance.disposed` synthesis) so all four terminal-event sources
agree on the same one-terminal-event-per-turn invariant. New case in
`adapters/opencode/test/test-opencode-adapter.mjs`; the fake server's `/abort` now also broadcasts
`session.idle` after `session.error` (previously only sent the one event — didn't even reproduce the
real bug), plus a new `drainAll()` test helper (unlike the existing `drainUntilTurnEnd`, does NOT stop
at the first `turn.end` — an earlier draft of this test used the stopping helper and passed trivially,
never actually observing whether a second event arrived; caught and fixed before trusting the result).
Verified to fail against the pre-fix code (2 turn.end events observed, the second overwriting status
to `'completed'`) before restoring the fix. `npm test`: exit 0, **123 suites** (one new case in an
existing file), re-verified 2x. Full detail below, at item 32's own entry.

**Item 31, same session (2026-09-13)**: the fifth item off the OLDER should-fix backlog —
`supervisor/adapters/opencode/adapter.js`'s `server.instance.disposed` mapped to `null` (a deliberate
liveness-only broadcast), so a run still mid-turn when its server tore itself down got NO terminal
event at all — `observe()`'s only exit condition is seeing a real `turn.end`, so it waited forever.
Fixed in `_demuxOneEvent`'s session-less broadcast branch: on `server.instance.disposed`, every run on
that server not already `completed`/`errored` gets a synthesized `turn.end` (`status: 'error'`,
`error` naming the disposal) instead of silently nothing. New test-only `POST /debug/dispose` endpoint
on the fake OpenCode server (broadcasts a real `server.instance.disposed` SSE event on demand) plus a
new `FAKE_OC_NEVER_FINISH=1` mode (skips scheduling the turn's natural completion, so a test can
guarantee genuine mid-turn timing rather than racing a 50ms auto-complete). New case in
`adapters/opencode/test/test-opencode-adapter.mjs`: starts a never-finishing turn, disposes the server
mid-flight, asserts a real synthesized `turn.end` arrives rather than the drain loop timing out.
Verified to fail against the pre-fix code (the drain loop received nothing but a `worker.env` record
and hit its own 3s bound) before restoring the fix. `npm test`: exit 0, **122 suites** (one new case in
an existing file), re-verified 2x (one intervening run hit an unrelated pre-existing flake in
`runtime/test/concurrency.test.js`, confirmed by 2 clean re-runs immediately after — not caused by this
change, not investigated further since it didn't recur). Full detail below, at item 31's own entry.

**Item 30, same session (2026-09-13)**: the fourth item off the OLDER should-fix backlog —
`supervisor/adapters/opencode/adapter.js`'s `StderrRing` was bounded by LINE COUNT (200 lines), not
bytes — a process writing one enormous line with no newline (a giant JSON dump, garbage binary output)
stored the whole thing as a single ring entry, so "200 lines" was not actually a memory bound. Rewrote
`StderrRing` to bound by BYTES (`STDERR_RING_MAX_BYTES`, 64 KiB total) with a per-line truncation cap
(`STDERR_RING_MAX_LINE_BYTES`, 4 KiB, itself clamped to the instance's own budget so a truncated line can
never immediately evict itself back out of an otherwise-empty ring). Exported the class and added a pure
unit test, `adapters/opencode/test/stderr-ring.test.mjs` (3 cases: many small lines evicted correctly,
one 10 MiB line truncated rather than stored whole, many lines each individually small but exceeding the
total budget together). Verified all 3 to fail against the pre-fix (line-count-bounded) code before
restoring the fix. `npm test`: exit 0, **121 suites** (unchanged — the new file's own console output uses
`ok —`, not `PASS:`, same convention `mcp-manifest.test.js` already established), re-verified 2x. Full
detail below, at item 30's own entry.

**db/'s three backlog items were closed the same session, right before item 30** (two by code fix —
`openDb()`'s fd leak, item 27 — and one deferred, one resolved-as-stale by a targeted audit): checked
the `db/`-directory backlog's two remaining items and made a scoping call on each:
- **"missing `requests` writer"** — NOT a bug. `pendingRequests()`'s own comment in `runtime/
  supervisor.js` already says why: the `requests` table exists for Slack-inbound requests, but the
  Slack-inbound feature itself (PLAN.md §13.2, depends on the `../team-slack-bridge/` sibling repo) is
  whole-feature backlog, not built at all yet. Nothing to patch here — skip it, it isn't a small fix.
- **"`event_log`/`outbox` redaction gap"** — NOT a small fix either, and needs a real product/security
  decision before touching it: `db/redact.js`'s `redactPrompt` already redacts the STARTING prompt by
  default (hash + preview, full text opt-in only), but `event_log` (the tier-1 transcript itself —
  assistant text, tool calls, tool results) is deliberately persisted in full, because tier-1 existing
  in full IS the human-transcript feature (Rule 4: "the human has the transcript, that's the whole
  point"). Redacting it wholesale would break that. If this is worth doing at all, it needs a decision
  about WHAT specifically should be redacted from a live transcript (secrets pasted mid-conversation? a
  tool's raw output? all of it?) — not something to guess at unilaterally. Flagging rather than fixing.
- **"no affected-row-count checks on writes"** — **AUDITED 2026-09-13, resolved as a STALE note, no
  code change needed.** A background fork checked every UPDATE/DELETE writer in `db/index.js` (~35
  functions): every one already checks `.changes` (many carry their own dated comment — "codex review,
  fixed 2026-09-11", "Phase 7 review (sol)" — from earlier individual passes that each fixed exactly
  this class of bug one function at a time) or has 0-rows-matched as a legitimately harmless no-op
  (`reopenRun`'s clear-if-present `asks.auto_close_at` reset; two pure-bookkeeping timestamp bumps in
  `claimTaskWorktreeSlot`/`attachToPool` whose target row's existence is already confirmed earlier in
  the same transaction). The terse backlog line just never got updated to reflect that cumulative
  progress. Nothing to fix here.

**`supervisor/db/`'s three backlog items are now ALL closed** — two by code fix (`openDb()`'s
fd leak, item 27) and one deferred/one resolved-as-stale by this audit (`requests` writer is a whole
unbuilt feature; the redaction gap needs a product decision, not a unilateral code change; the
row-count-check note was stale). `supervisor/adapters/`'s `StderrRing` byte-bound gap is fixed too
(item 30, above) — 5 items remain in that directory's backlog, see the list below.

**Item 29, same session (2026-09-13)**: the third item off the OLDER should-fix backlog —
`supervisor/lock/`'s two temp-file cleanup gaps. (1) `fs.writeFile(tmpPath, ..., {flag:"wx"})` used to
run BEFORE the try/finally that cleans up `tmpPath` — `wx` creates the file as one step of that call, so
a failure partway through the write itself (disk full, an I/O error) left a half-written file on disk
forever, nothing ever reached the cleanup path for it. (2) once `fs.link()` had ALREADY succeeded (the
lock is genuinely held at that point), a failure removing the now-redundant temp hard link used to
propagate and fail the whole `acquireLock()` call — turning a legitimately-acquired lock into an orphan
the caller never gets a `release()` for. Both fixed in `lock/lock.js`: the write is now inside the same
try/finally as the link, and cleanup after a SUCCESSFUL link is best-effort (never fails the
acquisition), while cleanup after a failed/unpublished write still propagates a real error as before.
New `lock/test/cleanup-failure.test.js` (2 cases, `node:fs`'s `promises` object monkey-patched for the
duration of one case each — same object `lock.js` itself imports, so the patch reaches it with no
injection point needed in `lock.js`), verified to fail against the pre-fix code (both independently)
before restoring the fix. `npm test`: exit 0, **121 suites** (one new file, 2 cases), re-verified 2x.
Full detail below, at item 29's own entry.

**Item 28, next session (2026-09-13)**: the second item off the OLDER should-fix backlog —
`supervisor/ipc/`'s unsolicited frames (overflow/shutdown notices) used `id: null` with no way for a
real client to ever receive them; `ipc/client.js`'s correlation model (`pending`/`streamHandlers`, both
keyed by request id) silently dropped every one, since nothing is ever keyed by `null`. New
`client.onNotice(handler)` delivers them; the overflow frame also gained a structured `event: {type:
"connection.overflow", maxLineBytes}` twin of its existing `error` string, matching the shutdown
notice's own `event: {type: "server.shutdown", reason}` shape. `npm test`: exit 0, **119 suites** (one
new case in an existing file), re-verified 2x. Full detail below, at item 28's own entry.

**Item 27, same day**: the first item off the OLDER should-fix backlog (the section below the numbered
list) is fixed — `openDb()`'s error-path handle leak (a real fd leak on every failed open: `new
Database()` opens a real handle before any pragma/migration step that could throw). `npm test`: exit 0,
**118 suites** (one new file), re-verified 2x. Full detail below, at item 27's own entry. The rest of
that backlog section is unchanged — this closed exactly one item, not a general sweep.

**Item 26, same day, right after item 25**: the utility-task lane's own "not built" gap (item 13) is
closed — `createUtilityTask({ type, title, ... })` is a one-call dispatch (task + worker + assign,
in the right order), and each of the 4 utility roles' spawned run now gets REAL per-role instruction
text (`domain/utility-instructions.js`) instead of the generic "Task t1 (type), role x." sentence
every other role still gets. `npm test`: exit 0, **117 suites**, re-verified 3x. Full detail below.

**Item 25, same day, right after item 24**: 4 of the deferred-in-item-16 findings from
`codexdoc/REVIEW-NOTES.md` are now fixed too (findings 6, 9, 12, 16 — self-answering asks, the
`tuiSnapshot` transcript leak, the git fight loop blocking the daemon's event loop, and the
ask/task lifecycle wiring). Each verified to fail against the pre-fix code. `npm test`: exit 0,
**117 suites**, re-verified 3x. Full detail below, at item 25's own entry. **One pre-existing flake
observed, unrelated to this pass**: `adapters/claude-code/test/test-claude-code-adapter.mjs`'s
"turn.end status shape (rejected prompt synthesizes error)" failed once under full-suite load,
passed standalone, and passed clean on 2 immediate full-suite re-runs — a timing flake in a file
this pass never touched, not investigated further given it didn't recur.

**Where things stand**: Phases 0-6 complete and reviewed; Phase 7 (utility framework, resource leases,
MCP pooling, the utility-task lane) has its LIFECYCLE/FRAMEWORK complete — task/role/capability
resolution, leases, pooling bookkeeping — but **worker-side MCP tool transport for Jira/Slack/AWS-query
is NOT complete** (review-sol-2026-09-13.md finding 13/35, corrected 2026-09-13: `spec.mcpConfig` is
deliberately left unset, so a Jira/Slack/awsquery utility run can start and enter `planning` while
having no actual channel to perform its advertised operation — see item 39's "not yet actioned" list,
top of this file, for the full explanation). The git-push utility path does NOT depend on that
transport (it is a direct supervisor wire command, `agents/git-create-push.js`) and is genuinely
complete. Twice independently reviewed (codex, then `opencode`'s `luna` once codex hit a multi-day quota
wall), and has had **20 real findings fixed across four passes** — item 16 (9 findings, first codex pass), item 18 (2 findings, second codex pass), item
22 (5 of 9 findings, first `luna` pass), item 24 (the remaining 4 findings from that same `luna` pass —
**all 9 of `review-luna-2026-09-11.md`'s findings are now fixed**).
**Item 22's own flake fix was itself incomplete — item 23 caught and root-caused it during final
session verification**: a fire-and-forget child-process exit handler in `runtime/mcp-pool.js` could
crash the ENTIRE node process (not just fail a test) if it fired after a test had already closed the
database — the first fix only made one test case wait longer, and the same unguarded handler crashed
the suite again from a DIFFERENT test the very next full run. Now actually try/catch-guarded at the
source. Read item 23 before touching `mcp-pool.js` — it's a real lesson about verifying a flake fix
touches the code that threw, not just the test that happened to surface it.
`npm test`: **117 suites**, exit 0, re-verified 3x after item 23's fix and again (2x) after item 24's
fix, zero leaked processes checked every time.
`leo-mcp` (`../leo-mcp/`, PRIVATE at `manish96170/leo-mcp`) now has a real socket transport in addition
to stdio, closing the "not a genuinely shared connection" limitation that item 17 originally left open
— though item 22 separately found (and fixed) that the utility-task-lane's OWN wiring toward that pool
had gone further wrong (was handing a broken value to a real adapter) than item 17 knew at the time.

**Item 24, 2026-09-11 — the 4 findings item 22 deliberately left open (worktree-claim area), all fixed
in one sequential pass** (not parallel forks, per this file's own prior "shared-file collision risk"
note): finding 5 (worktree claim didn't bind to the requested repo/branch — a conflicting caller could
get back someone else's `{ created: false }` silently) fixed by persisting `tasks.worktree_repo_path`
at CLAIM time, not just finalize, via migration 0014, and refusing on mismatch on both the finalized
and still-pending sides of the CAS; finding 6 (a crashed creator left `WORKTREE_CLAIM_PENDING` forever,
an availability deadlock) fixed with a new `reclaimStaleTaskWorktreeClaim` that reopens a claim once it
has sat unfinalized past 60s, then checks disk to ADOPT the dead claimant's real git work if it already
landed, or redo it if it didn't; finding 7 (discard-versus-start check-then-delete race) fixed by making
`assignTask` refuse a terminal task outright — the general "one shared lifecycle reservation" the
finding also asks for is deliberately NOT built, since refusing terminal-task assignment removes the
only way that race could occur without it, and there is no reopen transition today for a future one to
matter against; finding 8 (forced discard destroyed clean uncommitted work) fixed with a
`git status --porcelain` dirty-tree check that refuses by default, overridable with an explicit
`{ force: true }`. All 4 verified to fail against the pre-fix code (each guard temporarily disabled,
the corresponding new case reproduced the finding's own repro symptom) before restoring the fix.
Regression: `runtime/test/worktree.test.js` cases 11-14 (10 cases before this pass, 14 after — same
file, no new test file). Read `codexdoc/review-luna-2026-09-11.md` findings 5-8 for the full mechanism
per finding; each now has a "Fixed 2026-09-11" note in place, same convention as findings 1-4/9.

**Codex status**: blocked until **Sep 15, 2026 11:02 AM** (a multi-day quota wall, not the earlier
same-day reset) — don't retry before then. `opencode --agent luna --variant medium --auto` is the
interim substitute, already proven to work for both a diff review and a full-repo architecture review
this session (`codexdoc/review-luna-2026-09-11.md`, `ARCHITECTURE-luna-2026-09-11.md`,
`REVIEW-NOTES-luna-2026-09-11.md`) — keep prompts short/single-line/ASCII per the known environment
notes further down this file, or output degrades to banner-only.

**Nothing has been committed or pushed this entire session** (multiple explicit owner instructions to
that effect) — `git status`/`git diff` in this repo reflect everything above, uncommitted. Same for
`leo-mcp` (pushed once early on; everything built in it since is also uncommitted on top of that).
mechanical half — item 12, PLAN.md §16.1. **Still design-only, nothing built:** three TUI corrections
(item 14, PLAN.md §14.4/§5, FLOWS.md §6a-6c). Repo is public — manish96170/custom-team-dashboard, read
the GIT section before adding
anything, hiding it later does not un-publish it.
**ADDENDUM, same day, item 22**: codex's quota is now blocked until Sep 15 — a fresh review used
`opencode`'s `luna` agent instead (`codexdoc/review-luna-2026-09-11.md`, 9 findings). **5 fixed**: the
`hashPoolConfig` credential-hashing bug, a dead-pool-process attachment leak, an `adapter.start()` throw
leaking attachments, invalid lease TTLs (item 16 had wrongly marked this "still NOT fixed" — it is now),
and — most consequential — **item 17's MCP-pool wiring briefly handed the real adapter a malformed
`spec.mcpConfig`, not just an unshared one as item 17 claimed; `start()` no longer sets it at all**. Read
item 22 before trusting item 17's own "honest limitation" wording, which this correction supersedes.
117 suites unaffected (all fixes, no new files). The other 4 findings from this same review (worktree
claim/repo-branch binding, the crashed-claim deadlock, discard-vs-start racing assignment, forced discard
of clean uncommitted work) were explicitly NOT covered by item 22 — **now fixed, item 24, same day.**)

## Forty-eighth pass, 2026-09-14 — Phase 8's clear-policy DECISION logic (item 39's remaining half)

Item 39 (2026-09-13) built the SCHEMA half only — `config/harness-defaults.js`'s `clearPolicy` field per
role, validated against `CLEAR_POLICIES`. Nothing read it. This pass built the decision module and wired
it for real.

**Investigated before writing any code** (same discipline the two prior review passes used):
- `domain/task-states.js`'s state machine plus every `recordTransition(...)` call site in
  `runtime/supervisor.js` — found that only THREE of the seven call sites also regenerate a tier-3
  handoff (`approveTaskLocked`'s success path, `assignTask`'s compensation path, `mergeTask`) — the auto
  block/unblock sites do not. Rule 5's own argument ("clearing is cheap BECAUSE a handoff exists to
  reload from") ties clearing directly to those three, not to every `recordTransition` call.
- Checked `assignTask`'s own handoff site specifically and found every run it could apply to was spawned
  moments earlier in the SAME call — a brand-new process has nothing to clear, so this site is
  deliberately NOT wired (documented in place in the code, not silently skipped).
- Checked how a review "round" actually concludes: `round` is a caller-supplied integer
  (`recordReviewVerdict`), and the ONLY round-concluding event this runtime drives is `approveTaskLocked`'s
  success path. `awaiting-review` -> `fixing` (a change-request round ending) is a legal edge in
  `domain/task-states.js` but nothing in `runtime/supervisor.js` transitions a task there automatically —
  so `per-review-round`'s OTHER half has no real event to hook yet. Not wired; flagged as future work once
  that transition itself exists, not invented against a hypothetical.
- Checked whether a utility ("always") role's run is structurally one-shot (no second turn possible) —
  it is NOT: nothing stops `resume()`/`sendInput()` reaching one a second time, so `always` needed a real,
  per-turn trigger rather than being satisfiable by architecture alone.
- Checked `on-demand`: the `clearContext(runId)` wire command already exists and callable directly — that
  already IS "on demand". No automatic trigger should ever fire it, and none does.

**Built:**
- `domain/clear-policy.js` — pure `decideClear({ clearPolicy, trigger, clearContextCapability })`, mapping
  each of the four policies to the one real trigger found above (`state-transition`,
  `review-round-concluded`, `turn-end`, `demand`), refusing when the target harness's own
  `capabilities().clearContext` is falsy. `domain/test/clear-policy.test.js`: 8 pure cases, all four
  policies against all four triggers plus the capability gate.
- Wired into `runtime/supervisor.js`: `configSlotForWorker` (reuses `derivedSlotFor`'s own
  assignment-record-first, stable-nickname-order mechanism, without its "parent" rename), `maybeClearRun`
  (best-effort, non-fatal, gated by the adapter's declared capability), `applyClearPolicy` (task-scoped,
  for `approveTaskLocked`/`mergeTask`) and `applyClearPolicyForRun` (single-run, for the pump's `turn.end`
  hook). Every automatic call is fire-and-forget (`.catch()`, never awaited from a transition/verdict/turn
  path) — matching `writeTurnDigest`'s and `mcpPool.detach(...).catch(...)`'s existing convention in this
  same file.
- `runtime/test/clear-policy.test.js` — 3 real-process wiring cases: approving a task clears the coder's
  own open run AND a reviewer's open run, and never touches a bystander coder's unrelated run on a
  different task; a utility role's run is cleared on its own `turn.end` with no task-level trigger at all;
  a harness declaring no `clearContext` support is never called regardless of policy. Verified: case 1
  fails with a real 5-second timeout against the pre-wiring code (confirmed by temporarily reverting
  `runtime/supervisor.js`'s changes and re-running), restored, passes.
- `ROADMAP.md`'s Phase 8 checkbox flipped `[~]` -> `[x]`; `PLAN.md`'s Rule 5 annotated "BUILT 2026-09-14".

Full `npm test`: exit 0, twice in a row (one standalone re-run of
`adapters/claude-code/test/test-claude-code-adapter.mjs` needed once, due to a pre-existing intermittent
flake in that suite's `turn.end status: completed` case — confirmed clean, unrelated to this pass).

Committed and pushed as `a307ae6`.

Read this first in a new session. It tells you what's real, what's fixed, what's
still broken, and exactly what to do next, without re-reading the whole prior
conversation.

## What this project is

A session-orchestration dashboard for running many concurrent Claude Code / OpenCode
sessions as a virtual team (leads, coders, reviewers, QA), with a single-writer
SQLite-backed supervisor daemon as the runtime. Full design: `PLAN.md` (21 sections — §20,
host-resource and git-identity leases, added 2026-09-09; §21, MCP pooling + lazy tool
discovery, and a git-worktree-per-session rule folded into §7, both added 2026-09-10 after
reviewing `hydra-acp`),
`FLOWS.md` (diagrams + keybindings), `ROADMAP.md` (phased build order), `TODO.md`
(the Group 1-6 breakdown). All are up to date and internally consistent.

## Run the tests first

```
cd supervisor && npm test
```

That now runs everything — `test:db`, `test:lock`, `test:ipc`, `test:adapters`, `test:runtime`, `test:pane`,
`test:crash`, `test:tui`, `test:domain`, `test:agents` (individually runnable too). As of this handoff
**112 suites pass, exit 0** (raw `PASS:`-line count as of 2026-09-10; item 8 below explains why this
file's older "113" claim doesn't reconcile cleanly with that count and isn't worth chasing further — use
file count + exit code),
and all thirteen mutation harnesses from before this pass are still at 100% (**185 mutations**: worker-env 22, approval 14,
preflight 10, handoff 14, conformance 9, adoption 12, task-states 8, turn-digest 10, TUI 16, assignment 11,
wrapper 10, review 27, auth 22 — each observed failing BY ASSERTION at the case that protects it).

**The daemon now enforces authorization**, so any client — including a test — must present a principal token.
The owner's is written to the state dir as `owner.token` (0600) by `boot()`. `ping` is the one command that
needs none. If a request comes back with `refused: "unauthorized"`, that is the gate working, not a bug.

Re-run it twice before believing a green result: round three's `endRun` fix exposed a race that only showed up
on about one run in three. If they don't pass on a clean checkout, fix that before building anything new.

**Watch the suite COUNT, not just the exit code.** On 2026-09-08 it silently dropped from 109 to 104 because
202 files in this tree were overwritten at 17:13:40 by an older copy (cause unidentified — not this session's
edits, not the mutation runner, not git, not OpenCode's snapshot repos). Four code edits and two days of doc
updates were lost; the code was re-applied and re-verified, the docs were rebuilt from
`supervisor/runtime/FINDINGS.md`, which survived. A snapshot now lives OUTSIDE the tree at
`~/ctd-snapshot-*.tar.gz`. If the count moves without a reason you know, look for a restore before looking
for a bug.

Five things are deliberately NOT in `npm test` because they cost real money and need the network:
`runtime/test/real-claude-approval.slice.mjs`, `real-claude-crash.slice.mjs`, `real-claude-preflight.slice.mjs`,
`real-claude-adoption.slice.mjs`, `real-phase2-gate.slice.mjs`, plus `pane/test/real-pane.slice.mjs` and
`adapters/claude-code/probe/*-probe.mjs`. Run those by hand when touching the approval path, the recovery
path, adoption or the pane. **One exception worth knowing: `probe/worker-env-probe.mjs` and
`probe/hook-axis-control.mjs` are cheap** — the first makes no observable model call at all.

`test:runtime` and `test:crash` are the slow ones (~15s and ~60s): they spawn real detached
OS processes, kill real process groups, SIGKILL a real supervisor and a real daemon, and
include deliberate grace periods before SIGKILL escalation. Slow is the point — the
alternative proves nothing.

## Where we actually are

**Phase 0a + 0b: fully done.** Contracts written, runtime spiked and proven with real
code (`spike-0b/*/`), reviewed by three independent models, corrections applied. Gate
cleared.

**Phase 1: COMPLETE.** All six groups built, tested and independently code-reviewed (round three: 13 defects
fixed, 3 rejected with reasons, 1 deferred with a design reason). Group 6 — crash/concurrency validation —
found and fixed one real defect of its own (a zombie-only process group reported as having survived a kill).

**Phases 2, 3, 4, 5 and 6: COMPLETE.** Per-phase checklists are in `ROADMAP.md`; every decision and every
defect found along the way is in `supervisor/runtime/FINDINGS.md` §17-§37. The short version:

| Phase | What landed | Record |
|---|---|---|
| 2 — vertical slice (**gate: GO 2026-09-07**) | approval round trip, live pane, real-harness crash recovery, worker-env decision, preflight cleanup, tier-3 handoff, tier-2 digests | §17-§25, §31, §33 |
| 3 — second harness + adoption | capability matrix with semantics-carrying fields, conformance suite, hook adoption of human-started sessions, `started_by` provenance | §26, §27, §30 |
| 4 — TUI | pure layout/state + I/O split, replay by cursor, mouse, Requests panel, a rendered status line | §28, §34 |
| 5 — domain | §6 state machine ENFORCED, task-type workflow profiles, harness/model assignment with idempotency and partial-start compensation | §29, §35 |
| 7 — authorization gate (REVIEWED) | capability-based authorization: principals with hashed tokens, a command->capability policy that FAILS CLOSED, an append-only agent journal recording allows and refusals, and a sensitive class bound to argument hashes | §38 |
| 6 — reviews | `review-profiles.json` -> `review_profiles` (content-addressed), revision-bound per-dimension verdicts, finding verification, review bar, validated model diversity | §37 |
| — | the `wrapper` tier: pipes, not `node-pty` — and it corrected §9's own tier logic | §36 |

**Phase 7 (utility framework + git agent) is the next thing to build.** `callerIdentity`/capability
authorization must land first and in one session: every utility agent is gated by it, and handing out the
roster before the gate exists is the same sequencing bug this project already hit once.

| Group | Directory | Status |
|---|---|---|
| 1 — Persistence | `supervisor/db/` | Built, tested, reviewed. All 3 blocking bugs fixed (`createAsk` column count; concurrent-startup WAL/`SQLITE_BUSY`; unserialized migrations) + 2 new regression tests |
| 2 — Lock fix | `supervisor/lock/` | Built, tested, reviewed. Blocking TOCTOU fixed + deterministic regression test added |
| 3 — Wire protocol | `supervisor/ipc/` | Built, tested, reviewed. All 3 blocking bugs fixed + regression tests |
| 4 — Adapters | `supervisor/adapters/` | Built, tested, reviewed. Blocking SSE race fixed + regression test |
| 5 — Integration | `supervisor/runtime/` | Built, tested (5 test files: 8 pump cases, 7 reconcile cases, 9 end-to-end integration cases, 13 round-three regression cases, plus process-group ownership), mutation-verified with 15 mutations, **reviewed by luna + terra + a Sonnet consolidation; 13 defects fixed, each fix reverted and observed failing**. See `review-three/group5-verdicts.md` |
| 6 — Validation | `supervisor/runtime/test/` | Built and passing (4 suites, 30 cases: `crash-recovery`, `concurrency`, `daemon-crash`, `asks`), 21 runtime mutations each observed failing at the case that protects them. Found + fixed 1 real defect (zombie-only process group) and shipped both of its design findings as migration 0003. `npm run test:crash`. **Phase 2 gate cleared** |

Every fix listed above has a regression test that was **explicitly verified to FAIL
against the pre-fix code** (each fix was temporarily reverted and the test re-run), so
none of them are tautological. That verification step is worth keeping as a habit —
it's what distinguishes these from the spike-0b claims that didn't survive review.

## What to keep, if Phases 2-6 are ever refactored

The load-bearing invariants, in one place. Each of these is enforced by a test AND by a mutation, and each one
is a thing a reasonable person would simplify away:

- **`merged` needs an explicit human approval.** No number of green reviews is one. PLAN.md §6 calls it "a hard
  rule, not a default that can be silently skipped", and it survives every profile — including an `adhoc`
  task, which needs zero reviewer verdicts and still cannot merge itself.
- **`approveTask()` is the only path to `approved`.** `recordTransition` will otherwise take the transition
  from anybody who passes two verdicts. A rule nothing enforces is a comment — Phase 5 learned this about the
  state machine, Phase 6 about the review rule.
- **Verdicts are revision-bound, and the asymmetry is deliberate:** a stale approval dies with its commit, a
  stale change request does not, because nobody said it was fixed.
- **Quorum counts distinct reviewers, not verdicts.** One thorough reviewer is not two reviewers.
  **CORRECTED 2026-09-11 — this promise was not actually enforced.** Both codex reviews
  (`codexdoc/REVIEW-NOTES.md` finding 3) found `recordVerdict`'s wire handler accepted a caller-supplied
  `workerId` without binding it to the authenticated principal — one authenticated reviewer token could
  submit verdicts under a second worker's identity and manufacture the two-distinct-reviewer quorum alone.
  **Fixed the same day**: `recordVerdict` now refuses when an authenticated worker-backed principal's own
  `workerId` disagrees with the verdict's claimed `workerId`; the wire handler now forwards `cmd._principal`
  through (it had been dropping it). Proven against pre-fix code (`runtime/test/review.test.js` case 18).
  Deferred: nothing yet stops a reviewer from arbitrarily advancing the authoritative round being reviewed.
- **The supervisor only kills what it started.** `reap` refuses an adopted run, reconciliation skips the orphan
  branch for it, and `runs.started_by` makes that queryable instead of implicit in three mechanisms.
- **A clear is not a kill.** `clearContext` erases on Claude Code and COMPACTS on OpenCode — same method name,
  opposite meaning, which is why the capability matrix carries semantics as strings rather than booleans.
- **No agent reads tier 1.** Tier 2 digests and tier-3 handoffs are what cross a worker boundary. Tier 2 is
  extractive by default and states no assumptions; tier 3 QUOTES tier 2 and never infers.
- **Findings are verified before storage, and an unverified finding says so.** With no verifier configured a
  finding is `unverified` and still delivered — calling it confirmed is a lie, dropping it loses real work.
- **A wrapper-tier run is always marked**, in the pane header, in the pane body, and as `degraded: true` on
  every event. `structuredOutput: 'terminal'` means wrapper tier however well the adapter behaves.
- **Partial starts keep what worked.** The coder that started is not killed because a reviewer did not; the
  failed role becomes a retryable blocker in the handoff. If NOTHING starts, the task lands in `start-failed`
  and never sits in `starting`.
- **Repo config is OFF by default.** `'project'` — which executes a repo's committed hooks — is opt-in per run
  or per session, and an invalid session value throws rather than silently running with it off.
- **Nothing the authorization decision reads comes from the request.** The capability set is a property of the
  principal row, resolved from a token hash. A request that names its own capabilities is refused exactly like
  one that does not — and the test has to ATTEMPT that escalation, or the mutation survives.
- **The gate fails closed.** A command with no declared capability is refused, and `ipc/server.js`'s demo
  `switch` is no longer a fallback for a real command surface (it was an authorization bypass, since the
  wrapper wraps the map and cannot wrap a case statement).
- **`merged` needs a second signature bound to the arguments.** Self-approval is refused, so a CTO merge still
  requires the human. That is §6's gate as an artifact rather than a boolean.
- **Authorization is not a sandbox.** Workers run as the same user and can read the owner's token; §38.1 says so
  explicitly. Do not let a future note claim otherwise.
- **Every idempotency key is claimed before the side effect**, not after. And test it concurrently: a
  sequential pair of calls passes even when the claim is in the wrong place.

## Group 1's two blocking migration bugs are now FIXED (2026-09-05, third pass)

The previous handoff opened with "fix these before Group 5." Done. Group 5 is now
unblocked. Details in `supervisor/db/FINDINGS.md`; the short version:

1. **Concurrent-startup `SQLITE_BUSY`** — `busy_timeout` now goes first, but that alone
   was *not* the fix. SQLite needs exclusive access to convert a db to WAL and does not
   invoke the busy handler for that conversion, so no timeout can absorb it;
   `journal_mode = WAL` is now retried in `setWalMode()` (`db/index.js`), treating "some
   other process already made it WAL" as success. Reverting only the pragma *ordering*
   made no test fail — worth knowing, because the review's stated mechanism was
   incomplete even though the bug was real. Another instance of "verify the mechanism,
   not just the conclusion."
2. **Unserialized migrations** — each migration now runs in a `BEGIN IMMEDIATE`
   transaction that takes the write lock *before* re-reading `schema_version`
   (`db/migrate.js`), so the loser skips instead of re-running the DDL.

Two new tests, both wired into `npm run test:db`, both verified to fail against the
pre-fix code: `db/test/wal-conversion.test.js` (deterministic, 3/3 pre-fix failures) and
`db/test/concurrent-startup.test.js` (8 processes racing a fresh state dir, 6/6 pre-fix
failures). The latter alternates barrier-synchronized and staggered child arrival on
purpose — measured: barrier rounds catch the migration race but hide the WAL one, and
staggered rounds do the reverse. Don't "simplify" that away.

## Group 5 is done (2026-09-06, fourth pass)

Built in `supervisor/runtime/`: `procinfo.js`, `spawn.js`, `event-pump.js`,
`reconcile.js`, `supervisor.js`. `ipc/daemon.js` is now the real daemon — it opens the
real database, registers both real adapters, boots (routing rehydrated, then
reconciliation), serves `supervisor.commandHandlers()`, and tears down bounded on either
signal. Smoke-verified end to end: boots, answers `ping`/`list`, exits clean on SIGTERM
with no surviving children.

**Read `supervisor/runtime/FINDINGS.md` before touching any of it.** The three things
worth knowing up front:

1. **PLAN.md's "Known gap, explicitly not yet closed" is closed.** Both adapters spawn
   detached and ownership is *verified* — `spawnManaged` reads the child's pgid back from
   the OS and kills a child it could not own rather than recording an unverified identity.
2. **`orphaned-unmanaged` is no longer a dead end.** Real `reap` (verify pid + pgid +
   lstart, then kill the group) plus `harnessOf` as a *cache over `runs.harness_id`*, so a
   run created before a restart is routable. Two refusals to kill are contract, not
   caveat: pid reuse, and a group shared with another open run (pooled `opencode serve`).
3. **The event pump replaced client-driven consumption**, which had three real defects:
   nothing persisted unless a client watched; two clients meant double-persist *and* a
   split stream; a disconnecting client took the only consumer with it.

Both deferred Group 3 review items are folded in and closed: per-connection
`AbortController` cancels a peer's `observe` iterator on disconnect, and duplicate
in-flight correlation IDs are rejected rather than silently overwriting a waiter.

**How Group 5's tests were verified.** There is no "pre-fix" version of new code, so the
standing "verified to FAIL" rule was satisfied by **mutation testing**: 15 mutations total
(7 integration, 4 pump, 4 reconcile), each breaking one mechanism, each confirmed to fail
*at the assertion that claims to protect it*. The table is in `runtime/FINDINGS.md`. Two
methodology notes from doing it: `timeout(1)` does not exist on macOS (use
`perl -e 'alarm shift; exec @ARGV'`) and a hung top-level `await` shows up as Node exit 13
with no PASS line. Also — one mutation was initially "caught" for the wrong reason (a
ReferenceError, not the behavior), so it was re-done behaviorally. A mutation that crashes
the module proves nothing.

## Group 5's review is done (round three, 2026-09-06, fifth pass)

`luna` and `terra` reviewed `supervisor/runtime/` independently (9 findings each), Claude
Sonnet consolidated them into 15 unique findings (deduping, correcting mechanisms, adding 2
neither reviewer found), and every mechanism was then re-verified here against the source
before anything was changed. **`review-three/group5-verdicts.md` is the file to read** — it
records what was fixed, what was rejected, and why, and it overrides the consolidation where
they disagree.

Result: **13 fixed, 3 rejected, 1 deferred, 1 fixed only partially and labelled as such.**
The six that mattered most:

1. **A failed spawn crashed the whole daemon** — no `'error'` listener on the child. Any typo
   in a command string, or a bad cwd, took the supervisor down. Reproduced before fixing.
2. **`reap` wrote terminal rows for outcomes it hadn't achieved** — a group that survived the
   kill still got `exit_reason = "reaped"`, and a shared-group reap closed the row even when
   `adapterStop` threw. Both produce a live process with no open row and no handle: nothing
   would ever reap it again, and the shared-group case makes a later reap of the *sibling*
   kill the group and take the still-live session with it.
3. **`resume()` never re-attached the pump** — `attach()` is a no-op once `state.consumer` is
   set, so a resumed process's events were consumed by nobody: `event_log` stopped growing and
   `observe` reported a live run as finished. Now resets pump state and bumps
   `runs.generation`.
4. **The identity-capture timeout abandoned the child** instead of killing it, manufacturing
   the exact orphan `spawn.js` exists to prevent (no pid recorded → classified `lost` without
   asking the OS → `reap` short-circuits on the NULL pid).
5. **`endRun` had no `WHERE ended_at IS NULL`** while `reconcileRun` did, so two concurrent
   terminal writers clobbered each other's `exit_reason`. Fixing it immediately exposed a real
   ordering question the unguarded UPDATE had been hiding — see below.
6. **A subscriber parked mid-fan-out could silently skip evicted events**, breaking the pump's
   documented "eviction is never silent" guarantee. The outer-loop gap check cannot catch it.

**The one thing to understand before touching terminal writes:** `endRun` is now
first-writer-wins, and a *deliberate* cause has to outrank a *derived* one. When the
supervisor kills a run, the adapter stream ends because of the kill, so the pump derives
`error` → `"errored"` and races reap's truthful `"reaped"`. `supervisor.js` therefore holds a
`terminalIntent` for the duration of a deliberate `stop`/`reap`, and the pump's `onEnd` hook
prefers it. The map save/restores rather than set/deletes because the two nest (`reap` holds
`"reaped"` while ending one session of a shared group with an inner `"stopped"`). Don't
"simplify" that to a `set`/`delete` pair.

Two findings are worth carrying forward as review-quality lessons, both in the verdicts file:

- luna's "incomplete identity is reapable" was **rejected by the consolidator as unreachable
  in code — and both were wrong**. Schema v1 (`0001_initial.sql`) has `pid` and
  `process_group` and no `proc_lstart` column at all, so every pre-0002 row has exactly that
  shape. `reap` now has a third refusal for it. Found by reading the migrations, not the
  reviews.
- terra's mechanism for the shutdown race ("waits up to 2 seconds") was **arithmetically
  wrong** (`Math.min(2000, timeoutMs)` clamps to the caller's budget); the defect was real for
  a different reason. Acting on the stated mechanism would have changed nothing.

Verification, per the standing rule: `runtime/test/review-three.test.js` has 13 cases and
**every fix was reverted individually and the protecting case observed failing**, with the
mechanism the finding describes (table in the verdicts file). One revert was discarded as
invalid first — case 3 reused a shared-pgid fixture, so the wrong refusal answered and the
case "failed" for the wrong reason. Same trap as Group 5's ReferenceError mutation.

## Group 6 is done, and Phase 1 with it (2026-09-06, sixth pass)

Three suites in `supervisor/runtime/test/`, `npm run test:crash`, all wired into `npm test`:

1. **`crash-recovery.test.js`** — `_crash-victim.js` runs a real supervisor in its **own OS
   process** with real detached children and a continuous write load, and is killed with
   **SIGKILL**: no `finally`, no `closeDb()`, no adapter disposal, no lock release, an
   un-checkpointed WAL left on disk. Then: `integrity_check` ok, no unparseable
   `payload_json`, nothing committed lost, every run row obeying its terminal-state
   invariants — and all three reconciliation outcomes distinguished on data written by a
   process that no longer exists (`orphaned-unmanaged` for the children that survived, `lost`
   for the one whose process died with the crash, `finished` neither written nor overwritten).
   Open asks closed, orphans then actually reaped, second reconciliation a no-op.
2. **`concurrency.test.js`** — everything over the real socket, because that is where
   concurrency actually arrives: eight concurrent starts (eight distinct *verified* process
   groups), concurrent load with exact per-run event accounting plus an anti-crosstalk check,
   three concurrent observers on a run being written to, `stop` racing `reap`, two concurrent
   reaps, bounded teardown with nothing surviving.
3. **`daemon-crash.test.js`** — the **real `ipc/daemon.js`**, not a supervisor composed in a
   test: it crashes and restarts, so the stale lock (held by a dead pid) is taken over, the
   stale socket file is rebound, a third daemon started against the live one is refused and
   leaves it serving, and SIGTERM releases the lock with no harness process left behind.

**The one defect Group 6 found, and it is worth knowing about before you touch any kill
path:** a process group whose members have all exited but not yet been waited for contains only
**zombies**, and on macOS `kill(-pgid, 0)` on such a group *succeeds* while
`kill(-pgid, SIGTERM)` returns **EPERM**. So `killProcessGroup` reported a definitively dead
group as `killed: false` — and round three had just made `reap` gate its terminal write on
exactly that flag, so reap logged "process group SURVIVED the kill" and left the run row open
forever for a process that no longer existed. Fixed with `procinfo.isProcessGroupLive()`
(zombie-aware, portable `ps -A` + pgid filter — BSD `ps -g` selects by process group, procps
`-g` selects by *group name*, so `-g` silently asks a different question on Linux), consulted at
all three decision points in the kill path. `isProcessGroupAlive()` is unchanged and now says
in its docstring that it counts zombies.

That defect was found by the concurrent-double-reap case *by luck* — the zombie window is a few
milliseconds — which the mutation run proved by passing. So there is now a **deterministic**
case for it (a `perl` parent never waits for its child, so the zombie persists). Same lesson as
Group 5's ReferenceError mutation and round three's shared-pgid fixture: a test that only
sometimes exercises its mechanism has not proven it.

**Mutation evidence, and two tests it corrected.** 12 mutations of the runtime, each observed
failing at the case that claims to protect it (full table in `runtime/FINDINGS.md` section 12).
Two of them fixed the *tests*: one assertion checked an already-connected socket client, which
can never catch the socket file being unlinked (an established Unix-socket connection survives
that), and one expected `finished` to be protected by `listOpenRuns` when the guard that
actually protects it is `reconcileRun`'s `AND ended_at IS NULL`. A third was corrected against
the design: two concurrent reaps need not be the writer that closes the row — the pump's
`onEnd` hook can land first, carrying the deliberate `reaped` intent. The invariant is "closed
once, with the deliberate reason", not "closed by reap".

## Group 6's two findings are decided and shipped (migration 0003, 2026-09-06, seventh pass)

Group 6 surfaced two questions rather than bugs. Both went to three independent models
(`sol`, `luna`, `terra` via Bedrock — note `sol` **does** work; the `@ai-sdk/amazon-bedrock`
`reasoningContent.redactedContent` crash only fires when Bedrock actually returns a
redacted-thinking block, so the old "sol is broken" note was too strong). **All three
independently chose the same shape for the first finding**, and that is what shipped.

**Read `supervisor/runtime/FINDINGS.md` section 13 for the full record.** The short version:

1. **`orphaned-unmanaged` is now a lifecycle STATE, not a terminal outcome.** It goes in
   `runs.lifecycle` and the row keeps `ended_at IS NULL`, because the process has not ended.
   Before this, reconciliation closed the row of a process it had *just verified to be running* —
   and since its own input set is `WHERE ended_at IS NULL`, that live unmanaged process was
   classified once and then invisible to every later boot, still burning CPU and tokens. Now it is
   re-examined every boot, and gets a real terminal write when something real happens: `lost`
   when its process dies, `reaped` + `runs.reaped_at` when we kill it.
2. **A side-effect nobody had noticed, fixed by the same change:** a closed orphan row dropped out
   of `listOpenRunsSharingProcessGroup`, so reaping a *sibling* run on a pooled `opencode serve`
   pgid would group-kill the orphan's still-live session, silently. An unreaped orphan now keeps
   protecting its own process group. `reconcile.test.js` case 6 asserts this directly.
3. **`orphan_sightings`** — an append-only journal (`kind: new | repeat`), one row each time
   reconciliation sees a live unmanaged process. **A log, never state**: `runs.lifecycle` is the
   state and nothing reads the journal back as truth. It exists so "we keep getting orphans
   lately" is a query with history behind it, and so a future watcher process has something to
   reason about.
4. **The shortcut list** — `supervisor.orphans()` and an `orphans` wire command: every live orphan
   by title, cwd, pid, pgid, first/last seen, sighting count. That query was impossible before.
5. **Unanswered asks on a naturally completed run get a five-minute grace.** `asks.auto_close_at`,
   **persisted** rather than an in-memory timer, swept on `boot()` and on a 30s interval — a
   supervisor SIGKILLed mid-grace must not strand the ask, which is the very failure being fixed.
   A human answer during the grace wins; the sweep closes as `supervisor:auto-close`, which is
   distinguishable from a human answer.
6. **Deliberate `stop`/`reap` and reconciliation still close asks immediately** — a human is
   already acting, or nothing is left that could answer. Note `stop` never closed asks *at all*
   before; it was the one terminal path that touched `runs` and ignored `asks`.

**The subtlety to understand before touching any of this:** the grace-vs-immediate decision is
keyed on the *terminal reason*, never on which function wrote the row. Killing a run ends its
adapter stream, so the terminal write frequently comes from the pump's `onEnd` hook carrying the
deliberate intent (Group 6, concurrency case 5) — "who wrote it" answers nothing. The first
version of this fix scheduled a grace for every reason, so a reaped run's ask sat open for five
minutes; `asks` case 5 exists because of that.

**PLAN.md section 4 changed**, in three places, all deliberately: the definition of "not already
terminal" (now explicitly `ended_at IS NULL`, which includes orphan rows), the
`orphaned-unmanaged` bullet, and the asks sentence (which now spells out the per-reason policy).
Section 3's schema block gained `runs.lifecycle`, `runs.reaped_at` and `orphan_sightings`.

**Mutation evidence: 9 more (M13-M21), table in FINDINGS §13.** M21 is the one to remember — it
**passed** at first, because in the crash suite every open row happens to be an orphan, so nothing
there could tell "filter by lifecycle" from "every open run". The assertion that kills it had to
move to where healthy managed runs exist (concurrency case 1, eight of them). Third time this
project has hit that trap; the pattern is now explicit in FINDINGS.

## Deferred by decision, not by omission

- **Obsidian vault projection: after the Phase 2 vertical slice** (PLAN.md section 18, ROADMAP
  Phase 10 — both now say so). The basic tier is what gives a picture outside the terminal:
  per team/task/worker notes whose wikilinks make Obsidian's graph view a live team topology
  diagram, a `Dashboard.md` "what is going on right now" file, the live-orphan list beside it,
  **off by default** so nothing writes to the vault unless it is switched on. Sequenced after the
  slice so the projector is not rewritten while the workflow is still changing shape; a web view
  later is a second projection of the same truth, not a second system.
- **A watcher process for "doubted" orphans** — reads `orphan_sightings`, spots repeat offenders,
  proposes what to do. Explicitly a side story; the journal it would read is already being written.

## Immediate next steps, in order

0. **Both Phase 6 and Phase 7's gate have been reviewed** (`review-phase6/verdicts.md`,
   `review-phase7/verdicts.md`). Between them sol found the same failure shape seven times and not one logic
   error in a rule: **a correct mechanism whose seam was never exercised.** The five rules that came out of it are
   in `runtime/FINDINGS.md` §37.10 and §38.7 — read those before writing the rest of Phase 7's roster, because
   utility agents are all seam.
1. ~~**Get Phase 6 reviewed.**~~ **DONE 2026-09-09** — `opencode --agent sol --variant medium`: 6 blocking,
   4 should-fix, 2 refuted, all accepted, ten fixed, each blocking one reproduced first
   (`review-phase6/verdicts.md`). Read §37.10's four rules before Phase 7's authorization work — three of the
   six blocking findings were mechanisms that had been built, documented and never consulted, and an auth
   system has exactly that shape.
1. **(superseded, kept for the reasoning) Get each phase reviewed.** Every phase that got an independent review found real defects in it, including
   one lethal one in the adoption safety path (§30). Phase 6 decides whether code merges reviewed, so it is
   the worst place to skip that step. The 15 review mutations are the floor, not the ceiling — hand
   `domain/review.js`, `config/review-profiles.js`, `migration 0009` and the supervisor's review surface to
   two models on two harnesses (which is what §13's own `modelDiversity` rule is about).
2. **Phase 7 — the roster.** The gate is DONE and reviewed, so this is unblocked: jira-automation,
   git-create-push and slack-message agents, each a narrow principal whose FIXED toolset already exists as a
   preset in `domain/capabilities.js` and is already enforced. Then `git-create-push`'s full fight loop (§8,
   Rule 2) — real `git` access, stage/commit/hook-failure/classify/autofix/re-run, returning a short structured
   result and never raw tool output to the caller. The per-agent operation journal they need is already written
   for them: `agent_journal` records every allow and refusal, and `journalHasDone()` answers "did I already file
   this ticket".
   **Start by reading §37.10 and §38.7's five rules.** A utility agent is almost entirely seam, and seams are
   where both reviews found everything.
   **One known gap to close in the same stretch:** nothing drives the INSTALLED session hook through the
   authorized socket (mutation **A21** is marked `expectSurvives` for that reason). The hook's fix is in
   production; the regression net is missing.
3. ~~**Unify the state directory before anything ships.**~~ **Already DONE — found already done,
   2026-09-10, this note was stale.** `supervisor/paths.js` is the single resolver: canonical env var is
   `SUPERVISOR_STATE_DIR`, `CTD_STATE_DIR` is kept only as a legacy alias, and `SUPERVISOR_STATE_DIR` wins
   when both are set. `lock/test/state-dir-unified.test.js` asserts exactly this, and
   `runtime/test/daemon-crash.test.js` now sets only `SUPERVISOR_STATE_DIR` (`CTD_STATE_DIR` explicitly
   deleted from its env). Unclear which prior session did this without updating this note — a live example
   of why this file has to be checked against the actual code before being trusted, not just read.
4. **Find out what overwrote this tree on 2026-09-08 at 17:13:40**, or it will happen again. 202 files were
   replaced by an older copy — including `.obsidian/*.json`, which suggests something that treats this
   directory as a unit (a vault sync, or an editor writing a bundle) rather than a code tool. Ruled out: the
   mutation runner, the test suites, git (this tree is untracked), and OpenCode's snapshot repos. Until it is
   identified, `~/ctd-snapshot-*.tar.gz` is the fallback and the suite COUNT is the canary.
5. ~~**Consider `git init` here.**~~ **DONE 2026-09-09** — the tree is its own repo and is pushed
   (`manish96170/custom-team-dashboard`; see the GIT section). A silent overwrite is now a `git diff`
   and `git restore`, which is the durable fix for item 4 rather than a workaround for it. Item 4's
   "git ruled out because the tree is untracked" refers to the state on 2026-09-08 and no longer
   describes this tree.
6. ~~**Build section 20's leases with `git-create-push`, not after it.**~~ **The leases themselves are
   BUILT, 2026-09-10 — see item 10.** `git-create-push` itself (the thing that will actually HOLD
   `git:identity` across its switch->push->restore triple) is still not built; that part of this note
   still stands.
7. **New from reviewing `hydra-acp` (2026-09-10) — three more Phase 7 items**, all in PLAN.md and
   ROADMAP now: (a) **a shared git worktree per TASK, not per session** (§7 — corrected same day from
   a first draft that copied `hydra-acp`'s per-session isolation too literally; a task's coder(s) and
   reviewer(s) are deliberately looking at the same revision, so the default is one worktree per task
   that every assigned worker attaches to, with `requestWorktree(runId, reason)` as an explicit opt-out
   only for isolated testing that shouldn't land in the shared tree — logged to the task's history and
   worth surfacing to agentmemory/claude-mem too); (b) **MCP server pooling** (§21.1) — today every
   session spins its own copy of every configured MCP server, so N sessions duplicate N processes per
   logical server; pool utility agents' servers first, since their toolsets are fixed by construction;
   (c) **a lazy capability router** (§21.2) per utility agent, replacing "every configured server's
   full tool schema in every turn" with the same deferred-tool-search shape this project's own tooling
   already uses. (b) and (c) are optimizations with a working fallback — neither is a new hard
   dependency.
   Also flagged, not yet acted on: whether ACP (Agent Client Protocol) could replace the bespoke
   per-harness adapter model — PLAN.md §9, ROADMAP Phase 11, spike before committing either way.
8. **Implementation started 2026-09-10, in dependency order: schema first.** `migration 0011`
   (`db/migrations/0011_leases_and_mcp_pool.sql`) adds `resource_leases` (one row per active claim, not one row
   per resource — a `counted` lease at capacity > 1 needs multiple concurrent holder rows; `released_at IS
   NULL` = still held, same convention as `runs`/`asks`) and `mcp_pool` (one row per pooled MCP process, unique
   on `(name, config_hash)`). **Deliberately did NOT add new `worktree_path`/`worktree_branch` columns** —
   `tasks.worktree_id` and `tasks.branch` already exist since migration 0001 and are already the live cwd for
   a task's runs (`runtime/supervisor.js` reads `task.worktree_id` directly as `cwd`). PLAN.md §7's "one shared
   worktree per task" lands on those existing columns; adding parallel ones would have been the exact
   two-sources-of-truth mistake this file already calls out for `runs.lifecycle` vs `exit_reason`. Verified:
   `npm test` exit 0, 0 failures, migration tested both from-scratch and upgrading-from-0010.
   **`npm test`'s suite-count metric is not what it used to be, and this is worth fixing rather than trusting
   the old number**: this file has claimed "113 suites" for a while, but raw `PASS:`-line count is 106 (was
   before this change too — one file was added, 49→50 test files, 106 unaffected) because several files print
   one `PASS:` per internal case group, not one per file. Neither number is wrong exactly, they're just not
   counting the same thing "113" used to claim. Next session: pin down what actually produces "113" before
   citing it again, or stop citing it and use file count + exit code instead.
9. **The shared per-task worktree lifecycle is BUILT, 2026-09-10** — `createTaskWorktree(taskId, {
   repoPath, branch })`, `discardTaskWorktree(taskId)`, `requestWorktree(runId, { reason })`
   (`runtime/supervisor.js`, near `mergeTask`), all gated by one new capability `task:worktree`
   (`domain/capabilities.js`, granted to `worker`/`reviewer`/`cto`). Read the capability's own comment
   before touching it: it deliberately covers all three actions rather than splitting create/discard from
   request, so a worker can technically also discard the shared worktree — `discardTaskWorktree`'s
   non-terminal refusal is the actual backstop, not the capability split. **`merge` is NOT a supervisor
   command** — `mergeTask()` already says it doesn't touch git; that's `git-create-push`'s job, operating
   inside the shared worktree after `mergeTask`'s approval-gated transition. `sync` is specified, not
   built. **One collision worth knowing before touching branch-naming**: an overlay branch cannot be named
   as a child ref of the task branch (`ctd/<taskId>/overlay-<runId>` collided with `ctd/<taskId>` — git
   refs are a filesystem-like hierarchy and a ref can't be both a leaf and a path segment); the fix was a
   separate top-level namespace, `ctd-overlay/<taskId>/<runId>`. Test: `runtime/test/worktree.test.js`, 6
   cases, real `git worktree add`/`remove` in a throwaway repo — no mocked git.
   Consequence, and the correct one: `domain/test/capabilities.test.js`'s allow-listed-domains case needed
   `"task"` added for `worker`/`reviewer` — updated, not worked around.
   `npm test`: exit 0, **107 suites** (106 + this one file).
   **CORRECTED 2026-09-11 — the "non-terminal refusal is the actual backstop" claim above was wrong.**
   Both codex reviews (`codexdoc/REVIEW-NOTES.md`/`review-phase7-uncommitted.md` finding 4/3) found task
   state and run termination are separate (`mergeTask`/cancel/fail record state without stopping any run
   still using the tree), so a terminal task could still have a live open run when discard force-deleted its
   dirty tree. **Fixed the same day**: `discardTaskWorktree` now also refuses when any run joined via
   `workers.task_id` has `ended_at IS NULL`. Proven against pre-fix code (`runtime/test/worktree.test.js`
   case 7). Deferred: `createTaskWorktree` still has no cross-process claim; a worker-backed principal's
   lease/overlay still isn't bound to its own run identity.
10. **`acquireLease`/`releaseLease`/`renewLease` are BUILT, 2026-09-10** (`runtime/supervisor.js`,
    `db/index.js`'s `tryAcquireLease`/`releaseLeaseRow`/`renewLeaseRow`/`sweepExpiredLeases`, migration
    0012 for `resource_leases.release_reason`, `config/resources.js` for `resources.json` — same
    on-demand-read/malformed-throws contract as `harness-defaults.js`). `git:identity` (exclusive) and
    `host:heavy-job` (counted, capacity 1, 15% memory headroom) ship as built-ins.
    **`host:heavy-job`'s memory-pressure check (§20.3) is now built too** — `os.freemem()`/`os.totalmem()`
    sampled on every acquire, refusing below the configured headroom, sampled numbers surfaced on BOTH
    grant and refusal. Not built: periodic re-sampling of an already-held lease, and auto-raising an
    `ask` on refusal (§20.3's other half) — a caller has to do that itself today.
    **§20.2's "queue is FIFO and visible" line in PLAN.md was corrected, not built as specified**: this is
    a multi-process daemon with nothing to hold a caller's connection on, so a refusal is a non-blocking
    check naming every current holder (`blockedBy`) rather than a real queue with a position — decided
    deliberately, because a `counted` resource is a semaphore, not a mutex queue, and "3rd in line" isn't
    well-defined for one.
    **Proven CONCURRENTLY across real OS processes, not just sequentially** (`db/test/leases.test.js`):
    8 processes race an exclusive lease (exactly 1 granted) and a capacity-3 counted one (exactly 3
    granted), using `BEGIN IMMEDIATE` — the exact mechanism `db/migrate.js` already uses for its own
    schema-version race, because a plain `db.transaction()` only escalates to a write lock at the FIRST
    WRITE, too late for a check-then-insert.
    **One flake caught by following this file's own "re-run before believing green" rule**:
    `runtime/test/leases.test.js`'s "healthy host" case originally asserted against REAL ambient free
    memory, which dropped under 15% on a re-run from something unrelated running on the machine — fixed
    by mocking `os.freemem`/`os.totalmem` in both directions instead of trusting the real host to be
    "healthy." Re-verified clean across 3 consecutive full-suite runs after the fix.
    `npm test`: exit 0, **110 suites**, re-verified 3x.
    **Gap closed same day, after this item shipped**: `releaseLeasesForRun` (`db/index.js`) existed but was
    built and never called from anywhere — a run ending (however it ended) left its leases held until the
    sweep's TTL caught up, not immediately. Wired directly into `endRun` (`db/index.js`), gated on
    `info.changes === 1` so it only fires for the call that actually closed the row — a second, rejected
    `endRun` on an already-closed run must not re-release leases the first call already handled. New case 9
    in `db/test/leases.test.js` proves it, including that a rejected second `endRun` is a safe no-op.
    `npm test` re-verified after this: exit 0, 110 suites unchanged, 0 failures.
11. **`git-create-push` (PLAN.md §8 Rule 2, §16's roster) is BUILT, 2026-09-10** — the first thing to
    actually consume both item 9 (the worktree) and item 10 (the lease). `agents/git-create-push.js` is
    the pure fight loop (no database, no supervisor — testable against a real throwaway repo alone):
    stage -> commit -> on hook failure, classify into one of §8 Rule 2's 8 classes by pattern-matching
    real tool output (heuristic, documented as one in the code, not hidden behind confident-looking
    logic) -> auto-fix ONLY `format`/`lint-autofixable`, and only if the target repo provides an
    executable `.git-create-push-autofix.sh` at its root — no script means honestly `unresolved`, never
    a silent no-op claiming success -> re-commit, bounded at 3 total attempts -> push. Returns exactly
    `{status: 'pushed'|'blocked'|'failed', attempts, unresolved?}`, never raw tool output.
    **Two wire commands share the one loop, and the split IS the authorization decision**: `gitPush`
    (`git:push`) and `gitPushProtected` (`git:push-protected`, SENSITIVE — needs a second principal's
    approval bound to the exact args, same mechanism `mergeTask`/`task:merge` already uses). There is no
    `protected: true` argument anywhere in the fight loop itself — which command you call is what
    determines whether a second signature was required, so a caller cannot self-declare "this one's not
    protected" the way the existing "nothing the decision reads from the request" rule already forbids.
    **`git:identity` is acquired before anything else and released in a `finally`, no matter how the
    loop ends** — proven two ways: a REAL separate OS process holding the lease (reusing
    `db/test/_lease-race-child.js`) genuinely blocks a `gitCreatePush` call made from a different
    process, and a forced mid-loop throw (a task whose `worktree_id` points at a nonexistent directory)
    still releases it rather than leaving it held until the TTL sweep.
    **`gh pr create`/`mrUrl` is real code (`openPullRequest`) but deliberately NOT exercised by
    `npm test`** — real credentials and network, the same class of thing `real-claude-adoption.slice.mjs`
    etc. already keep out of the automated suite. `runtime/test/real-git-create-push.slice.mjs` is the
    manual counterpart; it needs `CTD_REAL_GIT_SANDBOX_REPO` pointed at a real disposable repo and skips
    cleanly (exit 0, no assertions run) when that isn't set, rather than failing CI-style runs that don't
    have it.
    15 new cases across two files (`agents/test/git-create-push.test.js`,
    `runtime/test/git-create-push.test.js`), `npm test`: exit 0, **112 suites**, re-verified 3x (full
    suite) plus 3 standalone runs of the new integration test specifically, given its real-child-process
    case.
12. **`leo-mcp` (new standalone sibling repo, `../leo-mcp/`) built 2026-09-11 — read PLAN.md §16.1 before
    touching the roster further.** Triggered by checking what already existed before building
    jira-automation/slack-message here: the `git-create-push`/`jira-automation` Claude Code skills are
    real, mature, and CONVERSATIONAL (they ask a human everything, then execute) — not something an MCP
    tool call can replace — and `team-slack-bridge` had, by 2026-09-10, grown a full 21-tool MCP server
    this document hadn't caught up to. So instead of bespoke Jira/Slack agents in THIS repo:
    - `leo-mcp/git/fight-loop.js` — a **deliberate, tracked, standalone duplicate** of item 11's fight
      loop, ported so `leo-mcp` works without this dashboard's SQLite/lease system. Both files' headers
      point at each other; if you fix a bug in one, fix it in the other or it will silently drift — there
      is no automated check for that today.
    - `leo-mcp/mcp/tools.js` **mounts `team-slack-bridge/mcp/tools.local.js`'s real 21 tools directly**
      (a `file:` dependency, re-registered under leo-mcp's own `tools/list`) — nothing reimplemented.
    - `leo-mcp/jira/tools.js`'s `jira_create_ticket` is a **deliberate stub** — the custom-field IDs it
      would need came from a skill file's prose, never verified against a live Jira schema, and a wrong
      one silently corrupts a real ticket rather than failing loudly. Refuses to write anything until a
      human checks the field map against `getJiraIssueTypeMetaWithFields` and signs off.
    Verified end-to-end over the real MCP JSON-RPC protocol (not just the unit test): `initialize`,
    `tools/list`, a real `git_push` landing a commit on a real bare remote, a missing-required-arg
    rejection, and the Jira stub's honest refusal. `npm test` in `leo-mcp/` (the ported fight-loop
    suite): exit 0, all 6 cases pass.
    **Expanded and pushed, 2026-09-11**: 4 more Jira stub tools added (`jira_transition`,
    `jira_add_resolution_notes`, `jira_add_acceptance_criteria`, `jira_log_worklog` — 26 tools total
    now), and **every Jira field/project/transition ID moved out of source into `.env`** (git-ignored;
    `.env.example` documents the vars, `env.js` mirrors team-slack-bridge's own zero-dependency reader)
    — `jira/tools.js` no longer has any organization-specific literal in it, checked by grepping the
    whole tree before committing. `leo-mcp` is now its own git repo and pushed to
    **`manish96170/leo-mcp`, PRIVATE**, confirmed via `gh repo view` and by listing the pushed tree
    (`node_modules` and `.env` correctly absent). This supersedes the previous note about it being
    uncommitted — that was true only until the owner explicitly asked for it to be pushed.
    **Next up**: the rest of §16's roster (jira-automation, slack-message) or §21's MCP pooling/lazy
    capability router — neither depends on the other, pick either first.
13. **PLAN.md §16.2, "the utility-task lane" — BUILT 2026-09-11.** Four narrow `type: "adhoc"`-shaped
    task types, each wanting exactly one worker in a role with its own cheap-model default and its own
    fixed UTILITY capability preset (not the generic worker one):

    | Task type | Role | `harness-defaults.json` | Capability preset |
    |---|---|---|---|
    | `git-push-task` | `git-push-runner` | haiku/low | `utility:git` (has `git:push`/`git:push-protected`/`resource:lease`) |
    | `jira-task` | `jira-runner` | haiku/low | `utility:jira` (has `jira:create`) |
    | `awsquery-task` | `awsquery-runner` | haiku/low | `utility:awsquery` (`read:registry` ONLY — new preset, added for this; a pure read query has no dashboard side effect to gate) |
    | `slack-task` | `slack-runner` | haiku/low | `utility:slack` (has `slack:post-bot`) |

    `domain/workflow-profiles.js` — 4 new profiles, one role each (a SEPARATE profile per role rather than
    one `adhoc` profile with an overridable role name, because task TYPE already drives role resolution
    everywhere else in this file — a second, parallel override mechanism would repeat the exact "two ways
    to reach one decision" shape this project avoids). `config/harness-defaults.js` — 4 new
    `BUILT_IN_DEFAULTS` entries. `domain/capabilities.js` — the new `utility:awsquery` preset.
    `runtime/supervisor.js`'s `ensureWorkerPrincipal` — a role->preset lookup for these four roles, minting
    `kind: "utility"` (not `"worker"`) for them, matching migration 0010's own description of that kind
    ("a narrow single-purpose agent") even though they're dispatched through the same run/task machinery
    as a coder or reviewer.
    **The one hard rule this section keeps**: ambiguity always becomes an `ask` (§7, already built), never
    a guess — a utility-task role has no judgment to spend guessing with, by design. This is a session
    behavior (the runner's own instructions), not new dashboard mechanism — nothing to test here beyond
    what §7's `asks` tests already cover.
    **`runtime/test/utility-task-lane.test.js`** (new, 4 cases): each task type resolves to exactly its
    own role; each role has its own cheap/low default; each role's minted principal is `kind: "utility"`
    with EXACTLY its own toolset — including a NEGATIVE check that it does NOT also hold any OTHER role's
    capabilities (the actual point of a fixed-toolset preset over a generic one); the real coverage check
    (`assertCoversCommands` against the real `supervisor.commandHandlers()`, not a tautological
    self-check) still passes. `npm test`: exit 0, **113 suites**, re-verified 3x total (once at 112->113,
    twice more full-suite after).
    **Not built, deliberately out of scope for this pass**: the actual DISPATCH convenience (a one-line
    "run a git-push-task for me" helper) and the runner's own prompt/instructions text — this pass wires
    the role/capability/model machinery so dispatch is just `createTask({ type: "git-push-task", ... })`
    + `assignTask()`, the same two calls as any other task type, not a new code path.
14. **Three TUI design corrections, added 2026-09-11 — DESIGN ONLY, nothing built** (the Requests panel
    and its buttons are still 100% backlog, per item... see `layout.js`'s own comment on the panel's hit
    target). PLAN.md §14.4 / FLOWS.md §6a-6c: Requests panel default height raised to ~30% (was ~12%,
    too small for real message text), a dedicated show/hide toggle independent of pending count, and a
    long request now expands to a FULL-WIDTH detail view (pane area + tree hidden entirely, not
    fullscreened — different operation from `f`) with Accept/Decline in place, restoring the layout
    exactly on `esc`/decision. PLAN.md §5 / FLOWS.md §5: the same show/hide toggle added for the TREE
    panel itself (confirmed with the owner — "right area" meant the existing left tree, not a new
    multi-user panel; no such feature exists or is planned). None of this touches code — it corrects the
    design before Slack inbound (which is what would eventually make the Requests panel real) gets built
    against the wrong shape.
15. **PLAN.md §21 (MCP server pooling + lazy capability router) — BOTH BUILT, 2026-09-11.**
    `runtime/mcp-pool.js` + migration 0013 (`mcp_pool.status`/`.pgid`, new `mcp_pool_attachments` table
    — refcount now DERIVED from attachment rows, not migration 0011's original bare integer, per
    `codexdoc/REVIEW-NOTES.md`'s explicit warning). One resident process per `(name, config_hash)`,
    resurrected (same row) on the next attach after a full drain rather than a new row (the unique index
    would have refused that anyway). **The last-detach-vs-new-attach race that review section calls out
    is closed by construction**: `attachToPool` only ever joins `starting`/`ready`, never `draining`,
    and `detachAndMaybeDrain` flips to `draining` atomically inside the same transaction as its "any
    attachments left" count. Proved 4 ways: a deterministic interleaving test, a real 8-process race of
    the DB primitives, a 6-worker concurrent-async race of the FULL manager with real spawn/kill in one
    process, and boot reconciliation killing a real orphaned-but-alive process from a "previous boot."
    **One real bug caught by the test itself, mid-build**: `killProcessGroup` confirms a kill via a
    zombie-aware check (`isProcessGroupLive`), but the FIRST version of this test asserted "really dead"
    with the plain `isPidAlive` — which this project's own `procinfo.js` docstring already says is
    insufficient (`process.kill(pid,0)` succeeds on a zombie). That produced a genuine intermittent flake
    until the test was fixed to use the same zombie-aware check `killProcessGroup` itself relies on —
    worth remembering next time a "process must be dead" assertion looks flaky.
    `leo-mcp` (§16.1) is the first real pooled config.
    **§21.2's scope was corrected by investigation, not assumed**: checked whether a harness-level
    "defer tool schemas" mechanism exists for a spawned worker session before designing anything — it
    does NOT (`adapters/claude-code/worker-env.js` shows `spec.mcpConfig` + `--strict-mcp-config` is the
    only lever this codebase has; no per-turn ask-for-it-by-name deferral is available). Built what IS
    buildable given that ceiling: `domain/mcp-manifest.js`'s `manifestForRole` (pure, 4 cases) computes
    the MINIMAL `spec.mcpConfig` set a role needs by declared pool name.
    `npm test`: exit 0, **115 suites**, re-verified 3x, confirmed zero leaked OS processes after each run.
17. **Wired `manifestForRole`/`mcp-pool.js` into a REAL `start()`/`endRun` path, 2026-09-11 — closes
    item 15's "not wired" gap.** `runtime/supervisor.js`'s `start()` now: looks up the worker's role,
    and for a utility-task role with a declared MCP need (`ROLE_MCP_NEEDS`), attaches to each pool
    (new `config/mcp-pools.js` — same on-demand-read/malformed-throws pattern as `resources.js`;
    `leo-mcp` is the built-in, resolved to the real sibling repo) BEFORE the adapter spawns [†see item
    22 — this originally also built `spec.mcpConfig` from the result; that part was corrected out the
    same day], then backfills the attachment's `run_id` once `createRun()` has
    actually committed (attaching has to happen before `adapter.start()` returns a runId; backfilling
    has to wait until AFTER `createRun()`, or the UPDATE would itself violate
    `mcp_pool_attachments.run_id`'s real foreign key to `runs.run_id` — found and fixed via a real
    "Too few parameter values were provided" SQL error while writing the very first test, a plain
    forgotten-bind-parameter bug in `listOpenAttachmentsForRun`, not a design flaw). Detaches on
    `endRun`/`releaseSession` (fire-and-forget, logged, never blocking the run's own terminal write —
    same posture leases already have) and on boot reconciliation's `lost` path.
    **New tests** (`runtime/test/mcp-pool-wiring.test.js`, skips cleanly if the `leo-mcp`
    sibling repo isn't present on a given checkout): a git-push-runner's real start backed by a real
    `mcp_pool`/`mcp_pool_attachments` row; ending the run detaches it; a
    coder run's spec is completely untouched; two CONCURRENT git-push-runner starts share exactly ONE
    pool row with two attachments (real concurrency via `Promise.all`, not sequential calls); a run
    with no recorded process identity (same "lost" trigger `reconcile.test.js`'s own case 5 uses — no
    real spawn-then-kill needed, since a full crash-of-the-daemon scenario can't be forced from within
    one test process the way a real separate-OS-process crash test can) gets its attachment detached by
    `supervisor.boot()`'s reconciliation; a 6th case (added in item 22's fix pass) covers an
    `adapter.start()` throw.
    **STALE AS ORIGINALLY WRITTEN — corrected by item 22**: this note used to say "the spec correctly
    naming the pool" was real, alongside the honest limitation about no genuinely shared connection. In
    between, `spec.mcpConfig` briefly carried a marker object handed to the real adapter — which was not
    a limitation, it was a live bug (a non-string value in a real `spawn()`'s argv). `start()` no longer
    sets `spec.mcpConfig` at all; see item 22, finding 2, for the corrected, accurate state.
    `npm test`: exit 0, **116 suites** at the time, re-verified 3x, confirmed zero leaked OS processes each time.
16. **The two independent codex (gpt-6-astra) reviews and the resulting fix pass, 2026-09-11 — never got
    a numbered item until now; a real doc-staleness gap flagged by item 15's own fork.** Both reviews
    landed in `codexdoc/` (`review-phase7-uncommitted.md`, `ARCHITECTURE.md`, `REVIEW-NOTES.md`) and
    independently found the same blocking bug (lease renewal resurrecting an expired lease), plus 4 more
    blocking bugs between them and a dozen should-fix/minor findings. **All 5 blocking bugs are FIXED**:
    lease renewal now requires `ttl_expires_at >= now` atomically with the update; `gitPush` classifies
    the real destination server-side (`config/protected-branches.js` + `resolvePushDestination`) so a
    caller can no longer bypass `gitPushProtected`'s second signature by choosing the cheap command;
    `recordVerdict` now binds a verdict to the AUTHENTICATED principal's `workerId`, closing a
    one-token-two-identities quorum-manufacture exploit; `discardTaskWorktree` refuses on a terminal task
    with an open run rather than force-deleting a live worktree; `git-create-push`'s fight loop gained an
    optional `paths` param so a caller CAN stage exact files instead of `-A` (default unchanged — this
    is a tool, not a forced fix, and is documented as such, not oversold). **Also fixed**: the
    `isActionable` gate that made item 13's whole utility-task lane unreachable (was hardcoded to
    `coder`/`parentReviewer` only — now driven by each workflow profile's own `workRoles` field, so a
    sixth role never needs this file edited again), plus 3 closely-related lease/`endRun` items
    (`tryAcquireLease` now refuses an already-ended `holderRunId`; `endRun` and `reconcileRun` now
    release a run's leases in the SAME transaction as their terminal write, not two separate commits that
    a crash could split).
    **Explicitly deferred, documented in `codexdoc/`, not silently dropped** (two of these — cross-run
    ownership binding and the `createTaskWorktree` race — were closed in item 18 below; not re-listed
    here): invalid/negative TTL validation; ask self-answering and attribution; `tuiSnapshot` leaking raw
    transcripts to a registry-only principal; the standalone pane failing against real authorization (no
    token injected); a push failure not being retryable after a successful commit; the git fight loop
    running synchronously on the daemon's event loop thread; the TUI selecting the wrong historical run
    for a restarted worker; the ask/task lifecycle not being wired together (`autoBlockTarget` has no
    runtime caller).
    `npm test` re-verified independently (not just trusted from the fix pass's own report) at each stage:
    113 suites after the fix pass, 115 after item 15's build on top of it, exit 0 both times.
18. **The two findings item 16 deferred as "bigger than this pass" — closed 2026-09-11.**
    - **Cross-run ownership binding** (`codexdoc/review-phase7-uncommitted.md` finding 4). `acquireLease`
      and `requestWorktree` (`runtime/supervisor.js`) now refuse when a WORKER-backed principal supplies
      a `runId` that resolves to a DIFFERENT worker (`db/index.js`'s new `workerIdForRun`) — same
      "identity is a registry fact, not a request field" boundary already applied to `recordVerdict`.
      Owner/CTO principals (no `workerId`) remain unrestricted; that delegation question is still not
      decided. Regression: `runtime/test/leases.test.js` case 8, `runtime/test/worktree.test.js` case 8 —
      both verified to fail against the pre-fix code (impersonation succeeded).
    - **`createTaskWorktree`'s cross-process creation race** (finding 2, blocking). `db/index.js` gained
      a compare-and-swap claim (`claimTaskWorktreeSlot`/`finalizeTaskWorktreeSlot`/
      `releaseTaskWorktreeClaim`, a `WORKTREE_CLAIM_PENDING` marker inside `BEGIN IMMEDIATE`) that
      `createTaskWorktree` now takes BEFORE running any git command — same "reserve with a status
      marker, only the winner does real work" pattern already proven for `mcp-pool.js`'s
      `claimPoolSlot`. A caller that loses the claim polls (bounded, ~2s) for the winner's result.
      **Worth remembering**: the first, integration-shaped regression test (6 real processes calling the
      full `createTaskWorktree`) passed 3-for-3 against the UNFIXED code too — local git is fast enough
      that natural OS scheduling rarely produces the actual overlap. Matches this project's own
      recurring lesson ("a test that only sometimes exercises its mechanism has not proven it" —
      FINDINGS.md, hit at least three times before this). Fixed by adding a SECOND, deterministic test
      (`runtime/test/worktree.test.js` case 10) using two barriers — one after the read, one before the
      claim attempt — to FORCE every child to observe the same stale value, matching the review's own
      reproduction technique exactly. Case 10 was verified to fail when the CAS condition was
      deliberately broken (8/8 "won" instead of 1/8); case 9 is kept as a real-world integration check
      despite not being the thing that actually proves the fix.
    Both findings' `codexdoc/` entries flipped to "Fixed 2026-09-11" with what changed and where — their
    own finding text is untouched.
    `npm test`: exit 0, **116 suites** (unchanged — these landed as new cases in existing test files, not
    new files), re-verified 3x total, zero leaked OS processes.
19. **The Requests-panel/TREE-panel design corrections BUILT, plus 2 more `codexdoc/` findings fixed —
    2026-09-11, done concurrently with item 18 (deliberately scoped to `tui/`/`pane/` only, no overlap).**
    - **PLAN.md §14.4/§5's UI mechanics** — default height ~30%, `R` toggles the Requests panel from
      anywhere regardless of pending count, `t` toggles the TREE panel the same way (pane area
      reclaims the freed width either way, selection state untouched), and a request too long to fit
      inline expands to a full-width Request Detail view (`tui/state.js`'s new `FOCUS.REQUEST_DETAIL`)
      that replaces the tree + pane area — `[a] Accept`/`[d] Decline`/`esc`, closing it restores the
      layout exactly because entering/leaving only ever touches `focus`. **Still backlog, unchanged**:
      the buttons themselves and everything server-side — Accept/Decline hand off to `app.js` as
      `pendingRequestDecision` (same split `pendingChat` uses) and land on a status-line no-op, honestly,
      since there's still no wire command to turn a request into a task. 3 new pure cases
      (`tui/test/tui.test.js` 20-22), 5 new captured scenes (`tui/evidence/01-demo-frames.txt`,
      regenerated via `tui/capture-frames.mjs`), `TUI-GUIDE.md` steps 16-20.
    - **Fixed finding 10** (`codexdoc/REVIEW-NOTES.md`) — standalone `attachPane`/`pane/cli.js --list`
      sent no principal token, refused by the real gate with "no token sent." `ipc/client.js`'s
      `connect()` now carries an optional `token` on every request; `pane/pane.js` reads
      `stateDir/owner.token` by default, the SAME mechanism `tui/cli.js`'s own client already used
      (not a second one). New `pane/test/pane-auth.test.js` (3 cases) against the REAL
      `authorizedCommandHandlers()` gate, not the raw map the existing pane-e2e test uses — which is
      exactly how the original bug went unnoticed.
    - **Fixed finding 15's run-SELECTION half, NOT its labelling half (at the time)** — `tui/app.js`'s
      `forWorker` used to be a bare `rows.find(...)`, always returning whichever run for a worker came
      first in snapshot order, so a restarted worker's OLD ended run kept showing over its live
      replacement. Now prefers live (`endedAt` null) regardless of array position, and among ended-only
      runs the newest by `lastEventAt`. New case 9 in `runtime/test/tui-replay.test.js`, reproducing the
      review's exact fixture shape plus the ended-only tiebreak. The labelling half was checked and left
      honestly open in this pass — **see item 20, closed the same day.**
    `npm test`: exit 0, **117 suites**, re-verified 3x (each also checked for zero leaked OS processes
    from the new `capture-frames.mjs` scenes and the real-socket pane-auth test).
20. **Finding 15's labelling half — the one item 19 explicitly left open — closed 2026-09-11.**
    `buildPanes` (`tui/app.js`) used to set `status: "crashed"` for ANY ended run regardless of
    `exitReason`, so a run that finished cleanly was still internally classified as a crash (the
    on-screen text was already softer than the field name — `renderPaneBody` always showed the real
    reason — but the status name itself asserted a failure the reason might contradict). Renamed to the
    neutral `"ended"` in both `tui/app.js` and `tui/layout.js`'s matching render branch (also swapped
    the `✖` marker for a neutral `■`, same reasoning). `tui/test/tui.test.js` now covers a deliberate
    `reaped` exit and a genuine `errored` one under the identical neutral status, with an explicit
    `assert.doesNotMatch(..., /crashed/i)`; `runtime/test/tui-replay.test.js` case 9 gained an assertion
    that a normally-`finished` run's pane status is `"ended"`. `npm test`: exit 0, **117 suites**
    (unchanged — a fix, not a new file), 0 failures.
21. **Finding 11 — a push failure could not be retried after a successful commit — fixed 2026-09-11,
    scoped to `supervisor/agents/git-create-push.js` only.** `runFightLoop`'s "nothing staged" case used
    to always mean "nothing to do," but it's also exactly what a RETRY looks like right after a commit
    succeeded and the push failed — the commit already happened, so re-staging finds nothing new, and
    the old code reported a false "nothing to commit" while a real, unpushed commit sat stuck on disk.
    Now checks the REMOTE directly (`git ls-remote`, never a possibly-stale local remote-tracking
    branch) for whether local HEAD already matches its tip; if not (ahead — this bug's exact case,
    remote branch missing entirely, behind, or diverged), skips the false "nothing to commit" and
    pushes the existing commit directly, letting a genuine divergence surface as `git push`'s own real,
    honest refusal rather than either a fabricated failure or a silent force-push. New cases 9-12 in
    `agents/test/git-create-push.test.js` (12 total in the file now, all passing): the exact
    commit-succeeds-push-fails-then-retry reproduction with no duplicate commit on retry, a first-push-
    ever-with-nothing-new-to-stage case, a local-behind-the-remote case confirmed NOT to force-push, and
    confirmation the genuinely-nothing-to-do case is byte-for-byte unchanged. **Honest scope limit**: no
    durable commit/push/PR operation-identity record was added — this makes the fight loop correctly
    RE-DERIVE the right next action from git's own state on a fresh call, which covers this finding's
    exact reproduction, but does not reconcile a genuinely ambiguous outcome (e.g. a push the network
    dropped after the remote already accepted it) — that needs the bigger persisted-operation design the
    finding's own text sketches, not built here. `npm test`: exit 0, **117 suites** (unchanged — a fix,
    not a new file), 0 failures, re-verified 3x.
22. **Codex quota is now blocked until Sep 15 (a 4-day wait, not the earlier same-day reset) — this
    pass's review used `opencode`'s `luna` agent (Bedrock `gpt-5.6-luna`) instead, per the owner's
    direction, with codex to resume once quota resets.** `codexdoc/review-luna-2026-09-11.md` (9
    findings — 5 blocking, 4 should-fix) is the resulting record. **5 of the 9 fixed same day** (the
    other 4 — worktree claim binding to repo/branch, the crashed-claim deadlock, discard-vs-start racing
    assignment, and forced discard destroying clean uncommitted work — are a different agent's concurrent
    scope, not covered by this item; check `codexdoc/review-luna-2026-09-11.md` directly for their
    current status rather than assuming):
    - **Finding 1 (blocking)** — `hashPoolConfig` hashed only top-level key NAMES (a `JSON.stringify`
      replacer-array quirk that silently drops any nested value, most importantly `env` credentials), so
      two pool configs differing only in a credential hashed IDENTICALLY — confirmed independently before
      delegating the fix (`e15b0f9f44381656` for both). Now a real recursive canonical stringifier.
      `runtime/test/mcp-pool.test.js` case 7.
    - **Finding 2 (blocking)** — the utility-task-lane wiring (item 17) had, in the meantime, started
      putting the pool-attachment marker onto `spec.mcpConfig` and handing it to the REAL adapter — worse
      than "not yet shared" as item 17 described it: `adapters/claude-code/adapter.js`'s own `StartSpec`
      typedef declares `mcpConfig` as a real config file path (`string | string[]`), so a marker object
      would push a non-string into a real `spawn()`'s argv the first time this ran through the actual
      Claude Code adapter (OpenCode's adapter would have thrown outright on any `mcpConfig` at all).
      Neither existing test caught it — both use the fake harness, which never validates argv shape.
      `start()` no longer sets `spec.mcpConfig` at all for a utility-task role; the attach/detach
      lifecycle stays real and tested. `config/mcp-pools.js`/`domain/mcp-manifest.js`'s header comments
      corrected to stop describing a `configPathFor` lever that was never built. **Item 17's own "one
      honest limitation" note was itself too soft — corrected in PLAN.md §21.1/ROADMAP alongside this
      fix.**
    - **Finding 3 (blocking)** — a dead pooled process's exit handler (and boot reconciliation) marked
      the pool row `failed` but left its attachment row live forever, so a resurrected replacement's OWN
      `detach()` could never trigger teardown (`shouldTeardown` stuck false) — a permanent process leak.
      `markPoolFailed` now closes every live attachment atomically with the failure write, at all 3 call
      sites. `runtime/test/mcp-pool.test.js` case 8 — a REAL child killed outside `detach()`, confirmed
      the replacement's own teardown then works correctly.
    - **Finding 4 (should-fix)** — `start()` had NO try/catch at all around `adapter.start(spec)`; a
      throw there leaked whatever MCP attachments were made just before it, with no runId for anything to
      ever find them by. Now wrapped, detaching on any throw before a runId exists.
      `runtime/test/mcp-pool-wiring.test.js` case 6 (fake harness configured to throw on `start`).
    - **Finding 5 (should-fix)** — invalid lease TTLs (negative, zero, unbounded) still returned
      `granted: true`/`renewed: true` for a lease already expired the instant it existed — a gap an
      EARLIER pass (item 16) had already flagged as deferred and PLAN.md §20.1 explicitly said was "still
      NOT fixed." New `MAX_LEASE_TTL_MS` (30 min) + a shared `validateTtlMs`, enforced in BOTH
      `tryAcquireLease`/`renewLeaseRow` (throws) AND the wire handlers (clean `{ok:false}`, not an
      exception, for ordinary traffic) — defense in depth per the finding's own ask. `tryAcquireLease`'s
      expiry is now computed INSIDE its `BEGIN IMMEDIATE` transaction, not before it, closing a lock-wait
      timing gap the same finding named. `runtime/test/leases.test.js` case 9.
    All 5 verified to fail against the pre-fix code before restoring the fix. `npm test`: exit 0,
    **117 suites** (unchanged — all fixes, no new test files), 0 failures, re-verified 3x, `ps`
    process count checked stable after each real-process test.
    **One flake caught here, but the first fix for it was INCOMPLETE — corrected same day, see item 23.**
    Finding 4's new case (`mcp-pool-wiring.test.js` case 6) initially crashed the WHOLE node process
    under full-suite load with `TypeError: The database connection is not open`. The first attempt fixed
    it by making case 6 itself wait longer before teardown — that made case 6 stop crashing, but the
    real defect was in `runtime/mcp-pool.js`'s spawned-child `'exit'` handler itself (unguarded, callable
    at any time after the DB is closed), and it crashed the WHOLE PROCESS again a few runs later from a
    DIFFERENT test (`mcp-pool-wiring.test.js` case 5) that happened to trigger the same race. See item 23
    for the actual fix.

23. **The flake item 22 thought it had fixed came back in a different test — fixed at the root cause
    this time, 2026-09-11, during final session verification.** `runtime/mcp-pool.js`'s spawned child's
    `once("exit", ...)` handler called `markPoolFailed(db, poolId)` with NO try/catch, and it fires
    asynchronously, on Node's own schedule — including after a test's `finally` has already closed `db`.
    An uncaught throw inside an `EventEmitter` callback with no listener is FATAL to the whole process,
    which is exactly what item 22's "fixed" case 6 flake was, and it was never actually closed — only
    case 6 itself was hardened to wait longer, so the SAME unguarded handler crashed the suite again from
    a different test (case 5, "a lost run's attachment is detached by boot reconciliation") the very next
    time this file's own "re-run before believing green" rule was followed. Root-caused this time: wrapped
    `markPoolFailed`'s call inside the exit handler in try/catch, logging (not throwing) if the db is
    already closed — the same "best-effort, never throw from a fire-and-forget lifecycle hook" convention
    this file already uses for the `killProcessGroup` catches right next to it. No test change needed;
    this is a defect in the PRODUCTION code path, not the test. Re-verified: 3 consecutive full-suite runs
    clean after this fix (**117 suites, exit 0, 0 failures each time**) — including the exact run that
    caught the original crash. **Lesson for next time**: when a flake "fix" only changes the TEST's
    timing/waits rather than the production code path that actually threw, re-run enough times to prove
    the underlying race is gone, not just that this one test stopped hitting it.

24. **The 4 findings item 22 deliberately left open — worktree-claim area, all fixed 2026-09-11 in one
    sequential pass.** `codexdoc/review-luna-2026-09-11.md` findings 5-8, all in `createTaskWorktree`/
    `discardTaskWorktree` (`runtime/supervisor.js`) and their claim helpers (`db/index.js`):
    - **Finding 5 (blocking)** — the CAS marker prevented two callers from running git simultaneously,
      but an existing result was returned by checking only that its path existed, never that the
      caller's `repoPath`/`branch` matched what was actually claimed — a conflicting caller silently got
      back `{ created: false }` for a DIFFERENT repo's worktree. Migration 0014 adds
      `tasks.worktree_repo_path`, set at CLAIM time (not just finalize) by `claimTaskWorktreeSlot` — so
      the mismatch check applies to a still-pending claim too, the exact "losing side of the pending-claim
      poll has the same problem" half the finding calls out separately. `createTaskWorktree` now refuses
      with `worktree-repo-mismatch`/`worktree-branch-mismatch` on every path through the function.
    - **Finding 6 (blocking)** — `WORKTREE_CLAIM_PENDING` had no owner, timestamp, or recovery path: a
      creator that crashed between claiming and finalizing left every later caller polling
      `worktree-claim-pending` forever — a process crash had become a permanent availability deadlock,
      not just a race. New `reclaimStaleTaskWorktreeClaim` (`db/index.js`) atomically reopens a claim once
      it has sat unfinalized past 60s (well above a real `git worktree add`'s own 30s timeout, so this
      only fires for "probably crashed," not "still working"). The reclaimer then checks
      `.git/ctd-worktrees/<taskId>` on disk: if the dead claimant's git call already landed, ADOPT it; if
      not, redo it. Finding 5's repo/branch identity is checked before ever reaching this branch, so a
      reclaim can't adopt/redo under a mismatched repo.
    - **Finding 7 (blocking)** — `discardTaskWorktree`'s open-run check observes a point in time;
      `assignTask()` could start a brand-new run for the same terminal task with no coordination against
      it, so a start landing between discard's check and its `git worktree remove --force` could be
      deleted out from under a live worker. Fixed the practical half the finding's own text names as
      sufficient (its second sentence): `assignTask()` now refuses outright on any `isTerminal` task —
      there is no reopen transition anywhere in this codebase, so a terminal task can never grow a new
      open run under ANY caller, which was the only way this race could occur. **Deliberately not built**:
      the general "one shared lifecycle reservation for create/discard/assign/restart" the finding's first
      sentence asks for — tracked as still open, relevant only if a reopen transition is ever added.
    - **Finding 8 (should-fix)** — the open-run fix from the prior pass protected a LIVE worker, not the
      DATA a dead one already produced: a terminal task with no open run could still have an uncommitted
      file in its worktree, deleted with no trace by the unconditional `--force`. `discardTaskWorktree`
      now runs `git status --porcelain` first and refuses with `worktree-dirty` unless the caller passes
      an explicit `{ force: true }` (wired through the wire command as `cmd.force === true`).
    All 4 verified to fail against the pre-fix code (each guard temporarily disabled one at a time; the
    corresponding new case reproduced that finding's own repro symptom exactly) before restoring the fix.
    Regression: `runtime/test/worktree.test.js` cases 11-14 (same file — 10 cases before this pass, 14
    after, no new test file). `codexdoc/review-luna-2026-09-11.md` findings 5-8 each carry a "Fixed
    2026-09-11" note now, same convention as findings 1-4/9 already had.
    `npm test`: exit 0, **117 suites** (unchanged — fixes to an existing file, one new migration, no new
    test file), re-verified 2x, zero leaked processes.

25. **4 of the findings item 16 deferred as "out of scope for this pass" — fixed 2026-09-11, same session
    as item 24.** `codexdoc/REVIEW-NOTES.md` findings 6, 9, 12, 16:
    - **Finding 6 (should-fix)** — a worker could answer its OWN parked ask (`ask:answer` is on the plain
      `worker`/`reviewer` presets so a run is never stranded) and have the decision recorded as if a human
      made it, because the wire handler forwarded whatever `answeredBy` the caller supplied, defaulting to
      `"human"`. `answerAsk`'s wire handler now refuses when an authenticated worker-backed principal's
      `workerId` owns the ask's run (same cross-run ownership boundary `requestWorktree`/`acquireLease`
      already draw), and DERIVES attribution from `cmd._principal` — never from the caller's claimed
      `answeredBy` — for any authenticated caller. A caller with no principal at all (the unauthenticated
      in-process path several existing tests use directly) is unaffected. `runtime/test/authorization.test.js`
      case 14.
    - **Finding 9 (should-fix)** — `tuiSnapshot` requires only `read:registry`, but its transcript fields
      handed over a run's RAW tier-1 output regardless — the exact thing `observe:run` gates for `observe`
      itself, so any `utility:*` principal (or the plain `worker` preset) could read every run's transcript
      just by calling this one command. Now computed per-request: transcripts are populated only when
      there's no principal at all (unauthenticated/in-process, unaffected) or the principal holds
      `observe:run`; checked in the PRODUCER before the fields are ever built. `runtime/test/
      authorization.test.js` case 13. **Not done**: per-task result scoping and a review of other raw
      observation paths — the finding's own broader asks.
    - **Finding 12 (should-fix)** — the whole git fight loop (`agents/git-create-push.js`) ran every git/
      autofix/`gh pr create` call through `execFileSync`, which blocks the WHOLE Node event loop for as
      long as the child runs (up to 30s per call, several attempts) — no socket command, ask, digest, or
      sweep timer on the same daemon process could make progress meanwhile. Converted every call to
      `execFile` (promisified) — libuv waits on the child without blocking the loop. `run()`,
      `tryAutofix()`, `remoteHeadSha()`, `resolvePushDestination()`, `runFightLoop()`, `openPullRequest()`
      are all `async` now; the sequence/meaning of each git call is unchanged, only how it's awaited.
      `gitCreatePush()` and its two wire handlers now `await` it. `runtime/test/git-create-push.test.js`
      case 7 proves it directly: a real 1s-sleeping pre-commit hook alongside a 10ms `setInterval` ticker
      — fixed code logs 100+ ticks during that second, pre-fix code logs 0. **Not done**: a durable
      operation record, cancellation, output limits, and lease renewal during a long call, or moving the
      work to a genuinely separate supervised process — this closes the SPECIFIC blocking mechanism
      measured (a full-process-blocking syscall), not the larger job-supervision design the finding
      sketches around it.
    - **Finding 16 (should-fix)** — `domain/task-states.js`'s `autoBlockTarget` ("enters `blocked`
      automatically when an ask opens, clears automatically when the last one closes" — PLAN.md section 6)
      was built and unit-tested but had NO runtime caller at all — a task could sit in `implementing` with
      a real open ask, or in `blocked` with nothing left open, forever. Two hooks in `runtime/
      supervisor.js`: `syncBlockedOnAskOpened(taskId)` fires right after a NEW ask row is actually created
      (`recordApprovalAsk`); `reconcileAutoBlockedTasks()` fires after EVERY ask-closing path this file has
      (`answerAsk`, both `closeOpenAsksForRun` sites, the grace-expiry sweep, `withdrawApprovalAsk`, `reap`,
      boot/on-demand `reconcileOnBoot`) — rather than threading "was this the last open ask" through each
      site, it re-queries the (small) set of currently-`blocked` tasks and unblocks any with nothing open,
      which also covers run loss/failure per the finding's own closing sentence since `reap`/
      `reconcileOnBoot` close asks for lost/reaped runs through the same reconcile. `runtime/test/
      approval.test.js` case 16 — a real parked request auto-blocks an `implementing` task; answering the
      LAST open ask auto-unblocks it. Verified BOTH directions to fail independently against the pre-fix
      code.
    All 4 verified to fail against the pre-fix code before restoring the fix (self-answer succeeding with
    fabricated attribution; the real transcript text appearing for a registry-only principal; 0 event-loop
    ticks during a slow git call; a task frozen in `implementing`/`blocked` in both directions).
    `npm test`: exit 0, **117 suites** (unchanged — fixes to existing files, no new test files), re-verified
    3x, zero leaked processes each time. **One pre-existing flake observed, unrelated**: see this file's own
    top-header note.

26. **The utility-task lane's own "not built, deliberately out of scope" note (item 13) — closed
    2026-09-11.** Two gaps, both in the same area:
    - **New `domain/utility-instructions.js`** (pure, no database) — real, role-specific instruction text
      for each of the 4 utility roles (`git-push-runner`/`jira-runner`/`awsquery-runner`/`slack-runner`),
      naming the actual tool to reach for (`gitPush`/`gitPushProtected`, leo-mcp's Jira tools, the
      read-only AWS query contract, leo-mcp's Slack tools) and repeating this project's own "raise an ask,
      never guess an underspecified request" rule for a role that has no judgment to spend guessing with
      by design. `assignTask`'s prompt construction (`runtime/supervisor.js`) now calls
      `instructionForRole(slot.role, task)` and falls back to the existing generic sentence for every
      OTHER role (coder, reviewer, cto, etc.) — additive, not a behavior change for anything already
      working. `domain/test/utility-instructions.test.js` (new, wired into `test:domain`), plus
      `runtime/test/utility-task-lane.test.js` case 5 proving the REAL started run (through the fake
      harness) actually carries this text — verified to fail against the pre-fix code (temporarily
      reverted the wiring; the run's prompt came back as the old generic sentence) before restoring.
    - **New `createUtilityTask({ type, title, teamId, actor, overrides, cwd })`** (`runtime/supervisor.js`)
      — one call instead of `createTask` + `createWorker` + `assignTask` done separately, in the right
      order, with the right role name, which is exactly what item 13 named as the missing "one-line 'run
      a git-push-task for me' helper." A thin composition in front of `assignTask` — same idempotency,
      partial-start compensation, and terminal-task guard apply, because this calls it rather than
      reimplementing any part of it. Refuses a non-utility `type` by name (`rolesFor` from
      `domain/workflow-profiles.js` decides, not a second hardcoded list). Wired as a wire command too
      (`createUtilityTask`, gated on `task:assign` — the same capability `assignTask` itself requires,
      reused rather than inventing a new one for a composition that does nothing `assignTask` couldn't
      already do). `domain/capabilities.js`'s `COMMAND_CAPABILITIES` updated; coverage check (case 4 in
      `utility-task-lane.test.js`) still passes. `runtime/test/utility-task-lane.test.js` cases 5-6.
    **Deliberately NOT this pass's scope** (per explicit owner direction): no new bespoke jira-automation/
    slack-message AGENT MODULES in this repo — `leo-mcp` (item 12, PLAN.md §16.1) already provides that
    execution surface via MCP tools; this pass's job was making the DASHBOARD side (dispatch + instructions)
    actually usable, not duplicating leo-mcp's tools here a second time.
    `npm test`: exit 0, **117 suites** (one new test file, `domain/test/utility-instructions.test.js`, plus
    fixes/additions to two existing files — the count is unchanged because this file's own "PASS:"-per-file
    convention doesn't apply to every domain test, see the `mcp-manifest.test.js` precedent), re-verified 3x.

27. **First item off the OLDER should-fix backlog (below) — `openDb()`'s error-path handle leak, fixed
    2026-09-11.** `new Database(dbPath)` (`db/index.js`) opens a real OS file handle immediately, before
    any of `openDb`'s own pragma/migration steps run — a throw anywhere in those steps (a corrupt file, a
    bad migration, a permissions error) left that handle open with nothing to ever close it, one leaked fd
    per failed open. Wrapped the whole post-construction sequence in try/catch: on any throw, `db.close()`
    (best-effort — a failure closing an already-broken handle is swallowed, not layered on top of the
    original error) then rethrows the ORIGINAL error unchanged. Regression: new
    `db/test/open-db-error-path.test.js` — writes real garbage bytes to the target db path (better-sqlite3
    opens successfully on this; the first pragma that actually reads the file, `journal_mode = WAL` inside
    `setWalMode`, throws "file is not a database", proven empirically before writing the fix), patches
    `Database.prototype.close` for the duration of one case to count real close() calls, asserts exactly 1.
    Verified to fail against the pre-fix code (0 close calls) before restoring the fix. `npm test`: exit 0,
    **118 suites** (one new file), re-verified 2x.

28. **Second item off the OLDER should-fix backlog — `supervisor/ipc/`'s unsolicited-frame contract,
    fixed 2026-09-13.** The overflow and shutdown notices `ipc/server.js` writes are genuinely
    unsolicited (server-initiated, not a response to any request), so they carry `id: null` on
    purpose — but `ipc/client.js`'s correlation model (`pending`/`streamHandlers`, both keyed strictly
    by request id) had no bucket for `null` at all, so every real client built on it (`pane/pane.js`,
    any long-lived `observe` subscriber) silently dropped both notices. A pane attached during a real
    daemon shutdown got its socket destroyed with no chance to ever see "the supervisor is shutting
    down" — it just saw the connection die. Fixed with a third, explicit bucket:
    `client.onNotice(handler)` (`ipc/client.js`) receives every `id: null` frame; the overflow frame
    (`ipc/server.js`) also gained a structured `event: {type: "connection.overflow", maxLineBytes}`
    twin of its existing `error` string, so a caller can dispatch on `event.type` for either notice
    instead of pattern-matching text, matching the shutdown notice's own `event: {type:
    "server.shutdown", reason}` shape it already had. Regression: `ipc/test/teardown.test.js`'s
    existing case (which already opens a real long-lived `observe` connection and calls the real
    `shutdown()`) now also registers `onNotice` and asserts the shutdown notice actually arrives with
    its structured `event`, matching the exact `reason` the test passed to `shutdown()`. Verified to
    fail against the pre-fix code (0 notices received, temporarily removed the `onNotice` dispatch)
    before restoring the fix. `npm test`: exit 0, **119 suites** (one new case in an existing file),
    re-verified 2x.

29. **Third item off the OLDER should-fix backlog — `supervisor/lock/`'s two temp-file cleanup gaps,
    fixed 2026-09-13.** `acquireLock()` (`lock/lock.js`):
    - **The `fs.writeFile(tmpPath, ..., {flag:"wx"})` call used to run BEFORE the try/finally that
      cleans up `tmpPath`.** `wx` creates the file as one step of that call; a failure partway through
      the write itself (disk full, an I/O error) created a real file on disk and then threw, and NOTHING
      downstream ever ran to remove it — the old cleanup path was only reachable once this call had
      already returned successfully. Moved the write inside the same try/finally as the `fs.link()` call.
    - **A cleanup failure AFTER a successful `fs.link()` used to fail the whole acquisition.** Once
      `fs.link()` succeeds, the lock is genuinely held — `lockPath` and `tmpPath` are two hard links to
      the same inode. The old code still ran the redundant-temp-name cleanup with a throwing
      `safeUnlink`, so a failure removing that now-harmless extra directory entry (e.g. EPERM) propagated
      out of `acquireLock()` — the caller never got its `release()` back for a lock it was, in fact, still
      holding: an orphan nobody could ever release. Cleanup after a SUCCESSFUL link is now best-effort
      (logged nowhere, just swallowed — a leftover redundant hard link is harmless clutter); cleanup
      after a failed/unpublished write still propagates a real error, since in that branch the lock was
      never acquired and there's nothing correctness-critical to protect by swallowing it.
    New `lock/test/cleanup-failure.test.js` (2 cases) — `node:fs`'s `promises` object is monkey-patched
    for the duration of one case each (the SAME object `lock.js` itself imports via `import { promises as
    fs } from "node:fs"`, so the patch reaches its calls with no injection point needed in `lock.js`):
    case 1 patches `writeFile` to create the file then throw (simulating the real on-disk state a
    partial write leaves), asserts the temp file is gone afterward; case 2 patches `unlink` to always
    throw, asserts `acquireLock()` still returns `{acquired: true}` and that the lock still releases
    cleanly later. Both verified to fail independently against the pre-fix code (case 1: a leftover temp
    file; case 2: the patched `unlink`'s error propagating out of `acquireLock` itself) before restoring
    the fix. `npm test`: exit 0, **121 suites** (one new file, 2 cases), re-verified 2x.

30. **db/'s remaining two backlog items scoped (not code fixes) and the fourth item off the
    OLDER should-fix backlog fixed — `supervisor/adapters/opencode/adapter.js`'s `StderrRing` byte
    bound — both 2026-09-13.** See this file's own top header for the full writeup of both; short
    version: `requests`-writer and the `event_log`/`outbox` redaction gap are NOT small fixes (a whole
    unbuilt Slack-inbound feature, and a product decision about what to redact from a live transcript,
    respectively) and are left open, correctly scoped rather than guessed at; "no affected-row-count
    checks on writes" turned out to already be fixed piecemeal across many earlier passes and the
    backlog line was simply stale — audited via a background fork, zero code change needed.
    `StderrRing` (the actual fix in this item): rewritten to bound by BYTES
    (`STDERR_RING_MAX_BYTES` = 64 KiB) instead of line count (200 lines) — a process writing one
    enormous line with no newline used to store the whole thing as a single ring entry, so "200 lines"
    was never actually a memory bound. `STDERR_RING_MAX_LINE_BYTES` (4 KiB) also truncates any single
    absurd line before storage, clamped to the instance's own `maxBytes` so a just-truncated line can
    never immediately evict itself out of an otherwise-empty ring (a real bug caught by the test itself
    mid-build: a ring constructed with a budget smaller than the truncation constant emptied itself on
    the very first push). Class exported (`export class StderrRing`) purely so a unit test could prove
    the byte bound without spawning a real `opencode` process. New
    `adapters/opencode/test/stderr-ring.test.mjs` (3 cases: many short lines evicted oldest-first, one
    10 MiB single line truncated rather than stored whole, many individually-small lines that together
    exceed the budget). All 3 verified to fail against the pre-fix (line-count-bounded) code before
    restoring the fix. `npm test`: exit 0, **121 suites** (unchanged — new file uses `ok —` console
    output, not `PASS:`), re-verified 2x.

31. **Fifth item off the OLDER should-fix backlog — `supervisor/adapters/opencode/adapter.js`'s
    `server.instance.disposed` produced no terminal event, fixed 2026-09-13.** `mapEvent()` returns
    `null` for `server.instance.disposed` by design (it's a liveness broadcast, not itself
    turn-relevant) — but `_demuxOneEvent`'s session-less broadcast branch took that `null` at face
    value and emitted NOTHING to any run, including a run genuinely still mid-turn on that server.
    `observe()`'s only exit condition is seeing a real `turn.end` in the run's event log, so a run
    whose server disposed itself mid-turn waited forever — no other code path ever tells it the turn
    is over, because the server that WOULD have emitted the real `session.idle`/`session.error` just
    tore itself down. Fixed at the same broadcast branch: on `server.instance.disposed`, every run on
    that server not already `completed`/`errored` (this also catches a run mid-abort, status
    `'aborted'`, which is a request-sent marker, not yet a real terminal state) gets a synthesized
    `turn.end` (`status: 'error'`, `isError: true`, `error` naming the disposal) instead of silence.
    New test infrastructure: `POST /debug/dispose` on the fake OpenCode test server broadcasts a real
    `server.instance.disposed` SSE event on demand (test-only, mirrors the existing `/debug/spawn-env`
    pattern); `FAKE_OC_NEVER_FINISH=1` skips the fake server's normal 50ms auto-complete so a turn can
    be forced genuinely, deterministically mid-flight rather than racing a timer. New case in
    `adapters/opencode/test/test-opencode-adapter.mjs`: starts a never-finishing turn, disposes the
    server 100ms in, asserts a real synthesized `turn.end` (not a hang) arrives. Verified to fail
    against the pre-fix code (the drain loop received only an earlier `worker.env` record and hit its
    own 3s test bound with no `turn.end` at all) before restoring the fix. `npm test`: exit 0,
    **122 suites** (one new case in an existing file), re-verified 2x (one intervening run hit an
    unrelated pre-existing flake in `runtime/test/concurrency.test.js`, confirmed by 2 immediate clean
    re-runs — not caused by this change).

32. **Sixth item off the OLDER should-fix backlog — OpenCode abort's double terminal event, fixed
    2026-09-13.** A real abort emits BOTH `session.error` (MessageAbortedError) and `session.idle`
    for the SAME logical turn ending (measured, `interrupt()`'s own doc comment) — both map to
    `turn.end` via `mapEvent()`, so the run's `_eventLog` got TWO terminal events for one abort.
    `runtime/event-pump.js`'s `updateDerived` does a plain last-wins overwrite of
    `derived.terminalStatus` per `turn.end` it processes, so the LATER event (`session.idle` ->
    `'completed'`) silently masked the TRUE, earlier one (`session.error` -> `'aborted'`) — an
    aborted run was reported as having completed cleanly. New `Run._turnEndedForCurrentTurn` flag
    (`adapters/opencode/adapter.js`): set the first time a real `turn.end` is emitted for the
    current turn; reset at the start of a NEW turn (top of `sendInput()`); checked in
    `_demuxOneEvent`'s per-session branch, which now suppresses (with a stderr-ring diagnostic
    breadcrumb — visible, not silent) any second `turn.end` for an already-ended turn. Applied to
    all three OTHER `turn.end`-emitting sites too (the rejected-`prompt_async` synthesis, and item
    31's `server.instance.disposed` synthesis both now set the flag; the disposal-synthesis check
    was also switched from a status comparison to the same flag, for one single source of truth
    across all four sites) so every terminal-event source agrees on one-terminal-event-per-turn.
    Test infrastructure: the fake OpenCode server's `/abort` handler now also broadcasts
    `session.idle` after `session.error`, matching the real measured sequence — it previously only
    sent the one event, which would not have reproduced this bug at all. New `drainAll()` test
    helper, distinct from the existing `drainUntilTurnEnd` (which stops at the FIRST `turn.end` by
    design — an earlier draft of this test used that helper and passed trivially, since it never
    even looked far enough to see whether a second event arrived; caught before trusting the
    result, not after). New case in `adapters/opencode/test/test-opencode-adapter.mjs`: starts a
    never-finishing turn (`FAKE_OC_NEVER_FINISH=1`), aborts it, asserts exactly one `turn.end`
    survives with `status: 'aborted'` intact. Verified to fail against the pre-fix code (2
    `turn.end` events observed, the second overwriting status to `'completed'` exactly as
    described) before restoring the fix. `npm test`: exit 0, **123 suites** (one new case in an
    existing file), re-verified 2x.

33. **Seventh item off the OLDER should-fix backlog, resolved as STALE — `clearContext`/`resume`'s
    "incompatible semantics between harnesses" note, checked 2026-09-13.** No code change: already
    resolved before this pass, the backlog line just wasn't updated. `conformance/matrix.js`
    documents the real difference explicitly (Claude Code's `clearContext` sends `/clear` and
    ERASES history; OpenCode's POSTs `/summarize` and COMPACTS it — same method name, opposite
    effect), and both adapters' `capabilities().clearContext` return that as an explicit STRING
    (`'erase'`/`'compact'`), never a boolean — which `conformance/suite.js` then checks. This is
    exactly the "semantics carried as strings, not booleans" decision this file's own "What to
    keep" section already lists as settled; the backlog note predated that being verified as
    actually wired through the real conformance suite, not just designed. No test changes needed —
    nothing was broken.

34. **Eighth item off the OLDER should-fix backlog — Claude Code process exiting with no `result`
    produces no `turn.end`, fixed 2026-09-13.** `adapters/claude-code/adapter.js`'s `turn.end` is
    ONLY emitted from a parsed `type: 'result'` stdout line — a process that crashes, is killed, or
    otherwise dies mid-turn without ever printing one left NO `turn.end` in the run's event log at
    all. `observe()` itself still terminates (its exit check is `run.status`-based, set
    independently by the `exit` handler), but `runtime/event-pump.js`'s `updateDerived` only marks a
    run's derived status terminal ON a real `turn.end` event — a silently-dead run's derived status
    stayed whatever it was before, never actually recorded as terminal at that layer. The same class
    of gap items 31/32 just closed for the OpenCode adapter, fixed with the identical pattern: new
    `Run._turnEnded` flag, set when the real `result`-driven `turn.end` fires, reset at the top of
    `_sendUserMessage` (covers both `sendInput` and `clearContext`'s `/clear` — both start a genuinely
    new turn). `child.on('exit', ...)` now synthesizes a fallback `turn.end` if none was ever
    emitted, mapped onto the same `'completed'|'error'|'aborted'` vocabulary every other `turn.end`
    uses via `run.status` (a clean exit code alone does NOT mean `'completed'` here, since the
    protocol's own `result` line never arrived — always `'error'` unless the run was already known
    `'stopped'`/`'interrupted'`, which maps to `'aborted'`). New `FAKE_CLAUDE_MODE=crash` in the fake
    test binary (prints the usual delta, then exits nonzero with NO result line) plus a new case in
    `adapters/claude-code/test/test-claude-code-adapter.mjs`. Verified to fail against the pre-fix
    code (the drain loop received only `process.exit`, no `turn.end` at all) before restoring the
    fix. `npm test`: exit 0, **124 suites** (one new case in an existing file), re-verified 2x.

35. **Ninth item off the OLDER should-fix backlog, and the LAST item in `supervisor/adapters/`'s
    list — `verifyRunIdentity()`'s HTTP-unavailable fallback false-positiving `sessionKnown:true`,
    fixed 2026-09-13.** `adapters/opencode/adapter.js`'s `entry.sessionsKnown` is the fallback
    signal `verifyRunIdentity()` consults only when the real `GET /session/{id}` call itself fails
    (network blip, server momentarily unresponsive) — but it was add-only: populated when a session
    is created, never touched by `discardSession()` when that same session is genuinely deleted.
    A LATER identity check landing during a transient HTTP outage therefore fell back to this stale
    cache and reported an already-discarded session as still known, even though the real server
    (if reachable) would have said 404. Fixed: `discardSession()` now calls
    `entry?.sessionsKnown.delete(sessionID)` the instant the real DELETE confirms the session is
    gone (200 or already-404) — `entry` resolved by `run.cwd` normally, falling back to matching by
    `baseUrl` for a stopped run already out of the `runs` map (the same recovery `discardSession`
    already did for `baseUrl`/`sessionID` themselves). New `DELETE /session/:id` handler in the fake
    OpenCode test server — didn't exist before, so `discardSession()` had no way to succeed against
    it at all. New case in `test-opencode-adapter.mjs`: discards a real session, then forces the
    exact failure mode by pointing `run.baseUrl` (mutated directly via the existing
    `_getRunForTest()` test seam) at an unreachable port so the HTTP call fails while the real
    server OS process stays alive (`serverAlive: true`, unaffected since that check is process-based
    via `run.cwd`), asserts `sessionKnown` correctly comes back `false` rather than the stale-cache
    `true`. Verified to fail against the pre-fix code (`sessionKnown: true` for an already-discarded
    session, reproducing the finding exactly) before restoring the fix. `npm test`: exit 0,
    **125 suites** (one new case in an existing file), re-verified 2x. **Every item in
    `supervisor/adapters/`'s should-fix backlog is now closed.**

36. **`supervisor/runtime/`'s "state directory is not one directory" backlog note — checked
    2026-09-13, already resolved, stale note, no code change.** `paths.js` is (and was already) the
    single canonical resolver: `stateDir()` reads `SUPERVISOR_STATE_DIR`, falls back to the legacy
    `CTD_STATE_DIR` alias, then a hardcoded default. `db/paths.js`/`ipc/paths.js` are both thin
    re-export shims over the SAME module (checked their actual contents — neither has its own
    resolution logic anymore). `lock/lock.js`'s `LOCK_DIR`/`LOCK_PATH` are computed by calling
    `stateDir()`/`lockPath()` from that same module, not by reading either env var itself.
    `runtime/test/daemon-crash.test.js` already sets only `SUPERVISOR_STATE_DIR` and explicitly
    `delete`s `CTD_STATE_DIR`, with its own comment noting this "used to have to set two ... because
    the two roots disagreed" — past tense, already fixed. Third stale backlog note found this session
    (same pattern as items 30 and 33).

37. **`supervisor/runtime/`'s "full adapter-iterator cancellation needs an AbortSignal" backlog
    note — genuinely real, fixed 2026-09-13 (NOT stale, unlike item 36 right above it).** Verified
    empirically before writing anything: a minimal standalone repro of the EXACT
    `while (true) { await new Promise(...) }`-with-no-`yield`-between-successive-awaits shape both
    real adapters' `observe()` used hung indefinitely when `.return()` was called while genuinely
    idle-polling — confirmed this is a real JS engine behavior (a queued `.return()` on an async
    generator can only be delivered once the generator reaches an actual suspend/resume point, which
    a bare repeated-await loop with no `yield` in between never reaches while idling), not
    theoretical. Reproduced against BOTH real adapters directly (`adapters/opencode/adapter.js`,
    `adapters/claude-code/adapter.js`), not just the synthetic mock iterator
    `runtime/test/review-three.test.js`'s existing case 8 already covers — that case proves the
    PUMP's `cancelIterator()` correctly calls `.return()`, but never exercised whether a REAL
    adapter's generator actually honors it. Fixed in both: `observe()` now returns a thin wrapper
    object around the real async generator; the wrapper's `.return()` — the pump's ONLY
    cancellation call — sets a new `run._cancelled` flag and wakes the pending wait immediately
    (reusing each adapter's own existing wake mechanism), so the generator's OWN code runs a
    genuine, synchronous `return;` statement on its very next tick. That completes the generator
    NORMALLY, which needs no generator-protocol delivery of an externally-queued completion at
    all — sidestepping the JS limitation entirely rather than fighting it. `next`/`throw`/
    `[Symbol.asyncIterator]` on the wrapper all delegate straight through to the real generator,
    so nothing else about either adapter's public shape changes. `_cancelled` is reset in the
    Claude Code adapter's `resume()` (a resumed run is a genuinely NEW process — the observer that
    gave up on the OLD one does not speak for whoever calls `observe()` on the fresh generation);
    OpenCode's `resume()` never restarts anything, so no reset needed there. New
    `FAKE_CLAUDE_MODE=stall` in the Claude Code fake test binary (emits the usual delta, then never
    emits a result and never exits — genuinely, permanently mid-turn, distinct from the existing
    `crash` mode which DOES exit); the OpenCode adapter already had an equivalent
    (`FAKE_OC_NEVER_FINISH`, from item 31). New case in each adapter's own test file: drains
    whatever's already buffered (detecting "genuinely parked" by a 60ms non-resolution race rather
    than a hardcoded event count), calls `.return()` on the parked iterator, asserts the earlier
    pending `.next()` call settles well within the 200ms safety-net window (bounded at 500ms) rather
    than hanging. Verified to fail against the pre-fix code in BOTH adapters independently (each
    timed out at the test's own 1000ms bound, reproducing the exact hang) before restoring the fix.
    `npm test`: exit 0, **127 suites** (two new cases in existing files), re-verified 2x, zero leaked
    processes (the Claude Code test's `stall`-mode run, which never exits on its own, is explicitly
    `stop()`ped after the assertion — confirmed by the suite's own final `disposeAll` teardown count).

38. **The LAST item in the OLDER should-fix backlog — `supervisor/ipc/`'s "SO_PEERCRED uid check,"
    resolved as DECIDED 2026-09-13, no code written.** Explicit instruction before starting: verify
    this is actually required before implementing anything, and don't build something that
    shouldn't be built. Re-ran `adapters/claude-code/probe/peercred-probe.mjs` (originally captured
    2026-09-09, evidence 17) LIVE against the current Node version rather than trusting the old
    output file — it reproduces identically: a Unix-socket connection's `remoteAddress`/
    `remotePort`/`remoteFamily` are all `undefined`, and the connection handle's prototype exposes
    only `bind, listen, connect, open, fchmod` — no peer-credential API exists anywhere in pure
    Node. A real native addon would be needed to implement the LITERAL ask. But the security gap
    that check exists to close was ALREADY closed, and already decided, well before this backlog
    note was ever written: `runtime/supervisor.js`'s own §14.5/migration 0010 commentary (right
    where `ensureOwnerPrincipal` lives) documents a two-part identity built from (1) the state
    directory's `0700` permission — enforced by `db/index.js`'s `ensureStateDir` via an explicit
    `chmodSync`, not trusted to `mkdir`'s umask-affected mode — which gates which OS user can even
    resolve the path to the socket at all, and (2) a supervisor-minted, hashed, capability-scoped
    token checked on every command, which is STRICTLY finer-grained than a raw same-user uid check
    would ever be (a uid check proves "same user"; the token system proves "this exact principal,
    holding these exact capabilities"). Building a native addon (`SO_PEERCRED` on Linux and
    `getpeereid` on macOS/BSD are genuinely different APIs — real, ongoing per-platform maintenance
    weight) would re-close a gap that's already closed, for a threat model — a shared multi-user
    host — this project's own documentation already states is explicitly not its current design
    target ("an honest boundary for a local single-user tool... would not be one on a shared
    host," written down rather than hidden). **Fixed the documentation instead of writing code**:
    `ipc/FINDINGS.md`'s "open item, not implemented" section rewritten to state the actual decision
    and point at where it already lives, rather than reading as a silently-dropped gap;
    `TODO.md`'s misleading `[x]` checkbox (which read as if a native addon had actually been built)
    annotated with what was really decided; this file's own backlog note corrected to match.
    **The OLDER should-fix backlog, worked through directory by directory across items 27-38, is
    now fully closed or correctly, explicitly deferred — nothing pending action remains in it.**
    No test changes (nothing was broken; nothing was built). `npm test` unaffected: **127 suites**,
    exit 0 (last verified at item 37).

39. **Phase 8's first step — `config/harness-defaults.js`'s new `clearPolicy` schema — had a real
    validation gap when re-audited after the rewind; fixed 2026-09-13.** `clearPolicy` (PLAN.md §8
    Rule 5's closed vocabulary: `on-state-transition` / `per-review-round` / `on-demand` / `always`)
    was added as a field on every `BUILT_IN_DEFAULTS` role entry, and as a recognized key in
    `ASSIGNMENT_KEYS` (so a config file naming it is not rejected as "unknown key"). But its VALUE
    was never checked against `CLEAR_POLICIES` — a typo like `"clearPolicy": "on-demandd"` loaded
    through with no error, contradicting this same file's own stated design rule for every OTHER
    field ("A MALFORMED file THROWS" — the person who wrote it intended to change something, and
    running with the typo silently is the exact intent-versus-reality mismatch this file's other
    validation exists to catch). A comment also claimed, in the present tense, that
    `domain/clear-policy.js` "is what actually DECIDES when one of these fires" — that module does
    not exist; nothing anywhere reads `clearPolicy` at all yet. Fixed: added the missing value
    validation (same throw-with-the-valid-list pattern `harnessId`'s own check already uses);
    corrected the comment to state plainly that this is SCHEMA ONLY, Phase 8's first step, with the
    actual decision module still unbuilt. Regression: new case in `runtime/test/assignment.test.js`'s
    existing "malformed config" test — an unrecognized `clearPolicy` value throws, a recognized one
    loads through unchanged. Verified to fail against the pre-fix code (the bad value loaded with no
    error at all) before restoring the fix. `npm test`: exit 0, **127 suites** (unchanged — one new
    case in an existing file), re-verified 2x. **Still not built**: the decision module itself
    (`domain/clear-policy.js` or equivalent) that would actually read this field and call
    `clearContext()`/`resume()` at the right moment — tracked honestly as a partial checkbox (`[~]`)
    in `ROADMAP.md`'s Phase 8 section, not a closed one.

## Open should-fix items, by directory (nothing here is silently dropped)

**`supervisor/db/`** — `event_log`/`outbox` redaction gap (needs a product decision, not a
unilateral fix — see item 30); missing `requests` writer (whole unbuilt Slack-inbound feature,
not a bug — see item 30); ~~`openDb()` error-path handle leak~~ **fixed 2026-09-11, item 27**;
~~no affected-row-count checks on writes~~ **audited 2026-09-13, item 30 — stale note, already
fixed piecemeal across many earlier passes, no code change needed**. (The unvalidated
`busyTimeoutMs` PRAGMA interpolation was fixed alongside the WAL work.)

**`supervisor/lock/`** — ~~temp-file leak if `fs.writeFile` fails mid-write; orphaned
lock if `fs.link()` succeeds but temp cleanup then fails~~ **both fixed 2026-09-13, item 29**.

**`supervisor/ipc/`** — ~~duplicate correlation IDs are accepted~~ **fixed in Group 5**
(server-side: a second command reusing an in-flight id on the same connection is refused
with an explanatory error; note the *client's* `pending` map is still last-writer-wins, so
the server's refusal is what protects you); ~~`observe` iterator not cancelled on peer
close~~ **fixed in Group 5** (per-connection `AbortController`); ~~unsolicited frames (overflow/shutdown
notices) use `id: null`, inconsistent with the "every frame echoes its request id" claim~~ **fixed
2026-09-13, item 28** (see above — `id: null` is now a documented, deliberate third case with its own
`onNotice` delivery path, not a silent drop);
~~`SO_PEERCRED`/`getpeereid` uid check on accept is still unimplemented~~ **checked 2026-09-13,
item 38 — DECIDED, not a gap, no code needed.** Re-verified the 2026-09-09 probe
(`adapters/claude-code/probe/peercred-probe.mjs`) still holds on the current Node version: no
peer-credential API exists on a Unix socket in pure Node, confirmed today, not just trusted from
the old evidence file. A native addon was deliberately NOT written — the two-part identity
`runtime/supervisor.js` already documents (§14.5/migration 0010: the `0700` state dir gates WHICH
OS user can reach the socket at all; a minted, hashed, capability-scoped token gates WHICH
principal) already closes the same gap, with FINER granularity than a raw uid check ever would.
See `ipc/FINDINGS.md`'s corrected entry for the full reasoning; `TODO.md`'s checkbox corrected to
say what was actually decided rather than implying a native addon that doesn't exist.

**`supervisor/runtime/`** — (both Group 6 findings that used to be listed here are **closed** as
of migration 0003 — see `runtime/FINDINGS.md` section 13.) ~~full adapter-iterator cancellation
needs an `AbortSignal`~~ **fixed 2026-09-13, item 37** (both adapters' `observe()` now returns a
wrapper whose `.return()` forces a real, synchronous generator completion instead of relying on
the JS engine ever delivering a queued external one — verified this was a genuine, reproducible
hang before fixing it, not assumed); ~~the state directory is not one directory~~ **checked
2026-09-13, item 36, already resolved, stale note** (`paths.js` has been the single canonical
resolver for a while; `lock/lock.js`, `db/paths.js`, `ipc/paths.js` all delegate to it). Still
open: pump state for completed runs is never released (deferred ON PURPOSE: that state is what
`status()`/`list()` read for `derived`, so dropping it on completion makes a just-finished run
report `derived: null`; correct fix is bounded retention once replay from `event_log` exists,
which is Group 6 — not attempted this pass, since it's a deliberate design tradeoff pending other
work, not an oversight).

**`supervisor/adapters/`** — **CLOSED, 2026-09-13.** All 6 items resolved (5 real fixes, 1 stale
note): ~~OpenCode abort can emit two terminal events~~ **fixed, item 32** (a
`Run._turnEndedForCurrentTurn` flag suppresses the redundant second one); ~~a Claude Code process
exiting with no `result` object produces no `turn.end`~~ **fixed, item 34** (a `Run._turnEnded`
flag + a synthesized fallback `turn.end` from the exit handler, same pattern as item 32); ~~the
stderr ring is bounded by line count not bytes~~ **fixed, item 30** (`StderrRing` now bounds by
bytes, with a per-line truncation cap); ~~`server.instance.disposed` maps to `null`, hangs
`observe()`~~ **fixed, item 31** (every non-terminal run on a disposed server gets a synthesized
`turn.end`); ~~`verifyRunIdentity()`'s HTTP-unavailable fallback can false-positive
`sessionKnown:true`~~ **fixed, item 35** (`discardSession()` now removes the stale local-cache
entry the instant the real server confirms deletion); ~~`clearContext`/`resume` have incompatible
semantics between harnesses~~ **checked, item 33, already resolved, stale note, no code change** —
`conformance/matrix.js`/`conformance/suite.js` already declare and check the real semantics as an
explicit string (`'erase'`/`'compact'`), the exact "semantics as strings, not booleans" decision
this file's own "What to keep" section already documents as settled.

## One behavior change to be aware of (`supervisor/ipc/`)

`MAX_LINE_BYTES` (256 KiB) is now a cap on **every** wire command, not just on
unterminated ones. Previously a command of any size was accepted as long as it ended
in a newline — that was the blocking bug. Consequence: a single command carrying a
payload over 256 KiB (a very large `sendInput` prompt, or a big `echo`) is now refused
and its connection closed. If a real caller legitimately needs more, raise
`maxLineBytes` deliberately at the `createIpcServer` call site — do not weaken the cap
itself. Nothing in the current code sends anything near 256 KiB, so this is a
forward-looking note, not a present problem.

## GIT — this repo is published, and what that means for you

**It is in git as of 2026-09-09: `manish96170/custom-team-dashboard`, branch `main`, PUBLIC.** One commit, 264
files. Public deliberately, to get the free tooling that public repos qualify for; the owner intends to flip it
to private once the build is finished.

**The one thing to remember about that flip:** it hides the repo, it does not un-publish it. Anyone who forked or
cloned while it was public keeps their copy, and crawlers may too. Treat everything already committed as
permanently public, and decide accordingly *before* adding anything new.

### What is deliberately NOT in the repo

`.gitignore` excludes `review-*/`, `arch-reviews-now-not-needed/` and `consolidated-review-*.md` — the
independent-model review transcripts. They quote internal repo names and workflow detail that is not this
project's to publish. **Nothing is lost**: every conclusion they produced is in `supervisor/runtime/FINDINGS.md`,
which is committed. Also excluded: `node_modules/`, `.DS_Store`, `.obsidian/`, `*.sqlite3*`, `*.token`,
`owner.token`, `.env*`, `*.tar.gz`.

### Two consequences of the exclusions, worth knowing before you read further

**The suite still passes after the scrub: 113 suites, exit 0, re-verified.** Removing files is exactly how a
green suite goes red quietly, so this was checked rather than assumed.

**Citations to review transcripts are records, not files.** HANDOFF, ROADMAP and FINDINGS all reference
`review-phase6/verdicts.md` and `review-phase7/verdicts.md` by path, and on a fresh clone those paths do not
exist. Read such a citation as "this happened, and FINDINGS records what came of it". If one ever needs to stand
alone, fold the remaining detail into FINDINGS — do not publish the transcript. What IS committed and checkable:
`spike-0b/` (81 files), `supervisor/adapters/claude-code/probe/evidence/` (18 captured-output files, including
the real-CLI runs) and `supervisor/tui/evidence/` (the demo frames).

### Paths in these docs are generic on purpose

Before publication, absolute paths were rewritten to `/path/to/…` and the OS username to `user`. So when a doc
says `/path/to/custom-team-dashboard`, that means **your clone**. Sibling-repo references are relative
(`../team-slack-bridge/`) and still resolve correctly. The evidence directories carry a `REDACTION.md` stating
exactly what was substituted and that no event, timing, exit code or payload was altered — worth keeping true if
you ever add evidence.

### Pushing from here

Two accounts are logged into `gh` on this machine. **`anchor-mani` is the active one** and owns unrelated work
repos; **`manish96170`** owns this one. Git over HTTPS authenticates as whichever is ACTIVE, so:

```
gh auth switch --user manish96170   # before pushing
git push
gh auth switch --user anchor-mani   # restore the default afterwards
```

**Ask the owner before pushing.** Another session watches git for this repo, and an unannounced commit will be
seen by it. That has not changed just because the repo now exists.

### The upside worth using

Recovery is now one command. The 2026-09-08 incident — 202 files silently replaced by an older copy — would today
show up as a `git status`/`git diff` and be undone with `git restore`. The tarballs in `~/ctd-snapshot-*.tar.gz`
are now a belt-and-braces second line, not the only one. **Still watch the suite count** (below); it is what
caught that incident before anyone thought to look at the files.

## Known environment issues (don't rediscover these)

- **This tree was overwritten by an older copy on 2026-09-08 at 17:13:40** — 202 files, `.obsidian/*.json`
  included. Cause unidentified; ruled out the mutation runner, the suites, git (untracked) and OpenCode's
  snapshot repos. Symptom to watch: the `npm test` suite COUNT dropping for no reason you know. Fallback:
  `~/ctd-snapshot-*.tar.gz`, kept outside the tree.

- **`opencode run` needs `--auto`** when run non-interactively with no TTY, or
  permission prompts hang forever with zero output and zero indication why.
- **Keep `opencode run` prompts SHORT, single-line, and ASCII.** A long multi-line
  prompt piped in via `nohup ... "$(cat file)"` produced banner-only output and
  exit 0 — looks like success, contains nothing. The same question as one compact
  single-line prompt in the foreground worked immediately. Also never tell the model
  to "read PLAN.md in full" for context (1140+ lines) — inline the 2-3 relevant
  sentences instead. Both of these have now bitten multiple times.
- **Model agent aliases live in `~/.config/opencode/opencode.json`.** Verified
  working: `luna` (`openai.gpt-5.6-luna`) and `terra` (`openai.gpt-5.6-terra`), both
  via `opencode run --agent <name> --variant medium --auto`. `sol`
  (`global.openai.gpt-5.6-sol`) **works, but is fragile** — corrected 2026-09-06 after using it
  successfully: the installed `@ai-sdk/amazon-bedrock` has no case for Bedrock's
  `reasoningContent.redactedContent` block shape, so a call crashes **only when that response
  actually contains a redacted-extended-thinking block**, not every time. The earlier "sol is
  broken, don't use it" note was too strong. Not fixable via CLI flags when it does hit. The "no payment method" error
  people hit on `opencode/gpt-5.6-sol` is a different, unrelated red herring (that's
  the OpenCode Zen catalog model, not the Bedrock one).
- **Backgrounded `opencode run` calls can silently stall if the laptop sleeps** — CPU
  time flatlines but the process isn't dead. Check `ps -o pid,etime,time` and compare
  CPU-time deltas across two checks a few minutes apart before concluding it's stuck.
- **The `Agent`/subagent tool may be unavailable in this repo's sessions.** It failed
  with `teammateMode is set to "iterm2" but the it2 CLI is not reachable` (fix would be
  `pip install it2` + enable iTerm2's Python API, or change `teammateMode`). Even when
  it does work, subagents have twice proven unreliable for long-running backgrounded
  shell commands — they start one, stop watching, and report "completed" with no
  result. **Prefer `Bash` with `run_in_background: true` directly.**
- **Subagents are blocked by tool policy from writing files named `FINDINGS.md`** or
  other report-shaped filenames. They'll return the content in their final report; the
  orchestrator has to materialize the file.

## Sibling repos worth knowing about

- **`../team-slack-bridge/`** — the Slack integration this project's §14 and §16 depend on. It now has its own
  build plan (`PLAN.md`, 2026-09-09, 682 lines): one core, four surfaces (direct CLI / MCP server / Claude Code
  skill / this dashboard's `slack-message` agent), and a **remote profile locked down by construction** — no user
  tokens, no DM paths, no listener, no `chat:write.customize`. As-user posting and DM-reading are therefore
  LOCAL-ONLY, permanently, which is consistent with our sensitive class gating them. Nothing there has been
  committed either.
- **`../slack-bots/yadavbot/`** — a Slack-provided Bolt sample ("Casey"). It is the working reference for Socket
  Mode, the event-subscription set, and a complete app manifest. The bridge's plan §3 says exactly what to lift
  and what to leave.

## Doc map

- `PLAN.md` — full design, 21 sections. §20 ("Host resource arbitration & exclusive
  external resources", added 2026-09-09) is leases over `host:heavy-job` and
  `git:identity`; §21 (MCP pooling + lazy tool discovery, added 2026-09-10) is the
  newest. Section 12 ("Model health, fallback &
  preferences") documents the model-reliability incidents above and the design
  response (preflight checks, silent mid-session failover, denylist, per-section model
  defaults, settings UI, session-ID visibility).
- `ROADMAP.md` — phased build order; Phase 1's checklist has Group 5's requirements
  spelled out in detail, traced to specific review findings.
- `TODO.md` — the Group 1-6 breakdown with independent-vs-dependent grouping.
- `FLOWS.md` — diagrams + full keybinding table.
- `TUI-GUIDE.md` (added 2026-09-10) — a screen-by-screen walkthrough built from REAL captured
  frames (`supervisor/tui/evidence/01-demo-frames.txt`, regenerated by
  `supervisor/tui/capture-frames.mjs`), not mockups: for each action, what you see before and
  after. Also carries a checked-against-the-code gap list (`v` variant picker, `g` grouped-view
  toggle, Requests panel buttons, chat NLU commands — documented in FLOWS §5 but not actually
  wired). Meant to be regenerated alongside the TUI, not written once — its own "Keeping this
  guide current" section says how.
- `codexdoc/` (started 2026-09-10) — architecture docs and diagrams from an independent codex
  (gpt-6-astra) review, plus a review of the Phase 7 lease/worktree work. **Both runs hit the
  ChatGPT-account codex quota before finishing** (resets ~2026-09-11 02:04) — a retry is
  scheduled (cron job `2c6ed030`, durable). If this note is stale, check whether `codexdoc/`
  actually has content yet before assuming the retry ran.
- `supervisor/` — the real Phase 1 code, now complete. Each subdirectory (`db/`, `lock/`,
  `ipc/`, `adapters/`, `runtime/`) has its own `FINDINGS.md` with what's built, proven, fixed, and open.
  Those are the authoritative per-group record; read the relevant one before touching
  that directory. `runtime/FINDINGS.md` sections 12-13 are Group 6: the crash/concurrency
  suites, their mutation table, and what is still open after them.
- `review-two/` — cross-model code review for Groups 1-4. `CONSOLIDATED-SUMMARY.md`
  first; drill into `group*-*.md` only for a specific finding's repro.
- `review-three/` — cross-model code review for Group 5. **`group5-verdicts.md` first** (what
  was fixed, rejected, deferred, and why — it overrides the consolidation); then
  `group5-consolidated.md`, then the raw `group5-runtime-{luna,terra}.md`.
- `spike-0b/` — throwaway Phase 0b proof-of-concept. Don't build on it;
  `supervisor/` is the real implementation.
- `arch-reviews-now-not-needed/` — archived architecture reviews, already incorporated.
- `team-slack-bridge/` — separate standalone sibling repo, not part of this codebase.

## Review-quality note worth carrying forward

Two review claims from round two turned out to be **wrong about their reasoning while
right about the bug**, and one reviewer rationale was simply false:

- luna claimed the Group 4 SSE race was hidden because the fake test server "replays
  historical events to late subscribers." It does not — `fake-opencode-server.mjs`
  pushes to an `eventQueue` that is **never read anywhere**. Independently confirmed by
  a second model (`terra`) tracing every read of that array. What actually hid the bug
  was localhost subscription latency being too small to lose the race. The bug itself
  was real and is fixed.
- Every group's own `FINDINGS.md` overclaimed something, consistently: "fully proven"
  usually meant "the test I wrote passes," not "I checked every path." This recurred
  at the real-build stage after also happening in spike-0b, so treat it as a durable
  pattern — see PLAN.md section 12's `claims-vs-evidence` review dimension.

Practical upshot: **verify a reviewer's mechanism, not just its conclusion**, and make
every regression test fail against the pre-fix code before believing it.

## What NOT to do

- Don't re-run Groups 1-6's builds from scratch — they're done, tested, and reviewed.
- Don't "simplify" `runs.lifecycle` back into `exit_reason`. They answer different questions —
  "how did this run end" versus "was its process ever observed running unmanaged" — and collapsing
  them is exactly the bug migration 0003 fixed: a closed row is invisible to reconciliation's own
  input set. A row reconciled straight to `lost` keeps `lifecycle: 'managed'`, and that is correct.
- Don't turn `orphan_sightings` into a state table. It is append-only history; the moment
  something reads it back as truth there are two sources of truth for one process.
- Don't replace `asks.auto_close_at` with an in-memory timer. The whole point is that a supervisor
  killed mid-grace still honours the deadline on its next boot.
- Don't "simplify" `killProcessGroup` back to signal-only checks. The `ps`-based
  zombie check looks redundant next to `kill(-pgid, 0)` and is not: a zombie-only group
  answers the cheap check with "alive" and the actual SIGTERM with EPERM, and `reap` gates a
  terminal database write on the difference (`runtime/FINDINGS.md` section 12).
- Don't replace `runtime/test/_crash-victim.js` with an in-process simulation. Catching a
  signal is exactly what a crash does not do; `integration.test.js` case 8 already covers the
  cooperative "handles are gone" shape, and it cannot cover a WAL that was never checkpointed.
- Don't re-open the round-three findings that were rejected. The reasons are written down in
  `review-three/group5-verdicts.md`, including two cases where a reviewer was right about the
  bug and wrong about the mechanism, and one where the "fix" was impossible as written.
- Don't "simplify" the runtime tests by replacing real spawned processes with mocks. The
  entire point of Group 5 is OS process ownership; `ipc/mock-adapter.js` and
  `ipc/persistence-stub.js` remain only as `createIpcServer` defaults for `ipc/test/`,
  and are annotated as such.
- Don't re-litigate architecture already settled in PLAN.md (single-writer supervisor,
  SQLite not JSON, event-transcript pane rendering, capability-based auth) — these
  went through multiple independent-model reviews.
- Don't assume a long-running background `opencode` call is stuck without checking
  CPU-time deltas first.
