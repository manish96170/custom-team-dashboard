// lock.js — single-instance exclusive lock via atomic O_EXCL file create + PID liveness check.
//
// Why roll our own instead of `proper-lockfile`: proper-lockfile (and most npm lock libs)
// implement *mtime-based* staleness (a lock older than N ms is considered stale) rather than
// *PID-liveness* staleness. mtime staleness is wrong for a long-lived daemon that might
// legitimately hold a lock for days — a supervisor that's alive for a week would look "stale"
// to a pure mtime check. PID liveness (checked via a zero-signal `process.kill(pid, 0)`) is the
// correct check for "is the process that holds this lock still alive," and is exactly what
// flock(2)-based tools give you for free via kernel-held advisory locks tied to the fd's
// lifetime. Node has no bound flock() in core, so we approximate it:
//
//   - Acquisition is atomic: fs.open(path, 'wx') maps to open(2) with O_CREAT|O_EXCL, which is
//     atomic at the kernel/filesystem level — two processes racing to create the same path can
//     never both succeed. Exactly one open() wins; POSIX guarantees this, and every mainstream
//     filesystem (APFS, ext4, most local disks) honors it. (Network filesystems like older NFS
//     are the traditional exception; not a concern for a per-user local state dir.)
//   - Staleness is content-based: the file's body is the holder's PID (and start time). If the
//     PID inside is dead, we unlink and retry the atomic create. The retry-after-unlink is where
//     a residual race could theoretically exist (see below) — but because acquisition is always
//     via 'wx', not a plain overwrite, at most one of two racing "clean up a stale lock and
//     recreate" attempts can ever win the recreate step. The loser correctly sees EEXIST again
//     and defers.
//
// CORRECTION (2026-09-05, code review — see consolidated-review-claudeopus5-medium--spike-0b.md
// finding B1): the paragraph above used to end by claiming "it is impossible for two processes
// to both believe they hold the lock at the same time." That is FALSE as this file is written.
// `fs.open(path, 'wx')` creates the file atomically, but the PID payload is written in a
// *separate* fs.write call afterward. In the window between those two calls the file exists on
// disk but is empty. A second process arriving in exactly that window reads an unparseable empty
// file, treats it as unowned/stale, unlinks it, and recreates it with its own PID — while the
// first process still holds an open fd to the (now-unlinked) original file and believes it holds
// the lock. Both processes proceed believing they're the sole holder. The exclusivity guarantee
// only holds against the acquire-vs-live-holder race that test-lock-race.js exercises; it does
// NOT hold against this write-gap race, which was never tested. Not yet fixed here — the real
// fix (write payload to a temp file, then `fs.link(tmp, lockPath)`, which is atomic and fails
// EEXIST with no unpopulated-file window) is tracked as a Phase 1 design requirement
// (ROADMAP.md Phase 1).

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export const LOCK_DIR =
  process.env.CTD_STATE_DIR ||
  path.join(os.homedir(), ".local", "state", "custom-team-dashboard");
export const LOCK_PATH = path.join(LOCK_DIR, "supervisor.lock");

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

async function readLockFile(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const data = JSON.parse(raw);
    return data;
  } catch {
    return null; // missing, unreadable, or corrupt -> treat as no usable info
  }
}

/**
 * Try to acquire the single-instance lock.
 * Returns { acquired: true, release } on success,
 * or { acquired: false, holderPid, reason } if another live process holds it.
 */
export async function acquireLock(lockPath = LOCK_PATH, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 5;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let fd;
    try {
      // O_CREAT|O_EXCL: atomic create-or-fail. Never overwrites an existing file.
      fd = await fs.open(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      // Lock file already exists. Inspect it to decide: held-live, or stale.
      const info = await readLockFile(lockPath);
      const holderPid = info?.pid;

      if (holderPid && isPidAlive(holderPid)) {
        return { acquired: false, holderPid, reason: "held-by-live-process" };
      }

      // Stale (dead PID, or unreadable/corrupt content we can't trust as "live").
      // Remove it and retry the atomic create. If someone else wins the recreate
      // race, our next loop iteration's open('wx') will fail with EEXIST again,
      // pointing at *their* fresh PID, which we will find alive and correctly defer to.
      try {
        await fs.unlink(lockPath);
      } catch (unlinkErr) {
        if (unlinkErr.code !== "ENOENT") throw unlinkErr;
        // someone else already cleaned it up; loop and retry open()
      }
      continue;
    }

    // We hold the fd from a fresh, exclusive create. Write our identity into it.
    const payload = JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: os.hostname(),
      },
      null,
      2,
    );
    await fd.writeFile(payload);
    await fd.close();

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      // Only remove the file if it still contains OUR pid — never blindly unlink,
      // in case something unexpected replaced it underneath us.
      const info = await readLockFile(lockPath);
      if (info?.pid === process.pid) {
        try {
          await fs.unlink(lockPath);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
      }
    };

    return { acquired: true, release, path: lockPath };
  }

  throw new Error(
    `acquireLock: exceeded ${maxAttempts} attempts contending on ${lockPath}`,
  );
}

export { isPidAlive };
