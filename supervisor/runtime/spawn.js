// spawn.js — managed child spawning: real process-group ownership plus the spawn
// recursion guard. Every harness child in this codebase goes through here.
//
// Two review findings drive this file:
//
//   1. "Neither adapter currently spawns its child detached with the supervisor owning
//      the process group" (PLAN.md section 4, "Known gap, explicitly not yet closed").
//      Without `detached: true` the child inherits the *supervisor's* process group, so
//      the pgid recorded on the run row is the supervisor's own — which makes a later
//      "kill this run's process group" either a no-op or, much worse, a command to kill
//      the supervisor and every sibling run. Verified here rather than assumed: after
//      the spawn we read the child's real pgid back from the OS and require
//      `pgid === pid` (it leads its own group). Inheriting the parent's pgid was the
//      original bug; a comment claiming otherwise is not a fix.
//
//   2. Spawn recursion guard (PLAN.md section 4): a managed worker can re-invoke the
//      dashboard's own spawn path and create runs the supervisor only half-knows about.
//      `DASHBOARD_SPAWN_DEPTH` is set on every managed child at spawn time, and a spawn
//      requested from a process that is already at the ceiling is refused outright.

import { spawn } from "node:child_process";
import { readProcInfo, signalProcessGroup, isProcessGroupLive } from "./procinfo.js";

/** Env var name carried into every managed child. */
export const SPAWN_DEPTH_ENV = "DASHBOARD_SPAWN_DEPTH";

/**
 * Hard ceiling, per PLAN.md section 4 ("hard cap at 1 for dashboard-managed runs").
 * Depth 0 = the supervisor itself. Depth 1 = a harness process it manages. A depth-1
 * process asking to spawn a depth-2 managed run is refused: in-harness subagents are
 * never promoted to registry rows.
 */
export const MAX_SPAWN_DEPTH = 1;

/** How long to wait for the OS to report a just-spawned child before giving up. */
const IDENTITY_TIMEOUT_MS = 2000;

export class SpawnDepthExceededError extends Error {
  constructor(depth, ceiling) {
    super(
      `refusing to spawn a managed child: ${SPAWN_DEPTH_ENV}=${depth} is already at the ceiling of ${ceiling}. ` +
        `A dashboard-managed process may not spawn further dashboard-managed runs (PLAN.md section 4).`,
    );
    this.name = "SpawnDepthExceededError";
    this.depth = depth;
    this.ceiling = ceiling;
  }
}

/** Depth of the process calling this. 0 (the supervisor) when the var is absent or junk. */
export function currentSpawnDepth(env = process.env) {
  const raw = env[SPAWN_DEPTH_ENV];
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  // A malformed value is treated as "at the ceiling", not as 0: an unparseable depth
  // must never be the reason a recursion guard silently opens up.
  if (!Number.isInteger(n) || n < 0) return MAX_SPAWN_DEPTH;
  return n;
}

/**
 * Build the env for a managed child, incrementing the depth. Throws
 * SpawnDepthExceededError if the *current* process is already at the ceiling.
 */
export function childSpawnEnv(extraEnv = {}, env = process.env, ceiling = MAX_SPAWN_DEPTH) {
  const depth = currentSpawnDepth(env);
  if (depth >= ceiling) throw new SpawnDepthExceededError(depth, ceiling);
  return { ...env, ...extraEnv, [SPAWN_DEPTH_ENV]: String(depth + 1) };
}

/**
 * Spawn a child that leads its own process group, with the spawn-depth guard applied.
 *
 * Returns synchronously (like `child_process.spawn`, so callers with synchronous
 * `start()` signatures keep working), with the OS-verified identity available as a
 * promise on the result:
 *
 *   identity -> { verified: true,  pid, pgid, lstart }
 *            -> { verified: false, pid, reason }   // child already exited, or no group
 *
 * `verified: false` is not necessarily an error — a fast child can exit before `ps` can
 * see it, and there is then nothing to own or reap. What must never happen is recording
 * an *unverified* pgid on a run row and later killing that group; callers persist only
 * what this promise verifies.
 *
 * If the child comes back in someone else's process group (the inherited-pgid bug), it
 * is killed immediately and `identity` rejects: a child we cannot own is worse than no
 * child, because it looks managed and isn't.
 */
export function spawnManaged({
  command,
  args = [],
  cwd,
  stdio = ["pipe", "pipe", "pipe"],
  env,
  ceiling = MAX_SPAWN_DEPTH,
  // Test seams, both defaulted to the real behavior. `ps` being too slow to see a live
  // child is not something a test can provoke on demand, and the timeout branch is the one
  // that decides whether an unownable child is killed or abandoned — so it has to be
  // reachable deliberately.
  identityTimeoutMs = IDENTITY_TIMEOUT_MS,
  readProc = readProcInfo,
}) {
  const childEnv = childSpawnEnv(env ? { ...env } : {}, process.env, ceiling);

  const child = spawn(command, args, {
    cwd,
    stdio,
    env: childEnv,
    // The whole point of this module. On POSIX this makes the child a process-group
    // leader (setsid/setpgid), so its pgid === its pid and killing -pgid reaches it and
    // every descendant it spawns, and nothing else.
    detached: true,
  });

  // Do NOT unref(): the supervisor wants to know when this child exits. `detached` is
  // about process-group ownership and surviving the parent, not about being ignored.

  // A ChildProcess with no 'error' listener turns a failed spawn (ENOENT on the command,
  // EACCES on the cwd) into an *unhandled* 'error' event, which takes the whole daemon
  // down. Reproduced: `spawnManaged({ command: "definitely-not-a-command" })` printed
  // `Unhandled 'error' event` and exited, even though `identity` resolved cleanly with
  // `{ verified: false, reason: "spawn produced no pid" }`. The identity promise's
  // `.catch()` below guards the derived promise, never the emitter itself.
  const spawnError = new Promise((resolve) => {
    child.once("error", (err) => {
      child.__spawnError = err;
      resolve(err);
    });
  });
  // Nothing awaits `spawnError` unless the child fails, and a never-settling promise with
  // no handler is inert; the listener is what matters.
  void spawnError;

  const identity = captureIdentity(child, { identityTimeoutMs, readProc });
  // A rejected identity promise with no handler would be an unhandled rejection; the
  // caller is expected to await it, but a spawn that dies immediately must not be able
  // to take the supervisor down (findings B7/B8's class of bug).
  identity.catch(() => {});

  return { child, identity, spawnDepth: childEnv[SPAWN_DEPTH_ENV] };
}

