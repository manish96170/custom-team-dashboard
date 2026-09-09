#!/usr/bin/env node
// _mutate-adoption.mjs — mutation harness for adopting externally-started sessions
// (ROADMAP Phase 3, migration 0007).
//
// Same standing rule: break one mechanism at a time, and the suite must fail BY ASSERTION at the case
// that protects it. A mutation that merely crashes proves nothing.
//
// WHY THIS SET IS DIFFERENT FROM THE OTHERS
//
// Most mutations in this project break a record or a report. Two of these break a REFUSAL to kill,
// and the thing on the other side of that refusal is a live process a person is sitting in front of.
// A1 and A2 are the only mutations in the codebase whose real-world failure mode is "somebody's work
// is terminated mid-sentence" — and neither would fail any test written before this suite existed,
// because an adopted session looks exactly like an orphan from the outside.
//
// A6 is worth reading too: it makes the hook exit non-zero, which is harmless in a test and would
// mean an installed dashboard makes somebody's terminal misbehave.
//
// Usage: node runtime/test/_mutate-adoption.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  reconcile: path.join(SUPERVISOR, 'runtime/reconcile.js'),
  supervisor: path.join(SUPERVISOR, 'runtime/supervisor.js'),
  db: path.join(SUPERVISOR, 'db/index.js'),
  hook: path.join(SUPERVISOR, 'hooks/claude-session-hook.mjs'),
};

// A numbered suite, so the runner's own attribution says WHICH case broke.
const ADOPT = 'runtime/test/adoption.test.js';

