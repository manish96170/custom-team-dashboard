// review-profiles.js — load, resolve and validate `review-profiles.json` (PLAN.md sections 3 and 13).
//
// THE OTHER SIDE OF SECTION 3's CONFIG SPLIT. `harness-defaults.json` is read straight from disk every time;
// this one is "imported into the `review_profiles` table on supervisor startup/file-change (that table exists
// specifically to hold it) — SQLite is truth for *that copy* once imported, and re-editing the JSON
// re-imports it". Migration 0009's header has the reason at length: a verdict recorded under a profile must
// stay interpretable after the profile is edited, and reading today's file would silently rewrite the meaning
// of every verdict already stored.
//
// So this module's job is: parse, resolve `extends`, validate, and produce a CONTENT HASH per resolved
// profile. The hash is what makes the imported copy addressable — `review_verdicts` records which
// `(profile_id, profile_hash)` it was judged under, so "was correctness blocking when this was approved" has
// an answer that an edit cannot change.
//
// WHY `extends` IS RESOLVED HERE RATHER THAN AT READ TIME
//
// Section 13's own example makes `hotfix` extend `default` and then override `dimensions` with BARE ID
// STRINGS (`["correctness", "security"]`) rather than full objects. So resolution is not a merge; it is a
// small language: a string list means "these dimensions, taken from the parent, in this order". Doing that
// once at import time means every consumer — the approval rule, the UI, the verdict recorder — sees the same
// fully-resolved shape, and `blocking` is never accidentally read off a string.
//
// LOUD ON A TYPO, same asymmetry as `harness-defaults.json` and for the same reason: a missing file is normal
// (nothing ships one), while a malformed one is somebody's intent silently dropped. Here the stakes are
// higher — an unknown `quorum` key, or a dimension id that its parent does not define, changes whether code
// merges reviewed.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const CONFIG_FILENAME = "review-profiles.json";

/** Every key a profile may carry, with the type it must be. Anything else is a typo worth reporting. */
const PROFILE_KEYS = Object.freeze({
  extends: "string",
  dimensions: "array",
  quorum: "object",
  changeRequestBlocks: "boolean",
  revisionBound: "boolean",
  verifyFindings: "boolean",
  effort: "string",
  modelDiversity: "string",
});

const QUORUM_KEYS = Object.freeze(["required", "parentCounts", "parentRequired"]);

/** `require-distinct-harness` is the only value section 13 names; `any` is the explicit opt-out. */
export const MODEL_DIVERSITY = Object.freeze(["require-distinct-harness", "any"]);

/**
 * The built-in `default` profile — section 13's own table, verbatim.
 *
 * Present for the same reason `harness-defaults.json` has built-ins: nothing ships a config file, so the
 * first review on a fresh install has none, and refusing to review until someone writes JSON by hand would
 * make the feature unreachable. The values are the design's, not invented: five dimensions, three blocking,
 * quorum of 2 with the parent not counting, revision-bound, findings verified.
 */
export const BUILT_IN_DEFAULT = Object.freeze({
  dimensions: Object.freeze([
    Object.freeze({ id: "correctness", blocking: true, prompt: "Does this do what it claims, on the paths that matter?" }),
    Object.freeze({ id: "security", blocking: true, prompt: "What can an attacker or a mistake do with this?" }),
    Object.freeze({ id: "tests", blocking: true, prompt: "Does a test fail if the mechanism breaks? Name the test." }),
    Object.freeze({ id: "simplification", blocking: false, prompt: "What could be removed without losing behaviour?" }),
    Object.freeze({ id: "performance", blocking: false, prompt: "What gets slower, and by how much, on real input?" }),
  ]),
  quorum: Object.freeze({ required: 2, parentCounts: false, parentRequired: false }),
  changeRequestBlocks: true,
  revisionBound: true,
  verifyFindings: true,
  effort: "medium",
  modelDiversity: "require-distinct-harness",
});

