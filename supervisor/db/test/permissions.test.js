// permissions.test.js — proves the state directory is created 0700 and the db file
// (plus WAL/SHM sidecars once they exist) is 0600, by actually statSync-ing them after
// creation -- not by trusting that a chmod call succeeded.

import fs from "node:fs";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import { openDb, closeDb, recordEvent, upsertHarness, createTeam, createWorker, createRun } from "../index.js";
import { defaultDbPath } from "../paths.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

await runTest("permissions", async () => {
  const stateDir = makeScratchDir("supervisor-permissions-test");
  // makeScratchDir (fs.mkdtempSync) already creates the dir before openDb runs, at
  // whatever mode mkdtemp defaults to (0700 on most platforms, but we don't rely on
  // that -- openDb must force 0700 regardless of what it inherits).
  fs.chmodSync(stateDir, 0o755); // deliberately loosen it first, so the assertion below
  // actually proves openDb corrects the mode rather than happening to inherit a good one.
  try {
    const db = openDb({ stateDir });
    const dbPath = defaultDbPath(stateDir);

    const dirMode = modeOf(stateDir);
    const fileMode = modeOf(dbPath);

    console.log(`stateDir mode after openDb: ${dirMode.toString(8)}`);
    console.log(`dbPath mode after openDb: ${fileMode.toString(8)}`);
    console.log("ls -la evidence:\n" + execSync(`ls -la ${JSON.stringify(stateDir)}`).toString());

    assert.equal(dirMode, 0o700, `expected state dir mode 0700, got ${dirMode.toString(8)}`);
    assert.equal(fileMode, 0o600, `expected db file mode 0600, got ${fileMode.toString(8)}`);

    // Force WAL/SHM sidecars into existence by actually writing, then re-check those too.
    upsertHarness(db, { id: "claude-code", displayName: "Claude Code" });
    createTeam(db, { id: "team-1", name: "Test Team" });
    createWorker(db, { workerId: "worker-1", nickname: "Purus", role: "coder", teamId: "team-1" });
    createRun(db, {
      runId: "run-1",
      workerId: "worker-1",
      harnessId: "claude-code",
      prompt: "hello world, this should never be persisted verbatim by default",
    });
    for (let i = 0; i < 50; i++) {
      recordEvent(db, { runId: "run-1", tier: 1, type: "assistant.delta", payload: { i } });
    }

    const walPath = dbPath + "-wal";
    const shmPath = dbPath + "-shm";
    console.log("wal exists:", fs.existsSync(walPath), "shm exists:", fs.existsSync(shmPath));
    for (const p of [walPath, shmPath]) {
      if (fs.existsSync(p)) {
        const m = modeOf(p);
        console.log(`${p} mode: ${m.toString(8)}`);
        assert.equal(m, 0o600, `expected sidecar ${p} mode 0600, got ${m.toString(8)}`);
      }
    }

    console.log("ls -la evidence after writes:\n" + execSync(`ls -la ${JSON.stringify(stateDir)}`).toString());

    closeDb(db);
  } finally {
    rmScratchDir(stateDir);
  }
});
