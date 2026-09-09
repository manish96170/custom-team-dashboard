// index.js — the supervisor's persistence module. Open the database, enforce
// permissions on disk, run migrations, and expose a small set of targeted
// insert/update helpers (never a full-table read-modify-write).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { applyMigrations } from "./migrate.js";
import { defaultStateDir, defaultDbPath } from "./paths.js";
import { redactPrompt, fullPromptPersistenceEnabled } from "./redact.js";
import { canTransition } from "../domain/task-states.js";
import { requiredVerdictsFor } from "../domain/workflow-profiles.js";
import { isVerdict, VERDICTS } from "../domain/review.js";
import { validateCapabilities } from "../domain/capabilities.js";

const STATE_DIR_MODE = 0o700;
const DB_FILE_MODE = 0o600;

function nowIso() {
  return new Date().toISOString();
}

/** Create (if needed) and lock down the state directory's permissions. */
export function ensureStateDir(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: STATE_DIR_MODE });
  // mkdir's mode is subject to umask, so force it explicitly rather than trusting that.
  fs.chmodSync(stateDir, STATE_DIR_MODE);
  return stateDir;
}

/**
 * Re-assert 0600 on the main db file and any WAL-mode sidecar files that exist.
 * Called at open time and safe to call again after writes (WAL/SHM files are created
 * lazily on first write, so a fresh empty db won't have them yet).
 */
export function enforceFilePermissions(dbPath) {
  const results = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) {
      fs.chmodSync(p, DB_FILE_MODE);
      results[suffix || "main"] = fs.statSync(p).mode & 0o777;
    }
  }
  return results;
}

/** Synchronous sleep. better-sqlite3 is synchronous, so there is no event loop turn to
 * yield to here -- Atomics.wait on a throwaway buffer is the only way to actually wait
 * without busy-spinning the CPU. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Put the database into WAL mode, tolerating a concurrent process doing the same thing.
 *
 * Setting busy_timeout first is NOT sufficient on its own: converting a journal-mode
 * database to WAL needs exclusive access, and SQLite does not invoke the busy handler
 * for that conversion -- it returns SQLITE_BUSY immediately if any other connection has
 * the database open. So this retries around the conversion, and treats "somebody else
 * already made it WAL" as success. Once the file is WAL, `journal_mode = WAL` is a
 * no-op that needs no exclusive lock, so this loop only ever spins on the very first
 * open of a fresh database.
 */
function setWalMode(db, busyTimeoutMs) {
  const deadline = Date.now() + Math.max(busyTimeoutMs, 1000);
  for (;;) {
    try {
      const mode = db.pragma("journal_mode = WAL", { simple: true });
      if (mode === "wal") return mode;
      throw new Error(`could not enable WAL mode; journal_mode is "${mode}"`);
    } catch (err) {
      if (err.code !== "SQLITE_BUSY") throw err;
      // Another process is converting the same file right now. If it finished, we are
      // done; otherwise wait and retry until the timeout budget runs out.
      if (db.pragma("journal_mode", { simple: true }) === "wal") return "wal";
      if (Date.now() >= deadline) throw err;
      sleepSync(10);
    }
  }
}

/**
 * Open the supervisor's SQLite database: ensures the state dir exists at 0700, opens
 * (creating if absent) the db file, chmods it 0600, sets WAL mode + foreign keys +
 * a busy timeout so concurrent writers block-and-retry instead of erroring, and runs
 * any pending migrations.
 *
 * @param {{ stateDir?: string, dbPath?: string, busyTimeoutMs?: number }} [opts]
 */
export function openDb(opts = {}) {
  const stateDir = opts.stateDir || defaultStateDir();
  ensureStateDir(stateDir);
  const dbPath = opts.dbPath || defaultDbPath(stateDir);

  // Bug found by independent code review (2026-09-05): busy_timeout used to be set
  // AFTER `journal_mode = WAL`, so two processes opening the same fresh state dir at
  // once meant one of them failed immediately with SQLITE_BUSY, with no timeout
  // configured yet to absorb it. busy_timeout is a connection-level setting, so it goes
  // first: that covers every statement that follows, including the migrations below.
  const busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    // PRAGMA values can't be bound as parameters, so this is interpolated -- validate
    // it rather than splicing an arbitrary caller-supplied string into SQL.
    throw new Error(`busyTimeoutMs must be a non-negative integer, got ${JSON.stringify(opts.busyTimeoutMs)}`);
  }
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  setWalMode(db, busyTimeoutMs);
  db.pragma("foreign_keys = ON");

  enforceFilePermissions(dbPath);

  const migrationResult = applyMigrations(db);

  // WAL/SHM sidecars may have just been created by the migration's writes.
  enforceFilePermissions(dbPath);

  db.__dbPath = dbPath;
  db.__stateDir = stateDir;
  db.__migrationResult = migrationResult;
  return db;
}

export function closeDb(db) {
  db.close();
}

// ---------------------------------------------------------------------------
// Targeted writers. Every one of these is a single prepared-statement insert/update
// against an indexed key -- never a read-all-rows-then-rewrite-the-file operation.
// ---------------------------------------------------------------------------

export function upsertHarness(db, h) {
  db.prepare(
    `INSERT INTO harnesses (id, display_name, heartbeat_mechanism, config_path, status, capabilities_json, onboarded_at)
     VALUES (@id, @display_name, @heartbeat_mechanism, @config_path, @status, @capabilities_json, @onboarded_at)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       heartbeat_mechanism = excluded.heartbeat_mechanism,
       config_path = excluded.config_path,
       status = excluded.status,
       capabilities_json = excluded.capabilities_json,
       onboarded_at = excluded.onboarded_at`,
  ).run({
    id: h.id,
    display_name: h.displayName,
    heartbeat_mechanism: h.heartbeatMechanism ?? null,
    config_path: h.configPath ?? null,
    status: h.status ?? "not-configured",
    capabilities_json: h.capabilities ? JSON.stringify(h.capabilities) : null,
    onboarded_at: h.onboardedAt ?? nowIso(),
  });
  return h.id;
}

export function createTeam(db, t) {
  db.prepare(
    `INSERT INTO teams (id, name, hidden_from_top_bar) VALUES (?, ?, ?)`,
  ).run(t.id, t.name, t.hiddenFromTopBar ? 1 : 0);
  return t.id;
}

export function createWorker(db, w) {
  db.prepare(
    `INSERT INTO workers (worker_id, nickname, role, team_id, task_id, status, cwd, revision)
     VALUES (@worker_id, @nickname, @role, @team_id, @task_id, @status, @cwd, @revision)`,
  ).run({
    worker_id: w.workerId,
    nickname: w.nickname,
    role: w.role,
    team_id: w.teamId ?? null,
    task_id: w.taskId ?? null,
    status: w.status ?? "idle",
    cwd: w.cwd ?? null,
    revision: w.revision ?? 0,
  });
  return w.workerId;
}

