// Standard proven scenario, ported from spike-0b/packaging-probe: a normal
// SIGTERM/SIGINT lets the holder run its release handler, so the lock file is
// removed cleanly (as opposed to the stale-after-SIGKILL case).

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { assert, assertEqual } from "./assert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(__dirname, "helper-holder.js");

function spawnIndefiniteHolder(lockPath) {
  const child = spawn(process.execPath, [HELPER, lockPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => lines.push(JSON.parse(line)));
  return { child, lines };
}

async function scenario(signal) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ctd-lock-graceful-${signal}-`));
  const lockPath = path.join(dir, "supervisor.lock");

  const holder = spawnIndefiniteHolder(lockPath);
  // Wait for the acquire line.
  await new Promise((resolve) => {
    const check = () => {
      if (holder.lines.length >= 1) resolve();
      else setTimeout(check, 10);
    };
    check();
  });
  assertEqual(holder.lines[0].acquired, true, "holder must acquire before we signal it");

  const exitPromise = new Promise((resolve) => holder.child.once("exit", resolve));
  holder.child.kill(signal);
  await exitPromise;

  assertEqual(holder.lines.length, 2, `holder must print a release confirmation after ${signal}`);
  assertEqual(holder.lines[1].released, true, `holder must have released cleanly on ${signal}`);

  const existsAfter = await fs
    .access(lockPath)
    .then(() => true)
    .catch(() => false);
  assert(!existsAfter, `lock file must be gone after graceful ${signal} shutdown, not left stale`);

  await fs.rm(dir, { recursive: true, force: true });
  console.log(`PASS: graceful ${signal} shutdown releases the lock cleanly`);
}

async function main() {
  await scenario("SIGTERM");
  await scenario("SIGINT");
}

main()
  .then(() => {
    console.log("graceful-release.test.js: ALL PASS");
    process.exit(0);
  })
  .catch((err) => {
    console.error("graceful-release.test.js: FAIL");
    console.error(err);
    process.exit(1);
  });
