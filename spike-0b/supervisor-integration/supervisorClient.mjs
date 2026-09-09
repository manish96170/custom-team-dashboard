// supervisorClient.mjs — small client library for talking to supervisor.js
// over its Unix socket. Reuses packaging-probe's proven lazy-start pattern
// (spawn detached, log to file not pipe, wait for socket) adapted to this
// spike's own paths/state dir.

import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { STATE_DIR, SOCK_PATH, LOG_PATH } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function probeSocket(sockPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.end();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitForSocket(sockPath, maxWaitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await probeSocket(sockPath)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export async function ensureSupervisorRunning() {
  const alive = await probeSocket(SOCK_PATH);
  if (alive) return { spawned: false };

  await fs.mkdir(STATE_DIR, { recursive: true });
  const logFd = await fs.open(LOG_PATH, "a");
  const child = spawn(process.execPath, [path.join(__dirname, "supervisor.js")], {
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
  });
  child.unref();
  await logFd.close();

  const ok = await waitForSocket(SOCK_PATH);
  if (!ok) throw new Error("timed out waiting for spawned supervisor socket");
  return { spawned: true, pid: child.pid };
}

/** Send one command, return the first JSON response line, close the connection. */
export function sendCommand(cmd) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK_PATH);
    let buf = "";
    sock.on("connect", () => sock.write(JSON.stringify(cmd) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        sock.end();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    });
    sock.on("error", reject);
  });
}

/**
 * Open a dedicated connection, send {cmd:"observe", runId}, and call
 * onEvent(parsedLine) for every JSON-lines message until the server signals
 * done:true or the socket closes. Resolves when the stream ends.
 */
export function observeRun(runId, onEvent) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK_PATH);
    let buf = "";
    sock.on("connect", () => sock.write(JSON.stringify({ cmd: "observe", runId }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        onEvent(msg);
        if (msg.done) {
          sock.end();
        }
      }
    });
    sock.on("close", () => resolve());
    sock.on("error", reject);
  });
}
