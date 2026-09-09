// demo-crash-recovery.mjs — Phase 0b gate item 3: prove restart recovery
// against a real, in-flight run.
//
// Step 1 (this script, "start" mode): start a real Claude Code run doing
// something that takes a few seconds, then exit immediately WITHOUT
// stopping it — leaving it in-flight and the supervisor's runs-state.json
// showing status: "running".
//
// A separate shell step then does `kill -9 <supervisor-pid>` — a real
// crash, not graceful shutdown — and restarts the supervisor.
//
// Step 2 (this script, "check" mode): call `list` on the freshly-restarted
// supervisor and print the reconciled row for the run started in step 1,
// to confirm it was marked `lost` or `orphaned-unmanaged` (per PLAN.md
// section 4's reconciliation rule), never silently `finished`/`completed`.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { ensureSupervisorRunning, sendCommand } from "./supervisorClient.mjs";
import { STATE_DIR } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testdir = path.join(__dirname, "testdir");
const markerPath = path.join(STATE_DIR, "crash-recovery-runid.json");

async function modeStart() {
  const spawnResult = await ensureSupervisorRunning();
  const ping = await sendCommand({ cmd: "ping" });
  console.log(`supervisor pid=${ping.pid} spawned=${JSON.stringify(spawnResult)}`);

  const start = await sendCommand({
    cmd: "start",
    harness: "claude-code",
    spec: {
      prompt:
        "Run the bash command `sleep 8 && echo SLOW_TASK_DONE`, wait for it to finish, then tell me it's done. Do not do anything else.",
      cwd: testdir,
    },
  });
  console.log(`started runId=${start.runId}`);
  await fs.writeFile(markerPath, JSON.stringify({ runId: start.runId, supervisorPid: ping.pid, startedAt: new Date().toISOString() }, null, 2));

  // Give the sleep 8 command time to actually be launched inside the
  // resident process before we (from the outside, via a separate shell
  // command) kill -9 the supervisor — we want the tool call genuinely
  // in-flight, not merely queued.
  await new Promise((r) => setTimeout(r, 3000));
  const list = await sendCommand({ cmd: "list" });
  console.log("pre-crash list:", JSON.stringify(list.runs, null, 2));
  console.log(`\nNow run: kill -9 ${ping.pid}`);
}

async function modeCheck() {
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  const spawnResult = await ensureSupervisorRunning();
  const ping = await sendCommand({ cmd: "ping" });
  console.log(`post-restart supervisor pid=${ping.pid} (was ${marker.supervisorPid}) spawned=${JSON.stringify(spawnResult)}`);

  const list = await sendCommand({ cmd: "list" });
  const row = list.runs.find((r) => r.runId === marker.runId);
  console.log("reconciled row for the pre-crash run:");
  console.log(JSON.stringify(row, null, 2));

  if (!row) {
    console.log("FAIL: run row missing entirely after restart");
    process.exit(1);
  }
  if (row.status === "lost" || row.status === "orphaned-unmanaged") {
    console.log(`PASS: run correctly marked '${row.status}', not silently finished/completed`);
  } else {
    console.log(`FAIL: run status is '${row.status}' — expected 'lost' or 'orphaned-unmanaged'`);
    process.exit(1);
  }
}

const mode = process.argv[2];
if (mode === "start") modeStart().catch((e) => { console.error(e); process.exit(1); });
else if (mode === "check") modeCheck().catch((e) => { console.error(e); process.exit(1); });
else {
  console.error("usage: node demo-crash-recovery.mjs start|check");
  process.exit(1);
}
