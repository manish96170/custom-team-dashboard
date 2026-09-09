// capabilities.js — PLAN.md section 16's capability-based authorization, as a PURE module. Phase 7.
//
// WHAT THIS REPLACES. The original design routed every side effect through a fixed chain: worker -> lead ->
// CTO -> utility agent, unconditionally. Section 16 replaced it because a hop count "adds model calls to
// routine, low-risk actions for no clear security benefit" and "a hop with no return path is a deadlock
// waiting to happen". The replacement: "every caller carries an immutable principal and a set of
// capabilities. Direct invocation of a utility agent is allowed when the caller holds the capability for that
// action. CTO approval is required only for an explicitly enumerated sensitive class."
//
// Section 16 is equally explicit about what must SURVIVE the change, and each of these is a decision below:
//
//   * **Fixed toolsets** — "a jira-automation agent never picks up git access 'just this once'". So capability
//     sets are enumerated per kind of principal and there is no wildcard. A `*` is how that intent erodes in
//     one commit.
//   * **Never guess an underspecified task** — "a request missing a team/task is rejected back to the caller,
//     not interpreted charitably". `requireArgs` is that rule, and it lives here rather than in each agent.
//   * **No skip-level authority grants** — a principal cannot hand out what it does not hold, and cannot
//     approve its own sensitive action.
//
// THE RULE THIS FILE OWES §37.10. The Phase 6 review found three defects of one shape: a mechanism built,
// documented, and never consulted, with its inputs taken from the caller. Authorization has exactly that
// shape, so two properties are structural here rather than conventional:
//
//   1. **Nothing the decision reads comes from the request.** `authorize()` takes a principal OBJECT that the
//      caller cannot construct — the supervisor resolves it from a token hash — and the capability set is a
//      property of that row. The request supplies the command name and its arguments, nothing else.
//   2. **It fails closed.** A command with no declared capability is REFUSED, not allowed. A new command is
//      therefore unreachable until someone decides what it requires, which is the correct direction for the
//      mistake to fall.

import { createHash } from "node:crypto";

/**
 * The capability vocabulary. Explicit strings, one per class of action.
 *
 * `<domain>:<action>` because the domain is the part a reader scans for ("what can this thing touch"), and it
 * makes a fixed toolset legible at a glance: a jira agent's set contains only `jira:*` entries — written out,
 * never as a pattern.
 */
export const CAPABILITIES = Object.freeze([
  // Reading the dashboard's own state. Separated from writing because most principals need it and almost none
  // need the rest — and because a transcript is not public: `observe:run` hands over a worker's raw output.
  "read:registry",
  "observe:run",

  // The run lifecycle (PLAN.md §4).
  "run:start",
  "run:input",
  "run:interrupt",
  "run:stop",
  "run:clear",
  "run:resume",
  "run:reap",

  // Answering what a worker is blocked on (§7). Distinct from `run:input` because a permission decision is
  // not the same act as typing at a worker, and the sensitive-tool case is exactly where that matters.
  "ask:answer",

  // Task lifecycle and reviews (§6, §11, §13).
  "task:assign",
  "task:transition",
  "review:record",
  "task:approve",
  "task:merge",

  // Harness administration (§9, §12.1).
  "harness:onboard",
  "harness:preflight",
  "session:adopt",

  // The utility roster (§16). Each is a separate capability precisely so a toolset can be fixed.
  "git:push",
  "git:push-protected",
  "jira:create",
  "slack:post-bot",
  "slack:post-as-user",

  // Authorization administration. `principal:mint` is the one that can grow authority, so it is held by the
  // owner alone; `approve:sensitive` is the second signature the enumerated sensitive class requires.
  "principal:mint",
  "principal:revoke",
  "approve:sensitive",
]);

const CAP_SET = new Set(CAPABILITIES);
export const isCapability = (c) => CAP_SET.has(c);

