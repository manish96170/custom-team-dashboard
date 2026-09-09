// paths.js — THE state directory. One root, resolved in one place.
//
// Before this file there were two: `db/paths.js` and `ipc/paths.js` read
// `SUPERVISOR_STATE_DIR` and defaulted to `~/.custom-team-dashboard/supervisor/` (database +
// control socket), while `lock/lock.js` read `CTD_STATE_DIR` and defaulted to
// `~/.local/state/custom-team-dashboard/` (the single-instance lock). Both worked, and the
// tell that it was a trap rather than a preference: `runtime/test/daemon-crash.test.js` had to
// set BOTH env vars to keep a test out of the developer's real state directory. Miss one and a
// test silently reaches into `$HOME` — or worse, a deployment sets one and the lock quietly
// lands somewhere nobody is looking.
//
// Canonical root: `~/.custom-team-dashboard/supervisor/`. The database lives there already and
// relocating a database for tidiness is a migration with no benefit; the lock is an ephemeral
// file, so it is the thing that moves.
//
// `CTD_STATE_DIR` is still honoured as a legacy alias so existing setups keep working, but
// `SUPERVISOR_STATE_DIR` wins when both are set.

import os from "node:os";
import path from "node:path";

export const DB_FILE = "state.sqlite3";
export const SOCK_FILE = "supervisor.sock";
export const LOCK_FILE = "supervisor.lock";

/** The one state directory. Everything the supervisor persists lives directly under it. */
export function stateDir(env = process.env) {
  return (
    env.SUPERVISOR_STATE_DIR ||
    env.CTD_STATE_DIR || // legacy alias, kept working deliberately
    path.join(os.homedir(), ".custom-team-dashboard", "supervisor")
  );
}

export function dbPath(dir = stateDir()) {
  return path.join(dir, DB_FILE);
}

export function sockPath(dir = stateDir()) {
  return path.join(dir, SOCK_FILE);
}

export function lockPath(dir = stateDir()) {
  return path.join(dir, LOCK_FILE);
}

/**
 * Where the lock used to live (XDG-style), for one purpose only: a daemon started after this
 * change must not ignore a daemon still running against the OLD path. That would break the
 * single-writer invariant the entire design rests on — two live supervisors, each holding a
 * lock the other cannot see — so `acquireLock` refuses when a LIVE pid holds the legacy lock.
 *
 * Transitional. Delete this, and the check in lock.js, once no daemon predating 2026-09-07 can
 * still be running (i.e. after the first release that ships the unified root).
 */
export function legacyLockPath(env = process.env) {
  const dir = env.CTD_STATE_DIR || path.join(os.homedir(), ".local", "state", "custom-team-dashboard");
  return path.join(dir, LOCK_FILE);
}
