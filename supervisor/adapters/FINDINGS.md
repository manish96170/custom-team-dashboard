# Findings — Phase 1 Group 4: Adapter normalization

(Written by the parent session — the subagent that did this work was blocked by tool
policy from writing this file itself; this is its report, verbatim.)

## Files

`supervisor/adapters/claude-code/adapter.js`, `supervisor/adapters/opencode/adapter.js`
(spike-0b originals untouched), plus fakes/tests under each adapter's `test/` dir.

Both suites pass: `node supervisor/adapters/claude-code/test/test-claude-code-adapter.mjs`
(6/6) and `node supervisor/adapters/opencode/test/test-opencode-adapter.mjs` (9/9).
Every finding below was regression-checked by reverting the fix and confirming the
suite goes red, then restoring it.

## Fully fixed and proven (7/9)

- **B4** — normalized `turn.end` with `status: completed|error|aborted` on both
  adapters, `isError` derived for back-compat. Proven per terminal shape.
- **S5** — OpenCode `sendInput` now reuses `spec.model`/effort persisted at `start()`.
  Proven against the fake server's own request log.
- **S6** — stderr drained into a bounded ring buffer, `proc.on('error')` guarded,
  raced against the health check (a flag-check version lost the race in testing —
  fixed to a promise race). Proven via a genuinely-missing binary.
- **S7** — stop/resume timer race fixed with a generation counter + specific-child
  check; `resume()` now shares `_bindChild()` with `start()` so it can't omit the
  error handler. Proven by actually triggering the race with a real subprocess.
- **S8** — OpenCode `observe()` replay via a per-server SSE demuxer buffering into
  per-run `_eventLog`, same shape as Claude Code's. Proven with a
  fast-turn-before-observe scenario.
- **S9** — fail-closed SSE session filtering. Allowlist (`server.connected`,
  `server.heartbeat`, `server.instance.disposed`) verified against live OpenCode
  server source via `gh api`, not guessed. Proven — first test version was itself
  buggy (used an event type `mapEvent` already discarded) and was caught during
  self-review.
- **M14** — `preflight()` on both adapters, fast ENOENT detection.

## Fixed but not independently proven (S4, M7)

- **S4** — two-level identity (`{serverPid, sessionID}` + `verifyRunIdentity()`) is
  implemented and the "shared pid, distinct sessionID" case is proven, but the
  `serverAlive:true/sessionKnown:false` combination isn't exercised end-to-end.
- **M7** — clearContext/resume surfaces confirmed consistent between the two
  adapters; no code changed.

## Code-review round two (2026-09-05): one blocking bug, FIXED

`review-two/group4-adapters-luna.md`: **the OpenCode SSE demuxer started
`fetch('/event')` fire-and-forget**, so `getServer()`'s `ready` promise resolved —
and `start()` went on to POST `prompt_async` — while the subscription was still
being established. A turn finishing inside that window emitted its terminating event
to nobody, and `observe()` hung forever.

