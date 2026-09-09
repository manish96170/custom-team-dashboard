#!/usr/bin/env node
// _mutate-assignment.mjs — mutation harness for harness/model assignment and workflow profiles
// (PLAN.md sections 10 and 11).
//
// Same standing rule: break one mechanism, and the suite must fail BY ASSERTION at the case that protects
// it. A mutation that merely crashes proves nothing.
//
// WHAT MAKES THIS SET WORTH HAVING: assignment is the one path that starts real processes and spends real
// tokens, and almost every way it can be wrong still LOOKS like it worked. A double-started worker looks
// like a busy task. A per-team override that silently blanked the harness looks like a default. A task left
// in `starting` looks like a slow start. None of them throws.
//
// N1 and N4 are the two to read. N1 claims the idempotency key after spawning instead of before, which is
// the actual duplicate-start window. N4 reverses the compensation decision that two independent models were
// asked about — kill the coder because a reviewer failed — which is defensible-sounding and throws away
// work the task already did.
//
// Usage: node runtime/test/_mutate-assignment.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  config: path.join(SUPERVISOR, 'config/harness-defaults.js'),
  plan: path.join(SUPERVISOR, 'domain/assignment.js'),
  profiles: path.join(SUPERVISOR, 'domain/workflow-profiles.js'),
  supervisor: path.join(SUPERVISOR, 'runtime/supervisor.js'),
  db: path.join(SUPERVISOR, 'db/index.js'),
  gen: path.join(SUPERVISOR, 'handoff/generate.js'),
};

const ASSIGN = 'runtime/test/assignment.test.js';

