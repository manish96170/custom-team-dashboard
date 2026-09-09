// Regression test for consolidated-review-claudeopus5-medium--spike-0b.md finding
// B1 ("the lock's exclusivity guarantee is false: a write-gap makes two holders
// possible").
//
// Why this test does NOT race two acquireLock() calls against each other (which
// is what spike-0b/packaging-probe/test-lock-race.js did, and which never caught
// the bug): with the temp-file + fs.link() fix in ../lock.js, a process's own
// acquisition path never exposes an empty lockPath to anyone else — the payload
// is fully written under a private temp name before link(2) makes it visible
// under the real name. There is no longer a timing window to win by racing two
// full acquireLock() calls; racing them just proves the (now closed) gap is
// closed, it doesn't exercise the code path that used to be wrong.
//
// So instead this test forces the exact on-disk state the original bug hinged
// on directly and deterministically, via the test-only hook
// `_createBareLockFileForTest` (an existing, empty, unparseable lock file — the
// state a reader would see mid-way through the old open()-then-write()
// sequence) and checks that a concurrent acquireLock() call:
//
//   (A) does NOT unlink/steal that file while its liveness is unknown — it
//       waits/retries with backoff instead, which is the secondary hardening
//       the review asked for, and
//   (B) DOES correctly resolve once the file's content becomes readable again
//       (proving the retry loop actually re-reads on each backoff step rather
//       than making a single stale/not-stale decision and then just sleeping
//       before repeating the same wrong decision).
//
// If we could not construct (A) deterministically we would say so explicitly
// here rather than silently falling back to a timing race — but we can, via the
// test-only hook, so this is a real, deterministic proof of the fix, not a
// flaky race.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  acquireLock,
  isPidAlive,
  _createBareLockFileForTest,
} from "../lock.js";
import { assert, assertEqual } from "./assert.js";

async function freshStateDir(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ctd-lock-${label}-`));
  return path.join(dir, "supervisor.lock");
}

async function fileSize(p) {
  const st = await fs.stat(p);
  return st.size;
}

function findDeadPid() {
  // Scan downward from a high PID for one that isn't alive. PIDs are recycled,
  // so we verify with isPidAlive rather than assuming any specific number.
  for (let pid = 999999; pid > 900000; pid--) {
    if (!isPidAlive(pid)) return pid;
  }
  throw new Error("could not find a dead PID to use in test");
}

async function testDoesNotStealDuringUnknownWindow() {
  const lockPath = await freshStateDir("unknown-no-steal");
  await _createBareLockFileForTest(lockPath);

  assertEqual(await fileSize(lockPath), 0, "fabricated lock file starts empty");

  // maxAttempts: 1 means exactly one EEXIST encounter, followed by one full
  // unknownRetries backoff cycle, then acquireLock must give up rather than
  // ever unlinking the file it couldn't parse.
  const unknownRetries = 3;
  const unknownBackoffMs = 40;
  const acquirePromise = acquireLock(lockPath, {
    maxAttempts: 1,
    unknownRetries,
    unknownBackoffMs,
  });

  // Check partway through the backoff window (well before all retries are
  // exhausted: sum of backoffs is 40+80+120=240ms) that the file has not been
  // touched. This is the direct check that the fix's "unknown, not stale"
  // classification is actually being honored moment-to-moment, not just in the
  // final outcome.
  await new Promise((resolve) => setTimeout(resolve, 70));
  const stillExists = await fs
    .access(lockPath)
    .then(() => true)
    .catch(() => false);
  assert(
    stillExists,
    "lock file must NOT be unlinked while its liveness is still unknown (mid-backoff check)",
  );
  assertEqual(
    await fileSize(lockPath),
    0,
    "lock file must still be untouched/empty mid-backoff — nobody should have stolen or rewritten it",
  );

  let threw = false;
  try {
    await acquirePromise;
  } catch {
    threw = true;
  }
  assert(
    threw,
    "acquireLock must fail with contention (not silently acquire) when the existing lock file's liveness never resolves",
  );

  // And it still must not have unlinked the file it couldn't interpret.
  const existsAfter = await fs
    .access(lockPath)
    .then(() => true)
    .catch(() => false);
  assert(
    existsAfter,
    "lock file must still exist after acquireLock gives up — giving up on contention is fine, deleting someone else's (possibly live) lock is not",
  );

  await fs.rm(path.dirname(lockPath), { recursive: true, force: true });
  console.log("PASS: does not steal a lock file while its liveness is unknown");
}

async function testResolvesOnceContentBecomesReadable() {
  const lockPath = await freshStateDir("unknown-then-stale");
  await _createBareLockFileForTest(lockPath);

  const deadPid = findDeadPid();
  const unknownRetries = 4;
  const unknownBackoffMs = 40;

  const acquirePromise = acquireLock(lockPath, {
    maxAttempts: 5,
    unknownRetries,
    unknownBackoffMs,
  });

  // While the acquirer is mid-backoff (still treating the file as
  // unknown-liveness), make its content become parseable and genuinely stale —
  // simulating the crash-recovery case the original code's "unparseable ->
  // stale" shortcut was trying (unsafely) to handle in one step. A correct
  // retry loop must pick this up on its next re-read.
  await new Promise((resolve) => setTimeout(resolve, 60));
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: deadPid, startedAt: new Date(0).toISOString(), hostname: "test" }),
  );

  const result = await acquirePromise;
  assertEqual(result.acquired, true, "acquireLock must succeed once the previously-unparseable lock file resolves to a parseable dead PID");
  assertEqual(typeof result.release, "function", "successful acquire must return a release()");

  const info = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assertEqual(info.pid, process.pid, "lock file must now record OUR pid after taking over the stale lock");

  await result.release();
  const existsAfterRelease = await fs
    .access(lockPath)
    .then(() => true)
    .catch(() => false);
  assert(!existsAfterRelease, "release() must remove the lock file we own");

  await fs.rm(path.dirname(lockPath), { recursive: true, force: true });
  console.log("PASS: correctly resolves once an unknown-liveness lock file becomes parseable/stale");
}

async function main() {
  await testDoesNotStealDuringUnknownWindow();
  await testResolvesOnceContentBecomesReadable();
}

main()
  .then(() => {
    console.log("write-gap.test.js: ALL PASS");
    process.exit(0);
  })
  .catch((err) => {
    console.error("write-gap.test.js: FAIL");
    console.error(err);
    process.exit(1);
  });
