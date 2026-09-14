# Custom Team Dashboard (working name)

A Claude Code / OpenCode plugin for running and watching a virtual team of named agent
sessions — leads, coders, reviewers, QA — from one screen, with a CTO-style chat as the
control point. **STATUS, updated 2026-09-14: Phases 0a-10 built** (supervisor daemon,
capability-based authorization, resource leases, MCP tool pooling with a per-role tool
allowlist, Slack outbound notifications, a read-only Obsidian vault projection) **and
Phase 11 (conservative harness onboarding) investigated and closed** — see
`ROADMAP.md`'s own status pointer and `HANDOFF.md`'s top header for the current,
authoritative picture; this paragraph is a summary, not the source of truth. **The CTO
chat itself does not exist yet** (Phase 6/8) — every capability below the chat layer
(assign, approve, clear, reset, onboard a harness) is a real, tested, capability-gated
command reachable over the control socket, but nothing routes plain language to it yet.
See PLAN.md / FLOWS.md for the full design.

## What this is for

If you're running many concurrent Claude Code / OpenCode sessions as a "virtual team,"
this gives you:
- One screen showing every team and every session, across both Claude Code and OpenCode.
- A CTO chat you talk to in plain language to assign work, ask "who's reviewing X," or
  clear a stuck session.
- Per-task panes that automatically show whoever is currently "on the hook" for a task
  (the coder, or the coder + whichever reviewer you're looking at).
- A single-writer supervisor + SQLite database as the single source of truth, so
  nothing that happens is invisible to the dashboard — including one-off DMs and
  things the manager did itself. (Earlier drafts used flat JSON files for this; a
  consolidated review of four independent AI architecture reviews rejected that as
  unsafe under concurrent writes — see PLAN.md section 3.)

## How to use it today

This repo is now also a real, installable Claude Code plugin (`.claude-plugin/`) — the
plugin manifest lives in this same repo, at this same commit; there is no separate
packaging step. Once installed:

1. Run `/custom-team-dashboard:dashboard` to start the supervisor daemon (or confirm
   it's already running). It will then tell you the exact command to attach the TUI
   yourself in your own terminal — the TUI is a real interactive terminal app and
   cannot be launched through a tool call. No CTO chat exists yet (see below); every
   other capability described past this point is design intent for Phase 6/8, not yet
   built.

## How you'll use it once the CTO chat exists (Phase 6/8, not yet built)

1. Group existing running sessions into a team by telling the CTO: *"make these
   sessions a team called Vite Migration."*
2. Click a team in the top bar to switch to it. The tree on the left (15% width) shows
   that team's structure; click a member to see their session directly, or click the
   team/lead to get the sensible default view for whatever's in progress.
3. Ask the CTO anything conversational — *"who is reviewing NJ's MR?"* — and get an
   answer without hunting through panes.
4. For a quick one-off task, DM a session directly (toggle with `d`) or just tell the
   CTO — *"@Purus fix the lint warning in checkout.ts"* — no team ceremony required.
   It still gets logged like everything else.
5. Use keybindings to control what's on screen — hide/show reviewer panes, fullscreen
   one pane, jump between teams. Full table in FLOWS.md, section 5.

## What it will never do (by design)

- **No autonomous merges.** Every merge needs an explicit human/senior approval, no
  matter how many reviewers signed off.
- **"Clean yourself" is never destructive by default.** It clears context; it does not
  kill and recreate a session unless you say so explicitly.
- **No drag-and-drop, no right-click.** Reassigning someone between teams is a typed
  command, not a mouse gesture — this is what keeps it buildable as a fast, keyboard-
  first TUI (see PLAN.md, section 19, for why).
- **Nothing happens off the record.** Direct messages, one-off adhoc tasks, and things
  the manager/CTO does itself all still write into the same registry as CTO-routed work.

## Documents in this directory

- `PLAN.md` — the full design: data model & persistence, control plane & runtime,
  layout, state machine, escalation rules, context economy, cross-tool harness
  onboarding, configurable reviews, Slack integration, distribution plan, and explicit
  guardrails/non-goals.
- `arch-reviews-now-not-needed/consolidated-full-review-claude-opus5-medium.md` — the
  architecture review that drove the 2026-09-04 runtime rewrite (supervisor + SQLite
  replacing the original JSON-file registry); read this for *why*, not just *what
  changed*. Archived (not deleted) because its findings are now incorporated into
  PLAN.md/ROADMAP.md/FLOWS.md — kept for a future session or agent to re-check against,
  not because there's outstanding work in it.
- `FLOWS.md` — diagrams (task state machine, session-clean-vs-kill, escalation flow,
  harness onboarding flow) and the complete keybinding -> situation -> result table.
- `ROADMAP.md` — the phased build order this project will follow.

## Open questions not yet settled

- Whether to ship Claude Code and OpenCode adapters as one plugin install or two.
- Exact Slack bot setup details for inbound `@mention` routing (outbound-to-channel is
  simple and scoped; inbound is the heavier, not-yet-detailed piece).
- Onboarding flow UX for a brand-new harness beyond "agy" as the working example.
We should delete test sessions after test complete as like for testing that model harness is working we are testing may be at session start or first prompt so we can delete test sessions so it will not mess with session history. Also if we are storing it somewhere but after test we should delete those session just used to test the connection between model and harness.