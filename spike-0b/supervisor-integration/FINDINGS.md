# Findings — Supervisor integration spike (2026-09-04/05)

All four remaining Phase 0b gate items proven with real evidence in this directory.
(Written by the parent session — the subagent that did this work was blocked by tool
policy from writing a file named `FINDINGS.md` itself; this is its report, verbatim.)

## 1. Real supervisor (`supervisor.js`)

Reuses `packaging-probe/lock.js`'s lazy-start scaffold unmodified, wires in
`../claude-code-adapter/adapter.js` and `../opencode-adapter/adapter.js` via a
`runId -> harness` routing map, over a newline-delimited-JSON Unix socket
(`start`/`sendInput`/`interrupt`/`stop`/`observe`/`list`/`answerApproval`).

## 2. Two concurrent real sessions (`demo-concurrency.mjs`)

One real Claude Code run and one real OpenCode run, both against a real 3-file
`testdir/`, driven simultaneously through the supervisor. Captured log
(`concurrency-evidence.log`) shows genuinely interleaved sub-second timestamps — e.g.
Claude Code's `turn.end` at `19:06:24.121` lands between two OpenCode
`assistant.delta` events at `19:06:23.902` and `19:06:24.231` — with `ps` confirming
both real OS processes (a `claude` stdin process and an `opencode serve` HTTP server)
alive at once.

**Real bug found and fixed**: the first attempt hung forever because nothing answered
OpenCode's `permission.asked` event. Fixed by adding a real `answerApproval` supervisor
command (not a demo-side workaround). Claude Code has no equivalent command since its
approval is a synchronous hook — calling `answerApproval` on a Claude Code run throws
rather than silently no-op'ing.

## 3. Restart recovery (`demo-crash-recovery.mjs`)

A real Claude Code run was left in-flight, the supervisor was `kill -9`'d (confirmed
via `ps`), then restarted. **Two real outcomes captured, not one** — this is a genuine
discovery beyond what was originally scoped:

- The orphaned Claude Code child died on its own (broken stdout pipe) once its parent
  (the supervisor) died — reconciled to `lost`.
- A repeat with OpenCode: its `serve` process **survived** being orphaned (it's an HTTP
  server, not a stdin-attached process — nothing about losing its parent stops it).
  Reconciled to a new, honest third state: **`orphaned-unmanaged`** — PID and start
  time verified as genuinely still alive, but with no adapter handle bound to it
  anymore. This is a real state the original two-state (`lost` / `finished`) model
  didn't anticipate. PLAN.md's reconciliation rule (section 4) needs a third bucket,
  not just two.

Neither run was ever silently marked `finished`.

## 4. Token telemetry

Claude Code's `result.usage` (already present in its JSON output, previously
discarded by the adapter) now flows into the `turn.end` event. OpenCode's SSE stream
was checked live (previously undocumented either way) and does carry a `step-finish`
part with the same token shape as its one-shot CLI — added as a new `usage` event. Real
captured values for both harnesses are in the run registry.

## Biggest remaining risk

Neither adapter's child processes are spawned detached, so a crashed *supervisor*
doesn't automatically kill its managed *runs* — a real orphaned process (like the
`opencode serve` above) keeps running and consuming resources with nobody managing it.
This spike didn't need to fix that to prove the reconciliation *logic* works, but
**Phase 1's real supervisor needs explicit process-group ownership and kill-on-lost**,
not just detection.
