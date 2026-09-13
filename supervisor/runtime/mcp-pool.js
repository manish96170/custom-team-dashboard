// mcp-pool.js — the MCP server pooling manager (PLAN.md §21.1), added 2026-09-11.
//
// One resident process per distinct (name, config) pair instead of one per attaching session. The DB
// primitives in `db/index.js` (`claimPoolSlot`/`attachToPool`/`detachAndMaybeDrain`/...) already make
// the attach-vs-drain race provably safe (see their doc comments); this module is the process side:
// actually spawning, health-checking, killing, and reconciling at boot — the same split
// `runtime/spawn.js`/`runtime/reconcile.js` already keep from `db/index.js`'s run rows, applied to a
// different resource.
//
// WHAT THIS DOES NOT SOLVE, WRITTEN DOWN RATHER THAN DISCOVERED LATER (codexdoc/REVIEW-NOTES.md's
// "Before MCP pooling and lazy discovery" section):
//   * A pooled process serving multiple attachers gets ONE environment/credential set, fixed at spawn
//     time. It cannot hand a different credential to each attacher — the exact limitation OpenCode's
//     own private `opencode serve` pool already has (`runtime/supervisor.js`'s OpenCode adapter notes
//     this token-delivery path as "undeliverable" for per-worker credentials). Only pool configurations
//     whose credential/isolation semantics genuinely permit sharing across attachers.
//   * This manager is IN-MEMORY-authoritative for the live child handle (a Map in THIS daemon
//     process), backed by the DB for cross-restart reconciliation — the same shape
//     `runtime/supervisor.js`'s adapter session maps already use for `runs`. It does not attempt to
//     reattach to a pooled process across a daemon restart — no ChildProcess handle survives one — so
//     `reconcileOnBoot` below treats EVERY `starting`/`ready` row as unusable at boot: genuinely dead
//     ones are marked `failed`, and ones still alive on the OS (orphaned from a previous boot) are
//     killed by process group and marked `failed` too, the same "the supervisor only kills what it
//     started" ownership `runtime/reconcile.js` already relies on for runs, applied to a process this
//     same daemon spawned in an earlier life.
//   * No lazy-discovery/tool-catalog logic lives here — that is §21.2, a session-facing concern, not a
//     process-lifecycle one. See PLAN.md §21.2 for what v1 of that turned out to actually need.

import { spawnManaged, killProcessGroup, IDENTITY_TIMEOUT_MS } from "./spawn.js";
import { verifyProcIdentity } from "./procinfo.js";
import {
  claimPoolSlot, markPoolReady, markPoolFailed, attachToPool, detachAndMaybeDrain, markPoolStopped,
  getPool, listLivePoolRows,
} from "../db/index.js";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Deterministically stringify a value with every object's keys sorted, AT EVERY NESTING LEVEL — not
 * just the top. `JSON.stringify`'s own replacer-array form only allow-lists key NAMES, and does so at
 * every level too, which silently DROPS any nested value whose key isn't also a top-level key name of
 * the outer object — e.g. `env.TOKEN` vanishes entirely unless `"TOKEN"` happens to also be a top-level
 * property name. Two configs differing only in a nested `env` value hashed IDENTICALLY as a result —
 * found in review (`codexdoc/review-luna-2026-09-11.md` finding 1), confirmed independently before this
 * fix: `hashPoolConfig({..., env:{TOKEN:"one"}})` and `hashPoolConfig({..., env:{TOKEN:"two"}})` both
 * produced `e15b0f9f44381656`. This function recurses instead, so every nested value participates.
 */
