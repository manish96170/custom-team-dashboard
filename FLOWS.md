# Flows, Diagrams & Keybindings

## 1. Task state machine

```mermaid
stateDiagram-v2
    [*] --> created
    created --> starting: harness/model assignment confirmed (PLAN.md section 11)
    starting --> start_failed: adapter reports spawn failure
    starting --> planning: run confirmed live
    planning --> implementing
    implementing --> awaiting_review: dev opens for review
    implementing --> blocked: unresolved ask created (PLAN.md section 7) -- only implementing generates an ask, see PLAN.md section 6
    blocked --> implementing: ask answered
    awaiting_review --> fixing: reviewer requests changes (PLAN.md section 13)
    fixing --> awaiting_review: fix pushed
    awaiting_review --> approved: every blocking dimension approved, quorum met, zero current-round change requests (PLAN.md section 13)
    approved --> merged: explicit human/senior gate (never automatic)
    planning --> failed: run errored
    implementing --> failed: run errored
    awaiting_review --> failed: run errored
    fixing --> failed: run errored
    planning --> cancelled: explicitly stopped
    implementing --> cancelled: explicitly stopped
    awaiting_review --> cancelled: explicitly stopped
    fixing --> cancelled: explicitly stopped
    start_failed --> created: explicit retry only, never automatic
    failed --> created: explicit retry only, never automatic
    cancelled --> created: explicit retry only, never automatic
    merged --> [*]
```

Note: state names use underscores here for mermaid syntax validity; the canonical value
in the database (PLAN.md section 3, section 6) is hyphenated (`awaiting-review`,
`start-failed`) — same state, rendering constraint only. `superseded`/`reopened`/
`merge-rejected` are deliberately not modeled yet (PLAN.md section 6) — add only when a
real flow needs them. `failed`/`cancelled` are reachable from any in-flight state
(planning/implementing/awaiting_review/fixing) by design — see PLAN.md section 6 for
why that's broader than `blocked`, which is implementing-only.

## 2. Session lifecycle (clean vs. kill)

```mermaid
flowchart TD
    A[Instruction arrives, e.g. from CTO chat] --> B{Phrasing explicit about destroying the worker?}
    B -- "no / casual, e.g. 'clean yourself'" --> C[Soft context clear via clearContext adapter call]
    C --> C1[Worker identity + task assignment persist]
    C --> C2[Anything in agentmemory/claude-mem survives]
    C --> C3[Only in-head conversation resets]
    B -- "yes, e.g. 'kill and restart Purus'" --> D[Kill + respawn]
    D --> D1[Old run terminated by the supervisor]
    D --> D2[New run started under the same worker identity]
    D --> D3[Anything not yet persisted is lost]
```

`clearContext` (PLAN.md section 4, section 7) is a real per-harness adapter capability,
not an assumption that "clear" means the same operation on every harness — proven in
the Phase 0b runtime spike before this flow is built.

## 3. Escalation ("ask") flow — the approval control plane

```mermaid
sequenceDiagram
    participant W as Worker (e.g. Purus)
    participant S as Supervisor (control socket)
    participant D as Database (asks table)
    participant U as Dashboard UI (tree pane)
    participant M as Manager (CTO / lead)
    W->>S: approval.request event / ask needed
    S->>D: insert ask row {id, runId, question, resolved:false}
    D->>D: task.state -> blocked (PLAN.md section 6)
    D->>U: badge appears on worker in tree ("?")
    U->>M: visible next time manager looks at tree
    M->>S: answer over control socket
    S->>D: persist answer, THEN set resolved=true (ordering matters — see PLAN.md section 7)
    D->>U: badge clears; task.state -> implementing
```

This is not a notification nicety — it is the mechanism that prevents a headless
session from deadlocking on a permission decision (PLAN.md section 7). It ships in the
first vertical slice (ROADMAP Phase 2), not deferred.

## 4. Onboarding a new harness

```mermaid
flowchart LR
    A["CTO chat: 'onboard agy'"] --> B[harnesses table: add row, status=pending-setup]
    B --> C[Adapter package installed, declares capability matrix]
    C --> D[Conformance suite runs: start/stream/interrupt/clear/exit-detect]
    D -- pass --> E[status=active]
    D -- fail / no capability matrix declared --> F[heartbeatMechanism=wrapper, marked degraded]
    E --> G[New runs on agy now go through the supervisor like any other harness]
    F --> G
```

