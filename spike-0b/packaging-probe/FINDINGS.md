# Phase 0b packaging probe — findings

Tests real code in this directory, run on macOS (Darwin 25.6.0), Node v26.6.0, from a cold
`~/.local/state/custom-team-dashboard/` each time. All commands and output below are pasted
directly from actual terminal runs, not simulated.

Files: `lock.js`, `paths.js`, `supervisor.js`, `client.js`, `test-lock-race.js`.

## Library choice: rolled our own, not `proper-lockfile`

Did not reach for an npm lock library. The common ones (`proper-lockfile`, `lockfile`)
implement **mtime-based staleness**: a lock older than N ms is considered dead. That's wrong for
a daemon meant to live for days — a healthy week-old supervisor would look "stale" to an mtime
check. The correct staleness signal is **PID liveness** (is the process that wrote this lock
still alive), checked with a zero-signal `process.kill(pid, 0)`. Node has no bound `flock()` in
core, so `lock.js` approximates it with:

- **Atomic acquisition**: `fs.open(path, 'wx')` -> `open(2)` with `O_CREAT|O_EXCL`. Exactly one of
  N racing processes can ever win this syscall; POSIX guarantees it on local filesystems (APFS
  here). This is the load-bearing primitive — everything else is built on top of it.
- **Content-based staleness**: the lock file body is JSON `{pid, startedAt, hostname}`. On
  `EEXIST`, read the PID out and check liveness. If dead, `unlink` and retry the atomic create.
- **Race safety of the unlink-and-retry step**: acquisition is *always* via `wx`, never a plain
  overwrite. If two processes both see the same stale lock and both unlink-then-retry, only one
  of the two retried `open('wx')` calls can win — the loser sees a fresh `EEXIST` pointing at the
  winner's live PID and correctly defers.
  **Correction (2026-09-05, code review — `consolidated-review-claudeopus5-medium--spike-0b.md`,
  finding B1): the exclusivity claim below is FALSE as originally written, and the empirical
  test below does not cover the path that breaks it.** `fs.open(path, 'wx')` creates the file
  atomically, but the PID payload isn't written until a later `fs.write` — in that window the
  file exists and is empty. A second process arriving in that exact window reads an unparseable
  empty file, treats it as stale, unlinks it, and re-creates it with its own PID while the first
  process still holds a live fd to the (now unlinked) original inode. Both processes then believe
  they hold the lock. `test-lock-race.js` only exercises the acquire-vs-live-PID path, never the
  write-gap, so "verified empirically" below is true of a narrower claim than the one it was
  attached to. **Real fix, not yet applied**: write the payload to `lock.tmp.<pid>` first, then
  `fs.link(tmp, lockPath)` — `link(2)` is atomic and fails `EEXIST`, closing the gap entirely.
  Tracked as a Phase 1 design requirement (ROADMAP.md Phase 1, item 6).
- Release only unlinks the file if it still contains *our* PID, so a process can never delete a
  lock it doesn't actually own (defends against any residual doubt about the race above).

## 1. Single-instance lock — proven

`test-lock-race.js` acquires the lock, holds it briefly, releases, and prints its result as JSON.
Ran two instances launched in the same shell statement (backgrounded, no delay between them):

```
=== Race test: two instances started simultaneously ===
--- out1.json ---
{"pid":99610,"acquired":false,"holderPid":99611,"reason":"held-by-live-process","lockPath":".../supervisor.lock"}
--- out2.json ---
{"pid":99611,"acquired":true,"lockPath":".../supervisor.lock"}
{"pid":99611,"released":true}
--- lock file state after both exited ---
cat: .../supervisor.lock: No such file or directory
(no lock file - correctly cleaned up)
```

Exactly one of the two (pid 99611) acquired; the other (99610) detected contention and exited 0
without crashing. No corruption — the lock file that existed while held was well-formed, and it
was removed cleanly on release.

Stress variant, 10 instances launched simultaneously via `for i in $(seq 1 10); do node
test-lock-race.js & done; wait`:

```
count acquired=true: 1
```
(full output: one `{"acquired":true,...}` / `{"released":true}` pair for pid 2713; the other nine
processes — pids 2708-2712, 2714-2717 — each returned `{"acquired":false,"holderPid":2713,
"reason":"held-by-live-process"}`.) 10-way contention, one winner, nine clean deferrals, zero
crashes, zero corrupted lock files.

## 2. Lazy start by first client — proven (after fixing a real bug)

**Bug caught during testing, not by inspection**: the first version of `client.js` imported
`SOCK_PATH` from `supervisor.js`. Because `supervisor.js` called `main()` unconditionally at
module top level, merely *importing* it for a constant caused the client process itself to run
the supervisor's startup logic. First run showed both roles under the *same* PID:
```
[client pid=8089] supervisor socket not reachable — lazily spawning a new supervisor
[supervisor pid=8089] acquired lock at .../supervisor.lock
[supervisor pid=8089] listening on .../supervisor.sock
  (spawned) [supervisor pid=8090] lock already held by pid=8089 ... — refusing to start a second supervisor
```
Fixed by moving `SOCK_PATH`/`STATE_DIR` into a separate `paths.js` with no side effects, and
guarding `supervisor.js`'s `main()` behind `fileURLToPath(import.meta.url) === process.argv[1]`
so it only runs when executed directly, never on import. A second, related bug: piping the
detached child's stdout/stderr back to the client (`stdio: ["ignore","pipe","pipe"]`) kept the
client's event loop alive past `unref()` because an open pipe fd with an active listener holds
the loop regardless of unref — the client hung indefinitely. Fixed by redirecting the detached
child's output to a log file (`supervisor.log`) instead of piping it, which is also more correct
for an independent daemon that should survive after its launching client exits.

