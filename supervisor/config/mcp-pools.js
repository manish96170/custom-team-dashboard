// mcp-pools.js — read `mcp-pools.json` (PLAN.md §21.1/§21.2, wiring pass 2026-09-11).
//
// Same shape as `resources.js`/`harness-defaults.js`, deliberately: user-authored config declaring what a
// pooled MCP server IS (the spawn command for `runtime/mcp-pool.js`'s `attach(name, config)`), read on
// demand rather than imported into a table. Missing file -> built-in default; malformed -> THROWS.
//
// THE ONE BUILT-IN ENTRY, AND THE HONEST LIMIT ON WHAT ITS CONFIG PATH CAN ACTUALLY DO
//
// `leo-mcp` (`../leo-mcp/`, a sibling repo, PLAN.md §16.1) is the first real pooled config: spawned via
// `node mcp/server-socket.js` (the Unix-socket transport, not the stdio one — see below) at a path
// resolved relative to THIS repo (overridable via `LEO_MCP_PATH` for an install where the sibling isn't
// at the default location). If that directory doesn't exist, `attach()` will fail loudly when actually
// invoked — this file does not verify the path exists, the same "declare, don't validate on load"
// contract `resources.js` already keeps.
//
// CORRECTED 2026-09-14 (review-sol-2026-09-13.md finding 13, real transport delivery built) — an earlier
// version of this comment (itself correcting a still-earlier, never-built `configPathFor(name)`) left
// this at "no path naming leo-mcp's pooled process would actually connect a worker's OWN MCP client to
// that SAME process" because nothing in this repo had measured what `claude --mcp-config` actually
// accepts. That has now been measured directly against the installed `claude` CLI (`claude mcp add
// --help` / `claude mcp add-json --help`): exactly three transport types (`stdio`, `sse`, `http`), none
// of which describe a raw Unix socket. So the fix is not "point `--mcp-config` at the socket" — it is
// `runtime/mcp-stdio-proxy.js`: a tiny script `--mcp-config` spawns as an ORDINARY stdio server (fully
// within the one transport type this repo can actually rely on) that does nothing but relay bytes to and
// from THIS pool's real socket. `runtime/mcp-pool.js`'s `spawnOne` now spawns every registered pool
// config as a socket-transport server BY CONVENTION (passing `LEO_MCP_SOCKET_PATH` and waiting for the
// socket file to exist before marking the row ready) — this module's registered configs are assumed to
// speak that convention, which is true of the one real entry below; a hypothetical future stdio-only
// pool config is out of scope until one is actually needed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONFIG_FILENAME = "mcp-pools.json";

function defaultLeoMcpPath() {
  if (process.env.LEO_MCP_PATH) return process.env.LEO_MCP_PATH;
  // supervisor/config/ -> supervisor/ -> custom-team-dashboard/ -> siblings/ -> leo-mcp/
  return path.resolve(__dirname, "..", "..", "..", "leo-mcp");
}

export const BUILT_IN_DEFAULTS = Object.freeze({
  pools: Object.freeze({
    "leo-mcp": Object.freeze({ command: "node", args: Object.freeze(["mcp/server-socket.js"]), cwd: defaultLeoMcpPath() }),
  }),
});

const POOL_KEYS = Object.freeze(["command", "args", "cwd", "env"]);

/** Load and validate the file. Returns `{ pools, source, path }`. */
export function loadMcpPools({ stateDir, fileText } = {}) {
  let text = fileText;
  let filePath = null;
  if (text === undefined) {
    if (!stateDir) throw new Error("loadMcpPools: stateDir is required (or pass fileText)");
    filePath = path.join(stateDir, CONFIG_FILENAME);
    if (!fs.existsSync(filePath)) {
      return { pools: { ...BUILT_IN_DEFAULTS.pools }, source: "built-in", path: filePath };
    }
    text = fs.readFileSync(filePath, "utf8");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.pools || typeof parsed.pools !== "object") {
    throw new Error(`${CONFIG_FILENAME} must be an object with a "pools" object`);
  }
  const pools = {};
  for (const [name, spec] of Object.entries(parsed.pools)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error(`${CONFIG_FILENAME}: pool "${name}" must be an object`);
    }
    for (const key of Object.keys(spec)) {
      if (!POOL_KEYS.includes(key)) {
        throw new Error(`${CONFIG_FILENAME}: pool "${name}" has unknown key "${key}" (allowed: ${POOL_KEYS.join(", ")})`);
      }
    }
    if (typeof spec.command !== "string" || !spec.command) {
      throw new Error(`${CONFIG_FILENAME}: pool "${name}" must have a non-empty "command" string`);
    }
    // review-sol-2026-09-13.md finding 32: `args`/`env`/`cwd` used to be accepted with no shape check at
    // all — `spec.args ?? []` passes through a non-array, a non-string entry, a non-plain-object `env`,
    // or a non-string `cwd` unchanged, and this file's own contract is "malformed -> THROWS", not
    // "malformed -> a confusing spawn failure later inside `runtime/mcp-pool.js`'s `spawnManaged`."
    if (spec.args !== undefined && (!Array.isArray(spec.args) || !spec.args.every((a) => typeof a === "string"))) {
      throw new Error(`${CONFIG_FILENAME}: pool "${name}"'s "args" must be an array of strings`);
    }
    if (spec.cwd !== undefined && spec.cwd !== null && typeof spec.cwd !== "string") {
      throw new Error(`${CONFIG_FILENAME}: pool "${name}"'s "cwd" must be a string or null`);
    }
    if (
      spec.env !== undefined
      && (spec.env === null || typeof spec.env !== "object" || Array.isArray(spec.env)
        || Object.values(spec.env).some((v) => typeof v !== "string"))
    ) {
      throw new Error(`${CONFIG_FILENAME}: pool "${name}"'s "env" must be a plain object of string values`);
    }
    pools[name] = { command: spec.command, args: spec.args ?? [], cwd: spec.cwd ?? null, env: spec.env ?? {} };
  }
  return { pools, source: "file", path: filePath };
}

/** The spawn config for one named pool, or null if undeclared. Merges built-ins with file overrides
 *  the same way `harness-defaults.js` merges per-role config: a file entry replaces a built-in of the
 *  same name wholesale (not a deep merge) — a pool's spawn config is one unit, not per-field options. */
export function poolConfigFor(name, opts = {}) {
  const { pools } = loadMcpPools(opts);
  return pools[name] ?? BUILT_IN_DEFAULTS.pools[name] ?? null;
}