Runtime research-and-generate of a brand-new adapter (the original flow) is backlog
(PLAN.md section 9) — v1 registers pre-installed, versioned, conformance-tested
adapters only.

## 5. Keybinding -> situation -> result table

This is the reference for "when you press this and the situation is this, it shows
this." All keybindings act on the **currently focused pane context** (a team selected
in the top bar + tree), not globally.

**For the actual rendered screens this table describes — real captured frames, not
mockups, plus a gap list of what's in this table but not yet wired — see
`TUI-GUIDE.md`.**

| Key | Situation | Result |
|---|---|---|
| `<-` / `->` or `h` / `l` | Top team bar has more teams than fit on screen | Move selection across the team bar |
| Click a team in top bar | — | That team becomes active; tree + panes scope to it |
| Click a worker in tree | — | Opens that worker's pane directly, full focus |
| Click a task node in tree | Task type = `dev` | Shows last-active dev run pane (most-recent-message, unless pinned) |
| Click a task node in tree | Task type = `review` | Shows dev pane + one reviewer pane (parent by default) side by side |
| Click a worker, then `m` | — | Pins that worker's run as `mainWorkerId` for the task — overrides most-recent-message default until unpinned |
| Click a worker, then `v` | — | Opens a quick effort/variant picker scoped to that one run (PLAN.md section 11) — Claude Code's "effort" and OpenCode's "variant" shown as one generic control; changes the running instance only, not the stored default |
| Click the Requests panel, then `h` | Requests panel focused (backlog feature — PLAN.md section 14.4) | Hides the panel, returns to default pane layout (see section 6a — same `h` key, scoped by focus, not a collision) |
| `t` (BUILT 2026-09-11 — PLAN.md section 5) | Anywhere | Hides/shows the TREE panel — pane area expands to fill the freed 15% width when hidden. Selection (`selectedNodeId`, `treeScroll`) is preserved while hidden, same "hide is a view change, not a reset" rule section 7 already applies to hiding a team from the top bar. |
| `R` (BUILT 2026-09-11 — PLAN.md section 14.4) | Anywhere | Shows/hides the Requests panel regardless of pending count — unlike the row above, works even while requests ARE pending, to reclaim space temporarily. **Corrected 2026-09-13 (finding 41): auto-reappearance only happens on an empty-then-new-batch transition — a new request landing while an EARLIER one is still pending and the panel is hidden stays invisible too**, see §6a's own note below for the exact rule. Capital, distinct from lowercase `r` (toggle all reviewers) — this codebase's own `decodeKey` returns a shifted letter as its own string, verified before picking it. |
| Click a request too long to fit inline, or `return` on it (BUILT 2026-09-11 — the UI half; server-side Accept/Decline is still backlog, PLAN.md section 14.4/FLOWS section 6c) | Requests panel focused | Pane area + tree HIDE entirely (not fullscreened); full-width Request Detail view shows the whole message plus `[a] Accept` `[d] Decline` |
| `a` (BUILT 2026-09-11, UI half — section 6c) | Request Detail view open | Accept — hands off to `app.js` as `pendingRequestDecision` (same split `pendingChat` already uses); today a status-line no-op, since there is still no wire command to create the task (section 6b) — restores the pane area exactly as it was regardless |
| `d` (BUILT 2026-09-11, UI half — section 6c) | Request Detail view open | Decline — same handoff, restores the pane area exactly as it was. **Deliberately reuses `d`**, scoped by focus like `h`'s existing panel-vs-team-bar split above — while the Request Detail view is focused, `d` cannot also mean "toggle direct chat" (there is no worker pane to target), so the two meanings never compete. |
| `esc` (BUILT 2026-09-11 — section 6c) | Request Detail view open | Back, no decision made — restores the pane area exactly as it was |
| `1` | Review pane open | Toggle Reviewer 1 pane on/off |
| `2` | Review pane open | Toggle Reviewer 2 pane on/off |
| `p` | Review pane open | Toggle Parent-reviewer pane on/off |
| `r` | Any reviewer pane visible | Toggle **all** reviewer panes off at once ("just show me the coder") |
| `r` (again) | All reviewer panes hidden | Restore last-shown reviewer pane state |
| — | All reviewer panes hidden (via `r` or individually) | Dev pane auto-expands to fill width — no dead space |
| `f` | Any pane focused | Fullscreen that pane |
| `f` (again) | Pane is fullscreen | Return to split/group view |
| `g` | — | Toggle grouped/split view vs. single-pane view |
| `d` | A worker's pane is focused | Toggle bottom bar target from CTO chat to direct chat with that worker (`> Purus (direct)`) |
| `d` (again) | Bottom bar targeting a worker directly | Return bottom bar target to CTO |
| `/` | Anywhere | Focus jumps to the bottom chat bar |
| chat: `"hide <team>"` | Team currently shown in top bar | Sets `hiddenFromTopBar: true` — view filter, not delete |
| chat: `"move <name> -> <team>"` | — | Typed supervisor command (`moveWorker`) — no drag-and-drop, no separate agent (PLAN.md section 16) |
| chat: `"onboard <harness>"` | New CLI not yet registered | Triggers onboarding flow, see diagram 4 |
| chat: `"@<nickname> <task>"` (adhoc) | Single worker, no team ceremony needed | Creates a `type: adhoc` task, `source: manager-direct` or `direct-message`, starts via the supervisor's normal `start()` call (PLAN.md section 4, section 10) |

