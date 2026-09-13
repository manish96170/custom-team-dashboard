// lock.js — single-instance exclusive lock via atomic link(2) publish + PID liveness check.
//
// This is the Phase 1 fix for a real exclusivity bug found in the Phase 0b spike
// (spike-0b/packaging-probe/lock.js, code review finding B1 in
// consolidated-review-claudeopus5-medium--spike-0b.md).
//
// The spike's acquisition was: `fs.open(path, 'wx')` (atomic create) followed by a
// *separate* `fs.write` of the PID payload. Between those two calls the lock file
// existed on disk but was empty. A second process arriving in exactly that window
// would read the empty file, fail to parse a PID out of it, treat it as stale,
// unlink it, and recreate it with its own PID — while the first process still held
// a live fd to the now-unlinked original file and believed it held the lock. Both
// processes ended up believing they were the sole holder. That is a real double-
// acquire, not a theoretical one; see B1 for the full trace.
//
// The fix here closes the gap structurally rather than patching around it:
//
//   1. Write the full payload ({pid, startedAt, hostname}) to a temp file
//      (`<lockPath>.tmp.<pid>.<attempt>.<rand>`, same directory as lockPath, so the
//      link below stays on one filesystem/device) using `wx` so two attempts by the
//      same process can never collide on the temp name either.
//   2. Publish it atomically with `fs.link(tmpPath, lockPath)`. `link(2)` fails
//      `EEXIST` if the target already exists — the same atomicity guarantee as
//      `open(path, 'wx')` — but by the time the name `lockPath` becomes visible to
//      anyone, the payload is already fully written under the temp name. There is
//      no window in which `lockPath` exists and is empty.
//   3. The temp file is always cleaned up afterward — on a successful link (the
//      directory entry is redundant once `lockPath` points at the same inode) and
//      on a failed one (EEXIST or any other error) — so retries never leak temp
//      files.
//
// Secondary hardening (also called out in B1): the spike's logic leapt straight
// from "can't parse the lock file's contents" to "therefore stale, therefore safe
// to unlink." That leap is exactly what turned an empty-file race into a double
// acquire. With the write-gap closed, an unparseable `lockPath` can now only arise
// from an actual partial write or crash (e.g. the process died between `fs.link`
// and this file being fsynced, or something outside this module truncated it) —
// far rarer than before, but not impossible. So an unparseable lock file is now
// treated as *unknown liveness*, not stale: we back off and re-read a bounded
// number of times, hoping it resolves to either a parseable dead PID (genuinely
// stale — safe to unlink and retry) or a parseable live PID (held). If it never
// resolves, acquisition fails with contention rather than silently stealing an
// unowned-looking file.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { stateDir, lockPath, legacyLockPath } from "../paths.js";

// The lock lives in THE state directory, next to the database and the socket
// (`supervisor/paths.js`). It used to default to `~/.local/state/custom-team-dashboard/` while
// the database and socket lived under `~/.custom-team-dashboard/supervisor/` — two roots that
// both worked and disagreed, which is why `runtime/test/daemon-crash.test.js` had to set two
// different env vars to stay out of `$HOME`. The lock moved rather than the database because
// the lock is ephemeral and a database is a migration.
export const LOCK_DIR = stateDir();
export const LOCK_PATH = lockPath();

/** Zero-signal liveness check. Returns true iff a process with this PID exists. */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process -> dead. EPERM: process exists but owned by someone else -> alive.
    return err.code === "EPERM";
  }
}

