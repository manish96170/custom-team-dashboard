// resilience-peer-crash.test.js — the central adversarial proof for this
// directory (closes review finding B7: "The daemon dies from the client
// crashes it exists to survive"). This is NOT a simulated error event — it
// spawns a real separate OS process, lets the server start actively writing
// to it mid-stream, then sends real SIGKILL, and asserts the SERVER PROCESS
// (this test's own process, hosting the server in-process) is still alive,
// still has no uncaught exception/unhandled rejection, and still answers a
// brand-new client afterward.
//
// The spike-0b review's finding was explicit that this direction — kill the
// CLIENT, confirm the supervisor survives — "was never tested" in the prior
// spike. This test exists specifically to close that gap for real.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createIpcServer } from "../server.js";
import { installProcessSafetyNet } from "../safety.js";
import { connect } from "../client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCK_PATH = path.join(os.tmpdir(), `ctd-ipc-crash-${process.pid}.sock`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const safetyEvents = [];
  const uninstall = installProcessSafetyNet({
    logger: { error() {}, warn() {}, log() {} },
    onEvent: (e) => safetyEvents.push(e),
  });

  fs.rmSync(SOCK_PATH, { force: true });
  const serverLogs = [];
  const { listen, shutdown } = createIpcServer({
    logger: {
      warn(msg) {
        serverLogs.push(String(msg));
      },
      error(msg) {
        serverLogs.push(String(msg));
      },
      log() {},
    },
  });
  await listen(SOCK_PATH);

  // 1. Spawn a REAL separate process that connects, pipelines a burst of
  //    large echo requests (so the server queues a real backlog of responses
  //    to write to it), and then stops reading entirely.
  const child = spawn(process.execPath, [path.join(__dirname, "helpers", "crash-client.js"), SOCK_PATH], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let ready = false;
  child.stdout.on("data", (chunk) => {
    if (chunk.toString("utf8").includes("READY")) ready = true;
  });
  child.on("error", () => {});

  const readyDeadline = Date.now() + 3000;
  while (!ready && Date.now() < readyDeadline) {
    await sleep(10);
  }
  assert.ok(ready, "crash-client child process should have reached READY (connected, pipelined the echo burst, paused reading)");

  // Give the server a real chance to start writing its (large) responses into
  // the now-unread socket before we kill the peer — this is what produces
  // genuine backpressure/backlog, not a simulated error.
  await sleep(80);

  // 2. The adversarial step: SIGKILL the child mid-stream. This is a real
  //    kill -9 of a real OS process — not a simulated socket error.
  const childPid = child.pid;
  process.kill(childPid, "SIGKILL");

  const exitCode = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  console.log(`crash-client (pid=${childPid}) killed: exit signal=${exitCode.signal} code=${exitCode.code}`);
  assert.equal(exitCode.signal, "SIGKILL", "child must have actually died by SIGKILL, not exited on its own");

  // 3. Give the server's next scheduled write (mock-adapter still emits on its
  //    own timers regardless of whether anyone's listening) time to hit the
  //    now-dead socket and surface whatever error Node produces for that.
  await sleep(300);

  // 4. THE assertion: the server process (this process) must still be here,
  //    with no uncaught exception / unhandled rejection escaping, and must
  //    still correctly answer a brand-new, unrelated client.
  assert.equal(
    safetyEvents.length,
    0,
    `no uncaughtException/unhandledRejection should ever have reached the top-level safety net; got: ${JSON.stringify(safetyEvents.map((e) => e.type))}`,
  );
  console.log("PASS: zero uncaughtException/unhandledRejection events reached the process-level safety net");

  const survivedLog = serverLogs.find((l) => /socket error from peer \(surviving\)/.test(l));
  assert.ok(
    survivedLog,
    `expected the server's per-socket error handler to have logged the peer's error and survived it; got logs: ${JSON.stringify(serverLogs)}`,
  );
  console.log(`PASS: server's own error handler observed and survived the peer crash: "${survivedLog}"`);

  const freshClient = await connect(SOCK_PATH);
  const pingRes = await freshClient.send("ping");
  assert.equal(pingRes.ok, true, "server must still answer a brand-new client after surviving the peer crash");
  assert.equal(pingRes.pid, process.pid, "the responding server must be THIS process — it never crashed and restarted");
  console.log(`PASS: server answered a fresh ping after the crash (pid=${pingRes.pid}, unchanged)`);
  freshClient.close();

  await shutdown({ timeoutMs: 1000 });
  uninstall();
  fs.rmSync(SOCK_PATH, { force: true });
  console.log("ALL PEER-CRASH RESILIENCE CHECKS PASSED — the daemon survived a real kill -9 of a connected client mid-write");
}

main().catch((err) => {
  console.error("FAIL:", err.stack || err.message);
  process.exit(1);
});
