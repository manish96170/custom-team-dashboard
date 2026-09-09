// worker-env.js — what environment a dashboard-managed Claude Code worker gets.
//
// THE DECISION (Phase 2, item 2; measured by probe/worker-env-probe.mjs, evidence in
// probe/evidence/08-worker-env-matrix.txt and 09-setting-sources-project.txt)
//
// Before this module, `spawnManaged` passed the ambient environment through and the CLI
// read its usual settings sources, so every worker silently loaded the DEVELOPER'S OWN
// global configuration. Measured on `claude` 2.1.263 in an empty directory: 6 MCP servers,
// 110 tools, 97 slash commands, and 2 `SessionStart` hooks that fired before any of our
// prompts did. A worker in the real-pane slice volunteered an unprompted note about an
// unrelated MCP server needing authorization -- which is how this was noticed at all.
//
// A worker now DECLARES its environment and inherits nothing by accident. The default is
// `'project'`:
//
//     --setting-sources=project --strict-mcp-config
//
// which measured 1 hook (the repo's own) instead of 3, 0 MCP servers instead of 6, and the
// full 24-tool built-in set intact.
//
// WHY `project` AND NOT `none`
//
// A repo's `.claude/settings.json` is checked into git, so it is the same on every machine
// and is reviewed like any other code. It is real signal -- the conventions and permissions
// that repo has already decided on -- and dropping it would force every repo to
// re-litigate its config inside the dashboard's own registry instead of in git.
// `'project'` is exactly as reproducible as `'none'` (same repo, same commit, same
// settings, any machine) while keeping that signal. `.claude/settings.local.json` is the
// `local` source: gitignored, machine-specific, and therefore the one thing that WOULD
// make "it worked for me" unfalsifiable. It is never included.
//
// TWO FLAGS, TWO INDEPENDENT AXES -- do not treat them as one "config" dial:
//   --setting-sources    governs hooks, skills, plugins, slash commands, permissions
//   --strict-mcp-config  governs MCP servers ONLY
// Measured separately: `--strict-mcp-config` alone left all 3 hooks firing and 95 slash
// commands loaded while taking MCP to 0. Turning one off is not turning the other off.
//
// FLAGS DELIBERATELY NOT USED, each for a measured reason:
//
//   --bare        Leaves only 3 tools -- Bash, Edit, Read. No Write, no Grep, no Glob, no
//                 Task. That is not a worker that can do the job. AND its help states auth
//                 becomes strictly ANTHROPIC_API_KEY or apiKeyHelper, with OAuth and the
//                 keychain never read: it started on the machine this was measured on only
//                 because that machine uses Bedrock, so shipping it would break every
//                 subscription/OAuth user. Two independent disqualifications.
//   --safe-mode   Reaches the same numbers as the default above (0 hooks, 0 MCP, 24 tools)
//                 but is documented as a TROUBLESHOOTING switch for a broken config, and
//                 it also drops one built-in agent. "Disable all customizations" is a
//                 blunt instrument whose meaning is free to change; two named flags say
//                 what we actually want and will keep meaning it.
//   --restricted  Genuinely interesting -- it removes Bash and WebFetch (24 tools -> 22),
//                 which maps onto a reviewer/QA role that should not run commands. NOT
//                 shipped yet, deliberately: there is no evidence yet that any role's
//                 failures are Bash-shaped, and adding a role/profile matrix before that
//                 evidence exists multiplies what has to be reasoned about. `PROFILES`
//                 below is the seam it would be added at.
//
// ── EXECUTING REPO CODE IS OPT-IN (owner decision, 2026-09-08) ───────────────────────
//
// `--setting-sources=project` LOADS AND EXECUTES a repo's committed `.claude/settings.json`,
// including its hooks, before the worker's first turn. Two of three independent reviewers rated
// that as blocking when it was the DEFAULT, and the owner's decision is the stronger form of
// their point: **anything that executes repo-controlled code is off unless someone turns it on.**
//
// So `'project'` is now a deliberate act at one of two levels:
//
//   per run      spec.envProfile = 'project'
//   per session  CTD_WORKER_ENV_PROFILE=project
//
// The asymmetry is what makes this the right default rather than merely the cautious one. Turning
// it on costs one field and gains a repo's conventions. Leaving it on by mistake runs somebody
// else's code with the supervisor's ambient environment, before anything the dashboard mediates —
// and a hook only has to run once. The safe direction is also the recoverable one.
//
// A worker on `'none'` still has every built-in tool (measured: 0 hooks, 0 MCP servers, 24 tools);
// what it loses is the repo's conventions, not its capabilities.
//
// NOT claimed: that recording the settings digest mitigates the risk. It does not — it is
// forensics after the fact, not a control. Two reviewers pointed out that conflating the two
// would be the more dangerous error, and they are right.
//
// ── WHAT THE RECORD IS AND IS NOT ────────────────────────────────────────────────────
//
// `describeEnv()` records the settings files in effect and their digests, emitted as a
// `worker.env` event, so that when a worker behaves oddly in three weeks the settings that
// shaped it are one grep away instead of a guess about a machine's global state.
//
// It is a BEST-EFFORT record, and one gap is unclosable here: the digest is read before the
// spawn, and the CLI reads the file afterwards. A `git pull` or an editor save in between means
// the record names digest A while the worker ran with digest B. Nothing in this module can close
// that without the CLI reporting the digest it actually used, so the honest position is that
// `projectSettings` is "what was on disk when the worker was started", not "what the CLI parsed".
// `session.init` (recorded alongside) is the CLI's own account of what it loaded, and is the
// half of the pair that does not depend on our timing.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

