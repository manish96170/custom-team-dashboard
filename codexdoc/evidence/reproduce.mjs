// ARCHIVED, NON-EXECUTABLE HISTORICAL EVIDENCE — dated 2026-09-11, NOT maintained since. Corrected
// 2026-09-13 (review-sol-2026-09-13.md finding 46): DO NOT RUN THIS as a check of current behavior.
//   * It exits early at a reviewer-identity guard that has since been fixed — every probe after that
//     point never runs.
//   * Several of its own assertions describe behavior that has since been fixed, so a "pass" here would
//     be asserting the WRONG (pre-fix) thing, not proving anything about the current tree.
//   * It calls `runFightLoop()` without `await`, so that probe's real outcome is never actually observed
//     before the script moves on.
//   * It calls `attachPane()` with no fixture-local state/token, so it silently falls back to reading
//     the REAL `owner.token` from whatever state directory happens to be active — a real credential
//     reaching a throwaway fixture server, not an isolated reproduction.
// The individual defects this script originally reproduced are now covered by real, current,
// `npm test`-wired regression cases (see `HANDOFF.md`'s top header and `codexdoc/review-sol-2026-09-13.md`
// for the current list) — read those instead of running this file. Kept only as a dated record of what
// was reproduced and how, at the time.
//
// Original header, describing what this script was for BEFORE the above correction:
// Review probes: assert the observed defects, not the desired future behavior.
// Run from anywhere: node codexdoc/evidence/reproduce.mjs
// Uses temporary databases and local-only git remotes. No model/network calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as dbm from '../../supervisor/db/index.js';
import { createSupervisor } from '../../supervisor/runtime/supervisor.js';
import { PRESETS } from '../../supervisor/domain/capabilities.js';
import { runFightLoop } from '../../supervisor/agents/git-create-push.js';
import { createIpcServer } from '../../supervisor/ipc/server.js';
import { attachPane } from '../../supervisor/pane/pane.js';
import { createTuiApp } from '../../supervisor/tui/app.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-review-probes-'));
const db = dbm.openDb({ stateDir: path.join(root, 'state') });
const quiet = { log() {}, warn() {}, error() {} };
const sup = createSupervisor({ db, adapters: { fake: {} }, logger: quiet, askSweepIntervalMs: 0 });
let ipc;
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
}).trim();
function repo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Review Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'initial');
  return dir;
}
function task(id, type = 'feature', state = 'created') {
  dbm.createTask(db, { id, title: id, type, state });
}
function worker(id, taskId, role = 'reviewer') {
  dbm.createWorker(db, { workerId: id, nickname: id, taskId, role });
}
function principal(id, workerId, preset) {
  const token = `fixture-token-${id}`;
  dbm.mintPrincipal(db, { id, kind: 'worker', workerId,
    capabilities: [...PRESETS[preset]], tokenSha256: createHash('sha256').update(token).digest('hex') });
  return token;
}
const report = (name, facts) => console.log(JSON.stringify({ observed: name, ...facts }));
try {
  dbm.upsertHarness(db, { id: 'fake', displayName: 'Fixture' });
  await sup.boot();
  const handlers = sup.authorizedCommandHandlers();

  for (const [type, role] of [['git-push-task','git-push-runner'], ['jira-task','jira-runner'],
    ['awsquery-task','awsquery-runner'], ['slack-task','slack-runner']]) {
    task(type, type); worker(role, type, role);
    const result = await sup.assignTask(type);
    assert.equal(result.assigned, false);
    report('utility assignment refused', { type, reason: result.refused });
  }

  task('review', 'feature', 'awaiting-review');
  worker('reviewer-a', 'review'); worker('reviewer-b', 'review');
  const reviewerToken = principal('pa', 'reviewer-a', 'reviewer');
  for (const workerId of ['reviewer-a', 'reviewer-b']) {
    for (const dimension of ['correctness', 'security', 'tests']) {
      const r = await handlers.recordVerdict({ id: `${workerId}-${dimension}`, token: reviewerToken,
        taskId: 'review', workerId, round: 1, commitSha: 'fixture-sha', dimension, verdict: 'approved' });
      assert.equal(r.recorded, true);
    }
  }
  const review = await sup.approveTask('review');
  assert.equal(review.approved, true);
  report('one authenticated reviewer supplied both quorum identities', { approved: review.approved,
    distinctReviewers: review.status.quorum.distinctReviewers });

  dbm.createRun(db, { runId: 'raw-run', workerId: 'reviewer-a', harnessId: 'fake' });
  dbm.recordEvent(db, { runId: 'raw-run', tier: 1, type: 'assistant.delta', payload: { text: 'RAW_FIXTURE_MARKER\n' } });
  const reader = sup.mintNamedPrincipal({ preset: 'utility:awsquery' });
  const snapshot = await handlers.tuiSnapshot({ id: 'raw', token: reader.token });
  assert.match(JSON.stringify({ transcripts: snapshot.transcripts, provisional: snapshot.provisional }), /RAW_FIXTURE_MARKER/);
  report('read-only utility principal receives raw transcript through tuiSnapshot', { rawVisible: true });

  const now = '2026-01-01T00:00:00.000Z';
  const later = '2026-01-01T00:00:02.000Z';
  const leaseArgs = { resourceName: 'git:identity', kind: 'exclusive', holderPrincipalId: reader.id };
  const a = dbm.tryAcquireLease(db, { ...leaseArgs, ttlMs: 1000, now });
  const b = dbm.tryAcquireLease(db, { ...leaseArgs, now: later });
  assert.equal(a.granted && b.granted, true);
  assert.equal(dbm.renewLeaseRow(db, a.lease.id, { now: later }).renewed, true);
  assert.equal(dbm.listActiveLeases(db, 'git:identity', { now: later }).length, 2);
  report('expired lease renewal resurrects overlapping exclusive claim', { active: 2 });
  for (const l of [a,b]) dbm.releaseLeaseRow(db, l.lease.id);

  const source = repo('repo'); const remote = path.join(root, 'remote.git');
  fs.mkdirSync(remote); git(remote, 'init', '--bare', '-q');
  git(source, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(source, 'uncommitted.txt'), 'not copied\n');
  task('push');
  const wt = sup.createTaskWorktree('push', { repoPath: source });
  assert.equal(fs.existsSync(path.join(wt.worktreeId, 'uncommitted.txt')), false);
  report('worktree create omits uncommitted source files', { originalPreserved: true, copyPresent: false });
  fs.writeFileSync(path.join(wt.worktreeId, 'intended.txt'), 'intended\n');
  fs.writeFileSync(path.join(wt.worktreeId, 'unrelated.txt'), 'unrelated\n');
  const pusher = sup.mintNamedPrincipal({ preset: 'utility:git' });
  const command = { token: pusher.token, taskId: 'push', message: 'fixture push', targetBranch: 'main' };
  const denied = await handlers.gitPushProtected({ id: 'protected', ...command });
  assert.equal(denied.needsApproval, true);
  const pushed = await handlers.gitPush({ id: 'ordinary', ...command });
  assert.equal(pushed.status, 'pushed');
  assert.equal(git(remote, 'show', 'main:unrelated.txt'), 'unrelated');
  report('ordinary command pushes exact destination refused by sensitive command', {
    target: 'main', status: pushed.status, unrelatedFileCommitted: true });

  fs.writeFileSync(path.join(wt.worktreeId, 'retry.txt'), 'retry\n');
  const failed = runFightLoop({ cwd: wt.worktreeId, message: 'retry fixture', remote: 'missing-remote' });
  assert.equal(failed.status, 'failed');
  const retry = runFightLoop({ cwd: wt.worktreeId, message: 'retry fixture', remote: 'origin' });
  assert.equal(retry.status, 'failed');
  assert.match(retry.unresolved.oneParagraphDiagnosis, /nothing was staged/);
  report('push retry stops before retrying committed change', { retryDiagnosis: retry.unresolved.oneParagraphDiagnosis });

  worker('live-worker', 'push', 'coder');
  dbm.createRun(db, { runId: 'still-open', workerId: 'live-worker', harnessId: 'fake' });
  dbm.recordRunProcess(db, 'still-open', { cwd: wt.worktreeId });
  // A legal terminal transition does not close runs. No OS process needed to show the missing guard.
  dbm.recordTransition(db, { id: 'p1', taskId: 'push', toState: 'starting', actor: 'fixture' });
  dbm.recordTransition(db, { id: 'p2', taskId: 'push', toState: 'planning', actor: 'fixture' });
  dbm.recordTransition(db, { id: 'p3', taskId: 'push', toState: 'cancelled', actor: 'fixture' });
  fs.writeFileSync(path.join(wt.worktreeId, 'only-copy.txt'), 'unsaved\n');
  const discarded = sup.discardTaskWorktree('push');
  assert.equal(discarded.discarded, true);
  assert.equal(dbm.getRun(db, 'still-open').ended_at, null);
  assert.equal(fs.existsSync(path.join(wt.worktreeId, 'only-copy.txt')), false);
  report('terminal task discard removes dirty tree while run row remains open', { discarded: true, runOpen: true });

  task('ask-task', 'adhoc', 'implementing'); worker('ask-worker', 'ask-task', 'coder');
  dbm.createRun(db, { runId: 'ask-run', workerId: 'ask-worker', harnessId: 'fake' });
  dbm.createAsk(db, { id: 'fixture-ask', runId: 'ask-run', taskId: 'ask-task', question: 'approve?', kind: 'tool-approval' });
  assert.equal(db.prepare("SELECT state FROM tasks WHERE id='ask-task'").get().state, 'implementing');
  const workerToken = principal('ask-principal', 'ask-worker', 'worker');
  const answered = await handlers.answerAsk({ id: 'self-answer', token: workerToken, askId: 'fixture-ask', allow: true, answeredBy: 'human' });
  assert.equal(answered.answered, true);
  assert.equal(dbm.getAsk(db, 'fixture-ask').answered_by, 'human');
  report('ask does not block task; worker self-answers with human attribution', { taskState: 'implementing', answeredBy: 'human' });

  const l = sup.acquireLease({ resourceName: 'git:identity', principal: { id: reader.id }, runId: 'ask-run' });
  dbm.reconcileRun(db, 'ask-run', { exitReason: 'lost' });
  assert.equal(dbm.getLease(db, l.lease.id).releasedAt, null);
  report('reconciliation closes run without releasing lease', { leaseStillHeld: true });

  task('zero-review', 'adhoc', 'awaiting-review');
  const zero = await sup.approveTask('zero-review');
  assert.equal(zero.approved, false);
  assert.equal(zero.status.quorum.required, 2);
  report('adhoc zero-review profile still evaluated under default review quorum', { required: 2 });

  const app = createTuiApp({ out: { columns: 100, rows: 30, write() {} }, input: {}, client: { request: async () => ({
    ok: true, teams: [], tasks: [{ id: 't', type: 'adhoc' }], workers: [{ workerId: 'w', nickname: 'w', role: 'coder', taskId: 't' }],
    runs: [{ runId: 'old', workerId: 'w', endedAt: 'yesterday', exitReason: 'finished' }, { runId: 'new', workerId: 'w', endedAt: null }],
    transcripts: { old: ['OLD'], new: ['NEW'] }, cursors: { old: 1, new: 2 },
  }) } });
  await app.refresh();
  assert.match(app.state.panes[0].title, /old/);
  report('TUI chooses first historical run over replacement', { pane: app.state.panes[0].title });

  ipc = createIpcServer({ commands: handlers, logger: quiet });
  const socket = path.join(root, 'control.sock');
  await ipc.listen(socket);
  await assert.rejects(attachPane({ runId: 'raw-run', sockPath: socket, out() {} }), /requires capability/);
  report('standalone pane rejected by authorized socket', { reason: 'no token sent' });
} finally {
  if (ipc) await ipc.shutdown({ timeoutMs: 1000 });
  await sup.shutdown({ timeoutMs: 1000 });
  dbm.closeDb(db);
  fs.rmSync(root, { recursive: true, force: true });
}
