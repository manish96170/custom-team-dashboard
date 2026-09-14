// clear-policy.test.js — the pure decision half of Phase 8's clear-policy work (PLAN.md §8 Rule 5).
//
// Every case is pure: no database, no supervisor, no harness. See `clear-policy.js`'s own header for
// WHERE each policy -> trigger mapping came from (a real call site in `runtime/supervisor.js`, not a
// guess) — this file only asserts the mapping itself is applied correctly.
//
// Cases:
//   1. "on-state-transition" clears on "state-transition", nothing else
//   2. "per-review-round" clears on "review-round-concluded", nothing else
//   3. "always" clears on "turn-end", nothing else
//   4. "on-demand" never clears automatically — not even on "demand" itself, since nothing in this
//      module should ever raise that trigger on its own; it exists only so the function has an answer
//   5. a harness with clearContextCapability: false never clears, regardless of policy/trigger
//   6. an unknown clearPolicy is refused, and the refusal names the valid set
//   7. an unknown trigger is refused, and the refusal names the valid set
//   8. every refusal names a reason — never "clear: false" with nothing to act on

import assert from "node:assert/strict";
import { decideClear, CLEAR_TRIGGERS } from "../clear-policy.js";
import { CLEAR_POLICIES } from "../../config/harness-defaults.js";

let failed = 0;
let n = 0;
function testCase(name, fn) {
  n += 1;
  try {
    fn();
    console.log(`  ${n}. ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ${n}. FAILED — ${name}`);
    console.error(err);
  }
}

// ── 1 ────────────────────────────────────────────────────────────────────────────────────
testCase('"on-state-transition" clears on "state-transition", nothing else', () => {
  assert.equal(decideClear({ clearPolicy: "on-state-transition", trigger: "state-transition", clearContextCapability: "erase" }).clear, true);
  for (const trigger of ["review-round-concluded", "turn-end", "demand"]) {
    const result = decideClear({ clearPolicy: "on-state-transition", trigger, clearContextCapability: "erase" });
    assert.equal(result.clear, false, `must not clear on "${trigger}"`);
    assert.match(result.reason, /fires on "state-transition"/);
  }
});

// ── 2 ────────────────────────────────────────────────────────────────────────────────────
testCase('"per-review-round" clears on "review-round-concluded", nothing else', () => {
  assert.equal(decideClear({ clearPolicy: "per-review-round", trigger: "review-round-concluded", clearContextCapability: "compact" }).clear, true);
  for (const trigger of ["state-transition", "turn-end", "demand"]) {
    const result = decideClear({ clearPolicy: "per-review-round", trigger, clearContextCapability: "erase" });
    assert.equal(result.clear, false, `must not clear on "${trigger}"`);
  }
});

// ── 3 ────────────────────────────────────────────────────────────────────────────────────
testCase('"always" clears on "turn-end", nothing else', () => {
  assert.equal(decideClear({ clearPolicy: "always", trigger: "turn-end", clearContextCapability: "erase" }).clear, true);
  for (const trigger of ["state-transition", "review-round-concluded", "demand"]) {
    const result = decideClear({ clearPolicy: "always", trigger, clearContextCapability: "erase" });
    assert.equal(result.clear, false, `must not clear on "${trigger}"`);
  }
});

// ── 4 ────────────────────────────────────────────────────────────────────────────────────
// "on-demand" DOES answer `true` for its own "demand" trigger — that is what makes the already-built
// `clearContext(runId)` wire command "on demand" rather than dead. The real guarantee is elsewhere: no
// AUTOMATIC call site in `runtime/supervisor.js` ever raises `trigger: "demand"` on its own (see
// `clear-policy.js`'s own header) — this module cannot enforce that from here, since it has no notion of
// "automatic" versus "an explicit command a human just ran".
testCase('"on-demand" clears on "demand" but on nothing else', () => {
  assert.equal(decideClear({ clearPolicy: "on-demand", trigger: "demand", clearContextCapability: "erase" }).clear, true);
  for (const trigger of ["state-transition", "review-round-concluded", "turn-end"]) {
    const result = decideClear({ clearPolicy: "on-demand", trigger, clearContextCapability: "erase" });
    assert.equal(result.clear, false, `"on-demand" must not clear automatically on "${trigger}"`);
  }
});

// ── 5 ────────────────────────────────────────────────────────────────────────────────────
testCase("a harness declaring clearContext: false never clears, regardless of policy/trigger", () => {
  for (const clearPolicy of CLEAR_POLICIES) {
    for (const trigger of CLEAR_TRIGGERS) {
      const result = decideClear({ clearPolicy, trigger, clearContextCapability: false });
      assert.equal(result.clear, false, `${clearPolicy}/${trigger} must not clear with no capability`);
      assert.match(result.reason, /clearContext: false/);
    }
  }
});

// ── 6 ────────────────────────────────────────────────────────────────────────────────────
testCase("an unknown clearPolicy is refused, and the refusal names the valid set", () => {
  const result = decideClear({ clearPolicy: "whenever-i-feel-like-it", trigger: "turn-end", clearContextCapability: "erase" });
  assert.equal(result.clear, false);
  for (const p of CLEAR_POLICIES) assert.ok(result.reason.includes(p), `reason must name "${p}"`);
});

// ── 7 ────────────────────────────────────────────────────────────────────────────────────
testCase("an unknown trigger is refused, and the refusal names the valid set", () => {
  const result = decideClear({ clearPolicy: "always", trigger: "eclipse", clearContextCapability: "erase" });
  assert.equal(result.clear, false);
  for (const t of CLEAR_TRIGGERS) assert.ok(result.reason.includes(t), `reason must name "${t}"`);
});

// ── 8 ────────────────────────────────────────────────────────────────────────────────────
testCase('every refusal names a reason — never "clear: false" with nothing to act on', () => {
  for (const clearPolicy of [...CLEAR_POLICIES, "bogus"]) {
    for (const trigger of [...CLEAR_TRIGGERS, "bogus"]) {
      for (const clearContextCapability of ["erase", "compact", false, undefined]) {
        const result = decideClear({ clearPolicy, trigger, clearContextCapability });
        if (!result.clear) assert.ok(result.reason && result.reason.length > 0, `${clearPolicy}/${trigger}/${clearContextCapability} refused with no reason`);
      }
    }
  }
});

if (failed > 0) {
  console.error(`\n${failed} clear-policy case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: clear-policy decision module");