/** The `--setting-sources` values the CLI accepts. Measured: an unknown value exits 1. */
export const VALID_SETTING_SOURCES = ['user', 'project', 'local'];

/**
 * Named environments a worker can declare. The VALUE is the `--setting-sources` list.
 *
 * `inherit` is the escape hatch and is spelled as a profile rather than as "omit the
 * flag" on purpose: today's silent full inheritance is the bug, so the way to ask for it
 * is to say so, and `describeEnv()` reports it as `inherited: true` so it shows up in the
 * event log rather than looking like a normal worker.
 */
export const PROFILES = {
  project: ['project'],
  none: [],
  inherit: null, // null = pass no --setting-sources at all; the CLI's own default applies
};

/**
 * The default, and it is `'none'` BY OWNER DECISION (2026-09-08).
 *
 * It was `'project'`, on the reasoning that a repo's committed `.claude/settings.json` is checked into
 * git, reviewed like code, and therefore real signal worth keeping. Two of three independent reviewers
 * rated that BLOCKING anyway, for a reason the reasoning did not answer:
 * `--setting-sources=project` **loads and executes** that repo's hooks before the worker's first turn.
 * The owner's call is that anything which executes repo-controlled code must be off unless switched on.
 *
 * That is the right default for a asymmetric risk. Turning it on costs one field and gains a repo's
 * conventions; leaving it on by mistake runs someone else's code with the supervisor's environment. The
 * safe direction is also the recoverable one.
 *
 * TO TURN IT ON — two levels, both explicit:
 *   per run      spec.envProfile = 'project'
 *   per session  CTD_WORKER_ENV_PROFILE=project   (changes this default for one supervisor process)
 *
 * Measured cost of `'none'`: 0 hooks, 0 MCP servers, and the FULL 24-tool built-in set intact — a
 * worker loses the repo's conventions, not its capabilities (adapters/FINDINGS.md's table).
 */
export const DEFAULT_PROFILE = 'none';

/**
 * The session-level default, from the environment.
 *
 * Read at call time rather than at import, so a test (or a caller that sets it late) is not silently
 * ignored — an env var that only works if it was set before the module loaded is the kind of switch
 * people reasonably believe they have used.
 *
 * An invalid value THROWS rather than falling back to the safe default. Falling back would be the
 * friendlier-looking choice and the wrong one: someone who wrote `CTD_WORKER_ENV_PROFILE=projekt`
 * intended to turn something ON, and silently running with it off is exactly the mismatch between
 * intent and reality that the whole `worker.env` record exists to prevent.
 */
export function sessionDefaultProfile(env = process.env) {
  const raw = env.CTD_WORKER_ENV_PROFILE;
  if (raw === undefined || raw === '') return DEFAULT_PROFILE;
  if (!Object.hasOwn(PROFILES, raw)) {
    throw new Error(
      `CTD_WORKER_ENV_PROFILE is ${JSON.stringify(raw)}, which is not a profile; valid: ${Object.keys(PROFILES).join(', ')}`,
    );
  }
  return raw;
}

