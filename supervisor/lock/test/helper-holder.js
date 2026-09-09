// Subprocess helper used by race/stale/graceful tests. Attempts to acquire the
// lock at process.argv[2], prints the result as one line of JSON, then:
//   - if acquired and CTD_HOLD_MS is set, holds the lock for that long, then
//     releases and prints a second JSON line, then exits 0.
//   - if acquired and CTD_HOLD_MS is NOT set, holds indefinitely and releases
//     cleanly on SIGTERM/SIGINT (for the graceful-release test), printing a
//     "released" line before exiting 0.
//   - if not acquired, exits 0 immediately (contention is an expected, non-error
//     outcome for this helper; the orchestrator is what asserts on the shape of
//     the results across all helpers).
import { acquireLock } from "../lock.js";

const lockPath = process.argv[2];
const holdMs = process.env.CTD_HOLD_MS ? Number(process.env.CTD_HOLD_MS) : null;

async function main() {
  const result = await acquireLock(lockPath);
  console.log(JSON.stringify({ pid: process.pid, ...result, release: undefined }));

  if (!result.acquired) {
    process.exit(0);
  }

  if (holdMs !== null) {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await result.release();
    console.log(JSON.stringify({ pid: process.pid, released: true }));
    process.exit(0);
  }

  // Hold indefinitely; release on signal.
  const shutdown = async (sig) => {
    await result.release();
    console.log(JSON.stringify({ pid: process.pid, released: true, signal: sig }));
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Keep the event loop alive without busy-waiting.
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error(JSON.stringify({ pid: process.pid, error: String(err && err.message || err) }));
  process.exit(1);
});
