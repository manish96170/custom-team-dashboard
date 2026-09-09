# Phase 1 `supervisor/lock/` — findings

Real code, run on macOS (Darwin 25.6.0), Node v26.6.0. All output below is pasted
directly from actual terminal runs (`npm run test:lock` from `supervisor/`), not
simulated. Every test asserts and exits non-zero on failure (checked directly —
see "harness sanity check" below); nothing here prints-and-exits-0 unconditionally.

Files: `lock.js`, `test/assert.js`, `test/write-gap.test.js`, `test/race.test.js`,
`test/stale-recovery.test.js`, `test/graceful-release.test.js`,
`test/helper-holder.js`.

## The bug this replaces

`spike-0b/packaging-probe/lock.js` created the lock file atomically
(`fs.open(path, 'wx')`) but wrote the PID payload in a separate, later
`fs.write`. In the window between those two calls the file existed and was
empty. A second process arriving in that window read the unparseable empty
file, treated it as stale, unlinked it, and recreated it with its own PID —
while the first process still held a live fd to the (now-unlinked) original
file and believed it held the lock. Both processes could end up believing
they were the sole holder. Documented as finding B1 in
`consolidated-review-claudeopus5-medium--spike-0b.md`, and already corrected
in the spike's own header comment / `FINDINGS.md` as "not yet fixed there."
This directory is the real fix.

## The fix

`lock.js`'s `acquireLock()`:

1. Writes the full payload (`{pid, startedAt, hostname}`) to a private temp
   file (`<lockPath>.tmp.<pid>.<attempt>.<random>`, same directory as
   `lockPath`) using `wx`.
2. Publishes it with `fs.link(tmpPath, lockPath)`. `link(2)` fails `EEXIST` if
   `lockPath` already exists — same atomicity guarantee as `open(path, 'wx')`
   — but the payload is fully written before `lockPath` becomes visible under
   its real name. There is no window where `lockPath` exists and is empty.
3. The temp file is always removed afterward (`finally`), on both the success
   and failure path, so retries never leak temp files. Confirmed by scanning
   `$TMPDIR` after full test runs — zero leaked `*.tmp.*` files (see command
   and empty output below).