/**
 * Resolve a spec's environment declaration into `--setting-sources` values.
 *
 * Accepts either `envProfile: 'project' | 'none' | 'inherit'` or, for a caller that needs
 * a combination no profile names, an explicit `settingSources: ['project', 'local']`.
 * An explicit list wins over a profile, because a caller that passed both was more
 * specific with the list.
 *
 * Throws on anything invalid instead of falling back to a default. A silent fallback here
 * would be the same class of failure as the missing `--permission-prompt-tool stdio`:
 * a worker running in an environment nobody asked for, with nothing to indicate it.
 */
export function resolveSettingSources(spec = {}) {
  const { envProfile, settingSources } = spec;

  if (settingSources !== undefined) {
    if (!Array.isArray(settingSources)) {
      throw new Error(`spec.settingSources must be an array of ${VALID_SETTING_SOURCES.join('|')}, got ${typeof settingSources}`);
    }
    const bad = settingSources.filter((s) => !VALID_SETTING_SOURCES.includes(s));
    if (bad.length) {
      throw new Error(`spec.settingSources has invalid ${bad.length === 1 ? 'source' : 'sources'} ${bad.map((b) => JSON.stringify(b)).join(', ')}; valid: ${VALID_SETTING_SOURCES.join(', ')}`);
    }
    // Deduplicated because `--setting-sources=project,project` is a pointless argv that
    // would also make two otherwise-identical workers compare unequal in the event log.
    return { profile: 'explicit', sources: [...new Set(settingSources)] };
  }

  const name = envProfile ?? sessionDefaultProfile();
  if (!Object.hasOwn(PROFILES, name)) {
    throw new Error(`unknown spec.envProfile ${JSON.stringify(name)}; valid: ${Object.keys(PROFILES).join(', ')}`);
  }
  return { profile: name, sources: PROFILES[name] };
}

/**
 * The argv fragment that pins a worker's environment.
 *
 * `--setting-sources=<v>` uses the `=`-joined form, including for the empty list, because
 * that is the form Claude Code's own disposable sub-sessions use (observed in the argv of
 * a live sidecar: `--setting-sources= --strict-mcp-config --permission-mode dontAsk
 * --no-session-persistence`). Both forms were measured to work; this one matches the CLI's
 * own usage and cannot be mistaken for a missing value by a future argv parser.
 */
export function settingSourcesArgv(spec = {}) {
  const { profile, sources } = resolveSettingSources(spec);

  // `inherit` passes no MCP flags at all, so an `mcpConfig` alongside it cannot be honoured.
  // Silently dropping it was a real mismatch: the argv had no `--mcp-config` while
  // `describeEnv()` recorded one, so the audit record claimed the worker was given a server it
  // never received. This module throws on a declaration it cannot honour everywhere else; a
  // contradiction between two fields of the same declaration is no different.
  if (profile === 'inherit' && spec.mcpConfig) {
    throw new Error("spec.mcpConfig cannot be combined with envProfile: 'inherit' — inherit passes no MCP flags, so the config would be silently ignored. Use envProfile 'project' or 'none' with mcpConfig.");
  }

  const args = [];
  // `inherit` is the one profile that passes nothing, so the CLI's own default applies.
  if (sources !== null) args.push(`--setting-sources=${sources.join(',')}`);

  // MCP is a separate axis (see the header). A worker gets exactly the servers it was
  // handed and nothing else; with no --mcp-config that is zero servers.
  if (profile !== 'inherit') {
    args.push('--strict-mcp-config');
    for (const cfg of spec.mcpConfig ? [].concat(spec.mcpConfig) : []) args.push('--mcp-config', cfg);
  }
  return args;
}

/**
 * Every `.claude/settings.json` that could apply to a worker at `cwd`, nearest first.
 *
 * Settings resolution walks UP from the working directory, so the file that shapes a
 * worker is frequently not in the directory the worker was started in -- in the repo this
 * was built in, `custom-team-dashboard/` has no `.claude/` of its own and its parent does.
 * Recording only `cwd/.claude/settings.json` would therefore report "no project settings"
 * for a worker that has them.
 *
 * The walk is bounded by the filesystem root and by `maxDepth`, and every read is
 * best-effort: this is an observability record, so a settings file that cannot be read
 * must degrade to a note about that rather than failing a spawn.
 */