const MUTATIONS = [
  {
    name: 'N1-idempotency-claimed-after-spawning',
    file: F.supervisor,
    why: "Writing the assignment record AFTER the runs are started instead of before. This is the actual duplicate-start window: `start()` awaits, so a second confirm arriving in that window finds no record and spawns a second run for the same worker. The task then has two processes editing the same worktree, which is the failure this project's whole single-writer design is arranged to avoid -- and both look like normal, busy runs.",
    breaks: 'assignment case 5 (one idempotency key, one start)',
    test: ASSIGN,
    find: `    writeAssignmentRecord(taskId, record);

    // \`created\` -> \`starting\` BEFORE the spawns`,
    replace: `    // MUTANT: the claim moves below the spawns

    // \`created\` -> \`starting\` BEFORE the spawns`,
  },
  {
    name: 'N2-per-team-override-replaces-the-whole-slot',
    file: F.config,
    why: "Replacing a slot wholesale with its per-team override instead of merging field by field. Works perfectly for a full override and silently blanks the harness for a partial one -- and a partial override is the only kind anyone writes, since the point of overriding one field is not restating the other two. The failure surfaces as 'slot has no harnessId', a long way from the file that caused it.",
    breaks: 'assignment case 1 (an override merges per field)',
    test: ASSIGN,
    find: `  return { ...(base ?? {}), ...(override ?? {}), role, overridden: !!override };`,
    replace: `  return { ...(override ?? base ?? {}), role, overridden: !!override }; // MUTANT: whole-slot replacement`,
  },
  {
    name: 'N3-unknown-config-key-ignored',
    file: F.config,
    why: "Ignoring an unrecognised key in a hand-edited config. Someone who wrote `modell: opus` intended to change the model, and dropping that silently means the setting appears to have no effect -- the intent-versus-reality mismatch FINDINGS section 31 exists to catch, in the file a human is most likely to typo.",
    breaks: 'assignment case 2 (a misspelled key is reported)',
    test: ASSIGN,
    find: `    if (unknown.length) {`,
    replace: `    if (false) { // MUTANT: unknown keys silently dropped`,
  },
  {
    name: 'N4-partial-start-is-all-or-nothing',
    file: F.supervisor,
    why: "Reversing the compensation decision: treat a partial start as a total failure, so the coder that DID start is abandoned and the task is marked failed. Two independent models were asked about this fork and both chose 'keep what worked' -- killing a working coder because a reviewer failed to spawn throws away real work to preserve a symmetry nothing needs, and the reviewer is retryable. Note the mutant is defensible-sounding, which is exactly why it needs a test rather than a discussion.",
    breaks: 'assignment case 6 (a partial start keeps the coder and moves on)',
    test: ASSIGN,
    find: `    if (live === 0 && finalState === "starting") {`,
    replace: `    if (failures.some((f) => f.kind === "start-failed") && finalState === "starting") { // MUTANT: all-or-nothing`,
  },
  {
    name: 'N5-nothing-started-stays-in-starting',
    file: F.supervisor,
    why: "Leaving a task in `starting` when every start failed. ROADMAP names this outcome specifically -- 'a task stuck in starting forever' -- and it is the worst of the three possible states to be wrong about: `starting` says a process is coming up, so anything watching waits for a report that will never arrive, and no human is told there is nothing to wait for.",
    breaks: 'assignment case 7 (nothing started -> start-failed)',
    test: ASSIGN,
    find: `        taskId, fromState: "starting", toState: "start-failed", actor,`,
    replace: `        taskId, fromState: "starting", toState: "planning", actor, // MUTANT: no honest failure state`,
  },
  {
    name: 'N6-assignment-runs-with-nobody-to-do-the-work',
    file: F.plan,
    why: "Acting on a plan that has no coder and no parent reviewer. The task leaves `created` for no reason: no work begins, but the state now says it has, so the tree shows it as running and the only thing wrong is that nothing is happening. Refusing keeps `created` meaning what it means -- the task exists and has not started.",
    breaks: 'assignment case 8 (a task with nobody to do the work is refused)',
    test: ASSIGN,
    find: `  const hasWork = plan.slots.some((s) => s.role === "coder" || s.role === "parentReviewer");`,
    replace: `  const hasWork = true; // MUTANT: always actionable`,
  },
  {
    name: 'N7-verdict-count-not-read-from-the-task-type',
    file: F.db,
    why: "Not consulting the task's type for the required verdict count. Two failures at once, in opposite directions: an `adhoc` task (no reviewers at all, PLAN.md section 10) can never reach `approved` under the default of two, and any per-type quorum becomes advisory. The profile's ONE connection to the state machine is this parameter, so cutting it makes the profiles decorative.",
    breaks: 'assignment case 9 (profiles change the verdict requirement per type)',
    test: ASSIGN,
    find: `      requiredVerdicts: tr.requiredVerdicts ?? requiredVerdictsFor(task.type),`,
    replace: `      requiredVerdicts: tr.requiredVerdicts, // MUTANT: the task type is ignored`,
  },
  {
    name: 'N8-unprofiled-type-defaults-to-no-review',
    file: F.profiles,
    why: "Defaulting an unknown task type to zero required verdicts. The safe default for a type nobody has thought about is the STRICTER one -- a type added by a future feature should not be the one that reaches `approved` with no review at all, and this is the kind of default that is discovered years later by reading a merge nobody checked.",
    breaks: 'assignment case 9 (an unprofiled type uses the stricter default)',
    test: ASSIGN,
    find: `  requiredVerdicts: 2,
  paneDefault: "dev",
  reviewRequired: true,
  description: "ordinary work: one coder, two reviewers, two verdicts before approval",`,
    replace: `  requiredVerdicts: 0, // MUTANT: unknown types need no review
  paneDefault: "dev",
  reviewRequired: true,
  description: "ordinary work: one coder, two reviewers, two verdicts before approval",`,
  },
  {
    name: 'N9-reviewer-slots-not-stably-ordered',
    file: F.plan,
    why: "Taking reviewers in registry order instead of a stable one. Which reviewer is `reviewer2` decides which HARNESS they run on (PLAN.md section 11's own example puts reviewer2 on OpenCode), so an unstable order means a task's two reviewers can swap harnesses between assignments for no visible reason -- and the two reviewers exist precisely because different harnesses catch different things.",
    breaks: 'assignment case 3 (reviewers are numbered in a stable order)',
    test: ASSIGN,
    find: `    .sort((a, b) => String(a.nickname ?? a.workerId).localeCompare(String(b.nickname ?? b.workerId)));`,
    replace: `    ; // MUTANT: registry order, whatever it happens to be`,
  },
  {
    name: 'N10-failed-role-never-surfaces',
    file: F.gen,
    why: "Recording a failed role in the assignment record and never showing it. This is how 'the task is not stuck in starting forever' quietly becomes 'the task is short a reviewer forever' instead: the compensation succeeded, the failure is durable, and nobody is told -- so the retry that would fix it never happens. The handoff's Blockers section is the one place every reader looks.",
    breaks: 'assignment case 10 (a failed role reaches the handoff as a blocker)',
    test: ASSIGN,
    find: `  for (const f of (facts.assignmentFailures ?? []).slice(0, SECTION_LIMITS.blockers)) {`,
    replace: `  for (const f of []) { // MUTANT: failed roles are recorded and never shown`,
  },
  {
    name: 'N11-retry-restarts-a-working-worker',
    file: F.plan,
    why: "Ignoring which workers already have a live run, so a retry starts a SECOND process for a worker that is working. Distinct from the idempotency case: that one is a double-click, this one is a deliberate retry of a partial start, and it is the more dangerous of the two because retrying is the correct action -- the operator does everything right and gets two processes in one worktree.",
    breaks: 'assignment case 5 (a retry skips a worker that is already running)',
    test: ASSIGN,
    find: `      alreadyRunning: open.has(worker.workerId),`,
    replace: `      alreadyRunning: false, // MUTANT: a live run is not noticed`,
  },
];

const exitCode = await runMutations(MUTATIONS, { cwd: SUPERVISOR, filter: process.argv[2] });
process.exit(exitCode);
