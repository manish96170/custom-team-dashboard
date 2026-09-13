// client.js — a minimal test/demo client for the wire protocol in protocol.js.
// Not a production CTO/TUI client; just enough to drive the adversarial tests
// in test/ against a real socket with real id correlation.

import net from "node:net";
import { randomUUID } from "node:crypto";
import { LineFramer } from "./protocol.js";

// `token` added 2026-09-11 (`codexdoc/REVIEW-NOTES.md` finding 10): this client used to send no
// principal token on any request, so anything built on it (`pane/pane.js`'s standalone `attachPane`)
// was refused by the real `authorizedCommandHandlers()` gate with "no token sent" — the interactive
// TUI has its own hand-rolled client (`tui/cli.js`) that already does this correctly; this brings the
// SAME mechanism here rather than inventing a second one.
export function connect(sockPath, { maxLineBytes, token = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    const framer = new LineFramer(maxLineBytes ? { maxBytes: maxLineBytes } : undefined);
    const pending = new Map(); // id -> { resolve, reject, streaming, onFrame }
    const streamHandlers = new Map(); // id -> (frame) => void, for observe-style subscriptions
    // `ipc/server.js`'s overflow/shutdown frames are UNSOLICITED — server-initiated, not a response to
    // any request this client sent — so they carry `id: null` on purpose, and neither `pending` nor
    // `streamHandlers` is ever keyed by `null`. Before this, that meant they were silently dropped:
    // nothing here could ever learn "the daemon is shutting down" or "this connection was cut for
    // exceeding the line-size cap" (HANDOFF.md's older should-fix backlog). `noticeHandlers` is the
    // deliberate third bucket for exactly that shape of frame.
    const noticeHandlers = new Set();

    // review-sol-2026-09-13.md finding 21: `pending`'s entries were settled ONLY by a matching response
    // frame arriving — a `send()` whose connection died (server force-closed it, a network error, the
    // shutdown notice's own `socket.destroy()` racing the response) left its promise unsettled FOREVER,
    // with no timeout and nothing else that could ever resolve it. `close`/`error` now reject every still
    // -pending request and clear stream handlers, so a caller's `await client.send(...)` fails loudly
    // instead of hanging. Connect-time `error` (before `connect` has fired) still only rejects the
    // connect promise — `once` below ensures this handler does not ALSO try to settle a connect that
    // already resolved successfully.
    let connected = false;
    socket.once("connect", () => { connected = true; });
    const settleAllPending = (err) => {
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.resolve({ id, ok: false, error: `connection closed: ${err.message}` });
      }
      streamHandlers.clear();
    };
    socket.on("close", () => { if (connected) settleAllPending(new Error("socket closed")); });
    socket.on("error", (err) => { if (connected) settleAllPending(err); });

    socket.on("connect", () => resolve(client));
    socket.on("error", reject); // connect-time errors only reject the promise; see note below.
    socket.on("data", (chunk) => {
      const { lines } = framer.push(chunk);
      for (const line of lines) {
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.id == null) {
          for (const handler of noticeHandlers) handler(frame);
          continue;
        }
        const handler = streamHandlers.get(frame.id);
        if (handler) {
          handler(frame);
          continue;
        }
        const waiter = pending.get(frame.id);
        if (waiter) {
          pending.delete(frame.id);
          waiter.resolve(frame);
        }
      }
    });

    const client = {
      socket,
      send(cmd, params = {}) {
        const id = params.id ?? randomUUID();
        const payload = { id, cmd, ...params };
        delete payload.id;
        payload.id = id;
        // Rides on EVERY request, same as `tui/cli.js`'s own client — a caller-supplied `token` in
        // `params` still wins (matching that this is a per-connection default, not an override).
        if (token && payload.token === undefined) payload.token = token;
        return new Promise((res) => {
          pending.set(id, { resolve: res });
          socket.write(JSON.stringify(payload) + "\n");
        });
      },
      /** Register a handler for every frame carrying this id (for observe-style streams). Returns an unsubscribe fn. */
      onStream(id, handler) {
        streamHandlers.set(id, handler);
        return () => streamHandlers.delete(id);
      },
      /** Register a handler for every UNSOLICITED frame (`id: null` — an overflow or shutdown notice,
       *  never a response to a request this client sent). Returns an unsubscribe fn. */
      onNotice(handler) {
        noticeHandlers.add(handler);
        return () => noticeHandlers.delete(handler);
      },
      writeRaw(bytes) {
        socket.write(bytes);
      },
      close() {
        socket.destroy();
      },
    };
  });
}