export function createTask(db, t) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO tasks (id, title, aliases_json, team_id, type, state, main_worker_id, source,
       repo_id, worktree_id, branch, base_rev, harness_assignments_json, created_at, updated_at, revision)
     VALUES (@id, @title, @aliases_json, @team_id, @type, @state, @main_worker_id, @source,
       @repo_id, @worktree_id, @branch, @base_rev, @harness_assignments_json, @created_at, @updated_at, 0)`,
  ).run({
    id: t.id,
    title: t.title,
    aliases_json: t.aliases ? JSON.stringify(t.aliases) : null,
    team_id: t.teamId ?? null,
    type: t.type,
    state: t.state ?? "created",
    main_worker_id: t.mainWorkerId ?? null,
    source: t.source ?? null,
    repo_id: t.repoId ?? null,
    worktree_id: t.worktreeId ?? null,
    branch: t.branch ?? null,
    base_rev: t.baseRev ?? null,
    harness_assignments_json: t.harnessAssignments ? JSON.stringify(t.harnessAssignments) : null,
    created_at: now,
    updated_at: now,
  });
  return t.id;
}

/**
 * Create a run row. `prompt`, if given, is redacted at this write boundary per
 * db/redact.js: by default only a hash + ~200-char preview are persisted; full text
 * only if `persistFullPrompt: true` is passed explicitly or the
 * SUPERVISOR_PERSIST_FULL_PROMPTS env var opts in.
 */
export function createRun(db, r) {
  const redacted = redactPrompt(r.prompt, {
    persistFull: r.persistFullPrompt,
  });
  db.prepare(
    `INSERT INTO runs (run_id, worker_id, harness_id, harness_session_id, pid, process_group,
       generation, started_at, ended_at, exit_reason, prompt_sha256, prompt_preview, prompt_full,
       is_preflight, started_by)
     VALUES (@run_id, @worker_id, @harness_id, @harness_session_id, @pid, @process_group,
       @generation, @started_at, NULL, NULL, @prompt_sha256, @prompt_preview, @prompt_full,
       @is_preflight, @started_by)`,
  ).run({
    run_id: r.runId,
    worker_id: r.workerId,
    harness_id: r.harnessId,
    harness_session_id: r.harnessSessionId ?? null,
    pid: r.pid ?? null,
    process_group: r.processGroup ?? null,
    generation: r.generation ?? 1,
    started_at: r.startedAt ?? nowIso(),
    prompt_sha256: redacted.sha256,
    prompt_preview: redacted.preview,
    prompt_full: redacted.full,
    // 0005: marked from the START, not on the way out. A preflight that crashes between
    // `start()` and its cleanup has to be recognisable as a preflight by the reconciliation
    // that finds it, and nothing can set a flag after a SIGKILL.
    is_preflight: r.isPreflight ? 1 : 0,
    // 0008: provenance. 'dashboard' is the only value the orphan reaper may act on, so the default
    // here matters -- an unstated origin must mean "we started it", never "unknown".
    started_by: r.startedBy ?? (r.isPreflight ? "preflight" : "dashboard"),
  });
  return r.runId;
}

/**
 * Close a run with a terminal reason. **First writer wins** — the `ended_at IS NULL` guard
 * makes that a property of the statement, matching `reconcileRun` below.
 *
 * Without the guard this was a check-then-act race in every caller: `onEnd` (natural
 * completion), `stop()`, and `reap()` each do `getRun()` then `endRun()` as two separate
 * statements, so a run finishing at the same instant a client stops it had both paths read
 * `ended_at: null` and both write — the second silently overwriting the first's
 * `exit_reason`, e.g. a deliberate "stopped" becoming "finished". Callers should trust the
 * returned `changes` count (0 = someone else closed it first), not their own pre-read.
 */
export function endRun(db, runId, { endedAt, exitReason, reapedAt } = {}) {
  const ts = endedAt ?? nowIso();
  const info = db.prepare(
    `UPDATE runs SET ended_at = ?, exit_reason = ?, reaped_at = COALESCE(?, reaped_at)
       WHERE run_id = ? AND ended_at IS NULL`,
  ).run(ts, exitReason ?? null, reapedAt ?? null, runId);
  return info.changes;
}

/**
 * Stamp `reaped_at` for a kill that actually happened, regardless of who closed the row.
 *
 * `endRun` is first-writer-wins, so two truthful facts were being conflated: "this invocation
 * killed the process group" and "this invocation wrote the terminal row". They come apart in two
 * verified ways — killing a run ends its stream, so the pump's `onEnd` hook often wins the
 * terminal write first; and reaping a row that some other path already closed kills a live
 * process and recorded nothing at all (verified: `exit_reason` stayed `finished`, `reaped_at`
 * stayed NULL, and the process was gone). `exit_reason` still belongs to the first writer; the
 * timestamp belongs to whoever did the killing.
 */
export function markRunReaped(db, runId, { at } = {}) {
  const info = db.prepare(`UPDATE runs SET reaped_at = COALESCE(reaped_at, ?) WHERE run_id = ?`).run(at ?? nowIso(), runId);
  return info.changes;
}

/**
 * Record that reconciliation found this run's process **still alive but unmanaged**
 * (migration 0003).
 *
 * Deliberately not `reconcileRun`: an orphan has not ended, so `ended_at` stays NULL and the
 * row stays in `listOpenRuns()` — which is what makes every later boot re-examine it instead
 * of losing sight of a live process. `reconciled_at` is still stamped, because a *derived*
 * observation is exactly what it means.
 *
 * Returns `{ changed, alreadyOrphaned }`: `alreadyOrphaned` is how the caller tells a first
 * sighting from a repeat one without a second query.
 */
export function markRunOrphaned(db, runId, { at, note } = {}) {
  // One transaction, three reasons (all three from the 0003 review): the read-then-write pair
  // could otherwise let two reconciliations both see `managed` and both log a "new" sighting; a
  // crash between the lifecycle write and the sighting insert left an orphan whose journal claims
  // it was first seen on a *later* boot; and a caller doing the insert separately can forget to.
  // The sighting is written here rather than by the caller for exactly that last reason.
  const ts = at ?? nowIso();
  const run = db.transaction(() => {
    const before = db.prepare(`SELECT * FROM runs WHERE run_id = ? AND ended_at IS NULL`).get(runId);
    if (!before) return { changed: 0, alreadyOrphaned: false, sighting: null };
    const info = db.prepare(
      `UPDATE runs SET lifecycle = 'orphaned-unmanaged', reconciled_at = ?
         WHERE run_id = ? AND ended_at IS NULL`,
    ).run(ts, runId);
    const alreadyOrphaned = before.lifecycle === "orphaned-unmanaged";
    let sighting = null;
    if (info.changes === 1) {
      sighting = recordOrphanSighting(db, {
        runId,
        pid: before.pid,
        processGroup: before.process_group,
        procLstart: before.proc_lstart,
        kind: alreadyOrphaned ? "repeat" : "new",
        note,
        at: ts,
      });
    }
    return { changed: info.changes, alreadyOrphaned, sighting };
  });
  return run();
}

/**
 * Append one orphan sighting. A journal, never state — `runs.lifecycle` is the state, and
 * nothing reads this table back as truth (migration 0003's header explains why).
 */
export const ORPHAN_SIGHTINGS_PER_RUN = 100;

export function recordOrphanSighting(db, { runId, pid, processGroup, procLstart, kind = "new", note, at } = {}) {
  const info = db.prepare(
    `INSERT INTO orphan_sightings (run_id, seen_at, pid, process_group, proc_lstart, kind, note)
     VALUES (@run_id, @seen_at, @pid, @process_group, @proc_lstart, @kind, @note)`,
  ).run({
    run_id: runId,
    seen_at: at ?? nowIso(),
    pid: pid ?? null,
    process_group: processGroup ?? null,
    proc_lstart: procLstart ?? null,
    kind,
    note: note ?? null,
  });
  // Bounded retention (0003 review: "the journal grows without bound"). One row per orphan per
  // boot is small, but "small forever" is still unbounded, and a long-lived orphan on a machine
  // that reboots daily accumulates rows nobody will ever read. Keep the FIRST sighting (when this
  // started) and the most recent ones (what is true now); drop the middle, which is the part that
  // says the same thing repeatedly. Pruning here rather than in a sweep keeps the invariant local
  // to the only writer.
  db.prepare(
    `DELETE FROM orphan_sightings
      WHERE run_id = @run_id
        AND id NOT IN (
          SELECT id FROM orphan_sightings WHERE run_id = @run_id ORDER BY id ASC  LIMIT 1
        )
        AND id NOT IN (
          SELECT id FROM orphan_sightings WHERE run_id = @run_id ORDER BY id DESC LIMIT @keep
        )`,
  ).run({ run_id: runId, keep: ORPHAN_SIGHTINGS_PER_RUN - 1 });
  return info.lastInsertRowid;
}

/**
 * Sightings, oldest first, **bounded** — `limit` caps how many of the most recent rows come back
 * (the read was unbounded, and it is exposed over the wire via the `orphans` command's
 * `withSightings`, so a long-lived orphan could turn one request into an arbitrarily large
 * response). The rows are still returned oldest-first within that window, because reading a
 * history backwards is worse than reading a recent slice of it.
 */
export function listOrphanSightings(db, runId = null, { limit = 200 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`listOrphanSightings: limit must be a positive integer, got ${limit}`);
  if (runId) {
    return db
      .prepare(
        `SELECT * FROM (SELECT * FROM orphan_sightings WHERE run_id = ? ORDER BY id DESC LIMIT ?)
          ORDER BY seen_at, id`,
      )
      .all(runId, limit);
  }
  return db
    .prepare(`SELECT * FROM (SELECT * FROM orphan_sightings ORDER BY id DESC LIMIT ?) ORDER BY seen_at, id`)
    .all(limit);
}

/**
 * Live orphans: open rows whose process reconciliation verified alive with no adapter handle.
 *
 * This is the query that was impossible before migration 0003 — a closed row could not be
 * distinguished from a still-running one, so "show me the processes nobody is managing" had no
 * answer at all. Joined against the sightings journal so a caller gets first/last seen and a
 * count without a second round trip.
 */
export function listOrphanedRuns(db) {
  return db
    .prepare(
      `SELECT r.*,
              (SELECT COUNT(*) FROM orphan_sightings s WHERE s.run_id = r.run_id)   AS sighting_count,
              (SELECT MIN(seen_at) FROM orphan_sightings s WHERE s.run_id = r.run_id) AS first_seen_at,
              (SELECT MAX(seen_at) FROM orphan_sightings s WHERE s.run_id = r.run_id) AS last_seen_at
         FROM runs r
        WHERE r.ended_at IS NULL AND r.lifecycle = 'orphaned-unmanaged'
        ORDER BY r.started_at`,
    )
    .all();
}

/**
 * Re-open a run that had been closed, for `resume()` (0003 review, finding B).
 *
 * `resume()` starts a NEW OS process against the same run_id. Without this the row kept its
 * terminal state, and the consequences were exactly the invisible-orphan class of bug this
 * project keeps finding: the resumed process was live while `listOpenRuns()` could not see it, so
 * boot reconciliation never examined it, `list()` never showed it, the shared-pgid refusal never
 * counted it, and its own completion write was rejected by `endRun`'s `ended_at IS NULL` guard —
 * meaning generation 2's asks were never scheduled either. Verified before fixing: resume
 * reported `resumed: true, generation: 2` over a live process whose row still said `finished`.
 *
 * Clears `reaped_at` and resets `lifecycle` too: whatever was true of the previous generation is
 * not true of this one. Any grace deadline on an unresolved ask is cancelled, because the run is
 * answerable again.
 */
export function reopenRun(db, runId) {
  const reopen = db.transaction(() => {
    const info = db.prepare(
      `UPDATE runs SET ended_at = NULL, exit_reason = NULL, reconciled_at = NULL, reaped_at = NULL,
                       lifecycle = 'managed'
         WHERE run_id = ? AND ended_at IS NOT NULL`,
    ).run(runId);
    if (info.changes === 1) {
      db.prepare(`UPDATE asks SET auto_close_at = NULL WHERE run_id = ? AND resolved = 0`).run(runId);
    }
    return info.changes;
  });
  return reopen();
}

/**
 * Bump a run's process generation (Group 5, resume path). A resumed run is a new OS
 * process feeding the same run_id; `generation` is what distinguishes its events and its
 * recorded identity from the previous process's. Returns the new generation, or null if
 * the run does not exist.
 */
export function bumpRunGeneration(db, runId) {
  const info = db.prepare(`UPDATE runs SET generation = generation + 1 WHERE run_id = ?`).run(runId);
  if (info.changes === 0) return null;
  return db.prepare(`SELECT generation FROM runs WHERE run_id = ?`).get(runId)?.generation ?? null;
}

/**
 * Record the OS-verified process identity of a run's child (Group 5).
 *
 * Called only with values that came back *verified* from
 * runtime/spawn.js's identity promise — never with an assumed pgid. `procLstart` is the
 * pid-reuse guard: `reap` and reconciliation both refuse to act when it doesn't match
 * what the OS reports now.
 */
export function recordRunProcess(db, runId, { pid, processGroup, procLstart, spawnDepth, cwd, harnessSessionId } = {}) {
  const info = db.prepare(
    `UPDATE runs SET
       pid = COALESCE(@pid, pid),
       process_group = COALESCE(@process_group, process_group),
       proc_lstart = COALESCE(@proc_lstart, proc_lstart),
       spawn_depth = COALESCE(@spawn_depth, spawn_depth),
       cwd = COALESCE(@cwd, cwd),
       harness_session_id = COALESCE(@harness_session_id, harness_session_id)
     WHERE run_id = @run_id`,
  ).run({
    run_id: runId,
    pid: pid ?? null,
    process_group: processGroup ?? null,
    proc_lstart: procLstart ?? null,
    spawn_depth: spawnDepth ?? null,
    cwd: cwd ?? null,
    harness_session_id: harnessSessionId ?? null,
  });
  if (info.changes !== 1) {
    throw new Error(`recordRunProcess: no runs row for run_id "${runId}" (updated ${info.changes} rows)`);
  }
  return info.changes;
}

export function getRun(db, runId) {
  return db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) ?? null;
}

/**
 * The task a run belongs to, via its worker — or null.
 *
 * There is deliberately no `runs.task_id`: a run belongs to a WORKER, and the worker holds
 * the task assignment (PLAN.md section 3's identity split), so denormalising it onto the run
 * would make reassigning a worker's task silently disagree with its own history. Null is a
 * real, expected answer: an adhoc/DM session (section 10) and everything in the Phase 2
 * slice has a worker with no task, which is why `asks.task_id` is nullable as of 0004.
 */
export function taskIdForRun(db, runId) {
  const row = db
    .prepare(`SELECT w.task_id AS task_id FROM runs r JOIN workers w ON w.worker_id = r.worker_id WHERE r.run_id = ?`)
    .get(runId);
  return row?.task_id ?? null;
}

/**
 * Every run the database still believes is in flight. This is reconciliation's input set
 * on boot: `ended_at IS NULL` means no terminal path (adapter completion, stop, or a
 * previous reconciliation) ever closed it.
 */
export function listOpenRuns(db) {
  // DELIBERATELY includes preflight runs. This is reconciliation's input set, and a preflight
  // that crashed is an orphaned process exactly like any other -- PLAN.md 12.1 says it must be
  // reaped by this same path rather than by a second mechanism. Hiding preflights here would
  // turn "a preflight leaves nothing behind" into "a preflight can leak a process nobody can
  // see", which is the worse failure by a distance. The HUMAN-facing filter is
  // `listRunsForDisplay` below.
  return db.prepare(`SELECT * FROM runs WHERE ended_at IS NULL ORDER BY started_at`).all();
}

/**
 * Runs a human (or the CTO) should see: everything except preflights.
 *
 * PLAN.md 12.1: a preflight "must never appear in team views, task history, or the CTO's
 * picture of who is doing what". Twenty sessions saying "hi" is exactly the history pollution
 * the cleanup exists to prevent, and it pollutes it just as effectively while the checks are
 * still running as it would afterwards -- so the exclusion is a read-time filter, not something
 * that only becomes true once the row is deleted.
 */
export function listRunsForDisplay(db, { openOnly = false } = {}) {
  const where = openOnly ? `WHERE is_preflight = 0 AND ended_at IS NULL` : `WHERE is_preflight = 0`;
  return db.prepare(`SELECT * FROM runs ${where} ORDER BY started_at`).all();
}

/** Preflight rows still on disk. The cleanup sweep's input, and a leak detector. */
/**
 * Mark a run as an ADOPTED session (migration 0007) and record what the hook told us.
 *
 * One statement, because `lifecycle` and the identity fields describe one fact: this is somebody
 * else's live process. A row that said `adopted` without a pid, or carried a pid without saying it
 * was adopted, would be dangerous in opposite directions -- the first is unverifiable, and the second
 * is exactly what the orphan reaper looks for.
 */
export function markRunAdopted(db, runId, { pid = null, pgid = null, lstart = null, transcriptPath = null, cwd = null, at } = {}) {
  const info = db.prepare(
    `UPDATE runs
        SET lifecycle = 'adopted', adopted_at = ?, transcript_path = ?,
            pid = COALESCE(?, pid), process_group = COALESCE(?, process_group),
            proc_lstart = COALESCE(?, proc_lstart)
      WHERE run_id = ? AND ended_at IS NULL`,
  ).run(at ?? nowIso(), transcriptPath, pid, pgid, lstart, runId);
  void cwd; // the run's cwd lives on the worker; accepted here so the hook's payload can be passed whole
  return info.changes;
}

/** The adopted run for a harness session, if there is one. The idempotency key for adoption. */
export function findAdoptedRun(db, { harnessId, sessionId }) {
  return db
    .prepare(`SELECT * FROM runs WHERE lifecycle = 'adopted' AND harness_id = ? AND harness_session_id = ?`)
    .get(harnessId, sessionId) ?? null;
}

/** Adopted sessions still believed live. */
export function listAdoptedRuns(db) {
  return db
    .prepare(`SELECT * FROM runs WHERE lifecycle = 'adopted' AND ended_at IS NULL ORDER BY adopted_at`)
    .all();
}

export function listPreflightRuns(db, { openOnly = false } = {}) {
  const where = openOnly ? `WHERE is_preflight = 1 AND ended_at IS NULL` : `WHERE is_preflight = 1`;
  return db.prepare(`SELECT * FROM runs ${where} ORDER BY started_at`).all();
}

/**
 * Delete a preflight run and everything that points at it.
 *
 * REFUSES A NON-PREFLIGHT RUN, and that guard is the most important line in this function. It
 * is the only destructive delete in this file -- everything else in the codebase closes rows and
 * keeps them -- so a caller passing the wrong runId must fail loudly rather than silently
 * destroy a real worker's history. `is_preflight` is checked in the DATABASE inside the same
 * transaction as the deletes, not trusted from the caller, because the caller is what would be
 * wrong.
 *
 * Order matters: children before parents, or the `runs.run_id` foreign keys reject the delete. The
 * children are exactly the tables that reference `runs.run_id` -- `event_log`, `asks`,
 * `orphan_sightings` -- and deliberately not `transition_journal`, which is keyed by `task_id`.
 * One transaction, so a crash mid-cleanup leaves either the whole session or none of it -- a
 * half-deleted run with orphaned `event_log` rows would be unreadable AND undeletable.
 *
 * Returns what it removed, so a caller can assert rather than assume.
 */
export function deletePreflightRun(db, runId) {
  const row = db.prepare(`SELECT run_id, is_preflight FROM runs WHERE run_id = ?`).get(runId);
  if (!row) return { deleted: false, reason: "no such run" };
  if (!row.is_preflight) {
    throw new Error(
      `refusing to delete run ${runId}: it is not a preflight run. deletePreflightRun is the only `
      + `destructive delete in this codebase and it must never be able to remove a real worker's history.`,
    );
  }

  const tx = db.transaction(() => {
    // Re-read inside the transaction. Between the check above and here, nothing should have
    // changed the flag -- but "should" is what the guard exists to not rely on, and the cost of
    // re-reading is one indexed lookup.
    const inner = db.prepare(`SELECT is_preflight FROM runs WHERE run_id = ?`).get(runId);
    if (!inner?.is_preflight) throw new Error(`run ${runId} stopped being a preflight mid-delete; nothing deleted`);

    const events = db.prepare(`DELETE FROM event_log WHERE run_id = ?`).run(runId).changes;
    const asks = db.prepare(`DELETE FROM asks WHERE run_id = ?`).run(runId).changes;
    const sightings = db.prepare(`DELETE FROM orphan_sightings WHERE run_id = ?`).run(runId).changes;
    // NOT `transition_journal`: it is keyed by `task_id`, not `run_id` — it records TASK state
    // changes, and a preflight has no task. An earlier draft deleted from it by `run_id` and failed
    // with "no such column", which was the schema refusing a delete that would have been wrong even
    // if it had parsed: task history does not belong to a run.
    const runs = db.prepare(`DELETE FROM runs WHERE run_id = ? AND is_preflight = 1`).run(runId).changes;
    if (runs !== 1) throw new Error(`expected to delete exactly 1 run row for ${runId}, deleted ${runs}`);
    return { deleted: true, events, asks, sightings };
  });
  return tx();
}

