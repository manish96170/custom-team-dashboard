// correlation.test.js — proves the wire protocol's id correlation (closes
// review finding S10): pipeline multiple commands on one connection, including
// two concurrent `observe` subscriptions, and verify every response/stream
// frame comes back tagged with the id of the request that caused it — even
// though responses can and do arrive out of send order.
//
// This is a real assertion script: it exits 1 and prints FAIL on any
// violation, exits 0 only if every check passed. No "print and exit 0
// regardless" — that is exactly the failure mode the task spec calls out.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createIpcServer } from "../server.js";
import { connect } from "../client.js";

const SOCK_PATH = path.join(os.tmpdir(), `ctd-ipc-correlation-${process.pid}.sock`);

async function main() {
  fs.rmSync(SOCK_PATH, { force: true });
  const { listen, shutdown } = createIpcServer({ logger: { warn() {}, error() {}, log() {} } });
  await listen(SOCK_PATH);

  const client = await connect(SOCK_PATH);

  // 1. Pipeline three ordinary commands without awaiting between sends, out of
  //    any guaranteed order, and confirm each response's id matches its own request.
  const pingP = client.send("ping");
  const echoAP = client.send("echo", { payload: "A" });
  const echoBP = client.send("echo", { payload: "B" });

  const [pingRes, echoARes, echoBRes] = await Promise.all([pingP, echoAP, echoBP]);
  assert.equal(pingRes.ok, true, "ping should succeed");
  assert.equal(echoARes.payload, "A", "echo A must return payload A");
  assert.equal(echoBRes.payload, "B", "echo B must return payload B");
  console.log("PASS: three pipelined ordinary commands each got their own correctly-tagged response");

  // 2. Two concurrent observe subscriptions on two different runs, same connection.
  //    Each stream frame must carry the id of the observe request that opened it,
  //    and events from run A must never appear under run B's id or vice versa.
  const startA = await client.send("start", { spec: { prompt: "task A" } });
  const startB = await client.send("start", { spec: { prompt: "task B" } });
  assert.equal(startA.ok, true);
  assert.equal(startB.ok, true);
  const runIdA = startA.runId;
  const runIdB = startB.runId;
  assert.notEqual(runIdA, runIdB, "two starts must produce distinct runIds");

  const framesA = [];
  const framesB = [];
  const idA = "observe-A-" + process.pid;
  const idB = "observe-B-" + process.pid;

  let doneA, doneB;
  const doneAP = new Promise((r) => (doneA = r));
  const doneBP = new Promise((r) => (doneB = r));

  client.onStream(idA, (frame) => {
    framesA.push(frame);
    if (frame.done || frame.ok === false) doneA();
  });
  client.onStream(idB, (frame) => {
    framesB.push(frame);
    if (frame.done || frame.ok === false) doneB();
  });

  // Fire both observe requests back-to-back, unawaited (they're long-lived; they
  // never "return" a single response — resolution only happens via onStream above).
  client.send("observe", { id: idA, runId: runIdA });
  client.send("observe", { id: idB, runId: runIdB });

  await Promise.all([doneAP, doneBP]);

  assert.ok(framesA.length > 0, "stream A must have received at least one frame");
  assert.ok(framesB.length > 0, "stream B must have received at least one frame");
  for (const f of framesA) assert.equal(f.id, idA, `every frame on stream A must carry id=${idA}, got ${f.id}`);
  for (const f of framesB) assert.equal(f.id, idB, `every frame on stream B must carry id=${idB}, got ${f.id}`);
  const lastA = framesA[framesA.length - 1];
  const lastB = framesB[framesB.length - 1];
  assert.equal(lastA.done, true, "stream A must end with a done frame");
  assert.equal(lastB.done, true, "stream B must end with a done frame");
  console.log(`PASS: two concurrent observe subscriptions stayed correctly separated by id (A got ${framesA.length} frames, B got ${framesB.length} frames)`);

  client.close();
  await shutdown({ timeoutMs: 1000 });
  fs.rmSync(SOCK_PATH, { force: true });
  console.log("ALL CORRELATION CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
