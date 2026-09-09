// test-lock-race.js — a tiny standalone program used to prove point 1: single-instance lock.
// Run as a child process. It tries to acquire the lock, reports the result on stdout as JSON,
// and if it acquired the lock, holds it for `holdMs` milliseconds before releasing and exiting
// (so a sibling process racing at "literally the same instant" can observe contention).

import { acquireLock, LOCK_PATH } from "./lock.js";

const holdMs = Number(process.argv[2] ?? 500);

const result = await acquireLock();

if (!result.acquired) {
  console.log(
    JSON.stringify({
      pid: process.pid,
      acquired: false,
      holderPid: result.holderPid,
      reason: result.reason,
      lockPath: LOCK_PATH,
    }),
  );
  process.exit(0);
}

console.log(
  JSON.stringify({
    pid: process.pid,
    acquired: true,
    lockPath: LOCK_PATH,
  }),
);

await new Promise((r) => setTimeout(r, holdMs));
await result.release();
console.log(JSON.stringify({ pid: process.pid, released: true }));
