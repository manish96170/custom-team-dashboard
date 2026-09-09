// client.js — proves lazy-start: check if the supervisor's socket is alive; if not, spawn it
// detached, wait for the socket, then connect and exchange a message.

import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { SOCK_PATH, STATE_DIR } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(...args) {
  console.log(`[client pid=${process.pid}]`, ...args);
}

/** Try a single connect attempt to the socket. Resolves true/false, never throws. */
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

async function waitForSocket(sockPath, maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await probeSocket(sockPath)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function sendAndReceive(sockPath, message) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    let reply = "";
    sock.on("connect", () => sock.write(message));
    sock.on("data", (d) => {
      reply += d.toString("utf8");
      sock.end();
    });
    sock.on("close", () => resolve(reply));
    sock.on("error", reject);
  });
}

async function ensureSupervisorRunning() {
  const alive = await probeSocket(SOCK_PATH);
  if (alive) {
    log("supervisor socket already alive — reusing existing supervisor, not spawning");
    return { spawned: false };
  }

  log("supervisor socket not reachable — lazily spawning a new supervisor");
  // Redirect the detached child's stdout/stderr to a log file rather than piping to this
  // process — a `pipe` fd held open by the parent keeps the parent's event loop alive even
  // after unref(), which defeats the point of a lazily-spawned, independent daemon (caught by
  // this exact test hanging past its own exit — see FINDINGS.md).
  await fs.mkdir(STATE_DIR, { recursive: true });
  const logPath = path.join(STATE_DIR, "supervisor.log");
  const logFd = await fs.open(logPath, "a");
  const child = spawn(process.execPath, [path.join(__dirname, "supervisor.js")], {
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
  });
  child.unref();
  await logFd.close();

  const ok = await waitForSocket(SOCK_PATH);
  if (!ok) throw new Error("timed out waiting for spawned supervisor's socket");
  log(`spawned supervisor pid=${child.pid}, socket is now live`);
  return { spawned: true, pid: child.pid };
}

async function main() {
  const spawnResult = await ensureSupervisorRunning();
  const message = process.argv[2] || `hello from client pid=${process.pid}`;
  const reply = await sendAndReceive(SOCK_PATH, message);
  log(`sent: ${message.trim()}`);
  log(`received: ${reply.trim()}`);
  console.log(JSON.stringify({ ...spawnResult, sent: message, reply }));
}

main().catch((err) => {
  console.error("client fatal error:", err);
  process.exit(1);
});
