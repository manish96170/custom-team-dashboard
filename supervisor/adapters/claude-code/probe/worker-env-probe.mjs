#!/usr/bin/env node
// worker-env-probe.mjs — the reproducible measurement behind the decision recorded in
// adapters/FINDINGS.md, "what environment a spawned worker gets" (Phase 2, item 2).
//
// WHY THIS EXISTS
//
// The real-pane slice caught a spawned worker volunteering a note about an unrelated MCP
// server needing authorization. Nobody asked it about MCP servers: the worker had loaded
// the DEVELOPER'S ENTIRE global Claude Code configuration — MCP servers, SessionStart
// hooks, skills, plugins, agents. adapters/FINDINGS.md recorded that as a design decision
// to be made rather than a patch, and listed the flags to make it with. This probe
// measures what each of those flags ACTUALLY does, because the flag descriptions in
// `claude --help` are not the same thing as the behaviour.
//
// THIS PROBE MAKES NO OBSERVABLE MODEL CALL, and in practice costs nothing measurable.
//
// Stated carefully, because the honest limit matters: what is verified is that no assistant
// output is emitted before the probe kills the process. That is NOT the same as proving no
// request reached the API — a request could in principle be in flight when `init` is emitted,
// and this probe cannot see that. Treat it as "no observable model call", not as a billing
// guarantee. Every other probe in this directory costs real money and says so; this one is
// cheap for two measured reasons:
//
//   1. `init` does NOT arrive on host `initialize` alone. Measured: sending only the
//      `initialize` control_request yields the hook events and a control_response, then
//      nothing — a 25s wait saw no `init`. So a user message is required.
//   2. `init` DOES arrive BEFORE the model is called (~5.4s, consistently). So the probe
//      sends a one-token user message, waits for `init`, and SIGKILLs the process the
//      instant it lands. The turn never reaches the API.
//
// If a future CLI version reorders those, the `MODEL CALL HAPPENED BEFORE INIT` guard below
// says so instead of hiding it. That guard watches `assistant` frames AND the `stream_event`
// frames that actually carry assistant deltas — watching only the former was a false negative,
// since the probe skips `stream_event` as noise.
//
// Run it:  node worker-env-probe.mjs             # every configuration, as a table
//          node worker-env-probe.mjs baseline    # one configuration, full init payload
//
// Captured runs: ./evidence/08-worker-env-matrix.txt

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Not under /tmp, for the same reason permission-host-probe.mjs says not to: on macOS
// /tmp resolves through a symlink and the tool sandbox compares resolved paths.
//
// Default is an EMPTY scratch dir so that whatever a row shows came from the developer's
// own global config and nothing else. `CTD_PROBE_CWD` points it at a real repo instead,
// which is the only way to measure a `project`/`local` setting source: in an empty dir
// `--setting-sources=project` and `--setting-sources=` are indistinguishable, so reading
// a difference from the empty-dir table would be reading a difference that is not there.
const CWD = process.env.CTD_PROBE_CWD || mkdtempSync(join(process.env.HOME, 'ctd-env-probe-'));

// Every pid this probe spawned, so the survivor check can ask about ITS OWN children.
// The first version grepped `ps` for `--permission-prompt-tool` and reported 2 survivors
// that turned out to be unrelated Claude Code sidecars belonging to the developer's live
// session. A hygiene check that cannot tell its own leak from someone else's traffic
// reports a leak that is not there -- which is worse than not checking.
const SPAWNED = [];
const EXITED = new Set();

// The argv the adapter builds today, minus the model/effort bits that do not affect
// which settings sources load. `_buildArgs` in ../adapter.js is the source of truth;
// if these drift apart the probe is measuring a session the adapter never creates.
const ADAPTER_ARGV = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--permission-mode', 'default',
  '--permission-prompt-tool', 'stdio',
];

