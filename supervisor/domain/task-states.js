// task-states.js — the task state machine (PLAN.md section 6), as a PURE module. Phase 5.
//
// WHY THIS EXISTS AS ITS OWN FILE
//
// Until now `recordTransition` accepted any string as a state and only checked that the caller's
// `fromState` was not stale. So the diagram in PLAN.md section 6 was documentation, not a constraint,
// and the project's own tests had drifted to `in-progress` / `in-review` — names that appear nowhere in
// the design. A state machine nothing enforces is a naming convention.
//
// Everything here is pure and data-driven: the edges are a table, the guards are predicates over
// (from, to, context). That keeps the whole of section 6 assertable without a database, and it makes
// "is this edge legal" a question with one answer rather than one per caller.
//
// WHAT IS DELIBERATELY *NOT* HERE
//
// Section 6 is explicit that `superseded`, `reopened` and `merge-rejected` are not being added yet:
// "adopting all of them before a runtime exists to test any of them produces a large schema for a
// system that cannot run." Adding them speculatively is the one change this file should resist.

/** Every state a task can be in. Anything else is a typo, and is refused as one. */
export const STATES = Object.freeze([
  "created",
  "starting",
  "start-failed",
  "planning",
  "implementing",
  "blocked",
  "awaiting-review",
  "fixing",
  "approved",
  "merged",
  "failed",
  "cancelled",
]);

/**
 * The states a run can be actively working in.
 *
 * Named because three separate rules key off it: `failed` and `cancelled` are reachable from ANY of
 * them, `blocked` from exactly one, and nothing else. Writing the set once is what keeps those three
 * rules from drifting apart.
 */
export const IN_FLIGHT = Object.freeze(["planning", "implementing", "awaiting-review", "fixing"]);

/** Nothing proceeds from here without an explicit human/CTO action. */
export const TERMINAL = Object.freeze(["merged", "start-failed", "failed", "cancelled"]);

/**
 * The happy path plus its branches, exactly as section 6's diagram draws it.
 *
 * `blocked` has ONE way in (`implementing`) and one way back, which is why no "previous state" needs
 * storing: section 6 says blocked is "only reachable from `implementing`", so the return is unambiguous.
 * If real usage shows planning or awaiting-review generating asks too, section 6 says to widen it then
 * — "rather than pre-designing for a case with no evidence yet".
 */
const EDGES = Object.freeze({
  created: ["starting"],
  starting: ["planning", "start-failed"],
  "start-failed": ["created"],
  planning: ["implementing", ...IN_FLIGHT_EXITS()],
  implementing: ["awaiting-review", "blocked", ...IN_FLIGHT_EXITS()],
  blocked: ["implementing", "failed", "cancelled"],
  "awaiting-review": ["fixing", "approved", ...IN_FLIGHT_EXITS()],
  fixing: ["awaiting-review", ...IN_FLIGHT_EXITS()],
  approved: ["merged", "failed", "cancelled"],
  merged: [],
  failed: ["created"],
  cancelled: ["created"],
});

/** `failed` and `cancelled` leave every in-flight state — a run can crash or be stopped at any point. */
function IN_FLIGHT_EXITS() {
  return ["failed", "cancelled"];
}

export const isState = (s) => STATES.includes(s);
export const isInFlight = (s) => IN_FLIGHT.includes(s);
export const isTerminal = (s) => TERMINAL.includes(s);

/** Every state reachable in one step. Useful to a UI that wants to offer only legal actions. */
export function nextStates(from) {
  return [...(EDGES[from] ?? [])];
}

/**
 * Can this transition happen, and if not, why not?
 *
 * Returns a reason rather than a boolean because every refusal here ends up in front of a person or in
 * a log, and "illegal transition" without the edge is a message that sends someone to the source.
 *
 * `context` carries the facts the GUARDS need — section 6's last line is that "every transition needs a
 * named actor and a guard, recorded in `transition_journal` — not just a diagram edge", and these are
 * those guards:
 *
 *   { actor, humanApproved, reviewerVerdicts, askOpen }
 */
