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
// actually verified) — but instead of implementing the MCP protocol, it does almost nothing but connect
// to the real pooled server's Unix socket and relay frames both ways.
//
// review-consolidated-2026-09-14.md finding 1 — WHY "ALMOST": a pooled server serves EVERY attached
// role from the same one resident process, and that process's own tool surface is not scoped per role
// (leo-mcp's real socket, measured directly, advertises 27 tools — `git_push` plus 21 `slack_*` and 5
// `jira_*` tools — to every attacher alike). Without a per-role bound at THIS layer, a `jira-runner`
// (capability preset: `jira:create` only) could reach `git_push` and every Slack tool, bypassing the
// supervisor's own `gitPush` capability check, its `git:identity` lease, and its `agent_journal` record
// entirely — the exact tool-allowlist gap `--strict-mcp-config` does NOT close (it bounds which SERVERS
// load, not which tools a loaded server exposes). `--allow-tools <comma-separated-names>` is that bound:
// when passed, this proxy parses the newline-delimited JSON-RPC frames leo-mcp's `dispatch.js`/
// `server-socket.js` already speaks (both ends already use this framing, so this is the smallest amount
// of protocol awareness that can enforce a bound — not a general MCP client/server implementation), and
//   - filters `tools/list` RESPONSES down to only the allowed names before relaying them to the harness,
//   - refuses `tools/call` REQUESTS naming a disallowed tool directly (a real JSON-RPC error carrying the
//     caller's own request id), without ever forwarding them to the real server at all,
//   - drops (never forwards) a client-side frame this proxy could not itself parse as JSON — added
//     2026-09-14: an unparseable frame is one this proxy cannot examine, so relaying it blind would be
//     the one input shape every check above could never see.
// Every other frame is relayed byte-for-byte, unexamined — this is a bound on WHICH tools are reachable,
// not a reimplementation of the protocol.
//
// Without `--allow-tools`, this is the original pure byte relay (kept for backward compatibility with
// any caller that does not set one) — `runtime/supervisor.js`'s `start()` always sets one for every pool
// it attaches, so that path is a fallback, not the intended steady state.
//
// Usage: node mcp-stdio-proxy.js --socket <path> [--allow-tools <name1,name2,...>]

import net from "node:net";

function parseArgs(argv) {
  const socketIdx = argv.indexOf("--socket");
  if (socketIdx === -1 || !argv[socketIdx + 1]) {
    throw new Error("mcp-stdio-proxy: --socket <path> is required");
  }
  const allowIdx = argv.indexOf("--allow-tools");
  const allowTools = allowIdx === -1 ? null : (argv[allowIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { socketPath: argv[socketIdx + 1], allowTools };
}

/** Line-buffered newline-delimited JSON-RPC framing, same convention leo-mcp's own transports use on
 *  both sides — a chunk boundary from a real socket/pipe has no relationship to a message boundary.
 *
 *  Buffers RAW BYTES, not strings — a hardening fix (2026-09-14, external review): the original version
 *  buffered with `buf += chunk`, which implicitly `.toString('utf8')`-decodes each incoming Buffer chunk
 *  INDEPENDENTLY the instant it arrives, before a multi-byte UTF-8 character split across a chunk
 *  boundary has all its bytes. Each half then decodes to U+FFFD replacement characters on its own —
 *  reproduced directly: a real tool-name string split mid-character corrupted into mangled text. Now
 *  every chunk is concatenated as bytes first, and `.toString('utf8')` is called exactly once, on a
 *  complete line (delimited by a real `\n` byte) — a multi-byte character can never be mid-decode at a
 *  chunk boundary because decoding never happens until the whole line is assembled. */
function makeLineBuffer(onLine) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let nl;
    // eslint-disable-next-line no-cond-assign
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      const lineBuf = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const line = lineBuf.toString("utf8");
      const trimmed = line.trim();
      if (trimmed) onLine(line);
    }
  };
}

function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function main() {
  let socketPath;
  let allowTools;
  try {
    ({ socketPath, allowTools } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  const socket = net.createConnection(socketPath);

  socket.on("connect", () => {
    if (!allowTools) {
      // No bound configured — the original, unexamined byte relay. Every real caller in this repo sets
      // `--allow-tools`; this path exists only so an old or test caller that doesn't is unaffected.
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
      return;
    }

    const allowedSet = new Set(allowTools);
    // Request ids the harness sent a `tools/list` for — a JSON-RPC response carries no method name, only
    // the id and the result, so this is what lets the response leg know which incoming result to filter.
    const pendingToolsListIds = new Set();

    const onClientLine = makeLineBuffer((line) => {
      const msg = tryParseJson(line);
      if (msg === undefined) {
        // Hardening fix (2026-09-14, external review): an unparseable CLIENT line used to be relayed
        // verbatim, same as the server side. On the server side that's harmless (nothing forwarded to the
        // real server as a result). On the CLIENT side, once `--allow-tools` is set, this proxy IS a
        // security boundary — relaying a frame it could not itself parse and therefore could never check
        // means every enforcement decision above is bypassable by the one input shape this proxy cannot
        // examine. Both this proxy and the real pooled server run the same JSON.parse-based dispatch, so
        // there is no known real frame this would ever legitimately reject and the server would accept —
        // but "no known case today" is not the same guarantee as "structurally impossible," so refuse
        // rather than relay blind.
        process.stderr.write(`mcp-stdio-proxy: dropping an unparseable client frame while --allow-tools is active (never forwarded)\n`);
        return;
      }
      if (msg.method === "tools/list") pendingToolsListIds.add(msg.id);
      if (msg.method === "tools/call") {
        const toolName = msg.params?.name;
        if (!allowedSet.has(toolName)) {
          process.stderr.write(
            `mcp-stdio-proxy: refusing tools/call for "${toolName}" — not in the allowed set [${allowTools.join(", ")}]\n`,
          );
          process.stdout.write(
            // `msg.id ?? null`: a JSON-RPC NOTIFICATION (no `id` at all, valid but unusual for `tools/call`)
            // must not silently vanish from `JSON.stringify` (which drops an `undefined` property) — the
            // refusal is unconditional either way (this line never reaches `socket.write` below regardless
            // of whether it's a request or a notification), this only keeps the error frame's own shape
            // honest about which case it was.
            `${JSON.stringify({
              jsonrpc: "2.0", id: msg.id ?? null,
              error: { code: -32601, message: `tool "${toolName}" is not allowed for this role` },
            })}\n`,
          );
          return; // never reaches the real server
        }
      }
      socket.write(`${line}\n`);
    });
    process.stdin.on("data", onClientLine);

    const onServerLine = makeLineBuffer((line) => {
      const msg = tryParseJson(line);
      if (msg === undefined) {
        process.stdout.write(`${line}\n`);
        return;
      }
      if (Object.hasOwn(msg, "id") && pendingToolsListIds.has(msg.id)) {
        pendingToolsListIds.delete(msg.id);
        if (Array.isArray(msg.result?.tools)) {
          msg.result.tools = msg.result.tools.filter((t) => allowedSet.has(t?.name));
        }
        process.stdout.write(`${JSON.stringify(msg)}\n`);
        return;
      }
      process.stdout.write(`${line}\n`);
    });
    socket.on("data", onServerLine);
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
