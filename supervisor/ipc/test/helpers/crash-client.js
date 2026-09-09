// crash-client.js — a real separate OS process, started by
// resilience-peer-crash.test.js and killed with SIGKILL mid-stream so the
// parent process's server sees a genuine ECONNRESET on an in-flight write, not
// a simulated one. Deliberately minimal: connect, start a run, observe it
// (which makes the server actively write to this socket every ~15-45ms), and
// then just sit there until the parent kills -9 this whole process.

import net from "node:net";

const sockPath = process.argv[2];
const socket = net.connect(sockPath);

// Strategy to force a REAL ECONNRESET/EPIPE on the server's side (proven
// empirically to require actual send-buffer backpressure, not just a couple
// of small frames — see FINDINGS.md for the raw-socket experiment that
// established this): ask the server to echo back a large payload many times
// in a pipelined burst, using the id-correlated wire protocol itself (each
// request carries a distinct id, echoed back per protocol.js), then
// immediately stop reading (pause) so every one of those large responses
// piles up UNREAD in this process's own kernel receive buffer. Getting
// SIGKILL'd with that much unread backlog queued is what makes the OS tear
// the connection down with an error the server's write() surfaces, instead of
// a clean FIN.

const BIG_PAYLOAD = "x".repeat(64 * 1024); // 64 KiB per echo response
const BURST_COUNT = 40; // ~2.5MB of responses queued, then left unread

socket.on("connect", () => {
  for (let i = 0; i < BURST_COUNT; i++) {
    socket.write(JSON.stringify({ id: `echo-${i}`, cmd: "echo", payload: BIG_PAYLOAD }) + "\n");
  }
  process.stdout.write("READY\n"); // parent watches stdout for this line
  // Stop draining entirely from here on — every byte of those BURST_COUNT
  // responses queues up unread until the parent SIGKILLs this process.
  socket.pause();
});

socket.on("error", () => {
  /* swallow — we're about to be killed anyway; the point is the OTHER end's survival */
});

// Never exit on our own — the parent kills us with SIGKILL.
setInterval(() => {}, 1000);
