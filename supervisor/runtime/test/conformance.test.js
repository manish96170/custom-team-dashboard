// conformance.test.js — harness onboarding by conformance (PLAN.md section 9), Phase 3.
//
// Section 9: "register an already-installed, versioned adapter that declares a capability matrix and
// passes conformance tests", and only on passing does `harnesses.status` flip to `active`. This is
// the machinery that answers Phase 3's actual question — was "one interface, N implementations"
// honest or aspirational?
//
// The answer, found by writing this: **mostly honest, with two real divergences that a boolean
// matrix would have hidden.** Cases 7 and 8 pin them down, and they are the reason
// `conformance/matrix.js` uses semantics-carrying strings instead of booleans:
//
//   clearContext      claude-code ERASES history; opencode COMPACTS and retains it
//   approvalProtocol  claude-code can be ANSWERED; opencode can only be OBSERVED
//
// Both adapters would have declared `true` for both fields and the declaration would have been
// worthless.
//
// Cases:
//   1. a conforming adapter passes every check and is flipped to `active`
//   2. the tier and the declaration it came from are both persisted
//   3. a missing/partial matrix lands in the `wrapper` tier, not `active`
//   4. a capability declared but NOT implemented fails — the whole point of verifying a claim
//   5. a capability declared and BROKEN fails at the behavioural check, not the method check
//   6. an undeclared-but-present capability WARNS, and does not block
//   7. the two real adapters' declarations are valid and complete
//   8. ...and they DISAGREE on clearContext and approvalProtocol, in the contract rather than in prose
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import { openDb, closeDb, createWorker, createTask } from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { runConformance, verdict, formatReport } from "../../conformance/suite.js";
import { validateMatrix, requiredMethods, TIERS } from "../../conformance/matrix.js";
import * as claudeCode from "../../adapters/claude-code/adapter.js";
import * as openCode from "../../adapters/opencode/adapter.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

/** Wrap the fake harness, overriding pieces, so a defect can be injected without editing the fake. */
function harnessWith(overrides = {}) {
  const base = createFakeHarness({ label: "conformance" });
  return { ...base, ...overrides };
}

const harnessRow = (db, id) => db.prepare("SELECT * FROM harnesses WHERE id = ?").get(id);

