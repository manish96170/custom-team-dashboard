// session-intent.test.js — PLAN.md §7's clean-vs-kill rule (Phase 8), pure.
//
// Every case is pure: no database, no supervisor, no adapter. See `session-intent.js`'s own header for
// why this is a structured-signal function and not a natural-language classifier.
//
// Cases:
//   1. "clear" (the default, and an explicit "clear" request) always succeeds as "clear"
//   2. "kill-respawn" WITHOUT explicitKillConfirmed: true is refused down to "clear", and the refusal
//      names why
//   3. "kill-respawn" WITH explicitKillConfirmed: true succeeds as "kill-respawn"
//   4. a truthy-but-not-literal-true confirmation ("true" the string, 1) is treated as unconfirmed —
//      never inferred, never coerced
//   5. an unrecognized requestedAction defaults to the safe "clear" path, named as a caller error

import assert from "node:assert/strict";
import { classifySessionAction, SESSION_ACTIONS } from "../session-intent.js";

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
testCase('"clear" (the default, and an explicit request) always succeeds as "clear"', () => {
  assert.deepEqual(classifySessionAction({}), { action: "clear" });
  assert.deepEqual(classifySessionAction({ requestedAction: "clear" }), { action: "clear" });
  assert.deepEqual(classifySessionAction({ requestedAction: "clear", explicitKillConfirmed: true }), { action: "clear" });
});

// ── 2 ────────────────────────────────────────────────────────────────────────────────────
testCase('"kill-respawn" without explicitKillConfirmed: true is refused down to "clear"', () => {
  for (const explicitKillConfirmed of [undefined, false, null]) {
    const result = classifySessionAction({ requestedAction: "kill-respawn", explicitKillConfirmed });
    assert.equal(result.action, "clear", `explicitKillConfirmed=${JSON.stringify(explicitKillConfirmed)} must not authorize a kill`);
    assert.match(result.refused, /requires explicitKillConfirmed: true/);
  }
});

// ── 3 ────────────────────────────────────────────────────────────────────────────────────
testCase('"kill-respawn" with explicitKillConfirmed: true succeeds as "kill-respawn"', () => {
  const result = classifySessionAction({ requestedAction: "kill-respawn", explicitKillConfirmed: true });
  assert.deepEqual(result, { action: "kill-respawn" });
});

// ── 4 ────────────────────────────────────────────────────────────────────────────────────
testCase('a truthy-but-not-literal-true confirmation is treated as unconfirmed, never coerced', () => {
  for (const explicitKillConfirmed of ["true", 1, "yes"]) {
    const result = classifySessionAction({ requestedAction: "kill-respawn", explicitKillConfirmed });
    assert.equal(result.action, "clear", `explicitKillConfirmed=${JSON.stringify(explicitKillConfirmed)} must not authorize a kill`);
  }
});

// ── 5 ────────────────────────────────────────────────────────────────────────────────────
testCase("an unrecognized requestedAction defaults to the safe \"clear\" path, named as a caller error", () => {
  const result = classifySessionAction({ requestedAction: "wipe-everything" });
  assert.equal(result.action, "clear");
  assert.match(result.refused, /not a recognized session action/);
  assert.ok(SESSION_ACTIONS.every((a) => result.refused.includes(a)), "the refusal must name the valid set");
});

if (failed > 0) {
  console.error(`\nFAIL: session-intent (${failed}/${n} failed)`);
  process.exit(1);
}
console.log(`\nPASS: session-intent (${n}/${n})`);
