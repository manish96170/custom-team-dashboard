// mcp-stdio-proxy.test.js — review-sol-2026-09-13.md finding 13: `mcp-stdio-proxy.js` is the ONLY new
// piece of code this fix introduces (everything else is wiring) — it is what a harness's
// `--mcp-config` actually spawns, so it has to be proven directly, against a REAL Unix socket server,
// not assumed correct because the surrounding wiring compiles.
//
// No leo-mcp dependency here on purpose: the proxy relays raw bytes both ways and never parses the
// protocol, so a tiny throwaway echo-ish socket server in THIS file is enough to prove the mechanism —
// the same "prove the mechanism with a real OS resource, not a mock" rule `worktree.test.js`'s own
// header states for git.
//
// Cases:
//   1. a real line written to the proxy's stdin arrives, byte-for-byte, out the socket server's side
//   2. a real line written by the socket server arrives, byte-for-byte, out the proxy's stdout
//   3. closing the proxy's stdin ends the socket connection (the far end sees a clean close)
//   4. no --socket flag: the proxy exits non-zero with a clear stderr message, never hangs
//   5. --socket pointing at nothing (no listener): the proxy exits non-zero rather than hanging forever

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

await runTest("mcp-stdio-proxy", async () => {
  const stateDir = makeScratchDir("supervisor-mcp-stdio-proxy-test");
  const socketPath = path.join(stateDir, "test.sock");

  let server;
  let serverSocket;
  const serverConnections = [];
  try {
    server = net.createServer((socket) => { serverConnections.push(socket); });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    // ── 1 & 2 ────────────────────────────────────────────────────────────────────────────
    let proxy = spawn(process.execPath, [PROXY_SCRIPT, "--socket", socketPath], { stdio: ["pipe", "pipe", "pipe"] });
    [serverSocket] = await waitForEvent(server, "connection");

    let stdoutBuf = "";
    proxy.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString("utf8"); });
    let serverBuf = "";
    serverSocket.on("data", (chunk) => { serverBuf += chunk.toString("utf8"); });

    proxy.stdin.write('{"jsonrpc":"2.0","method":"tools/list","id":1}\n');
    await new Promise((resolve) => {
      const check = setInterval(() => { if (serverBuf.includes("tools/list")) { clearInterval(check); resolve(); } }, 10);
    });
    assert.equal(serverBuf, '{"jsonrpc":"2.0","method":"tools/list","id":1}\n',
      "the exact bytes written to the proxy's stdin must arrive at the real socket server, unmodified");
    console.log("  1. a real line written to the proxy's stdin arrives, byte-for-byte, out the socket server's side");

    serverSocket.write('{"jsonrpc":"2.0","result":{"tools":[]},"id":1}\n');
    await new Promise((resolve) => {
      const check = setInterval(() => { if (stdoutBuf.includes("result")) { clearInterval(check); resolve(); } }, 10);
    });
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
      const noFlag = spawn(process.execPath, [PROXY_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
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
      const deadProxy = spawn(process.execPath, [PROXY_SCRIPT, "--socket", deadSocketPath], { stdio: ["pipe", "pipe", "pipe"] });
      const [code] = await waitForEvent(deadProxy, "exit", { timeoutMs: 5000 });
      assert.notEqual(code, 0, "a socket path with no real listener must exit non-zero rather than hang forever");
      console.log("  5. --socket pointing at nothing: the proxy exits non-zero rather than hanging forever");
    }
  } finally {
    try { serverSocket?.destroy(); } catch { /* best effort */ }
    for (const s of serverConnections) { try { s.destroy(); } catch { /* best effort */ } }
    try { await new Promise((r) => server?.close(r)); } catch { /* best effort */ }
    rmScratchDir(stateDir);
  }
});
