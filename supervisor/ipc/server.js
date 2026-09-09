// server.js — the Unix domain socket server: typed commands + subscriptions,
// newline-delimited JSON framing, id-correlated wire protocol (protocol.js),
// and the resilience/bounding properties required by the Group 3 spec and by
// review findings B7/S10/S14/S11 (consolidated-review-claudeopus5-medium
// --spike-0b.md):
//
//   B7  — daemon must never die from a peer crash (every socket gets a real
//         `error` listener; no listener means Node escalates ECONNRESET to an
//         uncaught exception).
//   S10 — every response/stream-frame echoes the request's `id`.
//   S14 — bounded per-connection input buffer; overflow destroys the
//         connection instead of growing memory unboundedly.
//   S11 — deterministic teardown: track every accepted socket so it can be
//         force-closed rather than waiting on server.close()'s default
//         behavior (which hangs forever if any connection is a long-lived
//         `observe` stream — proven in the spike, see PLAN.md section 4 /
//         TODO.md Group 5).
//
// Persistence and adapter boundary — RESOLVED in Group 5, and not the way this
// header originally anticipated. Rather than swapping the `persistence` and
// `adapter` arguments for real modules, supervisor/runtime/supervisor.js owns
// both and injects its whole command surface through `commands` (below), so this
// file dispatches without knowing what a run or a database is. The `persistence`
// and `adapter` defaults remain purely as fixtures for ipc/test/, which must keep
// exercising wire behavior with no database and no harness installed.

import net from "node:net";
import { LineFramer, MAX_LINE_BYTES, encodeFrame, validateRequestShape } from "./protocol.js";
import { createPersistenceStub } from "./persistence-stub.js";
import { createMockAdapter } from "./mock-adapter.js";

/** How long an overflowing connection is allowed to stay open purely so the
 * human-readable error frame has a chance to flush. Deliberately short: the
 * bound is already held (the framer retains nothing further), so this only
 * trades a few milliseconds for a better client-side error message, and it is
 * an upper bound, not a wait — the write callback cuts sooner when it fires. */
export const OVERFLOW_CLOSE_GRACE_MS = 50;

