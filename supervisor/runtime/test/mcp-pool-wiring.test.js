// mcp-pool-wiring.test.js — closing PLAN.md §21.1/§21.2's deferred gap, 2026-09-11: a utility-task-lane
// role (§16.2) that declares an MCP need now actually attaches through `runtime/mcp-pool.js` when its
// run starts, and detaches when it ends. Real spawn (the fake harness spawns a real detached process,
// same as every other test in this file's siblings), real pool config (`leo-mcp`, resolved via
// `config/mcp-pools.js` to the real sibling repo checked out on this machine — skipped, not failed, if
// that directory doesn't exist, since it's an external sibling repo this test cannot assume every
// checkout has).
//
// Cases:
//   1. a git-push-runner run's spec gets a real mcp_pool + mcp_pool_attachments row after start()
//      returns, but no spec.mcpConfig — the fake harness here declares no mcpConfigDelivery, same as
//      every OTHER test in this file, so bookkeeping-only is the CORRECT behavior, not a gap
//   2. ending that run detaches the attachment (detached_at set)
//   3. a coder run's spec is completely unaffected — no mcpConfig, no attachment
//   4. two CONCURRENT git-push-runner starts share exactly one pool row (real concurrency)
//   5. a run reconciled to "lost" at boot has its attachment detached too
//   6. an adapter.start() throw (before a runId exists) still detaches whatever was attached —
//      fixed 2026-09-11 (`codexdoc/review-luna-2026-09-11.md` finding 4)
//   7. a harness that DOES declare mcpConfigDelivery gets a real spec.mcpConfig — the exact JSON schema
//      measured against the installed `claude` CLI, naming `mcp-stdio-proxy.js` and a real, live
//      socketPath — and that proxy, spawned for real with those exact args, actually round-trips a
//      JSON-RPC request through the real pooled leo-mcp process end to end (review-sol-2026-09-13.md
//      finding 13)

import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import {
  openDb, closeDb, upsertHarness, createTask, createWorker, createRun, recordRunProcess, getRun,
  claimPoolSlot, markPoolReady, attachToPool,
} from "../../db/index.js";
import { createSupervisor, MCP_STDIO_PROXY_PATH } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";
import { BUILT_IN_DEFAULTS } from "../../config/mcp-pools.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };
const LEO_MCP_AVAILABLE = fs.existsSync(BUILT_IN_DEFAULTS.pools["leo-mcp"].cwd);

if (!LEO_MCP_AVAILABLE) {
  console.log("SKIP: mcp-pool wiring (leo-mcp sibling repo not present on this checkout)");
  process.exit(0);
}

async function waitUntilDetached(db, where, args) {
  const deadline = Date.now() + 5000;
  let row;
  do {
    row = db.prepare(where).get(...args);
    if (row?.detached_at) break;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < deadline);
  return row;
}

