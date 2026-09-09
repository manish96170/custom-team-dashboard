#!/usr/bin/env node
// _mutate-approval.mjs — mutation harness for the Phase 2 approval round trip.
//
// New code has no "pre-fix" version, so the standing rule (every regression test must be
// observed FAILING against the code it protects) is satisfied the way Group 5 and 0003 did
// it: break one mechanism at a time and confirm the test fails AT THE CASE that claims to
// protect it. A mutation that passes means either the mechanism is not load-bearing or the
// assertion is not actually testing it — both are findings.
//
// THE HARNESS ITSELF LIED ONCE BEFORE, and that is why the checks below are what they are.
// From runtime/FINDINGS.md (the 0003 review): a shell helper verified "did the mutation
// apply?" with `grep -F "$replacement"`, which for a MULTI-LINE replacement matches when any
// single line matches — so an unapplied mutation looked applied, its test passed, and the
// result read as "this fix is not load-bearing". So here: the pattern must occur EXACTLY
// ONCE, the file contents must actually differ afterwards, and the file is restored from the
// original bytes rather than by a reverse substitution.
//
// Usage: node runtime/test/_mutate-approval.mjs [substring-of-mutation-name]
//
// ONE OPERATIONAL NOTE: this harness kills a test that exceeds its timeout, and a killed test's
// `finally` never runs — so an aborted mutation can leave detached harness children alive. The
// suites themselves do not leak when they complete (measured, one suite at a time), and this is not
// a reason to make the timeout generous; it is a reason to check `ps` after a run you interrupted.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  supervisor: path.join(SUPERVISOR, 'runtime/supervisor.js'),
  db: path.join(SUPERVISOR, 'db/index.js'),
  adapter: path.join(SUPERVISOR, 'adapters/claude-code/adapter.js'),
  migration: path.join(SUPERVISOR, 'db/migrations/0004_asks_round_trip.sql'),
};

const APPROVAL = 'runtime/test/approval.test.js';

