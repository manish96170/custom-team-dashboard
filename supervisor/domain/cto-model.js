// cto-model.js — Phase 8, PLAN.md §8 Rule 6's "cheap resident, single-decision escalation" made
// concrete, 2026-09-14.
//
// SCOPE, CHECKED BEFORE BUILDING ANYTHING: `config/harness-defaults.js` already declares the cheap-
// resident half (`cto: { harnessId: "claude-code", model: "haiku", effort: "low", clearPolicy:
// "on-demand" }`). The escalation PRIMITIVE — a per-call model/effort override on top of a role's
// resident default — already exists too, one layer down: `assignTask`'s own planning already lets a
// slot's `model`/`effort` override the role default (`domain/assignment.js`), and `preflight()` accepts
// a `model` override for a single bounded, one-shot invocation.
//
// What does NOT exist, confirmed by grep before writing this file: a `cto` role is never actually
// instantiated as a real worker/run anywhere in this runtime (`grep -rn "role: .cto\|role === .cto"`
// across `runtime/`, `domain/`, `config/` returns nothing outside config defaults and comments) — Phase 6
// (the CTO agent itself) is unbuilt, per `tuiChat`'s own refusal ("the CTO agent does not exist yet").
// So there is no real CTO run to escalate FROM yet. This module is therefore the pure DECISION half only
// — what model/effort a single escalated decision should use, given a resident default — with no
// `runtime/supervisor.js` wiring, because wiring it to a CTO run that does not exist would be building on
// nothing. The future CTO runtime calls this once it exists; documented as the honest remaining gap
// rather than faked with a wiring call site that has no real caller.

/**
 * resolveModelForDecision({ baseModel, baseEffort, escalate, escalateModel, escalateEffort })
 *   -> { model, effort, escalated: boolean }
 *
 * Pure. `escalate: false` (the default) returns the resident role's own cheap default UNCHANGED — Rule
 * 6's "mostly deterministic... not running a high-effort model resident all day" holds by construction.
 * `escalate: true` returns `escalateModel`/`escalateEffort` for THIS ONE call only — the caller is
 * responsible for using this for a single bounded invocation (e.g. `preflight()`'s own `model` override,
 * or a future one-shot escalated decision run), not for mutating the resident role's own persisted
 * default; this function never touches `harness-defaults.json`.
 *
 * Refuses (throws) an `escalate: true` with no `escalateModel` — matching this project's own
 * never-guess-an-underspecified-request convention: escalating to "a stronger model" with no model NAMED
 * is not a decision this function is willing to invent one for.
 */
export function resolveModelForDecision({
  baseModel, baseEffort, escalate = false, escalateModel = null, escalateEffort = null,
} = {}) {
  if (!escalate) {
    return { model: baseModel, effort: baseEffort, escalated: false };
  }
  if (!escalateModel) {
    throw new Error("resolveModelForDecision: escalate: true requires escalateModel — this function will not guess which stronger model to use");
  }
  return { model: escalateModel, effort: escalateEffort ?? baseEffort, escalated: true };
}