Fixed: `_startServerEventDemuxer()` now returns a promise that `entry.ready` awaits,
and it resolves only on OpenCode's own `server.connected` event — the one positive
proof from the server side that this reader is attached. A `/event` request that
fails, returns non-200, or ends before going live now fails the pool entry outright
instead of producing a server whose every `observe()` would hang. If headers arrive
but `server.connected` never does (an older OpenCode that doesn't emit it), the wait
degrades to resolved-with-breadcrumb after `SSE_CONNECT_TIMEOUT_MS` (5s) rather than
deadlocking startup.

Regression test: `test/opencode/... test_sse_subscription_is_live_before_turn_starts`
in `opencode/test/test-opencode-adapter.mjs`, backed by a new
`FAKE_OC_EVENT_DELAY_MS` knob in the fake server that holds the `/event` response
back 700ms while `FAKE_OC_FAST_TURN=1` finishes the turn immediately. Verified to
FAIL against the pre-fix adapter (start() returned in 165ms, racing the
subscription) and pass after.

**Correction to the reviewer's rationale, independently confirmed.** luna stated the
old suite missed this because the fake server "replays historical events, which real
OpenCode does not." That is false: `fake-opencode-server.mjs` pushes every event into
an `eventQueue` (line 66) that is **never read anywhere in the file** — `GET /event`
adds the response to `sseClients` and sends only `server.connected` (lines 104-105),
and later broadcasts go only to already-connected clients (lines 68-70). A second
model (`terra`, `amazon-bedrock/openai.gpt-5.6-terra`) was asked to trace every read
of `eventQueue` and reached the same conclusion independently. What actually hid the
bug was localhost subscription latency being too small to lose the race. The bug
itself was real and is fixed — the wrong mechanism does not make the finding wrong.
(`eventQueue` is now dead code kept only because its comment documents the intent;
removing it would be a safe cleanup.)

Still open from that review (should-fix, NOT yet fixed): OpenCode abort can emit two
terminal events (`session.error` then `session.idle`, both mapped to `turn.end`); a
Claude Code process exiting with no `result` object produces no `turn.end` at all;
the stderr ring is bounded by line count, not bytes, so one huge line is unbounded;
`server.instance.disposed` maps to `null`, so a disposed server produces no terminal
event and can hang `observe()`; `verifyRunIdentity()`'s HTTP-unavailable fallback can
false-positive `sessionKnown:true`; and `clearContext`/`resume` have compatible
signatures but incompatible *semantics* between harnesses (the M7 note above was
about signatures only — corrected).

## Biggest remaining risk

The S9 allowlist reflects one point-in-time read of OpenCode's server source — a
future upstream event type with no `sessionID` will be silently dropped (safe,
logged) rather than delivered, and nothing here keeps it in sync automatically.

## Phase 2 (2026-09-07): Claude Code CAN park a permission decision — PLAN.md was wrong about this

**PLAN.md sections 4 and 7 said Claude Code has no live permission callback in `--print`
mode, so the Claude Code adapter would have to make a PreToolUse hook subprocess
synchronously long-poll the control socket for an answer. That is false as of `claude`
2.1.263, and it was the "risky part" the whole of Phase 2 was sequenced around.**

Measured, reproducibly, by `claude-code/probe/permission-host-probe.mjs` (evidence in
`probe/evidence/`, one real turn per run, ~$0.14):

1. The CLI sends the host a `control_request` with `subtype: "can_use_tool"` on its
   stdout stream, carrying `tool_name`, `display_name`, `description`, the full tool
   `input`, the `tool_use_id`, and `permission_suggestions` (the "always allow this
   domain / this rule" offer, in `addRules` shape, ready to be surfaced as a UI option).
2. It **parks the turn** until the host answers on stdin with
   `{type:"control_response",response:{subtype:"success",request_id,response:{...}}}`,
   where the inner response is `{behavior:"allow", updatedInput?}` or
   `{behavior:"deny", message}`.
3. **A 65-second park was held and then honoured** (`evidence/` has the 6s run; the 65s
   run was the same shape). No deadline fired. The CLI's own embedded docs say the
   5-minute park deadline covers a dialog "forwarded to a remote client" and that
   "local-only permission prompts (no remote client) are unaffected" — consistent.
4. **A `deny` message reaches the model verbatim** as the tool_result error text, so a
   human's stated reason for refusing is visible to the worker rather than being flattened
   into a generic refusal.

So Claude Code's approval is the SAME async shape as OpenCode's `permission.asked`: an
`ask` row can sit `pending` indefinitely and be answered later. The two harnesses do not
need different plumbing here, and `asks.auto_close_at` is the supervisor's own policy
choice rather than a race against a harness timeout.

**The one load-bearing flag, and why the spike missed it.** `--permission-prompt-tool
stdio` is what routes the decision to the host. `--permission-prompts host` is already
the default and is NOT sufficient; `--await-initialize` is not required (it only makes the
CLI block on the host's `initialize` during startup). Without the flag the CLI **auto-denies
and tells the model "you haven't granted it yet"** — no error, no warning, nothing on
stderr, the turn just proceeds having quietly refused the tool. That negative result is
captured in `evidence/02-negative-auto-denied.txt` precisely because it is
indistinguishable from "this harness cannot do async approval", which is how the Phase 0b
spike reached the conclusion PLAN.md then wrote down.

Two traps met while measuring, both of which produced a *wrong* negative first:

- **A working-directory refusal is not an ask.** A `Read` outside the cwd is denied with
  `decision_reason_type: "workingDir"` and is never routed to the host at all. It looks
  like the host channel is dead when it is only a hard rule being applied. Use a genuine
  ask class — WebFetch on a fresh domain is the cleanest: no sandbox, no path rule.
- **Do not run the probe with a cwd under `/tmp`.** On macOS `/tmp` symlinks to
  `/private/tmp`, the tool sandbox compares resolved paths, and a write inside the cwd is
  refused with a message naming that same cwd as allowed. Confusing, and unrelated to
  permissions.

**A side effect to decide about, not to wire blind:** with `--permission-prompt-tool stdio`
the session's tool list *gains* `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` and
loses nothing (`evidence/03-tool-list-diff.txt`, 107 shared entries, diffed one flag
apart). Those are further host round-trips. `AskUserQuestion` in particular is a worker
asking a *question* — which is `asks` arriving by a second road, with a different wire
shape (`request_user_dialog`, which unlike `can_use_tool` DOES have a park deadline:
5 minutes by default, `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` / the `"never"` setting value
override it). Enabling the permission channel enables these whether or not the supervisor
handles them, so a run can now block on a dialog nothing is listening for.

## Phase 2 (2026-09-07): a worker's QUESTION rides the same channel as its approval

Measured by `claude-code/probe/dialog-host-probe.mjs` (`probe/evidence/04-*`, `05-*`).
This was worth measuring because the CLI's embedded docs describe a *separate*
`request_user_dialog` control request with its own `dialog_kind`, its own opaque payload,
its own `supportedDialogKinds` declaration on `initialize`, and — unlike `can_use_tool` —
its own 5-minute park deadline. The obvious guess is that `AskUserQuestion` uses it.
**It does not.**

`AskUserQuestion` arrives as an ordinary `can_use_tool` control_request, distinguished only
by **`requires_user_interaction: true`**, with the model's whole question structure
(`questions[].question`, `header`, `options[].label/description/preview`, `multiSelect`) as
the tool `input`. Declaring `supportedDialogKinds` had no effect on it, and no
`request_user_dialog` was ever sent — across two runs the only subtype the CLI sent was
`can_use_tool`.

**Answering it is not the same as allowing it, and the difference is silent.** Replying
`{behavior:"allow"}` — the correct answer for a normal tool — runs the tool with no
answers, and the model is told **"The user did not answer the questions."** It then carries
on having learned nothing, which reads as the human ignoring it rather than as a protocol
mistake by us (`evidence/04-askuserquestion.txt` captures exactly this). The answer must
ride back as `updatedInput`:

    { behavior: "allow",
      updatedInput: { ...originalInput, answers: { "<exact question text>": "<option label>" } } }

Keyed by the **exact question text**, valued by the **option label**. Done that way the
model gets `Your questions have been answered: "..."="Spaces". You can now continue with
these answers in mind.` (`evidence/05-askuserquestion-answered.txt`).

**Why this is good news for the design.** One channel, one `asks` table, one wire command
answers both "may I run this tool" and "which of these do you want" — on both harnesses,
since OpenCode's `permission.asked` is already this shape. `request_user_dialog` needs no
implementation in Phase 2: the only `dialog_kind` that appears anywhere in the binary is
`refusal_fallback_prompt`, and NOT declaring it degrades that flow to the classic refusal
error, which is the pre-existing behavior. Leave it undeclared and say so.

### Protocol facts worth having written down before touching this code

Read out of the CLI's own embedded protocol documentation, not guessed:

- **`initialize` is optional** and normally the first stdin line; the first user message
  initializes with defaults. A later `initialize` (a client joining) is answered with
  current state, but one-time session setup is **not** re-applied.
- Its response carries **`pending_permission_requests`** (and a dialog sibling) "so a
  client joining an already-initialized session learns about in-flight prompts" and can
  re-arm them. Useful for a reconnecting reader — **not** a supervisor-restart recovery
  path, because a restarted supervisor no longer holds the child's stdio pipes at all. An
  approval parked on a run whose supervisor died is unanswerable by anyone; reconciliation
  closing an orphan's asks is therefore right, not merely convenient.
- **`control_cancel_request`** exists and either side may send it to withdraw its own
  in-flight request — the CLI uses it for "a pending `can_use_tool` prompt after the turn
  was interrupted, or one that another client already answered". So `interrupt`/`stop`
  must expect a parked ask to be withdrawn *by the harness*, and the supervisor may itself
  withdraw one. There is no reply to a cancel.
- There is a **keepalive** control request with no payload that either side may send at any
  time, "for example while a long-running control request is in progress" — precisely the
  parked-approval case. Receivers **must ignore** it. An adapter that treats an unknown
  control_request as an error will start erroring the moment an ask parks for a while.
- **Closing stdin tells the CLI to finish the current turn and exit** — so stdin is not a
  channel we may casually end while an ask is outstanding.

## Phase 2 (2026-09-07): a spawned worker inherits the developer's whole Claude Code environment

Noticed in the real-pane slice's captured transcript
(`../../pane/evidence/01-real-pane-slice.txt`), not by reading code. The worker answered the question
it was asked and then added, unprompted:

> One session note unrelated to your request: the `project-manager` MCP server needs authorization
> before its tools can be used, and this session can't run the OAuth flow.

Nobody asked it about MCP servers. The spawned session had loaded **the developer's own global
configuration** — MCP servers, `SessionStart` hooks (claude-mem's ran in every probe), skills,
plugins — because `spawnManaged` passes the ambient environment through and the CLI reads its usual
settings sources. The probes showed the same thing from the other side: a `SessionStart` hook fired
before any of our prompts did.

**Why this matters more than it looks.** Three separate costs, and the design has not decided about
any of them:

1. **Tokens and latency.** Every worker pays for the developer's MCP tool definitions and hook
   output in its context, on every session, whether or not the task needs them. PLAN.md section 8
   makes context economy an architectural pillar and puts the CTO at ~15k tokens; a fleet of workers
   each silently carrying an unrelated MCP catalogue is the same problem one layer down.
2. **Behaviour.** A hook that injects "here is what you were doing last time" into a *fresh* worker
   is actively wrong for a dashboard that manages worker identity itself (PLAN.md section 2: a worker
   is durable, a run is not).
3. **Reproducibility.** Two machines with different global config produce different workers from the
   same task, which makes any "it worked for me" report unfalsifiable.

**Was not fixed when this was first written**, because the right answer is a design decision rather
than a patch. **It is decided and built now — see the next section.** The guess recorded at the time
("a dashboard-managed worker declares its environment explicitly and inherits nothing by default")
turned out to be half right: workers do declare, but the default is *project-only*, not *nothing*.

## Phase 2 (2026-09-07): the environment decision, measured (item 2)

**`adapters/claude-code/worker-env.js` is the decision; `probe/worker-env-probe.mjs` is the
measurement; `probe/evidence/08-worker-env-matrix.txt` and `09-setting-sources-project.txt` are the
captured runs.** Read the module header before changing any of it — it records why each rejected flag
was rejected, and each reason is a measurement rather than an opinion.

**The probe is FREE — no tokens, no model call**, which is worth knowing because every other probe in
that directory costs real money. Two measurements make it free: `system`/`init` does **not** arrive on
a host `initialize` alone (sending only that yields hook events and a `control_response`, then nothing
for 25s), but it **does** arrive ~5.4s in and **before the model is called**. So the probe sends a
one-token message, waits for `init`, and SIGKILLs the process the moment it lands. If a future CLI
reorders those the probe starts costing money, so it carries a `MODEL CALL HAPPENED BEFORE INIT` guard
rather than letting that change quietly.

**The measured table** (`claude` 2.1.263, in a directory whose own `.claude/settings.json` defines 1
`SessionStart` hook, while the developer's global config defines 2 hooks and 6 MCP servers):

| appended to the adapter's argv | hooks | mcp | tools | slash |
|---|---|---|---|---|
| *(nothing — the old behaviour)* | 3 | 6 | 110 | 97 |
| `--setting-sources=` `--strict-mcp-config` | 0 | 0 | 24 | 41 |
| **`--setting-sources=project` `--strict-mcp-config`** | **1 (the project's own)** | **0** | **24** | **41** |
| `--strict-mcp-config` alone | 3 | 0 | 24 | 95 |
| `--safe-mode` | 0 | 0 | 24 | 41 |
| `--bare` | 0 | 0 | **3** | 41 |
| `--restricted` `--strict-mcp-config` | 0 | 0 | 22 | 41 |

**The decision: `--setting-sources=project --strict-mcp-config` by default**, as `envProfile:
'project'`. A repo's `.claude/settings.json` is checked into git, so it is identical on every machine
and reviewed like code: it is exactly as reproducible as inheriting nothing, while keeping the
conventions and permissions that repo already decided on. `.claude/settings.local.json` is the `local`
source — gitignored, machine-specific, and therefore the one thing that would make "it worked for me"
unfalsifiable; no profile can reach it and a caller has to name it explicitly.

**Two flags, two INDEPENDENT axes.** `--setting-sources` governs hooks/skills/plugins/slash
commands/permissions; `--strict-mcp-config` governs MCP servers only. Measured separately:
`--strict-mcp-config` alone took MCP to 0 while leaving **all 3 hooks firing and 95 slash commands
loaded**. Do not read the table as one "config" dial — turning one off is not turning the other off.

**Three flags rejected, each for a measured reason:**

1. **`--bare` leaves 3 tools** — `Bash`, `Edit`, `Read`. No `Write`, no `Grep`, no `Glob`, no `Task`.
   That is not a worker that can do the job. **And** its help says auth becomes strictly
   `ANTHROPIC_API_KEY`/`apiKeyHelper`, with OAuth and the keychain never read: it started on the
   machine this was measured on **only because that machine uses Bedrock**, so shipping it would
   break every subscription/OAuth user. Two independent disqualifications, and the tool count is the
   one that would have been noticed late — a worker with no `Write` fails at the task, not at startup.
2. **`--safe-mode` reaches the same numbers** as the chosen default but is documented as a
   *troubleshooting* switch for a broken config, and drops one built-in agent. "Disable all
   customizations" is a blunt instrument whose meaning is free to change; two named flags say what we
   actually want and will keep meaning it.
3. **`--restricted` is genuinely interesting and deliberately deferred.** It removes `Bash` and
   `WebFetch` (24 → 22 tools), which maps onto a reviewer/QA role that should not run commands. Not
   shipped: there is no evidence yet that any role's failures are Bash-shaped, and a role/profile
   matrix built before that evidence multiplies what has to be reasoned about. `PROFILES` is the seam.

**An invalid declaration throws instead of defaulting.** Measured: the CLI itself exits 1 with
`Invalid setting source: bogus. Valid options are: user, project, local`, so a silent fallback would
be hiding a spawn that was going to fail anyway — and, worse, would be the same silent-failure shape
as the absent `--permission-prompt-tool` that produced this project's biggest wrong conclusion.

**The `=`-joined argv form** (`--setting-sources=project`, and `--setting-sources=` for the empty
list) is used because it is what Claude Code's **own** disposable sub-sessions use — observed in the
argv of a live sidecar: `--setting-sources= --strict-mcp-config --permission-mode dontAsk
--no-session-persistence`. Both forms were measured to work. That sidecar also names
**`--no-session-persistence`**, which is the flag preflight cleanup (PLAN.md 12.1) wants: worth
knowing before that item is built.

**The risk this does NOT remove, and the guard.** A repo's committed `settings.json` can carry hooks
or loose permissions written for an interactive human on their own laptop, and a worker now inherits
those **by design**. Sandboxing further would throw away the signal the choice exists to keep, so
instead every run emits a **`worker.env`** event recording the profile, the resolved sources, and the
`.claude/settings.json` files actually in effect with a digest of each. When a worker behaves oddly in
three weeks, the settings that shaped it are one grep away instead of a guess about a machine's global
state. The chain **walks upward** from the cwd, because settings resolution does: in this repo
`custom-team-dashboard/` has no `.claude/` of its own and its parent does, so recording only
`cwd/.claude/settings.json` would report "no project settings" for a worker that has them. A digest,
not the contents — a settings file can hold secrets and this record goes to the event log.

**Evidence:** `test/test-worker-env.mjs` (13 pure cases, no spawn/tokens), 5 new cases in
`test/test-claude-code-adapter.mjs` asserting the argv that actually reached a process, and
`runtime/test/_mutate-worker-env.mjs` — **12 mutations, all 12 observed failing at the named case**.

## Phase 2 (2026-09-07): the OpenCode side of the environment decision — measured, and it is NOT the same shape

The Claude Code decision above left one thing open on purpose: two of three reviewers refused to call
the OpenCode adapter's lack of environment pinning a defect, on the explicit grounds that **nobody
had measured whether `opencode` has an equivalent mechanism**. That is now measured, on
`opencode 1.18.29`, by starting real `opencode serve` processes in an EMPTY directory and reading
their own `GET /config` back. Probe: `opencode/probe/opencode-env-probe.sh` (free — no model call, no tokens); captured runs:
`opencode/probe/evidence/12-opencode-env-matrix.txt`.

**The problem is real and slightly worse than Claude Code's.** In an empty directory a pooled server
loads the developer's global `~/.config/opencode/opencode.json`: **8 MCP servers, 13 custom agents,
2 plugins, 20 agents at `/agent`**.

**`opencode serve` has NO config flag of any kind** — no `--setting-sources`, no
`--strict-mcp-config`, no `--config`. `--pure` exists and is plugin-scoped only.

| what was set (empty cwd) | mcp | agents in config | plugins | `/agent` |
|---|---|---|---|---|
| *nothing (today's behaviour)* | 8 | 13 | 2 | 20 |
| `OPENCODE_DISABLE_PROJECT_CONFIG=1` | 8 | 13 | 2 | 20 |
| `OPENCODE_CONFIG=<file with {}>` | 8 | 13 | 2 | 20 |
| `OPENCODE_CONFIG=<file with {"mcp":{},"agent":{},"plugin":[]}>` | 8 | 13 | 2 | 20 |
| `OPENCODE_CONFIG_CONTENT={}` | 8 | 13 | 2 | 20 |
| `OPENCODE_CONFIG_DIR=<empty dir>` | 8 | 13 | 2 | 20 |
| `OPENCODE_PURE=1` | 8 | 13 | 2 | 20 |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_EXTERNAL_SKILLS=1` | 8 | 13 | 2 | 20 |
| **`XDG_CONFIG_HOME=<empty dir>`** | **0** | **0** | **0** | **7 (built-ins only)** |

**`XDG_CONFIG_HOME` is the only lever that works, and it is not OpenCode's own.** Every
`OPENCODE_*` variable that looks like it should pin config changed **nothing** — including
`OPENCODE_CONFIG` pointed at a file that explicitly sets `mcp`, `agent` and `plugin` to empty. The
binary contains all of those variable names, so they exist; they simply do not suppress the global
cascade. Verified twice for the one that works.

**A REVIEWER'S MECHANISM DID NOT REPRODUCE, and the mechanism was the whole point.** `big-pickle`
was asked to decide this question and reported: *"The **only** real pin is `OPENCODE_CONFIG=<file>`,
verified to override the base keys."* Measured, `OPENCODE_CONFIG` does nothing observable at all —
not with `{}`, and not with the keys explicitly emptied. Its **decision** was sound and is what
shipped; its stated mechanism was wrong. **Third time in this project** that a reviewer has been
right about the conclusion and wrong about why (see `review-three/group5-verdicts.md` for the other
two), and the standing rule earned its keep again: acting on the stated mechanism would have shipped
an `OPENCODE_CONFIG` pin that pinned nothing, with a `worker.env` record asserting it had.

Also worth knowing, found on the way: **OpenCode's session store is global, not per-directory.**
`GET /session` on a server started in a fresh empty directory returned sessions belonging to other
projects entirely. That matters for preflight cleanup (PLAN.md 12.1) — "delete the session" is not
scoped by the directory the preflight ran in.

### What shipped, and why it is not a pin

**Decided: do NOT add a per-run environment declaration to the OpenCode adapter.** This is
`big-pickle`'s call and it is right, for a reason that has nothing to do with the missing flags:

> This adapter **pools one `opencode serve` per `cwd`** and multiplexes every run in that directory
> onto it. An environment is therefore a property of the **server**, not of a run. A `spec.envProfile`
> could only ever apply to whichever run happened to start the server, and the record would assert an
> environment the other runs' process never had.

That is the same defect class the cross-model review just found in the Claude Code guard, where the
record named a settings file the CLI provably never read. So two things shipped instead:

1. **`start()` REFUSES `envProfile` / `settingSources` / `mcpConfig`** rather than ignoring them.
   Silently ignoring is the worse option by a distance: the caller believes the worker is pinned. The
   error says why, and says what is recorded instead.
2. **A server-scoped `worker.env` event** recording what the pooled server *actually* loaded, read
   back from its own `/config`. It is deliberately the **outcome**, making it the OpenCode
   counterpart of Claude Code's `session.init` rather than of `worker.env`'s intent half — there is
   no intent half here. Best-effort, and **a failed read is recorded as a failure, never as an empty
   environment**: "we could not ask" and "it loaded nothing" are opposite facts, and the second is
   exactly what a correctly pinned server looks like.

### A HARD REQUIREMENT that constrains any future pin

**The `amazon-bedrock` model roster — `luna`, `sol`, `terra`, `opus` and the rest — must ALWAYS be
reachable through this adapter.** They are needed for cross-model review and sometimes for coding,
which makes this a product requirement rather than a convenience. The earlier note here called them
"irrelevant for a worker"; **that was wrong** and is corrected.

Those agents are defined in the developer's **global** `~/.config/opencode/opencode.json`, which is
exactly the file a `XDG_CONFIG_HOME` pin removes. So an empty-config-dir pin would silently delete
the models the project depends on: measured, `/agent` drops from **20 agents to 7 built-ins**.

**The measured shape a pin must take, if one is ever added.** The global config's keys are
independent, so the roster and the MCP servers can be separated:

| `XDG_CONFIG_HOME` points at | mcp | agents in config | `/agent` |
|---|---|---|---|
| *(unset — today)* | 8 | 13 | 20 |
| an EMPTY dir | 0 | 0 | **7 — roster GONE** |
| a **CURATED** dir: `agent` + `provider` + `model`, `mcp`/`plugin`/`skills` omitted | **0** | **13** | **20** |

So a curated dir gets both things: zero MCP servers *and* the full roster. **`provider` is
load-bearing** — it is what registers the `amazon-bedrock` model IDs the agents point at, so
carrying `agent` without it yields a roster of aliases to models the server does not know.

Two further conditions on any such pin: the **pool key must include it** (`big-pickle`'s F2), or two
runs wanting different environments race for one server; and it must not carry `mcp`, which is the
whole point. In its favour, and unlike Claude Code's `--bare`: OpenCode's credentials live in
`~/.local/share/opencode/auth.json`, i.e. under `XDG_DATA_HOME`, so a `XDG_CONFIG_HOME` pin does
**not** break auth.

**Guarded, not just written down.** `test-opencode-adapter.mjs` asserts the adapter passes the
ambient `XDG_CONFIG_HOME` through untouched and sets none of `OPENCODE_CONFIG`/`_DIR`/`_CONTENT`.
That check is machine-independent — it tests passthrough, not the developer's actual roster, so it
does not fail on a machine with no custom agents. Mutation **E20** pins `XDG_CONFIG_HOME` at a
nonexistent directory (the plausible future "fix") and is caught at that case.

**Evidence:** 4 new cases in `adapters/opencode/test/test-opencode-adapter.mjs` (14 total), a
`/config` and a `/debug/spawn-env` route on the fake server, and mutations **E17-E20** in
`runtime/test/_mutate-worker-env.mjs`, each observed failing at its named case. One of those cases
first failed for the wrong reason and is worth remembering: the failure-injection env var is read by
the **server** process, and the pool is keyed by `cwd`, so reusing a shared cwd reused a server
started before the flag was set. It needs a fresh cwd. Same "policy set after the loop was already
running" race the real-harness approval slice documents.