// Each configuration is EXTRA argv appended to what the adapter already sends. The
// question every row answers is "if the adapter added this, what would the worker load?"
const CONFIGS = [
  ['baseline', []],
  ['setting-sources-empty', ['--setting-sources', '']],
  ['sources-project+strict', ['--setting-sources', 'project', '--strict-mcp-config']],
  ['strict-mcp-only', ['--strict-mcp-config']],
  ['sources-empty+strict', ['--setting-sources', '', '--strict-mcp-config']],
  ['safe-mode', ['--safe-mode']],
  ['safe-mode+strict', ['--safe-mode', '--strict-mcp-config']],
  ['bare', ['--bare']],
  ['bare+strict', ['--bare', '--strict-mcp-config']],
  ['restricted+strict', ['--restricted', '--strict-mcp-config']],
];

/**
 * Spawn one configuration and resolve what its session loaded.
 *
 * Resolves rather than rejects on failure: a configuration that cannot start (`--bare`
 * with no ANTHROPIC_API_KEY is the expected one) is a RESULT, not an error. Recording it
 * as a row is the point — it is the reason that flag cannot be the default.
 */
function measure(extraArgv, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve) => {
    const args = [...ADAPTER_ARGV, ...extraArgv];
    const child = spawn(CLAUDE_BIN, args, { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] });
    SPAWNED.push(child.pid);

    const out = {
      argv: extraArgv.join(' ') || '(none)',
      started: false,
      hookEvents: 0,
      hookNames: [],
      mcpServers: null,
      toolCount: null,
      slashCount: null,
      agentCount: null,
      model: null,
      stderr: [],
      modelCallBeforeInit: false,
      error: null,
    };

    let buf = '';
    let settled = false;
    const done = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.error = out.error || why;
      // SIGKILL the group, not just the pid: the CLI spawns MCP server children, and a
      // probe for process hygiene that leaks processes would be self-refuting. This probe
      // does not use runtime/spawn.js (it is measuring the CLI, not the supervisor), so
      // the child shares our group -- kill by pid and sweep, do not kill(-pgid).
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(out);
    };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        // The model-call guard goes BEFORE the stream_event skip, not after. Assistant output
        // is delivered INSIDE `stream_event` frames, so skipping them first meant the guard
        // could never see the thing it watches for.
        if (o.type === 'assistant' || o.type === 'stream_event') {
          if (o.type === 'assistant' || o.event?.type?.startsWith('content_block') || o.event?.type === 'message_start') {
            out.modelCallBeforeInit = true;
          }
        }
        if (o.type === 'stream_event') continue;

        if (o.type === 'system' && o.subtype === 'hook_started') {
          out.hookEvents += 1;
          const n = o.hook_name || o.hook_event_name || o.hook || null;
          if (n && !out.hookNames.includes(n)) out.hookNames.push(n);
          continue;
        }

        if (o.type === 'system' && o.subtype === 'init') {
          out.started = true;
          out.mcpServers = (o.mcp_servers || []).map((s) => `${s.name}:${s.status}`);
          out.toolCount = o.tools?.length ?? null;
          out.slashCount = o.slash_commands?.length ?? null;
          out.agentCount = o.agents?.length ?? null;
          out.model = o.model ?? null;
          out.rawInit = o;
          done(null);
          return;
        }
      }
    });

    child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) out.stderr.push(s.slice(0, 300));
    });

    // An unstartable configuration exits here instead of timing out.
    child.on('exit', (code, signal) => {
      EXITED.add(child.pid);
      if (!out.started) done(`exited code=${code} signal=${signal} before init`);
    });
    child.on('error', (err) => done(`spawn error: ${err.message}`));

    child.stdin.on('error', () => { /* a dead child's stdin EPIPEs; the exit handler reports it */ });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'i1', request: { subtype: 'initialize' } }) + '\n');
    setTimeout(() => {
      if (!settled) child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    }, 800);

    const timer = setTimeout(() => done(`no init within ${timeoutMs}ms`), timeoutMs);
  });
}

/**
 * How many of THIS PROBE'S OWN spawned pids are still alive.
 *
 * `ps` is a test -- the Phase 2 review's own lesson, after the adapter suite was found to
 * have leaked 29 detached children over fifteen hours because nothing checked. But the
 * check has to be scoped to our own pids: see the SPAWNED comment above.
 *
 * It also has to wait for the exit to be REAPED rather than asking `kill(pid, 0)`. The
 * first version of this function asked `kill(pid, 0)` and reported 1 survivor on every
 * run: the last child had been SIGKILLed microseconds earlier and was still a zombie, and
 * `kill(pid, 0)` on a zombie SUCCEEDS. Same trap as the Group 6 defect one layer down --
 * "the signal says it is there" and "it is running" are different questions -- so this
 * counts a pid as gone only once Node has told us it exited.
 */
