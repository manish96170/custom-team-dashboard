// teardown.test.js — proves the deterministic teardown primitives required by
// the Group 3 spec (section 5) and review finding S11: "Graceful shutdown
// hangs whenever anything is observing ... server.close()'s default behavior
// of waiting for natural close ... hangs forever if any connection is a
// long-lived observe stream."
//
// Opens a genuinely long-lived `observe` subscription (the mock adapter's
// startLongLived run, which never emits turn.end), then calls shutdown() and
// asserts it resolves well within its timeout — i.e. it does NOT hang forever
// the way a bare `server.close()` would against this exact connection shape.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createIpcServer } from "../server.js";
import { connect } from "../client.js";

const SOCK_PATH = path.join(os.tmpdir(), `ctd-ipc-teardown-${process.pid}.sock`);

async function main() {
  fs.rmSync(SOCK_PATH, { force: true });
  const { listen, shutdown, listSockets } = createIpcServer({ logger: { warn() {}, error() {}, log() {} } });
  await listen(SOCK_PATH);

  const client = await connect(SOCK_PATH);

  // Open a run that never ends, and subscribe to it. This is exactly the
  // connection shape the spike proved hangs a bare server.close() forever.
  const startRes = await client.send("startLongLived");
  assert.equal(startRes.ok, true);
  const runId = startRes.runId;

  const observeId = "observe-longlived";
  const frames = [];
  client.onStream(observeId, (frame) => frames.push(frame));
  client.send("observe", { id: observeId, runId }); // never resolves/completes on its own — that's the point

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(listSockets().length, 1, "server should have exactly one accepted socket at this point");
  console.log("PASS: a long-lived observe subscription is open and tracked (this is the shape that hangs server.close())");

  // 1. THE real assertion: our shutdown() — which force-closes every tracked
  //    socket BEFORE calling server.close() — must resolve promptly.
  const start = Date.now();
  const { timedOut } = await shutdown({ timeoutMs: 2000 });
  const elapsedMs = Date.now() - start;

  assert.equal(timedOut, false, "shutdown() should complete via the normal path (force-close + server.close), not via the hard-timeout fallback");
  assert.ok(elapsedMs < 1500, `shutdown() took ${elapsedMs}ms — expected well under the 2000ms timeout, proving it didn't wait for the observe connection to close naturally`);
  console.log(`PASS: shutdown() with an open long-lived observe subscription resolved in ${elapsedMs}ms (well under the 2000ms cap), via force-close rather than waiting`);

  assert.equal(listSockets().length, 0, "no sockets should remain tracked after shutdown");
  console.log("PASS: zero sockets remain tracked after shutdown");

  client.close();
  fs.rmSync(SOCK_PATH, { force: true });

  // 2. Separately and honestly: demonstrate that a BARE server.close() against
  //    the identical long-lived-observe shape really would hang, so the "S11
  //    would hang" claim in this file's own header comment is evidence, not
  //    an assertion taken on faith.
  await demonstrateBareCloseHangs();

  console.log("ALL TEARDOWN CHECKS PASSED");
}

async function demonstrateBareCloseHangs() {
  const net = await import("node:net");
  const path2 = await import("node:path");
  const os2 = await import("node:os");
  const fs2 = await import("node:fs");
  const sockPath = path2.join(os2.tmpdir(), `ctd-ipc-barehang-${process.pid}.sock`);
  fs2.rmSync(sockPath, { force: true });

  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    // Deliberately never write/close — just hold the connection open, same
    // shape as a long-lived observe subscription from the caller's point of view.
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });

  const held = net.connect(sockPath);
  await new Promise((resolve, reject) => {
    held.once("connect", resolve);
    held.once("error", reject);
  });
  held.on("error", () => {});
  await new Promise((resolve) => setTimeout(resolve, 50));

  const CLOSE_PROBE_MS = 800;
  const closedInTime = await new Promise((resolve) => {
    let settled = false;
    server.close(() => {
      if (!settled) {
        settled = true;
        resolve(true);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, CLOSE_PROBE_MS);
  });

  // Cleanup regardless of outcome so the process can exit.
  held.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  try {
    server.close();
  } catch {
    /* already closing */
  }
  fs2.rmSync(sockPath, { force: true });

  console.log(
    closedInTime
      ? `NOTE: bare server.close() unexpectedly resolved within ${CLOSE_PROBE_MS}ms this run — platform-dependent; our shutdown() does not rely on this either way`
      : `PASS (control): bare server.close() did NOT resolve within ${CLOSE_PROBE_MS}ms while a connection was held open, confirming the exact hang this.shutdown() is built to avoid`,
  );
}

main().catch((err) => {
  console.error("FAIL:", err.stack || err.message);
  process.exit(1);
});