export function projectSettingsChain(cwd, { maxDepth = 64, home = homedir() } = {}) {
  const chain = [];

  // ABSOLUTE, always. A relative `cwd` (`"."`) makes `parse(cwd).root` the empty string and
  // `dirname(".")` return `"."`, so the loop terminated after one iteration and reported "no
  // project settings" for a worker that has them — while also writing a relative path into an
  // audit record, which is ambiguous the moment anything reads it from elsewhere. The spawned
  // child resolves `"."` against the supervisor's cwd, so this must resolve it the same way.
  const start = resolve(cwd);
  const root = parse(start).root;

  // `$HOME/.claude/settings.json` is the USER source, by definition — it is exactly what
  // `--setting-sources=project` does NOT load (measured: the developer's 2 hooks there do not
  // fire under the project-only profile). Walking past `$HOME` therefore recorded that file as
  // "actually in effect" on every single run, which is worse than recording nothing: the guard
  // exists to stop an investigation being misdirected, and it was doing the misdirecting. In the
  // repo this was built in it was the ONLY entry recorded.
  //
  // `home` is injectable so this boundary can be tested without depending on the developer's
  // real home directory.
  const boundary = home ? resolve(home) : null;

  let dir = start;
  for (let i = 0; i < maxDepth; i += 1) {
    const path = join(dir, '.claude', 'settings.json');
    try {
      const raw = readFileSync(path, 'utf8');
      chain.push({ path, sha256: createHash('sha256').update(raw).digest('hex').slice(0, 16), bytes: raw.length });
    } catch (err) {
      // ENOENT is the overwhelmingly common case and is not worth recording; anything
      // else (a permissions problem, a directory where a file should be) is.
      if (err.code !== 'ENOENT') chain.push({ path, unreadable: err.code || String(err) });
    }
    // Stop AT $HOME having read it? No — stop BEFORE it. The directory itself is the user
    // scope, so its settings file is the user source and must not appear here at all.
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break; // defensive: dirname is a fixed point at the root
    if (boundary && parent === boundary) break;
    dir = parent;
  }
  // `maxDepth` is a loop bound, not a policy: 64 rather than 32 because the CLI's own
  // resolution has no such limit, and a truncated walk silently under-reports. If it is ever
  // hit, that is recorded rather than inferred from a short list.
  if (chain.length >= 0 && depthExhausted(start, root, boundary, maxDepth)) {
    chain.push({ truncatedAfterDepth: maxDepth, note: 'the walk was bounded before reaching the project boundary; this record may be incomplete' });
  }
  return chain;
}

/** True if `maxDepth` stopped the walk before it reached its natural boundary. */
function depthExhausted(start, root, boundary, maxDepth) {
  let dir = start;
  for (let i = 0; i < maxDepth; i += 1) {
    if (dir === root) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    if (boundary && parent === boundary) return false;
    dir = parent;
  }
  return true;
}

/**
 * The record emitted as a `worker.env` event at spawn. This is the guard described in the
 * header: the environment a worker actually got, written down at the moment it got it.
 */
export function describeEnv(spec = {}) {
  const { profile, sources } = resolveSettingSources(spec);
  const inherited = profile === 'inherit';
  // Derived through `settingSourcesArgv`, not recomputed alongside it, for two reasons: it is
  // the same validation the spawn gets (so a declaration this module refuses cannot be recorded
  // as though it were honoured), and recording the ARGV means the record shows the exact flags
  // the child was given rather than a second description of them that can drift.
  const argv = settingSourcesArgv(spec);
  return {
    profile,
    settingSources: sources,
    argv,
    strictMcpConfig: !inherited,
    mcpConfig: spec.mcpConfig ? [].concat(spec.mcpConfig) : [],
    inherited,
    // Only meaningful when the `project` source is actually loaded; recorded as an empty
    // chain otherwise so the field's absence never has to be interpreted.
    projectSettings: (sources ?? VALID_SETTING_SOURCES).includes('project') && spec.cwd
      ? projectSettingsChain(spec.cwd)
      : [],
  };
}
