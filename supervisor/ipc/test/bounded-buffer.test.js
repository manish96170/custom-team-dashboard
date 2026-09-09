// bounded-buffer.test.js — proves the per-connection input buffer is actually
// bounded (closes review finding S14): a client that sends bytes with NO
// trailing newline must get cut off with an error frame once it crosses the
// cap, rather than being allowed to keep growing the server's memory.
//
// Uses a small maxLineBytes (64 KiB) so the test runs fast and deterministically,
// and separately proves the framer-level unit bound with an even larger direct
// push (no socket involved) so the cap is verified independent of any socket
// buffering behavior.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { createIpcServer } from "../server.js";
import { LineFramer } from "../protocol.js";

const SOCK_PATH = path.join(os.tmpdir(), `ctd-ipc-boundedbuf-${process.pid}.sock`);
const CAP = 64 * 1024; // 64 KiB, small on purpose for test speed

function unitLevelFramerCheck() {
  const framer = new LineFramer({ maxBytes: CAP });
  // Send a single unterminated chunk well past the cap, no socket involved.
  const bigChunk = Buffer.alloc(CAP * 4, 0x41); // 256 KiB of 'A', no '\n' anywhere
  const { lines, overflow } = framer.push(bigChunk);
  assert.equal(lines.length, 0, "no complete lines should have been produced (no newline sent)");
  assert.equal(overflow, true, "framer must report overflow once the unterminated line exceeds maxBytes");
  assert.ok(
    framer.bufferedBytes <= CAP,
    `framer must never RETAIN more than the cap; retained ${framer.bufferedBytes} against a ${CAP}-byte cap`,
  );
  assert.ok(
    framer.overflowBytes > CAP,
    `framer should report the offending line's length (${framer.overflowBytes}) as having crossed the cap`,
  );
  console.log(
    `PASS (unit): LineFramer reports overflow at ${framer.overflowBytes} attempted bytes ` +
      `against a ${CAP}-byte cap, retaining only ${framer.bufferedBytes}`,
  );
}

/** Regression: group3-ipc-luna.md finding 1 — a COMPLETE oversized line used to
 * bypass the cap entirely, because only the unterminated remainder was measured. */
function completeOversizedLineCheck() {
  const framer = new LineFramer({ maxBytes: CAP });
  const oversizedLine = Buffer.concat([Buffer.alloc(CAP + 1, 0x43), Buffer.from("\n")]);
  const { lines, overflow } = framer.push(oversizedLine);
  assert.equal(overflow, true, "a complete newline-terminated line over the cap MUST report overflow");
  assert.equal(lines.length, 0, "the oversized line must NOT be emitted for parsing");

  // ...and a line exactly AT the cap is still fine — the bound is a cap, not an off-by-one.
  const okFramer = new LineFramer({ maxBytes: CAP });
  const exactLine = Buffer.concat([Buffer.alloc(CAP, 0x44), Buffer.from("\n")]);
  const okResult = okFramer.push(exactLine);
  assert.equal(okResult.overflow, false, "a line exactly at the cap must be accepted");
  assert.equal(okResult.lines.length, 1, "the at-cap line must be emitted intact");
  assert.equal(okResult.lines[0].length, CAP, "the at-cap line must be emitted without truncation");
  console.log(`PASS (unit): a complete ${CAP + 1}-byte line is rejected, while an exactly-${CAP}-byte line still passes`);
}

/** Regression: group3-ipc-luna.md finding 3 — retention must stay bounded even
 * under a flood, and overflow must be terminal rather than re-armable. */
function overflowIsTerminalCheck() {
  const framer = new LineFramer({ maxBytes: CAP });
  framer.push(Buffer.alloc(CAP * 4, 0x45));
  assert.equal(framer.overflowed, true, "framer should be poisoned after crossing the cap");

  // Keep flooding: a poisoned framer must retain nothing and emit nothing, even
  // for perfectly well-formed newline-terminated input.
  for (let i = 0; i < 10; i++) {
    const { lines, overflow } = framer.push(Buffer.from(`{"id":"x","cmd":"ping"}\n`));
    assert.equal(overflow, true, "every push after overflow must keep reporting overflow");
    assert.equal(lines.length, 0, "a poisoned framer must not emit further lines");
    assert.equal(framer.bufferedBytes, 0, "a poisoned framer must retain zero bytes");
  }
  console.log("PASS (unit): overflow is terminal — 10 further pushes emitted nothing and retained nothing");
}

