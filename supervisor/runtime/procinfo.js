// procinfo.js — the process-identity primitives Group 5's ownership, reap, and
// reconciliation logic are all built on.
//
// Why `ps` rather than a Node API: reconciliation needs pid **+ process group + start
// time** (PLAN.md section 4). Node exposes none of the last two — there is no
// `process.getpgid()`, and `process.kill(pid, 0)` only answers "does some process with
// this pid exist," which is exactly the question that pid reuse makes worthless. One
// `ps -o pid=,pgid=,lstart=` call answers all three at once, on both macOS and Linux.
//
// `lstart` is the pid-reuse guard. A recorded pid can come back as an unrelated process
// after a reboot or a busy fork loop; its start time cannot. Everything in this module
// that can kill something therefore refuses to act on pid alone.

import { execFile } from "node:child_process";

/** ps invocations are trivial; anything slower than this means something is very wrong. */
const PS_TIMEOUT_MS = 5000;

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: PS_TIMEOUT_MS, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * Read pid, pgid and start time for one pid.
 *
 * @returns {Promise<{ alive: boolean, pid: number, pgid: number|null, lstart: string|null }>}
 *   `alive: false` with null fields when no such process exists. Never throws for a
 *   missing process — "not there" is an ordinary answer here, not an error.
 */
export async function readProcInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { alive: false, pid, pgid: null, lstart: null };
  }
  const { err, stdout } = await execFileAsync("ps", ["-o", "pid=,pgid=,lstart=", "-p", String(pid)]);
  const line = stdout.trim();
  if (err || !line) return { alive: false, pid, pgid: null, lstart: null };

  // "12345 12345 Fri Sep  5 13:39:00 2026" — pid, pgid, then lstart with its own
  // internal spaces, so split on the first two fields only.
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
  if (!m) return { alive: false, pid, pgid: null, lstart: null };
  return { alive: true, pid: Number(m[1]), pgid: Number(m[2]), lstart: m[3].trim() };
}

/** Cheap liveness check. Deliberately NOT sufficient on its own to authorize a kill. */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return err.code === "EPERM";
  }
}

/**
 * Verify a recorded process identity still refers to the same live process.
 *
 * All three recorded fields must match. A `pgid` mismatch is as disqualifying as an
 * `lstart` mismatch: it means the process we are looking at is not the group leader we
 * recorded, so killing its group would hit processes we never owned.
 *
 * @param {{ pid: number, pgid?: number|null, lstart?: string|null }} recorded
 * @returns {Promise<{ ok: boolean, reason: string, observed: object }>}
 */
export async function verifyProcIdentity(recorded) {
  const observed = await readProcInfo(recorded.pid);
  if (!observed.alive) return { ok: false, reason: "no live process with that pid", observed };
  if (recorded.pgid != null && observed.pgid !== recorded.pgid) {
    return { ok: false, reason: `pgid mismatch (recorded ${recorded.pgid}, observed ${observed.pgid})`, observed };
  }
  if (recorded.lstart != null && observed.lstart !== recorded.lstart) {
    // The pid is live but it is a DIFFERENT process than the one recorded — the pid-reuse
    // case. Refusing here is the whole point of persisting lstart.
    return { ok: false, reason: `start-time mismatch (pid reuse: recorded "${recorded.lstart}", observed "${observed.lstart}")`, observed };
  }
  return { ok: true, reason: "pid+pgid+lstart all match", observed };
}

/**
 * Signal a whole process group. `pgid` must be positive; `process.kill(-pgid, sig)` is
 * the group form.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
export function signalProcessGroup(pgid, signal = "SIGTERM") {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    // pgid 1 or below would signal init or every process the user owns. Never.
    return { ok: false, reason: `refusing to signal process group ${pgid}` };
  }
  try {
    process.kill(-pgid, signal);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `${err.code || err.message}` };
  }
}

/**
 * True while any process remains in the group **including a zombie** — i.e. an exited child
 * whose parent has not waited for it yet. Cheap (one signal, no `ps`), which is why it is
 * kept, but it is NOT the question "is anything still running": `kill(-pgid, 0)` succeeds on
 * a group that contains nothing but zombies. Use `isProcessGroupLive()` when the answer has
 * to distinguish those. Measured on macOS 25.6 (Group 6): for a group whose only member is a
 * zombie, `kill(-pgid, 0)` returns success while `kill(-pgid, SIGTERM)` returns EPERM.
 */
export function isProcessGroupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Every process in the group with its state code, and whether that state means "already
 * exited, just not yet waited for" (a zombie: `Z` on both macOS and Linux).
 *
 * Uses `ps -A` and filters by pgid rather than `ps -g <pgid>`: BSD's `-g` selects by process
 * group, procps' `-g` selects by GROUP NAME, so the `-g` form silently answers a different
 * question on Linux. One `ps -A` is portable, and this is a kill path, not a hot loop.
 *
 * @returns {Promise<Array<{ pid: number, pgid: number, stat: string, zombie: boolean }>>}
 */
export async function listProcessGroupStates(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return [];
  const { err, stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,pgid=,stat="]);
  if (err && !stdout) return [];
  return stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), stat: m[3], zombie: m[3].startsWith("Z") }))
    .filter((row) => row.pgid === pgid);
}

/**
 * True while the group still contains a process that is actually RUNNING — a zombie does
 * not count, because it holds no resources, executes nothing, and cannot be signalled.
 *
 * This is the question a kill has to answer. Treating a zombie-only group as "survived the
 * kill" makes `reap` report failure and leave the run row open for a process that is
 * definitively dead (Group 6 finding), and treating it as alive in the escalation loop burns
 * the whole grace period before a pointless SIGKILL.
 */
export async function isProcessGroupLive(pgid) {
  const members = await listProcessGroupStates(pgid);
  return members.some((m) => !m.zombie);
}

/** Every pid currently in the given process group (diagnostics, and kill verification). */
export async function listProcessGroup(pgid) {
  const { err, stdout } = await execFileAsync("ps", ["-o", "pid=,pgid=,command=", "-g", String(pgid)]);
  if (err) return [];
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), pgid: Number(m[2]), command: m[3] } : null;
    })
    .filter((row) => row && row.pgid === pgid);
}