function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(",")}}`;
}

/** Same config-hash convention `resources.js`/`harness-defaults.js` use elsewhere: canonical JSON,
 *  hashed, so identical config always hits the same pool row and a different one never collides —
 *  including nested values (`env` credentials in particular), not just top-level key names. The
 *  config itself is never logged or persisted anywhere in this function; only its hash is. */
export function hashPoolConfig(config) {
  return crypto.createHash("sha256").update(canonicalStringify(config)).digest("hex").slice(0, 16);
}

/**
 * Create a pool manager bound to one database. Returns `{ attach, detach, reconcileOnBoot,
 * _liveChildren }` (`_liveChildren` exposed only for tests that need to assert real process state).
 */
export function createMcpPool({ db, logger = console } = {}) {
  // pool id -> { child, config } for a process THIS daemon actually spawned. A pool row can exist
  // without an entry here (e.g. after a restart, before reconciliation) — that asymmetry is exactly
  // what `reconcileOnBoot` exists to resolve.
  const liveChildren = new Map();

  /**
   * Attach to (or spawn) the pooled process for `name`+`config`. Returns
   * `{ attachmentId, poolId, spawned: boolean, socketPath: string }` on success, or throws if spawning
   * failed and no existing process could be joined either.
   *
   * `socketPath` (review-sol-2026-09-13.md finding 13) is what makes this attachment actually USABLE by
   * a worker, not just bookkeeping: every registered pool config is spawned as a socket-transport MCP
   * server (see `spawnOne` below) precisely so N attachers can share ONE resident process, and the caller
   * (`runtime/supervisor.js`'s `start()`) points a real, verified `--mcp-config` stdio entry — a tiny
   * proxy script, `mcp-stdio-proxy.js`, since no MCP client contract this repo has actually checked
   * supports a raw Unix socket as a transport type — at this exact path.
   */
  async function attach(name, config, { principalId = null, runId = null } = {}) {
    const configHash = hashPoolConfig(config);

    // First, try to join something already starting/ready — the common case once a pool is warm.
    const joined = attachToPool(db, { name, configHash, principalId, runId });
    if (joined.attached) return { attachmentId: joined.attachmentId, poolId: joined.pool.id, spawned: false, socketPath: joined.pool.socketPath };

    // Not joinable (no row, or it's draining/stopped/failed). Claim the slot to spawn — or discover a
    // concurrent caller already claimed it first, in which case wait briefly and retry the join. This
    // is the one place a short poll is the right tool: spawning is inherently a "someone becomes the
    // spawner" race, and the DB-level claim above already makes that decision atomic — we're just
    // waiting for the winner's spawn to finish, not re-deciding who won.
    //
    // review-consolidated-2026-09-14.md finding 6: this used to be a FIXED 50×20ms ≈ 1s budget — but the
    // WINNER's own spawn can legitimately take up to `IDENTITY_TIMEOUT_MS` (identity verification) plus
    // `SOCKET_WAIT_ATTEMPTS × SOCKET_WAIT_INTERVAL_MS` (socket readiness) ≈ 7s, reproduced directly with
    // a real delayed-bind socket server: the winner attached at ~2.1s while the loser had already thrown
    // "timed out waiting for a joinable or spawnable slot" at ~1s — a perfectly healthy pooled server
    // came up a second after the loser gave up on it. The loser's own budget is now derived from the
    // SAME numbers the winner's spawn actually uses, not an independent guess that can fall short of it.
    const ATTACH_WAIT_BUDGET_MS = IDENTITY_TIMEOUT_MS + (SOCKET_WAIT_ATTEMPTS * SOCKET_WAIT_INTERVAL_MS) + 2000;
    const ATTACH_POLL_INTERVAL_MS = 20;
    const attachDeadline = Date.now() + ATTACH_WAIT_BUDGET_MS;
    for (let attempt = 0; Date.now() < attachDeadline; attempt += 1) {
      const claim = claimPoolSlot(db, { name, configHash });
      if (claim.claimed) {
        let spawned = null;
        try {
          spawned = await spawnOne(claim.pool.id, config);
          liveChildren.set(claim.pool.id, { child: spawned.child, config });
          const retryJoin = attachToPool(db, { name, configHash, principalId, runId });
          if (!retryJoin.attached) {
            // Spawned successfully but somehow not joinable an instant later — should not happen given
            // this function is the only writer of 'ready', but fail loudly rather than silently swallow.
            throw new Error(`mcp-pool: spawned ${name} but could not attach immediately after: ${retryJoin.reason}`);
          }
          return { attachmentId: retryJoin.attachmentId, poolId: claim.pool.id, spawned: true, socketPath: retryJoin.pool.socketPath };
        } catch (err) {
          // review-sol-2026-09-13.md finding 15: a real, verified process was spawned and marked 'ready'
          // above — if anything AFTER that (the attach insert, a DB error) fails, the process must be
          // killed here rather than left resident with no DB row and no live-child-map entry pointing at
          // it once `markPoolFailed` below runs. Leaving `spawned` alive here is exactly the leak.
          liveChildren.delete(claim.pool.id);
          if (spawned) {
            const pool = getPool(db, claim.pool.id);
            if (pool?.pgid) {
              try { await killProcessGroup(pool.pgid, { graceMs: 1000 }); } catch (killErr) { logger.warn?.(`[mcp-pool] cleanup kill of ${claim.pool.id} after attach failure: ${killErr.message}`); }
            } else {
              try { spawned.child.kill("SIGKILL"); } catch { /* already gone */ }
            }
          }
          markPoolFailed(db, claim.pool.id);
          throw err;
        }
      }
      // Someone else claimed it (or a joinable row appeared between our failed join and now) — check
      // once more before waiting, then retry the whole loop.
      const retry = attachToPool(db, { name, configHash, principalId, runId });
      if (retry.attached) return { attachmentId: retry.attachmentId, poolId: retry.pool.id, spawned: false, socketPath: retry.pool.socketPath };
      await new Promise((r) => setTimeout(r, ATTACH_POLL_INTERVAL_MS));
    }
    throw new Error(`mcp-pool: attach(${name}) timed out waiting for a joinable or spawnable slot`);
  }

  // review-sol-2026-09-13.md finding 13: every registered pool config is spawned as a socket-transport
  // MCP server (leo-mcp's `mcp/server-socket.js`, the one real config this repo has) — that is the whole
  // point of pooling: N attachers sharing ONE resident process needs a transport that is not 1:1 stdio.
  // A short, flat filename (no subdirectory) matters here, not just for tidiness: `os.tmpdir()` can
  // already be a long path on macOS, and AF_UNIX socket paths have a real, low length limit
  // (~104 bytes on macOS/BSD) — a nested path would risk `bind: File name too long` on exactly the
  // platform this project targets.
  const SOCKET_WAIT_ATTEMPTS = 100;
  const SOCKET_WAIT_INTERVAL_MS = 50;

  function socketPathFor(poolId) {
    return path.join(os.tmpdir(), `${poolId}.sock`);
  }

  /** A single, bounded, real connect-then-close handshake — review-consolidated-2026-09-14.md finding
   *  5's actual readiness proof. `fs.existsSync` alone cannot distinguish a live listening socket from
   *  a regular file someone left at that path, or a socket a server bound and then crashed right after
   *  (measured, real reproductions: both leave `existsSync` true and connecting fails — `ENOTSOCK` for
   *  the regular-file case, `ECONNREFUSED` for the bind-then-exit case). */
  function canConnect(socketPath) {
    return new Promise((resolve) => {
      let settled = false;
      const conn = net.connect(socketPath);
      const settle = (ok) => { if (settled) return; settled = true; resolve(ok); };
      conn.once("connect", () => { conn.end(); settle(true); });
      conn.once("error", () => settle(false));
      // A hung connect attempt (rare, but a socket handshake is not otherwise bounded) must not stall
      // the whole readiness loop — treat it as "not ready yet" and let the outer loop's own attempt
      // budget decide whether to keep trying.
      setTimeout(() => { try { conn.destroy(); } catch { /* already gone */ } settle(false); }, SOCKET_WAIT_INTERVAL_MS);
    });
  }

  async function spawnOne(poolId, config) {
    const { command, args = [], env = {}, cwd } = config;
    const socketPath = socketPathFor(poolId);
    // Best-effort: a stale socket file from a process this same poolId never actually reused (pool rows
    // are per (name, configHash) forever, so a resurrection reuses the same id) would make the new
    // server's own `listen()` fail with EADDRINUSE. leo-mcp's `server-socket.js` already removes a stale
    // file itself before listening — this is only a defensive belt-and-braces remove for a config that
    // might not.
    try { fs.rmSync(socketPath, { force: true }); } catch { /* best effort */ }
    const spawned = spawnManaged({
      command, args, cwd, env: { ...env, LEO_MCP_SOCKET_PATH: socketPath }, stdio: ["pipe", "pipe", "pipe"],
    });

    // review-consolidated-2026-09-14.md finding 5: this listener is installed IMMEDIATELY, before ever
    // awaiting identity or polling for the socket — Node does NOT replay a missed `exit` to a listener
    // attached after the child already died (verified directly: a listener attached 600ms post-exit
    // never fires), so a listener registered only after `markPoolReady` succeeded could permanently miss
    // a death that happened during the wait itself. One listener does both jobs: it flags `died` for the
    // readiness loop below to notice immediately, AND does the unconditional DB/handle cleanup whenever
    // this process exits, at any point in its life — not just after this function returns successfully.
    let died = false;
    let dieInfo = null;
    spawned.child.once("exit", (code, signal) => {
      died = true;
      dieInfo = { code, signal };
      liveChildren.delete(poolId);
      try {
        markPoolFailed(db, poolId);
      } catch (err) {
        // MUST NOT THROW: this fires asynchronously, on the Node event loop's own schedule, arbitrarily
        // long after the actual process death — including after a caller (e.g. a test) has already
        // closed `db` and moved on. An uncaught throw inside an EventEmitter callback with no listener
        // is FATAL to the whole process (confirmed: crashed the entire `npm test` run with "TypeError:
        // The database connection is not open" when this fired post-teardown under load).
        logger.warn?.(`[mcp-pool] could not record exit of pool ${poolId} (db likely already closed): ${err.message}`);
      }
    });

    const identity = await spawned.identity;
    if (!identity.verified) {
      try { spawned.child.kill("SIGKILL"); } catch { /* already gone */ }
      throw new Error(`mcp-pool: spawn of ${command} for pool ${poolId} could not be verified: ${identity.reason}`);
    }

    // Verify the socket is ACTUALLY listening before ever telling a caller it can connect to it — same
    // "verify against the real OS, don't trust a fixed delay" discipline this codebase applies to git
    // worktree claims and process identity elsewhere. THREE checks, not one (finding 5): the path
    // exists, it is genuinely a SOCKET (not a regular file some misconfigured process left there), and a
    // real connect-then-close handshake actually succeeds (catches a server that bound and crashed
    // before this loop got to it — `existsSync` alone would still report `true` for that stale file).
    let socketReady = false;
    for (let attempt = 0; attempt < SOCKET_WAIT_ATTEMPTS && !socketReady; attempt += 1) {
      if (died) break; // the early exit listener above already caught this — no point waiting further
      let isSocketFile = false;
      try { isSocketFile = fs.existsSync(socketPath) && fs.statSync(socketPath).isSocket(); } catch { /* race with removal, retry */ }
      if (isSocketFile && await canConnect(socketPath)) socketReady = true;
      else await new Promise((r) => setTimeout(r, SOCKET_WAIT_INTERVAL_MS));
    }
    if (!socketReady) {
      if (!died) {
        try { await killProcessGroup(identity.pgid, { graceMs: 1000 }); } catch (killErr) { logger.warn?.(`[mcp-pool] cleanup kill of ${poolId} after socket-wait timeout: ${killErr.message}`); }
      }
      throw new Error(
        died
          ? `mcp-pool: ${command} for pool ${poolId} exited (code=${dieInfo.code} signal=${dieInfo.signal}) before its socket at ${socketPath} became connectable`
          : `mcp-pool: ${command} for pool ${poolId} never became connectable at ${socketPath} within ${SOCKET_WAIT_ATTEMPTS * SOCKET_WAIT_INTERVAL_MS}ms`,
      );
    }

    // review-consolidated-2026-09-14.md finding 12: a Node Unix socket is created mode 0755 by default —
    // world-CONNECTABLE on any platform where the containing directory is itself shared (`TMPDIR=/tmp`
    // on Linux/CI; macOS's per-user `os.tmpdir()` mitigates this locally but this must not depend on
    // that). `0600` asserts the isolation directly rather than inheriting it from the platform's temp-dir
    // policy — with no peer-credential check anywhere in this stack, this is the only boundary there is.
    try { fs.chmodSync(socketPath, 0o600); } catch (err) { logger.warn?.(`[mcp-pool] could not chmod socket ${socketPath}: ${err.message}`); }

    const ready = markPoolReady(db, poolId, { pid: identity.pid, pgid: identity.pgid, lstart: identity.lstart, socketPath });
    if (!ready.updated) {
      // Someone else already marked this pool row past 'starting' — shouldn't happen (this function is
      // only reached by the caller that won the claim), but a spawned-and-orphaned process is worse than
      // a loud failure.
      try { await killProcessGroup(identity.pgid, { graceMs: 1000 }); } catch (killErr) { logger.warn?.(`[mcp-pool] cleanup kill of ${poolId} after lost markPoolReady race: ${killErr.message}`); }
      throw new Error(`mcp-pool: pool ${poolId} was no longer 'starting' when spawn completed`);
    }
    return spawned;
  }

  /**
   * Detach an attachment. If it was the last live one, tear down the real process — using
   * `detachAndMaybeDrain`'s atomic decision, never a separate racy count-then-kill.
   *
   * review-sol-2026-09-13.md finding 22: `killProcessGroup`'s return value used to be IGNORED — a
   * `{ killed: false }` (the process genuinely survived the signal, e.g. `EPERM` on a group this
   * process no longer has permission to signal) still cleared the live-child handle and marked the row
   * `stopped`, as if the process were confirmed dead. A later `attach()` for the same (name, configHash)
   * would then spawn a SECOND, genuinely duplicate process — the DB row said "gone," but the real OS
   * process was never actually killed. Now: only clear the handle and mark `stopped` when the kill is
   * CONFIRMED (or there was nothing to kill in the first place); a genuine kill failure keeps the row
   * `draining` (already set by `detachAndMaybeDrain` above) and the handle live, so a future call still
   * knows this process might still be running, rather than silently lying that it is not.
   */
  async function detach(attachmentId) {
    const result = detachAndMaybeDrain(db, attachmentId);
    if (!result.detached) return result;
    if (result.shouldTeardown) {
      const entry = liveChildren.get(result.poolId);
      if (entry) {
        const pool = getPool(db, result.poolId);
        let killed = true;
        if (pool?.pgid) {
          try {
            const outcome = await killProcessGroup(pool.pgid, { graceMs: 1000 });
            killed = outcome.killed;
          } catch (err) {
            logger.warn?.(`[mcp-pool] teardown of ${result.poolId}: ${err.message}`);
            killed = false;
          }
        } else {
          try { entry.child.kill("SIGTERM"); } catch { /* already gone */ }
        }
        if (!killed) {
          logger.warn?.(`[mcp-pool] teardown of ${result.poolId} could not confirm the process is dead — leaving it 'draining', not marking 'stopped'`);
          return { ...result, teardownConfirmed: false };
        }
        liveChildren.delete(result.poolId);
      }
      markPoolStopped(db, result.poolId);
      // Best-effort tidiness: a genuinely torn-down pool has no reason to leave its socket file behind
      // in `os.tmpdir()` — `spawnOne`'s own stale-file removal already tolerates this being skipped, so
      // a failure here is never allowed to affect the (already-committed) teardown result.
      try { fs.rmSync(socketPathFor(result.poolId), { force: true }); } catch { /* best effort */ }
    }
    return result;
  }

  /**
   * Boot-time reconciliation. Every `starting`/`ready` row predates THIS process's `liveChildren` map by
   * construction (it is empty at boot) — so every one of them is either genuinely dead (mark `failed`,
   * same "verify against the OS, don't trust the row" discipline `runtime/reconcile.js` already applies
   * to `runs`) or an ORPHAN from a previous boot of this same daemon: still alive on the OS, but with no
   * in-memory ChildProcess handle surviving the restart, so this manager could never actually write to
   * its stdin or read its stdout again. Leaving it running would be a live, unreachable, unaccounted
   * process — the same shape `reconcile.js`'s run-reaping already exists to close, applied here.
   * Verified-alive orphans are killed by process group (ownership already recorded as `pgid` at spawn
   * time) and marked `failed`, so the next `attach()` spawns a fresh, actually-usable process rather than
   * handing back an attachment to a process it cannot speak to. Deliberately NOT sharing code with
   * `reconcile.js` (different resource, different table) — parallel structure only.
   *
   * IDENTITY IS VERIFIED, NOT JUST LIVENESS — review-sol-2026-09-13.md finding 1 (critical). A pid can be
   * reused by an unrelated process between this daemon's last boot and this one; `isPidAlive(pool.pid)`
   * alone cannot tell that process apart from the one this manager actually spawned. `runs.proc_lstart`
   * (migration 0002) already exists to close exactly this gap for regular runs, and `runtime/reconcile.js`
   * already refuses to kill on a pid/pgid/lstart mismatch — this uses the same `verifyProcIdentity()`
   * primitive rather than trusting pid+pgid alone. A pool row with no recorded `pgid` can never be killed
   * (nothing to have grouped a full process tree behind); a mismatch or a genuinely dead process is
   * reported and left unkilled, not force-signaled on a guess.
   */
  async function reconcileOnBoot() {
    const results = [];
    for (const pool of listLivePoolRows(db)) {
      if (!pool.pid || !pool.pgid) {
        markPoolFailed(db, pool.id);
        results.push({ poolId: pool.id, name: pool.name, reconciledTo: "failed", reason: "no recorded pid/pgid" });
        continue;
      }
      const identity = await verifyProcIdentity({ pid: pool.pid, pgid: pool.pgid, lstart: pool.lstart });
      if (identity.ok) {
        // review-sol-2026-09-13.md finding 22 (boot-reconciliation half): the kill outcome used to be
        // ignored here too — a genuinely-surviving orphan (`killed: false`) still got `markPoolFailed`,
        // so the DB claimed it was gone while the real process kept running, unaccounted for, and a
        // fresh `attach()` could spawn a duplicate alongside it. Only mark `failed` when the kill is
        // actually confirmed; otherwise report the survival honestly and leave the row as-is so it is
        // re-examined (not silently trusted dead) on the next boot.
        let killed = false;
        try {
          killed = (await killProcessGroup(pool.pgid, { graceMs: 1000 })).killed;
        } catch (err) {
          logger.warn?.(`[mcp-pool] reconcile kill of orphan ${pool.id}: ${err.message}`);
        }
        if (!killed) {
          results.push({ poolId: pool.id, name: pool.name, reconciledTo: "unchanged", reason: "orphan-from-previous-boot, kill NOT confirmed — left for re-examination" });
          continue;
        }
        markPoolFailed(db, pool.id);
        try { fs.rmSync(socketPathFor(pool.id), { force: true }); } catch { /* best effort — finding 12 */ }
        results.push({ poolId: pool.id, name: pool.name, reconciledTo: "failed", reason: "orphan-from-previous-boot, killed" });
      } else {
        markPoolFailed(db, pool.id);
        try { fs.rmSync(socketPathFor(pool.id), { force: true }); } catch { /* best effort — finding 12 */ }
        results.push({ poolId: pool.id, name: pool.name, reconciledTo: "failed", reason: `not verified-alive: ${identity.reason}` });
      }
    }
    return results;
  }

  /**
   * Kill every live pooled process THIS manager instance spawned, best-effort and bounded.
   *
   * review-sol-2026-09-13.md finding 22 (shutdown half): `runtime/supervisor.js`'s `shutdown()` disposed
   * harness adapters but never touched the MCP pool manager at all — a pooled process (e.g. `leo-mcp`)
   * stayed running after the daemon exited, unaccounted for, and its own `exit` handler (registered in
   * `spawnOne`, above) could fire arbitrarily later and try to write to a DATABASE THE SUPERVISOR HAS
   * ALREADY CLOSED (that handler's own comment already documents this exact class of post-teardown
   * crash as something that has happened before). Called by `shutdown()` BEFORE `closeDb()`, mirroring
   * the same "kill real processes before anything closes the database out from under a fire-and-forget
   * hook" ordering `shutdown()` already applies to harness adapters.
   */
  async function disposeAll({ graceMs = 1000 } = {}) {
    const results = [];
    for (const [poolId, entry] of [...liveChildren]) {
      // review-consolidated-2026-09-14.md finding 7: the handle used to be deleted BEFORE the kill was
      // even attempted — an unconfirmed kill (EPERM, a group that outlives the grace window) still left
      // this manager believing it had already dropped ownership, so a real, still-resident MCP process
      // holding real Jira/Slack/git credentials could survive shutdown with nothing tracking it and
      // nothing warning about it. Same discipline `detach()` already has: only delete the handle once
      // the kill is CONFIRMED.
      let killed = true;
      try {
        const pool = getPool(db, poolId);
        if (pool?.pgid) {
          killed = (await killProcessGroup(pool.pgid, { graceMs })).killed;
        } else {
          try { entry.child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      } catch (err) {
        logger.warn?.(`[mcp-pool] disposeAll kill of ${poolId}: ${err.message}`);
        killed = false;
      }
      if (!killed) {
        logger.warn?.(`[mcp-pool] disposeAll could not confirm ${poolId} is dead — leaving its handle live and its row unmarked, unlike every other reported result here`);
        results.push({ poolId, killed: false });
        continue;
      }
      liveChildren.delete(poolId);
      // Best-effort DB write — `shutdown()` calls this BEFORE `closeDb()` specifically so this succeeds,
      // but never let a write failure here block tearing down the next pool's real OS process.
      try { markPoolStopped(db, poolId); } catch { /* db may already be closing */ }
      try { fs.rmSync(socketPathFor(poolId), { force: true }); } catch { /* best effort — finding 12 */ }
      results.push({ poolId, killed: true });
    }
    return results;
  }

  return { attach, detach, reconcileOnBoot, disposeAll, _liveChildren: liveChildren };
}
