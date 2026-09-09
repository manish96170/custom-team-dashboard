// suite.js — the conformance suite (PLAN.md section 9, step 2).
//
// "A conformance suite runs against it (start, stream, interrupt, clear, exit detection) —
// pass/fail, not 'probably works'." Only on passing does `harnesses.status` flip to `active`.
//
// WHAT THIS IS FOR, precisely
//
// Not "does the adapter have these methods" — `requiredMethods` in matrix.js answers that from the
// declaration alone. This runs the harness and checks that what it DECLARED is what it DOES. The
// interesting outcomes are the disagreements:
//
//   declared and works        -> pass
//   declared and BROKEN       -> fail. The reason the suite exists: a matrix nobody verifies is a
//                                wish list, and section 9 chose declaration+verification over
//                                runtime code-generation specifically to avoid trusting a claim.
//   NOT declared and present  -> reported, not failed. An adapter that quietly does more than it
//                                promises is a documentation bug, not a broken harness — but it is
//                                worth seeing, because the supervisor will never use the capability.
//
// PASS/FAIL IS PER CHECK, AND THE VERDICT IS DERIVED
//
// A single boolean for a whole harness would make "interrupt is broken" and "the whole adapter is
// unusable" indistinguishable, and they lead to different decisions. So each check reports
// independently and `verdict()` decides the tier from the set.
//
// THIS RUNS AGAINST ANY ADAPTER, including the fake one. That is deliberate: the suite must be
// exercisable deterministically and for free in `npm test`, or it will only ever be run by hand and
// will rot. Running it against the REAL adapters costs tokens and is a separate, by-hand step
// (`conformance/run.mjs`).

import { validateMatrix, requiredMethods, TIERS } from "./matrix.js";

/** Bounded so a hung harness fails the check rather than hanging the suite. */
const DEFAULT_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drain an adapter's `observe()` until a predicate matches or the budget expires.
 *
 * Takes the iterator once and always closes it: leaking an async iterator on a resident process is
 * how a suite that "passes" leaves the harness consuming its own stream forever.
 */
async function drainUntil(adapter, runId, pred, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const seen = [];
  const iter = adapter.observe(runId);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { matched: false, seen, reason: `timed out after ${timeoutMs}ms` };
      let step;
      try {
        step = await withTimeout(iter.next(), remaining, "the next event");
      } catch (err) {
        return { matched: false, seen, reason: err.message };
      }
      if (step.done) return { matched: false, seen, reason: "the stream ended without matching" };
      if (step.value !== undefined) {
        seen.push(step.value);
        if (pred(step.value, seen)) return { matched: true, seen };
      }
    }
  } finally {
    // `return()` is the async-iterator cancellation contract; a generator parked inside an `await`
    // may not honour it immediately, which is a known limitation (runtime/FINDINGS.md open items).
    try { await iter.return?.(); } catch { /* teardown must not fail the check */ }
  }
}

/** One check's result. `skipped` is a first-class outcome: a capability not declared is not a failure. */
const result = (name, status, detail, extra = {}) => ({ name, status, detail, ...extra });

/**
 * Run the suite.
 *
 * `spec` is how to start a trivial run on this harness — a prompt and a cwd. The caller supplies it
 * because a real harness needs a real directory and the fake one does not, and baking either in
 * would make the suite unrunnable against the other.
 */