/** Reads and parses the lock file. Returns null if missing, unreadable, empty, or corrupt. */
async function readLockFile(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    if (raw.length === 0) return null; // exists but empty -> unparseable, not "no PID"
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function safeUnlink(p) {
  try {
    await fs.unlink(p);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Test-only hook: fabricate the exact on-disk state the original B1 bug depended
 * on — a lock file that exists but is empty (created, payload never written) —
 * without going through acquireLock's own (now write-gap-free) path. There is no
 * way to force real acquireLock() calls into that state anymore, by design; this
 * exists so a regression test can exercise the "unparseable lock file" handling
 * directly and deterministically instead of racing timing.
 */
export async function _createBareLockFileForTest(lockPath = LOCK_PATH) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const fd = await fs.open(lockPath, "wx");
  await fd.close();
}

/**
 * Inspects an existing lock file (we just got EEXIST trying to link ours in) and
 * decides what it means, retrying with backoff while its liveness is unknown
 * (i.e. while it's unparseable) instead of assuming stale on the first read.
 *
 * Returns one of:
 *   { type: "held-live", holderPid }  - live process owns it, caller should defer
 *   { type: "stale" }                 - dead PID, or file vanished; safe to unlink+retry
 *   { type: "unknown" }               - stayed unparseable through all retries; caller
 *                                        should back off at the outer level, not steal it
 */
async function resolveExistingLock(lockPath, unknownRetries, unknownBackoffMs) {
  for (let i = 0; i <= unknownRetries; i++) {
    const info = await readLockFile(lockPath);

    if (info !== null) {
      if (info.pid && isPidAlive(info.pid)) {
        return { type: "held-live", holderPid: info.pid };
      }
      // Parseable, but the PID inside is dead -> genuinely stale. Remember exactly
      // which dead PID we saw, so the caller can verify it's still the same file
      // immediately before deleting it (see the "stale" handling in acquireLock) --
      // this is what closes the dual-acquire TOCTOU found by independent code
      // review (2026-09-05): two contenders could both resolve the same dead PID as
      // stale, then whichever unlinked *second* would delete the *other's* freshly
      // published live lock instead of the stale file it actually inspected.
      return { type: "stale", stalePid: info.pid ?? null };
    }

    // Unparseable. Could be genuinely gone by now (someone else already cleaned
    // it up), in which case there's nothing to steal and no need to wait further.
    const stillExists = await fs
      .access(lockPath)
      .then(() => true)
      .catch(() => false);
    if (!stillExists) return { type: "stale", stalePid: null };

    // Exists but unparseable: unknown liveness. This is the state the original
    // bug treated as "therefore stale" on the very first read. Back off and
    // re-read instead, giving a genuine in-progress write (or eventual crash
    // cleanup by whoever owns it) a chance to resolve before we give up.
    if (i < unknownRetries) {
      await sleep(unknownBackoffMs * (i + 1));
    }
  }
  return { type: "unknown" };
}

/**
 * Try to acquire the single-instance lock.
 * Returns { acquired: true, release } on success,
 * or { acquired: false, holderPid, reason } if another live process holds it.
 * Throws if contention can't be resolved within maxAttempts (including the case
 * where an existing lock file's liveness stays unknown through every retry).
 */
export async function acquireLock(lockPath = LOCK_PATH, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 5;
  const unknownRetries = opts.unknownRetries ?? 5;
  const unknownBackoffMs = opts.unknownBackoffMs ?? 20;

  // Transitional, and load-bearing while it lasts: the lock moved to the unified state
  // directory (2026-09-07). A daemon started after that move must not ignore a daemon still
  // running against the OLD path — that is two live supervisors each holding a lock the other
  // cannot see, i.e. the single-writer invariant broken by a tidy-up. Only consulted for the
  // DEFAULT path (`opts.legacyPath` lets a test target a scratch file); a caller that passes an
  // explicit lockPath is running its own lock and must never be told about the user's real one.
  const legacyPath = opts.legacyPath ?? (lockPath === LOCK_PATH ? legacyLockPath() : null);
  if (legacyPath && legacyPath !== lockPath) {
    const legacy = await readLockFile(legacyPath);
    if (legacy?.pid && isPidAlive(legacy.pid)) {
      return {
        acquired: false,
        holderPid: legacy.pid,
        reason: "held-by-live-process-at-legacy-lock-path",
        legacyPath,
      };
    }
  }

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tmpPath = `${lockPath}.tmp.${process.pid}.${attempt}.${crypto
      .randomBytes(4)
      .toString("hex")}`;
    const payload = JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: os.hostname(),
      },
      null,
      2,
    );

    let linked = false;
    // review-sol-2026-09-13.md finding 34: this used to `throw err` directly from the `catch` block and
    // let the `finally` block's own `await safeUnlink(tmpPath)` run afterward — a JS `finally` that
    // throws REPLACES whatever exception was already propagating from `try`/`catch`, so a real primary
    // failure (disk full, an I/O error on `writeFile`) was silently swapped for whatever the cleanup
    // attempt threw, and the caller/operator saw the wrong root cause. `primaryError` is captured here
    // instead of rethrown immediately, and the actual `throw` moves to AFTER the `finally` block entirely
    // — so a cleanup failure below has nothing in flight to replace; it can only attach itself as
    // additional context via `cleanupError`, never mask the original.
    let primaryError = null;
    try {
      // Write the full payload under a private temp name first. Nobody else can see
      // this name (it's namespaced by our own pid/attempt/random suffix), so this
      // write is never itself part of a race.
      //
      // INSIDE the try/finally now, not before it (older should-fix backlog: "temp-file
      // leak if fs.writeFile fails mid-write"). `wx` creates the file, then writes the
      // payload, then closes it as three separate underlying steps — a failure AFTER
      // creation but before the write completes (disk full, an I/O error) used to leave
      // a half-written file at `tmpPath` that nothing here ever cleaned up, because the
      // old code only reached its cleanup path once this call had already returned.
      await fs.writeFile(tmpPath, payload, { flag: "wx" });

      // Atomic publish: link(2) fails EEXIST if lockPath already exists. By the
      // time lockPath exists under this name, it is already fully populated —
      // there is no observable empty-file window.
      await fs.link(tmpPath, lockPath);
      linked = true;
    } catch (err) {
      if (err.code !== "EEXIST") primaryError = err;
    } finally {
      if (linked) {
        // The lock is ALREADY held at this point — `lockPath` is a second hard link to
        // `tmpPath`'s inode. A failure removing the now-redundant temp name must NEVER
        // fail the acquisition itself, or a legitimately-held lock becomes an ORPHAN
        // nobody can ever release (older should-fix backlog: "orphaned lock if
        // fs.link() succeeds but temp cleanup then fails"). Best-effort only — a
        // leftover redundant hard link is harmless clutter, not a correctness problem.
        try {
          await fs.unlink(tmpPath);
        } catch { /* redundant hard link; the lock itself is fine either way */ }
      } else {
        // Not published (write failed partway, or link lost EEXIST): whatever is at
        // `tmpPath` is exclusively ours, and it is never needed again. A real cleanup
        // failure here is recorded on `primaryError` (if there is one) rather than thrown
        // directly — see the note above finding 34.
        try {
          await safeUnlink(tmpPath);
        } catch (cleanupErr) {
          if (primaryError) primaryError.cleanupError = cleanupErr;
          else primaryError = cleanupErr;
        }
      }
    }
    if (primaryError) throw primaryError;

    if (!linked) {
      const outcome = await resolveExistingLock(
        lockPath,
        unknownRetries,
        unknownBackoffMs,
      );

      if (outcome.type === "held-live") {
        return {
          acquired: false,
          holderPid: outcome.holderPid,
          reason: "held-by-live-process",
        };
      }

      if (outcome.type === "stale") {
        // Test-only seam, same rationale as _createBareLockFileForTest above: the
        // dual-acquire TOCTOU lives in the window between resolving a lock as
        // stale and deleting it, and that window cannot be hit reliably by racing
        // real processes (the existing timing-based race.test.js never caught the
        // original bug). This hook lets a test occupy that exact window
        // deterministically — e.g. by publishing a fresh LIVE lock there, which is
        // precisely what a third contender does in the real failure. Never set in
        // production: `opts` comes from acquireLock's own caller, not from disk or
        // the wire.
        if (opts._inStaleWindowForTest) await opts._inStaleWindowForTest();

        // Fixed (2026-09-05, independent code review, both reviewers found this
        // independently): re-verify immediately before deleting that lockPath is
        // STILL the exact stale file we just inspected, not a fresh lock some
        // other process published in the meantime. Unconditionally deleting
        // whatever currently sits at lockPath -- the original bug -- meant a
        // second contender resolving the same dead PID as stale could delete a
        // third process's freshly-published *live* lock and then successfully
        // publish its own, leaving two processes both believing they hold it.
        const recheck = await readLockFile(lockPath);
        const stillTheSameStaleFile =
          outcome.stalePid === null
            ? recheck === null // we saw "vanished"; still gone is consistent
            : recheck !== null && recheck.pid === outcome.stalePid;

        if (!stillTheSameStaleFile) {
          // Someone else already resolved this (replaced it with their own lock,
          // possibly now live) between our read and now. Do NOT touch it -- loop
          // back and let the next link() attempt hit EEXIST against whatever is
          // there now, which resolveExistingLock will correctly classify (likely
          // held-live) rather than us stealing it out from under them.
          continue;
        }

        // Confirmed unchanged: safe to remove and retry the atomic create/link.
        // If someone else wins the recreate race after this point, our next loop
        // iteration's link() will fail with EEXIST again, pointing at *their*
        // fresh PID, which we will find alive and correctly defer to.
        await safeUnlink(lockPath);
        continue;
      }

      // outcome.type === "unknown": stayed unparseable through every retry.
      // Do NOT unlink it — we don't know who (if anyone) owns it, and blindly
      // stealing it is exactly the bug this file exists to fix. Loop back to
      // the top and try again; if it never resolves, maxAttempts below turns
      // this into an explicit contention error rather than a silent double
      // acquire.
      continue;
    }

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      // Only remove the file if it still contains OUR pid — never blindly unlink,
      // in case something unexpected replaced it underneath us.
      const info = await readLockFile(lockPath);
      if (info?.pid === process.pid) {
        await safeUnlink(lockPath);
      }
    };

    return { acquired: true, release, path: lockPath };
  }

  throw new Error(
    `acquireLock: exceeded ${maxAttempts} attempts contending on ${lockPath}`,
  );
}

export { isPidAlive };
