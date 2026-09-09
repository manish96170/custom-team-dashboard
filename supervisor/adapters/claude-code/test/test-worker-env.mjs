#!/usr/bin/env node
// Tests for worker-env.js — what environment a spawned worker gets (Phase 2, item 2).
//
// These are PURE: no spawn, no network, no tokens. The behaviour they cover is a decision
// about argv and a record of what was decided, and both are computable without a process.
// The measurement that JUSTIFIES the decision is a separate thing and lives in
// ../probe/worker-env-probe.mjs, which talks to the real CLI; asserting these values
// against a fake would prove only that the fake agrees with itself.
//
// Run: node supervisor/adapters/claude-code/test/test-worker-env.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveSettingSources,
  settingSourcesArgv,
  projectSettingsChain,
  describeEnv,
  PROFILES,
  DEFAULT_PROFILE,
  sessionDefaultProfile,
  VALID_SETTING_SOURCES,
} from '../worker-env.js';

/** The settings-file entries, dropping the bookkeeping marker a truncated walk appends. */
const files = (chain) => chain.filter((e) => e.path);

// ---------------------------------------------------------------------------
// The default is the whole point of the change: a spec that says NOTHING about
// its environment must still get a pinned one. Before this module, saying nothing
// meant inheriting the developer's entire global config.
// ---------------------------------------------------------------------------
function test_default_pins_the_environment() {
  const argv = settingSourcesArgv({ prompt: 'hi', cwd: '/tmp' });
  // The default is `'none'` by owner decision (2026-09-08): `--setting-sources=project` EXECUTES a
  // repo's committed hooks, and anything that executes repo-controlled code is off unless switched on.
  assert.deepEqual(argv, ['--setting-sources=', '--strict-mcp-config'],
    'a spec with no env declaration must load NO settings sources and no MCP');
  assert.equal(DEFAULT_PROFILE, 'none');
}

/**
 * Turning repo config ON is possible at two levels, and both must be explicit.
 *
 * The per-session switch is the one worth testing carefully: it is read at CALL time, so a caller that
 * sets it late is not silently ignored, and an invalid value THROWS rather than falling back to the safe
 * default — somebody who typed it meant to turn something on, and running with it off is exactly the
 * intent-vs-reality mismatch the `worker.env` record exists to catch.
 */
function test_repo_config_is_opt_in_at_two_levels() {
  const saved = process.env.CTD_WORKER_ENV_PROFILE;
  try {
    // per run
    assert.deepEqual(settingSourcesArgv({ cwd: '/tmp', envProfile: 'project' }),
      ['--setting-sources=project', '--strict-mcp-config'], 'a run may opt in');

    // per session
    delete process.env.CTD_WORKER_ENV_PROFILE;
    assert.equal(sessionDefaultProfile(), 'none', 'unset means off');
    process.env.CTD_WORKER_ENV_PROFILE = 'project';
    assert.equal(sessionDefaultProfile(), 'project');
    assert.deepEqual(settingSourcesArgv({ cwd: '/tmp' }),
      ['--setting-sources=project', '--strict-mcp-config'],
      'and it changes the default for specs that say nothing');

    // A run's own declaration still wins over the session switch — the narrower statement is the
    // more specific intent.
    assert.deepEqual(settingSourcesArgv({ cwd: '/tmp', envProfile: 'none' }),
      ['--setting-sources=', '--strict-mcp-config'], 'an explicit per-run profile overrides the session');

    process.env.CTD_WORKER_ENV_PROFILE = 'projekt';
    assert.throws(() => sessionDefaultProfile(), /not a profile/,
      'a typo must throw, not silently run with repo config off');
    process.env.CTD_WORKER_ENV_PROFILE = '';
    assert.equal(sessionDefaultProfile(), 'none', 'and an empty value is the same as unset');
  } finally {
    if (saved === undefined) delete process.env.CTD_WORKER_ENV_PROFILE;
    else process.env.CTD_WORKER_ENV_PROFILE = saved;
  }
}