async function captureIdentity(child, { identityTimeoutMs = IDENTITY_TIMEOUT_MS, readProc = readProcInfo } = {}) {
  const pid = child.pid;
  if (!pid) {
    // Give the 'error' event (emitted asynchronously by libuv) a turn, so the reason we
    // report is the actual spawn failure rather than the symptom.
    await new Promise((r) => setTimeout(r, 0));
    const err = child.__spawnError;
    return {
      verified: false,
      pid: null,
      reason: err ? `spawn failed: ${err.code ?? ""} ${err.message}`.trim() : "spawn produced no pid",
      spawnError: err ?? null,
    };
  }

  const deadline = Date.now() + identityTimeoutMs;
  for (;;) {
    const info = await readProc(pid);
    if (info.alive) {
      if (info.pgid !== pid) {
        // The inherited-pgid bug, caught at the only moment it can be caught cheaply.
        // Kill the child by pid (its group is not ours to signal) and refuse to hand
        // back a handle that would look managed.
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone; nothing to do */
        }
        throw new Error(
          `spawned child pid ${pid} is in process group ${info.pgid}, not its own (expected pgid === pid). ` +
            `It was killed rather than treated as managed — recording an inherited pgid is what makes a later ` +
            `"kill this run's process group" hit the supervisor instead of the run.`,
        );
      }
      return { verified: true, pid, pgid: info.pgid, lstart: info.lstart };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return { verified: false, pid, reason: `child exited (code=${child.exitCode} signal=${child.signalCode}) before its identity could be read` };
    }
    if (Date.now() >= deadline) {
      // The child may well be alive — `ps` can be slow on a loaded host. But an
      // unverifiable child is one the supervisor cannot own: `persistIdentity` records no
      // pid for it, `classifyRun` then calls it `lost` without consulting the OS, and
      // `reap` short-circuits on the NULL pid. Abandoning it manufactures exactly the
      // orphan this module exists to prevent, so kill it — same reasoning as the
      // inherited-pgid branch above.
      let killed = false;
      try {
        child.kill("SIGKILL");
        killed = true;
      } catch {
        /* already gone */
      }
      return {
        verified: false,
        pid,
        killed,
        reason: `no process info after ${identityTimeoutMs}ms; child was killed rather than left unowned`,
      };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Kill a managed child's whole process group, escalating SIGTERM -> SIGKILL.
 * Callers must have verified identity first (see procinfo.verifyProcIdentity) — this
 * function trusts the pgid it is given.
 */
export async function killProcessGroup(pgid, { graceMs = 2000, pollMs = 50 } = {}) {
  const term = signalProcessGroup(pgid, "SIGTERM");
  if (!term.ok && term.reason === "ESRCH") return { killed: true, escalated: false, note: "group already gone" };
  if (!term.ok) {
    // Not necessarily a failure. A group whose members have all exited but not yet been
    // waited for contains only zombies, and signalling a zombie group returns **EPERM**, not
    // ESRCH (measured on macOS 25.6 — see procinfo.isProcessGroupAlive's note). Reporting
    // `killed: false` there is a false negative with real consequences: `reap` gates its
    // terminal write on this flag, so it would leave the run row open, log "process group
    // SURVIVED the kill", and keep offering to reap a process that is definitively dead.
    // Reached deterministically by two concurrent reaps of the same run (Group 6).
    if (await isProcessGroupLive(pgid)) return { killed: false, escalated: false, note: term.reason };
    return { killed: true, escalated: false, note: `group already exited (${term.reason} on a zombie-only group)` };
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    // `kill(-pgid, 0)` also succeeds on a zombie-only group, so the cheap check alone would
    // spin out the entire grace period waiting for the parent to reap a dead child, then
    // escalate to a SIGKILL that can do nothing. Ask the cheap question first and only pay
    // for `ps` when it says "something is still there".
    if (!signalProcessGroup(pgid, 0).ok) return { killed: true, escalated: false };
    if (!(await isProcessGroupLive(pgid))) return { killed: true, escalated: false, note: "group already exited (zombies only)" };
    await new Promise((r) => setTimeout(r, pollMs));
  }

  const kill = signalProcessGroup(pgid, "SIGKILL");
  await new Promise((r) => setTimeout(r, pollMs));
  const stillThere = signalProcessGroup(pgid, 0).ok && (await isProcessGroupLive(pgid));
  return { killed: !stillThere, escalated: true, note: kill.ok ? undefined : kill.reason };
}