export function createIpcServer({
  persistence = createPersistenceStub(),
  adapter = createMockAdapter(),
  /**
   * Real command surface (Group 5). A map of `cmd` name -> handler
   *   handler(cmd, ctx) -> response object | null
   * where ctx is { socket, safeWrite, signal }. `null` means "I already wrote my own
   * frames" (streaming commands do this). Entries here take precedence over the
   * built-in demo cases below, which is how runtime/supervisor.js replaces the
   * mock adapter + persistence stub without this file needing to know about either.
   *
   * `signal` aborts when the client's socket closes — a streaming handler must stop
   * pulling from its source when the peer is gone (see the observe case below for the
   * built-in equivalent).
   */
  commands = {},
  maxLineBytes = MAX_LINE_BYTES,
  logger = console,
  /** Test/observability hook: called synchronously the moment the bounded-buffer
   * guard fires for a connection, before any write/destroy is attempted. Not
   * part of the wire protocol — exists so tests can assert the server-side
   * guard actually ran, independent of whether the error frame's bytes survive
   * the abrupt close on the wire (TCP/unix-domain semantics can legitimately
   * RST-discard a final write when the peer still has unread backlog queued —
   * see this directory's FINDINGS.md for the captured evidence). */
  onBufferOverflow,
} = {}) {
  /** Every currently-accepted socket. This IS the teardown primitive the spec asks for —
   * server.close()'s default wait-for-natural-close is never relied on (see shutdown() below). */
  const sockets = new Set();

  function safeWrite(socket, obj) {
    if (!socket || socket.destroyed || socket.writableEnded) return false;
    try {
      socket.write(encodeFrame(obj));
      return true;
    } catch (err) {
      logger.warn?.(`[ipc] write to a socket failed post-check: ${err.message}`);
      return false;
    }
  }

  /**
   * Was a real command surface supplied?
   *
   * If so, the built-in demo cases below are NOT a fallback for it — see `dispatch`. Derived rather than
   * configured, because "I passed a command map and also want the demo adapter to answer for anything I
   * forgot" is not a coherent request.
   */
  const hasRealCommands = Object.keys(commands).length > 0;

  async function dispatch(cmd, socket, ctx = {}) {
    const { id } = cmd;

    const handler = commands[cmd.cmd];
    if (handler) return handler(cmd, { socket, safeWrite, signal: ctx.signal, logger });

    // ── STRICT MODE, and it closes a real hole ──────────────────────────────────────────
    //
    // The demo `switch` below implements `start`, `stop`, `sendInput`, `observe` and `list` against the mock
    // adapter and the persistence stub. Those exist so this file can be exercised without a supervisor — and
    // as a FALLBACK they were two separate problems:
    //
    //   1. §27.5's defect, made silent. When the supervisor's map was once passed under the wrong key, every
    //      command fell through to these cases and a hook got back a plausible-looking success from a mock.
    //      "Unknown cmd" is the answer that would have found that in minutes.
    //   2. An authorization BYPASS, as of Phase 7. `authorizedCommandHandlers()` wraps the map; it cannot wrap
    //      a case statement inside this file. Any command missing from the map — a typo, a rename, a new
    //      command someone forgot to register — would be served here with no principal at all.
    //
    // So when a real command surface is supplied, an unregistered command is REFUSED. `ping` stays, because a
    // liveness probe carries no state and the daemon's own crash tests use it before they have a token.
    if (hasRealCommands && cmd.cmd !== "ping") {
      return { id, ok: false, error: `unknown cmd: ${cmd.cmd}` };
    }

    switch (cmd.cmd) {
      case "ping":
        return { id, ok: true, pid: process.pid, now: new Date().toISOString() };

      case "echo":
        return { id, ok: true, payload: cmd.payload ?? null };

      case "start": {
        const runId = await adapter.start(cmd.spec ?? {});
        await persistence.createRun({ runId, ...(cmd.spec ?? {}) });
        return { id, ok: true, runId };
      }

      case "startLongLived": {
        // test/demo only — a run that never emits turn.end, for teardown proofs.
        const runId = await adapter.startLongLived();
        await persistence.createRun({ runId });
        return { id, ok: true, runId };
      }

      case "sendInput":
        await adapter.sendInput(cmd.runId, cmd.input);
        return { id, ok: true };

      case "interrupt":
        await adapter.interrupt(cmd.runId);
        return { id, ok: true };

      case "stop":
        await adapter.stop(cmd.runId);
        await persistence.endRun(cmd.runId, { exitReason: "stopped" });
        return { id, ok: true };

      case "list":
        return { id, ok: true, runIds: [...(adapter._runs?.keys?.() ?? [])] };

      case "observe": {
        // Long-lived: every subsequent frame on this subscription echoes `id`,
        // per the wire protocol doc in protocol.js. Nothing here writes to the
        // socket without going through safeWrite (guards a destroyed peer).
        try {
          for await (const evt of adapter.observe(cmd.runId)) {
            if (socket.destroyed || ctx.signal?.aborted) break; // peer is gone — stop pulling events we can't deliver
            safeWrite(socket, { id, event: evt });
            try {
              await persistence.recordEvent({ runId: cmd.runId, tier: 1, type: evt.type, payload: evt });
            } catch (err) {
              logger.warn?.(`[ipc] persistence.recordEvent failed (non-fatal): ${err.message}`);
            }
          }
          if (!socket.destroyed) safeWrite(socket, { id, ok: true, done: true });
        } catch (err) {
          safeWrite(socket, { id, ok: false, error: String(err?.message ?? err) });
        }
        return null; // response(s) already written directly to the socket
      }

      default:
        return { id, ok: false, error: `unknown cmd: ${cmd.cmd}` };
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const framer = new LineFramer({ maxBytes: maxLineBytes });
    /** Aborted the moment this peer's socket closes. Handed to every command handler so a
     * long-lived streaming command (`observe`) stops pulling from its source instead of
     * running on against a socket nobody will ever read again. Deferred review item from
     * Group 3: "cancel a peer's observe iterator on disconnect". */
    const connAbort = new AbortController();
    /** id -> cmd, for every command currently executing on THIS connection.
     *
     * Second deferred review item: the protocol requires a client-supplied `id` echoed on
     * every response and every stream frame, so two concurrent commands sharing one id
     * make the correlation meaningless -- a client cannot tell which reply is whose, and
     * for a stream it cannot tell which subscription a frame belongs to. Reusing an id
     * whose command has finished is fine and normal; overlapping is what's rejected. */
    const inFlight = new Map();
    /** Set the instant the bound is crossed. Once true this connection is doomed:
     * no further line is parsed or dispatched, and the overflow path runs exactly
     * once no matter how many more `data` events the peer manages to deliver
     * before the destroy lands (review-two/group3-ipc-luna.md finding 3). */
    let overflowed = false;

    // The single most important listener in this file, per B7: an ECONNRESET
    // (peer killed mid-write, or any other transport error) fires 'error' on
    // this EventEmitter. With no listener, Node treats that as an uncaught
    // exception and takes the whole process down. This listener's only job is
    // to make that impossible — log and clean up, nothing more.
    socket.on("error", (err) => {
      logger.warn?.(`[ipc] socket error from peer (surviving): ${err.code || err.message}`);
      sockets.delete(socket);
    });

    socket.on("close", () => {
      sockets.delete(socket);
      connAbort.abort();
    });

    socket.on("data", (chunk) => {
      if (overflowed) return; // doomed connection — don't frame, parse, or dispatch anything more

      let result;
      try {
        result = framer.push(chunk);
      } catch (err) {
        logger.error?.(`[ipc] framer threw (unexpected): ${err.message}`);
        safeWrite(socket, { id: null, ok: false, error: "internal framing error" });
        socket.destroy();
        return;
      }

      // S14: the framer enforces the bound; the server enforces the consequence.
      // Checked BEFORE dispatching this batch's lines: once the bound is crossed
      // the connection is being cut, so any command that happened to be framed
      // ahead of the offending bytes is deliberately dropped rather than executed
      // against a peer that will never read the reply.
      if (result.overflow) {
        overflowed = true;
        // Stop reading immediately. Without this, kernel-buffered inbound bytes
        // keep firing 'data' while we wait for the outbound write to flush.
        socket.pause();
        logger.warn?.(`[ipc] connection exceeded ${maxLineBytes}-byte line cap — destroying`);
        onBufferOverflow?.({
          bufferedBytes: framer.bufferedBytes,
          attemptedBytes: framer.overflowBytes,
          maxLineBytes,
        });

        // Best-effort delivery of the human-readable reason, then a HARD close.
        // The write callback is a courtesy, not a precondition: if the peer isn't
        // draining, that callback can stay pending indefinitely, and waiting on it
        // would leave the connection open exactly when we most need it gone
        // (review-two/group3-ipc-luna.md finding 2). The grace timer guarantees
        // the destroy happens on a bounded schedule regardless.
        let cut = false;
        const destroyNow = () => {
          if (cut) return;
          cut = true;
          clearTimeout(graceTimer);
          if (!socket.destroyed) socket.destroy();
        };
        const graceTimer = setTimeout(destroyNow, OVERFLOW_CLOSE_GRACE_MS);
        graceTimer.unref?.(); // never hold the event loop open for this
        try {
          socket.write(
            encodeFrame({
              id: null,
              ok: false,
              error: `line exceeds max size (${maxLineBytes} bytes); closing connection`,
            }),
            destroyNow,
          );
        } catch (err) {
          logger.warn?.(`[ipc] overflow-frame write failed, destroying immediately: ${err.message}`);
          destroyNow();
        }
        return;
      }

      for (const line of result.lines) {
        if (!line.trim()) continue;
        let cmd;
        try {
          cmd = JSON.parse(line);
        } catch (err) {
          safeWrite(socket, { id: null, ok: false, error: `bad json: ${err.message}` });
          continue;
        }
        const shapeError = validateRequestShape(cmd);
        if (shapeError) {
          safeWrite(socket, { id: typeof cmd?.id === "string" ? cmd.id : null, ok: false, error: shapeError });
          continue;
        }
        if (inFlight.has(cmd.id)) {
          safeWrite(socket, {
            id: cmd.id,
            ok: false,
            error: `correlation id "${cmd.id}" is already in flight on this connection (running "${inFlight.get(cmd.id)}"); ids must be unique among concurrent commands`,
          });
          continue;
        }
        inFlight.set(cmd.id, cmd.cmd);
        dispatch(cmd, socket, { signal: connAbort.signal })
          .then((response) => {
            if (response) safeWrite(socket, response);
          })
          .catch((err) => {
            // Command handlers can throw (unknown runId, adapter error, etc.) —
            // this is the ordinary error path, distinct from B7/B8's crash path.
            safeWrite(socket, { id: cmd.id, ok: false, error: String(err?.message ?? err) });
          })
          .finally(() => {
            inFlight.delete(cmd.id);
          });
      }
    });
  });

  // A server-level error (e.g. EADDRINUSE-equivalent on the socket path) is
  // NOT a peer error — it's a startup/listen failure, left to the caller of
  // listen() to reject on. We still attach a listener so that if it fires
  // after listen() resolved (rare, but possible) it doesn't escalate either.
  server.on("error", (err) => {
    logger.error?.(`[ipc] server-level error: ${err.message}`);
  });

  function listen(sockPath) {
    return new Promise((resolve, reject) => {
      // The one-shot listen-failure listener must be removed on success, or every
      // listen() call leaves a dead `reject` closure attached to the server's
      // 'error' event forever (review-two/group3-ipc-luna.md finding 7).
      const onListenError = (err) => reject(err);
      server.once("error", onListenError);
      server.listen(sockPath, () => {
        server.removeListener("error", onListenError);
        resolve();
      });
    });
  }

  /** Enumerate every currently-accepted socket — the primitive Group 5's teardown wiring needs. */
  function listSockets() {
    return [...sockets];
  }

  /** Force-close every accepted socket immediately, writing a shutdown notice first where possible. */
  function forceCloseAll(reason = "server shutting down") {
    for (const socket of sockets) {
      safeWrite(socket, { id: null, ok: false, event: { type: "server.shutdown", reason } });
      socket.destroy();
    }
    sockets.clear();
  }

  /**
   * Deterministic teardown: force-close every open connection (never relies on
   * server.close()'s default "wait for natural close," which the spike proved
   * hangs forever against a long-lived `observe` stream — review finding S11),
   * then close the listening socket, bounded by a hard timeout so a caller can
   * always proceed to process.exit on schedule.
   */
  function shutdown({ timeoutMs = 3000, reason = "shutdown" } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (info) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(info);
      };
      const timer = setTimeout(() => {
        logger.warn?.(`[ipc] shutdown exceeded ${timeoutMs}ms — resolving anyway (hard timeout)`);
        finish({ timedOut: true });
      }, timeoutMs);

      forceCloseAll(reason);
      server.close(() => finish({ timedOut: false }));
    });
  }

  return { server, listen, dispatch, safeWrite, listSockets, forceCloseAll, shutdown };
}
