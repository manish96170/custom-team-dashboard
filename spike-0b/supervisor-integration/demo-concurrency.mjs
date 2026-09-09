// demo-concurrency.mjs — Phase 0b gate item 2: prove two concurrent REAL
// sessions (one Claude Code, one OpenCode) through the real supervisor,
// and prove they progressed concurrently (interleaved timestamps), not
// sequentially.
//
// Writes every observed event to ./concurrency-evidence.log with a
// wall-clock timestamp and a [CC]/[OC] tag, plus a combined-in-arrival-order
// stream that is the actual evidence: if the harnesses ran sequentially,
// all [CC] lines would appear before all [OC] lines (or vice versa) in this
// file. If they ran concurrently, lines interleave.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { ensureSupervisorRunning, sendCommand, observeRun } from "./supervisorClient.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testdir = path.join(__dirname, "testdir");
const logPath = path.join(__dirname, "concurrency-evidence.log");

const lines = [];
function record(tag, text) {
  const line = `${new Date().toISOString()} [${tag}] ${text}`;
  lines.push(line);
  console.log(line);
}

async function main() {
  await fs.rm(logPath, { force: true });
  const spawnResult = await ensureSupervisorRunning();
  record("SUP", `ensureSupervisorRunning -> ${JSON.stringify(spawnResult)}`);

  const ping = await sendCommand({ cmd: "ping" });
  record("SUP", `supervisor pid=${ping.pid}`);

  const ccStart = await sendCommand({
    cmd: "start",
    harness: "claude-code",
    spec: {
      prompt:
        "List the files in this directory (just filenames, one per line) and then, for each one, read it and state its exact contents in one short sentence. End with the line FINISHED_CC.",
      cwd: testdir,
    },
  });
  record("CC", `start -> runId=${ccStart.runId}`);

  const ocStart = await sendCommand({
    cmd: "start",
    harness: "opencode",
    spec: {
      prompt:
        "List the files in this directory (just filenames, one per line) and then, for each one, read it and state its exact contents in one short sentence. End with the line FINISHED_OC.",
      cwd: testdir,
    },
  });
  record("OC", `start -> runId=${ocStart.runId}`);

  // Launch both observe streams truly concurrently — do not await one
  // before starting the other.
  const ccPromise = observeRun(ccStart.runId, (msg) => {
    if (msg.event) record("CC", `${msg.event.type} ${JSON.stringify(msg.event).slice(0, 200)}`);
    if (msg.done) record("CC", "stream done");
  });
  const ocPromise = observeRun(ocStart.runId, (msg) => {
    if (msg.event) record("OC", `${msg.event.type} ${JSON.stringify(msg.event).slice(0, 200)}`);
    if (msg.event?.type === "approval.request") {
      // OpenCode's approval protocol is a genuine async event (PLAN.md
      // section 4/7) — nothing answers it automatically, unlike Claude
      // Code's synchronous hook. Answer it from here, over the supervisor's
      // own control socket (not a direct fetch from the demo), to actually
      // exercise the supervisor's answerApproval command path.
      sendCommand({ cmd: "answerApproval", runId: ocStart.runId, approvalId: msg.event.approvalID, decision: "once" })
        .then(() => record("OC", `answered approval ${msg.event.approvalID} -> once`))
        .catch((err) => record("OC", `FAILED to answer approval: ${err}`));
    }
    if (msg.done) record("OC", "stream done");
  });

  await Promise.all([ccPromise, ocPromise]);

  const list = await sendCommand({ cmd: "list" });
  record("SUP", `final list: ${JSON.stringify(list.runs.map((r) => ({ runId: r.runId, harness: r.harness, status: r.status, turns: r.turns })))}`);

  await fs.writeFile(logPath, lines.join("\n") + "\n");
  console.log(`\nWrote ${lines.length} lines to ${logPath}`);

  // best-effort teardown of the resident processes this demo created
  await sendCommand({ cmd: "stop", runId: ccStart.runId }).catch(() => {});
  await sendCommand({ cmd: "stop", runId: ocStart.runId }).catch(() => {});
}

main().catch((err) => {
  console.error("demo-concurrency FAILED:", err);
  process.exit(1);
});