/**
 * Record a preflight's verdict. This is what OUTLIVES the deleted session.
 *
 * REPLACE rather than append: section 12.3 asks "is this model usable right now", not "how has
 * it behaved historically". A history table here would grow without bound for a check designed
 * to be run liberally, and nothing reads it back as history.
 */
export function recordModelHealth(db, h) {
  if (!h?.harnessId) throw new Error("recordModelHealth: harnessId is required");
  if (!h.errorClass) throw new Error("recordModelHealth: errorClass is required (use 'ok' for success)");
  if (typeof h.reachable !== "boolean") throw new Error("recordModelHealth: reachable must be a boolean");
  db.prepare(
    `INSERT INTO model_health (harness_id, provider_id, model_id, reachable, error_class, detail,
                               latency_ms, checked_at)
     VALUES (@harness_id, @provider_id, @model_id, @reachable, @error_class, @detail, @latency_ms, @checked_at)
     ON CONFLICT (harness_id, provider_id, model_id) DO UPDATE SET
       reachable = excluded.reachable, error_class = excluded.error_class, detail = excluded.detail,
       latency_ms = excluded.latency_ms, checked_at = excluded.checked_at`,
  ).run({
    harness_id: h.harnessId,
    // A model is identified by provider AND id: the same model id behind two providers is two
    // different reachability facts, which is the whole reason section 12's failover exists.
    provider_id: h.providerId ?? "",
    model_id: h.modelId ?? "",
    reachable: h.reachable ? 1 : 0,
    error_class: h.errorClass,
    detail: h.detail ?? null,
    latency_ms: Number.isInteger(h.latencyMs) ? h.latencyMs : null,
    checked_at: h.checkedAt ?? nowIso(),
  });
}

