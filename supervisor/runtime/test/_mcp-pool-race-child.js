// _mcp-pool-race-child.js — spawned as a separate OS process by mcp-pool.test.js to prove the DB
// PRIMITIVES (claimPoolSlot/attachToPool/detachAndMaybeDrain) are race-safe ACROSS PROCESSES, same
// "a sequential pair of calls proves nothing" standing rule as db/test/_lease-race-child.js.
//
// No real process spawning here on purpose: `runtime/mcp-pool.js`'s manager is documented as
// in-memory-authoritative for the live child handle within ONE daemon process — real concurrent
// attach/detach against one manager instance is a SINGLE-PROCESS concurrency question (covered by
// mcp-pool.test.js's own in-process case), not a cross-process one. What genuinely must be safe across
// real OS processes is the underlying DB bookkeeping itself, which is what this child exercises directly.

import fs from "node:fs";
import { openDb, closeDb, claimPoolSlot, markPoolReady, attachToPool, detachAndMaybeDrain, markPoolStopped } from "../../db/index.js";

const [, , stateDir, childIndex, barrierPath, name, configHash] = process.argv;

fs.writeFileSync(`${barrierPath}.ready.${childIndex}`, "");
const deadline = Date.now() + 30_000;
while (!fs.existsSync(barrierPath)) {
  if (Date.now() > deadline) throw new Error(`child ${childIndex}: start barrier never appeared`);
}

const db = openDb({ stateDir, busyTimeoutMs: 10_000 });
const outcomes = [];
for (let i = 0; i < 3; i += 1) {
  let attachmentId = null;
  let poolId = null;
  const claim = claimPoolSlot(db, { name, configHash });
  if (claim.claimed) {
    // A fake pid — this child is proving the DB bookkeeping, not real process liveness.
    markPoolReady(db, claim.pool.id, { pid: 100000 + Number(childIndex), pgid: 100000 + Number(childIndex) });
  }
  for (let attempt = 0; attempt < 200 && !attachmentId; attempt += 1) {
    const joined = attachToPool(db, { name, configHash });
    if (joined.attached) {
      attachmentId = joined.attachmentId;
      poolId = joined.pool.id;
    } else {
      // Not joinable right now (draining, or the row doesn't exist because someone else's claim/spawn
      // hasn't completed yet, or claimed it but hasn't marked it ready). Re-attempt the claim too, in
      // case the row is now stopped/failed and resurrectable.
      const retryClaim = claimPoolSlot(db, { name, configHash });
      if (retryClaim.claimed) markPoolReady(db, retryClaim.pool.id, { pid: 100000 + Number(childIndex), pgid: 100000 + Number(childIndex) });
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  if (!attachmentId) throw new Error(`child ${childIndex}: could not attach after 200 attempts`);
  outcomes.push({ attached: true, poolId });
  const detachResult = detachAndMaybeDrain(db, attachmentId);
  // No real process here (fake pid) — this child simulates "teardown finished" by calling
  // markPoolStopped itself, standing in for what `runtime/mcp-pool.js`'s `detach()` does after a real
  // kill. Without this, a `shouldTeardown: true` row would sit in 'draining' forever, since resurrection
  // only fires from 'stopped'/'failed'.
  if (detachResult.shouldTeardown) markPoolStopped(db, detachResult.poolId);
  outcomes.push({ detached: detachResult.detached, shouldTeardown: detachResult.shouldTeardown });
}
closeDb(db);

process.stdout.write(`${JSON.stringify({ childIndex: Number(childIndex), outcomes })}\n`);
