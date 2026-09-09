// workflow-profiles.js — per-task-type workflow variation (PLAN.md sections 2, 5, 10 and 11). Pure.
//
// WHAT A PROFILE IS, AND WHAT IT DELIBERATELY IS NOT
//
// PLAN.md gives a task "a type (dev / review / adhoc)" and then, in three separate places, treats those
// types differently: §5 picks a different pane layout per type, §10 says an adhoc task is "a single worker
// and no reviewers", and §11's assignment step asks for "each role the task needs". Until now none of that
// was expressed anywhere — every task got the same treatment, and the differences lived in prose.
//
// A profile therefore answers three questions and nothing else:
//
//   1. WHICH ROLES does a task of this type need? (§11's assignment step, §10's "no reviewers")
//   2. HOW MANY reviewer verdicts does `approved` require? (§13's quorum, per type)
//   3. WHICH pane layout is the smart default? (§5's "dev task shows last-active dev run; review task
//      shows dev pane + one reviewer pane")
//
// IT ADDS NO STATE MACHINE EDGES. That is the important restraint. It would be easy to give an `adhoc`
// task a profile that skips `awaiting-review` entirely, and PLAN.md §6 explicitly warns against exactly
// that class of change: `superseded`, `reopened` and `merge-rejected` are named as NOT being added yet
// because "adopting all of them before a runtime exists to test any of them produces a large schema for a
// system that cannot run". Per-type edges would be the same mistake with a different label — one diagram
// becomes four, each with its own untested corners. So a profile with no reviewers reaches `approved` with
// **zero required verdicts**, which is a guard parameter rather than a new shape, and the diagram in §6
// stays the one diagram every task walks.
//
// The type names are PLAN.md's own (`dev` / `review` / `adhoc`), plus the ones the project's own fixtures
// and tasks already use (`feature`, `bug`, `chore`). An unknown type gets the DEFAULT profile rather than
// an error: a task that exists with a type nobody has profiled yet must still be workable, and refusing
// would make adding a type a schema migration.

/** Roles a task can need. `reviewer` twice is not a typo -- §11 configures reviewer1 and reviewer2. */
export const ROLES = Object.freeze(["coder", "reviewer", "parentReviewer"]);

/**
 * The default, used for any type without an entry of its own.
 *
 * Two reviewers and two required verdicts, because that is what §13 describes for ordinary dev work and
 * because the safe default for an unknown type is the STRICTER one: a type nobody has thought about yet
 * should not be the one that merges with no review.
 */
const DEFAULT_PROFILE = Object.freeze({
  type: "(default)",
  roles: Object.freeze(["coder", "reviewer", "reviewer"]),
  requiredVerdicts: 2,
  paneDefault: "dev",
  reviewRequired: true,
  description: "ordinary work: one coder, two reviewers, two verdicts before approval",
});

const PROFILES = Object.freeze({
  // §5's "dev task" and the two concrete types this project's own tasks use.
  dev: DEFAULT_PROFILE,
  feature: DEFAULT_PROFILE,
  bug: Object.freeze({
    type: "bug",
    roles: Object.freeze(["coder", "reviewer"]),
    requiredVerdicts: 1,
    paneDefault: "dev",
    reviewRequired: true,
    // One reviewer, not two, and this is a judgement rather than a fact: a fix with a reproduction is
    // cheaper to check than a feature with a design. Configurable later if it proves wrong -- which is
    // exactly why the number lives in a table rather than in an `if`.
    description: "a fix: one coder, one reviewer, one verdict",
  }),
  // §5: "review task shows dev pane + one reviewer pane". The work IS the review, so the parent reviewer
  // is the one role it cannot do without.
  review: Object.freeze({
    type: "review",
    roles: Object.freeze(["parentReviewer"]),
    requiredVerdicts: 1,
    paneDefault: "review",
    reviewRequired: true,
    description: "reviewing someone else's work: a parent reviewer, shown beside the dev pane",
  }),
  // §10: "a one-off task with a single worker and no reviewers is just `type: adhoc`". Zero required
  // verdicts, and note what that does NOT mean: `merged` still requires an explicit human approval,
  // because §6 calls that "a hard rule, not a default that can be silently skipped". No reviewers is not
  // no human.
  adhoc: Object.freeze({
    type: "adhoc",
    roles: Object.freeze(["coder"]),
    requiredVerdicts: 0,
    paneDefault: "dev",
    reviewRequired: false,
    description: "a one-off: one worker, no reviewers, and still no autonomous merge",
  }),
  chore: Object.freeze({
    type: "chore",
    roles: Object.freeze(["coder"]),
    requiredVerdicts: 0,
    paneDefault: "dev",
    reviewRequired: false,
    description: "maintenance: one worker, no reviewers",
  }),
});

/** Every profiled type, for a UI that wants to offer the real list rather than a hardcoded one. */
export const PROFILED_TYPES = Object.freeze(Object.keys(PROFILES));

/**
 * The profile for a task type. Never throws.
 *
 * An unknown type gets the default WITH ITS OWN `type` recorded, so a caller can tell "this is the
 * default" from "this type is genuinely configured as the default" — the difference matters to a human
 * reading a handoff and wondering why their `spike` task wants two reviewers.
 */
export function profileFor(type) {
  const known = PROFILES[type];
  if (known) return known;
  return Object.freeze({ ...DEFAULT_PROFILE, type: type ?? "(none)", isDefault: true });
}

/** The roles a task of this type needs a worker for — §11's "each role the task needs". */
export function rolesFor(type) {
  return [...profileFor(type).roles];
}

/**
 * How many reviewer verdicts `approved` requires for this type.
 *
 * This is the one place a profile touches the state machine, and it does so as a GUARD PARAMETER:
 * `canTransition(from, to, { reviewerVerdicts, requiredVerdicts })` already takes the number, so the
 * profile supplies it rather than the machine growing a per-type branch.
 */
export function requiredVerdictsFor(type) {
  return profileFor(type).requiredVerdicts;
}

/**
 * Which pane layout to open for a task of this type (§5's click behaviour).
 *
 * `dev` -> the last-active dev run, unless pinned. `review` -> dev pane plus one reviewer pane. Returned
 * as a string rather than a boolean because a third layout is plausible and `isReview: false` would have
 * to be renamed the day it arrives.
 */
export function paneDefaultFor(type) {
  return profileFor(type).paneDefault;
}
