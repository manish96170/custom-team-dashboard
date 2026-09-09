// Standard proven scenario, ported from spike-0b/packaging-probe/test-lock-race.js:
// N processes started simultaneously contend for the same lock file. Exactly one
// must win; the rest must cleanly report contention (not crash, not both "win").
// Run at N=2 and N=10, same as the spike proved, to confirm the temp-file+link
// rewrite in ../lock.js hasn't regressed the exclusivity property it's built on.
//
// Unlike the spike's version, every expectation here is a hard assertion that
// exits non-zero on failure.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { assert, assertEqual } from "./assert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(__dirname, "helper-holder.js");

async function freshLockPath(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ctd-lock-race-${label}-`));
  return path.join(dir, "supervisor.lock");
}

function runHelper(lockPath, holdMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, lockPath], {
      env: { ...process.env, CTD_HOLD_MS: String(holdMs) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      const lines = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      resolve({ code, lines, stderr });
    });
    child.on("error", reject);
  });
}

async function raceScenario(n) {
  const lockPath = await freshLockPath(`n${n}`);
  const holdMs = 300;

  const results = await Promise.all(
    Array.from({ length: n }, () => runHelper(lockPath, holdMs)),
  );

  for (const r of results) {
    assertEqual(r.code, 0, `helper process must exit 0, stderr=${r.stderr}`);
  }

  const firstLines = results.map((r) => r.lines[0]);
  const acquired = firstLines.filter((l) => l.acquired === true);
  const deferred = firstLines.filter((l) => l.acquired === false);

  assertEqual(acquired.length, 1, `exactly one of ${n} processes must acquire the lock`);
  assertEqual(deferred.length, n - 1, `the other ${n - 1} processes must report contention`);
  for (const d of deferred) {
    assertEqual(d.reason, "held-by-live-process", "deferred processes must report held-by-live-process, not treat the live holder as stale");
    assertEqual(d.holderPid, acquired[0].pid, "deferred processes must correctly identify the actual winner's PID as the holder");
  }

  const winnerResult = results.find((r) => r.lines[0].acquired === true);
  assertEqual(winnerResult.lines.length, 2, "winner must also print a release confirmation line");
  assertEqual(winnerResult.lines[1].released, true, "winner must have released cleanly");

  const lockFileExists = await fs
    .access(lockPath)
    .then(() => true)
    .catch(() => false);
  assert(!lockFileExists, "lock file must be gone after the winner releases");

  await fs.rm(path.dirname(lockPath), { recursive: true, force: true });
  console.log(`PASS: ${n}-way race — exactly one winner, ${n - 1} clean deferrals, clean release`);
}

async function main() {
  await raceScenario(2);
  await raceScenario(10);
}

main()
  .then(() => {
    console.log("race.test.js: ALL PASS");
    process.exit(0);
  })
  .catch((err) => {
    console.error("race.test.js: FAIL");
    console.error(err);
    process.exit(1);
  });