await runTest("conformance / harness onboarding", async () => {
  const stateDir = makeScratchDir("supervisor-conformance-test");
  let db;
  let supervisor;

  try {
    db = openDb({ stateDir });
    createTask(db, { id: "t1", title: "conformance", type: "feature" });
    createWorker(db, { workerId: "w1", nickname: "tester", role: "worker", taskId: "t1" });

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    {
      const harness = harnessWith();
      supervisor = createSupervisor({ db, adapters: { good: harness }, logger: quiet, askSweepIntervalMs: 0 });
      await supervisor.boot();

      const report = await supervisor.onboardHarness({ harnessId: "good", spec: { cwd: stateDir }, timeoutMs: 15_000 });
      const failures = report.checks.filter((c) => c.status === "fail");
      assert.deepEqual(failures, [], `a conforming adapter must pass everything; failed: ${JSON.stringify(failures, null, 1)}`);
      assert.equal(report.verdict.tier, TIERS.ACTIVE);
      assert.equal(report.verdict.passed, true);

      // The five behaviours section 9 names, all actually exercised.
      for (const name of ["start", "stream", "exit-detection", "interrupt", "clear"]) {
        const c = report.checks.find((x) => x.name === name);
        assert.ok(c, `section 9 requires a "${name}" check`);
        assert.notEqual(c.status, "fail", `${name} failed: ${c.detail}`);
      }
      console.log("  1. a conforming adapter passed every section-9 check and was flipped to active");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    {
      const row = harnessRow(db, "good");
      // Asserted BEFORE dereferencing: without this, an onboarding that persists nothing makes the
      // next line throw a TypeError, and the mutation harness only credits a failure caught by a
      // real AssertionError (a mutation that merely crashes proves nothing).
      assert.ok(row, "onboarding must PERSIST the harness row, not just return a verdict");
      assert.equal(row.status, "active", "the tier must be persisted, not just returned");
      const stored = JSON.parse(row.capabilities_json);
      assert.equal(stored.clearContext, "erase",
        "and the declaration it was derived from, or the tier cannot be reviewed later");
      assert.ok(row.onboarded_at, "with when it was decided");
      console.log("  2. the tier and the declaration behind it are both persisted");
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    // Section 9: no declared matrix at all -> the wrapper tier. NOT active-by-default, which is the
    // failure mode that makes a conformance step pointless.
    {
      const noMatrix = harnessWith({ capabilities: undefined });
      const s2 = createSupervisor({ db, adapters: { nomatrix: noMatrix }, logger: quiet, askSweepIntervalMs: 0 });
      await s2.boot();
      const report = await s2.onboardHarness({ harnessId: "nomatrix", spec: { cwd: stateDir }, timeoutMs: 15_000 });
      assert.equal(report.verdict.tier, TIERS.WRAPPER, "no matrix must NOT become active");
      assert.match(report.verdict.reason, /wrapper tier/);
      assert.equal(harnessRow(db, "nomatrix").status, "wrapper", "and the degradation is persisted");

      // A PARTIAL matrix is not a matrix either — "assume the defaults" is how an unverified claim
      // sneaks in.
      const partial = validateMatrix({ residentProcess: "per-run" });
      assert.equal(partial.ok, false);
      assert.ok(partial.problems.some((p) => /missing field "clearContext"/.test(p)),
        `a partial matrix must name what is missing; got ${JSON.stringify(partial.problems)}`);
      await s2.shutdown({ timeoutMs: 2000 });
      console.log("  3. no matrix, and a partial matrix, both land in the wrapper tier");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    // A claim nobody implemented. This is the case that justifies pairing the matrix with a suite
    // instead of trusting the declaration.
    {
      const liar = harnessWith({
        capabilities: () => ({
          residentProcess: "per-run", resumableTurns: true, structuredOutput: "stream-json",
          interrupt: "turn", clearContext: "erase",
          approvalProtocol: "host", // claims the host protocol...
          modelDiscovery: false,
        }),
        answerApproval: undefined,   // ...but cannot answer
        pendingApprovals: undefined,
      });
      const report = await runConformance(liar, { harnessId: "liar", spec: { cwd: stateDir, prompt: "hi" }, timeoutMs: 15_000 });
      const methods = report.checks.find((c) => c.name === "matrix:methods");
      assert.equal(methods.status, "fail", "declaring approvalProtocol:'host' without answerApproval must fail");
      assert.match(methods.detail, /answerApproval/);
      assert.equal(report.verdict.tier, TIERS.WRAPPER, "and the harness is degraded, not active");
      assert.ok(report.verdict.reason.includes("matrix:methods"));
      console.log("  4. a capability declared but not implemented failed the method cross-check");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    // Declared, present, and WRONG. Distinct from case 4: the method exists, so only running it
    // reveals the problem — which is what "pass/fail, not 'probably works'" means.
    {
      const broken = harnessWith({
        capabilities: () => ({
          residentProcess: "per-run", resumableTurns: true, structuredOutput: "stream-json",
          interrupt: "turn", clearContext: "erase", approvalProtocol: "host", modelDiscovery: false,
        }),
        // Acknowledges nothing: the shape a clear that silently does nothing would have.
        clearContext: () => ({}),
      });
      const report = await runConformance(broken, { harnessId: "broken", spec: { cwd: stateDir, prompt: "hi" }, timeoutMs: 15_000 });
      assert.equal(report.checks.find((c) => c.name === "matrix:methods").status, "pass",
        "the method exists, so the cheap cross-check passes...");
      assert.equal(report.checks.find((c) => c.name === "clear").status, "fail",
        "...and only actually running it catches that it does nothing");
      assert.equal(report.verdict.tier, TIERS.WRAPPER);
      console.log("  5. a declared-but-broken capability failed at the behavioural check");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    // Doing MORE than you declared is a documentation bug, not a broken harness. It must be visible
    // (the supervisor will never use the capability) and must not block onboarding.
    {
      const modest = harnessWith({
        capabilities: () => ({
          residentProcess: "per-run", resumableTurns: true, structuredOutput: "stream-json",
          interrupt: "turn", clearContext: "erase",
          approvalProtocol: "observe-only", // understates itself: it DOES have answerApproval
          modelDiscovery: false,
        }),
      });
      const report = await runConformance(modest, { harnessId: "modest", spec: { cwd: stateDir, prompt: "hi" }, timeoutMs: 15_000 });
      const warn = report.checks.find((c) => c.name === "matrix:undeclared-extras");
      assert.ok(warn, "an undeclared capability must be reported");
      assert.equal(warn.status, "warn", "as a warning, not a failure");
      assert.match(warn.detail, /never use it/, "and it must say the consequence: the supervisor will not use it");
      assert.equal(report.verdict.tier, TIERS.ACTIVE, "a warning must not block onboarding");
      // `includes`, not an exact array: pinning the whole list means any future warning fails this case
      // for a reason unrelated to what it tests. Raised by review as brittleness.
      assert.ok(report.verdict.warnings.includes("matrix:undeclared-extras"),
        `the warning must be reported in the verdict; got ${JSON.stringify(report.verdict.warnings)}`);
      console.log("  6. an undeclared-but-present capability warned without blocking");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    // The real adapters' DECLARATIONS, checked without running either harness — free, and it is the
    // half of Phase 3's question that does not need tokens.
    {
      for (const [id, adapter] of [["claude-code", claudeCode], ["opencode", openCode]]) {
        assert.equal(typeof adapter.capabilities, "function", `${id} must declare a capability matrix`);
        const declared = adapter.capabilities();
        const v = validateMatrix(declared);
        assert.deepEqual(v.problems, [], `${id}'s matrix is malformed: ${v.problems.join("; ")}`);
        const missing = requiredMethods(declared).filter((m) => typeof adapter[m] !== "function");
        assert.deepEqual(missing, [], `${id} declares capabilities it does not implement: ${missing.join(", ")}`);
      }
      console.log("  7. both real adapters declare valid, complete, implemented matrices");
    }

    // ── 8 ────────────────────────────────────────────────────────────────────────────
    // PHASE 3'S ACTUAL FINDING. The boundary holds, but only because these two fields carry
    // semantics. As booleans both adapters would have said `true` to both and the declaration would
    // have been worthless.
    {
      const cc = claudeCode.capabilities();
      const oc = openCode.capabilities();

      assert.equal(cc.clearContext, "erase", "claude-code's /clear discards the conversation");
      assert.equal(oc.clearContext, "compact", "opencode's clearContext summarizes and RETAINS it");
      assert.notEqual(cc.clearContext, oc.clearContext,
        "same method name, opposite semantics — this is the divergence a boolean matrix would hide, "
        + "and PLAN.md section 8's Rule 5 prices clearing as an erase");

      assert.equal(cc.approvalProtocol, "host", "claude-code parks a decision on us and acts on the answer");
      assert.equal(oc.approvalProtocol, "observe-only",
        "opencode reports that a permission was asked and offers no way to answer it");
      assert.equal(typeof openCode.answerApproval, "undefined",
        "and the declaration matches reality: there is genuinely no answerApproval to call");

      assert.equal(cc.residentProcess, "per-run");
      assert.equal(oc.residentProcess, "pooled",
        "and the pooling difference is declared too — it is why opencode refuses a per-run environment");

      // The suite must accept the honest declaration rather than punishing it: `observe-only`
      // requires no answerApproval, so opencode's matrix is valid precisely BECAUSE it is candid.
      assert.deepEqual(requiredMethods(oc).filter((m) => typeof openCode[m] !== "function"), [],
        "an honest 'observe-only' declaration must pass, or adapters are pushed toward overclaiming");
      console.log("  8. the two adapters DISAGREE on clearContext, approvalProtocol and pooling — in the contract");
    }

    // The report an operator would read.
    const shown = await runConformance(harnessWith(), { harnessId: "good", spec: { cwd: stateDir, prompt: "hi" }, timeoutMs: 15_000 });
    console.log("");
    for (const line of formatReport(shown).split("\n")) console.log(`  | ${line}`);
  } finally {
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* best effort */ }
    try { if (db) closeDb(db); } catch { /* best effort */ }
    rmScratchDir(stateDir);
  }
});
