// mcp-pool.test.js — the MCP server pooling manager (PLAN.md §21.1, `runtime/mcp-pool.js`), added
// 2026-09-11. Real spawned OS processes throughout — no mocked process lifecycle, same "no mocked git"
// discipline this project applies to every real-OS-resource module.
//
// Cases:
//   1. a second attach on the same config JOINS the real spawned process, no second spawn
//   2. the last detach tears down the real process; a later attach RESURRECTS the same identity
//      (a fresh real process, same pool row id — proves claimPoolSlot's resurrection path, not a
//      duplicate-row insert, which the unique index would have refused anyway)
//   3. deterministic proof the attach-vs-drain race is closed: manually interleaving
//      detachAndMaybeDrain and attachToPool at the exact decision point shows attach refused once
//      draining has been decided, not "usually refused"
//   4. the DB PRIMITIVES race-safe across real OS processes (8 processes, 3 claim/attach/detach cycles
//      each) — separate from the manager's own concurrency model, see below
//   5. the MANAGER is safe under real concurrent async attach/detach WITHIN ONE PROCESS (its actual
//      concurrency model — `liveChildren` is in-memory per manager instance, so cross-process teardown
//      of another process's spawned child was never a real scenario this manager needs to handle; a
//      single daemon owns one manager instance and every attacher goes through it)
//   6. boot-time reconciliation kills a real orphaned-but-alive process from a "previous boot" and
//      marks it failed; a genuinely dead pid is marked failed without attempting to signal it
//   7. hashPoolConfig hashes nested values (env credentials in particular), not just top-level key
//      names — fixed 2026-09-11 (`codexdoc/review-luna-2026-09-11.md` finding 1)
//   8. a REAL child killed outside detach() no longer leaks a stale live attachment: markPoolFailed
//      closes it atomically, so the replacement process spawned on the next attach can still be torn
//      down correctly by its OWN detach — fixed 2026-09-11 (finding 3)

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnChild } from "node:child_process";
import { openDb, closeDb, claimPoolSlot, markPoolReady, attachToPool, detachAndMaybeDrain, getPool } from "../../db/index.js";
import { createMcpPool, hashPoolConfig } from "../mcp-pool.js";
import { isPidAlive, isProcessGroupLive, readProcInfo } from "../procinfo.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

// `isPidAlive` is `process.kill(pid, 0)` — true for a ZOMBIE too (this project's own procinfo.js
// docstring says so explicitly: "Deliberately NOT sufficient on its own to authorize a kill"). A killed
// child can sit as a zombie for a brief window after `killProcessGroup` confirms the signal landed,
// which made an earlier version of this test genuinely flaky asserting "must be dead" with `isPidAlive`.
// `isProcessGroupLive` (zombie-aware) is the right tool for "is it REALLY gone" — same one
// `runtime/spawn.js`'s own `killProcessGroup` uses internally. Since every process here is its own
// group leader (`detached: true`), pid === pgid.
const isReallyDead = async (pid) => !(await isProcessGroupLive(pid));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = path.join(__dirname, "_mcp-pool-race-child.js");
const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };
// `spawnOne` (review-sol-2026-09-13.md finding 13) now waits for the spawned process to actually create
// a Unix socket at `process.env.LEO_MCP_SOCKET_PATH` before marking the pool row ready — the whole point
// of pooling being N attachers sharing one socket-transport server. This fixture is a real one: it opens
// a real `net.createServer()` on that exact env var and idles, matching the convention every registered
// pool config (leo-mcp's `server-socket.js`) actually follows.
const SOCKET_SERVER_SCRIPT = "require('net').createServer(() => {}).listen(process.env.LEO_MCP_SOCKET_PATH, () => setInterval(() => {}, 60000))";
const LONG_LIVED = { command: process.execPath, args: ["-e", SOCKET_SERVER_SCRIPT] };

function runRaceChild(stateDir, index, barrierPath, name, configHash) {
  return new Promise((resolve) => {
    const child = spawnChild(process.execPath, [CHILD_SCRIPT, stateDir, String(index), barrierPath, name, configHash], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ index, code, stdout, stderr }));
    child.on("error", (err) => resolve({ index, code: -1, stdout, stderr: String(err) }));
  });
}

