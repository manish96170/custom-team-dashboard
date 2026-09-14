// mcp-pool-wiring-fixture.test.js — review-consolidated-2026-09-14.md finding 9.
//
// `mcp-pool-wiring.test.js` is gated on the real `../leo-mcp` sibling repo being present, and skips
// EVERY case (including the only one that round-trips a real MCP tool call end to end) when it isn't
// — silently, with `npm test` still reporting the suite as passing. This file proves the EXACT SAME
// mechanism — `mcp-pool.js` spawning a socket-transport server, `attach()` returning a real, live
// `socketPath`, `start()` building the real `spec.mcpConfig` naming `mcp-stdio-proxy.js`, and that
// proxy round-tripping a real JSON-RPC request through the real pooled process end to end — against a
// repo-local fixture (`_fixture-mcp-socket-server.js`) instead of leo-mcp, so it runs and passes on ANY
// checkout, no sibling repo required.
//
// How the fixture stands in for `leo-mcp` without touching any of the real wiring code: `start()`
// resolves a role's declared pool config via `config/mcp-pools.js`'s `poolConfigFor('leo-mcp', {
// stateDir })`, which reads `<stateDir>/mcp-pools.json` if present — writing that file into this test's
// own scratch `stateDir`, naming the fixture script as the "leo-mcp" pool's spawn command, makes every
// real call site (`ROLE_MCP_NEEDS`, `attachMcpPoolsForRole`, `mcp-pool.js`'s `spawnOne`) run completely
// unchanged, spawning the fixture instead of the real server. No test-only branch anywhere in the real
// code.
//
// Cases:
//   1. a git-push-runner run gets a real spec.mcpConfig naming mcp-stdio-proxy.js and a live socketPath,
//      spawned against the FIXTURE server instead of leo-mcp
//   2. that exact command+args, spawned for real, round-trips a real tools/list through the fixture,
//      correctly bounded to git-push-runner's own allowlist (finding 1's mechanism, proven again here
//      independent of leo-mcp)
//   3. a disallowed tools/call (jira_create_ticket, not in git-push-runner's allowlist) is refused by
//      the proxy directly — never reaches the fixture at all

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnChild } from "node:child_process";
import { openDb, closeDb, upsertHarness, createTask, createWorker } from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SCRIPT = path.join(__dirname, "_fixture-mcp-socket-server.js");
const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

function waitForEvent(emitter, event, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (...args) => { clearTimeout(timer); resolve(args); });
  });
}

await runTest("mcp-pool wiring (sibling-independent fixture)", async () => {
  const stateDir = makeScratchDir("supervisor-mcp-pool-fixture");
  let db;
  let supervisor;
  let proxy;
  try {
    // Registers the fixture as the "leo-mcp" pool config for THIS test's stateDir only — the real
    // resolution path (`poolConfigFor`), not a mock of it.
    fs.writeFileSync(
      path.join(stateDir, "mcp-pools.json"),
      JSON.stringify({ pools: { "leo-mcp": { command: process.execPath, args: [FIXTURE_SCRIPT] } } }),
    );

    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createTask(db, { id: "t1", title: "fixture-backed MCP delivery", type: "git-push-task" });
    createWorker(db, { workerId: "w-git", nickname: "git-1", role: "git-push-runner", taskId: "t1" });

    const harness = createFakeHarness({ label: "mcp-pool-fixture", mcpConfigDelivery: "file-or-json-string" });
    supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askSweepIntervalMs: 0 });
    await supervisor.boot();

    const started = await supervisor.start({ harnessId: "fake", workerId: "w-git", spec: { cwd: stateDir, prompt: "push" } });
    const child = harness._runs.get(started.runId);

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    assert.ok(Array.isArray(child.spec?.mcpConfig) && child.spec.mcpConfig.length === 1,
      `expected spec.mcpConfig to be a one-entry array, got ${JSON.stringify(child.spec?.mcpConfig)}`);
    const parsed = JSON.parse(child.spec.mcpConfig[0]);
    const entry = parsed.mcpServers?.["leo-mcp"];
    assert.ok(entry, `expected an mcpServers.leo-mcp entry, got ${JSON.stringify(parsed)}`);
    assert.equal(entry.command, process.execPath);
    assert.match(entry.args[0], /mcp-stdio-proxy\.js$/, "the proxy, not the fixture, is what the harness is told to spawn");
    assert.equal(entry.args[1], "--socket");
    const socketPath = entry.args[2];
    assert.ok(fs.existsSync(socketPath), "the socketPath named in spec.mcpConfig must be real and live, spawned against the fixture");
    const pool = db.prepare(`SELECT * FROM mcp_pool WHERE name = 'leo-mcp'`).get();
    assert.equal(pool.socket_path, socketPath, "the pool row's own socket must match what was handed to the harness");
    console.log("  1. a git-push-runner run gets a real spec.mcpConfig naming mcp-stdio-proxy.js and a live socketPath, against the fixture server");

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    proxy = spawnChild(entry.command, entry.args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBuf = "";
    proxy.stdout.on("data", (c) => { stdoutBuf += c.toString("utf8"); });
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })}\n`);
    const deadline = Date.now() + 10_000;
    while (!stdoutBuf.includes('"id":1') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(stdoutBuf, /"id":1/,
      `expected a real tools/list response to round-trip through the proxy to the fixture within 10s; stdout: ${JSON.stringify(stdoutBuf)}`);
    const response = JSON.parse(stdoutBuf.trim().split("\n")[0]);
    assert.deepEqual(response.result?.tools?.map((t) => t.name), ["git_push"],
      "the fixture advertises 3 fake tools, but the response reaching the harness must already be bounded to git-push-runner's own allowlist");
    console.log("  2. that exact command+args, spawned for real, round-trips a real tools/list through the fixture, correctly bounded by finding 1's allowlist");

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    let stderrBuf = "";
    proxy.stderr.on("data", (c) => { stderrBuf += c.toString("utf8"); });
    stdoutBuf = "";
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 2, params: { name: "jira_create_ticket", arguments: {} } })}\n`);
    const deadline2 = Date.now() + 10_000;
    while (!stdoutBuf.includes('"id":2') && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const refusal = JSON.parse(stdoutBuf.trim().split("\n")[0]);
    assert.ok(refusal.error, `expected the disallowed tools/call to be refused directly by the proxy, got ${JSON.stringify(refusal)}`);
    assert.match(stderrBuf, /jira_create_ticket/, "the proxy's own stderr must name what it refused");
    console.log("  3. a disallowed tools/call is refused by the proxy directly — never reaches the fixture at all");

    await supervisor.stop(started.runId);
  } finally {
    try { proxy?.stdin?.end(); } catch { /* best effort */ }
    try { proxy?.kill("SIGKILL"); } catch { /* best effort */ }
    try { await supervisor?.shutdown?.({ timeoutMs: 3000 }); } catch { /* best-effort */ }
    try { closeDb(db); } catch { /* already closed */ }
    rmScratchDir(stateDir);
  }
});
