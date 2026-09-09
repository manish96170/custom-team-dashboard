// _helpers.js — shared scratch-dir + seed-row helpers for the db/test/*.test.js scripts.
// Not itself a test; nothing here should be run directly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { openDb, upsertHarness, createTeam, createWorker } from "../index.js";

export function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function rmScratchDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Open a fresh db in a scratch state dir and seed the minimal FK-satisfying rows. */
export function openSeededDb(stateDir) {
  const db = openDb({ stateDir });
  upsertHarness(db, { id: "claude-code", displayName: "Claude Code" });
  createTeam(db, { id: "team-1", name: "Test Team" });
  createWorker(db, { workerId: "worker-1", nickname: "Purus", role: "coder", teamId: "team-1" });
  return db;
}

export function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Run an async main() with a hard pass/fail exit contract: prints captured evidence,
 * exits 0 only if main() resolves without throwing, exits 1 (and prints the error) on
 * any thrown assertion or unexpected exception. This is the standing rule from the
 * spike-0b review (TODO.md Group 6 note) applied to every script in this directory --
 * no test here may print output and exit 0 regardless of outcome.
 */
export async function runTest(name, main) {
  try {
    await main();
    console.log(`\nPASS: ${name}`);
    process.exit(0);
  } catch (err) {
    console.error(`\nFAIL: ${name}`);
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}
