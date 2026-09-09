// Minimal test assertion helper. Every check must throw (and therefore, via the
// runner in each test file's own try/catch -> process.exit(1), fail the process)
// on failure — no test in this directory is allowed to print-and-exit-0 on a
// broken assertion, unlike spike-0b's proof scripts.

export function assert(cond, message) {
  if (!cond) {
    throw new Error(`assertion failed: ${message}`);
  }
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }
}
