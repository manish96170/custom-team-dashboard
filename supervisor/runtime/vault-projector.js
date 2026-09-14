// vault-projector.js — Phase 10 (Obsidian vault projection, basic tier), PLAN.md §18, 2026-09-14.
//
// STRICTLY READ-ONLY, STRICTLY DERIVED — PLAN.md §18's one rule. This module only ever READS `teams`/
// `tasks`/`workers`/`asks`/`runs` and WRITES markdown files; nothing anywhere reads a vault file back as
// truth, and nothing here ever mutates the database. Debounced (~1s, PLAN.md §18): `scheduleProject()` is
// what every real trigger call site calls, and it coalesces bursts of activity into one regenerate.
//
// EVERY FIELD PROJECTED IS AN EXPLICIT COLUMN NAME, NEVER `SELECT *` — the same "declare exactly what's
// included" discipline `domain/mcp-manifest.js`'s `ROLE_MCP_TOOL_ALLOWLIST` already uses. Checked against
// the real schema before writing this (`db/migrations/0001_initial.sql`): `teams`/`tasks`/`workers` have
// NO credential-shaped column at all (principal tokens live only in `principals.token_sha256`, a table
// this module never touches). The one column that DOES carry free text — `asks.question` — is
// deliberately NOT projected even as a preview; PLAN.md §18's own "keep tier-1 transcripts out of the
// vault" warning is honored here at its strictest for this basic tier: only a COUNT of open asks per
// task, never any ask's actual text. `runs.prompt_preview` is excluded from the orphan listing for the
// same reason — a live orphan is shown by identity (pid/pgid/cwd/timestamps), never by what it was asked
// to do.
//
// FULL REGENERATION EVERY DEBOUNCE FIRING, NOT AN INCREMENTAL DIFF — the vault is a projection, not a
// journal; regenerating from the current DB state every time is what makes "strictly derived" actually
// true (an incremental writer that only ever adds/updates files would let a DELETED task's note linger
// forever, silently becoming the one piece of the vault that ISN'T derived from current truth). Stale
// per-entity files (a task/team/worker that no longer exists) are removed on every regeneration.

import fs from "node:fs";
import path from "node:path";
import { loadVaultProjectorConfig } from "../config/vault-projector.js";

const ENTITY_DIRS = Object.freeze(["teams", "tasks", "workers"]);

