// cto-model.test.js — PLAN.md §8 Rule 6's cheap-resident/single-decision-escalation primitive
// (Phase 8), pure.
//
// See `cto-model.js`'s own header for why there is no `runtime/supervisor.js` wiring for this yet — the
// CTO role has no real runtime presence in this codebase (confirmed by grep before writing either file).
//
// Cases:
//   1. escalate: false (or omitted) returns the resident default UNCHANGED
//   2. escalate: true returns the escalate model/effort for this call only
//   3. escalate: true with no escalateEffort falls back to the resident base effort
//   4. escalate: true with no escalateModel is refused (thrown), not guessed

import assert from "node:assert/strict";
import { resolveModelForDecision } from "../cto-model.js";

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
testCase("escalate: false (or omitted) returns the resident default unchanged", () => {
  assert.deepEqual(
    resolveModelForDecision({ baseModel: "haiku", baseEffort: "low" }),
    { model: "haiku", effort: "low", escalated: false },
  );
  assert.deepEqual(
    resolveModelForDecision({ baseModel: "haiku", baseEffort: "low", escalate: false, escalateModel: "opus" }),
    { model: "haiku", effort: "low", escalated: false },
  );
});

// ── 2 ────────────────────────────────────────────────────────────────────────────────────
testCase("escalate: true returns the escalate model/effort for this call only", () => {
  assert.deepEqual(
    resolveModelForDecision({ baseModel: "haiku", baseEffort: "low", escalate: true, escalateModel: "opus", escalateEffort: "high" }),
    { model: "opus", effort: "high", escalated: true },
  );
});

// ── 3 ────────────────────────────────────────────────────────────────────────────────────
testCase("escalate: true with no escalateEffort falls back to the resident base effort", () => {
  const result = resolveModelForDecision({ baseModel: "haiku", baseEffort: "low", escalate: true, escalateModel: "opus" });
  assert.deepEqual(result, { model: "opus", effort: "low", escalated: true });
});

// ── 4 ────────────────────────────────────────────────────────────────────────────────────
testCase("escalate: true with no escalateModel is refused (thrown), not guessed", () => {
  assert.throws(
    () => resolveModelForDecision({ baseModel: "haiku", baseEffort: "low", escalate: true }),
    /requires escalateModel/,
  );
});

if (failed > 0) {
  console.error(`\nFAIL: cto-model (${failed}/${n} failed)`);
  process.exit(1);
}
console.log(`\nPASS: cto-model (${n}/${n})`);