/** Line comments only — section 13's example is `jsonc`, so a file copied from it must load. */
function stripJsonComments(text) {
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

/** A stable content hash of a resolved profile. Key order is normalised so formatting is not identity. */
export function profileHash(resolved) {
  return createHash("sha256").update(stableStringify(resolved)).digest("hex").slice(0, 16);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Load the file (or its text), resolve every profile, and validate.
 *
 * Returns `{ profiles, perTeam, perPath, source, path }` where each profile is fully resolved and carries its
 * own `id` and `hash`.
 */
export function loadReviewProfiles({ stateDir, fileText } = {}) {
  let text = fileText;
  let filePath = null;
  if (text === undefined) {
    if (!stateDir) throw new Error("loadReviewProfiles: stateDir is required (or pass fileText)");
    filePath = path.join(stateDir, CONFIG_FILENAME);
    if (!fs.existsSync(filePath)) return builtInOnly(filePath);
    text = fs.readFileSync(filePath, "utf8");
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (err) {
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILENAME} must be a JSON object with a "profiles" key (PLAN.md section 13)`);
  }
  // TOP-LEVEL keys, checked for the same reason profile and quorum keys are: a typo is somebody's intent
  // silently dropped. `perPaths` instead of `perPath` loaded cleanly and applied the DEFAULT profile to a
  // path someone had deliberately made stricter — the one place in this file where a typo is invisible AND
  // consequential. Found by the Phase 6 review (sol).
  const TOP_LEVEL = ["schemaVersion", "profiles", "perTeam", "perPath"];
  const unknownTop = Object.keys(parsed).filter((k) => !TOP_LEVEL.includes(k));
  if (unknownTop.length) {
    throw new Error(
      `${CONFIG_FILENAME}: unknown top-level key(s) ${unknownTop.join(", ")}; valid: ${TOP_LEVEL.join(", ")}`
      + " — a misspelled routing key would silently apply the default profile where a stricter one was intended",
    );
  }
  // `schemaVersion` is in section 13's example and is checked rather than ignored: a file written for a
  // future shape must not be interpreted as if it were this one.
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) {
    throw new Error(`${CONFIG_FILENAME}: schemaVersion ${JSON.stringify(parsed.schemaVersion)} is not supported (this build reads 1)`);
  }

  const raw = parsed.profiles ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${CONFIG_FILENAME}: "profiles" must be an object`);

  const resolved = {};
  for (const id of Object.keys(raw)) {
    resolved[id] = resolveProfile(id, raw, new Set());
  }
  // A file that defines no `default` still gets one: `perTeam`/`perPath` may name any profile, and the
  // fallback for everything else has to exist.
  if (!resolved.default) resolved.default = { ...BUILT_IN_DEFAULT, id: "default" };

  const profiles = {};
  for (const [id, p] of Object.entries(resolved)) {
    profiles[id] = Object.freeze({ ...p, id, hash: profileHash({ ...p, id }) });
  }

  const perPath = validatePerPath(parsed.perPath ?? [], profiles);
  const perTeam = validatePerTeam(parsed.perTeam ?? {}, profiles);

  return {
    profiles,
    perTeam,
    perPath,
    source: Object.keys(raw).length ? "file" : "built-in",
    path: filePath,
  };
}

function builtInOnly(filePath) {
  const base = { ...BUILT_IN_DEFAULT, id: "default" };
  return {
    profiles: { default: Object.freeze({ ...base, hash: profileHash(base) }) },
    perTeam: {},
    perPath: [],
    source: "built-in",
    path: filePath,
  };
}

/**
 * Resolve one profile, following `extends`.
 *
 * `seen` catches a cycle. A profile that extends itself (directly or through a chain) would otherwise
 * recurse until the stack dies, and a stack overflow at supervisor startup is a spectacularly unhelpful way
 * to be told about a two-character typo.
 */
function resolveProfile(id, raw, seen) {
  if (seen.has(id)) {
    throw new Error(`${CONFIG_FILENAME}: profile "${id}" extends itself (cycle: ${[...seen, id].join(" -> ")})`);
  }
  const own = raw[id];
  if (!own || typeof own !== "object" || Array.isArray(own)) {
    throw new Error(`${CONFIG_FILENAME}: profile "${id}" must be an object`);
  }
  checkKeys(id, own);

  let base;
  if (own.extends) {
    if (!Object.hasOwn(raw, own.extends) && own.extends !== "default") {
      throw new Error(`${CONFIG_FILENAME}: profile "${id}" extends "${own.extends}", which is not defined`);
    }
    base = own.extends === "default" && !raw.default
      ? { ...BUILT_IN_DEFAULT }
      : resolveProfile(own.extends, raw, new Set([...seen, id]));
  } else {
    // Even a profile with no `extends` inherits the built-in defaults for anything it omits — a file that
    // sets only `quorum` is a reasonable file and must not end up with no dimensions at all.
    base = { ...BUILT_IN_DEFAULT };
  }

  const merged = { ...base, ...own };
  delete merged.extends;
  delete merged.id;
  delete merged.hash;

  // Quorum merges per FIELD, for the same reason the harness config does: section 13's `hotfix` overrides
  // only `required`, and replacing the whole object would silently reset `parentCounts` to nothing.
  merged.quorum = { ...(base.quorum ?? {}), ...(own.quorum ?? {}) };
  for (const k of Object.keys(merged.quorum)) {
    if (!QUORUM_KEYS.includes(k)) {
      throw new Error(`${CONFIG_FILENAME}: profile "${id}" has unknown quorum key "${k}"; valid: ${QUORUM_KEYS.join(", ")}`);
    }
  }
  if (merged.quorum.required !== undefined
      && (!Number.isInteger(merged.quorum.required) || merged.quorum.required < 0)) {
    throw new Error(`${CONFIG_FILENAME}: profile "${id}" quorum.required must be a non-negative integer`);
  }

  merged.dimensions = resolveDimensions(id, own.dimensions, base.dimensions);
  if (merged.modelDiversity !== undefined && !MODEL_DIVERSITY.includes(merged.modelDiversity)) {
    throw new Error(
      `${CONFIG_FILENAME}: profile "${id}" modelDiversity is ${JSON.stringify(merged.modelDiversity)}; `
      + `valid: ${MODEL_DIVERSITY.join(", ")}`,
    );
  }
  return merged;
}

/**
 * Dimensions, in section 13's own two shapes.
 *
 * A list of OBJECTS declares them outright. A list of STRINGS selects from the parent's — which is what
 * `hotfix` and `docs-only` do — and a string naming a dimension the parent does not define is an error
 * rather than an empty dimension: a review profile that silently reviewed nothing would approve code with
 * no blocking dimension unsatisfied, which is the worst available failure in this file.
 */
function resolveDimensions(id, own, inherited) {
  if (own === undefined) return (inherited ?? []).map((d) => ({ ...d }));
  if (!Array.isArray(own)) throw new Error(`${CONFIG_FILENAME}: profile "${id}" dimensions must be an array`);
  const byId = new Map((inherited ?? []).map((d) => [d.id, d]));
  const out = [];
  for (const entry of own) {
    if (typeof entry === "string") {
      const found = byId.get(entry);
      if (!found) {
        throw new Error(
          `${CONFIG_FILENAME}: profile "${id}" selects dimension "${entry}", which the profile it extends does not define`
          + ` (available: ${[...byId.keys()].join(", ") || "none"})`,
        );
      }
      out.push({ ...found });
      continue;
    }
    if (!entry || typeof entry !== "object" || !entry.id) {
      throw new Error(`${CONFIG_FILENAME}: profile "${id}" has a dimension with no id`);
    }
    if (entry.blocking !== undefined && typeof entry.blocking !== "boolean") {
      throw new Error(`${CONFIG_FILENAME}: profile "${id}" dimension "${entry.id}" has a non-boolean "blocking"`);
    }
    // `blocking` DEFAULTS TO FALSE for a hand-written dimension: a reviewer dimension nobody marked as
    // blocking must not silently become a merge gate.
    out.push({ blocking: false, ...entry });
  }
  if (!out.length) throw new Error(`${CONFIG_FILENAME}: profile "${id}" has no dimensions`);
  return out;
}

function checkKeys(id, own) {
  for (const [k, v] of Object.entries(own)) {
    const want = PROFILE_KEYS[k];
    if (!want) {
      throw new Error(
        `${CONFIG_FILENAME}: profile "${id}" has unknown key "${k}"; valid: ${Object.keys(PROFILE_KEYS).join(", ")}`,
      );
    }
    const actual = Array.isArray(v) ? "array" : typeof v;
    if (actual !== want) {
      throw new Error(`${CONFIG_FILENAME}: profile "${id}" key "${k}" must be a ${want}, got ${actual}`);
    }
  }
}

function validatePerTeam(perTeam, profiles) {
  if (typeof perTeam !== "object" || Array.isArray(perTeam)) throw new Error(`${CONFIG_FILENAME}: "perTeam" must be an object`);
  for (const [teamId, name] of Object.entries(perTeam)) {
    if (!profiles[name]) {
      throw new Error(`${CONFIG_FILENAME}: perTeam["${teamId}"] names profile "${name}", which is not defined`);
    }
  }
  return { ...perTeam };
}

function validatePerPath(perPath, profiles) {
  if (!Array.isArray(perPath)) throw new Error(`${CONFIG_FILENAME}: "perPath" must be an array`);
  return perPath.map((entry, i) => {
    if (!entry?.glob || !entry?.profile) {
      throw new Error(`${CONFIG_FILENAME}: perPath[${i}] needs both "glob" and "profile"`);
    }
    if (!profiles[entry.profile]) {
      // Section 13's own example names `payments-strict`, a profile its `profiles` block does not define.
      // Reported rather than tolerated: a path rule pointing at a missing profile means the strictest
      // review in the config silently does not apply, which is the exact opposite of what it was written for.
      throw new Error(
        `${CONFIG_FILENAME}: perPath[${i}] names profile "${entry.profile}", which is not defined `
        + "— a path rule pointing at a missing profile would silently apply no extra strictness at all",
      );
    }
    return { glob: entry.glob, profile: entry.profile };
  });
}

/**
 * Which profile applies, and why.
 *
 * Precedence: **perPath beats perTeam beats default.** Path wins because it is the narrower statement — a
 * team-wide profile is a habit, whereas `packages/payments/**` is a property of the code being changed, and
 * the reason section 13 has the rule at all is to make payments stricter than whatever the owning team
 * normally does.
 *
 * `reason` is returned with the profile because "why is this task being reviewed under `hotfix`" is a
 * question a human asks the moment a review behaves unexpectedly.
 */
export function profileFor(config, { teamId = null, paths = [] } = {}) {
  for (const rule of config.perPath ?? []) {
    const hit = (paths ?? []).find((p) => matchGlob(rule.glob, p));
    if (hit) {
      return { profile: config.profiles[rule.profile], reason: `perPath "${rule.glob}" matched ${hit}` };
    }
  }
  if (teamId && config.perTeam?.[teamId]) {
    const name = config.perTeam[teamId];
    return { profile: config.profiles[name], reason: `perTeam "${teamId}" -> "${name}"` };
  }
  return { profile: config.profiles.default, reason: "the default profile" };
}

/**
 * The three glob forms this needs, and no more: `**` (any depth), `*` (one segment), and literals.
 *
 * Hand-rolled rather than a dependency, and deliberately small — `packages/payments/**` is the shape section
 * 13 uses. A full glob implementation here would be a second matcher for anyone to be surprised by; if a
 * real config ever needs brace expansion or negation, that is the moment to reconsider, with a case in hand.
 */
export function matchGlob(glob, filePath) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // `**` first, and to a distinct placeholder, so the single-`*` replacement below cannot eat it.
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*");
  return new RegExp(`^${escaped}$`).test(String(filePath));
}
