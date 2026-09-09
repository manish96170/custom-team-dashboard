// safety.js — the top-level backstop required by the Group 3 spec and by
// review finding B7 ("The daemon dies from the client crashes it exists to
// survive... There is also no process.on('uncaughtException') or
// 'unhandledRejection' net in main()").
//
// This is a LAST RESORT, not the primary defense. The primary defense is:
// every socket gets a real `error` listener (server.js), every write is
// guarded (server.js's safeWrite), and the per-connection buffer is bounded
// (protocol.js's LineFramer). This net exists for whatever slips past all of
// that — a bug in a command handler, a stray promise rejection somewhere in
// an adapter — so a single peer or a single bug can never take the whole
// daemon down. Per the task spec: log and continue, never let either escalate
// to process exit.

export function installProcessSafetyNet({ logger = console, onEvent } = {}) {
  const uncaughtHandler = (err, origin) => {
    const msg = `[safety-net] uncaughtException (origin=${origin}): ${err?.stack || err}`;
    logger.error?.(msg);
    onEvent?.({ type: "uncaughtException", error: err, origin });
  };
  const rejectionHandler = (reason, promise) => {
    const msg = `[safety-net] unhandledRejection: ${reason?.stack || reason}`;
    logger.error?.(msg);
    onEvent?.({ type: "unhandledRejection", reason, promise });
  };

  process.on("uncaughtException", uncaughtHandler);
  process.on("unhandledRejection", rejectionHandler);

  /** For tests: remove exactly the listeners this call installed (never process.removeAllListeners — other code may have its own). */
  return function uninstall() {
    process.off("uncaughtException", uncaughtHandler);
    process.off("unhandledRejection", rejectionHandler);
  };
}
