// protected-branches.js — read `protected-branches.json`.
//
// Same shape as `harness-defaults.js`/`resources.js`, deliberately: user-authored config, read on demand,
// missing file -> built-in default, malformed file -> THROWS.
//
// WHY THIS EXISTS: `gitPush`/`gitPushProtected` (PLAN.md §16 roster, §8 Rule 2) share one fight loop, and
// which command a caller invokes was the ONLY thing deciding whether a push needed the second-signature
// sensitive approval. Nothing checked whether the ACTUAL destination was one that should have required
// it — a caller could always choose the cheap `gitPush` for a push that should have gone through
// `gitPushProtected`. Found by two independent codex reviews (`codexdoc/review-phase7-uncommitted.md`
// finding not separately numbered there; `codexdoc/REVIEW-NOTES.md` finding 2), fixed 2026-09-11. This
// file is the missing piece: a declared list of destinations that are protected, checked server-side by
// the `gitPush` handler BEFORE it ever reaches the fight loop — see `runtime/supervisor.js`'s `gitPush`.

import fs from "node:fs";
import path from "node:path";

export const CONFIG_FILENAME = "protected-branches.json";

/** `main`/`master` are the overwhelmingly common default branch names — a reasonable floor for a fresh
 *  install with no config, not a claim that it covers every repo's actual policy. */
export const BUILT_IN_DEFAULTS = Object.freeze({
  branches: Object.freeze(["main", "master"]),
});

export function loadProtectedBranches({ stateDir, fileText } = {}) {
  let text = fileText;
  let filePath = null;
  if (text === undefined) {
    if (!stateDir) throw new Error("loadProtectedBranches: stateDir is required (or pass fileText)");
    filePath = path.join(stateDir, CONFIG_FILENAME);
    if (!fs.existsSync(filePath)) {
      return { branches: [...BUILT_IN_DEFAULTS.branches], source: "built-in", path: filePath };
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
    throw new Error(`${CONFIG_FILENAME} must be a JSON object`);
  }
  // review-sol-2026-09-13.md finding 31: an unknown top-level key (a misspelling — "branch" instead of
  // "branches", say) used to be silently ignored, and `parsed.branches === undefined` then fell back to
  // the built-in default with NO indication the file's actual content was never read. An administrator
  // could believe a real destination was protected when this fell straight through to `main`/`master`,
  // silently allowing ordinary `gitPush` authorization for it. A file that EXISTS must name `branches`
  // and nothing else — same "reject unknown keys" discipline `resources.js` already applies per-resource.
  const KNOWN_KEYS = ["branches"];
  const unknownKeys = Object.keys(parsed).filter((k) => !KNOWN_KEYS.includes(k));
  if (unknownKeys.length) {
    throw new Error(`${CONFIG_FILENAME}: unknown key(s) ${unknownKeys.join(", ")}; valid: ${KNOWN_KEYS.join(", ")}`);
  }
  if (parsed.branches === undefined) {
    throw new Error(`${CONFIG_FILENAME}: exists but has no "branches" key — remove the file to use the built-in default, or add "branches"`);
  }
  if (
    !Array.isArray(parsed.branches)
    || parsed.branches.length === 0
    || !parsed.branches.every((b) => typeof b === "string" && b.trim().length > 0)
  ) {
    throw new Error(`${CONFIG_FILENAME}: "branches" must be a non-empty array of non-empty strings`);
  }
  const deduped = [...new Set(parsed.branches)];
  if (deduped.length !== parsed.branches.length) {
    throw new Error(`${CONFIG_FILENAME}: "branches" contains duplicate entries`);
  }
  return { branches: parsed.branches, source: "file", path: filePath };
}

/** Whether `branchName` is on the protected list. Case-sensitive — git branch names are. */
export function isProtectedBranch(branchName, { stateDir } = {}) {
  const { branches } = loadProtectedBranches({ stateDir });
  return branches.includes(branchName);
}
