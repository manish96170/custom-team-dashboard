// secret-scan.test.js — Phase 12 (Release hardening), ROADMAP.md's "secret scanning across the
// database, event log" checklist item (the vault-projection half of that item already has its own real
// scan in `runtime/test/vault-projector.test.js` cases 4-5 — this file does not duplicate that).
//
// `db/test/redaction.test.js` already proves ONE specific secret pattern (a prompt containing
// "SECRET_TOKEN=...") is redacted on the ONE path that opts out of persisting it. This is a broader,
// real scan: mint a REAL principal the same way `runtime/supervisor.js`'s `ensureWorkerPrincipal` does
// (a random 32-byte hex token, only its SHA-256 hash ever handed to `mintPrincipal`), then run a
// realistic sequence of the other write paths a live daemon actually uses — `recordEvent` (event_log),
// `journalAppend` (agent_journal) — and scan the RAW on-disk sqlite bytes (main file + WAL, if present)
// for the raw token. It must never appear: this codebase's own architecture never gives any INSERT
// statement the raw token at all (only `token_sha256` ever reaches a row), so this proves that
// architectural claim against real bytes on disk, not just by reading the code and trusting it.
//
// Cases:
//   1. a real principal's raw token never appears anywhere in the raw sqlite file (main + WAL) after a
//      realistic sequence of event_log/agent_journal writes
//   2. sanity check: the token's OWN sha256 hash (the thing that IS supposed to be persisted) is found —
//      proves the scan mechanism actually works, rather than passing vacuously because the scan itself
//      is broken

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  openDb, closeDb, upsertHarness, createTask, createWorker, createRun, recordEvent, mintPrincipal, journalAppend,
} from "../index.js";
import { defaultDbPath } from "../paths.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

function rawBytesOf(stateDir) {
  const dbPath = defaultDbPath(stateDir);
  const parts = [fs.readFileSync(dbPath)];
  for (const suffix of ["-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) parts.push(fs.readFileSync(p));
  }
  return Buffer.concat(parts);
}

await runTest("secret-scan", async () => {
  const stateDir = makeScratchDir("supervisor-secret-scan-test");
  try {
    const db = openDb({ stateDir });

    // Exactly the shape `ensureWorkerPrincipal` mints — a real 32-byte random hex token, only its hash
    // ever reaching a write.
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenSha256 = crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");

    upsertHarness(db, { id: "claude-code", displayName: "Claude Code" });
    createTask(db, { id: "task-1", title: "secret-scan fixture task", type: "feature" });
    createWorker(db, { workerId: "worker-1", nickname: "Purus", role: "coder", taskId: "task-1" });
    mintPrincipal(db, {
      id: "p-worker-1", kind: "worker", displayName: "Purus (coder)", workerId: "worker-1",
      capabilities: ["run:start"], tokenSha256,
    });
    createRun(db, { runId: "run-1", workerId: "worker-1", harnessId: "claude-code", prompt: "implement checkout" });

    // A realistic burst of the other real write paths — event_log and agent_journal — neither of which
    // this codebase's own code ever hands the raw token to (only `mintPrincipal`'s `tokenSha256` field
    // does, and that's a hash, not the secret itself).
    for (let i = 0; i < 20; i += 1) {
      recordEvent(db, { runId: "run-1", tier: 1, type: "assistant.delta", payload: { i, text: `chunk ${i}` } });
    }
    journalAppend(db, {
      principalId: "p-worker-1", action: "run:start", argsSha256: "deadbeef", outcome: "done",
      taskId: "task-1", argsPreview: "start run-1",
    });
    journalAppend(db, {
      principalId: "p-worker-1", action: "run:input", argsSha256: "cafef00d", outcome: "refused",
      taskId: "task-1", argsPreview: "unauthorized attempt", detail: "capability not held",
    });

    closeDb(db);

    const raw = rawBytesOf(stateDir);
    const rawStr = raw.toString("latin1"); // byte-preserving — a hex token has no multi-byte encoding to lose

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    assert.ok(!rawStr.includes(rawToken), "the raw principal token must never appear anywhere in the on-disk sqlite file (main + WAL)");
    console.log("  1. a real principal's raw token never appears anywhere in the raw sqlite file after a realistic sequence of event_log/agent_journal writes");

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    assert.ok(rawStr.includes(tokenSha256), "sanity: the token's own sha256 hash (what IS supposed to be persisted) must be found, proving this scan can actually detect a real match");
    console.log("  2. sanity check: the token's own sha256 hash is found — the scan mechanism actually works, not vacuously passing");
  } finally {
    rmScratchDir(stateDir);
  }
});
