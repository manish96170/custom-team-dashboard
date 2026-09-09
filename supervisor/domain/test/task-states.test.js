// task-states.test.js — the task state machine (PLAN.md section 6), Phase 5.
//
// Every case is pure: no database, no supervisor, no harness. The point of extracting section 6 into a
// data-driven module is that its whole diagram becomes assertable, including the guards — which is what
// turns "every transition needs a named actor and a guard, recorded in `transition_journal` — not just a
// diagram edge" from a sentence in a design doc into something that fails a test when it stops being
// true.
//
// The three cases that matter most are 5, 6 and 7: the guards that cannot be skipped. An edge that is
// merely wrong gets caught the first time someone tries it; a guard that quietly stops applying does
// not, because the happy path still works.
//
// Cases:
//   1. the happy path from `created` to `merged` is walkable
//   2. an unknown state is refused, and the refusal names the valid set
//   3. `failed` and `cancelled` leave EVERY in-flight state
//   4. `blocked` is reachable only from `implementing`, and returns there
//   5. NO AUTONOMOUS MERGES — `merged` requires an explicit human approval
//   6. coming back from a failure is explicit, never automatic
//   7. `approved` respects the reviewer-verdict count when it is supplied
//   8. `blocked` cannot be entered without an open ask, or left with one still open
//   9. a no-op transition is refused (it would be a duplicate journal entry)
//  10. `autoBlockTarget` only moves `implementing` <-> `blocked`, nothing else
//  11. every state is reachable, and every edge points at a real state (the table is coherent)
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import {
  STATES, IN_FLIGHT, TERMINAL,
  isState, isInFlight, isTerminal,
  nextStates, canTransition, autoBlockTarget,
} from "../task-states.js";

let failed = 0;
let n = 0;
/**
 * Print in the project's NUMBERED convention ("  3. name") and re-print the WHOLE error on failure.
 *
 * Both matter to the mutation harness rather than to a human reader: `_mutate-runner.mjs` locates the
 * broken case by scanning for `^  N.` lines, and it only credits a mutation as caught when the output
 * contains a real `AssertionError`. An earlier version of this file printed "PASS <name>" and only
 * `err.message`, so every mutation was reported as a crash at case 1 — proving nothing. Same trap as
 * FINDINGS section 22.1, one file later.
 */
function testCase(name, fn) {
  n += 1;
  try { fn(); console.log(`  ${n}. ${name}`); } catch (err) {
    failed += 1;
    // `FAIL: <name>` exactly, because that is the form `_mutate-runner.mjs` matches for `breaksCase`.
    // The runner's other mechanism -- "the last numbered line printed is the last case that passed" --
    // does NOT work for this file: it keeps going after a failure, so later cases still print numbers
    // and the arithmetic overshoots. Naming the case is the reliable attribution here.
    console.error(`  FAIL: ${name}`);
    console.error(err);
  }
}

const A = { actor: "tester" };
const ok = (from, to, ctx = {}) => {
  const v = canTransition(from, to, { ...A, ...ctx });
  assert.equal(v.ok, true, `${from} -> ${to} should be legal, refused: ${v.reason}`);
};
const no = (from, to, ctx = {}, match = null) => {
  const v = canTransition(from, to, { ...A, ...ctx });
  assert.equal(v.ok, false, `${from} -> ${to} should be refused, but was allowed`);
  if (match) assert.match(v.reason, match, `refusal reason should explain itself; got: ${v.reason}`);
};

// ── 1 ────────────────────────────────────────────────────────────────────────────────────
testCase("the happy path created -> merged is walkable", () => {
  ok(null, "created");
  ok("created", "starting");
  ok("starting", "planning");
  ok("planning", "implementing");
  ok("implementing", "awaiting-review");
  ok("awaiting-review", "fixing");
  ok("fixing", "awaiting-review");
  ok("awaiting-review", "approved", { reviewerVerdicts: 2 });
  ok("approved", "merged", { humanApproved: true });
  assert.equal(isTerminal("merged"), true, "and merged is terminal");
  assert.deepEqual(nextStates("merged"), [], "with nowhere to go");
});

// ── 2 ────────────────────────────────────────────────────────────────────────────────────
testCase("an unknown state is refused, and names the valid set", () => {
  // The exact drift this module was written to stop: these were in the project's own tests.
  no("created", "in-progress", {}, /is not a task state/);
  no("in-review", "approved", {}, /is not a task state/);
  const v = canTransition("created", "nonsense", A);
  assert.ok(v.reason.includes("implementing"), "the refusal lists the real states, so the fix is obvious");
  assert.equal(isState("in-progress"), false);
  // An actor is not optional — section 6's own words.
  no("created", "starting", { actor: undefined }, /named actor/);
});

// ── 3 ────────────────────────────────────────────────────────────────────────────────────
// Section 6: "a run can error at any in-flight state" and "an explicit cancel can happen at any point".
testCase("failed and cancelled leave every in-flight state", () => {
  for (const from of IN_FLIGHT) {
    ok(from, "failed");
    ok(from, "cancelled");
  }
  // But NOT from states that are not in flight — a task nobody has started cannot fail mid-run.
  no("created", "failed", {}, /not an edge/);
  no("merged", "cancelled", {}, /not an edge/);
});

