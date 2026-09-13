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

import { spawnManaged, killProcessGroup } from "./spawn.js";
import { verifyProcIdentity } from "./procinfo.js";
import {
  claimPoolSlot, markPoolReady, markPoolFailed, attachToPool, detachAndMaybeDrain, markPoolStopped,
  getPool, listLivePoolRows,
} from "../db/index.js";
import crypto from "node:crypto";

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
   * `{ attachmentId, poolId, spawned: boolean }` on success, or throws if spawning failed and no
   * existing process could be joined either.
   */
  async function attach(name, config, { principalId = null, runId = null } = {}) {
    const configHash = hashPoolConfig(config);

    // First, try to join something already starting/ready — the common case once a pool is warm.
    const joined = attachToPool(db, { name, configHash, principalId, runId });
    if (joined.attached) return { attachmentId: joined.attachmentId, poolId: joined.pool.id, spawned: false };

    // Not joinable (no row, or it's draining/stopped/failed). Claim the slot to spawn — or discover a
    // concurrent caller already claimed it first, in which case wait briefly and retry the join. This
    // is the one place a short poll is the right tool: spawning is inherently a "someone becomes the
    // spawner" race, and the DB-level claim above already makes that decision atomic — we're just
    // waiting for the winner's spawn to finish, not re-deciding who won.
    for (let attempt = 0; attempt < 50; attempt += 1) {
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
          return { attachmentId: retryJoin.attachmentId, poolId: claim.pool.id, spawned: true };
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
      if (retry.attached) return { attachmentId: retry.attachmentId, poolId: retry.pool.id, spawned: false };
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`mcp-pool: attach(${name}) timed out waiting for a joinable or spawnable slot`);
  }

  async function spawnOne(poolId, config) {
    const { command, args = [], env = {}, cwd } = config;
    const spawned = spawnManaged({ command, args, cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const identity = await spawned.identity;
    if (!identity.verified) {
      try { spawned.child.kill("SIGKILL"); } catch { /* already gone */ }
      throw new Error(`mcp-pool: spawn of ${command} for pool ${poolId} could not be verified: ${identity.reason}`);
    }
    const ready = markPoolReady(db, poolId, { pid: identity.pid, pgid: identity.pgid, lstart: identity.lstart, socketPath: null });
    if (!ready.updated) {
      // Someone else already marked this pool row past 'starting' — shouldn't happen (this function is
      // only reached by the caller that won the claim), but a spawned-and-orphaned process is worse than
      // a loud failure.
      try { spawned.child.kill("SIGKILL"); } catch { /* already gone */ }
      throw new Error(`mcp-pool: pool ${poolId} was no longer 'starting' when spawn completed`);
    }
    spawned.child.once("exit", () => {
      // The process died on its own (crash, or a signal from outside this manager). Reflect it in the
      // DB so a later attach doesn't trust a stale 'ready' row — reconciliation would eventually catch
      // this too, but there's no reason to wait for a boot that may not come soon.
      //
      // MUST NOT THROW: this fires asynchronously, on the Node event loop's own schedule, arbitrarily
      // long after the actual process death — including after a caller (e.g. a test) has already closed
      // `db` and moved on. An uncaught throw inside an EventEmitter callback with no listener is FATAL to
      // the whole process (confirmed: crashed the entire `npm test` run with "TypeError: The database
      // connection is not open" when this fired post-teardown under load — the exact class of flake this
      // file's own tests were written to catch, just in a path those tests hadn't reached yet). Same
      // "best-effort, never throw from a fire-and-forget lifecycle hook" convention already used for the
      // `killProcessGroup` catches just above.
      liveChildren.delete(poolId);
      try {
        markPoolFailed(db, poolId);
      } catch (err) {
        logger.warn?.(`[mcp-pool] could not record exit of pool ${poolId} (db likely already closed): ${err.message}`);
      }
    });
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
        results.push({ poolId: pool.id, name: pool.name, reconciledTo: "failed", reason: "orphan-from-previous-boot, killed" });
      } else {
        markPoolFailed(db, pool.id);
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
      liveChildren.delete(poolId);
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
      // Best-effort DB write — `shutdown()` calls this BEFORE `closeDb()` specifically so this succeeds,
      // but never let a write failure here block tearing down the next pool's real OS process.
      try { if (killed) markPoolStopped(db, poolId); } catch { /* db may already be closing */ }
      results.push({ poolId, killed });
    }
    return results;
  }

  return { attach, detach, reconcileOnBoot, disposeAll, _liveChildren: liveChildren };
}