/**
 * Section 16's "explicitly enumerated sensitive class": push to a protected branch, as-user posting, a merge.
 *
 * Holding the capability is necessary and NOT sufficient — each of these also needs a second principal's
 * approval, bound to the exact arguments. That is the whole difference between "this agent may push" and "this
 * agent may push THIS".
 */
export const SENSITIVE = Object.freeze(["git:push-protected", "slack:post-as-user", "task:merge"]);
export const isSensitive = (c) => SENSITIVE.includes(c);

/**
 * Which capability each wire command requires.
 *
 * FAIL CLOSED: a command absent from this map is refused. `assertCoversCommands()` makes that a test rather
 * than a hope — a new command is unreachable until someone decides what it requires, which is the direction
 * this mistake should fall. The alternative default ("unmapped means public") would have made every future
 * command an accidental hole, and the person adding it would never know.
 */
export const COMMAND_CAPABILITIES = Object.freeze({
  // reads
  //
  // NOTE ON WHAT IS ABSENT: `conformanceReport` and `importReviewProfiles` were listed here and are NOT wire
  // commands — they are supervisor methods called in-process. The coverage case in
  // `runtime/test/authorization.test.js` caught them as STALE entries, which is the other half of fail-closed
  // being useful: a policy naming commands that do not exist is a policy nobody can trust to be complete.
  list: "read:registry",
  status: "read:registry",
  orphans: "read:registry",
  asks: "read:registry",
  tuiSnapshot: "read:registry",
  adoptedSessions: "read:registry",
  modelHealth: "read:registry",
  turnDigests: "read:registry",
  taskHandoff: "read:registry",
  reviewStatus: "read:registry",
  reviewFindings: "read:registry",
  reviewProfiles: "read:registry",
  assignmentPreview: "read:registry",
  journal: "read:registry",
  principals: "read:registry",
  // A transcript is its own capability: `observe` streams a worker's raw tier-1 output, and Rule 4's whole
  // premise is that raw output is not something to hand out by default.
  observe: "observe:run",
  // writes
  start: "run:start",
  sendInput: "run:input",
  interrupt: "run:interrupt",
  stop: "run:stop",
  clearContext: "run:clear",
  resume: "run:resume",
  reap: "run:reap",
  answerAsk: "ask:answer",
  tuiChat: "run:input",
  assignTask: "task:assign",
  recordVerdict: "review:record",
  approveTask: "task:approve",
  preflight: "harness:preflight",
  onboardHarness: "harness:onboard",
  adoptSession: "session:adopt",
  releaseSession: "session:adopt",
  reconcile: "run:reap",
  mintPrincipal: "principal:mint",
  revokePrincipal: "principal:revoke",
  grantApproval: "approve:sensitive",
  // SENSITIVE (see `SENSITIVE`): holding `task:merge` is necessary and not sufficient — this command also
  // needs a second principal's approval bound to its exact arguments, which is where §6's "explicit human
  // approval" stops being a boolean a caller passes and becomes a recorded artifact.
  mergeTask: "task:merge",
});

/**
 * Capability sets per kind of principal — section 16's "fixed toolsets", written out.
 *
 * A WORKER cannot start runs, assign tasks, approve anything, or touch a utility capability. That is not
 * caution for its own sake: a worker is a model with a shell, and the entire reason utility agents exist is
 * that "the capability to push code, file a Jira ticket, or post to Slack isn't duplicated into every
 * worker's toolset".
 *
 * A REVIEWER is a worker that may also record verdicts — and specifically may NOT approve the task, because
 * §13's rule is what approves a task and one reviewer is not a quorum.
 */
