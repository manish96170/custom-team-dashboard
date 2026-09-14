// vault-projector-wiring.test.js — ROADMAP.md Phase 10 (Obsidian vault projection, basic tier),
// 2026-09-14. Proves the WIRING, not just the pure module: a real command through the real
// `authorizedCommandHandlers()` wrapper (the one choke point every wire command already passes
// through) schedules a debounced projection, and a real file on disk reflects current DB state once
// the debounce elapses — with no manual `project()` call anywhere in this test.
//
// Cases:
//   1. disabled (the built-in default, no config file at all): a real command through the wrapper
//      schedules nothing observable — the vault directory never appears, even after waiting past the
//      debounce window
//   2. enabled: a real command through the wrapper (`mintPrincipal`, chosen because it needs no task/
//      worker precondition of its own) triggers a debounced projection that picks up a task created
//      moments earlier — proving the projector reflects CURRENT total state, not just the triggering
//      command's own effect
//   3. boot() itself projects once immediately when enabled, before any command has run
//   4. shutdown() cancels a pending scheduled projection rather than letting it fire against a closed db

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDb, closeDb, createTask, createTeam, upsertHarness } from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { CONFIG_FILENAME as VAULT_CONFIG_FILENAME } from "../../config/vault-projector.js";
import { makeScratchDir, rmScratchDir, runTest, waitFor } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