// Two flags, two axes. A regression that dropped one while keeping the other would
// silently restore either the developer's hooks or the developer's MCP servers, and
// the measured table shows those are independent (--strict-mcp-config alone left all
// 3 hooks firing).
function test_both_axes_are_pinned_independently() {
  const argv = settingSourcesArgv({ envProfile: 'none' });
  assert.ok(argv.includes('--setting-sources='), 'the settings axis must be pinned');
  assert.ok(argv.includes('--strict-mcp-config'), 'the MCP axis must be pinned separately');
}

// The empty list must be the `=`-joined empty form, not a dropped flag. `--setting-sources`
// omitted entirely means "load everything", so an implementation that skipped the flag for
// an empty array would produce the exact opposite of what `none` asks for.
function test_none_emits_an_empty_value_not_a_missing_flag() {
  const argv = settingSourcesArgv({ envProfile: 'none' });
  assert.ok(argv.includes('--setting-sources='),
    `'none' must pass an empty value; got: ${argv.join(' ')}`);
  assert.equal(argv.some((a) => a === '--setting-sources'),
    false, 'and must not pass the bare flag with a separate empty argument');
}

// `inherit` is the escape hatch: it must pass NEITHER flag, so the CLI's own defaults
// apply, and it must be visible as inherited in the record.
function test_inherit_passes_nothing_and_says_so() {
  const argv = settingSourcesArgv({ envProfile: 'inherit' });
  assert.deepEqual(argv, [], 'inherit must add no environment flags at all');
  const desc = describeEnv({ envProfile: 'inherit', cwd: '/tmp' });
  assert.equal(desc.inherited, true, 'and must be recorded as inherited');
  assert.equal(desc.strictMcpConfig, false);
  assert.deepEqual(desc.projectSettings, [],
    'no project chain is recorded for inherit: the CLI resolved sources we did not choose, so a chain here would imply we knew what applied');
}

// An invalid declaration must THROW, not fall back. A silent fallback is how a worker ends
// up in an environment nobody asked for — the same failure shape as the silently-absent
// --permission-prompt-tool flag. Measured: the CLI itself exits 1 on a bad value, so a
// fallback would also be hiding a spawn that was going to fail anyway.
function test_invalid_declarations_throw() {
  assert.throws(() => resolveSettingSources({ envProfile: 'bogus' }), /unknown spec.envProfile/,
    'an unknown profile must throw');
  assert.throws(() => resolveSettingSources({ settingSources: ['project', 'nope'] }), /invalid source/,
    'an unknown source must throw and name itself');
  assert.throws(() => resolveSettingSources({ settingSources: 'project' }), /must be an array/,
    'a string where a list belongs must throw rather than being treated as a list of characters');
  // And the error must name the valid options, because this throw is the only feedback a
  // caller gets and "invalid" alone would send them to the source.
  try {
    resolveSettingSources({ envProfile: 'bogus' });
    assert.fail('unreachable');
  } catch (err) {
    for (const p of Object.keys(PROFILES)) {
      assert.ok(err.message.includes(p), `the error must list the valid profile ${p}`);
    }
  }
}

// An explicit list is for combinations no profile names, and must beat a profile rather
// than being quietly ignored — a caller who passed both was more specific with the list.
function test_explicit_list_wins_and_dedupes() {
  const { profile, sources } = resolveSettingSources({ envProfile: 'none', settingSources: ['project', 'local', 'project'] });
  assert.equal(profile, 'explicit');
  assert.deepEqual(sources, ['project', 'local'], 'duplicates must collapse');
  assert.deepEqual(settingSourcesArgv({ settingSources: ['project', 'local'] }),
    ['--setting-sources=project,local', '--strict-mcp-config']);
}

