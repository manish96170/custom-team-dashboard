---
name: custom-team-dashboard
description: Use when the user asks about the custom-team-dashboard supervisor's status — running tasks, workers, teams, orphaned processes, or when they want to start/inspect the daemon or attach its TUI. Examples: "what's my team doing", "is the dashboard running", "show me open tasks".
---

# custom-team-dashboard

A single-writer SQLite supervisor daemon (`supervisor/ipc/daemon.js`) that owns every
team/task/worker/run row and exposes them over a Unix control socket. There is
**no natural-language "CTO" routing layer yet** — that is Phase 6/8, unbuilt (see
`ROADMAP.md`/`domain/session-intent.js`'s own header for why). This skill does not
pretend one exists.

## What you can actually do today

- **Start the daemon**: `/dashboard` (this plugin's own command), or directly
  `cd supervisor && node ipc/daemon.js`.
- **Attach the TUI** (real interactive terminal app — the USER must run this
  themselves, never via a tool call): `node supervisor/tui/cli.js` (real daemon) or
  `node supervisor/tui/cli.js --demo` (zero-setup demo).
- **Inspect state directly** (read-only, safe): the daemon's SQLite database lives at
  `$SUPERVISOR_STATE_DIR/state.sqlite3` (or `$CTD_STATE_DIR`, a legacy alias), defaulting
  to `~/.custom-team-dashboard/supervisor/state.sqlite3` (`supervisor/paths.js`'s
  `stateDir()`/`dbPath()` — re-check that file if this ever seems wrong rather than
  trusting this note forever). You can open it read-only with `sqlite3
  ~/.custom-team-dashboard/supervisor/state.sqlite3 "SELECT id, title, state FROM
  tasks;"` (or similarly for `workers`/`teams`/`runs`) to answer a status question
  without touching anything.
- **Read the projected vault**, if the user has enabled it (`config/
  vault-projector.js`, off by default) — one markdown file per team/task/worker plus
  `Dashboard.md`, already human-readable.
- **Run the test suite** (`cd supervisor && npm test`) if the user wants to confirm
  the daemon's own code is healthy — this is a development check, not a runtime
  status check.

## What you must NOT claim or attempt

- Do not claim you can "assign work," "clear a session," or "kill and respawn" a
  worker through natural language yet — those are real, tested, CAPABILITY-GATED wire
  commands (`assignTask`, `resetSession`, etc.) reachable only through the control
  socket protocol (`supervisor/ipc/protocol.js`), which has no CLI or MCP front-end
  today. If the user asks for one of these, say so plainly and point at the real gap
  (no NL-to-command routing exists) rather than improvising a fake result.
- Do not attempt to drive the interactive TUI via the Bash tool — it needs a real tty.
- Do not write to the daemon's SQLite database directly under any circumstances — it
  is single-writer by design (`supervisor/lock/lock.js`); a second writer corrupts the
  WAL invariant the whole project rests on. Read-only queries only.