async function waitForReady(barrierDir, barrierPath, n) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ready = fs.readdirSync(barrierDir).filter((f) => f.includes(".ready.")).length;
    if (ready === n) break;
    if (Date.now() > deadline) throw new Error(`only ${ready}/${n} children reported ready`);
    await new Promise((r) => setTimeout(r, 5));
  }
  fs.writeFileSync(barrierPath, "");
}

await runTest("mcp server pooling", async () => {
  // ── 1 & 2 ────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("mcp-pool-basic");
    let db;
    try {
      db = openDb({ stateDir });
      const pool = createMcpPool({ db, logger: quiet });

      const a = await pool.attach("basic", LONG_LIVED);
      assert.equal(a.spawned, true, "the first attach must spawn");
      const firstPoolId = a.poolId;
      const firstPid = getPool(db, firstPoolId).pid;
      assert.ok(isPidAlive(firstPid), "the spawned process must actually be alive");

      const b = await pool.attach("basic", LONG_LIVED);
      assert.equal(b.spawned, false, "a second attach on the SAME config must join, not spawn again");
      assert.equal(b.poolId, firstPoolId);

      const detachA = await pool.detach(a.attachmentId);
      assert.equal(detachA.shouldTeardown, false, "one of two attachments detaching must not drain yet");
      assert.ok(isPidAlive(firstPid), "the process must still be alive with one attachment left");

      const detachB = await pool.detach(b.attachmentId);
      assert.equal(detachB.shouldTeardown, true, "the LAST detach must trigger teardown");
      // detach() awaits the real kill before returning.
      assert.ok(await isReallyDead(firstPid), "the real process must actually be dead after the last detach");
      assert.equal(getPool(db, firstPoolId).status, "stopped");

      // ── 2, continued: resurrection ──────────────────────────────────────────────────
      const c = await pool.attach("basic", LONG_LIVED);
      assert.equal(c.spawned, true, "after a full drain, the NEXT attach must spawn again");
      assert.equal(c.poolId, firstPoolId, "resurrection reuses the SAME pool row id — the unique index on (name, config_hash) allows nothing else");
      const secondPid = getPool(db, firstPoolId).pid;
      assert.notEqual(secondPid, firstPid, "the resurrected process must be a genuinely new OS process");
      assert.ok(isPidAlive(secondPid));
      await pool.detach(c.attachmentId);
      assert.ok(await isReallyDead(secondPid), "the resurrected process must actually be dead after detach");
      console.log("  1. a second attach joins the real spawned process, no second spawn");
      console.log("  2. the last detach tears down the real process; a later attach resurrects the same identity with a fresh real process");
    } finally {
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 3 ────────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("mcp-pool-race-proof");
    let db;
    try {
      db = openDb({ stateDir });
      const configHash = hashPoolConfig(LONG_LIVED);
      const claim = claimPoolSlot(db, { name: "det", configHash });
      assert.equal(claim.claimed, true);
      markPoolReady(db, claim.pool.id, { pid: 999999, pgid: 999999 }); // fake pid — no real process needed for this deterministic proof
      const first = attachToPool(db, { name: "det", configHash });
      assert.equal(first.attached, true);

      // Detach decides to drain — status flips to 'draining' INSIDE detachAndMaybeDrain's own
      // transaction, which has already committed by the time this line runs.
      const detachResult = detachAndMaybeDrain(db, first.attachmentId);
      assert.equal(detachResult.shouldTeardown, true);
      assert.equal(getPool(db, claim.pool.id).status, "draining");

      // A "concurrent" attach arriving right now (teardown/kill has not happened yet in this
      // deterministic proof — that's the exact window the review flagged) must be refused, not
      // silently joined to a process that is about to be killed.
      const raceAttach = attachToPool(db, { name: "det", configHash });
      assert.equal(raceAttach.attached, false, "an attach arriving after drain was decided must be refused, not joined");
      assert.match(raceAttach.reason, /draining/);
      console.log("  3. deterministic proof: attach is refused once drain has been decided, not usually-refused");
    } finally {
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 4 ────────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("mcp-pool-real-race");
    const barrierDir = makeScratchDir("mcp-pool-race-barrier");
    try {
      closeDb(openDb({ stateDir })); // pre-create schema outside the race, same reasoning leases.test.js uses
      const barrierPath = path.join(barrierDir, "go");
      const numChildren = 8;
      const pending = Array.from({ length: numChildren }, (_, i) => runRaceChild(stateDir, i, barrierPath, "db-race-target", "fake-hash"));
      await waitForReady(barrierDir, barrierPath, numChildren);
      const results = await Promise.all(pending);

      const failed = results.filter((r) => r.code !== 0);
      if (failed.length > 0) assert.fail(failed.map((r) => `child ${r.index} exited ${r.code}\n${r.stderr}`).join("\n---\n"));

      const db = openDb({ stateDir });
      try {
        const rows = db.prepare(`SELECT * FROM mcp_pool WHERE name = ? AND config_hash = ?`).all("db-race-target", "fake-hash");
        assert.equal(rows.length, 1, `exactly one pool row must exist for this identity no matter how many claim/resurrect cycles happened, got ${rows.length}`);
        const liveAttachments = db.prepare(
          `SELECT COUNT(*) AS n FROM mcp_pool_attachments WHERE pool_id = ? AND detached_at IS NULL`,
        ).get(rows[0].id).n;
        assert.equal(liveAttachments, 0, "every attachment from every child must have been detached by the end");
      } finally {
        closeDb(db);
      }
      console.log("  4. the DB primitives are race-safe across 8 real OS processes, 3 claim/attach/detach cycles each: exactly one pool row, zero live attachments at the end");
    } finally {
      rmScratchDir(stateDir);
      rmScratchDir(barrierDir);
    }
  }

  // ── 5 ────────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("mcp-pool-inprocess-concurrency");
    let db;
    try {
      db = openDb({ stateDir });
      const pool = createMcpPool({ db, logger: quiet });

      // 6 concurrent "workers" within THIS process, each doing 2 attach/hold/detach cycles against the
      // SAME identity — this IS the manager's real concurrency model (many async callers, one manager
      // instance, `liveChildren` always has the entry because there is only ever one manager doing the
      // spawning and the killing).
      const seenPids = [];
      async function worker() {
        for (let i = 0; i < 2; i += 1) {
          const { attachmentId, poolId } = await pool.attach("concurrent", LONG_LIVED);
          seenPids.push(getPool(db, poolId).pid);
          await new Promise((r) => setTimeout(r, Math.random() * 15));
          await pool.detach(attachmentId);
        }
      }
      await Promise.all(Array.from({ length: 6 }, () => worker()));

      assert.equal(pool._liveChildren.size, 0, "no leaked in-memory child handles after every worker finished");
      const configHash = hashPoolConfig(LONG_LIVED);
      const rows = db.prepare(`SELECT * FROM mcp_pool WHERE name = ? AND config_hash = ?`).all("concurrent", configHash);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "stopped");
      assert.ok(seenPids.length > 0);
      for (const pid of seenPids) {
        assert.ok(await isReallyDead(pid), `real process ${pid} must not be leaked — no orphaned child left running`);
      }
      console.log("  5. 6 concurrent async workers in one process race attach/detach on the manager: no leaked handles, no leaked real process");
    } finally {
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 6 ────────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("mcp-pool-reconcile");
    let db;
    try {
      db = openDb({ stateDir });

      // A real orphan: spawn a process directly (bypassing the manager, simulating "a previous boot
      // of this daemon spawned it"), record it as 'ready' with real pid/pgid, then reconcile with a
      // FRESH manager that has no in-memory handle for it.
      const orphan = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { detached: true, stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(isPidAlive(orphan.pid), "precondition: the orphan process must actually be alive");
      const claim = claimPoolSlot(db, { name: "orphan-target", configHash: "x" });
      markPoolReady(db, claim.pool.id, { pid: orphan.pid, pgid: orphan.pid });

      // A genuinely dead one too, in the same reconciliation pass.
      const deadClaim = claimPoolSlot(db, { name: "dead-target", configHash: "y" });
      markPoolReady(db, deadClaim.pool.id, { pid: 999998, pgid: 999998 });

      const freshManager = createMcpPool({ db, logger: quiet });
      const results = await freshManager.reconcileOnBoot();
      assert.equal(results.length, 2);

      assert.equal(getPool(db, claim.pool.id).status, "failed");
      assert.equal(getPool(db, deadClaim.pool.id).status, "failed");
      assert.ok(await isReallyDead(orphan.pid), "the orphaned-but-alive process must actually be killed by reconciliation, not just marked failed in the db");
      const orphanResult = results.find((r) => r.poolId === claim.pool.id);
      assert.match(orphanResult.reason, /orphan/);
      console.log("  6. boot reconciliation kills a real orphaned-but-alive process and marks it failed; a dead pid is marked failed without a kill attempt");
    } finally {
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 7 ────────────────────────────────────────────────────────────────────────────────
  {
    // The exact repro from the review: two configs differing ONLY in a nested `env` value used to
    // hash identically, because JSON.stringify's replacer-array form allow-lists key NAMES at every
    // nesting level, silently dropping `env.TOKEN` since "TOKEN" isn't also a top-level key.
    const base = { command: "node", args: ["server.js"], cwd: "/tmp" };
    const withTokenOne = hashPoolConfig({ ...base, env: { TOKEN: "one" } });
    const withTokenTwo = hashPoolConfig({ ...base, env: { TOKEN: "two" } });
    assert.notEqual(withTokenOne, withTokenTwo, "two configs differing only in a nested env value must hash differently");

    // A nested SETTING (not just env) must also participate, and a nested ARRAY-valued difference too.
    const nestedSettingA = hashPoolConfig({ ...base, options: { retries: 1 } });
    const nestedSettingB = hashPoolConfig({ ...base, options: { retries: 2 } });
    assert.notEqual(nestedSettingA, nestedSettingB, "a nested non-env setting must also participate in the hash");

    // Identical VALUES in different key order must still hash the SAME — this is a canonicalization
    // fix, not a "hash everything including insertion order" regression.
    const orderA = { command: "node", args: ["x"], cwd: "/tmp", env: { A: "1", B: "2" } };
    const orderB = { env: { B: "2", A: "1" }, cwd: "/tmp", args: ["x"], command: "node" };
    assert.equal(hashPoolConfig(orderA), hashPoolConfig(orderB), "identical values in different key order must hash the same");
    console.log("  7. hashPoolConfig hashes nested values (env credentials included), not just top-level key names");
  }

  // ── 8 ────────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("mcp-pool-dead-attachment");
    let db;
    try {
      db = openDb({ stateDir });
      const pool = createMcpPool({ db, logger: quiet });

      const a = await pool.attach("dead-attachment", LONG_LIVED);
      const firstPid = getPool(db, a.poolId).pid;
      assert.ok(isPidAlive(firstPid), "precondition: the first spawned process must be alive");

      // Kill it OUTSIDE pool.detach() — the exact scenario the review's repro describes (a crash, or a
      // signal from outside this manager), not a normal detach-triggered teardown.
      process.kill(firstPid, "SIGKILL");
      const deadline = Date.now() + 5000;
      while (getPool(db, a.poolId).status !== "failed") {
        if (Date.now() > deadline) throw new Error("pool row never reached 'failed' after the child was killed");
        await new Promise((r) => setTimeout(r, 20));
      }

      // Before the fix, the attachment row would still show `detached_at IS NULL` here.
      const staleAttachment = db.prepare(`SELECT detached_at FROM mcp_pool_attachments WHERE id = ?`).get(a.attachmentId);
      assert.notEqual(staleAttachment.detached_at, null, "markPoolFailed must have closed the stale attachment atomically");

      // A fresh attach resurrects the SAME pool row (a real new process) — proving the resurrection
      // path itself is unaffected by this fix.
      const b = await pool.attach("dead-attachment", LONG_LIVED);
      assert.equal(b.poolId, a.poolId, "the resurrection must reuse the same pool row identity");
      assert.equal(b.spawned, true, "the dead pool must be respawned, not joined");
      const secondPid = getPool(db, b.poolId).pid;
      assert.ok(isPidAlive(secondPid), "the replacement process must be alive");
      assert.notEqual(secondPid, firstPid, "the replacement must be a genuinely different OS process");

      // The bug: the replacement's OWN detach must trigger teardown. Before the fix, the stale
      // attachment kept `liveAttachmentCount` above zero forever, so `shouldTeardown` never fired and
      // the replacement process leaked indefinitely.
      const detachB = await pool.detach(b.attachmentId);
      assert.equal(detachB.shouldTeardown, true, "the replacement's own last detach must trigger teardown, not be blocked by the stale attachment");
      assert.ok(await isReallyDead(secondPid), "the replacement process must actually be killed");
      console.log("  8. a dead process's stale attachment no longer blocks the replacement's own teardown");
    } finally {
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 9 ────────────────────────────────────────────────────────────────────────────────
  // review-sol-2026-09-13.md finding 1 (critical): boot reconciliation used to verify only pid+pgid
  // before killing a pool's process group. Simulate the pid-reuse case directly: a real, live process
  // recorded with a DELIBERATELY WRONG `lstart` (as pid reuse would produce — same pid/pgid, different
  // actual start time) must be left alone, not killed on a guess.
  {
    const stateDir = makeScratchDir("mcp-pool-reconcile-lstart");
    let db;
    let unrelated;
    try {
      db = openDb({ stateDir });

      unrelated = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { detached: true, stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 100));
      const realInfo = await readProcInfo(unrelated.pid);
      assert.ok(realInfo.alive, "precondition: the unrelated process must actually be alive");

      const claim = claimPoolSlot(db, { name: "reused-pid-target", configHash: "z" });
      // Record the REAL pid/pgid but a start time that does not match — the pid-reuse signature.
      markPoolReady(db, claim.pool.id, { pid: unrelated.pid, pgid: realInfo.pgid, lstart: "Mon Jan  1 00:00:00 2000" });

      const freshManager = createMcpPool({ db, logger: quiet });
      const results = await freshManager.reconcileOnBoot();

      assert.equal(getPool(db, claim.pool.id).status, "failed", "the stale row must still be marked failed");
      assert.ok(isPidAlive(unrelated.pid), "the unrelated live process must NOT be killed on a pid/pgid match alone — lstart disagreed");
      const result = results.find((r) => r.poolId === claim.pool.id);
      assert.match(result.reason, /start-time mismatch/, "the refusal reason must name the actual mismatch, not just 'failed'");
      console.log("  9. boot reconciliation refuses to kill a live process whose recorded start time does not match (pid-reuse guard)");
    } finally {
      try { if (unrelated) process.kill(-unrelated.pid, "SIGKILL"); } catch { /* already gone */ }
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 10 ───────────────────────────────────────────────────────────────────────────────
  // review-sol-2026-09-13.md finding 14: attachToPool used to consider a 'starting' row joinable, so a
  // second caller could be told "attached" before spawn had even finished — and before pid/pgid/lstart
  // were verified at all. Only 'ready' may be joined now.
  {
    const stateDir = makeScratchDir("mcp-pool-attach-starting");
    let db;
    try {
      db = openDb({ stateDir });
      const claim = claimPoolSlot(db, { name: "still-starting", configHash: "s" });
      assert.equal(getPool(db, claim.pool.id).status, "starting");
      const attempt = attachToPool(db, { name: "still-starting", configHash: "s" });
      assert.equal(attempt.attached, false, "a 'starting' row must not be joinable — only 'ready' is");
      assert.match(attempt.reason, /starting/);
      console.log("  10. attachToPool refuses to join a 'starting' row (only 'ready' is joinable)");
    } finally {
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 11 ───────────────────────────────────────────────────────────────────────────────
  // review-sol-2026-09-13.md finding 22 (shutdown half): `runtime/supervisor.js`'s `shutdown()` used to
  // dispose harness adapters but never touch the MCP pool manager at all, leaving a real pooled process
  // running after the daemon exited. `disposeAll()` (new) is what `shutdown()` now calls before
  // `closeDb()`; this proves the primitive itself kills every live pooled process and marks each row
  // `stopped`, real spawn + real kill, no mocking.
  {
    const stateDir = makeScratchDir("mcp-pool-dispose-all");
    let db;
    try {
      db = openDb({ stateDir });
      const pool = createMcpPool({ db, logger: quiet });

      const a = await pool.attach("dispose-all-a", LONG_LIVED);
      const b = await pool.attach("dispose-all-b", { command: process.execPath, args: ["-e", SOCKET_SERVER_SCRIPT] });
      const pidA = getPool(db, a.poolId).pid;
      const pidB = getPool(db, b.poolId).pid;
      assert.ok(isPidAlive(pidA) && isPidAlive(pidB), "precondition: both real pooled processes are alive");

      const results = await pool.disposeAll();
      assert.equal(results.length, 2, `disposeAll must report one result per live pool; got ${JSON.stringify(results)}`);
      assert.ok(results.every((r) => r.killed === true), `every process must be confirmed killed; got ${JSON.stringify(results)}`);
      assert.ok(await isReallyDead(pidA), "the first pooled process must actually be dead");
      assert.ok(await isReallyDead(pidB), "the second pooled process must actually be dead");
      assert.equal(getPool(db, a.poolId).status, "stopped");
      assert.equal(getPool(db, b.poolId).status, "stopped");
      assert.equal(pool._liveChildren.size, 0, "no leaked in-memory child handles after disposeAll");
      console.log("  11. disposeAll() kills every live pooled process for real and marks each row stopped — this is what shutdown() now calls before closeDb()");
    } finally {
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 12 ───────────────────────────────────────────────────────────────────────────
  // review-consolidated-2026-09-14.md finding 5: `fs.existsSync` alone is not proof of a live listening
  // socket. Two real reproductions: (a) a server that binds a real socket then exits immediately — the
  // file exists, but nothing is listening; (b) a "server" that writes a REGULAR FILE at the socket path
  // and stays alive — `existsSync` is true, but it is not a socket at all. Both must make `attach()`
  // fail loudly (never publish `ready` for an unusable endpoint), not silently succeed.
  {
    const stateDir = makeScratchDir("mcp-pool-dead-readiness");
    let db;
    try {
      db = openDb({ stateDir });
      const pool = createMcpPool({ db, logger: quiet });

      // (a) bind-then-exit
      const bindThenExit = {
        command: process.execPath,
        args: ["-e", "require('net').createServer(()=>{}).listen(process.env.LEO_MCP_SOCKET_PATH, () => process.exit(7))"],
      };
      await assert.rejects(
        pool.attach("bind-then-exit", bindThenExit),
        /never became connectable|exited/,
        "a server that binds its socket then exits must never be published as ready",
      );
      const deadRow = db.prepare(`SELECT status FROM mcp_pool WHERE name = 'bind-then-exit'`).get();
      assert.notEqual(deadRow.status, "ready", "the row for a bind-then-exit server must never reach 'ready'");
      console.log("  12a. a server that binds its socket then exits immediately never gets published as ready");

      // (b) regular file at the socket path, process stays alive
      const regularFile = {
        command: process.execPath,
        args: ["-e", "require('fs').writeFileSync(process.env.LEO_MCP_SOCKET_PATH, 'not a socket'); setInterval(() => {}, 60000)"],
      };
      await assert.rejects(
        pool.attach("regular-file-not-socket", regularFile),
        /never became connectable|exited/,
        "a regular file at the socket path (not a real socket) must never be published as ready",
      );
      const fileRow = db.prepare(`SELECT status FROM mcp_pool WHERE name = 'regular-file-not-socket'`).get();
      assert.notEqual(fileRow.status, "ready", "the row for a regular-file endpoint must never reach 'ready'");
      console.log("  12b. a regular file sitting at the socket path (not a real socket) never gets published as ready either");
    } finally {
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 13 ───────────────────────────────────────────────────────────────────────────
  // review-consolidated-2026-09-14.md finding 6: a LOSER's own wait budget used to be far shorter than
  // the WINNER's real spawn budget (~1s vs ~7s) — a perfectly healthy pooled server that legitimately
  // takes a couple of seconds to bind would still make every concurrent loser time out and proceed with
  // no MCP tool at all. A real delayed-bind socket server proves the loser now waits long enough.
  {
    const stateDir = makeScratchDir("mcp-pool-delayed-bind-concurrency");
    let db;
    try {
      db = openDb({ stateDir });
      const pool = createMcpPool({ db, logger: quiet });
      const delayedBind = {
        command: process.execPath,
        args: ["-e", "setTimeout(() => require('net').createServer(() => {}).listen(process.env.LEO_MCP_SOCKET_PATH, () => setInterval(() => {}, 60000)), 2000)"],
      };
      const [a, b] = await Promise.all([
        pool.attach("delayed-bind", delayedBind),
        pool.attach("delayed-bind", delayedBind),
      ]);
      assert.equal(a.poolId, b.poolId, "both concurrent attachers must land on the same pool row");
      assert.ok(a.spawned !== b.spawned, "exactly one of the two must have been the spawner, the other a joiner");
      const finalPool = getPool(db, a.poolId);
      assert.equal(finalPool.status, "ready", `expected the delayed-bind server to eventually be marked ready, got ${JSON.stringify(finalPool)}`);
      console.log("  13. a concurrent LOSER now waits long enough for a real, legitimately slow (~2s) bind to succeed, instead of timing out at ~1s");
    } finally {
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }
});