// `local` is `.claude/settings.local.json`: gitignored and machine-specific, so it is the
// one source that makes "it worked for me" unfalsifiable. It must never arrive by default
// or by profile — only by a caller naming it explicitly.
function test_local_is_never_reachable_by_default_or_by_profile() {
  assert.equal(settingSourcesArgv({}).includes('--setting-sources=project,local'), false);
  for (const [name, sources] of Object.entries(PROFILES)) {
    if (sources === null) continue;
    assert.equal(sources.includes('local'), false, `profile ${name} must not include the local source`);
  }
  // ...but naming it explicitly still works, because it is a deliberate exception.
  assert.deepEqual(resolveSettingSources({ settingSources: ['local'] }).sources, ['local']);
}

// MCP servers arrive only when handed over, and each config gets its own flag pair.
function test_mcp_config_is_passed_through() {
  assert.deepEqual(settingSourcesArgv({ mcpConfig: '/a.json' }),
    ['--setting-sources=', '--strict-mcp-config', '--mcp-config', '/a.json']);
  assert.deepEqual(settingSourcesArgv({ mcpConfig: ['/a.json', '/b.json'] }),
    ['--setting-sources=', '--strict-mcp-config', '--mcp-config', '/a.json', '--mcp-config', '/b.json'],
    'a list of configs must each get their own --mcp-config');
}