## 6. Layout wireframe (static reference)

```
+- TEAMS (online) --------------------------------------------- <- -> -+
|  [Vite Migration]  [Biome Lint]  [Stripe Fix]  [Checkout] ...       |
+-----------+-----------------------------------------------------------+
| TREE 15%  |  PANE AREA                                               |
| > team    |  +-------------------+---------------------------+      |
|   lead    |  |  DEV PANE          |  REVIEW PANE (toggleable) |      |
|   |-dev   |  |  (last-active dev  |  Parent reviewer or       |      |
|   |-rev1  |  |   run, or          |  Reviewer 1 / Reviewer 2  |      |
|   `-rev2  |  |   pinned "main")   |  (pick via bottom toggle) |      |
|           |  +-------------------+---------------------------+      |
+-----------+-----------------------------------------------------------+
| [1] rev1  [2] rev2  [p] parent-rev  [r] all-rev  [f] fullscreen      |
| [g] group/split   [h/l] switch team   [d] direct-chat  [/] focus chat|
+-------------------------------------------------------------------------+
| > (CTO chat -- always resident)                                       |
+-------------------------------------------------------------------------+
```

## 6a. Requests panel (backlog — PLAN.md section 14.4; top-left, height configurable, default ~30% —
raised from an earlier ~12% draft, 2026-09-11: a request's raw text doesn't fit legibly in a
line-height strip)

```
+- TEAMS (online) --------------------------------------------- <- -> -+
|  [Vite Migration]  [Biome Lint]  [Stripe Fix]  [Checkout] ...       |
+-----------+-----------------------------------------------------------+
| REQUESTS ~30% (configurable) --------------+  TREE 15% resumes below |
| [Accepted] [Declined] [Completed] [Team Requests]                   |
| > @nj in #your-mr-channel: "@you please review !4821 before         |
|   standup, this one touches the payment webhook so it's not..."     |
+-----------+-----------------------------------------------------------+
| TREE 15%  |  PANE AREA (unchanged from section 6)                    |
| ...       |  ...                                                     |
+-----------+-----------------------------------------------------------+
```

- Collapsed by default when there are zero pending requests; appears the moment one
  lands. `R` (BUILT 2026-09-11 — not `h`, which already means "move teams" outside this panel's focus)
  shows/hides it independent of pending count, so a human can reclaim space temporarily without marking
  anything read.
  **CORRECTED 2026-09-13 (review-sol-2026-09-13.md finding 41) — "a new request landing while manually
  hidden still auto-reappears" is OVERSTATED as written.** `withRequests()`'s actual rule un-hides only
  when the pending list transitions THROUGH EMPTY: if request A is hidden and still pending when request
  B arrives, the panel stays hidden — B is invisible too, despite this rule's original intent that a new
  request should never be silently swallowed. It reliably un-hides on the next empty-then-new-batch
  transition, not on every individual new arrival while something else is still pending.
- When a request's raw message is shown, the button row may collapse to keep the whole
  panel within its configured height rather than growing the panel.
- **A request too long for the panel's width expands to a full detail view instead of truncating** —
  see 6c below. This is a different operation from clicking a shorter one that already fits inline.

## 6c. Expanding a long request — the pane area hides, not just resizes

```
BEFORE (request selected, but not yet expanded — panel shows a truncated preview):
+- TEAMS ---------------------------------------------------------------+
+- REQUESTS ~30% ---------------------------------------------------------+
| > @nj in #your-mr-channel: "@you please review !4821 before stand…" |
+-----------+-------------------------------------------------------------+
| TREE 15%  |  PANE AREA (dev/review panes, as normal)                  |
+-----------+-------------------------------------------------------------+

