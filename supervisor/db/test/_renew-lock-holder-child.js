// _renew-lock-holder-child.js — spawned by leases.test.js to hold SQLite's real write lock for a
// known duration, proving `renewLeaseRow` reads "now" AFTER the lock is actually acquired
// (review-sol-2026-09-13.md finding 10), not before a busy-wait that can outlast the lease's own TTL.

import { openDb } from "../index.js";

const [, , stateDir, holdMs] = process.argv;
const db = openDb({ stateDir });
db.exec("BEGIN IMMEDIATE");
const deadline = Date.now() + Number(holdMs);
while (Date.now() < deadline) {
  /* deliberate busy-wait: this process must hold the write lock the whole time, not just schedule
     a timer, so the parent's renewLeaseRow call is genuinely blocked on SQLite's busy handler. */
}
db.exec("COMMIT");
process.stdout.write("done\n");
