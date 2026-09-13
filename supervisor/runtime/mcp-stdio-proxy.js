#!/usr/bin/env node
// mcp-stdio-proxy.js — review-sol-2026-09-13.md finding 13: the piece that closes the gap between "a
// resident, pooled MCP server exists" (`mcp-pool.js`) and "a worker's harness can actually talk to it".
//
// MEASURED, NOT GUESSED, PER THIS PROJECT'S OWN RULE: `claude --mcp-config` only accepts three transport
// types (`stdio`, `sse`, `http` — checked directly against `claude mcp add --help`/`claude mcp
// add-json --help` on this machine); there is no "connect to an existing Unix socket" transport in the
// MCP client contract this repo can rely on. A pooled server (leo-mcp's `mcp/server-socket.js`) exists
// PRECISELY so N workers can share ONE resident process instead of each spawning their own — but the
// harness itself cannot be pointed at that socket directly.
//
// This script is the bridge: it IS a normal stdio MCP "server" as far as `claude --mcp-config` is
// concerned (a `command`+`args` entry it spawns itself, fully within the one transport type this repo has
// actually verified) — but instead of implementing the MCP protocol, it does nothing but connect to the
// real pooled server's Unix socket and relay bytes both ways. The harness sees an ordinary stdio server;
// the pooled process sees one more socket client, indistinguishable from any other. No protocol parsing
// happens here at all — both ends already speak the same newline-delimited JSON-RPC framing (leo-mcp's
// `dispatch.js`/`server-socket.js`), so a byte-for-byte pipe is correct and is the smallest possible
// amount of code standing between a worker and the shared process.
//
// Usage: node mcp-stdio-proxy.js --socket <path>

import net from "node:net";

function parseArgs(argv) {
  const idx = argv.indexOf("--socket");
  if (idx === -1 || !argv[idx + 1]) {
    throw new Error("mcp-stdio-proxy: --socket <path> is required");
  }
  return { socketPath: argv[idx + 1] };
}

function main() {
  let socketPath;
  try {
    ({ socketPath } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  const socket = net.createConnection(socketPath);

  // Nothing but protocol frames may reach stdout (leo-mcp's own hard rule, inherited here since this
  // process's stdout IS the harness's view of "the MCP server's output") — this pipe carries exactly
  // that and nothing else, since neither side of it is this script's own code.
  socket.on("connect", () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });

  // The pooled process going away (crash, teardown) must end this proxy — a proxy that stays alive with
  // a dead far end would leave the harness believing its MCP server is still there when every future
  // request would simply hang forever.
  socket.on("error", (err) => {
    process.stderr.write(`mcp-stdio-proxy: socket error connecting to ${socketPath}: ${err.message}\n`);
    process.exit(1);
  });
  socket.on("close", () => {
    process.exit(0);
  });

  // The harness closing our stdin (session ended) must end the socket side cleanly too, rather than
  // leaving an orphaned connection open against the shared pooled process indefinitely.
  process.stdin.on("end", () => {
    socket.end();
  });
}

main();