export async function runConformance(adapter, {
  harnessId,
  spec,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  interruptPrompt = "Count slowly from 1 to 50, one number per line.",
} = {}) {
  const checks = [];
  const declared = typeof adapter.capabilities === "function" ? adapter.capabilities() : null;

  // ── 0. the declaration itself ─────────────────────────────────────────────────────────
  const validation = validateMatrix(declared);
  checks.push(validation.ok
    ? result("matrix:declared", "pass", "a complete, well-formed capability matrix")
    : result("matrix:declared", "fail", validation.problems.join("; ")));

  // Methods the DECLARATION requires. Cheap, and it catches a capability claimed but never written.
  const missing = declared ? requiredMethods(declared).filter((m) => typeof adapter[m] !== "function") : [];
  checks.push(missing.length === 0
    ? result("matrix:methods", "pass", "every method the declaration requires exists")
    : result("matrix:methods", "fail", `declared capabilities require missing method(s): ${missing.join(", ")}`));

  // Present but undeclared. Reported, never failed — see the header.
  const undeclaredExtras = ["answerApproval", "pendingApprovals"].filter(
    (m) => typeof adapter[m] === "function" && declared?.approvalProtocol !== "host",
  );
  if (undeclaredExtras.length) {
    checks.push(result("matrix:undeclared-extras", "warn",
      `implements ${undeclaredExtras.join(", ")} but does not declare approvalProtocol:'host', so the supervisor will never use it`));
  }

  let runId = null;
  try {
    // ── 1. start ────────────────────────────────────────────────────────────────────────
    try {
      runId = await withTimeout(Promise.resolve(adapter.start(spec)), timeoutMs, "start() to return a runId");
      checks.push(typeof runId === "string" && runId.length
        ? result("start", "pass", `returned runId ${runId}`)
        : result("start", "fail", `start() must return a non-empty runId string; got ${JSON.stringify(runId)}`));
    } catch (err) {
      checks.push(result("start", "fail", `start() threw: ${err.message}`));
      return finish(checks, harnessId, declared);
    }

    // ── 2. stream ───────────────────────────────────────────────────────────────────────
    // Any event at all is the bar here, not a specific type: this is "does the structured stream
    // work", and asserting on a particular event type would encode one harness's vocabulary.
    {
      const got = await drainUntil(adapter, runId, () => true, { timeoutMs });
      checks.push(got.matched
        ? result("stream", "pass", `observe() yielded ${got.seen[0]?.type ?? "an event"}`)
        : result("stream", "fail", `observe() yielded nothing: ${got.reason}`));
    }

    // ── 3. exit detection ───────────────────────────────────────────────────────────────
    // A terminal event must arrive. Without it the supervisor cannot tell a finished run from a
    // hung one, which is the single most load-bearing thing an adapter does — reconciliation,
    // `endRun`, and every ask-closing path hang off it.
    {
      const got = await drainUntil(adapter, runId, (e) => e.type === "turn.end" || e.type === "process.exit", { timeoutMs });
      checks.push(got.matched
        ? result("exit-detection", "pass", "a terminal event arrived (turn.end or process.exit)")
        : result("exit-detection", "fail",
            `no terminal event within ${timeoutMs}ms — the supervisor cannot distinguish finished from hung: ${got.reason}`));
    }

    // ── 4. interrupt ────────────────────────────────────────────────────────────────────
    if (!declared?.interrupt) {
      checks.push(result("interrupt", "skip", "not declared, so not required"));
    } else {
      // A SECOND run, given something long enough to interrupt. Interrupting the first would race
      // its natural completion and the check would pass or fail on timing rather than on behaviour.
      let victim = null;
      try {
        victim = await withTimeout(Promise.resolve(adapter.start({ ...spec, prompt: interruptPrompt })), timeoutMs, "the interrupt victim to start");
        await drainUntil(adapter, victim, () => true, { timeoutMs });
        await withTimeout(Promise.resolve(adapter.interrupt(victim)), timeoutMs, "interrupt() to return");

        if (declared.interrupt === "turn") {
          // 'turn' claims the PROCESS survives. That is the whole distinction from 'process', and
          // it is what section 7's clean-vs-kill rests on, so it is what gets checked.
          const alive = (adapter.listRuns?.() ?? []).includes(victim);
          checks.push(alive
            ? result("interrupt", "pass", "interrupt ended the turn and the run is still usable")
            : result("interrupt", "fail", "declared interrupt:'turn' but the run did not survive the interrupt — that is interrupt:'process'"));
        } else {
          // interrupt:'process' claims the process does NOT survive, so that is what gets checked.
          // This branch used to pass unconditionally — a harness could declare 'process', do nothing at
          // all, and be reported as conforming. Unreachable today (both adapters declare 'turn'), which
          // is exactly why it needed writing down rather than trusting: an unexercised branch that
          // asserts nothing is a branch that will be wrong the first time it runs. Raised by review.
          const stillListed = (adapter.listRuns?.() ?? []).includes(victim);
          checks.push(stillListed
            ? result("interrupt", "fail",
                "declared interrupt:'process' but the run survived the interrupt — that is interrupt:'turn'")
            : result("interrupt", "pass", "interrupt:'process' — the process did not survive, as declared"));
        }
      } catch (err) {
        checks.push(result("interrupt", "fail", `interrupt failed: ${err.message}`));
      } finally {
        if (victim) { try { await adapter.stop(victim); } catch { /* teardown */ } }
      }
    }

    // ── 5. clear ────────────────────────────────────────────────────────────────────────
    if (!declared?.clearContext) {
      checks.push(result("clear", "skip", "not declared, so not required"));
    } else {
      try {
        const out = await withTimeout(Promise.resolve(adapter.clearContext(runId)), timeoutMs, "clearContext() to return");
        // The semantics are DECLARED, not inferred: nothing observable from outside distinguishes an
        // erase from a compact in one call, and guessing would be worse than trusting a declaration
        // that a human wrote and a reader can check against the adapter's own code. What IS checked
        // is that it acknowledged rather than silently doing nothing.
        checks.push(out?.ack
          ? result("clear", "pass", `clearContext acknowledged; declared semantics: ${declared.clearContext}`,
              { semantics: declared.clearContext })
          : result("clear", "fail", `clearContext returned no ack: ${JSON.stringify(out)}`));
      } catch (err) {
        checks.push(result("clear", "fail", `clearContext threw: ${err.message}`));
      }
    }
  } finally {
    if (runId) { try { await adapter.stop(runId); } catch { /* teardown */ } }
    // Give a resident process a moment to actually go, so a suite run does not leave one behind for
    // the next one to trip over.
    await sleep(150);
  }

  return finish(checks, harnessId, declared);
}

