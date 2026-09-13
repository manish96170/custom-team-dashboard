// cleanup-failure.test.js — two temp-file cleanup edge cases from the older should-fix backlog
// (HANDOFF.md): a failed `fs.writeFile` used to leak the temp file forever, and a failed cleanup
// of the (already-redundant) temp file after a SUCCESSFUL `fs.link()` used to fail the whole
// acquisition — turning a legitimately-held lock into an orphan nobody could ever release.
//
// Both are forced deterministically by monkey-patching `node:fs`'s `promises` object for the
// duration of one case — `lock.js` imports the SAME object (`import { promises as fs } from
// "node:fs"`), and a property lookup happens at CALL time, not at import time, so patching the
// property here reaches lock.js's own calls without any injection point in lock.js itself. Restored
// immediately after each case so nothing else in this process (or another test file's process — each
// runs standalone) observes the patch.

import { promises as fsPromises } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { acquireLock } from "../lock.js";
import { assert, assertEqual } from "./assert.js";

async function tmpFilesFor(lockPath) {
  const dir = path.dirname(lockPath);
  const base = path.basename(lockPath);
  const names = await fsPromises.readdir(dir);
  return names.filter((n) => n.startsWith(`${base}.tmp.`));
}

async function main() {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ctd-lock-cleanup-"));
  const lockPath = path.join(dir, "supervisor.lock");

  // ── 1: a failed fs.writeFile must not leak the temp file ──────────────────────────────────
  {
    const originalWriteFile = fsPromises.writeFile;
    let calls = 0;
    fsPromises.writeFile = async (target, ...rest) => {
      calls += 1;
      // Simulate exactly what a real disk-full/I/O error leaves behind: `wx` has already
      // CREATED the file (that part of the syscall succeeded) before the write itself fails.
      await fs.promises.open(target, "wx").then((fd) => fd.close());
      throw Object.assign(new Error("simulated ENOSPC mid-write"), { code: "ENOSPC" });
    };
    try {
      let threw = null;
      try {
        await acquireLock(lockPath, { maxAttempts: 1 });
      } catch (err) {
        threw = err;
      }
      assert(threw && /ENOSPC/.test(threw.message), `acquireLock must propagate the real write error, got ${threw?.message}`);
      assertEqual(calls, 1, "precondition: the patched writeFile must have actually been called");
      const leftover = await tmpFilesFor(lockPath);
      assertEqual(leftover.length, 0, `a failed write must not leak its temp file; found: ${JSON.stringify(leftover)}`);
    } finally {
      fsPromises.writeFile = originalWriteFile;
    }
    console.log("PASS: a failed fs.writeFile does not leak its temp file");
  }

  // ── 2: a failed cleanup AFTER a successful link must not orphan the lock ──────────────────
  {
    const originalUnlink = fsPromises.unlink;
    let patchedCallCount = 0;
    fsPromises.unlink = async (target) => {
      patchedCallCount += 1;
      throw Object.assign(new Error("simulated EPERM removing the redundant temp link"), { code: "EPERM" });
    };
    let result;
    try {
      result = await acquireLock(lockPath, { maxAttempts: 1 });
    } finally {
      fsPromises.unlink = originalUnlink;
    }
    assertEqual(result.acquired, true, `a cleanup failure after a SUCCESSFUL link must not fail the acquisition itself; got ${JSON.stringify(result)}`);
    assert(patchedCallCount >= 1, "precondition: the patched unlink must have actually been called (the redundant-temp-name cleanup attempt)");
    const onDisk = await fsPromises
      .readFile(lockPath, "utf8")
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
    assertEqual(onDisk?.pid, process.pid, "the lock file itself must still exist and name this process, despite the cleanup failure");

    // The lock must still be genuinely RELEASABLE — an "acquired: true" that can't actually be
    // released later would just move the orphan from "temp file" to "the lock itself."
    await result.release();
    const stillThere = await fsPromises
      .access(lockPath)
      .then(() => true)
      .catch(() => false);
    assert(!stillThere, "the lock must still release cleanly after the earlier cleanup failure");
    console.log("PASS: a failed cleanup after a successful link does not orphan the lock, and it still releases cleanly");
  }

  // ── 3: a cleanup failure after a FAILED write must not replace the primary error ──────────
  // review-sol-2026-09-13.md finding 34: `finally` blocks in JS REPLACE a propagating exception with
  // whatever they themselves throw. Before the fix, a real primary error (the write failing) followed
  // by a real cleanup failure (the not-yet-published temp file's own unlink also failing) meant the
  // CALLER only ever saw the cleanup error — the actual root cause (disk full, an I/O error) was lost.
  {
    const originalWriteFile = fsPromises.writeFile;
    const originalUnlink = fsPromises.unlink;
    fsPromises.writeFile = async (target, ...rest) => {
      await fs.promises.open(target, "wx").then((fd) => fd.close());
      throw Object.assign(new Error("simulated ENOSPC mid-write"), { code: "ENOSPC" });
    };
    fsPromises.unlink = async () => {
      throw Object.assign(new Error("simulated EACCES removing the failed-write temp file"), { code: "EACCES" });
    };
    let threw = null;
    try {
      try {
        await acquireLock(lockPath, { maxAttempts: 1 });
      } catch (err) {
        threw = err;
      }
      assert(threw, "acquireLock must still throw when both the write and its cleanup fail");
      assert(/ENOSPC/.test(threw.message), `the PRIMARY (write) error must be what the caller sees, got: ${threw.message}`);
      assert(threw.code === "ENOSPC", `the primary error's own code must survive, got: ${threw.code}`);
      assert(threw.cleanupError && /EACCES/.test(threw.cleanupError.message),
        `the cleanup failure must still be recorded as context, not silently dropped; got: ${JSON.stringify(threw.cleanupError)}`);
    } finally {
      fsPromises.writeFile = originalWriteFile;
      fsPromises.unlink = originalUnlink;
    }
    console.log("PASS: a cleanup failure after a failed write does not mask the primary error, and is recorded as context instead");
  }

  await fsPromises.rm(dir, { recursive: true, force: true });
}

main()
  .then(() => {
    console.log("cleanup-failure.test.js: ALL PASS");
    process.exit(0);
  })
  .catch((err) => {
    console.error("cleanup-failure.test.js: FAIL");
    console.error(err);
    process.exit(1);
  });
