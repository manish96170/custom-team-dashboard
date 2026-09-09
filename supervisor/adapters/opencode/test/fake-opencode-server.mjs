#!/usr/bin/env node
// Fake `opencode` binary used only by the adapter tests in this directory.
// Implements just enough of the real HTTP+SSE surface (as documented in
// spike-0b FINDINGS.md and mirrored by adapter.js) to drive the specific
// behaviors under test, without needing the real `opencode` CLI installed.
//
// Supported:
//   opencode --version                -> prints a version string, exits 0
//   opencode serve --port N --hostname H
//     GET  /global/health
//     POST /session                        -> { id }
//     GET  /session/:id                    -> 200 if known, 404 if not
//     POST /session/:id/prompt_async       -> logs the body to
//                                              FAKE_LOG_FILE (one JSON line
//                                              per call) so the test can
//                                              inspect exactly what model
//                                              was sent on each turn
//                                              (finding S5). Then, after a
//                                              short delay, pushes events
//                                              onto the shared SSE broadcast
//                                              queue for that session.
//     POST /session/:id/abort              -> 200
//     POST /session/:id/summarize          -> 200
//     GET  /event                          -> SSE stream of everything
//                                              queued for broadcast,
//                                              including a synthetic
//                                              non-allowlisted session-less
//                                              event (for finding S9) and a
//                                              real "server.connected".
//
// Controlled by env vars:
//   FAKE_OC_PROMPT_MODE=ok|reject   (default ok) — reject makes
//     prompt_async respond 400 (finding B9's exact failure shape, checked
//     incidentally since start() shares this path).
//   FAKE_OC_FAST_TURN=1             — emit session.idle immediately (before
//     the HTTP response for prompt_async even returns) rather than after a
//     delay, to exercise the "turn finishes before observe() is ever
//     called" case (finding S8).
//   FAKE_OC_EVENT_DELAY_MS=<n>      — delay the GET /event response (headers,
//     and therefore `server.connected`) by n ms. Real opencode's subscription is
//     not instantaneous; this makes that latency large and deterministic so the
//     "turn starts before the SSE subscription is live" race can actually be
//     reproduced in a test instead of being hidden by localhost speed
//     (review-two/group4-adapters-luna.md blocking finding).
//   FAKE_OC_EMIT_LEAK_EVENT=1       — also emit one event with NO
//     sessionID and a type that is NOT on the adapter's allowlist, to
//     prove it does NOT leak into every session's stream (finding S9).

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('0.9.0-fake\n');
  process.exit(0);
}

const portIdx = process.argv.indexOf('--port');
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 0;

const sessions = new Map(); // id -> { createdAt }
const sseClients = new Set(); // Set<res>
const eventQueue = []; // events broadcast so far, for late-connecting SSE clients (not required by real opencode, but harmless here)

function broadcast(evt) {
  eventQueue.push(evt);
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    res.write(line);
  }
}

function logPromptCall(body) {
  const logFile = process.env.FAKE_OC_LOG_FILE;
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify(body) + '\n');
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/global/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // Reports the config-resolution env this server was SPAWNED with, so a test can assert the
  // adapter does not override it. That is the guard on a hard product requirement: the
  // amazon-bedrock agent roster (luna / sol / terra / opus) lives in the developer's global
  // opencode config, so anything that relocates XDG_CONFIG_HOME removes the models this project
  // needs for cross-model review. Measured: an empty config dir takes /agent from 20 to 7.
  if (req.method === 'GET' && url.pathname === '/debug/spawn-env') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null,
      OPENCODE_CONFIG: process.env.OPENCODE_CONFIG ?? null,
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR ?? null,
      OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null,
    }));
    return;
  }

  // `/config` is what the adapter reads back to record the environment the server actually
  // loaded. Shaped like the real endpoint, and non-empty on purpose: an empty config would let a
  // broken reader look correct, since "loaded nothing" is the expected answer for a pinned server.
  if (req.method === 'GET' && url.pathname === '/config') {
    if (process.env.FAKE_OPENCODE_CONFIG_FAILS) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mcp: { 'leaky-one': {}, 'leaky-two': {} },
      agent: { a: {}, b: {}, c: {} },
      plugin: ['p1'],
      instructions: [],
      model: 'fake-provider/fake-model',
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/event') {
    const eventDelayMs = Number(process.env.FAKE_OC_EVENT_DELAY_MS ?? 0);
    if (eventDelayMs > 0) await new Promise((r) => setTimeout(r, eventDelayMs));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/session') {
    await readBody(req);
    const id = `sess-${randomUUID().slice(0, 8)}`;
    sessions.set(id, { createdAt: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id }));
    return;
  }

  const sessionMatch = url.pathname.match(/^\/session\/([^/]+)(\/.*)?$/);
  if (sessionMatch) {
    const sessionID = sessionMatch[1];
    const sub = sessionMatch[2] ?? '';

    if (req.method === 'GET' && sub === '') {
      if (sessions.has(sessionID)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: sessionID }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
      return;
    }

    if (req.method === 'POST' && sub === '/prompt_async') {
      const body = await readBody(req);
      logPromptCall({ sessionID, ...body });

      if (process.env.FAKE_OC_PROMPT_MODE === 'reject') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad model' }));
        return; // deliberately never emits session.idle/session.error — finding B9
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');

      const emitTurn = () => {
        if (process.env.FAKE_OC_EMIT_LEAK_EVENT === '1') {
          // No sessionID at all, and of a type mapEvent() DOES map to a
          // real delivered event (assistant.delta) — unlike a made-up
          // event type, this actually proves the session filter itself,
          // not just mapEvent()'s unknown-type default. Must be dropped by
          // a fail-closed filter, not broadcast to every session sharing
          // this server (finding S9). Also throw in an unknown, clearly
          // bogus type for extra assurance nothing weird happens with it.
          broadcast({ type: 'message.part.delta', properties: { field: 'text', delta: 'LEAKED-CONTENT' } });
          broadcast({ type: 'custom.unscoped.leak', properties: {} });
        }
        broadcast({ type: 'message.part.delta', properties: { sessionID, field: 'text', delta: 'hi' } });
        broadcast({ type: 'session.idle', properties: { sessionID } });
      };
      if (process.env.FAKE_OC_FAST_TURN === '1') {
        emitTurn(); // synchronously, before the caller could plausibly call observe()
      } else {
        setTimeout(emitTurn, 50);
      }
      return;
    }

    if (req.method === 'POST' && sub === '/abort') {
      broadcast({ type: 'session.error', properties: { sessionID, error: { name: 'MessageAbortedError' } } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    if (req.method === 'POST' && sub === '/summarize') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('true');
      return;
    }
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  // Signal readiness on stderr for any human debugging; health check is via HTTP.
  process.stderr.write(`fake-opencode-server listening on ${port}\n`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
