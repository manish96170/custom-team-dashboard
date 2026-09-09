// protocol.js — the wire protocol: newline-delimited JSON over a Unix domain
// socket, with a client-supplied `id` correlating every response and every
// `observe` stream frame back to the command that caused it.
//
// This directly closes review finding S10 (consolidated-review-claudeopus5-medium
// --spike-0b.md): "No request IDs, with concurrent dispatch on one socket ...
// a client that pipelines two commands cannot tell which reply belongs to which."
//
// ── Message shapes ──────────────────────────────────────────────────────────
//
// Request (client -> server), exactly one JSON object per line:
//   { id: string, cmd: string, ...params }
//     - `id` is REQUIRED and caller-supplied (any non-empty string; a UUID is
//       recommended but not enforced). It is opaque to the server — never
//       interpreted, never reused server-side for anything but echoing back.
//     - `cmd` selects the handler (see server.js's dispatch table).
//
// Response (server -> client), exactly one JSON object per line:
//   success: { id, ok: true, ...result }
//   failure: { id, ok: false, error: string }
//     - `id` always equals the request's `id`.
//     - A request missing `id` (or with a non-string/empty `id`) gets a
//       failure response with `id: null` — the server cannot correlate what
//       it never received, so it says so explicitly rather than guessing.
//
// Stream frame (server -> client, for `observe`-style long-lived subscriptions):
//   { id, event: {...} }              -- one per upstream adapter event
//   { id, ok: true, done: true }       -- the stream ended normally
//   { id, ok: false, error: string }   -- the stream ended abnormally
//     - `id` is always the `id` of the `observe` request that opened this
//       subscription, for the lifetime of that subscription. A client that
//       opens two `observe` subscriptions on the same connection (e.g. two
//       different runIds) tells them apart purely by `id`, exactly like any
//       other pipelined pair of commands.
//
// Multiple requests may be pipelined on one connection (write several
// newline-terminated JSON lines back-to-back without waiting for a reply).
// The server dispatches each concurrently and does NOT guarantee reply order
// matches request order — `id` is the only correlation mechanism, by design,
// not order-of-arrival.
//
// ── Framing / bounded buffer ────────────────────────────────────────────────
//
// This directly closes review finding S14: "No maximum command size: one
// local client can exhaust supervisor memory ... A client that writes bytes
// without a newline grows `buf` unboundedly."
//
// LineFramer accumulates bytes per-connection and splits on '\n'. `maxBytes` is
// a cap on the length of ONE line, and it is enforced against every line —
// complete or not. If any line would exceed it, `push()` reports
// `overflow: true` and the caller (server.js) MUST destroy the connection; a
// buggy or malicious client cannot hold unbounded memory hostage, whether it
// withholds '\n' forever or sends one enormous newline-terminated command.
//
// Three properties this class guarantees, each of which was violated by the
// original concat-then-scan implementation (review-two/group3-ipc-luna.md
// findings 1 and 3):
//
//   1. The cap applies to complete lines too. Previously only the *unterminated
//      remainder* was measured, so `push(<maxBytes+1 bytes>, '\n')` returned
//      `overflow: false` and handed the whole oversized line to JSON.parse.
//   2. Retained bytes never exceed `maxBytes`. Previously the incoming chunk was
//      concatenated in full *before* the size check, so a single large chunk (or
//      a flood of them) could retain arbitrarily more than the configured bound.
//      The scan now walks the chunk in place and stops the instant the bound
//      would be crossed — nothing oversized is ever retained.
//   3. Overflow is terminal. Once the bound is crossed the framer is poisoned:
//      it drops its buffer, never emits another line, and every subsequent
//      `push()` re-reports `overflow: true` without accumulating anything. A
//      caller that is still mid-teardown (waiting on a socket write to flush,
//      say) therefore cannot be tricked into buffering more by a peer that
//      keeps writing.

export const MAX_LINE_BYTES = 256 * 1024; // 256 KiB per line, terminated or not

const NEWLINE = 0x0a;

export class LineFramer {
  constructor({ maxBytes = MAX_LINE_BYTES } = {}) {
    this.maxBytes = maxBytes;
    /** Raw pieces of the current, not-yet-terminated line. Copied on retention so
     * a subarray of a large socket chunk can't pin that whole chunk in memory. */
    this._pending = [];
    this._pendingBytes = 0;
    this._overflowed = false;
    this._overflowBytes = 0;
  }

  /**
   * Feed one chunk of bytes in. Returns { lines: string[], overflow: boolean }.
   * `lines` are complete, newline-terminated (newline stripped) UTF-8 strings,
   * in arrival order. `overflow` is true iff some line reached `maxBytes` — the
   * caller must treat this connection as unrecoverable and destroy it; this
   * class does not destroy anything itself, it only reports the bound was
   * crossed (it owns no socket).
   *
   * On overflow, `lines` holds only the complete lines that were fully framed
   * *before* the offending bytes. The caller is free to discard them — the
   * connection is doomed either way — but they are returned rather than
   * silently dropped so the decision stays with the caller.
   */
  push(chunk) {
    if (this._overflowed) return { lines: [], overflow: true };

    const lines = [];
    let offset = 0;
    while (offset < chunk.length) {
      const nl = chunk.indexOf(NEWLINE, offset);
      const segEnd = nl === -1 ? chunk.length : nl;
      const segLen = segEnd - offset;

      // Check BEFORE retaining anything, so retained bytes can never exceed the cap.
      if (this._pendingBytes + segLen > this.maxBytes) {
        this._overflowBytes = this._pendingBytes + segLen;
        this._pending = [];
        this._pendingBytes = 0;
        this._overflowed = true;
        return { lines, overflow: true };
      }

      if (nl === -1) {
        // Partial line: retain a copy (not a view) and wait for more bytes.
        this._pending.push(Buffer.from(chunk.subarray(offset, segEnd)));
        this._pendingBytes += segLen;
        return { lines, overflow: false };
      }

      // Complete line. Decode from the raw bytes so a multi-byte UTF-8 sequence
      // split across chunk boundaries still decodes correctly.
      if (this._pendingBytes === 0) {
        lines.push(chunk.subarray(offset, segEnd).toString("utf8"));
      } else {
        this._pending.push(chunk.subarray(offset, segEnd));
        lines.push(Buffer.concat(this._pending).toString("utf8"));
        this._pending = [];
        this._pendingBytes = 0;
      }
      offset = nl + 1;
    }
    return { lines, overflow: false };
  }

  /** Bytes currently retained for an unterminated line. Never exceeds `maxBytes`. */
  get bufferedBytes() {
    return this._pendingBytes;
  }

  /** Length the offending line had reached when the cap was crossed (0 if never). Diagnostics only. */
  get overflowBytes() {
    return this._overflowBytes;
  }

  /** True once the cap has been crossed; the framer emits nothing further. */
  get overflowed() {
    return this._overflowed;
  }
}

export function encodeFrame(obj) {
  return JSON.stringify(obj) + "\n";
}

/** Validate the minimal required shape of an incoming request. Returns an error string, or null if valid. */
export function validateRequestShape(cmd) {
  if (cmd === null || typeof cmd !== "object" || Array.isArray(cmd)) {
    return "request must be a JSON object";
  }
  if (typeof cmd.id !== "string" || cmd.id.length === 0) {
    return 'request must carry a non-empty string "id" field';
  }
  if (typeof cmd.cmd !== "string" || cmd.cmd.length === 0) {
    return 'request must carry a non-empty string "cmd" field';
  }
  return null;
}