// ---------------------------------------------------------------------------
// The traceability guard. Settings resolution walks UP from the working directory,
// so recording only `cwd/.claude/settings.json` would report "no project settings"
// for a worker that has them from an ancestor — which is the actual layout of the
// repo this was built in.
// ---------------------------------------------------------------------------
function test_project_settings_chain_walks_upward() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-env-chain-'));
  const mid = path.join(root, 'mid');
  const leaf = path.join(mid, 'leaf');
  fs.mkdirSync(leaf, { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'));
  fs.mkdirSync(path.join(mid, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{"a":1}');
  fs.writeFileSync(path.join(mid, '.claude', 'settings.json'), '{"b":2}');

  const chain = files(projectSettingsChain(leaf, { home: null }));
  const found = chain.filter((c) => c.sha256).map((c) => c.path);
  assert.deepEqual(found, [
    path.join(mid, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.json'),
  ], 'nearest first, and an ancestor must be found even though the cwd has no .claude/');

  // A digest, not the contents: a settings file can carry secrets, and this record goes
  // into the event log. It must still DISTINGUISH two different files, or it cannot answer
  // "did this change between generations", which is the question it exists for.
  const [nearest] = chain;
  assert.match(nearest.sha256, /^[0-9a-f]{16}$/, 'a short hex digest');
  assert.equal(nearest.bytes, 7);
  fs.writeFileSync(path.join(mid, '.claude', 'settings.json'), '{"b":3}');
  assert.notEqual(files(projectSettingsChain(leaf, { home: null }))[0].sha256, nearest.sha256,
    'an edited settings file must produce a different digest');

  fs.rmSync(root, { recursive: true, force: true });
}

// The walk must terminate at the filesystem root rather than looping on dirname's fixed
// point, and must not throw for a cwd with nothing above it.
function test_project_settings_chain_terminates() {
  const chain = projectSettingsChain(path.parse(process.cwd()).root);
  assert.ok(Array.isArray(chain), 'walking from the root itself must return, not hang or throw');
  const deep = projectSettingsChain(process.cwd(), { maxDepth: 1 });
  assert.ok(files(deep).length <= 1, 'maxDepth must bound the walk');
  // A bounded walk must SAY it was bounded. Silently returning a short list is the failure
  // mode: it looks exactly like "this worker has no project settings at all".
  assert.ok(deep.some((e) => e.truncatedAfterDepth === 1),
    `a truncated walk must record that it was truncated, got ${JSON.stringify(deep)}`);
}

// An unreadable settings file is recorded as unreadable rather than failing a spawn: this
// is an observability record, and a worker must not be blocked by a note about itself.
// ENOENT is excluded because it is the common case and would swamp the record.
function test_unreadable_settings_are_recorded_not_thrown() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-env-unread-'));
  // A DIRECTORY where settings.json should be: reads with EISDIR, not ENOENT.
  fs.mkdirSync(path.join(root, '.claude', 'settings.json'), { recursive: true });

  // Called through a catch so that "the error escaped" becomes an ASSERTION failure rather
  // than an uncaught throw. The mutation harness requires a real `AssertionError`, because a
  // mutation that merely crashes the module proves nothing — and this case's mechanism is
  // precisely "an error must NOT escape", so letting it escape and end the suite would report
  // the crash as the proof.
  let chain;
  try {
    chain = projectSettingsChain(root, { maxDepth: 1 });
  } catch (err) {
    assert.fail(`projectSettingsChain must record an unreadable settings file, not throw; it threw ${err.code || err.message}`);
  }
  const entries = files(chain);
  assert.equal(entries.length, 1, 'the problem must be recorded');
  assert.ok(entries[0].unreadable, `expected an unreadable note, got ${JSON.stringify(entries[0])}`);
  assert.equal(entries[0].sha256, undefined, 'and must not claim a digest it does not have');
  fs.rmSync(root, { recursive: true, force: true });
}

// The record must describe the environment that was actually chosen, because it is the
// only evidence available later about why a worker behaved as it did.
function test_describeEnv_records_what_was_chosen() {
  const desc = describeEnv({ cwd: process.cwd() });
  assert.equal(desc.profile, 'none', 'the default records itself as none');
  assert.deepEqual(desc.settingSources, []);
  assert.equal(desc.strictMcpConfig, true);
  assert.equal(desc.inherited, false);
  assert.deepEqual(desc.mcpConfig, []);
  assert.ok(Array.isArray(desc.projectSettings));

  // With the project source NOT loaded, the chain is empty rather than absent: a field
  // that is sometimes missing has to be interpreted, and a reader would have to know
  // whether "missing" meant "not loaded" or "none found".
  assert.deepEqual(describeEnv({ envProfile: 'none', cwd: process.cwd() }).projectSettings, [],
    'no project source means no chain');
  // ...and the chain IS collected when repo config is opted into, or the record could not name the
  // files that shaped a worker in the one case where files shape it.
  assert.ok(Array.isArray(describeEnv({ envProfile: 'project', cwd: process.cwd() }).projectSettings),
    'opting in collects the settings chain');
}

// ---------------------------------------------------------------------------
// Findings from the cross-model review (review-phase2-item2/). Each of these was a
// case where the RECORD disagreed with what the CLI actually did — which in a guard
// built to stop an investigation being misdirected is the worst possible defect.
// ---------------------------------------------------------------------------

// `$HOME/.claude/settings.json` IS the user source. `--setting-sources=project` provably does
// not load it (measured: the developer's 2 hooks there do not fire under the project profile),
// so recording it as "in effect" pointed every investigation at a file that shaped nothing.
// Before the fix it was the ONLY entry recorded in this repo.
function test_the_user_global_settings_file_is_never_recorded_as_project() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-env-home-'));
  const repo = path.join(home, 'code', 'repo');
  const work = path.join(repo, 'packages', 'app');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"user":true}');
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{"project":true}');

  const chain = files(projectSettingsChain(work, { home }));
  const paths = chain.map((c) => c.path);
  assert.deepEqual(paths, [path.join(repo, '.claude', 'settings.json')],
    `only the project file may be recorded; got ${JSON.stringify(paths)}`);
  assert.equal(paths.some((p) => p.startsWith(path.join(home, '.claude'))), false,
    'the user-global settings file must never appear in a project chain');
  fs.rmSync(home, { recursive: true, force: true });
}

// A relative cwd must resolve exactly as the spawned child resolves it. Unresolved, `parse(".").root`
// is "" and `dirname(".")` is ".", so the walk stopped after one directory and reported no project
// settings for a worker that had them — and wrote an ambiguous relative path into an audit record.
function test_a_relative_cwd_is_resolved_before_walking() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-env-rel-'));
  const leaf = path.join(root, 'a', 'b');
  fs.mkdirSync(leaf, { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{"r":1}');

  const saved = process.cwd();
  try {
    process.chdir(leaf);
    const chain = files(projectSettingsChain('.', { home: null }));
    // Compared through `realpathSync`: on macOS the scratch dir is under /var, which is a
    // symlink to /private/var, and `process.chdir` + `cwd()` hands back the resolved form. The
    // same symlink trap the probes already carry a warning about.
    assert.deepEqual(chain.map((c) => c.path), [fs.realpathSync(path.join(root, '.claude', 'settings.json'))],
      'a relative cwd must still find an ancestor\'s settings');
    for (const c of chain) {
      assert.ok(path.isAbsolute(c.path), `an audit record must hold absolute paths, got ${c.path}`);
    }
  } finally {
    process.chdir(saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// `inherit` passes no MCP flags, so an mcpConfig beside it cannot be honoured. Silently dropping
// it made the record claim a server the child never received — the same silent mismatch this
// module throws on everywhere else.
function test_inherit_with_mcp_config_is_refused() {
  assert.throws(() => settingSourcesArgv({ envProfile: 'inherit', mcpConfig: '/x.json' }),
    /cannot be combined with envProfile: 'inherit'/,
    'a contradiction between two fields of one declaration must throw');
  assert.throws(() => describeEnv({ envProfile: 'inherit', mcpConfig: '/x.json', cwd: '/tmp' }),
    /cannot be combined/,
    'and the record must not be producible either, or it could claim what the argv refused');
}

// The record carries the ARGV, derived from the same function the spawn uses. A second
// description computed alongside the argv is free to drift from it; this cannot.
function test_describeEnv_records_the_actual_argv() {
  const desc = describeEnv({ cwd: process.cwd(), mcpConfig: '/m.json' });
  assert.deepEqual(desc.argv, settingSourcesArgv({ cwd: process.cwd(), mcpConfig: '/m.json' }),
    'the recorded argv must be the argv the child is given');
  assert.ok(desc.argv.includes('--setting-sources='));
  assert.ok(desc.argv.includes('/m.json'));
}

function test_valid_sources_match_the_cli() {
  // Measured against `claude` 2.1.263, whose own error names them:
  // "Invalid setting source: bogus. Valid options are: user, project, local"
  assert.deepEqual(VALID_SETTING_SOURCES, ['user', 'project', 'local']);
}

const tests = [
  ['default pins the environment instead of inheriting', test_default_pins_the_environment],
  ['repo config is opt-in at both the run and session level', test_repo_config_is_opt_in_at_two_levels],
  ['both axes (settings, MCP) are pinned independently', test_both_axes_are_pinned_independently],
  ["'none' emits an empty value, not a missing flag", test_none_emits_an_empty_value_not_a_missing_flag],
  ["'inherit' passes nothing and is recorded as inherited", test_inherit_passes_nothing_and_says_so],
  ['an invalid declaration throws instead of defaulting', test_invalid_declarations_throw],
  ['an explicit source list wins over a profile, and dedupes', test_explicit_list_wins_and_dedupes],
  ['the local source is unreachable by default or by profile', test_local_is_never_reachable_by_default_or_by_profile],
  ['--mcp-config is passed through, one flag pair each', test_mcp_config_is_passed_through],
  ['the project settings chain walks upward, nearest first', test_project_settings_chain_walks_upward],
  ['the project settings walk terminates and is bounded', test_project_settings_chain_terminates],
  ['an unreadable settings file is recorded, not thrown', test_unreadable_settings_are_recorded_not_thrown],
  ['describeEnv records what was chosen', test_describeEnv_records_what_was_chosen],
  ['the user-global settings file is never recorded as project', test_the_user_global_settings_file_is_never_recorded_as_project],
  ['a relative cwd is resolved before walking', test_a_relative_cwd_is_resolved_before_walking],
  ["'inherit' with an mcpConfig is refused, not silently dropped", test_inherit_with_mcp_config_is_refused],
  ['describeEnv records the actual argv', test_describeEnv_records_the_actual_argv],
  ['the valid source list matches the CLI', test_valid_sources_match_the_cli],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${tests.length} test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} test(s) passed.`);