export const PRESETS = Object.freeze({
  // The foreground human. Holds `approve:sensitive`, and is the only holder until the CTO exists (§2, Phase 8).
  owner: Object.freeze([...CAPABILITIES]),
  worker: Object.freeze(["read:registry", "ask:answer"]),
  reviewer: Object.freeze(["read:registry", "observe:run", "review:record"]),
  // The CTO (Phase 8) routes and advises; it holds the registry-adjacent writes and the second signature, and
  // deliberately not `git:*` or `slack:*` — §16: "delegates all repository and external side effects".
  cto: Object.freeze([
    "read:registry", "observe:run", "run:start", "run:input", "run:interrupt", "run:stop", "run:clear",
    "run:resume", "run:reap", "ask:answer", "task:assign", "task:transition", "task:approve",
    // `task:merge` IS here, and it is not a contradiction with `approve:sensitive` below — it is the point.
    // Moving a task to `merged` is registry-adjacent, which §16 gives the CTO ("performs registry-adjacent
    // actions directly via typed supervisor commands"). But merge is in the sensitive class, and a principal
    // cannot approve its own sensitive action, so a CTO merge still requires the HUMAN's signature. That is
    // §6's "explicit human/senior approval gate" arriving as a mechanism rather than a boolean.
    "task:merge",
    "harness:preflight", "harness:onboard", "session:adopt", "approve:sensitive",
  ]),
  // The roster (§16). One domain each, and `git:push-protected` is present for the git agent because holding
  // it is what makes the second-signature requirement apply to it at all.
  "utility:git": Object.freeze(["read:registry", "git:push", "git:push-protected"]),
  "utility:jira": Object.freeze(["read:registry", "jira:create"]),
  "utility:slack": Object.freeze(["read:registry", "slack:post-bot"]),
});

/** Validate a capability set at mint time, so a typo cannot silently grant nothing (or something else). */
export function validateCapabilities(caps) {
  if (!Array.isArray(caps)) return { ok: false, problems: ["capabilities must be an array"] };
  const problems = caps.filter((c) => !isCapability(c)).map((c) => `unknown capability ${JSON.stringify(c)}`);
  if (caps.includes("*")) problems.push('"*" is not a capability — section 16 keeps toolsets FIXED, so a set must be enumerated');
  return { ok: problems.length === 0, problems };
}

/**
 * A stable hash of a command's arguments.
 *
 * Sorted keys, so formatting is not identity. This is what binds a sensitive-action approval to the thing that
 * was approved: without it, an approval to push branch A authorises a push of branch B, and the gate is a
 * coupon rather than a decision. It is also the dedup key for §16's "did I already file this ticket".
 *
 * `id` is EXCLUDED: it is the wire's correlation id, not an argument, and including it would make every
 * request unique — which would silently defeat both the approval binding and the dedup query.
 */
export function argsHash(args = {}) {
  const canonical = stableStringify(stripEnvelope(args));
  return createHash("sha256").update(canonical).digest("hex");
}