export function canTransition(from, to, context = {}) {
  if (!isState(to)) return { ok: false, reason: `"${to}" is not a task state (valid: ${STATES.join(", ")})` };
  if (from !== null && from !== undefined && !isState(from)) {
    return { ok: false, reason: `"${from}" is not a task state (valid: ${STATES.join(", ")})` };
  }
  if (!context.actor) return { ok: false, reason: "every transition needs a named actor (PLAN.md section 6)" };

  // A brand-new task may only be created. Modelled as an edge from null so the very first transition is
  // validated like any other, rather than being a special case nothing checks.
  if (from === null || from === undefined) {
    return to === "created"
      ? { ok: true }
      : { ok: false, reason: `a new task starts in "created", not "${to}"` };
  }

  if (from === to) return { ok: false, reason: `already in "${to}" — a no-op transition would be a duplicate journal entry` };

  if (!nextStates(from).includes(to)) {
    return {
      ok: false,
      reason: `"${from}" -> "${to}" is not an edge in the state machine; from "${from}" you can reach: ${nextStates(from).join(", ") || "(nothing — terminal)"}`,
    };
  }

  // ── the guards ────────────────────────────────────────────────────────────────────────
  //
  // NO AUTONOMOUS MERGES. Section 6: "merged requires an explicit human/senior approval gate — no
  // autonomous merges, even with all reviews green. This is a hard rule, not a default that can be
  // silently skipped." So the flag is required and its absence is a refusal, not a warning.
  if (to === "merged" && context.humanApproved !== true) {
    return {
      ok: false,
      reason: "merged requires an explicit human approval (PLAN.md section 6: no autonomous merges, "
        + "even with every review green) — pass humanApproved: true from a real human action",
    };
  }

  // Coming back from a failure is an explicit act, "never automatically" (section 6).
  if ((from === "failed" || from === "cancelled" || from === "start-failed") && to === "created") {
    if (context.explicitRetry !== true) {
      return {
        ok: false,
        reason: `"${from}" -> "created" is a fresh attempt and must be explicit, never automatic `
          + "(PLAN.md section 6) — pass explicitRetry: true",
      };
    }
  }

  // `approved` means the reviewers said so. Checked when the caller supplies the count, and left alone
  // when it does not: section 13 owns how verdicts are counted (revision-bound, per-dimension), and
  // duplicating that logic here would give two answers to one question.
  if (to === "approved" && context.reviewerVerdicts !== undefined) {
    const need = context.requiredVerdicts ?? 2;
    if (context.reviewerVerdicts < need) {
      return { ok: false, reason: `approved needs ${need} reviewer verdict(s), have ${context.reviewerVerdicts} (PLAN.md section 13)` };
    }
  }

  // `blocked` is a statement about the world: an unresolved ask exists. Entering it with none is a lie
  // the UI would then display.
  if (to === "blocked" && context.askOpen === false) {
    return { ok: false, reason: "blocked means an unresolved ask exists for this task's active run; there is none" };
  }
  // ...and leaving it while one is still open is the same lie inverted.
  if (from === "blocked" && to === "implementing" && context.askOpen === true) {
    return { ok: false, reason: "cannot leave blocked while an ask is still unresolved — answer or close it first" };
  }

  return { ok: true };
}

/**
 * The automatic half of `blocked` (section 6: "enters automatically when an `ask` is created, clears
 * automatically when answered").
 *
 * Returns the state a task SHOULD be in given its current state and whether an ask is open, or null
 * for "leave it alone". Pure, so the supervisor's ask paths can consult it without embedding policy.
 *
 * Only `implementing` <-> `blocked` moves automatically. An ask arriving while a task is planning or
 * awaiting-review does NOT drag it into `blocked` — section 6 restricts the state to `implementing`,
 * and silently widening it here would be pre-designing for a case with no evidence.
 */
export function autoBlockTarget(currentState, { askOpen }) {
  if (askOpen && currentState === "implementing") return "blocked";
  if (!askOpen && currentState === "blocked") return "implementing";
  return null;
}