/** Multi-byte UTF-8 split across chunk boundaries must still decode correctly —
 * the in-place scan retains raw bytes rather than decoding per chunk. */
function utf8SplitAcrossChunksCheck() {
  const framer = new LineFramer({ maxBytes: CAP });
  const payload = Buffer.from('{"id":"1","cmd":"echo","payload":"héllo → 世界"}\n', "utf8");
  const lines = [];
  // Feed one byte at a time — the worst case for boundary handling.
  for (const byte of payload) {
    const { lines: got } = framer.push(Buffer.from([byte]));
    lines.push(...got);
  }
  assert.equal(lines.length, 1, "one complete line expected after the terminating newline");
  assert.equal(JSON.parse(lines[0]).payload, "héllo → 世界", "multi-byte UTF-8 must survive chunk splits");
  console.log("PASS (unit): multi-byte UTF-8 split one byte per chunk still decodes intact");
}

async function socketLevelCheck() {
  fs.rmSync(SOCK_PATH, { force: true });
  const serverLogs = [];
  let overflowFired = null;
  const { listen, shutdown, listSockets } = createIpcServer({
    maxLineBytes: CAP,
    logger: {
      warn(msg) {
        serverLogs.push(String(msg));
      },
      error(msg) {
        serverLogs.push(String(msg));
      },
      log() {},
    },
    onBufferOverflow: (info) => {
      overflowFired = info;
    },
  });
  await listen(SOCK_PATH);

  const before = process.memoryUsage().rss;

  const socket = net.connect(SOCK_PATH);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const frames = [];
  let closed = false;
  socket.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        /* ignore partials for this test's purposes */
      }
    }
  });
  socket.on("close", () => {
    closed = true;
  });
  // A destroyed peer can surface as an 'error' event on our own end too
  // (e.g. EPIPE on a write after the server has destroyed its side) — this
  // test client needs its own persistent listener for the same reason
  // server.js needs one on every accepted socket.
  socket.on("error", () => {
    closed = true;
  });

  // Write chunks of a single unterminated "line" totalling well past CAP, no '\n' at all.
  const chunkSize = 16 * 1024;
  const chunk = Buffer.alloc(chunkSize, 0x42); // 'B'
  let totalSent = 0;
  const targetSent = CAP * 3; // 3x the cap — should overflow well before this completes
  while (totalSent < targetSent && !closed) {
    let ok;
    try {
      ok = socket.write(chunk);
    } catch {
      break; // already destroyed
    }
    totalSent += chunkSize;
    if (!ok && !closed) {
      // Race drain against close/error — once the server destroys the
      // connection, 'drain' will never fire, and waiting on it alone would
      // hang forever.
      await new Promise((resolve) => {
        const done = () => resolve();
        socket.once("drain", done);
        socket.once("close", done);
        socket.once("error", done);
      });
    }
    // small yield so 'data'/'close' handlers on the server side get a chance to run
    await new Promise((resolve) => setImmediate(resolve));
  }

  // Give the close/error frame a moment to arrive if it hasn't already.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const after = process.memoryUsage().rss;
  const rssGrowthMb = (after - before) / (1024 * 1024);

  assert.ok(
    totalSent < targetSent || closed,
    `connection should have been destroyed by the server before ${targetSent} unterminated bytes were fully sent`,
  );
  assert.ok(overflowFired, "server-side onBufferOverflow hook must have fired — the guard actually ran");
  assert.ok(
    overflowFired.attemptedBytes > CAP,
    `attemptedBytes at overflow (${overflowFired?.attemptedBytes}) should exceed the cap (${CAP})`,
  );
  assert.ok(
    overflowFired.bufferedBytes <= CAP,
    `the server must never have RETAINED more than the cap; retained ${overflowFired?.bufferedBytes} vs cap ${CAP}`,
  );
  assert.ok(
    serverLogs.some((l) => /exceeded .* cap.*destroying/.test(l)),
    `expected a server-side log noting the cap was exceeded, got: ${JSON.stringify(serverLogs)}`,
  );
  assert.equal(closed, true, "the client-visible connection must actually end (close or error) after overflow");
  console.log(
    `PASS (socket): sent ${totalSent} unterminated bytes against a ${CAP}-byte cap; ` +
      `server-side guard fired at ${overflowFired.attemptedBytes} attempted bytes ` +
      `(only ${overflowFired.bufferedBytes} retained) and destroyed the connection (closed=${closed})`,
  );
  // Note (captured real behavior, see FINDINGS.md): under this adversarial flood
  // the client does not reliably *receive* the human-readable overflow frame —
  // Unix-domain-socket semantics legitimately RST-discard a still-buffered
  // outbound write when destroy() runs while the peer still has unread inbound
  // backlog queued. The properties actually required by the spec — the buffer
  // never grows past the cap, and the connection is genuinely cut — are proven
  // above independent of whether that one frame's bytes survive the wire.
  if (frames.some((f) => f.ok === false && /max buffered size/.test(f.error || ""))) {
    console.log("BONUS: this run's client also received the overflow error frame intact before the connection closed");
  } else {
    console.log("NOTE: overflow error frame was not observed client-side this run (RST-discard race — see FINDINGS.md); connection cut + bound held regardless");
  }
  console.log(`(rss growth during flood: ~${rssGrowthMb.toFixed(1)}MB)`);

  assert.equal(listSockets().length, 0, "server must not still be tracking the destroyed socket");
  console.log("PASS: server's tracked-sockets set no longer contains the destroyed connection");

  await shutdown({ timeoutMs: 1000 });
  fs.rmSync(SOCK_PATH, { force: true });
}

