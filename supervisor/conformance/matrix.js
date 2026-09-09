// matrix.js — the capability matrix an adapter declares (PLAN.md section 9).
//
// WHY A MATRIX AT ALL, AND WHY THE FIELDS CARRY SEMANTICS RATHER THAN BOOLEANS
//
// Section 9 replaced runtime code-generation for new harnesses with "register an already-installed,
// versioned adapter that declares a capability matrix and passes conformance tests". The matrix is
// the declaration; `suite.js` is the check.
//
// The obvious shape would be booleans -- `clearContext: true` -- and it is WRONG, which Phase 3 found
// immediately by comparing the two adapters that already exist:
//
//   claude-code  clearContext() -> sends `/clear`         -> conversation history is ERASED
//   opencode     clearContext() -> POSTs `/summarize`     -> history is COMPACTED, not erased
//
// Same name, same signature, opposite meaning. Both would declare `clearContext: true` and the
// declaration would be worthless -- worse than worthless, because PLAN.md section 8's Rule 5 prices
// routine clearing at "one page of reload", which is true of an erase and false of a compact. A
// compact leaves a summary in context; it reduces context, it does not reset it. A `clearPolicy` of
// `on-state-transition` therefore means two different things depending on which harness the worker
// happens to be on, and nothing in the system could see that.
//
// So the fields that CAN diverge carry their semantics as a string, and a boolean is used only where
// there is genuinely nothing to distinguish. This is the whole point of the phase: "one interface, N
// implementations" is honest when the interface describes what implementations actually differ about,
// and aspirational when it papers over it.

/**
 * The declared shape. Every key is required — an adapter that omits one has not declared a matrix,
 * it has declared a partial one, and section 9 treats "no declared capability matrix" as the
 * `wrapper` (degraded) tier rather than as "assume the defaults".
 */
export const CAPABILITY_FIELDS = {
  /**
   * How the harness's process relates to a run.
   *
   *   'per-run' : one OS process per run, alive for the run's lifetime (claude-code).
   *   'pooled'  : one process shared by every run in a cwd, runs multiplexed on top (opencode).
   *   'one-shot': a process per TURN; nothing survives between turns.
   *
   * NOT a boolean, because `pooled` is the difference that broke the worker-environment feature:
   * an environment belongs to the process, so a pooled harness cannot take a per-run environment
   * declaration (adapters/FINDINGS.md). Anything reasoning about per-run isolation has to be able to
   * ask this.
   */
  residentProcess: ["per-run", "pooled", "one-shot"],

  /** Can a run continue after its process is gone -- `resume()` reattaching to harness-side state? */
  resumableTurns: [true, false],

  /**
   * The stream the adapter reads.
   *
   *   'stream-json' : newline-delimited JSON on stdout (claude-code).
   *   'sse'         : server-sent events over HTTP (opencode).
   *   'terminal'    : no structured stream; a terminal parser. This is section 9's `wrapper` tier.
   */
  structuredOutput: ["stream-json", "sse", "terminal"],

  /**
   * What an interrupt does.
   *
   *   'turn'    : ends the in-flight turn, process stays usable for the next one.
   *   'process' : the only way to stop it is to kill it (proven for `opencode run`, FINDINGS #4).
   *   false     : no interrupt at all.
   *
   * 'turn' vs 'process' is the difference between cancel and kill, which is section 7's whole
   * clean-vs-kill distinction. A boolean would erase it.
   */
  interrupt: ["turn", "process", false],

  /**
   * What clearing does to the conversation. THE FIELD THIS FILE EXISTS FOR.
   *
   *   'erase'   : history is gone; the next turn starts fresh (claude-code `/clear`).
   *   'compact' : history is summarized and RETAINED in reduced form (opencode `/summarize`).
   *   false     : no clear.
   *
   * Rule 5's cost model ("a soft clear costs one page of reload") holds for 'erase' and not for
   * 'compact'. Anything that treats these as the same thing is wrong about token cost, about what a
   * worker remembers after a clear, and about whether a tier-3 handoff is needed to reload it.
   */
  clearContext: ["erase", "compact", false],

  /**
   * How a parked permission decision reaches the harness.
   *
   *   'host'         : the harness asks US and waits; we answer and it proceeds (claude-code's
   *                    `can_use_tool` over stdio).
   *   'observe-only' : the harness TELLS us a permission was requested, and there is no way to
   *                    answer it from code. Measured on opencode: it emits `permission.asked`
   *                    (mapped to `approval.request`) and the adapter exposes no `answerApproval`.
   *   false          : no permission signal at all.
   *
   * 'observe-only' is the honest name for a real and dangerous state: a worker CAN park, an `asks`
   * row IS created, and nothing can ever deliver an answer. The supervisor already refuses to
   * pretend (it abandons the answer with a reason rather than stamping `delivered_at`), but nothing
   * DECLARED it, so an operator could reasonably expect the approval UI to work on that harness.
   */
  approvalProtocol: ["host", "observe-only", false],

  /** Can the adapter enumerate the models available to it, or must they be configured by hand? */
  modelDiscovery: [true, false],
};

/** Section 9's two tiers. `wrapper` is the canonical degraded mode, and is always marked as such. */
export const TIERS = { ACTIVE: "active", WRAPPER: "wrapper" };

/**
 * Validate a declared matrix.
 *
 * Returns problems rather than throwing, because "this adapter's declaration is malformed" is a
 * conformance RESULT that belongs in the report beside the behavioural checks -- not an exception
 * that stops the run before the other checks happen. An adapter can be wrong about one field and
 * right about the rest, and knowing that is more useful than a stack trace.
 */
export function validateMatrix(declared) {
  const problems = [];
  if (!declared || typeof declared !== "object") {
    return { ok: false, problems: ["no capability matrix declared at all (section 9: falls back to the wrapper tier)"] };
  }
  for (const [field, allowed] of Object.entries(CAPABILITY_FIELDS)) {
    if (!Object.hasOwn(declared, field)) {
      problems.push(`missing field "${field}" — a partial matrix is not a matrix; declare it explicitly, including as false`);
      continue;
    }
    if (!allowed.includes(declared[field])) {
      problems.push(
        `field "${field}" is ${JSON.stringify(declared[field])}; allowed: ${allowed.map((v) => JSON.stringify(v)).join(", ")}`,
      );
    }
  }
  for (const field of Object.keys(declared)) {
    if (!Object.hasOwn(CAPABILITY_FIELDS, field)) {
      problems.push(`unknown field "${field}" — the matrix is a contract, so an undeclared key is a typo or a capability that needs adding here`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Which adapter methods a declared capability REQUIRES.
 *
 * This is the cross-check that catches a declaration nobody implemented -- the failure mode a matrix
 * introduces if nothing verifies it, and the reason section 9 pairs the matrix with a suite instead
 * of trusting the declaration. It is deliberately about the METHOD's existence only; whether it
 * WORKS is `suite.js`'s job.
 */
export function requiredMethods(declared) {
  const need = new Set(["start", "observe", "stop", "listRuns", "disposeAll"]);
  if (declared?.resumableTurns === true) need.add("resume");
  if (declared?.interrupt) need.add("interrupt");
  if (declared?.clearContext) need.add("clearContext");
  if (declared?.approvalProtocol === "host") {
    // Only 'host' needs these. 'observe-only' is precisely the case where they are ABSENT, and
    // requiring them there would report the honest declaration as the failure.
    need.add("answerApproval");
    need.add("pendingApprovals");
  }
  return [...need];
}
