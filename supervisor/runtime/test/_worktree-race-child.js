// _worktree-race-child.js — spawned as a separate OS process by worktree.test.js to prove
// `createTaskWorktree` is race-safe ACROSS PROCESSES, not just single-threaded-safe. Same standing rule
// `db/test/_lease-race-child.js` already applies to leases: a sequential pair of calls passing proves
// nothing about a real race, only a genuinely concurrent one does.

import fs from "node:fs";
import { openDb, closeDb, upsertHarness } from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";

const [, , stateDir, childIndex, barrierPath, taskId, repoPath] = process.argv;
const quiet = { log() {}, warn() {}, error() {} };

fs.writeFileSync(`${barrierPath}.ready.${childIndex}`, "");
const deadline = Date.now() + 30_000;
while (!fs.existsSync(barrierPath)) {
  if (Date.now() > deadline) throw new Error(`child ${childIndex}: start barrier never appeared`);
}

const db = openDb({ stateDir, busyTimeoutMs: 10_000 });
upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
const supervisor = createSupervisor({
  db, adapters: { fake: createFakeHarness({ label: `worktree-race-${childIndex}` }) }, logger: quiet, askSweepIntervalMs: 0,
});

const result = await supervisor.createTaskWorktree(taskId, { repoPath });
closeDb(db);

process.stdout.write(`${JSON.stringify({
  childIndex: Number(childIndex), pid: process.pid,
  created: result.created === true, worktreeId: result.worktreeId ?? null,
  refused: result.refused ?? null,
})}\n`);
