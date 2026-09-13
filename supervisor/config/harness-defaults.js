// harness-defaults.js — read `harness-defaults.json` (PLAN.md sections 3 and 11).
//
// THE ONE EXCEPTION TO "SQLITE IS THE ONLY TRUTH", and PLAN.md §3 states it deliberately: this file is
// **user-authored input**, not runtime state, so it is read straight from disk rather than imported into a
// table. It is low-write-contention config a human edits by hand; there is no torn-write risk of the kind
// the SQLite move was solving for. (`review-profiles.json` is the other shape — it IS imported, because a
// table exists to hold it.)
//
// WHAT THIS FILE IS CAREFUL ABOUT, and why each one is a decision rather than defensiveness:
//
//   * **A MISSING file is normal.** Nothing ships one (§3: configs ship empty and versioned), so the very
//     first assignment on a fresh install happens with no file at all. Failing there would make the
//     dashboard unusable until someone wrote JSON by hand, so the built-in defaults below are the same
//     values PLAN.md §11 prints — and the resolution records `source: "built-in"` so a human can tell
//     "this is what I configured" from "this is what nobody configured".
//   * **A MALFORMED file THROWS.** The opposite call, on purpose. A typo in a hand-edited file must not
//     silently fall back to defaults: the person who wrote `"modell": "opus"` intended to change something,
//     and running with their intent quietly dropped is the exact intent-versus-reality mismatch the worker
//     env record exists to catch (FINDINGS §31). Loud on a typo, quiet on absence.
//   * **Per-team overrides MERGE per role, not per file.** `perTeam.vite.reviewer2` overriding only the
//     model must not blank that role's harness. Whole-object replacement is the subtle version of this bug:
//     everything works until someone writes a partial override, which is the whole point of an override.
//   * **It is read ON DEMAND, not cached at boot.** A human edits this file between assignments and expects
//     the next one to see it; a cached copy would make the file look ignored until the daemon restarted.
//     One small JSON read per assignment is not a cost worth a staleness bug.

import fs from "node:fs";
import path from "node:path";

/** The file's name, in the state directory. Exported so a test and an error message agree on it. */
export const CONFIG_FILENAME = "harness-defaults.json";

/**
 * PLAN.md §11's own table, verbatim, as the built-in fallback.
 *
 * These are not invented values: they are what the design document prints, so a fresh install behaves the
 * way the design says before anyone configures anything. If they change there, change them here.
 */
export const BUILT_IN_DEFAULTS = Object.freeze({
  coder: Object.freeze({ harnessId: "claude-code", model: "sonnet", effort: "medium", clearPolicy: "on-state-transition" }),
  reviewer1: Object.freeze({ harnessId: "claude-code", model: "sonnet", effort: "medium", clearPolicy: "per-review-round" }),
  reviewer2: Object.freeze({ harnessId: "opencode", model: "gpt-5.6", effort: "medium", clearPolicy: "per-review-round" }),
  parentReviewer: Object.freeze({ harnessId: "claude-code", model: "opus", effort: "high", clearPolicy: "per-review-round" }),
  cto: Object.freeze({ harnessId: "claude-code", model: "haiku", effort: "low", clearPolicy: "on-demand" }),
  // PLAN.md §16.2, the utility-task lane, added 2026-09-11: narrow, do-and-forget adhoc roles. Cheap
  // model on purpose — Rule 6/7's "cheap and mostly deterministic" pushed further than the CTO, because
  // the job itself is mechanical (a git push, a scoped Jira/AWS/Slack call), not because the role is
  // less important. Escalate per-run via the assignment override, same as any other role, if a specific
  // job genuinely needs more. `clearPolicy: "always"` matches PLAN.md §8 Rule 5's own worked example —
  // "one operation per invocation, state in its journal," so there is no second turn to clear between.
  "git-push-runner": Object.freeze({ harnessId: "claude-code", model: "haiku", effort: "low", clearPolicy: "always" }),
  "jira-runner": Object.freeze({ harnessId: "claude-code", model: "haiku", effort: "low", clearPolicy: "always" }),
  "awsquery-runner": Object.freeze({ harnessId: "claude-code", model: "haiku", effort: "low", clearPolicy: "always" }),
  "slack-runner": Object.freeze({ harnessId: "claude-code", model: "haiku", effort: "low", clearPolicy: "always" }),
});

/** The keys a role assignment may carry. Anything else in the file is a typo worth reporting. */
const ASSIGNMENT_KEYS = Object.freeze(["harnessId", "model", "effort", "clearPolicy"]);

/**
 * PLAN.md §8 Rule 5's own vocabulary, verbatim — the four shapes "clearing becomes routine" comes in.
 *
 * SCHEMA ONLY, added 2026-09-13 as Phase 8's first step (schema before behavior, same dependency
 * order item 9's leases/MCP-pooling work already used). Nothing reads `clearPolicy` yet to actually
 * call `clearContext()` at the right moment — no `domain/clear-policy.js` decision module exists.
 * This is just the closed vocabulary a config file (or an assignment override) is allowed to name,
 * validated below so a typo fails loudly instead of silently doing nothing (this file's own stated
 * rule: "A MALFORMED file THROWS"). Building the decision module that actually fires on this policy
 * is Phase 8's next step, not this one.
 */
