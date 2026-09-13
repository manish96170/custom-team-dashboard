// resources.js — read `resources.json` (PLAN.md section 20.1).
//
// Same shape as `harness-defaults.js`, deliberately: this is user-authored config (a human declares what a
// machine-wide resource IS — its kind and, for a counted one, its capacity), not runtime state, so it is
// read straight from disk on demand rather than imported into a table. `resource_leases` (migration 0011)
// holds the runtime CLAIMS against these declarations; this file holds the declarations themselves.
//
//   * **A MISSING file is normal.** The two resources PLAN.md §20.1 names — `git:identity` (one global
//     credential state, two GitHub accounts) and `host:heavy-job` (host memory/CPU) — ship as built-in
//     defaults so a fresh install has arbitration from the first run, not after someone hand-writes JSON.
//   * **A MALFORMED file THROWS**, same reasoning as `harness-defaults.js`: a typo in a hand-edited file
//     must not silently fall back to defaults the author was trying to change.
//   * **It is read ON DEMAND, not cached** — including on `host:heavy-job`'s hot path (every
//     `acquireLease` call samples memory AND re-reads this file), because a human lowering the headroom
//     mid-session expects the very next acquire to see it.

import fs from "node:fs";
import path from "node:path";

export const CONFIG_FILENAME = "resources.json";

/**
 * PLAN.md §20.1's own declared resources, verbatim, as the built-in fallback.
 *
 * `memoryHeadroomPercent` is this file's addition, for §20.3's memory-pressure check: `host:heavy-job`
 * acquisition is refused when free memory is below this percentage of total. 15% was picked as a
 * deliberately conservative default — the incident this section exists for (two concurrent webpack builds
 * exhausting host memory) was found in hindsight, not predicted, so the default should err toward refusing
 * a marginal acquire rather than allowing the machine to get close to the edge again. Overridable per
 * install because what counts as "close to the edge" depends on how much else runs on the host.
 */
export const BUILT_IN_DEFAULTS = Object.freeze({
  resources: Object.freeze({
    "git:identity": Object.freeze({ kind: "exclusive" }),
    "host:heavy-job": Object.freeze({ kind: "counted", capacity: 1 }),
  }),
  memoryHeadroomPercent: 15,
});

const RESOURCE_KEYS = Object.freeze(["kind", "capacity"]);

/**
 * Load and validate the file. Returns `{ resources, memoryHeadroomPercent, source, path }`.
 */
export function loadResources({ stateDir, fileText } = {}) {
  let text = fileText;
  let filePath = null;
  if (text === undefined) {
    if (!stateDir) throw new Error("loadResources: stateDir is required (or pass fileText)");
    filePath = path.join(stateDir, CONFIG_FILENAME);
    if (!fs.existsSync(filePath)) {
      return {
        resources: { ...BUILT_IN_DEFAULTS.resources },
        memoryHeadroomPercent: BUILT_IN_DEFAULTS.memoryHeadroomPercent,
        source: "built-in",
        path: filePath,
      };
    }
    text = fs.readFileSync(filePath, "utf8");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILENAME} must be a JSON object (PLAN.md section 20.1)`);
  }
  // review-sol-2026-09-13.md finding 32: a misspelled TOP-LEVEL key (e.g. `"resource"` instead of
  // `"resources"`) used to be silently ignored — `parsed.resources ?? {}` just treated it as "no
  // resources declared" and fell back to the built-in defaults, with no indication the file's real
  // content was never read. Same "reject unknown keys" discipline this file already applies per-resource
  // (below), now applied at the top level too.
  const TOP_LEVEL_KEYS = ["resources", "memoryHeadroomPercent"];
  const unknownTopLevel = Object.keys(parsed).filter((k) => !TOP_LEVEL_KEYS.includes(k));
  if (unknownTopLevel.length) {
    throw new Error(`${CONFIG_FILENAME}: unknown top-level key(s) ${unknownTopLevel.join(", ")}; valid: ${TOP_LEVEL_KEYS.join(", ")}`);
  }

  const fileResources = {};
  for (const [name, spec] of Object.entries(parsed.resources ?? {})) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error(`${CONFIG_FILENAME}: "resources.${name}" must be an object with a "kind"`);
    }
    const unknown = Object.keys(spec).filter((k) => !RESOURCE_KEYS.includes(k));
    if (unknown.length) {
      throw new Error(
        `${CONFIG_FILENAME}: "resources.${name}" has unknown key(s) ${unknown.join(", ")}; valid: ${RESOURCE_KEYS.join(", ")}`,
      );
    }
    if (spec.kind !== "exclusive" && spec.kind !== "counted") {
      throw new Error(`${CONFIG_FILENAME}: "resources.${name}.kind" must be "exclusive" or "counted"`);
    }
    if (spec.kind === "counted" && !(Number.isInteger(spec.capacity) && spec.capacity > 0)) {
      throw new Error(`${CONFIG_FILENAME}: "resources.${name}.capacity" must be a positive integer for a counted resource`);
    }
    fileResources[name] = { ...spec };
  }

  let memoryHeadroomPercent = BUILT_IN_DEFAULTS.memoryHeadroomPercent;
  if (parsed.memoryHeadroomPercent !== undefined) {
    if (typeof parsed.memoryHeadroomPercent !== "number" || parsed.memoryHeadroomPercent < 0 || parsed.memoryHeadroomPercent > 100) {
      throw new Error(`${CONFIG_FILENAME}: "memoryHeadroomPercent" must be a number between 0 and 100`);
    }
    memoryHeadroomPercent = parsed.memoryHeadroomPercent;
  }

  return {
    // File entries override built-ins per-name; a file declaring only `git:identity` differently must not
    // drop `host:heavy-job` — the same per-field-not-per-file merge `harness-defaults.js` uses.
    resources: { ...BUILT_IN_DEFAULTS.resources, ...fileResources },
    memoryHeadroomPercent,
    source: Object.keys(fileResources).length || parsed.memoryHeadroomPercent !== undefined ? "file" : "built-in",
    path: filePath,
  };
}
