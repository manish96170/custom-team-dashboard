// _depth-child.js — spawned by process-group.test.js with DASHBOARD_SPAWN_DEPTH already
// set, to prove the recursion guard from inside a real managed child rather than by
// hand-constructing an env object in the parent. Prints one JSON line describing what
// happened when it tried to spawn a managed grandchild.

import { spawnManaged, currentSpawnDepth, SpawnDepthExceededError } from "../spawn.js";

const report = { seenDepth: currentSpawnDepth(), refused: false, error: null, spawnedPid: null };

try {
  const { child } = spawnManaged({ command: "sh", args: ["-c", "sleep 5"] });
  report.spawnedPid = child.pid;
  child.kill("SIGKILL");
} catch (err) {
  report.refused = err instanceof SpawnDepthExceededError;
  report.error = err.message;
}

process.stdout.write(`${JSON.stringify(report)}\n`);
