// supervisor.js — dummy stand-in for the real supervisor daemon.
// Acquires the single-instance lock, listens on a Unix domain socket, echoes input.
// Exits (and releases the lock, closes the socket) cleanly on SIGTERM/SIGINT.

import net from "node:net";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { acquireLock } from "./lock.js";
import { STATE_DIR as SOCK_DIR, SOCK_PATH } from "./paths.js";

export { SOCK_DIR, SOCK_PATH };

function log(...args) {
  // Always write to a file too, so we have evidence even when detached/backgrounded.
  const line = `[supervisor pid=${process.pid}] ${args.join(" ")}\n`;
  process.stdout.write(line);
}

async function main() {
  const lockResult = await acquireLock();
  if (!lockResult.acquired) {
    log(
      `lock already held by pid=${lockResult.holderPid} (${lockResult.reason}) — refusing to start a second supervisor`,
    );
    process.exit(1);
  }
  log(`acquired lock at ${lockResult.path}`);

  await fs.mkdir(SOCK_DIR, { recursive: true });
  // Remove a leftover socket file from a previous crash before binding — Node's net.Server
  // will fail EADDRINUSE otherwise even though nothing is listening on it anymore.
  await fs.rm(SOCK_PATH, { force: true });

  const server = net.createServer((socket) => {
    log("client connected");
    socket.on("data", (data) => {
      const msg = data.toString("utf8");
      log(`recv: ${msg.trim()}`);
      socket.write(`echo: ${msg}`);
    });
    socket.on("end", () => log("client disconnected"));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCK_PATH, resolve);
  });
  log(`listening on ${SOCK_PATH}`);

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down gracefully`);
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(SOCK_PATH, { force: true });
    await lockResult.release();
    log("released lock, closed socket, exiting");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error("supervisor fatal error:", err);
    process.exit(1);
  });
}
