// Standard proven scenario, ported from spike-0b/packaging-probe: a holder is
// killed with SIGKILL (no chance to run its release handler), leaving a lock
// file behind that points at a now-dead PID. A subsequent acquireLock() must
// detect the dead PID, clean up, and take the lock — not refuse forever, and
// not (per the B1 fix) treat an unparseable file as automatically stale, since
// this file IS parseable (a real crash leaves real, complete, if stale, content
// — the temp-file+link design guarantees the file was fully written before it
// became visible, so a killed holder's lock file is never in the empty
// mid-write state the original bug exploited).

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
  const firstLine = new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    rl.once("line", (line) => {
      rl.close();
      resolve(JSON.parse(line));
    });
    child.once("error", reject);
  });
  return { child, firstLine };
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctd-lock-stale-"));
  const lockPath = path.join(dir, "supervisor.lock");

  const holder = spawnIndefiniteHolder(lockPath);
  const acquireResult = await holder.firstLine;
  assertEqual(acquireResult.acquired, true, "first holder must acquire the lock");

  const infoBeforeKill = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assertEqual(infoBeforeKill.pid, holder.child.pid, "lock file must record the holder's real PID");

  // Simulate a crash: SIGKILL, no cleanup handler runs.
  holder.child.kill("SIGKILL");
  await new Promise((resolve) => {
    holder.child.once("exit", resolve);
  });

  const infoAfterKill = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assertEqual(infoAfterKill.pid, holder.child.pid, "lock file must still be present and still point at the now-dead PID (stale, not cleaned up by the crash)");

  const { acquireLock, isPidAlive } = await import("../lock.js");
  assert(!isPidAlive(holder.child.pid), "sanity check: the killed holder's PID must actually be dead now");

  const second = await acquireLock(lockPath);
  assertEqual(second.acquired, true, "a fresh acquireLock() must detect the dead-PID stale lock, clean it up, and succeed");

  const infoAfterRecovery = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assertEqual(infoAfterRecovery.pid, process.pid, "lock file must now record the recovering process's own PID");

  await second.release();
  const existsAfterRelease = await fs
    .access(lockPath)
    .then(() => true)
    .catch(() => false);
  assert(!existsAfterRelease, "lock file must be removed after clean release");

  await fs.rm(dir, { recursive: true, force: true });
  console.log("PASS: stale lock (dead PID) after crash is detected and recovered");
}

main()
  .then(() => {
    console.log("stale-recovery.test.js: ALL PASS");
    process.exit(0);
  })
  .catch((err) => {
    console.error("stale-recovery.test.js: FAIL");
    console.error(err);
    process.exit(1);
  });
