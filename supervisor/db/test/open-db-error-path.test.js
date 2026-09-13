// open-db-error-path.test.js — `openDb()`'s error path closes the handle it just opened rather than
// leaking it, added 2026-09-11 (older should-fix backlog, HANDOFF.md's "openDb() error-path handle
// leak").
//
// `new Database(dbPath)` opens a REAL file handle immediately, before any of `openDb`'s own
// pragma/migration steps run. If any of those steps threw, nothing closed that handle — every failed
// open leaked one file descriptor. Proven here against a REAL corrupt file (not a mock): better-sqlite3
// opens successfully on garbage bytes (construction alone reads no header), and the first pragma that
// actually reads the file (`journal_mode = WAL`, inside `setWalMode`) throws "file is not a database".
//
// `Database.prototype.close` is patched for the duration of this one case to count real close() calls —
// this affects every `Database` instance process-wide while patched (there is no per-instance hook to
// attach to instead), which is why it is restored in a `finally` immediately after the assertion.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../index.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

await runTest("openDb error-path handle leak", async () => {
  const stateDir = makeScratchDir("supervisor-opendb-errorpath-test");
  try {
    const dbPath = path.join(stateDir, "state.sqlite3");
    fs.writeFileSync(dbPath, "not a real sqlite database file at all, deliberately corrupt for this test\n");

    let closeCalls = 0;
    const originalClose = Database.prototype.close;
    Database.prototype.close = function patchedClose(...args) {
      closeCalls += 1;
      return originalClose.apply(this, args);
    };
    try {
      assert.throws(
        () => openDb({ stateDir, dbPath }),
        /file is not a database/,
        "precondition: openDb must actually throw against a corrupt file for this test to mean anything",
      );
    } finally {
      Database.prototype.close = originalClose;
    }
    assert.equal(closeCalls, 1, "openDb must close the handle it just opened before rethrowing, not leak it");
    console.log("  openDb closes the handle it opened before rethrowing when a later step throws");
  } finally {
    rmScratchDir(stateDir);
  }
});
