// _worktree-claim-race-child.js — spawned as a separate OS process to deterministically FORCE the exact
// vulnerable interleaving `codexdoc/review-phase7-uncommitted.md` finding 2 describes: "two processes
// read the same task with worktree_id = NULL... [with] a barrier immediately after each task SELECT to
// force the vulnerable schedule." A single barrier before the whole operation (as
// `_worktree-race-child.js` uses) proves the INTEGRATION works but leaves the actual race window to OS
// scheduling luck, which this project's own FINDINGS.md explicitly warns against trusting ("a test that
// only sometimes exercises its mechanism has not proven it"). This script uses TWO barriers — one before
// the read, one before the claim attempt — so every child is guaranteed to have read the SAME stale
// value before any of them races to claim it.

import fs from "node:fs";
import { openDb, closeDb, claimTaskWorktreeSlot } from "../../db/index.js";

const [, , stateDir, childIndex, readBarrierPath, claimBarrierPath, taskId] = process.argv;

function waitFor(barrierPath, readyPath) {
  fs.writeFileSync(readyPath, "");
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(barrierPath)) {
    if (Date.now() > deadline) throw new Error(`child ${childIndex}: barrier ${barrierPath} never appeared`);
  }
}

const db = openDb({ stateDir, busyTimeoutMs: 10_000 });

waitFor(readBarrierPath, `${readBarrierPath}.ready.${childIndex}`);
const readValue = db.prepare(`SELECT worktree_id FROM tasks WHERE id = ?`).get(taskId)?.worktree_id ?? null;

waitFor(claimBarrierPath, `${claimBarrierPath}.ready.${childIndex}`);
const result = claimTaskWorktreeSlot(db, taskId, { previousValue: readValue });
closeDb(db);

process.stdout.write(`${JSON.stringify({ childIndex: Number(childIndex), pid: process.pid, claimed: result.claimed === true })}\n`);