AFTER clicking that truncated request (or pressing return on it):
+- TEAMS ---------------------------------------------------------------+
+- REQUEST DETAIL (full width, replaces TREE + PANE AREA entirely) -----+
|  @nj in #your-mr-channel, 14:02                                       |
|  "@you please review !4821 before standup, this one touches the       |
|   payment webhook so it's not just a lint fix, can you take a look    |
|   before the meeting? there's also a flaky test in the same file"     |
|                                                                         |
|  [a] Accept    [d] Decline                                            |
+-------------------------------------------------------------------------+
| footer: [esc] back                                                    |
+-------------------------------------------------------------------------+
```

The coding/review pane area and the tree are HIDDEN entirely here, not fullscreened-to-one-pane — `f`
(FLOWS §5) fullscreens whichever pane already has focus; this is a different operation, because a
request is not a pane. `esc` (or Accept/Decline resolving it) restores the pane area exactly as it was
before — same "restore what was there" rule `r`'s reviewer-restore already follows, not a reset to
whatever the type-driven default would pick.

## 6b. Review-request lifecycle (backlog)

```mermaid
stateDiagram-v2
    [*] --> pending: mention in a watched channel
    pending --> accepted: human clicks Accept in Requests panel
    pending --> declined: human clicks Decline
    accepted --> completed: human marks Complete once review work is done
    declined --> [*]
    completed --> [*]

    note right of accepted
      Accept is what creates the new
      task (source: slack-inbound).
      A mention alone never spawns
      work on its own.
    end note
```

Team-requests (sprint changes, ticket-ID asks, reassignment) get their own button and
queue, same pending/accepted/declined shape — the resolution logic for that bucket is
intentionally left open per PLAN.md section 14.2 ("more we can leverage later").

**Self-DM exception, two gates** (PLAN.md section 14.2): if the message is in the
owner's own DM with the bot *and* sent by the owner (gate 1), it skips straight to task
creation — `source: "slack-inbound-self"` — never enters `pending`. It still lands in
`created` (PLAN.md section 6), waiting on harness/model assignment, unless the message
*also* contains a trigger phrase (gate 2) — "start right now", "start right away",
`srn`, or `sra`, whole-word matched — in which case it auto-assigns defaults and starts
immediately. **Gate 2's auto-start cannot actually ship until PLAN.md section 14.6's
local DM-reading gate is fixed** — the originally specified password mechanism checks a
pull path (`conversations.history`) but Slack delivers DMs via a push event
subscription, so it never runs on the path it's meant to protect. This diagram
describes the intended behavior once 13.6 has a working replacement; do not build gate
2's auto-start against the old mechanism.

```mermaid
flowchart TD
    A[Inbound Slack message] --> B{DM channel AND sender is the owner?}
    B -- no --> D[Create request, status=pending -- goes through 6b above]
    B -- yes --> E{Contains trigger phrase: start right now / start right away / srn / sra -- whole word?}
    E -- no --> F[Create task, source=slack-inbound-self, state=created -- awaiting harness/model assignment]
    E -- yes --> G["Create task, source=slack-inbound-self, auto-assign default harness/model, start immediately (blocked on PLAN.md section 14.6 fix)"]
```
