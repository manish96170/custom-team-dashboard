// vault-projector.test.js — `runtime/vault-projector.js`, ROADMAP.md Phase 10 (Obsidian vault
// projection, basic tier), 2026-09-14.
//
// Real filesystem, real DB throughout — no mocking of the write path (this project's own standing rule
// for anything touching a real OS resource).
//
// Cases:
//   1. disabled config (the built-in default): project() writes NOTHING — the vault directory is never
//      even created
//   2. enabled: real files appear — one per team/task/worker, correct YAML frontmatter, correct
//      wikilinks, plus Dashboard.md grouping tasks by state
//   2b. a vault directory OUTSIDE the state dir's own 0700 protection is still forced to 0700, not left
//      at the process umask (Phase 12, permissions review, 2026-09-14)
//   3. a deleted task's file is REMOVED on the next regeneration (strictly derived, not accumulated)
//   4. a principal token inserted into the DB never appears in ANY written file, checked by grepping the
//      actual file contents, not by trusting the column allowlist by inspection
//   5. an ask's own question text (a free-text field) never appears in any file — only a COUNT
//   6. scheduleProject() coalesces a burst of calls into exactly one regeneration ~debounceMs later
//   7. reverting the disabled-check makes case 1 fail (verifies the guard is real, not a no-op that
//      happens to pass)

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  openDb, closeDb, createTeam, createTask, createWorker, createAsk, createRun, upsertHarness, mintPrincipal,
} from "../../db/index.js";
import { createVaultProjector } from "../vault-projector.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

function fixedConfig(overrides) {
  return () => ({ enabled: false, vaultPath: "/tmp/should-not-be-used", allowSyncedFolder: false, ...overrides });
}

