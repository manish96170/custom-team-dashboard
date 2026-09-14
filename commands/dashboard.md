---
description: Start the custom-team-dashboard supervisor daemon and show how to attach the TUI
---

Start (or confirm already-running) the custom-team-dashboard supervisor daemon for this
machine, then tell the user exactly how to attach the interactive TUI themselves.

Do this:

1. Run `cd supervisor && node ipc/daemon.js &` disowned in the background (check first
   whether it's already running — the daemon takes a real single-instance lock at boot
   and exits loudly if another instance already holds it, so a second `node
   ipc/daemon.js` is a safe, cheap way to find out; if it exits immediately citing the
   lock, that means one is already running and that's a success, not a failure).
2. Report the daemon's actual status back (started fresh, or already running) — never
   claim success without having actually run the command and checked its result.
3. Tell the user: the TUI is an interactive terminal application and cannot be launched
   or driven through a tool call — they need to run it themselves in their own
   terminal:
   - `node supervisor/tui/cli.js` to attach to the real running daemon, or
   - `node supervisor/tui/cli.js --demo` for a zero-setup demo (starts its own
     in-process supervisor with a fake harness, two teams, three tasks, five workers —
     no daemon, no tokens, no real agent sessions).
4. Do NOT attempt to run the TUI itself via the Bash tool — it will hang waiting for a
   real tty and produce no usable output; only the daemon (a headless process) should
   ever be started this way.