/**
 * Turn a set of checks into section 9's tier.
 *
 * `wrapper` for a harness with no usable declaration, `active` only when nothing failed. A `warn`
 * never blocks: it means the adapter does more than it says, which is a documentation problem.
 */
export function verdict(checks, declared) {
  const failed = checks.filter((c) => c.status === "fail");
  const noMatrix = !declared || checks.some((c) => c.name === "matrix:declared" && c.status === "fail");
  // A THIRD way into the wrapper tier, found when the tier's own adapter was written (FINDINGS §36).
  //
  // This function derived the tier entirely from "did the checks pass", which reads correctly for the two
  // cases section 9 names — no matrix, or a matrix whose claims do not hold. But a DEGRADED DRIVER THAT
  // TELLS THE TRUTH passes every check: `adapters/wrapper` declares `structuredOutput: 'terminal'`,
  // implements exactly what it declares, and would therefore have been marked `active`. The mechanism that
  // exists to stop a degraded harness being "silently treated as equivalent to a real,
  // conformance-passing adapter" would have done precisely that, to the one adapter that is degraded BY
  // DEFINITION.
  //
  // So the tier is `wrapper` whenever the harness is driven by a terminal rather than a structured stream,
  // however well it behaves. That is what the tier MEANS — section 9 defines it as being "driven via
  // node-pty + a terminal parser instead of its own structured event stream" — and honesty in the
  // declaration must not be what costs an adapter its accurate label.
  const terminal = declared?.structuredOutput === "terminal";
  const degraded = failed.length > 0 || terminal;
  return {
    tier: degraded ? TIERS.WRAPPER : TIERS.ACTIVE,
    // `passed` is about the CHECKS, and stays true for a well-behaved terminal driver: "this adapter does
    // what it says" and "this adapter is degraded" are different facts, and collapsing them would make a
    // conforming wrapper indistinguishable from a broken adapter in every report and log.
    passed: failed.length === 0,
    // Why it is degraded, in the terms section 9 uses: three distinct situations, three messages, because
    // the operator's next action differs for each.
    reason: failed.length === 0
      ? (terminal
          ? "declares structuredOutput: 'terminal' — section 9's wrapper tier by definition, not a failure"
          : null)
      : (noMatrix
          ? "no usable capability matrix — section 9's wrapper tier"
          : `declared capabilities did not hold: ${failed.map((c) => c.name).join(", ")}`),
    failed: failed.map((c) => c.name),
    warnings: checks.filter((c) => c.status === "warn").map((c) => c.name),
  };
}

function finish(checks, harnessId, declared) {
  return { harnessId, declared, checks, verdict: verdict(checks, declared) };
}

/** A compact human-readable report — the thing an operator reads before flipping a harness on. */
export function formatReport(report) {
  const L = [`conformance: ${report.harnessId} -> ${report.verdict.tier.toUpperCase()}`];
  if (report.verdict.reason) L.push(`  reason: ${report.verdict.reason}`);
  if (report.declared) {
    L.push("  declared:");
    for (const [k, v] of Object.entries(report.declared)) L.push(`    ${k}: ${JSON.stringify(v)}`);
  }
  L.push("  checks:");
  for (const c of report.checks) {
    const mark = { pass: "ok  ", fail: "FAIL", skip: "skip", warn: "warn" }[c.status] ?? c.status;
    L.push(`    [${mark}] ${c.name} — ${c.detail}`);
  }
  return L.join("\n");
}
