// stale-takeover-toctou.test.js — the deterministic regression test for the
// dual-acquire TOCTOU found by two independent code reviewers on 2026-09-05
// (review-two/group2-lock-{big-pickle,luna}.md, blocking finding #1).
//
// THE BUG: acquireLock() resolved an existing lock file as "stale" (parseable,
// dead PID inside), then unconditionally `unlink`ed whatever was sitting at
// lockPath. Between those two steps another process can publish its own,
// perfectly LIVE lock. The unlink then deleted that live lock, and the deleting
// process went on to publish its own — leaving two processes both believing they
// held an exclusive lock.
//
// WHY THIS TEST EXISTS SEPARATELY FROM race.test.js: race.test.js races N real
// processes and asserts one winner. It passes against the buggy code — it always
// did, which is exactly the problem. The window here is microseconds wide and
// timing-based racing does not reliably land in it. So this test does not race;
// it *occupies* the window, via the `_inStaleWindowForTest` seam in lock.js,
// and asserts the ordering property directly. That makes it deterministic:
// it fails 100% of the time against the pre-fix logic and passes 100% of the
// time against the fixed logic, with no sleeps and no flakiness.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { acquireLock } from "../lock.js";
import { assert, assertEqual } from "./assert.js";

async function freshLockPath(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ctd-lock-toctou-${label}-`));
  return path.join(dir, "supervisor.lock");
}

/** A PID that is guaranteed dead: spawn nothing, just pick one and confirm it. */
function deadPid() {
  // PIDs are recycled, so verify rather than assume. Walk down from a high value
  // until we find one that genuinely does not exist.
  for (let candidate = 999999; candidate > 100000; candidate -= 1) {
    try {
      process.kill(candidate, 0);
    } catch (err) {
      if (err.code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find a provably dead PID to fabricate a stale lock with");
}

async function writeLockFile(lockPath, pid) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid, startedAt: new Date().toISOString(), hostname: os.hostname() }, null, 2),
  );
}

/**
 * The core regression. Setup: lockPath holds a genuinely stale lock (dead PID).
 * Our acquireLock() resolves it as stale. Inside the resulting window — before
 * the unlink — a third party publishes a fresh LIVE lock. The correct behavior
 * is to notice the file is no longer the stale file we inspected, leave it
 * alone, and defer. The buggy behavior is to delete it and acquire anyway.
 */
async function staleWindowLiveTakeoverIsNotStolen() {
  const lockPath = await freshLockPath("takeover");
  const stalePid = deadPid();
  await writeLockFile(lockPath, stalePid);

  // The "other contender" publishes a live lock inside the window. Using our own
  // PID makes it unambiguously live for the duration of this test.
  const livePid = process.pid;
  let windowEntered = 0;

  const result = await acquireLock(lockPath, {
    maxAttempts: 5,
    _inStaleWindowForTest: async () => {
      windowEntered += 1;
      // Only take over on the first pass; on later attempts leave the live lock
      // in place so the loop terminates by deferring rather than churning.
      if (windowEntered === 1) await writeLockFile(lockPath, livePid);
    },
  });

  assertEqual(windowEntered >= 1, true, "the stale-resolution window must actually have been entered");
  assertEqual(
    result.acquired,
    false,
    "acquireLock MUST NOT acquire after a live lock replaced the stale file it inspected — " +
      "acquiring here is the dual-acquire bug (it means the live holder's lock was deleted)",
  );
  assertEqual(
    result.reason,
    "held-by-live-process",
    "the outcome must be a clean deferral to the live holder, not a contention error",
  );
  assertEqual(result.holderPid, livePid, "the reported holder must be the process that published the live lock");

  // The live lock must still be on disk, untouched — this is the property the
  // bug violated. Checking the file rather than just the return value catches a
  // variant where the unlink happens but acquisition then fails for some other
  // reason (the holder would still have been silently dispossessed).
  const raw = await fs.readFile(lockPath, "utf8");
  assertEqual(JSON.parse(raw).pid, livePid, "the live holder's lock file must still be intact on disk");

  await fs.rm(path.dirname(lockPath), { recursive: true, force: true });
  console.log(
    `PASS: a live lock published inside the stale-resolution window was left intact and deferred to ` +
      `(stale pid ${stalePid} -> live pid ${livePid})`,
  );
}

/**
 * Control case, to prove the test above is asserting the guard and not merely
 * that acquireLock refuses to take over stale locks in general: with NOTHING
 * happening in the window, the same genuinely-stale lock MUST be taken over.
 * If this failed, the fix would have over-corrected into never recovering from
 * a crashed holder — a worse bug than the one it closes.
 */
async function undisturbedStaleLockIsStillTakenOver() {
  const lockPath = await freshLockPath("plain-stale");
  const stalePid = deadPid();
  await writeLockFile(lockPath, stalePid);

  const result = await acquireLock(lockPath, { maxAttempts: 5 });
  assertEqual(result.acquired, true, "an undisturbed stale lock (dead PID) must still be recoverable");

  const raw = await fs.readFile(lockPath, "utf8");
  assertEqual(JSON.parse(raw).pid, process.pid, "the recovered lock must now carry our PID");

  await result.release();
  const stillThere = await fs
    .access(lockPath)
    .then(() => true)
    .catch(() => false);
  assert(!stillThere, "release() must remove our own lock file");

  await fs.rm(path.dirname(lockPath), { recursive: true, force: true });
  console.log(`PASS (control): an undisturbed stale lock (dead pid ${stalePid}) is still taken over cleanly`);
}

/**
 * The same window, but the takeover publishes another DEAD pid rather than a
 * live one. The file is still not the one we inspected, so it must not be
 * deleted on this pass — but it is genuinely stale, so the retry loop must
 * resolve it and acquire rather than giving up. This pins the "re-classify on
 * the next attempt" behavior the fix's `continue` depends on.
 */
async function staleWindowReplacedByAnotherStaleLockStillResolves() {
  const lockPath = await freshLockPath("stale-swap");
  const firstStalePid = deadPid();
  const secondStalePid = firstStalePid - 1;
  await writeLockFile(lockPath, firstStalePid);

  let windowEntered = 0;
  const result = await acquireLock(lockPath, {
    maxAttempts: 5,
    _inStaleWindowForTest: async () => {
      windowEntered += 1;
      if (windowEntered === 1) await writeLockFile(lockPath, secondStalePid);
    },
  });

  assert(windowEntered >= 2, `the loop must re-enter the window after re-classifying (entered ${windowEntered}x)`);
  assertEqual(result.acquired, true, "a lock that is still stale after the swap must eventually be acquired");
  const raw = await fs.readFile(lockPath, "utf8");
  assertEqual(JSON.parse(raw).pid, process.pid, "the acquired lock must carry our PID");

  await result.release();
  await fs.rm(path.dirname(lockPath), { recursive: true, force: true });
  console.log("PASS: a stale->stale swap inside the window is re-classified on the next attempt and acquired");
}

async function main() {
  await staleWindowLiveTakeoverIsNotStolen();
  await undisturbedStaleLockIsStillTakenOver();
  await staleWindowReplacedByAnotherStaleLockStillResolves();
}

main()
  .then(() => {
    console.log("stale-takeover-toctou.test.js: ALL PASS");
    process.exit(0);
  })
  .catch((err) => {
    console.error("stale-takeover-toctou.test.js: FAIL");
    console.error(err);
    process.exit(1);
  });
