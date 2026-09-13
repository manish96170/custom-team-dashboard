// _lease-race-child.js — spawned as a separate OS process by leases.test.js to prove
// `tryAcquireLease` is race-safe ACROSS PROCESSES, not just single-threaded-safe. The same
// standing rule concurrent-startup.test.js already applies to migrations: a sequential pair of
// calls passing proves nothing about a real race, only a genuinely concurrent one does.

import fs from "node:fs";
import { openDb, closeDb, mintPrincipal, tryAcquireLease } from "../index.js";

const [, , stateDir, childIndex, barrierPath, resourceName, kind, capacityArg] = process.argv;
const capacity = capacityArg === "null" ? null : Number(capacityArg);

fs.writeFileSync(`${barrierPath}.ready.${childIndex}`, "");
const deadline = Date.now() + 30_000;
while (!fs.existsSync(barrierPath)) {
  if (Date.now() > deadline) throw new Error(`child ${childIndex}: start barrier never appeared`);
}

const db = openDb({ stateDir, busyTimeoutMs: 10_000 });
const principalId = `p-child-${childIndex}`;
mintPrincipal(db, { id: principalId, kind: "worker", tokenSha256: `hash-${childIndex}`, capabilities: ["resource:lease"] });

const result = tryAcquireLease(db, {
  resourceName, kind, capacity, holderPrincipalId: principalId, reason: `child ${childIndex}`,
});
closeDb(db);

process.stdout.write(`${JSON.stringify({ childIndex: Number(childIndex), pid: process.pid, granted: result.granted })}\n`);