async function survivors({ drainMs = 500 } = {}) {
  await new Promise((r) => setTimeout(r, drainMs));
  const direct = SPAWNED.filter((pid) => !EXITED.has(pid)).map((pid) => `pid ${pid} (direct)`);

  // DESCENDANTS TOO. `child.kill('SIGKILL')` reaches only the CLI itself, and the CLI spawns
  // children of its own (MCP servers, tool subprocesses) — so a check that watched only the
  // direct pids reported 0 survivors while an MCP server outlived its parent. In a probe whose
  // whole subject is which servers a worker loads, that is the leak most likely to happen and
  // the one it was least able to see.
  //
  // Matched by the probe's own scratch cwd, which every child inherits and nothing else on the
  // machine shares. NOT by `--permission-prompt-tool`: an earlier version did that and reported
  // two survivors that were unrelated Claude Code sidecars from the developer's live session.
  if (!process.env.CTD_PROBE_CWD) {
    try {
      const lines = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => l.includes(CWD))
        .map((l) => l.trim());
      for (const l of lines) direct.push(`${l} (descendant or unexited)`);
    } catch { /* ps unavailable; the direct check still applies */ }
  }
  return direct;
}

const only = process.argv[2];
const rows = [];

for (const [name, extra] of CONFIGS) {
  if (only && name !== only) continue;
  process.stderr.write(`measuring ${name} ... `);
  const r = await measure(extra);
  process.stderr.write(r.started ? 'ok\n' : `NO INIT (${r.error})\n`);
  rows.push([name, r]);
  if (only) console.log(JSON.stringify(r.rawInit ?? r, null, 2));
}

if (!only) {
  console.log('');
  console.log(`claude ${execFileSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8' }).trim()}`);
  console.log(process.env.CTD_PROBE_CWD
    ? `cwd ${CWD} (CTD_PROBE_CWD -- whatever project/local config lives here is IN PLAY)`
    : `cwd ${CWD} (fresh empty dir -- anything a row shows came from global config)`);
  console.log('');
  const pad = (s, n) => String(s).padEnd(n);
  console.log([pad('configuration', 22), pad('starts', 7), pad('hooks', 6), pad('mcp', 5), pad('tools', 6), pad('slash', 6), pad('agents', 7)].join(' '));
  console.log('-'.repeat(66));
  for (const [name, r] of rows) {
    console.log([
      pad(name, 22),
      pad(r.started ? 'yes' : 'NO', 7),
      pad(r.hookEvents, 6),
      pad(r.mcpServers ? r.mcpServers.length : '-', 5),
      pad(r.toolCount ?? '-', 6),
      pad(r.slashCount ?? '-', 6),
      pad(r.agentCount ?? '-', 7),
    ].join(' '));
  }
  console.log('');
  for (const [name, r] of rows) {
    console.log(`${name}: argv=[${r.argv}]`);
    if (r.mcpServers) console.log(`  mcp: ${r.mcpServers.join(', ') || '(none)'}`);
    if (r.hookNames.length) console.log(`  hooks: ${r.hookNames.join(', ')}`);
    if (!r.started) console.log(`  DID NOT START: ${r.error}`);
    if (r.stderr.length) console.log(`  stderr: ${r.stderr.slice(0, 2).join(' | ')}`);
    if (r.modelCallBeforeInit) console.log('  WARNING: a model call preceded init -- this probe is no longer free');
  }
  console.log('');
  const left = await survivors();
  console.log(`leftover processes from this probe (self + descendants): ${left.length} (expect 0)`);
  for (const l of left) console.log(`  LEAKED: ${l}`);
  if (process.env.CTD_PROBE_CWD) {
    console.log('  (descendant scan SKIPPED: CTD_PROBE_CWD is a real repo, so matching on it would');
    console.log('   catch unrelated processes working in that directory rather than only ours)');
  }
}
