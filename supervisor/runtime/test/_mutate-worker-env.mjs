#!/usr/bin/env node
// _mutate-worker-env.mjs — mutation harness for the worker-environment decision
// (Phase 2, item 2: adapters/claude-code/worker-env.js).
//
// Same standing rule as _mutate-approval.mjs and the Group 5 / 0003 runs: new code has no
// "pre-fix" version, so each mechanism is broken one at a time and the test must fail AT
// THE CASE that claims to protect it. A mutation that PASSES is a finding either way —
// either the mechanism is not load-bearing, or the assertion does not test it.
//
// Why this matters more than usual here: every defect in this module is SILENT. A worker
// that inherits the developer's global config still answers, still finishes, still looks
// fine — it just costs more tokens, behaves differently, and cannot be reproduced on
// another machine. There is no crash to notice, so the assertions are the only alarm.
//
// Usage: node runtime/test/_mutate-worker-env.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  env: path.join(SUPERVISOR, 'adapters/claude-code/worker-env.js'),
  adapter: path.join(SUPERVISOR, 'adapters/claude-code/adapter.js'),
  opencode: path.join(SUPERVISOR, 'adapters/opencode/adapter.js'),
};

// The pure suite; fast, and where most of these mechanisms live.
const UNIT = 'adapters/claude-code/test/test-worker-env.mjs';
// The spawning suite; asserts the argv that actually reached a process.
const ADAPTER = 'adapters/claude-code/test/test-claude-code-adapter.mjs';
// The OTHER harness. Included because the environment decision is a cross-harness contract, and
// the Phase 2 review's own lesson is that a review (or a mutation run) only covers the files it
// is given -- omitting the second adapter is how a finding got mis-rated once already.
const OPENCODE = 'adapters/opencode/test/test-opencode-adapter.mjs';