// ── 4 ────────────────────────────────────────────────────────────────────────────────────
// Section 6: blocked is "only reachable from `implementing`". Widening it is explicitly deferred until
// real usage shows otherwise, so the narrowness is the behaviour under test.
testCase("blocked is reachable only from implementing, and returns there", () => {
  ok("implementing", "blocked", { askOpen: true });
  for (const from of ["planning", "awaiting-review", "fixing"]) {
    no(from, "blocked", { askOpen: true }, /not an edge/);
  }
  ok("blocked", "implementing", { askOpen: false });
  // A blocked run can still die or be cancelled.
  ok("blocked", "failed");
  ok("blocked", "cancelled");
  no("blocked", "awaiting-review", {}, /not an edge/);
});

// ── 5 ────────────────────────────────────────────────────────────────────────────────────
// Section 6: "merged requires an explicit human/senior approval gate — no autonomous merges, even with
// all reviews green. This is a hard rule, not a default that can be silently skipped."
testCase("NO AUTONOMOUS MERGES — merged needs an explicit human approval", () => {
  no("approved", "merged", {}, /no autonomous merges/);
  no("approved", "merged", { humanApproved: false }, /no autonomous merges/);
  // Green reviews are not approval. This is the case the rule exists for.
  no("approved", "merged", { reviewerVerdicts: 99 }, /no autonomous merges/);
  ok("approved", "merged", { humanApproved: true });
  // And it is not reachable by a shortcut from anywhere else.
  for (const from of STATES.filter((x) => x !== "approved")) {
    no(from, "merged", { humanApproved: true }, /not an edge|not a task state|already in/);
  }
});

// ── 6 ────────────────────────────────────────────────────────────────────────────────────
// Section 6: both can transition back to created "via an explicit human/CTO action, never
// automatically". An automatic retry loop is the failure mode.
testCase("coming back from a failure is explicit, never automatic", () => {
  for (const from of ["failed", "cancelled", "start-failed"]) {
    no(from, "created", {}, /must be explicit, never automatic/);
    ok(from, "created", { explicitRetry: true });
  }
});

// ── 7 ────────────────────────────────────────────────────────────────────────────────────
testCase("approved respects the reviewer-verdict count when supplied", () => {
  no("awaiting-review", "approved", { reviewerVerdicts: 1 }, /needs 2 reviewer verdict/);
  ok("awaiting-review", "approved", { reviewerVerdicts: 2 });
  ok("awaiting-review", "approved", { reviewerVerdicts: 1, requiredVerdicts: 1 });
  // Left alone when the caller does not supply a count: section 13 owns verdict counting, and
  // duplicating it here would give two answers to one question.
  ok("awaiting-review", "approved");
});

// ── 8 ────────────────────────────────────────────────────────────────────────────────────
testCase("blocked must match reality in both directions", () => {
  no("implementing", "blocked", { askOpen: false }, /there is none/);
  no("blocked", "implementing", { askOpen: true }, /still unresolved/);
  ok("implementing", "blocked", { askOpen: true });
  ok("blocked", "implementing", { askOpen: false });
});

// ── 9 ────────────────────────────────────────────────────────────────────────────────────
testCase("a no-op transition is refused", () => {
  for (const s of STATES) no(s, s, { humanApproved: true, explicitRetry: true }, /already in/);
});

// ── 10 ───────────────────────────────────────────────────────────────────────────────────
testCase("autoBlockTarget only moves implementing <-> blocked", () => {
  assert.equal(autoBlockTarget("implementing", { askOpen: true }), "blocked");
  assert.equal(autoBlockTarget("blocked", { askOpen: false }), "implementing");
  assert.equal(autoBlockTarget("implementing", { askOpen: false }), null, "no ask, no move");
  assert.equal(autoBlockTarget("blocked", { askOpen: true }), null, "still blocked, no move");
  // An ask arriving while planning must NOT drag the task into blocked — section 6 restricts the state
  // to `implementing`, and widening it silently would be pre-designing for a case with no evidence.
  for (const s of ["created", "starting", "planning", "awaiting-review", "fixing", "approved", "merged"]) {
    assert.equal(autoBlockTarget(s, { askOpen: true }), null, `${s} must not auto-block`);
  }
});

// ── 11 ───────────────────────────────────────────────────────────────────────────────────
// A coherence check on the table itself. Cheap, and it catches the typo that would otherwise present
// as a mysteriously unreachable state months later.
testCase("the edge table is coherent: every edge points at a real state, every state reachable", () => {
  for (const from of STATES) {
    for (const to of nextStates(from)) {
      assert.ok(isState(to), `edge ${from} -> ${to} points at a state that does not exist`);
    }
  }
  const reachable = new Set(["created"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const from of [...reachable]) {
      for (const to of nextStates(from)) if (!reachable.has(to)) { reachable.add(to); grew = true; }
    }
  }
  const unreachable = STATES.filter((s) => !reachable.has(s));
  assert.deepEqual(unreachable, [], `every state must be reachable from created; unreachable: ${unreachable}`);
  // And the three sets agree with each other.
  for (const s of IN_FLIGHT) assert.equal(isInFlight(s), true);
  for (const s of TERMINAL) assert.equal(isTerminal(s), true);
  assert.deepEqual(IN_FLIGHT.filter((s) => isTerminal(s)), [], "no state is both in-flight and terminal");
});

if (failed > 0) {
  console.error(`\n${failed} task-state case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: task state machine");