await runTest("mcp-pool wiring", async () => {
  // ── 1, 2, 3 ────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("supervisor-mcp-pool-wiring");
    let db;
    let supervisor;
    try {
      db = openDb({ stateDir });
      upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
      createTask(db, { id: "t1", title: "utility task", type: "git-push-task" });
      createWorker(db, { workerId: "w-git", nickname: "git-1", role: "git-push-runner", taskId: "t1" });
      createWorker(db, { workerId: "w-coder", nickname: "coder-1", role: "coder", taskId: "t1" });

      const harness = createFakeHarness({ label: "mcp-pool-wiring" });
      supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askSweepIntervalMs: 0 });
      await supervisor.boot();

      const started = await supervisor.start({ harnessId: "fake", workerId: "w-git", spec: { cwd: stateDir, prompt: "push" } });
      const runId1 = started.runId;
      const child = harness._runs.get(runId1);
      // Corrected 2026-09-11 (`codexdoc/review-luna-2026-09-11.md` finding 2): `spec.mcpConfig` is a
      // real adapter contract (`string | string[]`, a config FILE PATH the adapter itself spawns) —
      // handing it the pool-attachment marker object used to push a non-string into a real adapter's
      // spawn argv. The attach/detach LIFECYCLE is still real and tested below; `spec` itself must be
      // completely unaffected until a real, measured `--mcp-config` value exists to put there.
      assert.equal(child.spec?.mcpConfig, undefined, "spec.mcpConfig must NOT be set — no real adapter-consumable config value exists yet");

      const pool = db.prepare(`SELECT * FROM mcp_pool WHERE name = 'leo-mcp'`).get();
      assert.ok(pool, "a real mcp_pool row must exist for leo-mcp");
      assert.equal(pool.status, "ready");
      assert.ok(pool.socket_path && fs.existsSync(pool.socket_path), "the pool row's own socket must be real and actually exist on disk");
      const attachment = db.prepare(`SELECT * FROM mcp_pool_attachments WHERE pool_id = ?`).get(pool.id);
      assert.ok(attachment, "a real attachment row must exist");
      assert.equal(attachment.run_id, runId1, "the attachment must be backfilled with the real runId");
      assert.equal(attachment.detached_at, null, "still attached while the run is live");
      console.log("  1. a git-push-runner run attaches to a real pool+attachment row with a real socket, but spec.mcpConfig is NOT set — this harness declares no mcpConfigDelivery");

      await supervisor.stop(runId1);
      const after = await waitUntilDetached(db, `SELECT * FROM mcp_pool_attachments WHERE run_id = ?`, [runId1]);
      assert.ok(after?.detached_at, "ending the run must detach its mcp-pool attachment");
      console.log("  2. ending the run detaches its attachment");

      const startedCoder = await supervisor.start({ harnessId: "fake", workerId: "w-coder", spec: { cwd: stateDir, prompt: "code" } });
      const coderChild = harness._runs.get(startedCoder.runId);
      assert.equal(coderChild.spec?.mcpConfig, undefined, "a coder run's spec must be completely unaffected");
      await supervisor.stop(startedCoder.runId);
      console.log("  3. a non-utility-task role's spec is untouched — no mcpConfig, no attachment");
    } finally {
      try { await supervisor?.shutdown?.({ timeoutMs: 3000 }); } catch { /* best-effort */ }
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 4 ────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("supervisor-mcp-pool-concurrency");
    let db;
    let supervisor;
    try {
      db = openDb({ stateDir });
      upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
      createTask(db, { id: "t1", title: "concurrent utility tasks", type: "git-push-task" });
      createWorker(db, { workerId: "w-a", nickname: "a", role: "git-push-runner", taskId: "t1" });
      createWorker(db, { workerId: "w-b", nickname: "b", role: "git-push-runner", taskId: "t1" });

      const harness = createFakeHarness({ label: "mcp-pool-concurrency" });
      supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askSweepIntervalMs: 0 });
      await supervisor.boot();

      const [a, b] = await Promise.all([
        supervisor.start({ harnessId: "fake", workerId: "w-a", spec: { cwd: stateDir, prompt: "push a" } }),
        supervisor.start({ harnessId: "fake", workerId: "w-b", spec: { cwd: stateDir, prompt: "push b" } }),
      ]);
      const pools = db.prepare(`SELECT * FROM mcp_pool WHERE name = 'leo-mcp'`).all();
      assert.equal(pools.length, 1, "two concurrent attachers of the SAME config must share one pool row");
      const attachments = db.prepare(`SELECT * FROM mcp_pool_attachments WHERE pool_id = ? AND detached_at IS NULL`).all(pools[0].id);
      assert.equal(attachments.length, 2, "and each gets its own attachment row");
      const runIds = new Set(attachments.map((r) => r.run_id));
      assert.deepEqual([...runIds].sort(), [a.runId, b.runId].sort());
      console.log("  4. two concurrent git-push-runner starts share exactly one pool row, two attachments");

      await supervisor.stop(a.runId);
      await supervisor.stop(b.runId);
    } finally {
      try { await supervisor?.shutdown?.({ timeoutMs: 3000 }); } catch { /* best-effort */ }
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 5 ────────────────────────────────────────────────────────────────────────────
  // No real spawn here, deliberately — same technique `runtime/test/reconcile.test.js`'s own case 5
  // ("no recorded identity => lost") uses: a `runs` row with NO process identity ever recorded is
  // unconditionally classified `lost` on boot, no OS-liveness check needed. That gives a
  // deterministic "lost" outcome to test the ATTACHMENT cleanup against, instead of racing a real
  // process's death against this supervisor's own pump noticing it first (which a full
  // start()-then-kill sequence cannot avoid within one process — the pump and the process share this
  // test's own event loop).
  {
    const stateDir = makeScratchDir("supervisor-mcp-pool-lost");
    let db;
    let supervisor;
    try {
      db = openDb({ stateDir });
      upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
      createTask(db, { id: "t1", title: "will be lost", type: "git-push-task" });
      createWorker(db, { workerId: "w-git", nickname: "git-1", role: "git-push-runner", taskId: "t1" });

      const runId = "run-lost-1";
      createRun(db, { runId, workerId: "w-git", harnessId: "fake", prompt: "never actually spawned" });
      // Manually build the pool + attachment rows `start()` would have built, bypassing the real
      // spawn — this case is about the RECONCILIATION-triggers-detach wiring, not attach itself
      // (already proven for real in case 1).
      const claim = claimPoolSlot(db, { name: "leo-mcp", configHash: "test-hash-lost" });
      markPoolReady(db, claim.pool.id, { pid: 999999, pgid: 999999, socketPath: null });
      const joined = attachToPool(db, { name: "leo-mcp", configHash: "test-hash-lost", runId });
      assert.equal(joined.attached, true);

      const harness = createFakeHarness({ label: "mcp-pool-lost" });
      supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askSweepIntervalMs: 0 });
      const bootResult = await supervisor.boot();
      assert.deepEqual(bootResult.reconciliation.lost, [runId], "a run with no recorded process identity must be classified lost");

      const after = await waitUntilDetached(db, `SELECT * FROM mcp_pool_attachments WHERE id = ?`, [joined.attachmentId]);
      assert.ok(after?.detached_at, "a run reconciled to lost must have its mcp-pool attachment detached");
      console.log("  5. a lost run's attachment is detached by boot reconciliation");
    } finally {
      try { await supervisor?.shutdown?.({ timeoutMs: 3000 }); } catch { /* best-effort */ }
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 6 ────────────────────────────────────────────────────────────────────────────
  {
    const stateDir = makeScratchDir("supervisor-mcp-pool-start-throws");
    let db;
    let supervisor;
    try {
      db = openDb({ stateDir });
      upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
      createTask(db, { id: "t1", title: "adapter start fails", type: "git-push-task" });
      createWorker(db, { workerId: "w-git", nickname: "git-1", role: "git-push-runner", taskId: "t1" });

      const harness = createFakeHarness({ label: "mcp-pool-start-throws" });
      // A real MCP attach happens BEFORE this call, inside `start()` — this fake makes the adapter
      // itself fail afterward, so the attachment is made against a real pooled process but no run
      // (and no runId) ever exists to own it.
      harness.start = async () => { throw new Error("adapter.start() deliberately fails for this test"); };
      supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askSweepIntervalMs: 0 });
      await supervisor.boot();

      await assert.rejects(
        supervisor.start({ harnessId: "fake", workerId: "w-git", spec: { cwd: stateDir, prompt: "push" } }),
        /adapter.start\(\) deliberately fails/,
      );

      const pool = db.prepare(`SELECT * FROM mcp_pool WHERE name = 'leo-mcp'`).get();
      assert.ok(pool, "the pool row must exist — attach happened before the throw");
      const attachment = await waitUntilDetached(db, `SELECT * FROM mcp_pool_attachments WHERE pool_id = ?`, [pool.id]);
      assert.ok(attachment, "an attachment row must have been created before the throw");
      assert.ok(attachment.detached_at, "adapter.start() throwing must still detach the pre-run-ID attachment, not leak it");
      assert.equal(attachment.run_id, null, "this attachment never got a runId — createRun was never reached");

      // The catch path's detach is fire-and-forget (`mcpPool.detach(...).catch(...)`, matching the
      // existing createRun-failure path's own convention) — its real process kill, and the spawned
      // child's OWN async 'exit' handler (a separate code path in `mcp-pool.js`'s `spawnOne`), can both
      // still be settling after `attachment.detached_at` is already visible. Found under full-suite
      // load, not standalone: `closeDb()` in this case's own `finally` could race one of those trailing
      // async writes, producing "TypeError: The database connection is not open" from a handler that
      // fires after teardown. Wait for the pool to reach a terminal status before letting `finally`
      // close the database, so this test doesn't itself become the process-lifecycle race this whole
      // project is careful about elsewhere.
      const deadline = Date.now() + 5000;
      while (!["stopped", "failed"].includes(db.prepare(`SELECT status FROM mcp_pool WHERE id = ?`).get(pool.id)?.status)) {
        if (Date.now() > deadline) throw new Error("pool never reached a terminal status after the attach-then-throw teardown");
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 200)); // let any trailing exit-handler write settle too
      console.log("  6. adapter.start() throwing before a runId exists still detaches the attachment made just before it");
    } finally {
      try { await supervisor?.shutdown?.({ timeoutMs: 3000 }); } catch { /* best-effort */ }
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }

  // ── 7 ────────────────────────────────────────────────────────────────────────────
  // review-sol-2026-09-13.md finding 13, the real end-to-end proof. Every case above uses the SAME fake
  // harness every other test in this file's siblings uses — `mcpConfigDelivery: false` by default,
  // matching every caller's assumption before this fix. This case is the one that turns that on, so
  // `start()`'s new mcpConfig-building logic is proven against a REAL spec, not just read from a diff.
  {
    const stateDir = makeScratchDir("supervisor-mcp-pool-real-delivery");
    let db;
    let supervisor;
    let proxy;
    try {
      db = openDb({ stateDir });
      upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
      createTask(db, { id: "t1", title: "real mcp delivery", type: "git-push-task" });
      createWorker(db, { workerId: "w-git", nickname: "git-1", role: "git-push-runner", taskId: "t1" });

      const harness = createFakeHarness({ label: "mcp-pool-real-delivery", mcpConfigDelivery: "file-or-json-string" });
      supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askSweepIntervalMs: 0 });
      await supervisor.boot();

      const started = await supervisor.start({ harnessId: "fake", workerId: "w-git", spec: { cwd: stateDir, prompt: "push" } });
      const child = harness._runs.get(started.runId);

      // The exact JSON schema measured against the installed `claude` CLI (`claude mcp add-json --help`):
      // a real JSON string, `{ mcpServers: { <name>: { command, args } } }`.
      assert.ok(Array.isArray(child.spec?.mcpConfig) && child.spec.mcpConfig.length === 1,
        `expected spec.mcpConfig to be a one-entry array, got ${JSON.stringify(child.spec?.mcpConfig)}`);
      const parsed = JSON.parse(child.spec.mcpConfig[0]);
      assert.ok(parsed.mcpServers?.["leo-mcp"], `expected an mcpServers.leo-mcp entry, got ${JSON.stringify(parsed)}`);
      const entry = parsed.mcpServers["leo-mcp"];
      assert.equal(entry.command, process.execPath);
      assert.deepEqual(entry.args.slice(0, 2), [MCP_STDIO_PROXY_PATH, "--socket"]);
      const socketPath = entry.args[2];
      assert.ok(fs.existsSync(socketPath), "the socketPath named in spec.mcpConfig must be a real, live socket");
      console.log("  7a. a harness declaring mcpConfigDelivery gets a real spec.mcpConfig naming mcp-stdio-proxy.js and a live socketPath");

      // Spawn the proxy with EXACTLY the args start() built, and prove the whole chain end to end: the
      // proxy really connects to the real pooled leo-mcp process and a real JSON-RPC request round-trips
      // through it — not a mock of any of these pieces.
      proxy = spawnChild(entry.command, entry.args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdoutBuf = "";
      proxy.stdout.on("data", (c) => { stdoutBuf += c.toString("utf8"); });
      let stderrBuf = "";
      proxy.stderr.on("data", (c) => { stderrBuf += c.toString("utf8"); });
      proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })}\n`);
      const deadline = Date.now() + 10_000;
      while (!stdoutBuf.includes('"id":1') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.match(stdoutBuf, /"id":1/,
        `expected a real JSON-RPC response to round-trip through the proxy to the real pooled leo-mcp process within 10s; stdout so far: ${JSON.stringify(stdoutBuf)}, stderr: ${JSON.stringify(stderrBuf)}`);
      const response = JSON.parse(stdoutBuf.trim().split("\n")[0]);
      assert.ok(response.result?.tools, `expected a real tools/list result, got ${JSON.stringify(response)}`);
      console.log("  7b. that exact command+args, spawned for real, round-trips a real JSON-RPC request through the real pooled leo-mcp process");

      await supervisor.stop(started.runId);
    } finally {
      try { proxy?.stdin?.end(); } catch { /* best effort */ }
      try { await supervisor?.shutdown?.({ timeoutMs: 3000 }); } catch { /* best-effort */ }
      try { closeDb(db); } catch { /* already closed */ }
      rmScratchDir(stateDir);
    }
  }
});