function stripEnvelope(args) {
  const { id, cmd, token, ...rest } = args ?? {};
  return rest;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Section 16's "never guess an underspecified task": "a request missing a team/task is rejected back to the
 * caller, not interpreted charitably."
 *
 * Here rather than in each agent, because "charitable interpretation" is the default behaviour of every model
 * and the rule only holds if the refusal is mechanical.
 */
export function requireArgs(args, required = []) {
  const missing = required.filter((k) => args?.[k] === undefined || args[k] === null || args[k] === "");
  return missing.length === 0
    ? { ok: true }
    : {
      ok: false,
      reason: `missing required argument(s): ${missing.join(", ")} — an underspecified request is rejected `
        + "rather than interpreted (PLAN.md section 16)",
    };
}

/**
 * The decision.
 *
 * @param {{
 *   principal: { id, kind, capabilities: string[], revokedAt?: string|null } | null,
 *   command: string,
 *   args?: object,
 *   approval?: { id, action, argsSha256, forPrincipal, expiresAt, consumedAt } | null,
 *   now?: string,
 * }} input
 *
 * @returns {{ ok: boolean, capability?: string, reason?: string, sensitive?: boolean, needsApproval?: boolean }}
 *
 * Returns a REASON on refusal for the same purpose the review rule does: a denial that does not say what was
 * missing produces a support question rather than a fix. It never says "invalid token" versus "unknown
 * principal" though — that distinction is only useful to someone guessing tokens.
 */
export function authorize({ principal, command, args = {}, approval = null, now = new Date().toISOString() } = {}) {
  if (!command) return { ok: false, reason: "no command" };
  const capability = COMMAND_CAPABILITIES[command];
  if (!capability) {
    // FAIL CLOSED. See COMMAND_CAPABILITIES' note: an unmapped command is unreachable rather than public.
    return { ok: false, reason: `command "${command}" declares no required capability, so it is refused` };
  }
  if (!principal) return { ok: false, capability, reason: `"${command}" requires capability "${capability}" and the request carries no valid principal` };
  if (principal.revokedAt) return { ok: false, capability, reason: `principal ${principal.id} was revoked at ${principal.revokedAt}` };

  const held = new Set(principal.capabilities ?? []);
  if (!held.has(capability)) {
    return {
      ok: false,
      capability,
      reason: `principal ${principal.id} (${principal.kind}) does not hold "${capability}"`,
    };
  }

  if (!isSensitive(capability)) return { ok: true, capability, sensitive: false };

  // ── the enumerated sensitive class ────────────────────────────────────────────────────
  const hash = argsHash(args);
  if (!approval) {
    return {
      ok: false,
      capability,
      sensitive: true,
      needsApproval: true,
      reason: `"${capability}" is in the sensitive class and needs a second principal's approval for these exact `
        + `arguments (args ${hash.slice(0, 12)}) — PLAN.md section 16`,
    };
  }
  if (approval.action !== capability || approval.argsSha256 !== hash) {
    // The binding, and the reason it exists: an approval for one act must not authorise another.
    return {
      ok: false,
      capability,
      sensitive: true,
      needsApproval: true,
      reason: `the supplied approval is for ${approval.action} on args ${String(approval.argsSha256).slice(0, 12)}, `
        + `not ${capability} on args ${hash.slice(0, 12)}`,
    };
  }
  if (approval.forPrincipal !== principal.id) {
    return { ok: false, capability, sensitive: true, reason: "that approval was granted to a different principal" };
  }
  if (approval.consumedAt) {
    return { ok: false, capability, sensitive: true, reason: `that approval was already used at ${approval.consumedAt}` };
  }
  if (approval.expiresAt && approval.expiresAt <= now) {
    // Expiry is not bureaucracy: a decision made about a diff that has since changed is not a current
    // decision, which is the same reasoning that makes review verdicts revision-bound (§13).
    return { ok: false, capability, sensitive: true, reason: `that approval expired at ${approval.expiresAt}` };
  }
  return { ok: true, capability, sensitive: true, approvalId: approval.id };
}

/**
 * Can this principal grant an approval for that one?
 *
 * Two rules, both from section 16: the granter must hold `approve:sensitive`, and **self-approval is refused**
 * — "no skip-level authority grants" is meaningless if the level can be its own. Stated as its own function
 * because it is the check most likely to be skipped by a caller in a hurry.
 */
export function canGrantApproval({ granter, forPrincipal }) {
  if (!granter) return { ok: false, reason: "no granting principal" };
  if (granter.revokedAt) return { ok: false, reason: `principal ${granter.id} was revoked` };
  if (!(granter.capabilities ?? []).includes("approve:sensitive")) {
    return { ok: false, reason: `principal ${granter.id} does not hold "approve:sensitive"` };
  }
  if (granter.id === forPrincipal) {
    return { ok: false, reason: "a principal cannot approve its own sensitive action (PLAN.md section 16: no skip-level authority grants)" };
  }
  return { ok: true };
}

/**
 * Every command in a handler map has a declared capability.
 *
 * Exported for the test that enforces it. The same shape as the wire suite's coverage probe (FINDINGS §32):
 * enumerate what exists and assert the policy covers it, so adding a command without deciding its authority is
 * a failing test rather than a silent hole.
 */
export function assertCoversCommands(commandNames) {
  const missing = [...commandNames].filter((c) => !COMMAND_CAPABILITIES[c]);
  const stale = Object.keys(COMMAND_CAPABILITIES).filter((c) => ![...commandNames].includes(c));
  return { ok: missing.length === 0, missing, stale };
}
