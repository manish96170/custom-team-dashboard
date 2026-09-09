// process-group.test.js — proves the two properties Group 5's ownership work claims:
//
//   1. A managed child leads its OWN process group (pgid === pid), verified by reading
//      the pgid back from the OS — and killing that group reaches the child's own
//      descendants without touching anything else. The test also spawns a control child
//      the old way (plain `spawn`, no `detached`) and asserts it lands in the
//      *supervisor's* process group: that is the pre-fix behavior, demonstrated in the
//      same run rather than asserted from memory.
//
//   2. `DASHBOARD_SPAWN_DEPTH` is set on every managed child, and a managed child that
//      tries to spawn a further managed run is refused.

import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawnManaged, killProcessGroup, currentSpawnDepth, childSpawnEnv, SPAWN_DEPTH_ENV, SpawnDepthExceededError } from "../spawn.js";
import { readProcInfo, listProcessGroup, isPidAlive } from "../procinfo.js";
import { runTest, waitFor, sleep } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function collect(child) {
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  return () => out;
}

await runTest("process-group", async () => {
  // ── 1a. managed child leads its own group, and its grandchild joins that group ──
  // `sleep 30 & wait` gives the child a real descendant, so "kill the group" has
  // something to prove beyond killing one pid.
  const { child, identity } = spawnManaged({ command: "sh", args: ["-c", "sleep 30 & wait"] });
  const id = await identity;
  console.log("managed child identity:", id);
  assert.equal(id.verified, true, `identity must verify: ${id.reason ?? ""}`);
  assert.equal(id.pgid, child.pid, "managed child must lead its own process group (pgid === pid)");
  assert.notEqual(id.pgid, process.pid, "managed child must NOT be in the supervisor's process group");
  assert.ok(id.lstart, "start time must be captured (this is the pid-reuse guard)");

  const group = await waitFor(async () => {
    const rows = await listProcessGroup(id.pgid);
    return rows.length >= 2 ? rows : null;
  }, { what: "the child's grandchild to join its process group" });
  console.log(`process group ${id.pgid} contains ${group.length} processes:`, group.map((r) => r.pid));
  const grandchildPid = group.map((r) => r.pid).find((p) => p !== child.pid);
  assert.ok(grandchildPid, "expected a grandchild pid in the group");

  // ── 1b. control: the pre-fix spawn inherits the supervisor's group ──
  const inherited = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
  const inheritedInfo = await waitFor(async () => {
    const i = await readProcInfo(inherited.pid);
    return i.alive ? i : null;
  }, { what: "the control child to appear in ps" });
  const self = await readProcInfo(process.pid);
  console.log("control (plain spawn, no detached) identity:", inheritedInfo, "supervisor's own:", self);
  assert.equal(
    inheritedInfo.pgid,
    self.pgid,
    "control child should share the supervisor's process group — this is the pre-fix behavior the fix replaces " +
      "(note the supervisor is not itself a group leader here, so the inherited pgid is its shell's, not its pid)",
  );
  assert.notEqual(inheritedInfo.pgid, inherited.pid, "control child should NOT lead its own group");
  inherited.kill("SIGKILL");

  // ── 1c. killing the managed group takes the child AND its grandchild ──
  const result = await killProcessGroup(id.pgid, { graceMs: 1500 });
  console.log("killProcessGroup result:", result);
  assert.equal(result.killed, true, "the process group must actually be gone after killProcessGroup");
  await waitFor(() => !isPidAlive(child.pid), { what: "the managed child to die" });
  await waitFor(() => !isPidAlive(grandchildPid), { what: "the grandchild to die with its group" });
  console.log(`both pid ${child.pid} and grandchild pid ${grandchildPid} are gone`);

  // The supervisor is obviously still here — a group kill must not have reached us.
  assert.ok(isPidAlive(process.pid), "the supervisor must survive killing a run's process group");

  // ── 2a. DASHBOARD_SPAWN_DEPTH is set on the managed child ──
  const depthProbe = spawnManaged({ command: "sh", args: ["-c", `printf %s "$${SPAWN_DEPTH_ENV}"`] });
  const readOut = collect(depthProbe.child);
  await new Promise((r) => depthProbe.child.on("exit", r));
  assert.equal(readOut(), "1", `managed child must see ${SPAWN_DEPTH_ENV}=1, saw "${readOut()}"`);
  console.log(`managed child observed ${SPAWN_DEPTH_ENV}=${readOut()}`);

  // ── 2b. a managed child at the ceiling is refused when it tries to spawn again ──
  const guardChild = spawn(process.execPath, [path.join(__dirname, "_depth-child.js")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, [SPAWN_DEPTH_ENV]: "1" },
  });
  const guardOut = collect(guardChild);
  let guardErr = "";
  guardChild.stderr.on("data", (d) => (guardErr += d));
  const guardCode = await new Promise((r) => guardChild.on("exit", r));
  assert.equal(guardCode, 0, `depth-guard child exited ${guardCode}\nstderr:\n${guardErr}`);
  const guardReport = JSON.parse(guardOut().trim());
  console.log("depth-guard child report:", guardReport);
  assert.equal(guardReport.seenDepth, 1, "child should observe depth 1");
  assert.equal(guardReport.refused, true, "a depth-1 managed child must be refused when spawning a managed run");
  assert.equal(guardReport.spawnedPid, null, "no grandchild run may be spawned at depth 2");

  // ── 2c. unit-level: the guard's own arithmetic ──
  assert.equal(currentSpawnDepth({}), 0, "absent env var means depth 0 (the supervisor)");
  assert.equal(currentSpawnDepth({ [SPAWN_DEPTH_ENV]: "not-a-number" }), 1, "a malformed depth must fail closed, at the ceiling");
  assert.equal(childSpawnEnv({}, {})[SPAWN_DEPTH_ENV], "1", "supervisor's children spawn at depth 1");
  assert.throws(
    () => childSpawnEnv({}, { [SPAWN_DEPTH_ENV]: "1" }),
    SpawnDepthExceededError,
    "depth 1 must refuse to produce a depth-2 env",
  );
  assert.throws(
    () => childSpawnEnv({}, { [SPAWN_DEPTH_ENV]: "garbage" }),
    SpawnDepthExceededError,
    "a malformed depth must refuse too, not pass through",
  );

  await sleep(50);
});