/** Each mutation names the case it must break, so a wrong-reason failure is visible. */
const MUTATIONS = [
  {
    name: 'M1-deliver-before-persist',
    file: F.supervisor,
    why: 'Delivering the answer before writing it down. The ordering PLAN.md section 7 requires: a crash between the two steps must not lose a human decision.',
    breaks: 'case 2 (the answer is durable: answered_at is set)',
    test: APPROVAL,
    find: `    const changed = answerAskRow(database, askId, { answer: answerText, answeredBy, decision, answerJson });`,
    replace: `    const changed = 1; // MUTANT: deliver first, persist never`,
  },
  {
    name: 'M2-delivery-failure-marks-delivered',
    file: F.db,
    why: 'A failed delivery attempt stamping delivered_at anyway — the row leaves the redelivery queue and a parked worker is never told.',
    breaks: 'case 5 (delivered_at stays NULL on failure)',
    test: APPROVAL,
    find: `      .run(String(error), abandon ? 1 : 0, at ?? nowIso(), id).changes;`,
    replace: `      .run(String(error), abandon ? 1 : 0, at ?? nowIso(), id).changes && db.prepare(\`UPDATE asks SET delivered_at = ? WHERE id = ?\`).run(at ?? nowIso(), id).changes; // MUTANT: a failed attempt also stamps delivered_at`,
  },
  {
    name: 'M3-question-answered-with-bare-allow',
    file: F.supervisor,
    why: 'Answering a question by allowing the tool call without folding the answers into its input. Measured on the real harness: the model is then told "The user did not answer the questions."',
    breaks: 'case 4 (answers ride back in updatedInput)',
    test: APPROVAL,
    find: `          ...(ask.kind === "question" ? { updatedInput: buildAnsweredInput(ask) } : {}),`,
    replace: `          // MUTANT: no updatedInput`,
  },
  {
    name: 'M4-no-withdraw-handling',
    file: F.supervisor,
    why: 'Ignoring the harness withdrawing its own request, so the ask outlives the request it points at and a human can answer into a void.',
    breaks: 'case 6 (withdrawn ask closes)',
    test: APPROVAL,
    find: `      else if (event?.type === "approval.withdrawn") withdrawApprovalAsk(runId, event);`,
    replace: `      // MUTANT: withdrawals ignored`,
  },
  {
    name: 'M5-no-deny-fallback-on-unrecordable-ask',
    file: F.supervisor,
    why: 'Logging an unrecordable ask and moving on. A parked request has no deadline of its own, so the worker would stay stopped forever with nothing in the database to say why.',
    breaks: 'case 8 (unrecordable request is denied)',
    test: APPROVAL,
    find: `        Promise.resolve(
          adapter.answerApproval?.(runId, event.requestId, {`,
    replace: `        if (globalThis.__MUTANT__) return null;
        Promise.resolve(
          adapter.answerApproval?.(runId, event.requestId, {`,
    // The early return has to be reachable, so the mutant also turns the flag on.
    extra: {
      file: F.supervisor,
      find: `  // ── the approval / question round trip (Phase 2, PLAN.md section 7) ─────────────────`,
      replace: `  globalThis.__MUTANT__ = true;
  // ── the approval / question round trip (Phase 2, PLAN.md section 7) ─────────────────`,
    },
  },
  {
    name: 'M6-approval-closes-the-run',
    file: F.supervisor,
    why: 'Treating a parked approval as a terminal state. This is the pre-0003 invisible-orphan mistake wearing a new hat: a run that is merely WAITING would be closed, dropping out of listOpenRuns and out of reconciliation.',
    breaks: 'case 1 (a blocked run has not ended)',
    test: APPROVAL,
    find: `      if (event?.type === "approval.request") recordApprovalAsk(runId, event);`,
    replace: `      if (event?.type === "approval.request") { recordApprovalAsk(runId, event); endRun(database, runId, { exitReason: "errored" }); } // MUTANT`,
  },
  {
    name: 'M7-tool-approval-defaults-to-allow',
    file: F.supervisor,
    why: 'Letting a tool approval be answered without an explicit boolean, defaulting to allow. The exact failure mode an approval control plane exists to prevent.',
    breaks: 'case 7 (a tool approval refuses to be answered by guessing)',
    test: APPROVAL,
    find: `      if (typeof allow !== "boolean") {
        throw new Error(\`answerAsk: ask \${askId} is a tool approval and needs an explicit boolean \\\`allow\\\`\`);
      }
      decision = allow ? "allow" : "deny";`,
    replace: `      decision = allow === false ? "deny" : "allow"; // MUTANT: missing means allow`,
  },
  {
    name: 'M8-answer-not-generation-pinned',
    file: F.adapter,
    why: 'Answering a parked request without checking it belongs to the CURRENT process. resume() rebinds to a new OS process; the old request id means nothing there, so the write is a silent no-op.',
    breaks: 'the adapter suite\'s generation-pinning case (the fake harness has its own copy of this guard, so approval.test.js cannot see it)',
    test: 'adapters/claude-code/test/test-claude-code-adapter.mjs',
    find: `  if (parked.generation !== run._generation) {`,
    replace: `  if (false) { // MUTANT: generation unchecked`,
  },
  // ── the six mutations below cover the fixes that came out of the three-model review
  // (review-phase2/verdicts.md). Each one restores the defect a reviewer found.
  {
    name: 'M9-closed-asks-deliverable-again',
    file: F.db,
    why: 'Restores "anything that is not deny is an allow" in the redelivery queue, so a reconciliation-closed ask becomes deliverable — the worst defect the review found: a parked worker could be handed an approval no human gave.',
    breaks: 'case 11 (a closed ask stays out of the queue)',
    test: APPROVAL,
    find: `                 AND a.decision IN ('allow', 'deny', 'answered') AND r.ended_at IS NULL\`;`,
    replace: `                 AND COALESCE(a.decision, '') <> 'withdrawn' AND r.ended_at IS NULL\`; // MUTANT`,
  },
  {
    name: 'M10-withdraw-only-looks-at-unresolved',
    file: F.supervisor,
    why: 'Restores the `resolved = 0` filter before withdrawAsk, so an answer that raced a withdrawal is never settled and is retried on every boot forever.',
    breaks: 'case 12 (a raced answer is abandoned)',
    test: APPROVAL,
    find: `        \`SELECT id FROM asks WHERE run_id = ? AND harness_request_id = ?
          ORDER BY resolved ASC, created_at DESC LIMIT 1\`,`,
    replace: `        \`SELECT id FROM asks WHERE run_id = ? AND harness_request_id = ? AND resolved = 0\`, // MUTANT`,
  },
  {
    name: 'M11-unique-index-spans-generations',
    file: F.migration,
    why: 'Restores the unique index without generation, so a request id reused by a resumed process collides with the old row, the UNIQUE is swallowed, and the new worker is parked with no ask.',
    breaks: 'case 10 (both generations get their own ask)',
    test: APPROVAL,
    find: `  ON asks(run_id, COALESCE(generation, -1), harness_request_id)`,
    replace: `  ON asks(run_id, harness_request_id) -- MUTANT`,
  },
  {
    name: 'M12-no-event-shape-validation',
    file: F.supervisor,
    why: 'Removes the approval.request shape check, so the OpenCode adapter\'s differently-shaped event writes unanswerable rows with a NULL request id — and the partial unique index lets every repeat add another.',
    breaks: 'case 13 (a malformed event writes no rows)',
    test: APPROVAL,
    find: `    const problem = approvalRequestProblem(event);`,
    replace: `    const problem = null; // MUTANT: shape unchecked`,
  },
  {
    name: 'M13-no-payload-redaction-on-resolve',
    file: F.supervisor,
    why: 'Leaves the full tool input in the row after the decision, so a bearer token pasted into a Bash command stays in the database indefinitely.',
    breaks: 'case 14 (a resolved payload holds no secret)',
    test: APPROVAL,
    find: `    redactResolvedAskPayload(database, askId);`,
    replace: `    // MUTANT: payload kept in full forever`,
  },
  {
    name: 'M14-no-replay-guard',
    file: F.supervisor,
    why: 'Removes the "is anything actually parked" guard, so the event replay that follows resume() re-records historical approval requests as phantom asks — found while writing case 10, by neither reviewer.',
    breaks: 'case 15 (a replayed request creates no phantom ask)',
    test: APPROVAL,
    find: `    if (!stillParked(runId, event)) {`,
    replace: `    if (false) { // MUTANT: replayed events recorded again`,
  },
];

const exitCode = await runMutations(MUTATIONS, {
  cwd: SUPERVISOR,
  filter: process.argv[2],
});
process.exit(exitCode);
