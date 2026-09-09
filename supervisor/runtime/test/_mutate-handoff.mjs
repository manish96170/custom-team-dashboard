#!/usr/bin/env node
// _mutate-handoff.mjs — mutation harness for the tier-3 task handoff (PLAN.md section 8, Rule 4).
//
// Same standing rule as the other harnesses: each mechanism is broken one at a time and the suite
// must fail BY ASSERTION at the case that protects it. A mutation that merely crashes proves nothing.
//
// What makes a SUMMARY unusually worth mutating: its readers are agents that will act on it, so the
// two ways it can be wrong are both silent and both worse than having no summary at all —
//
//   * it invents content it has no source for   (the `Assumptions` seam)
//   * it looks complete while being truncated   (the one-page budget)
//
// Neither produces an error. Both produce a confident, wrong document.
//
// Usage: node runtime/test/_mutate-handoff.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  gen: path.join(SUPERVISOR, 'handoff/generate.js'),
  db: path.join(SUPERVISOR, 'db/index.js'),
  supervisor: path.join(SUPERVISOR, 'runtime/supervisor.js'),
};

// A numbered suite, so the runner's own lastCase attribution says WHICH case broke.
const HANDOFF = 'runtime/test/handoff.test.js';

const MUTATIONS = [
  {
    name: 'H1-assumptions-inferred-not-empty',
    file: F.gen,
    why: "Filling the Assumptions section with an inference instead of quoting tier 2. The worst possible failure for a document whose readers are agents that will act on it: every line in that section is supposed to be something a worker actually said, so anything tier 3 writes there itself is invented. Case 4 is the negative that protects this and it asserts the absence of inferred language, not just the presence of a heading.",
    breaks: 'handoff case 4 (Assumptions is empty and explains itself)',
    test: HANDOFF,
    find: `  if (assumptions.length) {`,
    replace: `  L.push("_The task is probably close to done and the approach is likely sound._"); if (assumptions.length) {`,
  },
  {
    name: 'H2-truncation-is-silent',
    file: F.gen,
    why: 'Cutting the document to the budget without saying so. A truncated handoff that looks complete makes its reader treat a MISSING blocker as an absent one — it silently converts "there is more you cannot see" into "there is nothing more".',
    breaks: 'handoff case 5 (truncation is stated in the document)',
    test: HANDOFF,
    find: `    doc = \`\${keep.slice(0, keep.lastIndexOf("\\n"))}\\n\\n_[handoff truncated at \${budgetChars} characters to stay within Rule 4's one-page budget — sections after this point were dropped]_\\n\`;`,
    replace: `    doc = keep.slice(0, keep.lastIndexOf("\\n")); // MUTANT: silent truncation`,
  },
  {
    name: 'H3-budget-not-enforced',
    file: F.gen,
    why: "Not enforcing Rule 4's one-page budget at all. Tier 3 exists so that a summary rather than a transcript crosses a worker boundary; an unbounded 'summary' is a transcript with extra steps, and it reintroduces the context explosion the whole tier was designed to prevent.",
    breaks: 'handoff case 5 (the budget is enforced)',
    test: HANDOFF,
    find: `  if (doc.length > budgetChars) {`,
    replace: `  if (false) { // MUTANT: budget ignored`,
  },
  {
    name: 'H4-blockers-dropped',
    file: F.gen,
    why: 'Omitting open asks from the Blockers section. The most actionable content in the document: an unresolved ask means a worker is stopped RIGHT NOW, and a handoff that omits it reads as "everything is fine" to the next reader — who is the person or agent that would have unblocked it.',
    breaks: 'handoff case 3 (asks appear as blockers)',
    test: HANDOFF,
    find: `  for (const a of asks) {`,
    replace: `  for (const a of []) { // MUTANT: blockers dropped`,
  },
  {
    name: 'H5-orphans-not-blockers',
    file: F.gen,
    why: 'Not treating an orphaned process as a blocker. An orphan is burning tokens and CPU unmanaged; it is the one blocker with an ongoing cost, and it is invisible unless something says so.',
    breaks: 'handoff case 3 (orphans appear as blockers)',
    test: HANDOFF,
    find: `  for (const r of orphans) {`,
    replace: `  for (const r of []) { // MUTANT: orphans hidden`,
  },
  {
    name: 'H6-preflights-included',
    file: F.gen,
    why: "Counting preflight runs in the handoff. A handoff is the most human-facing document in the system, so migration 0005's rule applies with full force: 'who did what' must not become twenty sessions saying 'ok'.",
    breaks: 'handoff case 8 (preflight runs are excluded)',
    test: HANDOFF,
    find: `        WHERE w.task_id = ? AND r.is_preflight = 0`,
    replace: `        WHERE w.task_id = ?`,
  },
  {
    name: 'H7-diff-failure-propagates',
    file: F.gen,
    why: 'Letting a git failure throw instead of degrading to a note. A task with no worktree, a stale base_rev, or no git at all would then produce NO handoff — losing the blockers, which matter more than the diff, to a failure in the least important section.',
    breaks: 'handoff case 9 (a failing git call degrades to a note)',
    test: HANDOFF,
    find: `  } catch (err) {
    // A wrong \`base_rev\`, a missing worktree, git not installed -- all the same shape to a reader:
    // the diff could not be read, and here is why.
    return { text: \`no diff information: \${String(err?.shortMessage ?? err?.message ?? err).split("\\n")[0]}\`, ok: false };
  }`,
    replace: `  } catch (err) {
    throw err; // MUTANT: a git failure loses the whole handoff
  }`,
  },
  {
    name: 'H8-sources-not-recorded',
    file: F.gen,
    why: "Returning the document without recording what it was built from. 'Which transitions and which asks did this see' is the first question anyone asks of a summary they do not trust, and a summary nobody can audit is one nobody should act on.",
    breaks: 'handoff case 6 (sources are recorded)',
    test: HANDOFF,
    find: `      askIds: facts.asks.map((a) => a.id),`,
    replace: `      askIds: [], // MUTANT: sources unauditable`,
  },
  {
    name: 'H9-handoff-replaces-instead-of-appending',
    file: F.supervisor,
    why: "Replacing the previous handoff rather than appending. Rule 4 regenerates on transition, and the previous document is what makes a regeneration reviewable -- 'the goal changed between these two' becomes unanswerable. This is the opposite call from model_health, which correctly replaces because 'is this usable right now' has no historical value.",
    breaks: 'handoff case 7 (regeneration appends and keeps history)',
    test: HANDOFF,
    // Anchored in the supervisor rather than on db/index.js's SQL, which is a template literal --
    // nesting backticks inside this harness's own template literals is not worth the escaping.
    find: `    const id = recordTaskHandoff(database, { taskId, reason, ...generated });
    return { id, ...generated };`,
    replace: `    database.prepare('DELETE FROM task_handoffs WHERE task_id = ?').run(taskId); // MUTANT: replaces instead of appending
    const id = recordTaskHandoff(database, { taskId, reason, ...generated });
    return { id, ...generated };`,
  },
  {
    name: 'H11-transition-journals-without-moving-the-state',
    file: F.db,
    why: "Journalling a transition without updating tasks.state -- the ORIGINAL behaviour, and the defect the Phase 2 gate run exposed. The journal and the column then disagree indefinitely: the gate produced a handoff whose Goal said `created` while its own Decisions list showed the task had reached `in-review`. Two sources of truth for one fact. Note the assertion that used to guard this searched the whole document and passed anyway, which is why case 10 checks the Goal SECTION.",
    // Observed to fail at case 2, not 10, and that is the tightened assertion doing its job: case
    // 2 now checks the GOAL SECTION for the current state, so it catches the divergence at the
    // first handoff rather than waiting for case 10's explicit transition. Before that assertion
    // was narrowed, neither case caught this at all.
    // Now caught in the SETUP walk (reported as case 1): each step passes the state the previous one
    // should have produced, so a transition that does not move `tasks.state` fails the second step. The
    // setup asserts rather than crashing, which is what makes this a real catch. Cases 2 and 10 still
    // assert the Goal section and the move directly.
    breaks: 'handoff setup walk (reported as case 1); cases 2 and 10 assert it directly',
    test: HANDOFF,
    find: `    db.prepare(\`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?\`).run(tr.toState, at, tr.taskId);`,
    replace: `    // MUTANT: journalled but the task never moves`,
  },
  {
    name: 'H12-stale-fromState-accepted',
    file: F.db,
    why: 'Accepting a transition from a state the task is not in. That is a lost update: two actors transitioning concurrently would each overwrite the other, and the journal would record a move that never happened from a state the task had already left.',
    breaks: 'handoff case 10 (a stale fromState is refused)',
    test: HANDOFF,
    find: `    if (tr.fromState !== undefined && tr.fromState !== null && task.state !== tr.fromState) {`,
    replace: `    if (false) { // MUTANT: stale fromState accepted`,
  },
  {
    name: 'H10-generated-but-not-persisted',
    file: F.supervisor,
    why: "Generating a handoff without storing it. The entire value of tier 3 is that the NEXT reader -- a cleared worker, a reviewer, the CTO -- finds it already there; one that is generated and discarded costs the same and delivers nothing.",
    breaks: 'handoff case 1 (the handoff is persisted, not just returned)',
    test: HANDOFF,
    find: `    const id = recordTaskHandoff(database, { taskId, reason, ...generated });`,
    replace: `    const id = 0; // MUTANT: never persisted`,
  },
  {
    name: 'H13-tier2-assumptions-never-quoted',
    file: F.gen,
    why: "Ignoring tier 2 and always printing the empty notice. This is the failure the section was BUILT to fix, and it is invisible: the document still has an Assumptions heading and a plausible sentence under it, so a reader concludes the worker stated no assumptions when in fact one was recorded and dropped. Worse than an inference in one respect -- an invented assumption at least looks suspicious, whereas a silently dropped one looks like knowledge.",
    breaks: 'handoff case 4 (a stated assumption reaches the handoff verbatim)',
    test: HANDOFF,
    find: `  if (assumptions.length) {`,
    replace: `  if (false) { // MUTANT: tier-2 assumptions dropped`,
  },
  {
    name: 'H14-the-two-empty-cases-collapse',
    file: F.gen,
    why: '"Nothing was digested" and "every turn was digested and none stated an assumption" reported with the same sentence. They are different facts and a reader acts differently on each: the first means the source is missing and someone should go and look, the second means there is nothing to look at. Collapsing them turns a finding into a gap.',
    breaks: 'handoff case 4 (each empty case says WHICH kind of empty it is)',
    test: HANDOFF,
    find: `  } else if (digestedTurns) {`,
    replace: `  } else if (false) { // MUTANT: both empty cases read the same`,
  },
];

const exitCode = await runMutations(MUTATIONS, {
  cwd: SUPERVISOR,
  filter: process.argv[2],
});
process.exit(exitCode);