export const CLEAR_POLICIES = Object.freeze(["on-state-transition", "per-review-round", "on-demand", "always"]);

/**
 * Load and validate the file. Returns `{ global, perTeam, source, path }`.
 *
 * `source` is `"file"` or `"built-in"`, and it exists so that every caller can say WHERE an assignment came
 * from. "Which model is this reviewer using and who decided" is the first question anyone asks of an
 * automatic choice, and an answer of "the default" is only useful if you can tell whose default.
 */
export function loadHarnessDefaults({ stateDir, fileText } = {}) {
  // `fileText` is for tests and for a caller that has already read the bytes; it bypasses the filesystem
  // entirely rather than making tests write temp files to exercise pure parsing.
  let text = fileText;
  let filePath = null;
  if (text === undefined) {
    if (!stateDir) throw new Error("loadHarnessDefaults: stateDir is required (or pass fileText)");
    filePath = path.join(stateDir, CONFIG_FILENAME);
    if (!fs.existsSync(filePath)) {
      return { global: { ...BUILT_IN_DEFAULTS }, perTeam: {}, source: "built-in", path: filePath };
    }
    text = fs.readFileSync(filePath, "utf8");
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (err) {
    // Names the file and the parser's own complaint. An error that says only "invalid config" sends
    // someone to the source of the loader rather than to the line they mistyped.
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILENAME} must be a JSON object with a "global" key (PLAN.md section 11)`);
  }

  const global = validateRoleMap(parsed.global ?? {}, "global");
  const perTeam = {};
  for (const [teamId, roles] of Object.entries(parsed.perTeam ?? {})) {
    perTeam[teamId] = validateRoleMap(roles, `perTeam.${teamId}`);
  }
  // Built-in roles fill any the file did not mention. A file that configures only `reviewer2` is a
  // perfectly reasonable file, and it must not leave `coder` undefined.
  return {
    global: { ...BUILT_IN_DEFAULTS, ...global },
    perTeam,
    source: Object.keys(global).length || Object.keys(perTeam).length ? "file" : "built-in",
    path: filePath,
  };
}

/** `jsonc`, minimally: PLAN.md's own example is commented, so a file copied from it must load. */
function stripJsonComments(text) {
  // Line comments only, and only outside strings. Block comments are not supported and do not need to be
  // — the design's example uses `//`. A hand-rolled comment stripper that tried to do more would be the
  // wrong kind of clever in a config loader.
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

function validateRoleMap(roles, where) {
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    throw new Error(`${CONFIG_FILENAME}: "${where}" must be an object of role -> { harnessId, model, effort }`);
  }
  const out = {};
  for (const [role, spec] of Object.entries(roles)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error(`${CONFIG_FILENAME}: "${where}.${role}" must be an object with a harnessId`);
    }
    const unknown = Object.keys(spec).filter((k) => !ASSIGNMENT_KEYS.includes(k));
    if (unknown.length) {
      // REPORTED, not ignored. An unknown key in a hand-edited file is almost always a misspelling of a
      // known one, and silently dropping it means the setting appears to have no effect.
      throw new Error(
        `${CONFIG_FILENAME}: "${where}.${role}" has unknown key(s) ${unknown.join(", ")}; valid: ${ASSIGNMENT_KEYS.join(", ")}`,
      );
    }
    if (spec.harnessId !== undefined && typeof spec.harnessId !== "string") {
      throw new Error(`${CONFIG_FILENAME}: "${where}.${role}.harnessId" must be a string`);
    }
    if (spec.clearPolicy !== undefined && !CLEAR_POLICIES.includes(spec.clearPolicy)) {
      // `clearPolicy` was accepted as a known KEY above (`ASSIGNMENT_KEYS`) but its VALUE was never
      // checked against the vocabulary it's supposed to be drawn from — a typo (`"clearPolicy":
      // "on-demandd"`) passed silently, which is exactly the "malformed file throws" rule this file
      // states as a design principle for every OTHER field.
      throw new Error(
        `${CONFIG_FILENAME}: "${where}.${role}.clearPolicy" must be one of ${CLEAR_POLICIES.join(", ")}, got ${JSON.stringify(spec.clearPolicy)}`,
      );
    }
    out[role] = { ...spec };
  }
  return out;
}

/**
 * The configured assignment for one role, with the per-team override merged in.
 *
 * MERGED PER FIELD: `perTeam.<team>.reviewer2 = { model: "x" }` changes the model and keeps the configured
 * harness. Replacing the whole object instead is the version of this that works until someone writes a
 * partial override — which is the only kind of override anyone writes.
 *
 * The role name is the CONFIG's vocabulary (`reviewer1` / `reviewer2` / `parentReviewer`), which is not
 * quite the workflow profile's (`coder` / `reviewer` / `parentReviewer`); `assignment.js` owns the mapping
 * between the two, because that is a policy about which reviewer slot is which rather than a fact about
 * this file.
 */
export function assignmentFor(config, role, { teamId = null } = {}) {
  const base = config.global?.[role];
  const override = teamId ? config.perTeam?.[teamId]?.[role] : null;
  if (!base && !override) return null;
  return { ...(base ?? {}), ...(override ?? {}), role, overridden: !!override };
}