function frontmatter(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function slugFileName(id) {
  // Ids in this schema are already safe path segments (`t-...`, `w-...`, uuids) — this is a defensive
  // floor, not a real slugifier, so an id with an unexpected character never escapes `vaultPath`.
  return `${String(id).replace(/[^a-zA-Z0-9._-]/g, "_")}.md`;
}

function renderTeam(team) {
  return frontmatter({ id: team.id, name: team.name, hiddenFromTopBar: !!team.hidden_from_top_bar })
    + `# ${team.name}\n\nTeam ID: \`${team.id}\`\n`;
}

function renderWorker(worker, { taskTitleById }) {
  const taskLink = worker.task_id && taskTitleById.has(worker.task_id)
    ? `[[${slugFileName(worker.task_id).replace(/\.md$/, "")}|${taskTitleById.get(worker.task_id)}]]`
    : worker.task_id ?? "(none)";
  return frontmatter({
    workerId: worker.worker_id, nickname: worker.nickname, role: worker.role,
    teamId: worker.team_id, taskId: worker.task_id, status: worker.status,
  }) + `# ${worker.nickname}\n\n- Role: ${worker.role}\n- Status: ${worker.status}\n- Task: ${taskLink}\n`;
}

function renderTask(task, { workerLines, openAskCount }) {
  const teamLink = task.team_id ? `[[${slugFileName(task.team_id).replace(/\.md$/, "")}]]` : "(none)";
  return frontmatter({
    id: task.id, title: task.title, type: task.type, state: task.state, teamId: task.team_id,
    branch: task.branch, createdAt: task.created_at, updatedAt: task.updated_at,
  }) + `# ${task.title}\n\n- State: ${task.state}\n- Type: ${task.type}\n- Team: ${teamLink}\n`
    + `- Open asks: ${openAskCount}\n\n## Workers\n\n${workerLines.length ? workerLines.join("\n") : "(none assigned)"}\n`;
}

function renderDashboard({ tasks, openAskCountByTask, orphans, generatedAt }) {
  const byState = new Map();
  for (const t of tasks) {
    if (!byState.has(t.state)) byState.set(t.state, []);
    byState.get(t.state).push(t);
  }
  const stateLines = [...byState.entries()].map(([state, list]) => (
    `### ${state} (${list.length})\n\n`
    + list.map((t) => `- [[${slugFileName(t.id).replace(/\.md$/, "")}|${t.title}]]`).join("\n")
  )).join("\n\n");

  const staleAsks = tasks.filter((t) => (openAskCountByTask.get(t.id) ?? 0) > 0);
  const askLines = staleAsks.length
    ? staleAsks.map((t) => `- [[${slugFileName(t.id).replace(/\.md$/, "")}|${t.title}]] — ${openAskCountByTask.get(t.id)} open`).join("\n")
    : "(none)";

  const orphanLines = orphans.length
    ? orphans.map((o) => `- run \`${o.run_id}\` (harness ${o.harness_id}, pid ${o.pid ?? "?"}, cwd \`${o.cwd ?? "?"}\`) — first seen ${o.first_seen_at}, ${o.sighting_count} sighting(s)`).join("\n")
    : "(none)";

  return `# Dashboard\n\n_Generated ${generatedAt} — strictly derived, never edited by hand (PLAN.md §18)._\n\n`
    + `## Tasks by state\n\n${stateLines || "(no tasks)"}\n\n`
    + `## Workers with open asks\n\n${askLines}\n\n`
    + `## Live orphans (unmanaged processes)\n\n${orphanLines}\n`;
}

/** Remove every file in `dir` (non-recursive, entity dirs are flat) whose name is not in `keepNames` —
 *  what makes a deleted task/team/worker's note actually disappear on the next regeneration. */
function pruneStale(dir, keepNames) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!keepNames.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * createVaultProjector({ db, logger, loadConfig, stateDir, debounceMs }) -> { scheduleProject, project, dispose }
 *
 * `loadConfig` is injected (defaults to the real `config/vault-projector.js`) — same "inject rather than
 * hard-wire" reasoning `createSlackOutboxDrain` already uses.
 */
export function createVaultProjector({ db, logger = console, loadConfig = loadVaultProjectorConfig, stateDir, debounceMs = 1000 } = {}) {
  let timer = null;

  function project() {
    const config = loadConfig({ stateDir });
    // "No optional integration is ever a hard dependency" (PLAN.md §19) — disabled is the built-in
    // default, and while disabled this function must not touch the filesystem AT ALL, not even to
    // create an empty vault directory.
    if (!config.enabled) return { projected: false, reason: "disabled" };

    const teams = db.prepare(`SELECT id, name, hidden_from_top_bar FROM teams`).all();
    const tasks = db.prepare(`SELECT id, title, type, state, team_id, branch, created_at, updated_at FROM tasks`).all();
    const workers = db.prepare(`SELECT worker_id, nickname, role, team_id, task_id, status FROM workers`).all();
    const openAskRows = db.prepare(`SELECT task_id, COUNT(*) AS n FROM asks WHERE resolved = 0 GROUP BY task_id`).all();
    const orphans = db.prepare(
      `SELECT r.run_id, r.harness_id, r.pid, r.cwd,
              (SELECT COUNT(*) FROM orphan_sightings s WHERE s.run_id = r.run_id) AS sighting_count,
              (SELECT MIN(seen_at) FROM orphan_sightings s WHERE s.run_id = r.run_id) AS first_seen_at
         FROM runs r WHERE r.ended_at IS NULL AND r.lifecycle = 'orphaned-unmanaged'
         ORDER BY r.started_at`,
    ).all();

    const openAskCountByTask = new Map(openAskRows.map((r) => [r.task_id, r.n]));
    const taskTitleById = new Map(tasks.map((t) => [t.id, t.title]));
    const workersByTask = new Map();
    for (const w of workers) {
      if (!w.task_id) continue;
      if (!workersByTask.has(w.task_id)) workersByTask.set(w.task_id, []);
      workersByTask.get(w.task_id).push(w);
    }

    fs.mkdirSync(config.vaultPath, { recursive: true });

    const teamNames = new Set();
    for (const team of teams) {
      const name = slugFileName(team.id);
      teamNames.add(name);
      writeFileEnsuringDir(path.join(config.vaultPath, "teams", name), renderTeam(team));
    }
    pruneStale(path.join(config.vaultPath, "teams"), teamNames);

    const workerNames = new Set();
    for (const worker of workers) {
      const name = slugFileName(worker.worker_id);
      workerNames.add(name);
      writeFileEnsuringDir(path.join(config.vaultPath, "workers", name), renderWorker(worker, { taskTitleById }));
    }
    pruneStale(path.join(config.vaultPath, "workers"), workerNames);

    const taskNames = new Set();
    for (const task of tasks) {
      const name = slugFileName(task.id);
      taskNames.add(name);
      const workerLines = (workersByTask.get(task.id) ?? []).map(
        (w) => `- [[${slugFileName(w.worker_id).replace(/\.md$/, "")}|${w.nickname}]] (${w.role})`,
      );
      writeFileEnsuringDir(
        path.join(config.vaultPath, "tasks", name),
        renderTask(task, { workerLines, openAskCount: openAskCountByTask.get(task.id) ?? 0 }),
      );
    }
    pruneStale(path.join(config.vaultPath, "tasks"), taskNames);

    writeFileEnsuringDir(
      path.join(config.vaultPath, "Dashboard.md"),
      renderDashboard({ tasks, openAskCountByTask, orphans, generatedAt: new Date().toISOString() }),
    );

    return { projected: true, teams: teams.length, tasks: tasks.length, workers: workers.length, orphans: orphans.length };
  }

  /** The debounced entry point every real trigger calls — coalesces a burst of commands into one
   *  regenerate ~`debounceMs` after the LAST one, not the first (a `setTimeout` reset on every call). */
  function scheduleProject() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        project();
      } catch (err) {
        logger.warn?.(`[vault-projector] scheduled projection failed (non-fatal): ${err.message}`);
      }
    }, debounceMs);
    timer.unref?.();
  }

  function dispose() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return { project, scheduleProject, dispose };
}
