// clear-policy.js — the DECISION half of Phase 8's clear-policy work (PLAN.md §8 Rule 5), pure. The
// SCHEMA half (`config/harness-defaults.js`'s `CLEAR_POLICIES` vocabulary and per-role `clearPolicy`
// field, validated on load) was built 2026-09-13, item 39 — nothing read it until now.
//
// WHAT "TRIGGER" MEANS, AND WHY IT IS NOT GUESSED
//
// Rule 5 names four policies but not four wire-level events — those had to be found by reading what this
// runtime actually does, not invented:
//
//   "on-state-transition" -> "state-transition"        a REAL forward-progress transition already
//                                                       regenerates a tier-3 handoff in
//                                                       `runtime/supervisor.js` (`approveTask`,
//                                                       `mergeTask`) — clearing belongs at the SAME
//                                                       moments, because Rule 5's whole argument is that
//                                                       clearing is cheap BECAUSE a fresh handoff exists
//                                                       to reload from. A transition into a brand-new
//                                                       run (`assignTask`'s own handoff-triggering site)
//                                                       has nothing to clear and is deliberately NOT a
//                                                       trigger call site — see `runtime/supervisor.js`'s
//                                                       own comment there.
//   "per-review-round"    -> "review-round-concluded"  the only round-concluding event this runtime
//                                                       actually implements is `approveTask`'s SUCCESS
//                                                       path (`awaiting-review` -> `approved`, no more
//                                                       rounds). The state machine (`domain/
//                                                       task-states.js`) has a legal `awaiting-review` ->
//                                                       `fixing` edge for a change-request round ending,
//                                                       but nothing in `runtime/supervisor.js` drives
//                                                       that transition automatically yet — there is no
//                                                       real event to hook for it, so this trigger does
//                                                       not fire there. Wiring it once that transition
//                                                       itself exists is future work, not a gap in this
//                                                       module.
//   "always"              -> "turn-end"                the pump's own `turn.end` event
//                                                       (`onEventHook`) — "one operation per invocation"
//                                                       only actually holds if this fires after EVERY
//                                                       turn, not just once: nothing in this codebase
//                                                       stops an operator from calling `resume()` or
//                                                       `sendInput()` on a utility run a second time, so
//                                                       the policy is enforced here, not assumed true by
//                                                       construction.
//   "on-demand"           -> "demand"                  never fired automatically by anything in this
//                                                       module — `clearContext(runId)` already exists as
//                                                       a callable wire command (PLAN.md §4/§9), and
//                                                       that IS "on demand". Nothing here should ever
//                                                       pass `trigger: "demand"` on its own; it exists
//                                                       purely so `decideClear` has an honest answer if
//                                                       something ever asks.
//
// A harness that does not support clearing at all declares `capabilities().clearContext: false`
// (`conformance/matrix.js`) — this module refuses to clear one regardless of policy/trigger, the same
// "check the adapter's own contract before assuming it" discipline `runtime/supervisor.js`'s `mcpConfig`
// wiring already uses.

import { CLEAR_POLICIES } from "../config/harness-defaults.js";

/** Every trigger a real call site in this runtime can actually raise. Closed, like `CLEAR_POLICIES` —
 *  an unrecognized trigger is a caller bug, not a policy this module should guess about. */
export const CLEAR_TRIGGERS = Object.freeze(["state-transition", "review-round-concluded", "turn-end", "demand"]);

/** Which trigger each policy fires on. The one-to-one mapping IS the decision — see the header above for
 *  where each right-hand side was found, not invented. */
const POLICY_TRIGGER = Object.freeze({
  "on-state-transition": "state-transition",
  "per-review-round": "review-round-concluded",
  always: "turn-end",
  "on-demand": "demand",
});

/**
 * decideClear({ clearPolicy, trigger, clearContextCapability }) -> { clear: boolean, reason?: string }
 *
 * Pure: no I/O, no adapter calls, no database — a caller resolves `clearPolicy` (from
 * `config/harness-defaults.js`'s `assignmentFor`) and `clearContextCapability`
 * (`adapter.capabilities().clearContext`) itself, and this function only says whether THIS event, for
 * THIS role/harness combination, is a moment to clear.
 *
 * `reason` is filled in on every `clear: false` — the same "a refusal names why" convention
 * `domain/task-states.js`'s `canTransition` already uses, so a caller can log or surface it rather than
 * silently doing nothing.
 */
export function decideClear({ clearPolicy, trigger, clearContextCapability } = {}) {
  if (!CLEAR_POLICIES.includes(clearPolicy)) {
    return { clear: false, reason: `"${clearPolicy}" is not a known clear policy (valid: ${CLEAR_POLICIES.join(", ")})` };
  }
  if (!CLEAR_TRIGGERS.includes(trigger)) {
    return { clear: false, reason: `"${trigger}" is not a known trigger (valid: ${CLEAR_TRIGGERS.join(", ")})` };
  }
  if (!clearContextCapability) {
    return { clear: false, reason: "the target harness's own capabilities() declares clearContext: false — nothing to call" };
  }
  const wantsTrigger = POLICY_TRIGGER[clearPolicy];
  if (trigger !== wantsTrigger) {
    return { clear: false, reason: `clearPolicy "${clearPolicy}" fires on "${wantsTrigger}", not "${trigger}"` };
  }
  return { clear: true };
}