Secondary hardening (per B1's "also fix" note): an unparseable lock file
(`readLockFile` returns `null` — missing, empty, or corrupt) is now treated as
**unknown liveness**, not stale. `resolveExistingLock()` backs off and
re-reads (bounded by `opts.unknownRetries` / `opts.unknownBackoffMs`) instead
of concluding "can't parse -> therefore stale -> therefore safe to unlink" on
the first read. If it stays unparseable through every retry, `acquireLock()`
gives up with a thrown contention error rather than silently stealing a file
it couldn't interpret. It only unlinks-and-retries once it can actually parse
a dead PID out of the file, or the file has genuinely vanished.

## Why the regression test doesn't just race two `acquireLock()` calls

The original spike's `test-lock-race.js` raced two full `acquireLock()`
invocations and never caught B1, because the bug lived in the gap between
*create* and *write* inside a single acquisition — a gap the fix above
structurally removes from every acquisition. Racing two (now write-gap-free)
`acquireLock()` calls against each other today would only prove the gap is
closed; it can't exercise the code path that used to be wrong, because that
path no longer exists on the "am I acquiring" side.

So `test/write-gap.test.js` forces the exact on-disk state the bug depended on
— an existing, empty, unparseable lock file — directly and deterministically,
via a test-only export `_createBareLockFileForTest()` (open+close, no write;
this is the literal old buggy intermediate state, fabricated on purpose rather
than raced for). This is a real, deterministic proof, not a non-deterministic
race dressed up as one — and it's explicitly called out here per the task's
instruction to say so if a deterministic construction weren't possible; it
was.

Two scenarios:

- **Does not steal while liveness is unknown**: fabricate the empty lock file,
  call `acquireLock(lockPath, { maxAttempts: 1, unknownRetries: 3,
  unknownBackoffMs: 40 })`, and — mid-backoff, at the 70ms mark, well before
  the ~240ms total backoff window elapses — assert the file is *still present
  and still 0 bytes*. Then assert the call eventually throws (contention,
  because liveness never resolved) rather than ever returning
  `{acquired: true}`, and assert the file is *still* present afterward (never
  unlinked).
- **Correctly resolves once content becomes readable**: fabricate the same
  empty lock file, start `acquireLock()` with retries enabled, and at the
  60ms mark — while it's still mid-backoff — overwrite the file's content
  (from outside `lock.js`, simulating a genuine crash's leftover content
  becoming visible) with a parseable JSON payload naming a dead PID. Assert
  `acquireLock()` then resolves to `{acquired: true}`, that the file now
  contains *our* PID, and that `release()` cleans it up. This proves the
  retry loop actually re-reads on each backoff step (not a single
  stale/not-stale decision made once and then just slept through).

Captured output (`node lock/test/write-gap.test.js`):

```
PASS: does not steal a lock file while its liveness is unknown
PASS: correctly resolves once an unknown-liveness lock file becomes parseable/stale
write-gap.test.js: ALL PASS
```

## Standard proven scenarios — re-confirmed, not regressed

Captured output (`npm run test:lock` from `supervisor/`, full run):

```
> custom-team-dashboard-supervisor@0.1.0 test:lock
> node lock/test/write-gap.test.js && node lock/test/race.test.js && node lock/test/stale-recovery.test.js && node lock/test/graceful-release.test.js

PASS: does not steal a lock file while its liveness is unknown
PASS: correctly resolves once an unknown-liveness lock file becomes parseable/stale
write-gap.test.js: ALL PASS
PASS: 2-way race — exactly one winner, 1 clean deferrals, clean release
PASS: 10-way race — exactly one winner, 9 clean deferrals, clean release
race.test.js: ALL PASS
PASS: stale lock (dead PID) after crash is detected and recovered
stale-recovery.test.js: ALL PASS
PASS: graceful SIGTERM shutdown releases the lock cleanly
PASS: graceful SIGINT shutdown releases the lock cleanly
graceful-release.test.js: ALL PASS
```

Exit code of the aggregate run: `0`.

- **2-way and 10-way concurrent acquire race** (`test/race.test.js`): N real
  subprocesses (`test/helper-holder.js`) launched simultaneously against the
  same lock path. Asserts exactly one reports `acquired: true`, the rest
  report `acquired: false, reason: "held-by-live-process"` with `holderPid`
  matching the actual winner's PID, the winner's release line prints, and the
  lock file is gone afterward. Both N=2 and N=10 passed.
- **Stale-lock-after-crash recovery** (`test/stale-recovery.test.js`): spawn a
  holder, `SIGKILL` it (no cleanup handler runs), confirm the lock file is
  left behind and still names the now-dead PID (a real crash leaves complete,
  parseable, stale content — never the empty state, because the temp-file+link
  design guarantees a lock file is fully written before it's ever visible),
  then confirm a fresh `acquireLock()` detects the dead PID, unlinks, and
  succeeds.
- **Graceful release** (`test/graceful-release.test.js`): spawn a holder,
  send `SIGTERM` then (separately) `SIGINT`, confirm the release handler runs
  and the lock file is removed cleanly in both cases.

## Leaked temp file check

After a full `npm run test:lock` run, scanned `$TMPDIR` for any leftover
`*.tmp.*` files from the acquisition path:

```
$ find "$TMPDIR" -maxdepth 3 -iname "*.tmp.*" 2>/dev/null | grep -i lock
$ echo done
done
```

No matches — every temp file created during acquisition (including on the
EEXIST/retry path) was cleaned up.

## Harness sanity check

Confirmed the assertion helper itself fails loudly rather than being a silent
no-op (this is what the previous spike's proof scripts lacked):

```
$ node -e "import('./test/assert.js').then(({assert}) => {
  try { assert(false, 'sanity check should fail'); } catch(e) { console.log('caught as expected:', e.message); process.exit(0); }
  console.log('BUG: assert(false) did not throw'); process.exit(1);
});"
caught as expected: assertion failed: sanity check should fail
```

Every test file's top-level `main().then(...).catch(err => { ...; process.exit(1); })`
means a thrown assertion propagates to a non-zero process exit code, which is
what `npm run test:lock`'s `&&` chain (and any CI invocation) depends on to
actually fail the build on a real regression.

## Fix applied (2026-09-05, post cross-model code review)

**Blocking bug fixed**: stale-recovery dual-acquire TOCTOU. Found INDEPENDENTLY by
both cross-model reviewers (`review-two/group2-lock-big-pickle.md`,
`review-two/group2-lock-luna.md`) — high confidence this was real, not a false
positive. Mechanism: two contenders could both resolve the same dead PID as stale;
whichever unlinked *second* would delete the *other's* freshly-published, possibly
live, lock instead of the stale file it originally inspected — both processes then
believe they hold the lock. One reviewer reproduced it empirically (~1/150 rounds,
6 concurrent processes).

Fixed: `resolveExistingLock()` now returns the exact stale PID it saw; immediately
before deleting, `acquireLock()` re-reads the lock file and only proceeds with the
unlink if it's still the same stale content. If someone else already replaced it,
the unlink is skipped and the loop retries `link()` normally against whatever's
there now (correctly resolved on the next pass, not stolen).

Existing test suite (`npm run test:lock`) still passes in full after the fix.

**Regression test now added** (2026-09-05, the item previously flagged here as
missing): `test/stale-takeover-toctou.test.js`. It does NOT race — racing is exactly
why the original bug went undetected, since the window is microseconds wide and
`race.test.js` passed against the buggy code the whole time. Instead it *occupies*
the window via a documented test-only `_inStaleWindowForTest` seam in `lock.js`,
publishing a fresh live lock at the precise point between resolving a file as stale
and unlinking it. Three cases, no sleeps, fully deterministic:

1. Live lock published inside the window → must be left intact on disk and deferred
   to (`held-by-live-process`, correct `holderPid`). **Verified to fail against the
   pre-fix logic** (it acquired, i.e. it deleted the live holder's lock) — so the
   test asserts the guard, not a tautology.
2. Control: an undisturbed stale lock (provably dead PID) is still taken over and
   released cleanly — proving the fix didn't over-correct into never recovering from
   a crashed holder.
3. A stale→stale swap inside the window is left alone on that pass, then correctly
   re-classified and acquired on the next attempt — pinning the behavior the fix's
   `continue` depends on.

**Not yet fixed, carried forward**:
- Temp-file leak if `fs.writeFile` fails mid-write before cleanup (should-fix).
- Orphaned lock if `fs.link()` succeeds but temp cleanup fails afterward (should-fix).
