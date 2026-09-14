// _fixture-mcp-socket-server.js — review-consolidated-2026-09-14.md finding 9: `mcp-pool-wiring.test.js`'s
// only real end-to-end proof that a role's declared MCP need actually reaches it (case 7, and the newer
// fail-closed cases 9/10) used the real `../leo-mcp` sibling repo as the pool's spawn command — silently
// skipped, with `npm test` still reporting green, on any checkout without that private sibling.
//
// This is a repo-local stand-in speaking the SAME wire protocol `mcp-stdio-proxy.js` already relays
// (newline-delimited JSON-RPC over a Unix socket, `LEO_MCP_SOCKET_PATH` env var — leo-mcp's own
// convention, matched here on purpose so `mcp-pool.js`'s `spawnOne` needs no special-casing to spawn
// this instead of the real thing). It advertises a FEW fake tools, including one named `git_push` so a
// test can reuse `ROLE_MCP_TOOL_ALLOWLIST`'s existing `git-push-runner` -> `["git_push"]` entry and
// prove the SAME allowlist-filtering mechanism finding 1 built, without depending on real leo-mcp at all.
//
// Deliberately tiny — just enough protocol to prove the mechanism, not a second leo-mcp: `initialize`,
// `tools/list`, and `tools/call` (which echoes its own arguments back so a test can assert exactly what
// was sent, unlike leo-mcp's real tools which have side effects this fixture must not need).

import net from "node:net";
import fs from "node:fs";

const FAKE_TOOLS = Object.freeze([
  { name: "git_push", description: "fixture stand-in for leo-mcp's real git_push" },
  { name: "jira_create_ticket", description: "fixture stand-in for leo-mcp's real jira_create_ticket" },
  { name: "slack_post", description: "fixture stand-in for leo-mcp's real slack_post" },
]);

function socketPathFromArgs() {
  const idx = process.argv.indexOf("--socket");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (process.env.LEO_MCP_SOCKET_PATH) return process.env.LEO_MCP_SOCKET_PATH;
  throw new Error("_fixture-mcp-socket-server: no socket path given (--socket <path> or LEO_MCP_SOCKET_PATH)");
}

function handle(message) {
  if (message.method === "initialize") {
    return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "fixture-1", capabilities: {} } };
  }
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id: message.id, result: { tools: FAKE_TOOLS.map((t) => ({ ...t })) } };
  }
  if (message.method === "tools/call") {
    return {
      jsonrpc: "2.0", id: message.id,
      result: { toolCalled: message.params?.name ?? null, argsEchoed: message.params?.arguments ?? null },
    };
  }
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `fixture: unknown method "${message.method}"` } };
}

function main() {
  const socketPath = socketPathFromArgs();
  if (fs.existsSync(socketPath)) {
    try { fs.unlinkSync(socketPath); } catch { /* best effort, same as leo-mcp's own server-socket.js */ }
  }
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      let nl;
      // eslint-disable-next-line no-cond-assign
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (err) {
          process.stderr.write(`_fixture-mcp-socket-server: invalid JSON-RPC frame: ${err.message}\n`);
          continue;
        }
        socket.write(`${JSON.stringify(handle(message))}\n`);
      }
    });
    socket.on("error", () => { /* a client disconnecting mid-write is not this fixture's problem */ });
  });
  server.listen(socketPath, () => {
    process.stderr.write(`_fixture-mcp-socket-server ready on ${socketPath} — ${FAKE_TOOLS.length} fake tools\n`);
  });
}

main();