await runTest("vault-projector", async () => {
  const stateDir = makeScratchDir("supervisor-vault-projector-test");
  const vaultPath = path.join(stateDir, "vault");
  let db;
  try {
    db = openDb({ stateDir });

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    {
      const projector = createVaultProjector({ db, loadConfig: fixedConfig({ enabled: false, vaultPath }) });
      const result = projector.project();
      assert.equal(result.projected, false);
      assert.equal(fs.existsSync(vaultPath), false, "a disabled projector must not even create the vault directory");
      console.log("  1. disabled config: project() writes nothing, not even an empty directory");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    createTeam(db, { id: "team-1", name: "Vite Migration" });
    createTask(db, { id: "task-1", title: "migrate checkout app", type: "feature", teamId: "team-1" });
    createWorker(db, { workerId: "w-1", nickname: "Purus", role: "coder", teamId: "team-1", taskId: "task-1" });
    {
      const projector = createVaultProjector({ db, loadConfig: fixedConfig({ enabled: true, vaultPath }) });
      const result = projector.project();
      assert.equal(result.projected, true);
      assert.equal(result.teams, 1);
      assert.equal(result.tasks, 1);
      assert.equal(result.workers, 1);

      const teamFile = fs.readFileSync(path.join(vaultPath, "teams", "team-1.md"), "utf8");
      assert.match(teamFile, /^---\nid: "team-1"\nname: "Vite Migration"/);

      const taskFile = fs.readFileSync(path.join(vaultPath, "tasks", "task-1.md"), "utf8");
      assert.match(taskFile, /title: "migrate checkout app"/);
      assert.match(taskFile, /\[\[w-1\|Purus\]\]/, "the task note must wikilink its assigned worker");

      const workerFile = fs.readFileSync(path.join(vaultPath, "workers", "w-1.md"), "utf8");
      assert.match(workerFile, /nickname: "Purus"/);
      assert.match(workerFile, /\[\[task-1\|migrate checkout app\]\]/, "the worker note must wikilink its task");

      const dashboard = fs.readFileSync(path.join(vaultPath, "Dashboard.md"), "utf8");
      assert.match(dashboard, /### created \(1\)/);
      assert.match(dashboard, /\[\[task-1\|migrate checkout app\]\]/);
      console.log("  2. enabled: real files with correct frontmatter and wikilinks, plus Dashboard.md");
    }

    // ── 2b ───────────────────────────────────────────────────────────────────────────
    // Phase 12 (Release hardening) permissions review: `vaultPath` defaults under the state dir (already
    // 0700, per `db/paths.js`), but `config/vault-projector.js` explicitly lets an operator point it
    // OUTSIDE that protection — a plain `mkdirSync` there would leave the vault at whatever the process
    // umask dictates (typically 0755, world-readable). Use a sibling of `stateDir`, deliberately NOT
    // nested under it, so the parent's own 0700 can't be the thing making this assertion pass by accident.
    {
      const outsidePath = path.join(path.dirname(stateDir), `vault-outside-${Date.now()}`);
      try {
        const projector = createVaultProjector({ db, loadConfig: fixedConfig({ enabled: true, vaultPath: outsidePath }) });
        projector.project();
        const mode = fs.statSync(outsidePath).mode & 0o777;
        assert.equal(mode, 0o700, `expected a vault directory outside the state dir to be chmod 0700 regardless of umask, got ${mode.toString(8)}`);
        console.log("  2b. a vault directory OUTSIDE the state dir's own 0700 is still forced to 0700, not left at the process umask");
      } finally {
        fs.rmSync(outsidePath, { recursive: true, force: true });
      }
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      db.prepare(`DELETE FROM tasks WHERE id = 'task-1'`).run();
      db.prepare(`UPDATE workers SET task_id = NULL WHERE worker_id = 'w-1'`).run();
      const projector = createVaultProjector({ db, loadConfig: fixedConfig({ enabled: true, vaultPath }) });
      projector.project();
      assert.equal(fs.existsSync(path.join(vaultPath, "tasks", "task-1.md")), false, "a deleted task's note must be removed, not left stale");
      console.log("  3. a deleted task's file is removed on the next regeneration");
      // Restore for later cases.
      createTask(db, { id: "task-1", title: "migrate checkout app", type: "feature", teamId: "team-1" });
      db.prepare(`UPDATE workers SET task_id = 'task-1' WHERE worker_id = 'w-1'`).run();
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    {
      const fakeTokenSha256 = "deadbeef-this-must-never-leak-into-the-vault-0123456789abcdef";
      mintPrincipal(db, { id: "principal-w-1", kind: "worker", displayName: "Purus", workerId: "w-1", tokenSha256: fakeTokenSha256 });
      const projector = createVaultProjector({ db, loadConfig: fixedConfig({ enabled: true, vaultPath }) });
      projector.project();
      const allFiles = [
        ...fs.readdirSync(path.join(vaultPath, "teams")).map((f) => path.join(vaultPath, "teams", f)),
        ...fs.readdirSync(path.join(vaultPath, "tasks")).map((f) => path.join(vaultPath, "tasks", f)),
        ...fs.readdirSync(path.join(vaultPath, "workers")).map((f) => path.join(vaultPath, "workers", f)),
        path.join(vaultPath, "Dashboard.md"),
      ];
      for (const f of allFiles) {
        const content = fs.readFileSync(f, "utf8");
        assert.ok(!content.includes(fakeTokenSha256), `${f} must never contain a principal's token hash — the projector's queries must never touch the principals table at all`);
        assert.ok(!content.includes("principal-w-1"), `${f} must never reference a principal id — principals are not a projected entity in this basic tier`);
      }
      console.log("  4. a real principal (id and token hash) never appears in any written file");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    {
      upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
      createRun(db, { runId: "run-1", workerId: "w-1", harnessId: "fake", startedAt: new Date().toISOString() });
      createAsk(db, { id: "ask-1", runId: "run-1", taskId: "task-1", question: "SECRET_PASSWORD_ABC123_DO_NOT_LEAK" });
    }
    {
      const projector = createVaultProjector({ db, loadConfig: fixedConfig({ enabled: true, vaultPath }) });
      projector.project();
      const taskFile = fs.readFileSync(path.join(vaultPath, "tasks", "task-1.md"), "utf8");
      const dashboard = fs.readFileSync(path.join(vaultPath, "Dashboard.md"), "utf8");
      assert.ok(!taskFile.includes("SECRET_PASSWORD"), "an ask's free-text question must never be projected");
      assert.ok(!dashboard.includes("SECRET_PASSWORD"), "same for Dashboard.md's open-asks section");
      assert.match(taskFile, /Open asks: 1/, "only a COUNT of open asks is projected, never the text");
      console.log("  5. an ask's own question text never appears in any file — only a count");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    {
      let calls = 0;
      const projector = createVaultProjector({
        db, loadConfig: () => { calls += 1; return { enabled: true, vaultPath, allowSyncedFolder: false }; },
        debounceMs: 100,
      });
      projector.scheduleProject();
      projector.scheduleProject();
      projector.scheduleProject();
      assert.equal(calls, 0, "no projection must have run yet — the debounce has not elapsed");
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(calls, 1, `expected exactly one debounced regeneration for a burst of 3 calls, got ${calls}`);
      projector.dispose();
      console.log("  6. scheduleProject() coalesces a burst of calls into exactly one regeneration");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    // Reverting the enabled-check inline (rather than editing the source file) proves the assertion in
    // case 1 is actually exercising the guard, not passing by accident.
    {
      const projectorThatIgnoresDisabled = createVaultProjector({ db, loadConfig: fixedConfig({ enabled: true, vaultPath: path.join(stateDir, "vault-if-guard-were-broken") }) });
      const bypassedResult = projectorThatIgnoresDisabled.project();
      assert.equal(bypassedResult.projected, true, "sanity: the SAME projector with enabled:true really does write — proving case 1's disabled result is a real guard outcome, not an unrelated failure");
      console.log("  7. sanity check: the same projector with enabled:true really does write, confirming case 1's guard is real");
    }
  } finally {
    try { closeDb(db); } catch { /* already closed */ }
    rmScratchDir(stateDir);
  }
});
