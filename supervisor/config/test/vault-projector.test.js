// vault-projector.test.js — `config/vault-projector.js`, pure. ROADMAP.md Phase 10 (Obsidian vault
// projection, basic tier), 2026-09-14.
//
// Cases:
//   1. no file at all -> the built-in default (DISABLED, vaultPath outside any repo) — "no optional
//      integration is ever a hard dependency" holds by construction
//   2. a well-formed enabled file is read as-is
//   3. an unknown top-level key throws
//   4. "enabled" must be a boolean
//   5. "vaultPath" must be a non-empty string
//   6. "allowSyncedFolder" must be a boolean
//   7. isInsideSyncedFolder: a real Dropbox/iCloud/Google Drive/OneDrive default path is detected
//   8. isInsideSyncedFolder: an unrelated path (even one that CONTAINS "Dropbox" as a substring, not a
//      real prefix) is NOT detected — a substring match would be a false positive this test catches
//   9. enabled: true with vaultPath inside a synced folder, no allowSyncedFolder -> throws
//   10. enabled: true with vaultPath inside a synced folder, allowSyncedFolder: true -> loads fine
//   11. enabled: false with vaultPath inside a synced folder -> loads fine (disabled means nothing is
//       ever written there, so the refusal does not need to fire)
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVaultProjectorConfig, isInsideSyncedFolder, BUILT_IN_DEFAULTS, CONFIG_FILENAME } from "../vault-projector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failed = 0;
let n = 0;
function testCase(name, fn) {
  n += 1;
  try { fn(); console.log(`  ${n}. ${name}`); } catch (err) {
    failed += 1;
    console.error(`  ${n}. FAIL: ${name}`);
    console.error(err);
  }
}

const FAKE_HOME = "/tmp/ctd-vault-projector-test-home";

testCase("no file at all falls back to the built-in default (disabled, vaultPath outside any repo)", () => {
  const result = loadVaultProjectorConfig({ fileText: undefined, stateDir: "/tmp/definitely-does-not-exist-ctd" });
  assert.equal(result.enabled, BUILT_IN_DEFAULTS.enabled);
  assert.equal(result.enabled, false, "the built-in default must be disabled");
  assert.equal(result.vaultPath, BUILT_IN_DEFAULTS.vaultPath);
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  assert.ok(
    !path.resolve(result.vaultPath).startsWith(repoRoot + path.sep),
    `the default vault path (${result.vaultPath}) must not live inside this repo (${repoRoot})`,
  );
  assert.equal(result.source, "built-in");
});

testCase("a well-formed enabled file is read as-is", () => {
  const result = loadVaultProjectorConfig({
    fileText: JSON.stringify({ enabled: true, vaultPath: "/tmp/my-vault", allowSyncedFolder: false }),
  });
  assert.equal(result.enabled, true);
  assert.equal(result.vaultPath, "/tmp/my-vault");
  assert.equal(result.allowSyncedFolder, false);
  assert.equal(result.source, "file");
});

testCase("an unrecognized top-level key throws", () => {
  assert.throws(
    () => loadVaultProjectorConfig({ fileText: JSON.stringify({ vault_path: "/tmp/x" }) }),
    new RegExp(`${CONFIG_FILENAME}.*unknown top-level key`),
  );
});

testCase(`"enabled" must be a boolean`, () => {
  assert.throws(
    () => loadVaultProjectorConfig({ fileText: JSON.stringify({ enabled: "yes" }) }),
    /"enabled" must be a boolean/,
  );
});

testCase(`"vaultPath" must be a non-empty string`, () => {
  assert.throws(
    () => loadVaultProjectorConfig({ fileText: JSON.stringify({ vaultPath: "" }) }),
    /"vaultPath" must be a non-empty string/,
  );
  assert.throws(
    () => loadVaultProjectorConfig({ fileText: JSON.stringify({ vaultPath: 42 }) }),
    /"vaultPath" must be a non-empty string/,
  );
});

testCase(`"allowSyncedFolder" must be a boolean`, () => {
  assert.throws(
    () => loadVaultProjectorConfig({ fileText: JSON.stringify({ allowSyncedFolder: "true" }) }),
    /"allowSyncedFolder" must be a boolean/,
  );
});

testCase("isInsideSyncedFolder detects a real Dropbox/iCloud/Google Drive/OneDrive default path", () => {
  assert.equal(isInsideSyncedFolder(path.join(FAKE_HOME, "Dropbox", "vault"), { home: FAKE_HOME }), true);
  assert.equal(isInsideSyncedFolder(path.join(FAKE_HOME, "Library", "Mobile Documents", "vault"), { home: FAKE_HOME }), true);
  assert.equal(isInsideSyncedFolder(path.join(FAKE_HOME, "Google Drive", "vault"), { home: FAKE_HOME }), true);
  assert.equal(isInsideSyncedFolder(path.join(FAKE_HOME, "OneDrive", "vault"), { home: FAKE_HOME }), true);
});

testCase("isInsideSyncedFolder does NOT false-positive on a substring match", () => {
  assert.equal(isInsideSyncedFolder(path.join(FAKE_HOME, "NotDropboxAtAll", "vault"), { home: FAKE_HOME }), false);
  assert.equal(isInsideSyncedFolder("/tmp/some/unrelated/path", { home: FAKE_HOME }), false);
});

// The LOADER (unlike the standalone `isInsideSyncedFolder` above) always checks against the REAL
// `os.homedir()` — it has no test-injection seam, deliberately, since production code must never be
// able to override whose home directory it protects. So these three cases use a real path under the
// REAL home, matching exactly what the loader itself will check.
const realDropboxPath = path.join(os.homedir(), "Dropbox", "ctd-vault-projector-test-vault");

testCase("enabled: true with vaultPath inside a synced folder, no allowSyncedFolder -> throws", () => {
  assert.throws(
    () => loadVaultProjectorConfig({
      fileText: JSON.stringify({ enabled: true, vaultPath: realDropboxPath }),
    }),
    /resolves inside a well-known cloud-sync folder/,
  );
});

testCase("enabled: true with vaultPath inside a synced folder, allowSyncedFolder: true -> loads fine", () => {
  const result = loadVaultProjectorConfig({
    fileText: JSON.stringify({ enabled: true, vaultPath: realDropboxPath, allowSyncedFolder: true }),
  });
  assert.equal(result.enabled, true);
  assert.equal(result.allowSyncedFolder, true);
});

testCase("enabled: false with vaultPath inside a synced folder -> loads fine (never written to while disabled)", () => {
  const result = loadVaultProjectorConfig({
    fileText: JSON.stringify({ enabled: false, vaultPath: realDropboxPath }),
  });
  assert.equal(result.enabled, false);
});

if (failed > 0) {
  console.error(`\nFAIL: vault-projector config (pure) — ${failed}/${n} case(s) failed`);
  process.exit(1);
}
console.log(`\nPASS: vault-projector config (pure)`);