const MUTATIONS = [
  {
    name: 'A1-reap-kills-adopted-sessions',
    file: F.reconcile,
    why: "Removing the refusal that stops `reap` killing an adopted session. `reap` GROUP-KILLS, so this terminates a live session a person is working in. Every other refusal in that function is about not killing the WRONG process; this one is about not killing a RIGHT process we were never asked to own — and nothing before this suite would have caught its removal, because an adopted session is indistinguishable from an orphan without the lifecycle column.",
    breaks: 'adoption case 4 (reap refuses an adopted session and leaves the process running)',
    test: ADOPT,
    // Pattern updated when the guard grew its provenance half — an anchor that silently stops matching
    // is a mutation that silently stops testing, which is why the harness errors rather than skipping.
    find: `  if (!force && (row.lifecycle === "adopted" || (row.started_by && row.started_by !== "dashboard" && row.started_by !== "preflight"))) {`,
    replace: `  if (false) { // MUTANT: adopted sessions are killable`,
  },
  {
    name: 'A2-reconciliation-orphans-adopted-sessions',
    file: F.reconcile,
    why: "Letting reconciliation treat an adopted session as an orphan. On every boot it would be relabelled `orphaned-unmanaged`, journalled as a sighting, and listed by `orphans()` — which is the list that invites a reap. So this does not kill anything by itself; it hands somebody's live session to the thing that does.",
    breaks: 'adoption case 3 (reconciliation leaves a live adopted session alone)',
    test: ADOPT,
    find: `    if (row.lifecycle === "adopted") {`,
    replace: `    if (false) { // MUTANT: adopted sessions reconciled as orphans`,
  },
  {
    name: 'A3-adopted-session-never-closed',
    file: F.reconcile,
    why: "Never closing an adopted session whose process is gone. This is the invisible-orphan bug of migration 0003 in reverse: instead of a live process with a closed row, a dead session with an open one — the dashboard would show a finished session as live forever, and the backstop for a hook that never fired (a crashed terminal) would not exist.",
    breaks: 'adoption case 5 (an adopted session whose process died is closed as lost)',
    test: ADOPT,
    find: `      const closed = reconcileRun(db, row.run_id, { exitReason: "lost" });
      if (closed) closeOpenAsksForRun(db, row.run_id, { reason: "lost" });
      summary.lost.push(row.run_id);`,
    replace: `      summary.lost.push(row.run_id); // MUTANT: dead adopted session stays open forever`,
  },
  {
    name: 'A4-adoption-trusts-the-reported-pid',
    file: F.supervisor,
    why: "Trusting the pid the hook reported instead of verifying it against the OS. A pid alone is not an identity — without the pgid and start time, a later `readProcInfo` cannot tell 'still the same process' from 'that pid was reused', which is the check that makes a force-reap safe. It would also happily adopt a session that is already gone.",
    // Observed at case 1, not 2: case 1 asserts `proc_lstart` was recorded, and the mutation nulls it
    // by never reading the OS. The earliest dependent case, not a wrong reason.
    breaks: 'adoption case 1 (the OS-verified identity is recorded) — first; case 2 asserts the dead-pid refusal',
    test: ADOPT,
    find: `    if (Number.isInteger(pid) && pid > 0) {
      const info = await readProcInfo(pid);
      if (!info.alive) {`,
    replace: `    if (Number.isInteger(pid) && pid > 0) {
      const info = { alive: true, pgid: pid, lstart: null }; // MUTANT: pid trusted, never verified
      if (!info.alive) {`,
  },
  {
    name: 'A5-adoption-not-idempotent',
    file: F.supervisor,
    why: "Adopting the same session twice. A `SessionStart` hook fires for more than just `startup` (a resume is another `source`), so a second report is normal. Migration 0007's UNIQUE index catches the duplicate as a backstop — but it surfaces as a SQLite constraint error, and a hook must get a clean answer rather than an exception, so the check in `adoptSession` is the interface and the index is the safety net.",
    breaks: 'adoption case 1 (idempotent on harness + session)',
    test: ADOPT,
    find: `    const existing = findAdoptedRun(database, { harnessId, sessionId });
    if (existing) return { runId: existing.run_id, adopted: false, reason: "already adopted" };`,
    replace: `    // MUTANT: no idempotency check`,
  },
  {
    name: 'A6-hook-exits-nonzero-on-failure',
    file: F.hook,
    why: "Making the hook exit non-zero when it cannot do its job. This runs inside somebody's interactive `claude`, and no supervisor running is the COMMON case rather than an error — most people's sessions have nothing to do with the dashboard. A non-zero exit means installing this dashboard becomes a reason for a terminal to start misbehaving, which is far worse than a session going un-adopted.",
    breaks: 'adoption case 8 (the hook exits 0 on every failure path)',
    test: ADOPT,
    find: `function giveUp(why) {
  if (process.env.CTD_HOOK_DEBUG) process.stderr.write(\`[ctd-hook] \${why}\\n\`);
  process.exit(0);
}`,
    replace: `function giveUp(why) {
  process.stderr.write(\`[ctd-hook] \${why}\\n\`);
  process.exit(1); // MUTANT: a failed hook breaks the user's session
}`,
  },
  {
    name: 'A7-adopted-reported-as-controllable',
    file: F.supervisor,
    why: "Reporting an adopted run as controllable. There is no stdio for it, so `observe`, `sendInput`, `interrupt` and the approval round trip all cannot work — and a UI shown a controllable-looking run will offer buttons that silently do nothing. Same class of overclaim as declaring `approvalProtocol: 'host'` on a harness that cannot answer (conformance/matrix.js).",
    breaks: 'adoption case 7 (an adopted run is reported as NOT controllable)',
    test: ADOPT,
    find: `      controllable: false,`,
    replace: `      controllable: true, // MUTANT: overclaims control the supervisor does not have`,
  },
  {
    name: 'A12-wire-command-unregistered',
    file: F.supervisor,
    why: "Dropping a command from the handler map. This is the defect that has now bitten THREE times (FINDINGS §27.5, §28.4, §30.2): a supervisor function that works when called in-process is invisible to every real client, all of which address it by name over the socket. The in-process suites cannot see it — `adoption.test.js` calls `supervisor.adoptSession()` directly and passes either way — so `wire.test.js` case 1 enumerates the map and proves each name is reachable.",
    // Caught by case 1's REQUIRED-list half, which exists because of this mutation: enumerating the map
    // could not see a handler that was never registered (it vanishes from `Object.keys` too), so the
    // first version of case 1 passed this and only case 5 caught it.
    breaks: 'wire case 1 (a client-required command is registered)',
    test: 'runtime/test/wire.test.js',
    find: `      adoptSession: async (cmd) => ({ id: cmd.id, ok: true, ...(await adoptSession(cmd)) }),`,
    replace: `      // MUTANT: command exists as a function but is not wired`,
  },
  {
    name: 'A9-provenance-defaults-to-unknown',
    file: F.db,
    why: "Recording an unstated origin as something other than 'dashboard'. The invariant is 'only what the dashboard started is reapable', so the DEFAULT is the load-bearing part: if an unstated origin became 'unknown' or empty, every row created by a path that forgot to say so would fall outside the reapable set and silently stop being cleanable — the failure runs the safe direction, which is exactly why nothing would notice.",
    breaks: 'adoption case 9 (provenance is recorded and only dashboard is reapable)',
    test: ADOPT,
    find: `    started_by: r.startedBy ?? (r.isPreflight ? "preflight" : "dashboard"),`,
    replace: `    started_by: r.startedBy ?? "unknown", // MUTANT: unstated origin is not 'dashboard'`,
  },
  {
    name: 'A10-reap-guard-lifecycle-only',
    file: F.reconcile,
    why: "Narrowing the reap refusal back to `lifecycle` alone. The stated invariant is about PROVENANCE ('the supervisor only ever kills a process it started itself'), so a lifecycle-only guard makes the mechanism narrower than the claim — and a review found the gap: a malformed row with started_by='hook' and lifecycle='managed' was reaped, verified to kill the process. Either fix alone leaves the invariant resting on the other.",
    breaks: 'adoption case 10 (a hook-provenance row is refused even when lifecycle says managed)',
    test: ADOPT,
    find: `  if (!force && (row.lifecycle === "adopted" || (row.started_by && row.started_by !== "dashboard" && row.started_by !== "preflight"))) {`,
    replace: `  if (!force && row.lifecycle === "adopted") { // MUTANT: guard narrower than the claim`,
  },
  {
    name: 'A11-adoption-not-atomic',
    file: F.supervisor,
    // EXPECTED TO SURVIVE, declared rather than discovered. The transaction's value is only observable
    // when a process DIES between the two writes, and provoking that needs a separate OS process (the
    // `_crash-victim.js` shape). Both statements still run in-process, so every assertion holds either
    // way — an honest "this mutation cannot be caught here" beats a contrived assertion that appears to
    // catch it.
    //
    // What IS tested is the consequence: case 10 hand-builds the exact malformed row the window used to
    // leave behind, and A10 proves the provenance guard refuses it. So the SECOND layer of the fix is
    // verified even though the first cannot be. That is the honest state of it, and it is why both
    // layers exist — the transaction prevents the window, the guard survives it.
    expectSurvives: true,
    why: "Splitting adoption back into two statements. `createRun` defaults lifecycle to 'managed', so a crash before `markRunAdopted` leaves a row reconciliation reads as an orphan — verified lethal before the fix. Not catchable in-process, because nothing dies mid-adoption; see the note above.",
    breaks: 'nothing in-process — the window needs a real crash (see A10 for the layer that IS tested)',
    test: ADOPT,
    // `((fn) => fn)(...)` returns the function unchanged, so the trailing `()` still calls it — just
    // without a transaction. An earlier mutant used `((f) => f())(...)`, which called it early and then
    // invoked `undefined`: a TypeError rather than the behaviour under test, and the harness correctly
    // refused to credit a crash.
    find: `    database.transaction(() => {`,
    replace: `    ((fn) => fn)(() => { // MUTANT: not a transaction`,
  },
  {
    name: 'A8-adopted-lifecycle-not-recorded',
    file: F.db,
    why: "Recording the identity without the `adopted` lifecycle. The row would then be an ordinary managed run with a pid and no handle — which is precisely the signature reconciliation classifies as `orphaned-unmanaged`. Both guards key on the lifecycle value, so removing it disables them from underneath.",
    breaks: 'adoption case 1 (the row carries lifecycle adopted)',
    test: ADOPT,
    find: `        SET lifecycle = 'adopted', adopted_at = ?, transcript_path = ?,`,
    replace: `        SET adopted_at = ?, transcript_path = ?,`,
  },
];

const exitCode = await runMutations(MUTATIONS, {
  cwd: SUPERVISOR,
  filter: process.argv[2],
});
process.exit(exitCode);