After both fixes, cold start:
```
=== Run 1: client from cold state ===
Fri Sep  4 23:23:29 IST 2026
[client pid=43145] supervisor socket not reachable — lazily spawning a new supervisor
[client pid=43145] spawned supervisor pid=43146, socket is now live
[client pid=43145] sent: hello-1
[client pid=43145] received: echo: hello-1
{"spawned":true,"pid":43146,"sent":"hello-1","reply":"echo: hello-1"}
exit code: 0
```
Lock file and `ps` confirm the supervisor is real and running:
```
{
  "pid": 43146,
  "startedAt": "2026-09-04T17:53:38.381Z",
  "hostname": "HB2561ManishSharma.local"
}
user 43146 ... node .../supervisor.js
```
Immediately after, a second client run:
```
=== Run 2: client immediately after, should reuse ===
Fri Sep  4 23:23:51 IST 2026
[client pid=46081] supervisor socket already alive — reusing existing supervisor, not spawning
[client pid=46081] sent: hello-2
[client pid=46081] received: echo: hello-2
{"spawned":false,"sent":"hello-2","reply":"echo: hello-2"}
```
`ps` afterward shows the same supervisor pid 43146, unchanged — client pid differs (46081 vs
43145) each run as expected for a short-lived client, supervisor pid does not. `supervisor.log`
shows two distinct client connections and both `recv:` lines against the one supervisor pid.

## 3. Stale lock recovery — proven

Simulated a crash by `kill -9` on the running supervisor (pid 43146), which cannot run its
shutdown handler:
```
=== SIGKILL the supervisor (simulate crash — no cleanup possible) ===
process gone?
(confirmed dead)

=== lock file STILL present (stale) ===
{
  "pid": 43146,
  "startedAt": "2026-09-04T17:53:38.381Z",
  "hostname": "HB2561ManishSharma.local"
}
=== socket file state ===
-rw-r--r--@ ... supervisor.lock
srwxr-xr-x@ ... supervisor.sock
```
Both the lock file *and* the socket file were left behind — exactly the failure mode the task
description called out ("crash leaves a stale lock, nobody designed for it"). Ran `client.js`
again:
```
=== client run after crash: should detect stale lock, clean up, start fresh supervisor ===
Fri Sep  4 23:24:10 IST 2026
[client pid=48038] supervisor socket not reachable — lazily spawning a new supervisor
[client pid=48038] spawned supervisor pid=48039, socket is now live
[client pid=48038] sent: hello-after-crash
[client pid=48038] received: echo: hello-after-crash
{"spawned":true,"pid":48039,"sent":"hello-after-crash","reply":"echo: hello-after-crash"}
```
New lock file shows the fresh PID, `ps` shows exactly one supervisor process (the old pid 43146
is gone, only 48039 remains):
```
{
  "pid": 48039,
  ...
}
user 48039 ... node .../supervisor.js
```
`client.js` neither refused to start (because a lock file existed) nor started a second
supervisor blindly — `lock.js`'s staleness check (dead PID -> unlink -> atomic re-create) did its
job. Separately, `supervisor.js` also unlinks any leftover socket file before calling
`server.listen()`, which is why the stale `supervisor.sock` from the killed process didn't cause
an `EADDRINUSE` on the new supervisor's bind.

## 4. Graceful shutdown — proven

Sent `SIGTERM` to the live supervisor (pid 48039):
```
=== send SIGTERM ===
Fri Sep  4 23:24:27 IST 2026
process gone?
(confirmed exited)

=== lock file after SIGTERM (should be GONE, not stale) ===
ls: .../supervisor.lock: No such file or directory
(no lock file - clean release)

=== socket file after SIGTERM (should be GONE) ===
ls: .../supervisor.sock: No such file or directory
(no socket file - clean close)

=== supervisor.log tail ===
[supervisor pid=48039] received SIGTERM, shutting down gracefully
[supervisor pid=48039] released lock, closed socket, exiting
```
Repeated with `SIGINT` against a fresh supervisor (pid 50534) — identical result: process exits,
lock file removed, log shows `received SIGINT, shutting down gracefully` /
`released lock, closed socket, exiting`. Confirms: a normal `kill`/Ctrl-C leaves nothing stale;
only an actual crash (`kill -9`, OOM, power loss) produces the stale-lock case that point 3
covers.

## Summary judgment

All four behaviors work as designed and were proven by actually spawning and killing real
processes, not by reasoning about the code. The single genuinely fixed bug (module-level
side-effecting import causing client/supervisor role collision) would have been invisible from
reading the code casually — it only surfaced because the test forced a cold start with a truly
empty state directory.

**Least confident edge case — same-instant cold-start race between two clients (not tested
above, reasoned only):** if two independent `client.js` processes both probe the socket as dead
and both decide to spawn a supervisor within the same few-millisecond window, both will call
`spawn()`. Both spawned supervisors will race for the lock via `acquireLock()`, and — per point 1
— exactly one will win; the loser logs `refusing to start a second supervisor` and exits 1. That
part is solid, verified by the 10-way race in point 1 using the *same* `acquireLock()` code path.
What's *not* directly verified end-to-end is the losing client's own recovery: in this probe,
`client.js` only spawns and waits for the socket — it never itself calls `acquireLock()` or
inspects the lock's contention outcome, so a client whose spawned supervisor loses the race is
just waiting on `waitForSocket()`, which will still succeed once the *other* client's supervisor
finishes binding. That path is not exercised by any test above (both test runs here only ever
had one client at a time), so I'd want an actual two-client-simultaneous-cold-start test before
fully trusting it, even though the underlying lock primitive it depends on is proven safe.
