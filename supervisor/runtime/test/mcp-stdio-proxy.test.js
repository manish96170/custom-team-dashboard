// mcp-stdio-proxy.test.js — review-sol-2026-09-13.md finding 13: `mcp-stdio-proxy.js` is the ONLY new
// piece of code that fix introduced (everything else is wiring) — it is what a harness's `--mcp-config`
// actually spawns, so it has to be proven directly, against a REAL Unix socket server, not assumed
// correct because the surrounding wiring compiles.
//
// No leo-mcp dependency here on purpose: the proxy relays raw bytes both ways (or filters real JSON-RPC
// frames, once `--allow-tools` is set) and never implements the protocol, so a tiny throwaway socket
// server in THIS file is enough to prove the mechanism — the same "prove the mechanism with a real OS
// resource, not a mock" rule `worktree.test.js`'s own header states for git.
//
// Cases:
//   1. a real line written to the proxy's stdin arrives, byte-for-byte, out the socket server's side
//   2. a real line written by the socket server arrives, byte-for-byte, out the proxy's stdout
//   3. closing the proxy's stdin ends the socket connection (the far end sees a clean close)
//   4. no --socket flag: the proxy exits non-zero with a clear stderr message, never hangs
//   5. --socket pointing at nothing (no listener): the proxy exits non-zero rather than hanging forever
//   6. review-consolidated-2026-09-14.md finding 1: --allow-tools filters a real tools/list response
//      down to only the allowed names, without touching any other field
//   7. --allow-tools refuses a disallowed tools/call directly — a real JSON-RPC error carrying the
//      caller's own request id — and the disallowed call NEVER reaches the real server at all
//   8. --allow-tools still relays an ALLOWED tools/call straight through, unmodified
//   9. with no --allow-tools at all, tools/list is relayed completely unfiltered (backward compat)

import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_SCRIPT = path.join(__dirname, "..", "mcp-stdio-proxy.js");

function waitForEvent(emitter, event, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (...args) => { clearTimeout(timer); resolve(args); });
  });
}

// review-consolidated-2026-09-14.md finding 10: the old version of this file polled with a bare
// `setInterval` and no deadline or rejection path for exactly this "wait until some buffer contains a
// substring" need — a transport regression that connects but stops forwarding one direction left that
// promise pending forever, so `finally` never ran and a real proxy/socket kept the whole `npm test` run
// alive. This helper is the same shape as this file's own `waitForEvent`: a real timer, a real
// rejection, always cleared.
function waitForBuffer(getBuffer, predicate, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = setInterval(() => {
      if (predicate(getBuffer())) { clearInterval(check); resolve(getBuffer()); return; }
      if (Date.now() > deadline) { clearInterval(check); reject(new Error(`timed out waiting for buffer condition; last value: ${JSON.stringify(getBuffer())}`)); }
    }, 10);
  });
}

