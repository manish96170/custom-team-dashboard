// vault-projector.js — read `vault-projector.json` (PLAN.md §18, ROADMAP.md's Phase 10).
//
// Same shape as `config/slack-notifications.js`, deliberately: user-authored config declaring whether/
// where the read-only Obsidian vault projection writes, read on demand rather than imported into a
// table. Missing file -> built-in default (DISABLED); malformed -> THROWS.
//
// DISABLED BY DEFAULT, ON PURPOSE — PLAN.md §19: "no optional integration ... is ever a hard dependency."
// While `enabled: false` (the built-in default), `runtime/vault-projector.js` never touches the
// filesystem at all — not even to create an empty directory.
//
// VAULT PATH DEFAULTS OUTSIDE THIS REPO, ON PURPOSE — PLAN.md §18's own non-negotiable is "git-ignored".
// Rather than write a `.gitignore` rule and hope nothing ever reads the vault path wrong, the default
// (`<state dir>/vault`, alongside the database and control socket — `paths.js`'s own canonical root) is
// simply never inside a git working tree at all, so the non-negotiable holds by construction for anyone
// who never overrides `vaultPath`. An operator who DOES override it to a path inside a repo is on their
// own — this module still refuses a well-known cloud-sync path (see `allowSyncedFolder` below) but does
// not attempt to detect "is this inside some git repo" (that would need shelling out to `git`, which a
// disabled-by-default, filesystem-only config loader should not do just to validate a path).
//
// SYNCED-FOLDER REFUSAL — PLAN.md §18: "never inside a synced folder without explicit opt-in." Checked
// against the well-known DEFAULT sync roots for the three services PLAN.md names (iCloud Drive, Dropbox,
// Google Drive) — this is a real, falsifiable check (a path prefix match), not an unfalsifiable claim of
// "we detect sync folders in general." A path outside all three prefixes is never blocked by this check,
// same honest scope every other "declare the limit, don't guess" module in this codebase already keeps.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateDir as defaultStateDirFn } from "../paths.js";

export const CONFIG_FILENAME = "vault-projector.json";

function defaultVaultPath() {
  return path.join(defaultStateDirFn(), "vault");
}

export const BUILT_IN_DEFAULTS = Object.freeze({
  enabled: false,
  vaultPath: defaultVaultPath(),
  allowSyncedFolder: false,
});

const TOP_LEVEL_KEYS = Object.freeze(["enabled", "vaultPath", "allowSyncedFolder"]);

/**
 * Well-known DEFAULT sync-root prefixes for the three services PLAN.md §18 names by example. Home-
 * relative, resolved against `os.homedir()` at call time (not at module load) so a test can override
 * `HOME`/pass an explicit home and get a real answer, not a cached one from whichever process happened
 * to load this module first.
 */
function syncedFolderPrefixes(home = os.homedir()) {
  return [
    path.join(home, "Library", "Mobile Documents"), // iCloud Drive (macOS)
    path.join(home, "Dropbox"),
    path.join(home, "Google Drive"),
    path.join(home, "My Drive"), // Google Drive for Desktop's newer default mount name
    path.join(home, "OneDrive"),
  ];
}

/** Real prefix match on the RESOLVED (symlink-free where possible, absolute) path — not a substring
 *  check, so `/tmp/NotDropboxAtAll` never false-positives against `~/Dropbox`. */
export function isInsideSyncedFolder(candidatePath, { home = os.homedir() } = {}) {
  const resolved = path.resolve(candidatePath);
  return syncedFolderPrefixes(home).some((prefix) => {
    const resolvedPrefix = path.resolve(prefix);
    return resolved === resolvedPrefix || resolved.startsWith(resolvedPrefix + path.sep);
  });
}

/** Load and validate the file. Returns `{ enabled, vaultPath, allowSyncedFolder, source, path }`. */
export function loadVaultProjectorConfig({ stateDir, fileText } = {}) {
  let text = fileText;
  let filePath = null;
  if (text === undefined) {
    if (!stateDir) throw new Error("loadVaultProjectorConfig: stateDir is required (or pass fileText)");
    filePath = path.join(stateDir, CONFIG_FILENAME);
    if (!fs.existsSync(filePath)) {
      return { ...BUILT_IN_DEFAULTS, source: "built-in", path: filePath };
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
  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      throw new Error(`${CONFIG_FILENAME}: unknown top-level key "${key}" (allowed: ${TOP_LEVEL_KEYS.join(", ")})`);
    }
  }
  if (parsed.enabled !== undefined && typeof parsed.enabled !== "boolean") {
    throw new Error(`${CONFIG_FILENAME}: "enabled" must be a boolean`);
  }
  if (parsed.vaultPath !== undefined && (typeof parsed.vaultPath !== "string" || !parsed.vaultPath)) {
    throw new Error(`${CONFIG_FILENAME}: "vaultPath" must be a non-empty string`);
  }
  if (parsed.allowSyncedFolder !== undefined && typeof parsed.allowSyncedFolder !== "boolean") {
    throw new Error(`${CONFIG_FILENAME}: "allowSyncedFolder" must be a boolean`);
  }

  const enabled = parsed.enabled ?? BUILT_IN_DEFAULTS.enabled;
  const vaultPath = parsed.vaultPath ?? BUILT_IN_DEFAULTS.vaultPath;
  const allowSyncedFolder = parsed.allowSyncedFolder ?? BUILT_IN_DEFAULTS.allowSyncedFolder;

  // The refusal happens HERE, at load time — before `runtime/vault-projector.js` ever gets a config
  // object it could act on — so "never inside a synced folder without explicit opt-in" is enforced at
  // the one place every caller of this loader passes through, not re-checked (or forgotten) per caller.
  if (enabled && !allowSyncedFolder && isInsideSyncedFolder(vaultPath)) {
    throw new Error(
      `${CONFIG_FILENAME}: "vaultPath" (${vaultPath}) resolves inside a well-known cloud-sync folder — `
      + 'refusing without "allowSyncedFolder": true (PLAN.md §18: never inside a synced folder without explicit opt-in)',
    );
  }

  return { enabled, vaultPath, allowSyncedFolder, source: "file", path: filePath };
}
