#!/usr/bin/env node
// cli.js — attach a live pane to a run from a terminal.
//
//   node supervisor/pane/cli.js <runId> [--from-seq N] [--thinking] [--no-color] [--timestamps]
//   node supervisor/pane/cli.js --list
//
// This is the first thing in the project you can actually watch. It is not the TUI (that is
// Phase 4, against the mock harness, with the tree and the team bar) — it is one pane, which is
// what the Phase 2 slice requires: spawn -> live pane -> send input -> approval round trip.
//
// It is a plain client over the control socket, so it can be attached and detached freely while
// the run keeps going, and two of them can watch the same run: `observe` gives each subscriber its
// own cursor.

import readline from "node:readline";
import { attachPane, parsePaneCommand, PANE_HELP, readOwnerToken } from "./pane.js";
import { connect } from "../ipc/client.js";
import { defaultSockPath, defaultStateDir } from "../ipc/paths.js";

function parseArgv(argv) {
  const opts = { color: process.stdout.isTTY !== false, showThinking: false, timestamps: false, fromSeq: 0 };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--list") opts.list = true;
    else if (a === "--thinking") opts.showThinking = true;
    else if (a === "--no-color") opts.color = false;
    else if (a === "--timestamps") opts.timestamps = true;
    else if (a === "--from-seq") opts.fromSeq = Number(argv[++i] ?? 0);
    else if (a === "--sock") opts.sockPath = argv[++i];
    else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  opts.runId = positional[0];
  return opts;
}

// Fixed 2026-09-11 alongside `attachPane`'s own fix (`codexdoc/REVIEW-NOTES.md` finding 10) — `--list`
// went through the same tokenless client and would be refused identically.
async function listRuns(sockPath, stateDir) {
  const client = await connect(sockPath, { token: readOwnerToken(stateDir) });
  try {
    const [runs, orphans] = await Promise.all([client.send("list", {}), client.send("orphans", {})]);
    const rows = runs.runs ?? [];
    if (rows.length === 0) {
      process.stdout.write("no runs\n");
    } else {
      process.stdout.write("runId                                 harness       status\n");
      for (const r of rows) {
        process.stdout.write(`${String(r.runId).padEnd(38)}${String(r.harnessId ?? "").padEnd(14)}${r.exitReason ?? r.derived?.terminalStatus ?? "live"}\n`);
      }
    }
    // Surfaced here because an orphan is the case where a human most needs to know a process is
    // running that nothing is driving (migration 0003's whole point).
    for (const o of orphans.orphans ?? []) {
      process.stdout.write(`orphan: ${o.runId} pid=${o.pid} pgid=${o.processGroup} seen=${o.sightings}x ${o.title ?? ""}\n`);
    }
  } finally {
    client.close();
  }
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const stateDir = defaultStateDir();
  const sockPath = opts.sockPath ?? defaultSockPath(stateDir);

  if (opts.list) {
    await listRuns(sockPath, stateDir);
    return;
  }
  if (!opts.runId) {
    process.stderr.write("usage: node supervisor/pane/cli.js <runId> [--from-seq N] [--thinking] [--no-color]\n       node supervisor/pane/cli.js --list\n");
    process.exitCode = 2;
    return;
  }

  // How a changing line is presented, which is a terminal concern and so lives here rather than in
  // the renderer. On a TTY a streaming assistant line is redrawn in place; piped to a file it is
  // held back and written once, when something else closes it. Neither is the renderer's business,
  // and getting it wrong is what made the first captured transcript print each prose line once per
  // token.
  const isTty = process.stdout.isTTY === true;
  let held = null;
  const flushHeld = () => {
    if (held !== null) {
      process.stdout.write(`${held}\n`);
      held = null;
    }
  };
  const out = (line, { replacesPrevious } = {}) => {
    if (!replacesPrevious) {
      flushHeld();
      process.stdout.write(`${line}\n`);
      return;
    }
    if (isTty) process.stdout.write(`\r[2K${line}`);
    else held = line; // piped: keep only the latest state of the line
  };

  const pane = await attachPane({ ...opts, sockPath, out });
  flushHeld();
  process.stdout.write(`${PANE_HELP.join("\n")}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();

  rl.on("line", async (line) => {
    const cmd = parsePaneCommand(line);
    try {
      switch (cmd.kind) {
        case "input":
          await pane.sendInput(cmd.text);
          break;
        case "answer": {
          const result = await pane.answer(cmd);
          if (!result.ok) process.stdout.write(`  ${result.error}\n`);
          break;
        }
        case "interrupt":
          await pane.interrupt();
          break;
        case "asks":
          await pane.refreshAsks();
          if (pane.pending.length === 0) process.stdout.write("  nothing is blocked\n");
          for (const a of pane.pending) {
            process.stdout.write(`  ${a.askId} [${a.kind}] ${a.question}${a.answerable === false ? " (unanswerable)" : ""}\n`);
          }
          break;
        case "help":
          process.stdout.write(`${PANE_HELP.join("\n")}\n`);
          break;
        case "detach":
          rl.close();
          return;
        case "error":
          process.stdout.write(`  ${cmd.error}\n`);
          break;
        default:
          break;
      }
    } catch (err) {
      process.stdout.write(`  ${err.message}\n`);
    }
    rl.prompt();
  });

  // Detaching must never end the run — that is the difference between a pane and a terminal.
  rl.on("close", () => {
    pane.detach();
    process.stdout.write("detached (the run keeps going)\n");
    process.exit(0);
  });

  pane.streamEnded.then(() => {
    process.stdout.write(`\n${pane.doneReason ?? "stream ended"} — /detach to leave\n`);
    rl.prompt();
  });
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
