#!/usr/bin/env node
// _mutate-conformance.mjs — mutation harness for harness onboarding by conformance (PLAN.md §9).
//
// Same standing rule: break one mechanism at a time, and the suite must fail BY ASSERTION at the case
// that protects it. A mutation that merely crashes proves nothing.
//
// What is unusual about mutating a CONFORMANCE system: most of its failure modes make it more
// permissive, and a more permissive gate still passes every happy-path test. "Accept a partial
// matrix", "call it active anyway", "don't check whether the method exists" — each of those turns the
// suite into a rubber stamp while every conforming adapter keeps conforming. So most of these
// mutations attack the REFUSALS, which is where a gate's value actually lives.
//
// C7 is the one to read: it boolean-ifies the `clearContext` field, which is the exact shape this
// system started as and the exact shape Phase 3 found to be wrong.
//
// Usage: node runtime/test/_mutate-conformance.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  matrix: path.join(SUPERVISOR, 'conformance/matrix.js'),
  suite: path.join(SUPERVISOR, 'conformance/suite.js'),
  supervisor: path.join(SUPERVISOR, 'runtime/supervisor.js'),
};

// A numbered suite, so the runner's own attribution says WHICH case broke.
const CONF = 'runtime/test/conformance.test.js';

const MUTATIONS = [
  {
    name: 'C1-partial-matrix-accepted',
    file: F.matrix,
    why: "Accepting a matrix that omits fields. Section 9 treats 'no declared capability matrix' as the degraded wrapper tier; a PARTIAL matrix silently defaulting is how an unverified claim gets in, and it is indistinguishable from a complete one to everything downstream.",
    breaks: 'conformance case 3 (a partial matrix is not a matrix)',
    test: CONF,
    find: `    if (!Object.hasOwn(declared, field)) {
      problems.push(\`missing field "\${field}" — a partial matrix is not a matrix; declare it explicitly, including as false\`);
      continue;
    }`,
    replace: `    if (!Object.hasOwn(declared, field)) continue; // MUTANT: partial matrix accepted`,
  },
  {
    name: 'C2-no-matrix-becomes-active',
    file: F.suite,
    why: "Letting an adapter with no capability matrix reach the active tier. This is the single change that makes the whole onboarding step decorative: section 9's entire point is that `active` must be EARNED, and before this work `harnesses.status` was whatever a caller typed.",
    breaks: 'conformance case 3 (no matrix lands in the wrapper tier)',
    test: CONF,
    find: `  const failed = checks.filter((c) => c.status === "fail");`,
    replace: `  const failed = []; // MUTANT: nothing ever fails`,
  },
  {
    name: 'C3-declared-methods-not-checked',
    file: F.suite,
    why: 'Not cross-checking the declaration against the methods that exist. An adapter could declare `approvalProtocol: host` with no `answerApproval`, reach the active tier, and then park workers forever with an approval UI that can never deliver — which is precisely the state the opencode adapter is in and honestly declares as `observe-only`.',
    breaks: 'conformance case 4 (a declared-but-unimplemented capability fails)',
    test: CONF,
    find: `  const missing = declared ? requiredMethods(declared).filter((m) => typeof adapter[m] !== "function") : [];`,
    replace: `  const missing = []; // MUTANT: declarations never cross-checked`,
  },
  {
    name: 'C4-host-approval-needs-nothing',
    file: F.matrix,
    why: "Declaring `approvalProtocol: 'host'` without requiring the methods that make it true. The same defect as C3 one layer down, in the table that decides what a claim implies rather than in the check that applies it.",
    breaks: 'conformance case 4 (host approval requires answerApproval)',
    test: CONF,
    find: `  if (declared?.approvalProtocol === "host") {`,
    replace: `  if (false) { // MUTANT: host approval implies nothing`,
  },
  {
    name: 'C5-honest-observe-only-punished',
    file: F.matrix,
    why: "Requiring `answerApproval` from every harness that reports permissions, including the honest `observe-only` ones. This is the mutation that would push adapters toward OVERCLAIMING: opencode's candid declaration would fail conformance while a dishonest `approvalProtocol: false` would pass, so the incentive would run backwards.",
    // Observed at case 7, not 8: case 7 runs `requiredMethods` over BOTH real adapters, so it fires
    // before case 8's explicit assertion. The earliest dependent case, not a wrong reason.
    breaks: 'conformance case 7 (both adapters implement what they declare) — first; case 8 asserts it directly',
    test: CONF,
    find: `  if (declared?.approvalProtocol === "host") {
    // Only 'host' needs these. 'observe-only' is precisely the case where they are ABSENT, and
    // requiring them there would report the honest declaration as the failure.
    need.add("answerApproval");`,
    replace: `  if (declared?.approvalProtocol) { // MUTANT: honesty punished
    need.add("answerApproval");`,
  },
  {
    name: 'C6-broken-clear-passes',
    file: F.suite,
    why: 'Accepting a `clearContext` that acknowledges nothing. The method exists so the cheap cross-check passes; only running it reveals a clear that silently does nothing, and "pass/fail, not probably works" is the sentence section 9 uses.',
    breaks: 'conformance case 5 (a declared-but-broken capability fails behaviourally)',
    test: CONF,
    find: `        checks.push(out?.ack`,
    replace: `        checks.push(true`,
  },
  {
    name: 'C7-clearContext-is-a-boolean',
    file: F.matrix,
    why: "THE ONE THAT MATTERS. Reverting `clearContext` to a boolean — the shape this system started as. Both real adapters would then declare `true`: claude-code ERASES history, opencode COMPACTS and retains it, and the declaration would say they are the same. PLAN.md section 8's Rule 5 prices routine clearing at 'one page of reload', which is true of an erase and false of a compact, so anything reading this field would be wrong about token cost and about what a worker remembers after a clear.",
    // Observed at case 1: boolean-ifying the field also invalidates the FAKE harness's declaration
    // (`clearContext: 'erase'`), so the very first onboarding fails. That is the mutation's reach
    // rather than a mis-attribution — it breaks every adapter in the project at once, which is the
    // most direct demonstration that the field's semantics are load-bearing.
    breaks: 'conformance case 1 (a conforming adapter passes) — first; cases 7/8 assert the divergence',
    test: CONF,
    find: `  clearContext: ["erase", "compact", false],`,
    replace: `  clearContext: [true, false], // MUTANT: semantics erased`,
  },
  {
    name: 'C8-undeclared-extras-block-onboarding',
    file: F.suite,
    why: 'Treating an undeclared-but-present capability as a failure instead of a warning. Doing MORE than you declared is a documentation bug: the supervisor will never reach for the capability, so nothing is broken. Failing it would block a working harness over a stale comment.',
    breaks: 'conformance case 6 (an undeclared capability warns without blocking)',
    test: CONF,
    find: `    checks.push(result("matrix:undeclared-extras", "warn",`,
    replace: `    checks.push(result("matrix:undeclared-extras", "fail",`,
  },
  {
    name: 'C9-tier-not-persisted',
    file: F.supervisor,
    why: "Returning the conformance verdict without persisting it. Section 9's step 3 is that `harnesses.status` FLIPS on passing; a verdict that lives only in a return value means every consumer has to re-run a real harness to find out whether it is trusted, which for `claude-code` costs tokens each time.",
    breaks: 'conformance case 2 (the tier and declaration are persisted)',
    test: CONF,
    find: `    upsertHarness(database, {
      id: harnessId,`,
    replace: `    if (globalThis.__NEVER__ ?? true) { /* MUTANT: tier not persisted */ } else upsertHarness(database, {
      id: harnessId,`,
  },
];

const exitCode = await runMutations(MUTATIONS, {
  cwd: SUPERVISOR,
  filter: process.argv[2],
});
process.exit(exitCode);