export function getModelHealth(db, { harnessId, providerId = "", modelId = "" }) {
  return db
    .prepare(`SELECT * FROM model_health WHERE harness_id = ? AND provider_id = ? AND model_id = ?`)
    .get(harnessId, providerId, modelId) ?? null;
}

/**
 * Tier-2 turn digests for a run, oldest first (PLAN.md section 8, Rule 4).
 *
 * Stored in `event_log` with `tier = 2` — tiers 1 and 2 genuinely do share that table (only tier 3
 * could not, because it is task-scoped; see migration 0006's header). So a digest is deleted with its
 * run, which is correct: a digest of a run that no longer exists describes nothing.
 */
export function listTurnDigests(db, runId, { limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`listTurnDigests: limit must be a positive integer, got ${limit}`);
  return db
    .prepare(`SELECT * FROM (SELECT * FROM event_log WHERE run_id = ? AND tier = 2 ORDER BY seq DESC LIMIT ?)
               ORDER BY seq ASC`)
    .all(runId, limit)
    .map((r) => ({ seq: r.seq, ts: r.ts, ...(r.payload_json ? JSON.parse(r.payload_json) : {}) }));
}

/**
 * TIER-1 events after a cursor, oldest first — what a pane replays when it is switched to.
 *
 * `afterSeq` is exclusive and is the last seq the caller has already rendered, so re-reading after a
 * switch RESUMES rather than duplicating. That is FLOWS §5's "replayed by cursor when a pane is switched
 * to", and it is the same contract `pane/pane.js` consumes over `observe` — this is the polling form of
 * it, for a client that reads a snapshot on a timer rather than holding a stream per pane.
 *
 * `skipped` is the honest half. When more than `limit` events have arrived since the cursor, the OLDEST
 * of them are dropped (a pane wants the newest), and the count of what was dropped is returned so the
 * gap can be ANNOUNCED. A pane that silently skips events shows a transcript with a hole in it, which is
 * indistinguishable from a worker that said nothing — the same reason the pump emits `gap` frames.
 */
