// session-intent.js — Phase 8, PLAN.md §7's clean-vs-kill rule made structurally enforceable, 2026-09-14.
//
// PLAN.md §7's own words: "'Clean yourself' (ambiguous casual phrasing) always means a soft context
// clear... 'Kill + respawn' (destructive — loses anything not yet persisted) only happens on an
// explicit, unambiguous instruction... never inferred from a loose paraphrase."
//
// WHY THIS IS A STRUCTURED-SIGNAL FUNCTION, NOT A NATURAL-LANGUAGE CLASSIFIER — checked before writing
// anything, not assumed: this codebase has no natural-language parser anywhere (no LLM-call integration
// point exists for "interpret an operator's phrasing" — `runtime/supervisor.js`'s `tuiChat` handler
// refuses `cmd.target === "cto"` outright with "the CTO agent does not exist yet"). Mapping raw text like
// "clean yourself" to a boolean is therefore not a problem this module can solve — that mapping belongs
// to whatever eventually implements the CTO's own language understanding (Phase 6/8, unbuilt). What IS
// buildable today, and is the actual enforceable half of the rule: given a STRUCTURED caller signal
// (a request for the destructive path, plus an explicit confirmation flag), refuse the destructive
// action unless that signal is unambiguous — the same "never infer from a loose paraphrase" guarantee,
// just applied at the boundary this runtime actually has rather than one it doesn't.
//
// Pure: no I/O, no adapter calls. `runtime/supervisor.js`'s `resetSession(runId, ...)` is the one real
// call site that resolves this decision and then actually calls `clearContext`/`stop`+`start`.

/** The only two outcomes PLAN.md §7 describes. */
export const SESSION_ACTIONS = Object.freeze(["clear", "kill-respawn"]);

/**
 * classifySessionAction({ requestedAction, explicitKillConfirmed }) -> { action, refused? }
 *
 * `requestedAction` is what the CALLER asked for ("clear" or "kill-respawn") — this function does not
 * infer intent from anything, it only decides whether a "kill-respawn" REQUEST is actually authorized to
 * proceed as one. `explicitKillConfirmed` must be the literal boolean `true`; anything else (missing,
 * `"true"` the string, `1`, undefined) is treated as unconfirmed, matching this project's own
 * "never-guess-an-underspecified-request" convention (`domain/capabilities.js`'s `requireArgs`, PLAN.md
 * §16's "a request missing a team/task is rejected back to the caller, not interpreted charitably").
 *
 * A request for "clear" always succeeds as "clear" — the soft path never needs authorization beyond
 * the command's own capability gate, matching §7's "clean yourself" default.
 *
 * An unrecognized `requestedAction` is refused down to the SAFE default ("clear") rather than thrown —
 * same reasoning as defaulting to the non-destructive path on ANY ambiguity, including a caller bug.
 */
export function classifySessionAction({ requestedAction, explicitKillConfirmed } = {}) {
  if (requestedAction === "kill-respawn") {
    if (explicitKillConfirmed !== true) {
      return {
        action: "clear",
        refused: 'a "kill-respawn" request requires explicitKillConfirmed: true — an unconfirmed or '
          + "ambiguous instruction always resolves to a soft clear, never a destructive kill (PLAN.md §7)",
      };
    }
    return { action: "kill-respawn" };
  }
  if (requestedAction !== "clear" && requestedAction !== undefined) {
    return {
      action: "clear",
      refused: `"${requestedAction}" is not a recognized session action (valid: ${SESSION_ACTIONS.join(", ")}) — defaulting to the safe, non-destructive path`,
    };
  }
  return { action: "clear" };
}
