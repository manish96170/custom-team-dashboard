// _helpers.js — shared pass/fail contract for supervisor/runtime/test/*.test.js.
// Same standing rule as db/test/_helpers.js: a test script here may never print output
// and exit 0 regardless of outcome (TODO.md Group 6 note).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * How many `assistant.delta` events `_fake-harness-child.js` emits per turn.
 *
 * Declared HERE rather than in the child, because the child is a script: importing it for a constant
 * runs it, which emits fake harness events into the importer's own stdout and installs its
 * stay-resident interval. (Tried it; the events showed up in a test's output.) The child imports this
 * value, so there is still exactly one definition.
 *
 * Fixed on purpose: the suites that do exact per-run event accounting (concurrency's anti-crosstalk
 * and no-loss checks) cannot work against a delta count that varies with the length of a prompt.
 */
export const DELTAS_PER_TURN = 3;

export function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function rmScratchDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export async function runTest(name, main) {
  try {
    await main();
    console.log(`\nPASS: ${name}`);
    process.exit(0);
  } catch (err) {
    console.error(`\nFAIL: ${name}`);
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `fn()` is truthy or the deadline passes. Returns the truthy value or throws. */
export async function waitFor(fn, { timeoutMs = 5000, pollMs = 20, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) {
      // An AssertionError, not a plain Error. A timeout here IS an assertion failure -- "this
      // never became true" -- and the distinction is load-bearing rather than cosmetic: the
      // mutation harness only credits a mutation as caught when the suite fails by ASSERTION,
      // because a mutation that merely crashes the module proves nothing (Group 5's lesson).
      // While this threw a plain Error, five of the approval harness's mutations were reported
      // as "caught by the assertion that protects them" when what actually happened was a
      // timeout or a TypeError. Found by the cross-model review of Phase 2 item 2.
      throw new assert.AssertionError({
        message: `timed out after ${timeoutMs}ms waiting for ${what}`,
        actual: v,
        expected: `a truthy value from the ${what} predicate`,
        operator: "waitFor",
      });
    }
    await sleep(pollMs);
  }
}