export function listTier1EventsSince(db, runId, { afterSeq = 0, limit = 200 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`listTier1EventsSince: limit must be a positive integer, got ${limit}`);
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM event_log WHERE run_id = ? AND tier = 1 AND seq > ?`)
    .get(runId, afterSeq).n;
  const rows = db
    .prepare(`SELECT * FROM (SELECT seq, type, payload_json FROM event_log
                              WHERE run_id = ? AND tier = 1 AND seq > ? ORDER BY seq DESC LIMIT ?)
               ORDER BY seq ASC`)
    .all(runId, afterSeq, limit);
  return { rows, skipped: Math.max(0, total - rows.length) };
}

/**
 * Every tier-2 digest for a TASK's runs, oldest first — what tier 3 reads for `assumptions`.
 *
 * Preflight runs are excluded for the same reason they are excluded from the handoff (migration 0005):
 * a reachability check's turn is not work anyone should read about.
 */
export function listTaskTurnDigests(db, taskId, { limit = 200 } = {}) {
  return db
    .prepare(`SELECT e.* FROM event_log e
                JOIN runs r ON r.run_id = e.run_id
                JOIN workers w ON w.worker_id = r.worker_id
               WHERE w.task_id = ? AND e.tier = 2 AND r.is_preflight = 0
               ORDER BY e.seq ASC LIMIT ?`)
    .all(taskId, limit)
    .map((r) => ({ seq: r.seq, ts: r.ts, runId: r.run_id, ...(r.payload_json ? JSON.parse(r.payload_json) : {}) }));
}

/**
 * Persist a tier-3 task handoff (migration 0006).
 *
 * APPEND, not replace. Rule 4 says "regenerated on transition", and keeping the previous document is
 * what makes a regeneration reviewable -- "the goal changed between these two" is a question worth
 * being able to ask. Readers take the newest. This is the opposite call from `model_health`, which
 * replaces, and the difference is that a handoff has historical value while "is this model usable
 * right now" does not.
 */
export function recordTaskHandoff(db, h) {
  if (!h?.taskId) throw new Error("recordTaskHandoff: taskId is required");
  if (typeof h.doc !== "string" || !h.doc.length) throw new Error("recordTaskHandoff: a non-empty doc is required");
  if (!h.reason) throw new Error("recordTaskHandoff: reason is required ('manual' | 'state-transition' | 'clear' | 'boot')");
  const info = db.prepare(
    `INSERT INTO task_handoffs (task_id, doc, sources_json, chars, truncated, reason, generated_at)
     VALUES (@task_id, @doc, @sources_json, @chars, @truncated, @reason, @generated_at)`,
  ).run({
    task_id: h.taskId,
    doc: h.doc,
    sources_json: h.sources ? JSON.stringify(h.sources) : null,
    chars: h.chars ?? h.doc.length,
    truncated: h.truncated ? 1 : 0,
    reason: h.reason,
    generated_at: h.generatedAt ?? nowIso(),
  });
  return info.lastInsertRowid;
}

/** The current handoff for a task: the newest row. */
export function latestTaskHandoff(db, taskId) {
  return db
    .prepare(`SELECT * FROM task_handoffs WHERE task_id = ? ORDER BY id DESC LIMIT 1`)
    .get(taskId) ?? null;
}

/** Every handoff for a task, newest first -- the regeneration history. */
export function listTaskHandoffs(db, taskId, { limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`listTaskHandoffs: limit must be a positive integer, got ${limit}`);
  return db
    .prepare(`SELECT * FROM task_handoffs WHERE task_id = ? ORDER BY id DESC LIMIT ?`)
    .all(taskId, limit);
}

export function listModelHealth(db) {
  return db.prepare(`SELECT * FROM model_health ORDER BY harness_id, provider_id, model_id`).all();
}

/**
 * Other still-open runs recorded against the same process group.
 *
 * This is how `reap` finds out that killing a process group would take unrelated runs
 * with it, and it is deliberately answered from the DATABASE rather than from adapter
 * memory: after a supervisor restart the adapters hold no handles at all, which is
 * exactly when a reap is most likely to be attempted. `opencode serve` is pooled per
 * cwd (adapter finding S4), so every run in one cwd shares one pgid.
 */
export function listOpenRunsSharingProcessGroup(db, processGroup, excludeRunId = null) {
  if (!Number.isInteger(processGroup)) return [];
  return db
    .prepare(`SELECT * FROM runs WHERE ended_at IS NULL AND process_group = ? AND run_id IS NOT ?`)
    .all(processGroup, excludeRunId);
}

/**
 * Close a run with a reconciliation-derived outcome (`lost` / `orphaned-unmanaged`).
 *
 * Distinct from endRun() on purpose: this stamps `reconciled_at`, which is what lets a
 * reader tell a derived outcome from the adapter's own normal completion. Reconciliation
 * never writes `finished` — per PLAN.md section 4 that value belongs solely to the
 * adapter's completion path.
 */
export function reconcileRun(db, runId, { exitReason, at } = {}) {
  // Only `lost` now. Since migration 0003 `orphaned-unmanaged` is a lifecycle state on a row that
  // stays OPEN (see markRunOrphaned) — but this writer still accepted it and still wrote
  // `ended_at`, which reconstructs the exact bug 0003 removed: a verified-live process closed out
  // of `listOpenRuns()` and therefore invisible to every later boot. Nothing calls it that way any
  // more, so this is a guard against the footgun growing back, and it was reachable: verified by
  // calling it on a live run and watching the run vanish from `listOpenRuns()`.
  if (exitReason !== "lost") {
    throw new Error(
      `reconcileRun: exitReason must be "lost", got ${JSON.stringify(exitReason)}. ` +
        `"orphaned-unmanaged" is a lifecycle state written by markRunOrphaned(), not a terminal reason.`,
    );
  }
  const ts = at ?? nowIso();
  const info = db.prepare(
    `UPDATE runs SET ended_at = ?, exit_reason = ?, reconciled_at = ? WHERE run_id = ? AND ended_at IS NULL`,
  ).run(ts, exitReason, ts, runId);
  return info.changes;
}

/**
 * Close every unresolved ask belonging to a run, with a machine-readable reason.
 * PLAN.md section 4: "Any row landing in `lost` or `orphaned-unmanaged` closes its open
 * `asks`" — otherwise a restart leaves a question nobody will ever answer blocking a
 * task forever.
 */
export function closeOpenAsksForRun(db, runId, { reason = "run-reconciled", at } = {}) {
  // 0004: stamps `answered_at`, not `delivered_at`. Nothing is delivered on this path — the
  // run is gone, unmanaged, or being killed — and recording a delivery that did not happen
  // would put the row in `listUndeliveredAnswers`' territory while claiming the opposite.
  const info = db.prepare(
    `UPDATE asks SET resolved = 1, decision = 'closed', answered_by = ?, answer = COALESCE(answer, ?),
                    answered_at = COALESCE(answered_at, ?)
     WHERE run_id = ? AND resolved = 0`,
  ).run("supervisor:reconciliation", `[closed by supervisor: ${reason}]`, at ?? nowIso(), runId);
  return info.changes;
}

/**
 * Record one event -- a single targeted INSERT against event_log, independent of how
 * many rows already exist in the table for this run or any other. This is the
 * mechanism that replaces spike-0b's O(all-rows) full-file rewrite per event
 * (finding S1 / S12 of the review).
 */
const insertEventStmt = new WeakMap();
export function recordEvent(db, e) {
  let stmt = insertEventStmt.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `INSERT INTO event_log (run_id, tier, type, payload_json, ts) VALUES (?, ?, ?, ?, ?)`,
    );
    insertEventStmt.set(db, stmt);
  }
  const info = stmt.run(
    e.runId,
    e.tier,
    e.type,
    e.payload !== undefined ? JSON.stringify(e.payload) : null,
    e.ts ?? nowIso(),
  );
  return info.lastInsertRowid;
}

/**
 * Create an ask.
 *
 * If the run has ALREADY ended, the ask is given its grace deadline immediately (0003 review):
 * every closing path — completion, stop, reap, reconciliation — only touches asks that exist at
 * the time it runs, and the sweep only looks at rows that have a deadline. So an ask inserted
 * even a moment after its run finished had `resolved = 0, auto_close_at = NULL` and was
 * unreachable by every mechanism, forever. Verified: inserted after completion, then swept
 * repeatedly, and it stayed open.
 */
export function createAsk(db, a) {
  // Bug found by independent code review (2026-09-05): the original VALUES clause had
  // only 8 slots for the 9 listed columns (was missing a NULL for delivered_at, which
  // got conflated with the resolved=0 literal) -- every call threw "8 values for 9
  // columns" and createAsk() always failed. Fixed: 9 slots, 5 bound params matching
  // the 5 args passed to .run() below.
  //
  // Migration 0004 added the round-trip columns. They are all optional: a plain ask
  // ("worker is blocked, someone look at this") still needs nothing but a run and a
  // question, while an ask raised from a parked harness request carries the correlation
  // that lets the answer travel back (`harnessRequestId`) and the run generation it belongs
  // to, so an answer is never handed to the process a `resume()` replaced.
  db.prepare(
    `INSERT INTO asks (id, run_id, task_id, kind, question, payload_json, harness_request_id,
                       harness_tool_use_id, generation, answer, answered_by, answered_at,
                       delivered_at, resolved, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?)`,
  ).run(
    a.id,
    a.runId,
    a.taskId ?? null,
    a.kind ?? "question",
    a.question,
    // Bounded, and never able to throw: an ask that fails to insert is a worker nobody can
    // unblock, so a payload that cannot be serialised is recorded as such rather than fatal.
    serialiseAskPayload(a.payload),
    a.harnessRequestId ?? null,
    a.harnessToolUseId ?? null,
    a.generation ?? null,
    nowIso(),
  );
  const run = db.prepare(`SELECT ended_at FROM runs WHERE run_id = ?`).get(a.runId);
  if (run?.ended_at) {
    scheduleAskAutoClose(db, a.runId, { graceMs: a.graceMs ?? ASK_AUTO_CLOSE_GRACE_MS });
  }
  return a.id;
}

/** One ask row by id, or undefined. */
export function getAsk(db, id) {
  return db.prepare(`SELECT * FROM asks WHERE id = ?`).get(id);
}

/**
 * Parse a `*_json` column without letting one bad row take a caller down.
 *
 * Every read of `payload_json` / `answer_json` goes through this. Found by review: an unguarded
 * `JSON.parse` on the delivery path threw AFTER the answer had been persisted, so the row was
 * resolved but never delivered and never recorded as failed — and `boot()`'s redelivery loop had
 * no per-row guard, so one malformed row could reject boot and stop every other answer from
 * being retried. A column can hold bad JSON for reasons that are not our bug (a truncated write,
 * a hand-edited database during debugging), so the read has to survive it.
 */
export function parseJsonColumn(value, fallback = null) {
  if (value == null) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Cap on a stored ask payload. A tool input is usually small, but `Write` carries whole file
 * bodies and nothing upstream bounds them, so without this one approval could put megabytes in
 * the database. Truncation is recorded in the payload itself rather than done silently.
 */
export const MAX_ASK_PAYLOAD_BYTES = 64 * 1024;

function serialiseAskPayload(payload) {
  if (payload === undefined || payload === null) return null;
  let json;
  try {
    json = JSON.stringify(payload);
  } catch (err) {
    // A payload that cannot be serialised (a cycle, a BigInt) must not stop the ask being
    // recorded — an unrecorded ask means a parked worker nobody can unblock.
    return JSON.stringify({ payloadError: `could not serialise: ${err.message}` });
  }
  if (json == null) return null;
  if (Buffer.byteLength(json, "utf8") <= MAX_ASK_PAYLOAD_BYTES) return json;
  return JSON.stringify({
    truncated: true,
    reason: `payload exceeded ${MAX_ASK_PAYLOAD_BYTES} bytes and was truncated at the write boundary`,
    preview: json.slice(0, 2000),
    sha256: crypto.createHash("sha256").update(json, "utf8").digest("hex"),
  });
}

/**
 * Replace a resolved ask's payload with a hash + bounded preview.
 *
 * The retention decision this implements (see 0004's comment on `payload_json`): a human cannot
 * approve a command they cannot read, so the full tool input is kept WHILE THE ASK IS PENDING —
 * but a bearer token pasted into a Bash command has no business still being in the database a
 * month later. So the full form lives for the decision window only, and history keeps something
 * verifiable instead. `SUPERVISOR_PERSIST_FULL_PROMPTS` (the same opt-in that governs full prompt
 * text) keeps the whole payload for callers who have decided that trade-off differently.
 *
 * Idempotent: a payload already reduced has no `input` to reduce again.
 */
export function redactResolvedAskPayload(db, id, { persistFull } = {}) {
  if (persistFull ?? fullPromptPersistenceEnabled()) return 0;
  const row = db.prepare(`SELECT payload_json FROM asks WHERE id = ?`).get(id);
  if (!row?.payload_json) return 0;
  const payload = parseJsonColumn(row.payload_json);
  if (!payload || typeof payload !== "object" || payload.redacted) return 0;

  const sensitive = JSON.stringify({ input: payload.input ?? null, description: payload.description ?? null });
  const reduced = {
    redacted: true,
    // Kept: what was asked and by which tool — that is the audit question. Dropped: the exact
    // arguments, which are what carry secrets.
    toolName: payload.toolName ?? null,
    displayName: payload.displayName ?? null,
    requiresUserInteraction: payload.requiresUserInteraction ?? null,
    inputSha256: crypto.createHash("sha256").update(sensitive, "utf8").digest("hex"),
    // NO PREVIEW OF THE INPUT, deliberately, and this is a correction to the first version of
    // this function: it kept a 200-char preview by analogy with `redactPrompt`, and the test
    // immediately caught that a short command like
    // `curl -H 'Authorization: Bearer <token>' ...` fits inside 200 characters entirely. A
    // preview of precisely the sensitive part is not a redaction. The prompt preview is a
    // different trade-off — orientation in a long body of text — and it does not transfer here,
    // where the whole value being reduced IS the argument list.
    //
    // The hash is what makes history useful ("was it this exact call?"), and the `asks.question`
    // column still holds the harness's own one-line summary of what was asked.
  };
  return db.prepare(`UPDATE asks SET payload_json = ? WHERE id = ?`).run(JSON.stringify(reduced), id).changes;
}

/**
 * Every unresolved ask, oldest first — what the tree badge counts and the `asks` wire
 * command returns. `runId` narrows it to one run.
 */
export function listPendingAsks(db, { runId = null, limit = 200 } = {}) {
  const sql = runId
    ? `SELECT * FROM asks WHERE resolved = 0 AND run_id = ? ORDER BY created_at ASC LIMIT ?`
    : `SELECT * FROM asks WHERE resolved = 0 ORDER BY created_at ASC LIMIT ?`;
  return runId ? db.prepare(sql).all(runId, limit) : db.prepare(sql).all(limit);
}

/**
 * Answers that are durable but have NOT reached the harness yet.
 *
 * This is the queue that makes the round trip crash-safe, and it exists because
 * `answered_at` and `delivered_at` are now separate facts (migration 0004). PLAN.md section
 * 7: the answer is persisted *before* it is acted on, so a supervisor that dies between
 * writing the answer and handing it to a parked harness can find it again on the next boot
 * instead of losing a human's decision.
 *
 * Only rows with a `harness_request_id` qualify: an ask nothing is parked on has nowhere to
 * be delivered, and stamping `delivered_at` on it would be a lie dressed up as completeness.
 *
 * Two exclusions keep this queue self-draining rather than accumulating rows nobody can ever
 * act on — the failure mode that `orphan_sightings` and the pre-0003 orphan rows both taught:
 *
 *   - the run must still be open (`ended_at IS NULL`). A parked request dies with its
 *     process, so an answer to a finished run is not undelivered, it is moot.
 *   - `decision <> 'withdrawn'`. The harness cancelled that request itself; there is nothing
 *     left listening on that id.
 */
export function listUndeliveredAnswers(db, { runId = null, limit = 500 } = {}) {
  // `decision IN (...)` rather than "anything except withdrawn". Found by review, and it was
  // the worst defect in the first version: `deliverAnswer` mapped every decision other than the
  // exact string 'deny' to an ALLOW, and a supervisor-closed ask (`decision = 'closed'`, written
  // by reconciliation or the auto-close sweep) satisfied the old predicate — so a reconciled
  // orphan's closed asks queued up and boot redelivery would have handed a still-parked worker
  // an approval no human ever gave. Only a real decision is deliverable, and the list is explicit
  // so a new decision value has to be added here on purpose.
  const where = `a.answered_at IS NOT NULL AND a.delivered_at IS NULL AND a.delivery_abandoned_at IS NULL
                 AND a.harness_request_id IS NOT NULL
                 AND a.decision IN ('allow', 'deny', 'answered') AND r.ended_at IS NULL`;
  const sql = runId
    ? `SELECT a.* FROM asks a JOIN runs r ON r.run_id = a.run_id WHERE ${where} AND a.run_id = ? ORDER BY a.answered_at ASC LIMIT ?`
    : `SELECT a.* FROM asks a JOIN runs r ON r.run_id = a.run_id WHERE ${where} ORDER BY a.answered_at ASC LIMIT ?`;
  return runId ? db.prepare(sql).all(runId, limit) : db.prepare(sql).all(limit);
}

/**
 * Record that the harness accepted this answer. Guarded on `delivered_at IS NULL` so a
 * redelivery cannot rewrite the first delivery's timestamp, and so the caller can tell
 * "I delivered it" from "someone else already had".
 */
export function markAskDelivered(db, id, { at, error, abandon = false } = {}) {
  if (error) {
    // A failed attempt is recorded WITHOUT stamping delivered_at, so the row stays in the
    // redelivery queue and the reason is visible rather than inferred from silence.
    //
    // `abandon` is for a failure that retrying cannot fix — the harness withdrew the request,
    // the process that asked has been replaced, the run is not routable any more. Added after
    // review: without it, "answered and not delivered" was true forever for such a row and every
    // boot retried a request that no longer exists. A queue that cannot end is not a queue.
    return db
      .prepare(
        `UPDATE asks SET delivery_error = ?, delivery_abandoned_at = CASE WHEN ? THEN ? ELSE delivery_abandoned_at END
          WHERE id = ? AND delivered_at IS NULL`,
      )
      .run(String(error), abandon ? 1 : 0, at ?? nowIso(), id).changes;
  }
  return db
    .prepare(
      `UPDATE asks SET delivered_at = ?, delivery_error = NULL, delivery_abandoned_at = NULL
        WHERE id = ? AND delivered_at IS NULL`,
    )
    .run(at ?? nowIso(), id).changes;
}

/**
 * Close an ask because the HARNESS withdrew the request it was raised for.
 *
 * The control protocol lets either side cancel its own in-flight request, and the CLI does
 * exactly that for "a pending permission prompt after the turn was interrupted, or one that
 * another client already answered" (adapters/FINDINGS.md). Without this the dashboard would
 * keep showing a question that no longer exists, and a human answering it would be
 * delivering to a request id the harness has already forgotten.
 *
 * `delivered_at` is deliberately left NULL: nothing was delivered, the question was
 * cancelled from the other end.
 */
export function withdrawAsk(db, id, { reason = "harness-withdrew", at } = {}) {
  const ts = at ?? nowIso();
  const changes = db
    .prepare(
      `UPDATE asks
          SET resolved = 1, decision = 'withdrawn', answered_by = 'harness',
              answer = COALESCE(answer, ?), answered_at = COALESCE(answered_at, ?)
        WHERE id = ? AND resolved = 0`,
    )
    .run(`[withdrawn by the harness: ${reason}]`, ts, id).changes;
  if (changes > 0) return changes;

  // The row was ALREADY resolved, which is the race both reviewers found: a human answered in
  // the window between the harness cancelling and us processing the cancellation. The human's
  // answer is kept — it is what actually happened, and rewriting it as a withdrawal would lose
  // the fact that somebody decided — but the *delivery* is abandoned, because there is nothing
  // left to deliver to. Without this the row stayed answered-and-undeliverable forever and was
  // retried on every boot.
  //
  // `delivery_error` is OVERWRITTEN rather than COALESCEd. The row usually already carries the
  // transient error from the failed delivery attempt, and keeping that as the recorded reason
  // would tell an operator the answer is waiting for a retry when in fact it can never be
  // delivered at all. The earlier error is folded into the text so nothing is lost.
  return db
    .prepare(
      `UPDATE asks
          SET delivery_abandoned_at = ?,
              delivery_error = ? || COALESCE(' (earlier attempt: ' || delivery_error || ')', '')
        WHERE id = ? AND delivered_at IS NULL AND delivery_abandoned_at IS NULL`,
    )
    .run(ts, `the harness withdrew this request before the answer could be delivered (${reason})`, id).changes;
}

/**
 * Answer an ask. Persists the answer and flips resolved=1 in the same statement, so
 * there is no window in which the answer is written but resolved is not yet set (or
 * vice versa) -- a crash mid-write leaves either the pre-state or the post-state, never
 * a torn mix, because it's one SQLite statement inside the db's own transaction.
 *
 * Migration 0004: this writes `answered_at`, NOT `delivered_at`. Handing the answer to a
 * parked harness is a separate, failable step (`markAskDelivered`), and conflating the two
 * is what made the old column mean "answered" while being named "delivered".
 *
 * `decision` is the machine-readable form — 'allow' | 'deny' for a tool approval,
 * 'answered' for a question — and `answerJson` carries the structured payload (a question's
 * answers are a map, not a sentence). `answer` stays the human-readable text.
 */
export function answerAsk(db, id, { answer, answeredBy, decision, answerJson }) {
  // `AND resolved = 0` (added after the 0003 code review; all three reviewers found it): every
  // *closing* statement in this file is guarded, and this one was not. So an answer arriving
  // after the grace expired — or racing the sweep — overwrote `supervisor:auto-close` and made a
  // system-resolved ask look human-answered, which defeats the whole point of a deadline: "an
  // answer during the grace wins" only means something if an answer after it does not.
  // Reproduced before fixing: swept the ask, then answered it, and `answered_by` became "human".
  // Callers should read the returned count rather than assume success.
  const info = db.prepare(
    `UPDATE asks SET answer = ?, answer_json = ?, decision = ?, answered_by = ?, answered_at = ?, resolved = 1
      WHERE id = ? AND resolved = 0`,
  ).run(
    answer,
    answerJson !== undefined ? JSON.stringify(answerJson) : null,
    decision ?? "answered",
    answeredBy ?? null,
    nowIso(),
    id,
  );
  return info.changes;
}

/**
 * Grace period before an unanswered ask on a naturally completed run is auto-closed
 * (migration 0003). Five minutes, decided deliberately: a run finishing does not mean the
 * human who was asked has gone away, and closing instantly would throw away an answer they
 * were in the middle of typing.
 */
export const ASK_AUTO_CLOSE_GRACE_MS = 5 * 60 * 1000;

/**
 * Schedule (don't perform) the auto-close of a run's unanswered asks.
 *
 * Called from the adapter's own completion path. `reap` and reconciliation still close asks
 * *immediately*, because in those cases the run is either gone or unmanaged and the question
 * can never be answered by it — whereas a run that completed normally may well have a human
 * still looking at its pane.
 *
 * Only sets the deadline where there isn't one, so a second completion write (or a resumed
 * generation completing again) cannot keep pushing the deadline out forever.
 */
export function scheduleAskAutoClose(db, runId, { graceMs = ASK_AUTO_CLOSE_GRACE_MS, now } = {}) {
  const at = new Date((now ? new Date(now).getTime() : Date.now()) + graceMs).toISOString();
  const info = db.prepare(
    `UPDATE asks SET auto_close_at = ? WHERE run_id = ? AND resolved = 0 AND auto_close_at IS NULL`,
  ).run(at, runId);
  return { scheduled: info.changes, autoCloseAt: at };
}

/**
 * Close every unresolved ask whose grace has expired.
 *
 * Idempotent and safe to call from anywhere: the `resolved = 0` guard means a human answer
 * that landed during the grace wins, and the row is left exactly as they answered it. Run on
 * boot as well as on a timer — the deadline is persisted precisely so a crash mid-grace does
 * not strand the ask (which was the bug this whole mechanism replaces).
 */
export function sweepExpiredAsks(db, { now } = {}) {
  const ts = now ?? nowIso();
  const info = db.prepare(
    `UPDATE asks
        SET resolved = 1,
            decision = 'closed',
            answered_by = 'supervisor:auto-close',
            answer = COALESCE(answer, '[closed by supervisor: run-completed, unanswered after the grace period]'),
            answered_at = COALESCE(answered_at, ?)
      WHERE resolved = 0 AND auto_close_at IS NOT NULL AND auto_close_at <= ?`,
  ).run(ts, ts);
  return info.changes;
}

/**
 * Move a task to a new state AND journal the move, in one transaction.
 *
 * THE TWO HALVES MUST NOT BE SEPARABLE, and before this they were: this function appended to
 * `transition_journal` and nothing anywhere updated `tasks.state` -- there was no `UPDATE tasks` in
 * this file at all, so the column was written once by `createTask` and never again. The journal and
 * the column could therefore disagree indefinitely, and did: the Phase 2 gate slice produced a
 * tier-3 handoff whose Goal said `created` while its own Decisions section showed the same task had
 * reached `in-review`. Two sources of truth for one fact, which is the shape migration 0003 was about.
 *
 * Found by the gate run rather than by a unit test, and the reason is worth keeping: the handoff
 * assertion that should have caught it searched the WHOLE document for the new state, and passed
 * because the state appeared in the journal-derived Decisions list. A vacuous assertion sitting on
 * top of a real defect.
 *
 * `fromState` is OPTIONAL but CHECKED when given: a caller saying "in-progress -> in-review" is
 * asserting what it believed the current state was, and honouring that when it is stale would be a
 * lost update. What is NOT validated here is whether the transition is LEGAL -- which states may
 * follow which is PLAN.md section 6's state machine, and building it is Phase 5. Refusing a stale
 * `fromState` is concurrency control, not policy.
 */
export function recordTransition(db, tr) {
  if (!tr?.taskId) throw new Error("recordTransition: taskId is required");
  if (!tr.toState) throw new Error("recordTransition: toState is required");
  const tx = db.transaction(() => {
    const task = db.prepare(`SELECT state, type FROM tasks WHERE id = ?`).get(tr.taskId);
    if (!task) throw new Error(`recordTransition: no such task ${tr.taskId}`);
    if (tr.fromState !== undefined && tr.fromState !== null && task.state !== tr.fromState) {
      throw new Error(
        `recordTransition: task ${tr.taskId} is in state "${task.state}", not "${tr.fromState}" -- `
        + `refusing a transition from a state it is not in, which would be a lost update`,
      );
    }
    // LEGALITY, not just staleness (PLAN.md section 6, Phase 5). Until this, any string was a state
    // and the diagram was documentation -- which is how the project's own tests drifted to
    // `in-progress` / `in-review`, names that appear nowhere in the design. A state machine nothing
    // enforces is a naming convention.
    //
    // `actor` is required by the guard rather than by this function, because section 6's rule is
    // "every transition needs a named actor AND a guard" and keeping both in one place is what stops
    // them diverging.
    const verdict = canTransition(tr.fromState ?? task.state ?? null, tr.toState, {
      actor: tr.actor,
      humanApproved: tr.humanApproved,
      explicitRetry: tr.explicitRetry,
      reviewerVerdicts: tr.reviewerVerdicts,
      // The task's TYPE decides how many verdicts `approved` needs (domain/workflow-profiles.js), and the
      // caller may override it explicitly. Read from the row rather than passed in, because the type is a
      // property of the task and a caller that had to look it up first would eventually forget to -- an
      // `adhoc` task, which has no reviewers at all (PLAN.md section 10), would then be unable to reach
      // `approved` at all under the default of 2.
      requiredVerdicts: tr.requiredVerdicts ?? requiredVerdictsFor(task.type),
      askOpen: tr.askOpen,
    });
    if (!verdict.ok) throw new Error(`recordTransition: ${verdict.reason}`);

    const at = tr.at ?? nowIso();
    db.prepare(
      `INSERT INTO transition_journal (id, task_id, from_state, to_state, actor, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(tr.id, tr.taskId, tr.fromState ?? task.state ?? null, tr.toState, tr.actor, at);
    // `updated_at` moves with it: a task whose state changed but whose timestamp did not would be
    // invisible to anything ordering by recency.
    db.prepare(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?`).run(tr.toState, at, tr.taskId);
  });
  tx();
}

export function enqueueOutbox(db, o) {
  db.prepare(
    `INSERT INTO outbox (id, event_type, payload_json, delivered, created_at) VALUES (?, ?, ?, 0, ?)`,
  ).run(o.id, o.eventType, o.payload !== undefined ? JSON.stringify(o.payload) : null, nowIso());
}

// ── configurable reviews (migration 0009, PLAN.md section 13) ──────────────────────────
//
// Two tables, and the reason `review_profiles` is one at all is in 0009's header: a verdict recorded under a
// profile has to stay interpretable after the profile is edited. So the imported copy is addressed by content
// hash, and every verdict records which `(profile_id, profile_hash)` it was judged under.

/**
 * Import one resolved profile. Idempotent per `(id, hash)`.
 *
 * `INSERT OR IGNORE`, not `REPLACE`: an identical re-import (every startup, every file touch) must not
 * rewrite `imported_at`, or "when did this profile first appear" stops being answerable — and that is the
 * question anyone asks when a verdict's meaning is in doubt.
 */
export function importReviewProfile(db, { id, hash, config }) {
  if (!id) throw new Error("importReviewProfile: id is required");
  if (!hash) throw new Error("importReviewProfile: hash is required");
  const info = db.prepare(
    `INSERT OR IGNORE INTO review_profiles (id, config_hash, config_json, imported_at) VALUES (?, ?, ?, ?)`,
  ).run(id, hash, JSON.stringify(config ?? null), nowIso());
  return { imported: info.changes === 1 };
}

/** The stored copy of a profile, as it was when a verdict was judged under it. */
export function getReviewProfile(db, { id, hash }) {
  const row = db.prepare(`SELECT * FROM review_profiles WHERE id = ? AND config_hash = ?`).get(id, hash);
  return row ? { id: row.id, hash: row.config_hash, config: parseJsonColumn(row.config_json), importedAt: row.imported_at } : null;
}

export function listReviewProfiles(db) {
  return db.prepare(`SELECT * FROM review_profiles ORDER BY id, imported_at`).all()
    .map((r) => ({ id: r.id, hash: r.config_hash, config: parseJsonColumn(r.config_json), importedAt: r.imported_at }));
}

/**
 * Record one reviewer's verdict on one dimension of one revision.
 *
 * UPSERT on `(task_id, round, commit_sha, worker_id, dimension)` — a reviewer revising its own opinion
 * REPLACES that row rather than appending a second one. Appending would leave "which of these two is
 * current" unanswerable from the data, and section 13's rule counts CURRENT-round verdicts.
 *
 * The verdict vocabulary is validated here against `domain/review.js` rather than by a CHECK constraint, so
 * the legal set lives in one place beside the rule that interprets it.
 */
export function recordReviewVerdict(db, v) {
  for (const field of ["taskId", "workerId", "round", "commitSha", "dimension", "verdict"]) {
    if (v?.[field] === undefined || v[field] === null || v[field] === "") {
      throw new Error(`recordReviewVerdict: ${field} is required`);
    }
  }
  if (!isVerdict(v.verdict)) {
    throw new Error(`recordReviewVerdict: verdict "${v.verdict}" is not one of ${VERDICTS.join(", ")}`);
  }
  if (!Number.isInteger(v.round) || v.round < 1) {
    throw new Error(`recordReviewVerdict: round must be a positive integer, got ${v.round}`);
  }
  const at = v.at ?? nowIso();
  db.prepare(
    `INSERT INTO review_verdicts
       (id, task_id, worker_id, slot, round, commit_sha, dimension, verdict, findings_json, profile_id, profile_hash, at)
     VALUES (@id, @task_id, @worker_id, @slot, @round, @commit_sha, @dimension, @verdict, @findings_json, @profile_id, @profile_hash, @at)
     ON CONFLICT (task_id, round, commit_sha, worker_id, dimension) DO UPDATE SET
       verdict = excluded.verdict,
       findings_json = excluded.findings_json,
       slot = excluded.slot,
       profile_id = excluded.profile_id,
       profile_hash = excluded.profile_hash,
       at = excluded.at`,
  ).run({
    // The commit is PART OF THE ID, because it is part of the uniqueness tuple. Without it, a reviewer
    // re-reviewing the same dimension in the same round after a new commit produced a different conflict
    // target but the SAME primary key, so the insert died with "UNIQUE constraint failed:
    // review_verdicts.id" — i.e. revision-bound re-review inside a round was impossible. Found by the
    // Phase 6 review (sol) and reproduced before fixing.
    id: v.id ?? `rv-${v.taskId}-${v.round}-${v.commitSha}-${v.workerId}-${v.dimension}`,
    task_id: v.taskId,
    worker_id: v.workerId,
    slot: v.slot ?? "reviewer1",
    round: v.round,
    commit_sha: v.commitSha,
    dimension: v.dimension,
    verdict: v.verdict,
    findings_json: v.findings ? JSON.stringify(v.findings) : null,
    profile_id: v.profileId ?? null,
    profile_hash: v.profileHash ?? null,
    at,
  });
  return { at };
}

/**
 * Every verdict for a task, oldest first, in the shape `domain/review.js` reads.
 *
 * Deliberately NOT filtered by round or commit here: `evaluateReview` decides what counts as current, and
 * that decision depends on the profile (`revisionBound`). Filtering in SQL would put half the rule in a
 * query and half in a pure module — which is how the two come to disagree.
 */
export function listReviewVerdicts(db, taskId, { round = null } = {}) {
  const rows = round === null
    ? db.prepare(`SELECT * FROM review_verdicts WHERE task_id = ? ORDER BY at, id`).all(taskId)
    : db.prepare(`SELECT * FROM review_verdicts WHERE task_id = ? AND round = ? ORDER BY at, id`).all(taskId, round);
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    workerId: r.worker_id,
    slot: r.slot,
    round: r.round,
    commitSha: r.commit_sha,
    dimension: r.dimension,
    verdict: r.verdict,
    findings: parseJsonColumn(r.findings_json) ?? [],
    profileId: r.profile_id,
    profileHash: r.profile_hash,
    at: r.at,
  }));
}

/** The highest round recorded for a task, or 0. What "start the next round" counts from. */
export function latestReviewRound(db, taskId) {
  const row = db.prepare(`SELECT MAX(round) AS r FROM review_verdicts WHERE task_id = ?`).get(taskId);
  return row?.r ?? 0;
}

// ── capability-based authorization (migration 0010, PLAN.md sections 16 and 14.5) ───────
//
// ONLY THE HASH IS STORED. A principal's token is returned once, at mint time, and cannot be recovered from
// the database — so a leaked database is not a set of working credentials. Every function below therefore takes
// or returns a hash, never a token, with one exception: `mintPrincipal` is where the token exists.

/**
 * Mint a principal.
 *
 * The caller supplies the token HASH, so the secret is generated where it will be delivered (the supervisor
 * hands one to a spawning worker, writes one to the owner's 0600 file) rather than this layer deciding how a
 * secret travels. What this layer owns is that only the hash lands in a row.
 */
export function mintPrincipal(db, p) {
  if (!p?.id) throw new Error("mintPrincipal: id is required");
  if (!p?.kind) throw new Error("mintPrincipal: kind is required");
  if (!p?.tokenSha256) throw new Error("mintPrincipal: tokenSha256 is required (never the token itself)");
  const verdict = validateCapabilities(p.capabilities ?? []);
  if (!verdict.ok) throw new Error(`mintPrincipal: ${verdict.problems.join("; ")}`);
  db.prepare(
    `INSERT INTO principals (id, kind, display_name, worker_id, token_sha256, capabilities_json, created_at, revoked_at)
     VALUES (@id, @kind, @display_name, @worker_id, @token_sha256, @capabilities_json, @created_at, NULL)`,
  ).run({
    id: p.id,
    kind: p.kind,
    display_name: p.displayName ?? p.id,
    worker_id: p.workerId ?? null,
    token_sha256: p.tokenSha256,
    capabilities_json: JSON.stringify(p.capabilities ?? []),
    created_at: nowIso(),
  });
  return { id: p.id };
}

const principalRow = (r) => (r
  ? {
    id: r.id,
    kind: r.kind,
    displayName: r.display_name,
    workerId: r.worker_id,
    capabilities: parseJsonColumn(r.capabilities_json) ?? [],
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  }
  : null);

/**
 * Resolve a principal by TOKEN HASH — the only way an incoming request becomes an identity.
 *
 * A revoked principal is still RETURNED, with `revokedAt` set, rather than treated as unknown: the
 * authorization decision needs to be able to say "this was revoked at 10:04" instead of "no such principal",
 * and a refusal that cannot distinguish the two is a support question.
 */
export function principalByTokenHash(db, tokenSha256) {
  if (!tokenSha256) return null;
  return principalRow(db.prepare(`SELECT * FROM principals WHERE token_sha256 = ?`).get(tokenSha256));
}

export function getPrincipal(db, id) {
  return principalRow(db.prepare(`SELECT * FROM principals WHERE id = ?`).get(id));
}

export function principalForWorker(db, workerId) {
  return principalRow(
    db.prepare(`SELECT * FROM principals WHERE worker_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`).get(workerId),
  );
}

export function listPrincipals(db, { includeRevoked = false } = {}) {
  const where = includeRevoked ? "" : "WHERE revoked_at IS NULL";
  return db.prepare(`SELECT * FROM principals ${where} ORDER BY created_at`).all().map(principalRow);
}

/**
 * Give an existing principal a NEW token, replacing the old one's hash.
 *
 * Why rotation rather than a fresh principal per run: a worker's identity is DURABLE (§3's identity split — it
 * survives clear and respawn), so its authority should be too, while its CREDENTIAL should not. Rotating keeps
 * one principal per worker and one working token per run, and it means a dead run's token stops working the
 * moment the worker is restarted — which is the behaviour you want from a credential that was handed to a
 * process that is gone.
 *
 * Found by the Phase 7 review (sol): without this, `ensureWorkerPrincipal` returned the existing principal with
 * no token, so every run after the first launched with no credential at all and every callback it made was
 * refused. Authorization worked for exactly one run per worker.
 */
export function rotatePrincipalToken(db, id, tokenSha256) {
  if (!id) throw new Error("rotatePrincipalToken: id is required");
  if (!tokenSha256) throw new Error("rotatePrincipalToken: tokenSha256 is required (never the token itself)");
  const info = db.prepare(`UPDATE principals SET token_sha256 = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(tokenSha256, id);
  return { rotated: info.changes === 1 };
}

/** Revocation is a timestamp, not a DELETE: "when did this stop being allowed" has to remain answerable. */
export function revokePrincipal(db, id) {
  const info = db.prepare(`UPDATE principals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(nowIso(), id);
  return { revoked: info.changes === 1 };
}

/**
 * Append to the agent journal (section 16's "task history, not memory").
 *
 * REFUSALS ARE APPENDED TOO — section 14.5: "Refusals are logged, never silently dropped". An authorization
 * system whose denials leave no trace cannot be audited, and cannot tell "nobody tried" from "somebody tried
 * and was stopped".
 */
export function journalAppend(db, e) {
  if (!e?.principalId) throw new Error("journalAppend: principalId is required");
  if (!e?.action) throw new Error("journalAppend: action is required");
  if (!e?.outcome) throw new Error("journalAppend: outcome is required ('allowed' | 'refused' | 'done' | 'failed')");
  const info = db.prepare(
    `INSERT INTO agent_journal (principal_id, action, args_sha256, args_preview, task_id, outcome, detail, at)
     VALUES (@principal_id, @action, @args_sha256, @args_preview, @task_id, @outcome, @detail, @at)`,
  ).run({
    principal_id: e.principalId,
    action: e.action,
    args_sha256: e.argsSha256 ?? "",
    // Truncated at the write boundary, like every other human-facing text in this schema (db/redact.js's rule).
    args_preview: e.argsPreview ? String(e.argsPreview).slice(0, 200) : null,
    task_id: e.taskId ?? null,
    outcome: e.outcome,
    detail: e.detail ? String(e.detail).slice(0, 500) : null,
    at: e.at ?? nowIso(),
  });
  return { id: info.lastInsertRowid };
}

/**
 * Section 16's actual query: "did I already file this ticket?"
 *
 * Keyed on `(principal, action, argsSha256)` AND on the outcome, because "I already did this" and "I already
 * tried this and was refused" lead to different next moves — retrying the second is reasonable, retrying the
 * first files a duplicate ticket.
 */
export function journalHasDone(db, { principalId, action, argsSha256 }) {
  const row = db.prepare(
    `SELECT id, at, outcome FROM agent_journal
      WHERE principal_id = ? AND action = ? AND args_sha256 = ? AND outcome = 'done'
      ORDER BY id DESC LIMIT 1`,
  ).get(principalId, action, argsSha256);
  return row ? { done: true, at: row.at, id: row.id } : { done: false };
}

export function listJournal(db, { principalId = null, taskId = null, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (principalId) { clauses.push("principal_id = ?"); params.push(principalId); }
  if (taskId) { clauses.push("task_id = ?"); params.push(taskId); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM agent_journal ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit)
    .map((r) => ({
      id: r.id,
      principalId: r.principal_id,
      action: r.action,
      argsSha256: r.args_sha256,
      argsPreview: r.args_preview,
      taskId: r.task_id,
      outcome: r.outcome,
      detail: r.detail,
      at: r.at,
    }));
}

/** Grant an approval for ONE sensitive action on ONE set of arguments. Expiring, single-use. */
export function grantSensitiveApproval(db, a) {
  for (const f of ["id", "action", "argsSha256", "forPrincipal", "grantedBy", "expiresAt"]) {
    if (!a?.[f]) throw new Error(`grantSensitiveApproval: ${f} is required`);
  }
  db.prepare(
    `INSERT INTO sensitive_approvals (id, action, args_sha256, for_principal, granted_by, granted_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(a.id, a.action, a.argsSha256, a.forPrincipal, a.grantedBy, nowIso(), a.expiresAt);
  return { id: a.id };
}

const approvalRow = (r) => (r
  ? {
    id: r.id,
    action: r.action,
    argsSha256: r.args_sha256,
    forPrincipal: r.for_principal,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
    expiresAt: r.expires_at,
    consumedAt: r.consumed_at,
  }
  : null);

/**
 * The newest unconsumed approval for this exact action + arguments + principal.
 *
 * Expiry is NOT filtered here on purpose: `authorize()` compares it against its own `now` and says "that
 * approval expired at ...", which is a better refusal than "no approval found" — the difference between "ask
 * again" and "you were never allowed".
 */
export function findSensitiveApproval(db, { action, argsSha256, forPrincipal, now = nowIso() } = {}) {
  // A VALID one is preferred, and an expired one is only returned when there is nothing better.
  //
  // The first version took "the newest unconsumed" and let `authorize()` judge expiry — which meant a newer
  // approval with a shorter TTL MASKED an older valid one, and the action was refused as expired while a good
  // approval sat unused beside it. Found by the Phase 7 review (sol). Expiry is still not the last word here:
  // when every candidate has expired, the newest is returned so the refusal can say "expired at ..." rather
  // than "no approval found" — the difference between "ask again" and "you were never allowed".
  //
  // `id DESC` breaks the tie deterministically: two approvals granted in the same millisecond have the same
  // `granted_at`, and "whichever the query happens to return" is not an ordering.
  const rows = db.prepare(
    `SELECT * FROM sensitive_approvals
      WHERE action = ? AND args_sha256 = ? AND for_principal = ? AND consumed_at IS NULL
      ORDER BY granted_at DESC, id DESC`,
  ).all(action, argsSha256, forPrincipal);
  const valid = rows.find((r) => !r.expires_at || r.expires_at > now);
  return approvalRow(valid ?? rows[0] ?? null);
}

/**
 * Spend an approval. Conditional UPDATE, so two concurrent uses cannot both succeed.
 *
 * `consumed_at IS NULL` in the WHERE clause is the whole mechanism: single-use has to be enforced by the write,
 * because a check-then-write would let two requests that both read "unconsumed" both proceed — and an approval
 * that can be replayed is a standing permission wearing a decision's clothes.
 */
export function consumeSensitiveApproval(db, id) {
  const info = db.prepare(`UPDATE sensitive_approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
    .run(nowIso(), id);
  return { consumed: info.changes === 1 };
}