await runTest("mcp-stdio-proxy", async () => {
  const stateDir = makeScratchDir("supervisor-mcp-stdio-proxy-test");
  const socketPath = path.join(stateDir, "test.sock");

  let server;
  let serverSocket;
  const serverConnections = [];
  const spawnedProxies = [];
  function spawnProxy(args) {
    const p = spawn(process.execPath, [PROXY_SCRIPT, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    spawnedProxies.push(p);
    return p;
  }

  try {
    server = net.createServer((socket) => { serverConnections.push(socket); });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    // ── 1 & 2 ────────────────────────────────────────────────────────────────────────────
    let proxy = spawnProxy(["--socket", socketPath]);
    [serverSocket] = await waitForEvent(server, "connection");

    let stdoutBuf = "";
    proxy.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString("utf8"); });
    let serverBuf = "";
    serverSocket.on("data", (chunk) => { serverBuf += chunk.toString("utf8"); });

    proxy.stdin.write('{"jsonrpc":"2.0","method":"tools/list","id":1}\n');
    await waitForBuffer(() => serverBuf, (b) => b.includes("tools/list"));
    assert.equal(serverBuf, '{"jsonrpc":"2.0","method":"tools/list","id":1}\n',
      "the exact bytes written to the proxy's stdin must arrive at the real socket server, unmodified");
    console.log("  1. a real line written to the proxy's stdin arrives, byte-for-byte, out the socket server's side");

    serverSocket.write('{"jsonrpc":"2.0","result":{"tools":[]},"id":1}\n');
    await waitForBuffer(() => stdoutBuf, (b) => b.includes("result"));
    assert.equal(stdoutBuf, '{"jsonrpc":"2.0","result":{"tools":[]},"id":1}\n',
      "the exact bytes written by the real socket server must arrive at the proxy's stdout, unmodified");
    console.log("  2. a real line written by the socket server arrives, byte-for-byte, out the proxy's stdout");

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    const closed = waitForEvent(serverSocket, "close");
    const exited = waitForEvent(proxy, "exit");
    proxy.stdin.end();
    await closed;
    const [exitCode] = await exited;
    assert.equal(exitCode, 0, "the proxy must exit cleanly (0) once its stdin ends and the socket closes");
    console.log("  3. closing the proxy's stdin ends the socket connection, and the proxy exits cleanly");

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    {
      const noFlag = spawnProxy([]);
      let stderrBuf = "";
      noFlag.stderr.on("data", (c) => { stderrBuf += c.toString("utf8"); });
      const [code] = await waitForEvent(noFlag, "exit");
      assert.notEqual(code, 0, "missing --socket must exit non-zero, not hang or silently succeed");
      assert.match(stderrBuf, /--socket/, "the failure must name what was missing, not fail silently");
      console.log("  4. no --socket flag: the proxy exits non-zero with a clear stderr message, never hangs");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    {
      const deadSocketPath = path.join(stateDir, "nothing-here.sock");
      const deadProxy = spawnProxy(["--socket", deadSocketPath]);
      const [code] = await waitForEvent(deadProxy, "exit", { timeoutMs: 5000 });
      assert.notEqual(code, 0, "a socket path with no real listener must exit non-zero rather than hang forever");
      console.log("  5. --socket pointing at nothing: the proxy exits non-zero rather than hanging forever");
    }

    // ── 6, 7, 8 ────────────────────────────────────────────────────────────────────────────
    // review-consolidated-2026-09-14.md finding 1: a fresh proxy+server pair, WITH --allow-tools set,
    // proving the actual protocol-aware filtering — not just that flag parsing accepts the option.
    {
      const filteredProxy = spawnProxy(["--socket", socketPath, "--allow-tools", "git_push,jira_create_ticket"]);
      const [filteredServerSocket] = await waitForEvent(server, "connection");
      let fStdout = "";
      filteredProxy.stdout.on("data", (c) => { fStdout += c.toString("utf8"); });
      let fServerBuf = "";
      filteredServerSocket.on("data", (c) => { fServerBuf += c.toString("utf8"); });

      // 6: tools/list response filtering — the real server advertises 4 tools, only 2 are allowed.
      filteredProxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 100 })}\n`);
      await waitForBuffer(() => fServerBuf, (b) => b.includes("tools/list"));
      filteredServerSocket.write(`${JSON.stringify({
        jsonrpc: "2.0", id: 100,
        result: { tools: [{ name: "git_push" }, { name: "jira_create_ticket" }, { name: "slack_delete_message" }, { name: "jira_transition" }] },
      })}\n`);
      await waitForBuffer(() => fStdout, (b) => b.includes('"id":100'));
      const listResponse = JSON.parse(fStdout.trim().split("\n").find((l) => l.includes('"id":100')));
      assert.deepEqual(
        listResponse.result.tools.map((t) => t.name).sort(),
        ["git_push", "jira_create_ticket"],
        `expected tools/list to be filtered to only the allowed names, got ${JSON.stringify(listResponse.result.tools)}`,
      );
      console.log("  6. --allow-tools filters a real tools/list response down to only the allowed names");

      // 7: a disallowed tools/call must be refused directly, by the proxy, and must NEVER reach the
      // real server — the server buffer must not grow at all for this specific call.
      const serverBufBeforeDisallowedCall = fServerBuf;
      filteredProxy.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0", method: "tools/call", id: 101, params: { name: "slack_delete_message", arguments: {} },
      })}\n`);
      await waitForBuffer(() => fStdout, (b) => b.includes('"id":101'));
      const refusal = JSON.parse(fStdout.trim().split("\n").find((l) => l.includes('"id":101')));
      assert.ok(refusal.error, `expected a JSON-RPC error for a disallowed tool, got ${JSON.stringify(refusal)}`);
      assert.equal(refusal.id, 101);
      assert.match(refusal.error.message, /slack_delete_message/);
      // Give any (incorrect) forward a moment to have arrived, then assert it never did.
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(fServerBuf, serverBufBeforeDisallowedCall,
        "a disallowed tools/call must never reach the real server at all — the server-side buffer must be unchanged");
      console.log("  7. --allow-tools refuses a disallowed tools/call directly, with the real server never seeing it");

      // 8: an ALLOWED tools/call must still go straight through, unmodified.
      filteredProxy.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0", method: "tools/call", id: 102, params: { name: "git_push", arguments: { cwd: "/tmp/x" } },
      })}\n`);
      await waitForBuffer(() => fServerBuf, (b) => b.includes('"id":102'));
      const forwardedCall = JSON.parse(fServerBuf.trim().split("\n").find((l) => l.includes('"id":102')));
      assert.equal(forwardedCall.params.name, "git_push");
      filteredServerSocket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 102, result: { ok: true } })}\n`);
      await waitForBuffer(() => fStdout, (b) => b.includes('"id":102') && b.includes('"ok":true'));
      console.log("  8. --allow-tools still relays an ALLOWED tools/call straight through, unmodified");

      const filteredExited = waitForEvent(filteredProxy, "exit");
      filteredProxy.stdin.end();
      filteredServerSocket.destroy();
      await filteredExited;
    }

    // ── 9 ────────────────────────────────────────────────────────────────────────────
    {
      const unfilteredProxy = spawnProxy(["--socket", socketPath]);
      const [unfilteredServerSocket] = await waitForEvent(server, "connection");
      let uStdout = "";
      unfilteredProxy.stdout.on("data", (c) => { uStdout += c.toString("utf8"); });
      unfilteredProxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 200 })}\n`);
      await new Promise((r) => setTimeout(r, 50));
      unfilteredServerSocket.write(`${JSON.stringify({
        jsonrpc: "2.0", id: 200, result: { tools: [{ name: "git_push" }, { name: "slack_delete_message" }] },
      })}\n`);
      await waitForBuffer(() => uStdout, (b) => b.includes('"id":200'));
      const unfilteredResponse = JSON.parse(uStdout.trim().split("\n").find((l) => l.includes('"id":200')));
      assert.equal(unfilteredResponse.result.tools.length, 2, "with no --allow-tools at all, nothing is filtered — full backward compatibility");
      console.log("  9. with no --allow-tools at all, tools/list is relayed completely unfiltered");
      const unfilteredExited = waitForEvent(unfilteredProxy, "exit");
      unfilteredProxy.stdin.end();
      unfilteredServerSocket.destroy();
      await unfilteredExited;
    }
  } finally {
    for (const p of spawnedProxies) {
      try { if (p.exitCode === null && !p.killed) p.kill("SIGKILL"); } catch { /* best effort */ }
    }
    try { serverSocket?.destroy(); } catch { /* best effort */ }
    for (const s of serverConnections) { try { s.destroy(); } catch { /* best effort */ } }
    try { await new Promise((r) => server?.close(r)); } catch { /* best effort */ }
    rmScratchDir(stateDir);
  }
});