const MUTATIONS = [
  {
    name: 'E1-default-is-inherit',
    breaksCase: 'default pins the environment instead of inheriting',
    file: F.env,
    why: 'The default reverting to full inheritance — precisely the bug this module exists to fix. Measured baseline: 6 MCP servers, 110 tools, 2 SessionStart hooks in an empty directory.',
    breaks: 'unit "default pins the environment instead of inheriting"',
    test: UNIT,
    find: `export const DEFAULT_PROFILE = 'none';`,
    replace: `export const DEFAULT_PROFILE = 'inherit'; // MUTANT`,
  },
  {
    name: 'E21-default-executes-repo-hooks',
    breaksCase: 'default pins the environment instead of inheriting',
    file: F.env,
    why: "Flipping the default back to `'project'`. That option LOADS AND EXECUTES a repo's committed hooks before the worker's first turn, and the owner's decision (2026-09-08) is that anything executing repo-controlled code is off unless switched on. The failure is silent and one-way: a hook only has to run once, and nothing errors -- which is why the default is the thing under test rather than the capability.",
    breaks: 'unit "default pins the environment instead of inheriting"',
    test: UNIT,
    find: `export const DEFAULT_PROFILE = 'none';`,
    replace: `export const DEFAULT_PROFILE = 'project'; // MUTANT: repo hooks execute by default`,
  },
  {
    name: 'E22-session-switch-falls-back-silently',
    breaksCase: 'repo config is opt-in at both the run and session level',
    file: F.env,
    why: "Silently falling back to the safe default when CTD_WORKER_ENV_PROFILE is invalid. Friendlier-looking and wrong: somebody who typed it intended to turn repo config ON, and running with it OFF is the intent-vs-reality mismatch the whole `worker.env` record exists to catch. A switch that silently does nothing is worse than one that refuses.",
    breaks: 'unit "repo config is opt-in at both the run and session level"',
    test: UNIT,
    find: `  if (!Object.hasOwn(PROFILES, raw)) {`,
    replace: `  if (false) { // MUTANT: invalid session switch silently ignored`,
  },
  {
    name: 'E2-empty-list-drops-the-flag',
    breaksCase: '\'none\' emits an empty value, not a missing flag',
    file: F.env,
    why: "Treating an empty source list as 'no flag needed'. Omitting --setting-sources means LOAD EVERYTHING, so this turns 'none' into the exact opposite of what it asks for — the most inviting wrong simplification in the file.",
    breaks: `unit "'none' emits an empty value, not a missing flag"`,
    test: UNIT,
    find: `  if (sources !== null) args.push(\`--setting-sources=\${sources.join(',')}\`);`,
    replace: `  if (sources !== null && sources.length) args.push(\`--setting-sources=\${sources.join(',')}\`); // MUTANT`,
  },
  {
    name: 'E3-mcp-axis-not-pinned',
    breaksCase: 'both axes (settings, MCP) are pinned independently',
    file: F.env,
    why: 'Pinning the settings axis but not the MCP axis. Measured as independent: --setting-sources alone still left the developer\'s MCP servers reachable in principle, and --strict-mcp-config alone left all 3 hooks firing. Two axes, two flags.',
    breaks: 'unit "both axes (settings, MCP) are pinned independently"',
    test: UNIT,
    find: `    args.push('--strict-mcp-config');`,
    replace: `    // MUTANT: MCP axis left inherited`,
  },
  {
    name: 'E4-invalid-declaration-falls-back',
    breaksCase: 'an invalid declaration throws instead of defaulting',
    file: F.env,
    why: 'Silently defaulting instead of throwing on an unknown profile. A worker would run in an environment nobody asked for with nothing to indicate it — the same silent-failure shape as a missing --permission-prompt-tool.',
    breaks: 'unit "an invalid declaration throws instead of defaulting"',
    test: UNIT,
    find: `  if (!Object.hasOwn(PROFILES, name)) {
    throw new Error(\`unknown spec.envProfile \${JSON.stringify(name)}; valid: \${Object.keys(PROFILES).join(', ')}\`);
  }
  return { profile: name, sources: PROFILES[name] };`,
    replace: `  if (!Object.hasOwn(PROFILES, name)) return { profile: DEFAULT_PROFILE, sources: PROFILES[DEFAULT_PROFILE] }; // MUTANT
  return { profile: name, sources: PROFILES[name] };`,
  },
  {
    name: 'E5-local-source-in-the-default-profile',
    breaksCase: 'the local source is unreachable by default or by profile',
    file: F.env,
    why: 'Adding the gitignored, machine-specific local source to the default profile. This is the one change that would quietly destroy the reproducibility the whole decision was made for, while every test that only checks "project is present" keeps passing.',
    breaks: 'unit "the local source is unreachable by default or by profile"',
    test: UNIT,
    find: `  project: ['project'],`,
    replace: `  project: ['project', 'local'], // MUTANT`,
  },
  {
    name: 'E6-settings-chain-does-not-walk-up',
    breaksCase: 'the project settings chain walks upward, nearest first',
    file: F.env,
    why: "Recording only cwd/.claude/settings.json. Settings resolution walks UP, so this reports 'no project settings' for a worker that has them from an ancestor — the actual layout of this repo. The guard would then be quietly useless exactly when it is needed.",
    breaks: 'unit "the project settings chain walks upward, nearest first"',
    test: UNIT,
    find: `    if (dir === root) break;`,
    replace: `    break; // MUTANT: no upward walk`,
  },
  {
    name: 'E7-digest-is-constant',
    breaksCase: 'the project settings chain walks upward, nearest first',
    file: F.env,
    why: 'A digest that cannot distinguish two different settings files. The record would still look populated and still be worthless for the one question it exists to answer: did the environment change between generations?',
    breaks: 'unit "the project settings chain walks upward, nearest first" (its edited-file assertion)',
    test: UNIT,
    find: `      chain.push({ path, sha256: createHash('sha256').update(raw).digest('hex').slice(0, 16), bytes: raw.length });`,
    replace: `      chain.push({ path, sha256: 'aaaaaaaaaaaaaaaa', bytes: raw.length }); // MUTANT`,
  },
  {
    name: 'E8-unreadable-settings-throws',
    breaksCase: 'an unreadable settings file is recorded, not thrown',
    file: F.env,
    why: 'Letting a settings file that cannot be read propagate. An observability record would then be able to block a spawn — a note about the worker preventing the worker.',
    breaks: 'unit "an unreadable settings file is recorded, not thrown"',
    test: UNIT,
    find: `      if (err.code !== 'ENOENT') chain.push({ path, unreadable: err.code || String(err) });`,
    replace: `      if (err.code !== 'ENOENT') throw err; // MUTANT`,
  },
  {
    name: 'E9-argv-never-reaches-the-spawn',
    breaksCase: 'env: a worker\'s environment is pinned in argv, and inherit escapes',
    file: F.adapter,
    why: "The decision existing in a module but not in the argv. Every pure unit test would still pass — this is the mutation that proves the adapter-level cases are not redundant with them.",
    breaks: `adapter "env: a worker's environment is pinned in argv, and inherit escapes"`,
    test: ADAPTER,
    find: `  args.push(...settingSourcesArgv(spec));`,
    replace: `  // MUTANT: environment decided but never passed`,
  },
  {
    name: 'E10-resume-is-not-re-recorded',
    breaksCase: 'env: the pin and its record survive resume()',
    file: F.adapter,
    why: 'One worker.env per run instead of one per generation. The record would then describe the environment generation 1 had, presented as the live process\'s — and settings on disk can change between generations (a git pull, an edited hook).',
    breaks: 'adapter "env: the pin and its record survive resume()"',
    test: ADAPTER,
    find: `  run._emitEvent({ type: 'worker.env', runId, resumed: true, ...describeEnv(run.spec) });`,
    replace: `  // MUTANT: resumed generation not re-recorded`,
  },
  {
    name: 'E11-validation-after-registration',
    breaksCase: 'env: an invalid declaration spawns and registers nothing',
    file: F.adapter,
    why: "Building the argv after the run is registered, so a throw leaves a runs entry with no child — the adapter-state twin of review-0003's start() defect, where a spawn preceded its row and left a live child with no row.",
    breaks: 'adapter "env: an invalid declaration spawns and registers nothing"',
    test: ADAPTER,
    find: `  const args = _buildArgs(spec);

  const runId = randomUUID();
  const run = new Run(runId, spec);
  runs.set(runId, run);`,
    replace: `  const runId = randomUUID();
  const run = new Run(runId, spec);
  runs.set(runId, run);
  const args = _buildArgs(spec); // MUTANT: validated after registration`,
  },
  {
    name: 'E13-home-settings-recorded-as-project',
    breaksCase: 'the user-global settings file is never recorded as project',
    file: F.env,
    why: "Walking past $HOME, so `$HOME/.claude/settings.json` — which IS the user source and is provably NOT loaded under --setting-sources=project — is recorded as 'actually in effect'. Found by the cross-model review; before the fix it was the ONLY entry recorded in this repo, so the guard built to stop an investigation being misdirected was doing the misdirecting.",
    breaks: 'unit "the user-global settings file is never recorded as project"',
    test: UNIT,
    find: `    if (boundary && parent === boundary) break;`,
    replace: `    // MUTANT: no user-scope boundary`,
  },
  {
    name: 'E14-relative-cwd-not-resolved',
    breaksCase: 'a relative cwd is resolved before walking',
    file: F.env,
    why: 'Not resolving cwd. `parse(".").root` is "" and `dirname(".")` is ".", so the walk stops after one directory and reports no project settings for a worker that has them — while writing an ambiguous relative path into an audit record.',
    breaks: 'unit "a relative cwd is resolved before walking"',
    test: UNIT,
    find: `  const start = resolve(cwd);`,
    replace: `  const start = cwd; // MUTANT: unresolved`,
  },
  {
    name: 'E15-inherit-plus-mcp-silently-dropped',
    breaksCase: "'inherit' with an mcpConfig is refused, not silently dropped",
    file: F.env,
    why: 'Silently dropping an mcpConfig that cannot be honoured under `inherit`, so the argv has no --mcp-config while the record claims one. The audit record would state the worker was given a server it never received.',
    breaks: `unit "'inherit' with an mcpConfig is refused, not silently dropped"`,
    test: UNIT,
    find: `  if (profile === 'inherit' && spec.mcpConfig) {`,
    replace: `  if (false && profile === 'inherit' && spec.mcpConfig) { // MUTANT: contradiction allowed`,
  },
  {
    name: 'E16-truncated-walk-is-silent',
    breaksCase: 'the project settings walk terminates and is bounded',
    file: F.env,
    why: 'A depth-bounded walk that does not say it was bounded. A short list then looks exactly like "this worker has no project settings", which is the same misdirection as E13 in a rarer shape.',
    breaks: 'unit "the project settings walk terminates and is bounded"',
    test: UNIT,
    find: `    chain.push({ truncatedAfterDepth: maxDepth, note: 'the walk was bounded before reaching the project boundary; this record may be incomplete' });`,
    replace: `    void 0; // MUTANT: truncation not recorded`,
  },
  {
    name: 'E20-opencode-pins-config-and-kills-the-roster',
    breaksCase: 'env: the bedrock agent roster is protected (config resolution passed through)',
    file: F.opencode,
    why: "Pinning the server's config by relocating XDG_CONFIG_HOME. This is the plausible future 'fix' for OpenCode's unpinned environment, and it silently removes the amazon-bedrock agent roster (luna/sol/terra/opus) that this project REQUIRES for cross-model review and sometimes for coding. Measured: an empty config dir takes /agent from 20 to 7. A pin must use a CURATED config dir (agent+provider+model, mcp omitted), which keeps all 13 and still reports mcp=0.",
    breaks: 'opencode "env: the bedrock agent roster is protected (config resolution passed through)"',
    test: OPENCODE,
    find: `    cwd,
    // Finding S6: stdout/stderr were piped but never read anywhere, which`,
    replace: `    cwd,
    env: { XDG_CONFIG_HOME: '/nonexistent-pinned-config' }, // MUTANT: pins config, kills the roster
    // Finding S6: stdout/stderr were piped but never read anywhere, which`,
  },
  {
    name: 'E17-opencode-silently-ignores-a-declaration',
    breaksCase: 'env: a per-run environment declaration is refused, not ignored',
    file: F.opencode,
    why: 'Accepting a per-run environment declaration OpenCode cannot honour. `opencode serve` has no config flag and one server is pooled across every run in a cwd, so the caller would believe a worker is pinned when nothing pinned it — strictly worse than not offering the feature.',
    breaks: 'opencode "env: a per-run environment declaration is refused, not ignored"',
    test: OPENCODE,
    find: `  if (spec.envProfile !== undefined || spec.settingSources !== undefined || spec.mcpConfig !== undefined) {`,
    replace: `  if (false) { // MUTANT: declaration silently ignored`,
  },
  {
    name: 'E18-opencode-env-not-recorded',
    breaksCase: 'env: the server-scoped environment is recorded from the server itself',
    file: F.opencode,
    why: "Not recording what the pooled server actually loaded. Measured: in an empty directory a server loads the developer's global config (8 MCP servers, 13 agents, 2 plugins) and nothing suppresses it — so with no record an OpenCode worker's environment is both unpinned AND invisible.",
    breaks: 'opencode "env: the server-scoped environment is recorded from the server itself"',
    test: OPENCODE,
    find: `  run._emitEvent({ type: 'worker.env', runId, scope: 'server', ...(await describeServerEnv(server)) });`,
    replace: `  // MUTANT: server environment never recorded`,
  },
  {
    name: 'E19-unavailable-env-reads-as-empty',
    breaksCase: 'env: an unavailable read is not recorded as an empty environment',
    file: F.opencode,
    why: 'Reporting a failed /config read as an EMPTY environment. "We could not ask" and "it loaded nothing" are opposite facts, and the second is exactly what a correctly pinned server looks like — so this failure mode manufactures false reassurance.',
    breaks: 'opencode "env: an unavailable read is not recorded as an empty environment"',
    test: OPENCODE,
    find: `    if (!res.ok) return { envUnavailable: \`GET /config -> \${res.status}\` };`,
    replace: `    if (!res.ok) return { mcpServers: [], agentCount: 0, pluginCount: 0 }; // MUTANT: failure looks pinned`,
  },
  {
    // ORIGINALLY this mutation moved the worker.env emit to AFTER the spawn and claimed to
    // break "worker.env is the first event". It PASSED — and chasing why was worth more
    // than the mutation: a failed spawn (ENOENT, EACCES) arrives ASYNCHRONOUSLY as an
    // 'error' event, so the event log gets worker.env either way and the ordering is not
    // independently observable. The ordering is a readability choice, now labelled as one.
    //
    // What the same code region DOES have is a load-bearing mechanism nobody had noticed:
    // `spawnManaged` throws SYNCHRONOUSLY at the spawn-depth ceiling, before `spawn()`, and
    // `start()` had already registered the run. So this mutation now targets that.
    name: 'E12-sync-spawn-refusal-leaks-a-registration',
    breaksCase: 'env: a synchronous spawn refusal registers nothing',
    file: F.adapter,
    why: 'Not cleaning up after a synchronous spawn refusal. `spawnManaged` throws before spawn() at the spawn-depth ceiling, leaving a runs entry with no child and no process — unreachable and never disposed, because a throwing start() never returned its runId to anyone.',
    breaks: 'adapter "env: a synchronous spawn refusal registers nothing"',
    test: ADAPTER,
    find: `  try {
    _adoptChild(run, spawnManaged({ command: CLAUDE_BIN, args, cwd }));
  } catch (err) {
    runs.delete(runId);
    throw err;
  }`,
    replace: `  _adoptChild(run, spawnManaged({ command: CLAUDE_BIN, args, cwd })); // MUTANT: no cleanup on a synchronous refusal`,
  },
];

const exitCode = await runMutations(MUTATIONS, {
  cwd: SUPERVISOR,
  filter: process.argv[2],
});
process.exit(exitCode);
