#!/usr/bin/env node
// real-pane.slice.mjs — the Phase 2 slice as a person would actually use it: the REAL daemon on a
// real socket, a REAL `claude` run, and the pane attached to it.
//
// DELIBERATELY NOT IN `npm test`. Real tokens, real network, needs a logged-in `claude`. What it adds
// over `pane-e2e.test.js` (which is deterministic and does belong in the suite) is the last mile:
// that the daemon this project ships, driven only over its socket, produces a transcript a human can
// read and an approval a human can answer — on the harness, not on a fake.
//
// It drives the pane's own API rather than the CLI's readline loop, for one reason: a test that
// pipes text into an interactive prompt asserts on prompt formatting and timing, which is not the
// contract. The CLI is a thin shell over exactly these calls.
//
// Run: node pane/test/real-pane.slice.mjs     (~$0.30, about a minute)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from '../../ipc/client.js';
import { attachPane, parsePaneCommand } from '../pane.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(__dirname, '../../ipc/daemon.js');

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

// Not under /tmp: on macOS /tmp symlinks to /private/tmp and the tool sandbox compares resolved
// paths, so a cwd there produces working-directory refusals that never reach the host at all
// (adapters/FINDINGS.md).
const stateDir = fs.mkdtempSync(path.join(process.env.HOME || os.tmpdir(), 'ctd-real-pane-'));
const workDir = fs.mkdtempSync(path.join(process.env.HOME || os.tmpdir(), 'ctd-real-pane-work-'));
const sockPath = path.join(stateDir, 'supervisor.sock');

let daemon;
let pane;
let client;
let runId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 120_000, pollMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(pollMs);
  }
}

