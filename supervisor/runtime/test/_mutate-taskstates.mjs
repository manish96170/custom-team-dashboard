#!/usr/bin/env node
// _mutate-taskstates.mjs — mutation harness for the task state machine (PLAN.md section 6), Phase 5.
//
// Same standing rule: break one mechanism, and the suite must fail BY ASSERTION at the case that
// protects it.
//
// WHAT MAKES THIS SET DIFFERENT: most of these mutations make the machine MORE PERMISSIVE, and a more
// permissive state machine still walks the happy path perfectly. "Let merged happen without approval",
// "accept any string as a state", "allow an automatic retry" — none of those breaks a single normal
// flow, which is exactly why they need mutations rather than trust.
//
// T1 is the one to read. It removes the no-autonomous-merges guard, which PLAN.md calls "a hard rule,
// not a default that can be silently skipped".
//
// Usage: node runtime/test/_mutate-taskstates.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  states: path.join(SUPERVISOR, 'domain/task-states.js'),
  db: path.join(SUPERVISOR, 'db/index.js'),
};

const STATES = 'domain/test/task-states.test.js';
const HANDOFF = 'runtime/test/handoff.test.js';

const MUTATIONS = [
  {
    name: 'T1-autonomous-merges-allowed',
    breaksCase: 'NO AUTONOMOUS MERGES — merged needs an explicit human approval',
    file: F.states,
    why: "Removing the no-autonomous-merges gate. PLAN.md section 6 calls this 'a hard rule, not a default that can be silently skipped' — and note the failure is invisible on the happy path: a flow that legitimately passes humanApproved keeps working, so only a mutation catches the guard going missing. The real-world consequence is code merged with no person in the loop.",
    breaks: 'task-states case 5 (merged needs an explicit human approval)',
    test: STATES,
    find: `  if (to === "merged" && context.humanApproved !== true) {`,
    replace: `  if (false) { // MUTANT: autonomous merges permitted`,
  },
  {
    name: 'T2-any-string-is-a-state',
    breaksCase: 'an unknown state is refused, and names the valid set',
    file: F.states,
    why: "Accepting an unknown state. This is the exact drift the module was written to stop — the project's own tests had reached `in-progress` / `in-review`, names appearing nowhere in the design, because nothing validated them. A state machine nothing enforces is a naming convention.",
    breaks: 'task-states case 2 (an unknown state is refused)',
    test: STATES,
    find: `  if (!isState(to)) return { ok: false, reason: \`"\${to}" is not a task state (valid: \${STATES.join(", ")})\` };`,
    replace: `  // MUTANT: any string accepted as a state`,
  },
  {
    name: 'T3-automatic-retry-allowed',
    breaksCase: 'coming back from a failure is explicit, never automatic',
    file: F.states,
    why: "Letting a failed or cancelled task return to `created` without an explicit act. Section 6: 'never automatically'. The failure mode is a retry loop that re-runs a task nobody asked to re-run, burning tokens on each pass.",
    breaks: 'task-states case 6 (coming back from a failure is explicit)',
    test: STATES,
    find: `    if (context.explicitRetry !== true) {`,
    replace: `    if (false) { // MUTANT: automatic retries permitted`,
  },
  {
    name: 'T4-blocked-reachable-from-anywhere',
    breaksCase: 'blocked is reachable only from implementing, and returns there',
    file: F.states,
    why: "Widening `blocked` beyond `implementing`. Section 6 restricts it deliberately and says to widen only 'if that assumption turns out wrong once real usage exists, widen it then rather than pre-designing for a case with no evidence yet'. Doing it speculatively is the change the design explicitly warns against.",
    breaks: 'task-states case 4 (blocked only from implementing)',
    test: STATES,
    find: `  planning: ["implementing", ...IN_FLIGHT_EXITS()],`,
    replace: `  planning: ["implementing", "blocked", ...IN_FLIGHT_EXITS()], // MUTANT`,
  },
  {
    name: 'T5-no-op-transitions-accepted',
    breaksCase: 'a no-op transition is refused',
    file: F.states,
    why: 'Accepting a transition to the state a task is already in. Section 6 wants the journal to make "double-transitions from a duplicate hook or a retried command detectable" — a no-op entry is precisely the duplicate that would then be indistinguishable from a real move.',
    breaks: 'task-states case 9 (a no-op transition is refused)',
    test: STATES,
    find: `  if (from === to) return { ok: false, reason: \`already in "\${to}" — a no-op transition would be a duplicate journal entry\` };`,
    replace: `  // MUTANT: no-op transitions accepted`,
  },
  {
    name: 'T6-actor-not-required',
    breaksCase: 'an unknown state is refused, and names the valid set',
    file: F.states,
    why: "Allowing an unattributed transition. Section 6's closing line is that every transition needs a named actor AND a guard; an unattributed state change makes the journal unable to answer 'who did this', which is the one question an audit trail exists for.",
    breaks: 'task-states case 2 (an actor is required)',
    test: STATES,
    find: `  if (!context.actor) return { ok: false, reason: "every transition needs a named actor (PLAN.md section 6)" };`,
    replace: `  // MUTANT: transitions may be unattributed`,
  },
  {
    name: 'T7-autoblock-widened',
    breaksCase: 'autoBlockTarget only moves implementing <-> blocked',
    file: F.states,
    why: 'Auto-blocking a task in any state as soon as an ask exists. Section 6 restricts the automatic behaviour to `implementing`; widening it would drag a planning or awaiting-review task into `blocked` on an unrelated ask, and the state would then be describing something that is not true.',
    breaks: 'task-states case 10 (autoBlockTarget only moves implementing <-> blocked)',
    test: STATES,
    find: `  if (askOpen && currentState === "implementing") return "blocked";`,
    replace: `  if (askOpen && currentState !== "blocked") return "blocked"; // MUTANT: auto-block anything`,
  },
  {
    name: 'T8-legality-not-enforced-on-write',
    file: F.db,
    why: "Journalling a transition without checking it is legal. The machine would then be a pure module nothing consults — which is the state the project was actually in before Phase 5, and why its own tests had drifted to invented state names.",
    breaks: 'handoff case 10 (a stale/illegal transition is refused)',
    test: HANDOFF,
    find: `    if (!verdict.ok) throw new Error(\`recordTransition: \${verdict.reason}\`);`,
    replace: `    void verdict; // MUTANT: legality computed and ignored`,
  },
];

const exitCode = await runMutations(MUTATIONS, { cwd: SUPERVISOR, filter: process.argv[2] });
process.exit(exitCode);
