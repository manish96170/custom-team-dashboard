// _concurrent-writer-child.js — spawned as a separate OS process by
// concurrent-write.test.js. Opens the shared db file (same stateDir, already
// migrated by the parent) and performs its own batch of run + event inserts, each in
// its own implicit transaction, exactly like a real supervisor would as events stream
// in one at a time. Exits 0 on success, non-zero (via uncaught throw) on any failure.

import { openDb, closeDb, createRun, recordEvent, endRun } from "../index.js";

const [, , stateDir, workerIndex, insertsPerProcessStr] = process.argv;
const insertsPerProcess = parseInt(insertsPerProcessStr, 10);
const runId = `run-child-${workerIndex}-${process.pid}`;

const db = openDb({ stateDir, busyTimeoutMs: 10000 });

createRun(db, {
  runId,
  workerId: "worker-1",
  harnessId: "claude-code",
  prompt: `child ${workerIndex} prompt`,
});

for (let i = 0; i < insertsPerProcess; i++) {
  recordEvent(db, {
    runId,
    tier: 1,
    type: "assistant.delta",
    payload: { workerIndex: Number(workerIndex), i },
  });
}

endRun(db, runId, { exitReason: "completed" });
closeDb(db);
process.stdout.write(`child ${workerIndex} (pid ${process.pid}) wrote ${insertsPerProcess} events under run ${runId}\n`);