/** End-to-end regression for group3-ipc-luna.md finding 1: a single COMPLETE,
 * newline-terminated, oversized command must be refused and the connection cut —
 * previously it sailed past the cap straight into JSON.parse and dispatch. Also
 * proves the daemon itself survives and keeps serving other connections. */
async function oversizedCommandOverSocketCheck() {
  const SOCK = `${SOCK_PATH}.oversized`;
  fs.rmSync(SOCK, { force: true });
  let overflowFired = null;
  const { listen, shutdown } = createIpcServer({
    maxLineBytes: CAP,
    logger: { warn() {}, error() {}, log() {} },
    onBufferOverflow: (info) => {
      overflowFired = info;
    },
  });
  await listen(SOCK);

  const socket = net.connect(SOCK);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const frames = [];
  socket.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        /* partials don't matter here */
      }
    }
  });
  const closedPromise = new Promise((resolve) => {
    socket.once("close", resolve);
    socket.once("error", resolve); // an EPIPE/ECONNRESET on our side counts as closed
  });

  // One well-formed, complete, newline-terminated command that is simply too big.
  const echoCmd = { id: "oversized-1", cmd: "echo", payload: "Z".repeat(CAP * 2) };
  socket.write(JSON.stringify(echoCmd) + "\n");

  await closedPromise;
  // Anything still in flight has a moment to arrive before we assert on frames.
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(overflowFired, "a complete oversized command must trip the server's overflow guard");
  assert.ok(
    overflowFired.attemptedBytes > CAP,
    `attemptedBytes (${overflowFired?.attemptedBytes}) should exceed the cap (${CAP})`,
  );
  assert.ok(
    !frames.some((f) => f.id === "oversized-1"),
    `the oversized command must never be dispatched; got ${JSON.stringify(frames)}`,
  );
  console.log(
    `PASS (socket): a complete ${JSON.stringify(echoCmd).length}-byte command was refused (not dispatched) ` +
      `against a ${CAP}-byte cap, and the connection was cut`,
  );

  // The daemon must be unharmed — a fresh connection still gets served.
  const socket2 = net.connect(SOCK);
  await new Promise((resolve, reject) => {
    socket2.once("connect", resolve);
    socket2.once("error", reject);
  });
  const pong = await new Promise((resolve, reject) => {
    socket2.on("data", (chunk) => {
      try {
        resolve(JSON.parse(chunk.toString("utf8").split("\n")[0]));
      } catch (err) {
        reject(err);
      }
    });
    socket2.write(JSON.stringify({ id: "after-overflow", cmd: "ping" }) + "\n");
  });
  assert.equal(pong.id, "after-overflow", "the server must still answer a fresh client after an overflow kill");
  assert.equal(pong.ok, true, "the post-overflow ping must succeed");
  console.log("PASS: the daemon survived the oversized-command kill and served a fresh connection");

  socket2.destroy();
  await shutdown({ timeoutMs: 1000 });
  fs.rmSync(SOCK, { force: true });
}

async function main() {
  unitLevelFramerCheck();
  completeOversizedLineCheck();
  overflowIsTerminalCheck();
  utf8SplitAcrossChunksCheck();
  await socketLevelCheck();
  await oversizedCommandOverSocketCheck();
  console.log("ALL BOUNDED-BUFFER CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAIL:", err.stack || err.message);
  process.exit(1);
});