try {
  // ── the real daemon, in its own OS process ────────────────────────────────────────
  // Its own state dir and its own lock path, so this never touches the developer's real one.
  daemon = spawn(process.execPath, [DAEMON], {
    // ONE env var, which is the point of `supervisor/paths.js`: database, socket and lock all
    // resolve from this root, so a test cannot accidentally reach into the developer's real state
    // dir by remembering one variable and forgetting another.
    env: { ...process.env, SUPERVISOR_STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.on('data', (d) => process.stdout.write(`  [daemon] ${d}`));
  daemon.stderr.on('data', (d) => process.stdout.write(`  [daemon!] ${d}`));

  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 20_000, what: 'the daemon to bind its socket' });
  log('daemon is serving on', sockPath);

  // ── a real worker, started over the socket ────────────────────────────────────────
  client = await connect(sockPath);
  const ping = await client.send('ping', {});
  assert.ok(ping.ok !== false, `the daemon should answer ping: ${JSON.stringify(ping)}`);

  // The identity rows a run needs. Done over the socket where possible; the roster commands are
  // Phase 5, so these two go straight into the daemon's database — which is why the slice opens it
  // read-write here and nowhere else.
  const { openDb, closeDb, upsertHarness, createTask, createWorker } = await import('../../db/index.js');
  const seed = openDb({ stateDir });
  upsertHarness(seed, { id: 'claude-code', displayName: 'Claude Code' });
  createTask(seed, { id: 't-pane', title: 'real pane slice', type: 'feature' });
  createWorker(seed, { workerId: 'w-pane', nickname: 'Purus', role: 'coder', taskId: 't-pane', cwd: workDir });
  closeDb(seed);

  const started = await client.send('start', {
    harnessId: 'claude-code',
    workerId: 'w-pane',
    spec: {
      cwd: workDir,
      // WebFetch on a fresh domain is the cleanest genuine "ask": no sandbox, no working-directory
      // rule, refused by default so it MUST ask.
      prompt: 'Use the WebFetch tool on https://example.com and tell me the page title.',
      permissionMode: 'default',
    },
  });
  assert.equal(started.ok, true, `start should succeed: ${JSON.stringify(started)}`);
  runId = started.runId;
  log('started run', runId, 'identityVerified =', started.identityVerified);
  assert.equal(started.identityVerified, true, 'the run must own a verified process group');

  // ── the pane ──────────────────────────────────────────────────────────────────────
  const paneLines = [];
  pane = await attachPane({
    runId,
    sockPath,
    color: false,
    askPollMs: 400,
    out: (line) => {
      paneLines.push(line);
      process.stdout.write(`  | ${line}\n`);
    },
  });
  log('pane attached');

  // ── it must show the approval, with the exact call ────────────────────────────────
  await waitFor(() => pane.transcript().includes('APPROVAL NEEDED'), { what: 'the approval to appear in the pane' });
  const atApproval = pane.transcript();
  assert.match(atApproval, /WebFetch/, 'the pane names the tool');
  assert.match(atApproval, /example\.com/, 'and shows what it wants to do');
  assert.match(atApproval, /the worker is waiting/, 'and says the worker is stopped');
  await waitFor(() => pane.pending.length === 1, { timeoutMs: 10_000, what: 'the pane to see the pending ask' });
  assert.equal(pane.pending[0].answerable, true, 'the real CLI is parked on it right now');
  log('1/3 the pane showed the approval and the run is genuinely blocked on it');

  // ── answered through the pane's own command grammar ───────────────────────────────
  const allow = await pane.answer(parsePaneCommand('/allow'));
  assert.equal(allow.ok, true, `/allow should have gone through: ${allow.error ?? ''}`);
  assert.equal(allow.delivered, true, 'and reached the parked CLI');
  await waitFor(() => pane.transcript().includes('tool ok'), { what: 'the approved tool call to return a result' });
  await waitFor(() => pane.transcript().includes('turn completed'), { what: 'the turn to finish' });
  assert.match(pane.transcript(), /Example Domain/i, 'the fetched page title reached the transcript');
  log('2/3 /allow through the pane let the real tool run, and its result is in the transcript');

  // ── a second turn, denied, and the reason must reach the model ────────────────────
  const before = pane.transcript().length;
  await pane.sendInput('Now use the WebFetch tool on https://example.org and tell me its title.');
  await waitFor(() => pane.pending.length === 1, { what: 'a second approval' });
  const deny = await pane.answer(parsePaneCommand('/deny not from this worker; report that it was refused'));
  assert.equal(deny.ok, true, `/deny should have gone through: ${deny.error ?? ''}`);
  await waitFor(() => pane.transcript().slice(before).includes('tool failed'), { what: 'the denied call to come back as an error' });
  assert.match(pane.transcript().slice(before), /not from this worker/, "the operator's reason is visible in the pane");
  log('3/3 /deny carried the reason through the pane to the model');

  // ── detach, and the run must survive it ──────────────────────────────────────────
  const cursor = pane.cursor;
  pane.detach();
  pane = null;
  const list = await client.send('list', {});
  const row = (list.runs ?? []).find((r) => r.runId === runId);
  assert.ok(row, 'the run is still listed after the pane detached');
  log(`detached at seq ${cursor}; the run is still live`);

  // Re-attach from the cursor: the pane is switchable, which is the whole point of section 5.
  const second = await attachPane({ runId, sockPath, color: false, fromSeq: cursor, out: () => {} });
  await second.refreshAsks();
  assert.ok(!second.transcript().includes('Example Domain'), 're-attaching from the cursor did not replay the whole session');
  second.detach();
  log('re-attached from the cursor without replaying the whole session');

  console.log('\nPASS: real pane slice — the real daemon, a real claude run, an approval answered from the pane, detach and re-attach');
  process.exitCode = 0;
} catch (err) {
  console.error('\nFAIL: real pane slice');
  console.error(err?.stack ?? err);
  process.exitCode = 1;
} finally {
  try {
    if (pane) pane.detach();
  } catch { /* already gone */ }
  try {
    if (client) client.close();
  } catch { /* already gone */ }
  if (daemon && daemon.exitCode === null) {
    // SIGTERM, not SIGKILL: the daemon's bounded teardown is what disposes the adapters and takes
    // the harness process group with it. SIGKILLing here would leak a real `claude`.
    daemon.kill('SIGTERM');
    await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(8000)]);
    if (daemon.exitCode === null) daemon.kill('SIGKILL');
  }
  await sleep(500);
  console.error(`state dir: ${stateDir}\nwork dir: ${workDir}`);
}