await runTest("vault-projector wiring", async () => {
  // ── 1 ────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("supervisor-vault-projector-wiring-disabled");
    const vaultPath = path.join(stateDir, "vault");
    let db;
    let supervisor;
    try {
      db = openDb({ stateDir });
      upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
      supervisor = createSupervisor({
        db, adapters: { fake: createFakeHarness({ label: "vault-disabled" }) }, logger: quiet,
        askSweepIntervalMs: 0, vaultProjectorDebounceMs: 100,
      });
      const booted = await supervisor.boot();
      const handlers = supervisor.authorizedCommandHandlers();
      const ownerToken = fs.readFileSync(path.join(stateDir, "owner.token"), "utf8").trim();
      const result = await handlers.mintPrincipal({
        id: "cmd-1", token: ownerToken, preset: "worker", displayName: "disabled-test",
      });
      assert.equal(result.ok, true, `precondition: the command itself must succeed, got ${JSON.stringify(result)}`);
      await new Promise((r) => setTimeout(r, 300)); // past the 100ms debounce, with margin
      assert.equal(fs.existsSync(vaultPath), false, "disabled: no vault directory must ever appear, even after a real command and the debounce window");
      console.log("  1. disabled: a real command through the wrapper schedules nothing observable — no vault directory ever appears");
    } finally {
      try { await supervisor?.shutdown?.({ timeoutMs: 2000 }); } catch { /* best-effort */ }
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 2 ────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("supervisor-vault-projector-wiring-enabled");
    const vaultPath = path.join(stateDir, "vault");
    fs.writeFileSync(path.join(stateDir, VAULT_CONFIG_FILENAME), JSON.stringify({ enabled: true, vaultPath }));
    let db;
    let supervisor;
    try {
      db = openDb({ stateDir });
      upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
      createTeam(db, { id: "team-w", name: "Wiring Team" });
      createTask(db, { id: "task-w", title: "wired-in task", type: "feature", teamId: "team-w" });

      supervisor = createSupervisor({
        db, adapters: { fake: createFakeHarness({ label: "vault-enabled" }) }, logger: quiet,
        askSweepIntervalMs: 0, vaultProjectorDebounceMs: 100,
      });
      await supervisor.boot({ sweepAsksOnBoot: false }); // case 3 covers the boot-projects-once behavior on its own
      const handlers = supervisor.authorizedCommandHandlers();
      const ownerToken = fs.readFileSync(path.join(stateDir, "owner.token"), "utf8").trim();

      const result = await handlers.mintPrincipal({
        id: "cmd-2", token: ownerToken, preset: "worker", displayName: "enabled-test",
      });
      assert.equal(result.ok, true, `precondition: the command itself must succeed, got ${JSON.stringify(result)}`);

      await waitFor(() => fs.existsSync(path.join(vaultPath, "tasks", "task-w.md")), {
        timeoutMs: 3000, what: "a debounced projection picking up the pre-existing task after a real wire command",
      });
      const content = fs.readFileSync(path.join(vaultPath, "tasks", "task-w.md"), "utf8");
      assert.match(content, /title: "wired-in task"/);
      console.log("  2. enabled: a real command through the wrapper schedules a debounced projection that reflects current DB state");
    } finally {
      try { await supervisor?.shutdown?.({ timeoutMs: 2000 }); } catch { /* best-effort */ }
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 3 ────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("supervisor-vault-projector-wiring-boot");
    const vaultPath = path.join(stateDir, "vault");
    fs.writeFileSync(path.join(stateDir, VAULT_CONFIG_FILENAME), JSON.stringify({ enabled: true, vaultPath }));
    let db;
    let supervisor;
    try {
      db = openDb({ stateDir });
      upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
      createTeam(db, { id: "team-boot", name: "Boot Team" });

      supervisor = createSupervisor({
        db, adapters: { fake: createFakeHarness({ label: "vault-boot" }) }, logger: quiet,
        askSweepIntervalMs: 0, vaultProjectorDebounceMs: 100,
      });
      await supervisor.boot({ sweepAsksOnBoot: true });
      assert.ok(fs.existsSync(path.join(vaultPath, "teams", "team-boot.md")), "boot() itself must project once immediately when enabled, with no command and no debounce wait");
      console.log("  3. boot() projects once immediately when enabled, before any command has run");
    } finally {
      try { await supervisor?.shutdown?.({ timeoutMs: 2000 }); } catch { /* best-effort */ }
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 4 ────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("supervisor-vault-projector-wiring-shutdown");
    const vaultPath = path.join(stateDir, "vault");
    fs.writeFileSync(path.join(stateDir, VAULT_CONFIG_FILENAME), JSON.stringify({ enabled: true, vaultPath }));
    let db;
    let supervisor;
    try {
      db = openDb({ stateDir });
      upsertHarness(db, { id: "fake", displayName: "Fake Harness" });

      // A long debounce, deliberately — long enough that shutdown() below is certain to run BEFORE it
      // would otherwise fire, so this proves cancellation rather than a race that happens to look right.
      supervisor = createSupervisor({
        db, adapters: { fake: createFakeHarness({ label: "vault-shutdown" }) }, logger: quiet,
        askSweepIntervalMs: 0, vaultProjectorDebounceMs: 5000,
      });
      await supervisor.boot({ sweepAsksOnBoot: false });
      const handlers = supervisor.authorizedCommandHandlers();
      const ownerToken = fs.readFileSync(path.join(stateDir, "owner.token"), "utf8").trim();
      await handlers.mintPrincipal({
        id: "cmd-4", token: ownerToken, preset: "worker", displayName: "shutdown-test",
      });
      // The scheduled projection is now pending, ~5s out. Shut down immediately.
      await supervisor.shutdown({ timeoutMs: 2000 });
      closeDb(db);
      db = null;
      // If the pending timer had NOT been cancelled, it would fire against a closed db around now and
      // either throw inside a bare setTimeout callback (an unhandled exception, not just a log line) or
      // write to a directory nobody asked it to touch this late — wait past its original deadline and
      // confirm neither happened.
      await new Promise((r) => setTimeout(r, 5500));
      assert.equal(fs.existsSync(vaultPath), false, "a scheduled projection must be cancelled by shutdown(), never left to fire against a closed database later");
      console.log("  4. shutdown() cancels a pending scheduled projection rather than letting it fire against a closed db");
    } finally {
      try { if (db) closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }
});
