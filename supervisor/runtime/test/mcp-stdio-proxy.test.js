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
//   9. with no --allow-tools at all, tools/list is relayed completely unfiltered
//
// Cases 10-17 below, added 2026-09-14 per an external (ChatGPT) security-boundary review of this exact
// file — each item was independently traced against the CURRENT code before being trusted:
//   10. a tools/call with missing/null/non-string params.name is safely refused, never crashes, never
//       forwarded (already-correct behavior, locked in)
//   11. a tools/call shaped as a JSON-RPC NOTIFICATION (no "id" at all) for a disallowed tool is still
//       refused and never forwarded, even though a notification expects no reply
//   12. a REAL bug, fixed: a multi-byte UTF-8 character split exactly at a socket chunk boundary used to
//       corrupt into replacement characters; a large multi-line JSON-RPC frame with an intentionally
//       fragmented multi-byte tool name now survives byte-for-byte
//   13. multiple complete JSON-RPC frames arriving in a single chunk are both processed (already-correct
//       behavior, locked in)
//   14. a REAL hardening fix: an unparseable (non-JSON) client-side line is now DROPPED, never relayed to
//       the real server, while --allow-tools is active
//   15. a Unicode homoglyph tool name (visually similar to an allowed name, not byte-identical) is safely
//       refused, never treated as a match
//   16. the real pooled server disconnecting mid-request makes the proxy exit promptly rather than
//       leaving a pending tools/call hanging forever
//   17. --allow-tools "" (present but explicitly empty) blocks EVERY tool outright — the safe primitive a
//       future caller can rely on to guarantee zero-tool access, distinct from omitting the flag entirely (backward compat)

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

    // Shared setup for cases 10-17: a fresh filtered proxy+server pair, same shape as case 6-9's own
    // inline setup, factored out since seven more cases need it.
    async function openFilteredPair(allowToolsArg) {
      const proxy = spawnProxy(["--socket", socketPath, "--allow-tools", allowToolsArg]);
      const [srv] = await waitForEvent(server, "connection");
      const state = { stdout: "", server: "", stderr: "" };
      proxy.stdout.on("data", (c) => { state.stdout += c.toString("utf8"); });
      proxy.stderr.on("data", (c) => { state.stderr += c.toString("utf8"); });
      srv.on("data", (c) => { state.server += c.toString("utf8"); });
      return { proxy, srv, state };
    }
    function closePair({ proxy, srv }) {
      const exited = waitForEvent(proxy, "exit");
      proxy.stdin.end();
      try { srv.destroy(); } catch { /* already gone */ }
      return exited;
    }
    function findResponseFor(buf, id) {
      const line = buf.trim().split("\n").find((l) => l.includes(`"id":${id}`));
      return line ? JSON.parse(line) : null;
    }

    // ── 10 ───────────────────────────────────────────────────────────────────────────
    {
      const pair = await openFilteredPair("git_push");
      const before = pair.state.server;
      pair.proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 300, params: {} })}\n`);
      pair.proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 301, params: null })}\n`);
      pair.proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 302, params: { name: 12345 } })}\n`);
      await waitForBuffer(() => pair.state.stdout, (b) => b.includes('"id":302'));
      for (const id of [300, 301, 302]) {
        const resp = findResponseFor(pair.state.stdout, id);
        assert.ok(resp?.error, `expected id ${id} (missing/null/non-string params.name) to be refused with an error, got ${JSON.stringify(resp)}`);
      }
      assert.equal(pair.state.server, before, "none of the three malformed tools/call frames must ever reach the real server");
      // The proxy must still be alive and functional afterward — no crash from the malformed input.
      pair.proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 303, params: { name: "git_push" } })}\n`);
      await waitForBuffer(() => pair.state.server, (b) => b.includes('"id":303'));
      await closePair(pair);
      console.log("  10. a tools/call with missing/null/non-string params.name is safely refused, never crashes, never forwarded");
    }

    // ── 11 ───────────────────────────────────────────────────────────────────────────
    {
      const pair = await openFilteredPair("git_push");
      const before = pair.state.server;
      // No "id" field at all — a valid JSON-RPC NOTIFICATION shape, unusual for tools/call but not invalid.
      pair.proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "slack_delete_message" } })}\n`);
      await new Promise((r) => setTimeout(r, 150)); // no id to wait on — give a wrongful forward time to arrive
      assert.equal(pair.state.server, before, "a disallowed notification-shaped tools/call must never reach the real server either");
      const refusalLine = pair.state.stdout.trim().split("\n").find((l) => l.includes("slack_delete_message"));
      assert.ok(refusalLine, "the refusal must still be reported somewhere on stdout");
      assert.equal(JSON.parse(refusalLine).id, null, `a notification has no id; the error frame's own id must be null, not dropped or a stale value, got ${refusalLine}`);
      await closePair(pair);
      console.log("  11. a tools/call shaped as a JSON-RPC notification (no id) for a disallowed tool is still refused and never forwarded");
    }

    // ── 12 ───────────────────────────────────────────────────────────────────────────
    // review, 2026-09-14: reproduced directly against the PRE-FIX `buf += chunk` implementation before
    // this fix landed — a multi-byte character split at a chunk boundary decoded to replacement
    // characters on each half independently. This name is deliberately multi-byte AND long enough that a
    // real OS pipe is likely to deliver it across more than one `data` event even without an artificial
    // delay, but the delay below makes the two-chunk split deterministic rather than hoped-for.
    {
      const toolName = "日本語ツール名前確認用文字列テスト用ツール";
      const pair = await openFilteredPair(toolName);
      const frame = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 400, params: { name: toolName } })}\n`, "utf8");
      // Split at a byte offset chosen to land inside one of the multi-byte characters, not on a boundary.
      let splitAt = Math.floor(frame.length / 2);
      while (splitAt > 0 && (frame[splitAt] & 0xc0) === 0x80) splitAt -= 1; // land ON a continuation byte, not before one
      splitAt += 1;
      pair.proxy.stdin.write(frame.slice(0, splitAt));
      await new Promise((r) => setTimeout(r, 30));
      pair.proxy.stdin.write(frame.slice(splitAt));
      await waitForBuffer(() => pair.state.server, (b) => b.includes('"id":400'));
      const forwarded = findResponseFor(pair.state.server, 400) ?? JSON.parse(pair.state.server.trim().split("\n").find((l) => l.includes('"id":400')));
      assert.equal(forwarded.params.name, toolName,
        `the multi-byte tool name must survive a chunk split byte-for-byte; got ${JSON.stringify(forwarded.params?.name)}`);
      await closePair(pair);
      console.log("  12. a multi-byte UTF-8 tool name split exactly at a socket chunk boundary survives byte-for-byte (was corrupted pre-fix)");
    }

    // ── 13 ───────────────────────────────────────────────────────────────────────────
    {
      const pair = await openFilteredPair("git_push");
      const line1 = JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 500, params: { name: "git_push" } });
      const line2 = JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 501, params: { name: "slack_delete_message" } });
      pair.proxy.stdin.write(`${line1}\n${line2}\n`); // two complete frames, one write, one chunk
      await waitForBuffer(() => pair.state.server, (b) => b.includes('"id":500'));
      await waitForBuffer(() => pair.state.stdout, (b) => b.includes('"id":501'));
      assert.ok(pair.state.server.includes('"id":500'), "the first (allowed) frame in the coalesced chunk must be forwarded");
      assert.ok(!pair.state.server.includes('"id":501'), "the second (disallowed) frame in the SAME coalesced chunk must still be refused, not let through");
      await closePair(pair);
      console.log("  13. two complete JSON-RPC frames arriving in a single chunk are both processed independently");
    }

    // ── 14 ───────────────────────────────────────────────────────────────────────────
    {
      const pair = await openFilteredPair("git_push");
      const before = pair.state.server;
      pair.proxy.stdin.write("this is not json at all\n");
      await waitForBuffer(() => pair.state.stderr, (b) => b.includes("dropping"));
      assert.equal(pair.state.server, before, "an unparseable client-side line must never reach the real server while --allow-tools is active");
      // Still alive afterward.
      pair.proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 600, params: { name: "git_push" } })}\n`);
      await waitForBuffer(() => pair.state.server, (b) => b.includes('"id":600'));
      await closePair(pair);
      console.log("  14. an unparseable (non-JSON) client-side line is dropped, never relayed, while --allow-tools is active");
    }

    // ── 15 ───────────────────────────────────────────────────────────────────────────
    {
      const pair = await openFilteredPair("git_push");
      const before = pair.state.server;
      // Cyrillic "і" (U+0456) in place of Latin "i" — visually near-identical, byte-distinct.
      const homoglyph = "gіt_push";
      pair.proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 700, params: { name: homoglyph } })}\n`);
      await waitForBuffer(() => pair.state.stdout, (b) => b.includes('"id":700'));
      assert.equal(pair.state.server, before, "a Unicode homoglyph of an allowed name must never be treated as a match");
      const resp = findResponseFor(pair.state.stdout, 700);
      assert.ok(resp?.error, "the homoglyph name must be refused with a real error");
      await closePair(pair);
      console.log("  15. a Unicode homoglyph tool name is safely refused, never treated as a match for the real allowed name");
    }

    // ── 16 ───────────────────────────────────────────────────────────────────────────
    {
      const pair = await openFilteredPair("git_push");
      pair.proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 800, params: { name: "git_push" } })}\n`);
      await waitForBuffer(() => pair.state.server, (b) => b.includes('"id":800'));
      const exited = waitForEvent(pair.proxy, "exit", { timeoutMs: 3000 });
      pair.srv.destroy(); // the real pooled server disappears mid-request, no response ever sent
      // The real invariant is "does not hang forever" — `waitForEvent`'s own timeout would REJECT (not
      // resolve) if the proxy never exited, which is what actually proves this. The exit CODE itself
      // (0 vs non-zero) depends on whether a clean `.destroy()` fires this socket's `close` or `error`
      // handler first — both already exit promptly (see the file's own `socket.on("close"/"error")`), so
      // the exact code is not the property worth asserting here.
      await exited;
      console.log("  16. the real pooled server disconnecting mid-request makes the proxy exit promptly rather than hanging");
    }

    // ── 17 ───────────────────────────────────────────────────────────────────────────
    {
      const pair = await openFilteredPair(""); // present, but explicitly empty — "allow nothing," not "unrestricted"
      pair.proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 900, params: { name: "git_push" } })}\n`);
      await waitForBuffer(() => pair.state.stdout, (b) => b.includes('"id":900'));
      assert.ok(findResponseFor(pair.state.stdout, 900)?.error, "an explicitly empty --allow-tools must refuse EVERY tool, including one that would be allowed elsewhere");
      assert.equal(pair.state.server, "", "nothing must ever reach the real server when the allowlist is explicitly empty");

      pair.proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 901 })}\n`);
      await waitForBuffer(() => pair.state.server, (b) => b.includes('"id":901'));
      pair.srv.write(`${JSON.stringify({ jsonrpc: "2.0", id: 901, result: { tools: [{ name: "git_push" }] } })}\n`);
      await waitForBuffer(() => pair.state.stdout, (b) => b.includes('"id":901'));
      const listResp = findResponseFor(pair.state.stdout, 901);
      assert.deepEqual(listResp.result.tools, [], "tools/list must be filtered down to an empty array when the allowlist is explicitly empty");
      await closePair(pair);
      console.log("  17. --allow-tools \"\" (present but explicitly empty) blocks every tool outright, distinct from omitting the flag entirely");
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
