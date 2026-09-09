// capabilities.test.js — PLAN.md section 16's capability-based authorization, pure. Phase 7.
//
// WHY THESE CASES EXIST IN THIS SHAPE. The Phase 6 review found three defects of one family: a mechanism built,
// documented, and never consulted, with the inputs its decision depended on taken from the caller
// (`runtime/FINDINGS.md` §37.10). Authorization is that same shape with worse consequences, so the two
// properties that matter are asserted directly rather than assumed:
//
//   * **it fails closed** — an unmapped command is refused, not allowed (case 3)
//   * **nothing the decision reads comes from the request** — the capability set is a property of the principal
//     object, which a caller cannot construct, and a sensitive approval is bound to the exact arguments
//     (cases 5, 6)
//
// Cases:
//   1. the capability vocabulary is closed, and a wildcard is refused outright
//   2. a principal without the capability is refused, and the refusal names what was missing
//   3. it FAILS CLOSED: a command with no declared capability is refused
//   4. a revoked principal is refused, and says when it was revoked
//   5. the sensitive class needs an approval BOUND TO THE ARGUMENTS — wrong args, wrong principal, spent or
//      expired are all refused
//   6. `argsHash` ignores the wire envelope and is stable under key order
//   7. `requireArgs` rejects an underspecified request rather than interpreting it
//   8. `canGrantApproval` needs `approve:sensitive` and refuses SELF-approval
//   9. the presets are fixed toolsets: a worker holds no utility capability, a reviewer cannot approve, the
//      CTO holds no git or slack capability
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import {
  CAPABILITIES, SENSITIVE, PRESETS, COMMAND_CAPABILITIES,
  isCapability, isSensitive, validateCapabilities, authorize, canGrantApproval, argsHash, requireArgs,
  assertCoversCommands,
} from "../capabilities.js";

let failed = 0;
let n = 0;
function testCase(name, fn) {
  n += 1;
  try { fn(); console.log(`  ${n}. ${name}`); } catch (err) {
    failed += 1;
    console.error(`  FAIL: ${name}`);
    console.error(err);
  }
}

const principal = (caps, extra = {}) => ({ id: "p-1", kind: "worker", capabilities: caps, revokedAt: null, ...extra });
const NOW = "2026-09-09T00:00:00.000Z";

// ── 1 ────────────────────────────────────────────────────────────────────────────────────
testCase("the capability vocabulary is closed, and a wildcard is refused", () => {
  assert.ok(CAPABILITIES.includes("run:start"));
  assert.equal(isCapability("run:launch"), false, "a near-miss is not a capability");
  assert.deepEqual(validateCapabilities(["read:registry", "run:start"]).problems, []);
  assert.match(validateCapabilities(["read:registry", "run:lunch"]).problems.join(" "), /unknown capability/,
    "a typo must be caught at mint time — a set that silently grants nothing is worse than a refusal");
  // Section 16 keeps toolsets FIXED. A wildcard is how that erodes in one commit, so it is not merely absent
  // from the vocabulary; it is named and refused.
  assert.match(validateCapabilities(["*"]).problems.join(" "), /"\*" is not a capability/);
  assert.equal(validateCapabilities("read:registry").ok, false, "and a bare string is not a set");
});

// ── 2 ────────────────────────────────────────────────────────────────────────────────────
testCase("a principal without the capability is refused, and the refusal names it", () => {
  const ok = authorize({ principal: principal(["run:start"]), command: "start", now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.capability, "run:start");

  const no = authorize({ principal: principal(["read:registry"]), command: "start", now: NOW });
  assert.equal(no.ok, false);
  assert.match(no.reason, /does not hold "run:start"/,
    "a denial that does not say what was missing produces a support question rather than a fix");
  // An absent principal is refused too, and names the capability it would have needed.
  const anon = authorize({ principal: null, command: "list", now: NOW });
  assert.equal(anon.ok, false);
  assert.match(anon.reason, /requires capability "read:registry"/);
  assert.match(anon.reason, /no valid principal/);
});

// ── 3 ────────────────────────────────────────────────────────────────────────────────────
// The default that decides which way every future mistake falls.
testCase("it fails closed: an unmapped command is refused", () => {
  const held = principal([...CAPABILITIES]);
  const verdict = authorize({ principal: held, command: "someBrandNewCommand", now: NOW });
  assert.equal(verdict.ok, false, "an omnipotent principal is still refused a command nobody classified");
  assert.match(verdict.reason, /declares no required capability/);
  assert.equal(authorize({ principal: held, command: "", now: NOW }).ok, false);

  // And the coverage check that keeps the map honest as commands are added.
  const cover = assertCoversCommands(["list", "start"]);
  assert.equal(cover.ok, true);
  assert.deepEqual(assertCoversCommands(["list", "notMapped"]).missing, ["notMapped"]);
});

// ── 4 ────────────────────────────────────────────────────────────────────────────────────
testCase("a revoked principal is refused, and says when", () => {
  const revoked = principal([...CAPABILITIES], { revokedAt: "2026-09-08T10:04:00.000Z" });
  const verdict = authorize({ principal: revoked, command: "start", now: NOW });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /revoked at 2026-09-08T10:04/,
    "'revoked at 10:04' and 'no such principal' are different facts, and only one of them is actionable");
});

// ── 5 ────────────────────────────────────────────────────────────────────────────────────
// THE SENSITIVE CLASS. Holding the capability is necessary and not sufficient — that is the whole difference
// between "this agent may push" and "this agent may push THIS".
testCase("a sensitive action needs an approval bound to the exact arguments", () => {
  assert.deepEqual(SENSITIVE, ["git:push-protected", "slack:post-as-user", "task:merge"]);
  assert.equal(isSensitive("git:push"), false, "an ordinary push is not in the class");

  // A MAPPED sensitive command, so this case cannot skip the branch it is named for. The first version looked
  // up "any command whose capability is sensitive" and wrapped the whole binding test in `if (command)` — and
  // no command was mapped to one yet, so the entire block was skipped and the case passed having tested
  // nothing. That is §37.10's family of defect appearing in a test written to prevent it, one file later; it
  // was caught by reading the case back rather than by running it, which is exactly the problem.
  const command = "mergeTask";
  const cap = COMMAND_CAPABILITIES[command];
  assert.equal(isSensitive(cap), true, `precondition: ${command} must require a sensitive capability`);

  const holder = principal([cap], { id: "p-h", kind: "cto" });
  const cmdArgs = { taskId: "t-1" };
  const cmdHash = argsHash(cmdArgs);
  const base = { id: "sa-1", action: cap, argsSha256: cmdHash, forPrincipal: "p-h", expiresAt: "2026-09-09T01:00:00.000Z", consumedAt: null };

  const needs = authorize({ principal: holder, command, args: cmdArgs, now: NOW });
  assert.equal(needs.ok, false, "holding the capability is not enough");
  assert.equal(needs.needsApproval, true, "and the refusal SAYS an approval is what is missing, so a caller can ask for one");
  assert.match(needs.reason, /second principal's approval/);
  assert.equal(authorize({ principal: holder, command, args: cmdArgs, approval: base, now: NOW }).ok, true);

  // BOUND TO THE ARGUMENTS. Without this the gate is a one-time coupon rather than a decision about a
  // specific act: an approval to merge t-1 would merge anything.
  const other = authorize({ principal: holder, command, args: { taskId: "t-2" }, approval: base, now: NOW });
  assert.equal(other.ok, false);
  assert.match(other.reason, /not task:merge on args/, "approving the merge of t-1 must not merge t-2");

  // ...to THIS principal, once, and only while it is current.
  const someoneElse = authorize({ principal: principal([cap], { id: "p-other" }), command, args: cmdArgs, approval: base, now: NOW });
  assert.equal(someoneElse.ok, false);
  assert.match(someoneElse.reason, /granted to a different principal/);
  assert.match(authorize({ principal: holder, command, args: cmdArgs, approval: { ...base, consumedAt: NOW }, now: NOW }).reason, /already used/);
  assert.match(authorize({ principal: holder, command, args: cmdArgs, approval: { ...base, expiresAt: "2026-09-08T23:00:00.000Z" }, now: NOW }).reason, /expired/);
  assert.match(authorize({ principal: holder, command, args: cmdArgs, approval: { ...base, action: "slack:post-as-user" }, now: NOW }).reason, /not task:merge/);

  // An unmapped command is refused BEFORE any of that, which is why a capability that has no command yet
  // (`git:push-protected`, waiting on Phase 7's git agent) cannot be reached at all.
  const gitAgent = principal(["git:push-protected"], { id: "p-git", kind: "utility" });
  const unmapped = authorize({ principal: gitAgent, command: "gitPushProtected", args: { branch: "main" }, now: NOW });
  assert.equal(unmapped.ok, false);
  assert.match(unmapped.reason, /declares no required capability/,
    "the capability exists, the command does not, and fail-closed means the answer is still no");
  assert.equal(argsHash({ branch: "main" }).length, 64, "and the hash is a full sha256, so two argument sets do not collide by truncation");
});

// ── 6 ────────────────────────────────────────────────────────────────────────────────────
testCase("argsHash ignores the wire envelope and is stable under key order", () => {
  assert.equal(argsHash({ a: 1, b: 2 }), argsHash({ b: 2, a: 1 }), "key order is not identity");
  // `id` is the wire's correlation id, not an argument. Including it would make every request unique, which
  // would silently defeat BOTH the approval binding and section 16's "did I already file this ticket".
  assert.equal(argsHash({ id: "req-1", cmd: "x", token: "secret", taskId: "t" }), argsHash({ id: "req-2", cmd: "y", token: "other", taskId: "t" }),
    "the envelope is excluded, or an approval could never match a second request");
  assert.notEqual(argsHash({ taskId: "t-1" }), argsHash({ taskId: "t-2" }), "but the arguments themselves are identity");
  assert.notEqual(argsHash({}), argsHash({ taskId: "t" }));
  // A token must never be part of the hash, since journal rows carry it and the journal is read by people.
  assert.equal(argsHash({ token: "sekrit" }), argsHash({}));
});

// ── 7 ────────────────────────────────────────────────────────────────────────────────────
// Section 16: "a request missing a team/task is rejected back to the caller, not interpreted charitably."
testCase("requireArgs rejects an underspecified request rather than interpreting it", () => {
  assert.equal(requireArgs({ taskId: "t" }, ["taskId"]).ok, true);
  const missing = requireArgs({ taskId: "t" }, ["taskId", "branch"]);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /missing required argument\(s\): branch/);
  assert.match(missing.reason, /rather than interpreted/, "and says why, because charity is every model's default");
  // Empty string and null count as missing: "" is what a UI sends for an untouched field.
  assert.equal(requireArgs({ taskId: "" }, ["taskId"]).ok, false);
  assert.equal(requireArgs({ taskId: null }, ["taskId"]).ok, false);
  assert.equal(requireArgs({ taskId: 0 }, ["taskId"]).ok, true, "but 0 is a value, not an absence");
});

// ── 8 ────────────────────────────────────────────────────────────────────────────────────
testCase("granting an approval needs approve:sensitive, and self-approval is refused", () => {
  const owner = principal(["approve:sensitive"], { id: "p-owner", kind: "human" });
  assert.equal(canGrantApproval({ granter: owner, forPrincipal: "p-git" }).ok, true);

  const agent = principal(["git:push-protected"], { id: "p-git" });
  const noAuthority = canGrantApproval({ granter: agent, forPrincipal: "p-other" });
  assert.equal(noAuthority.ok, false, "holding a sensitive capability does not let you approve one");
  assert.match(noAuthority.reason, /does not hold "approve:sensitive"/);

  // THE RULE THAT MAKES "no skip-level authority grants" MEAN ANYTHING. The CTO holds both `task:merge` and
  // `approve:sensitive`, so without this it would nod at its own merges and §6's "explicit human approval
  // gate" would be the CTO agreeing with itself.
  //
  // This assertion went MISSING once: an edit spliced the sensitive-binding block into this case and dropped
  // it, and mutation A5 (remove the self-approval check) then survived — the harness caught what reading the
  // file did not.
  const self = canGrantApproval({ granter: owner, forPrincipal: "p-owner" });
  assert.equal(self.ok, false, "a principal must not be able to approve its own sensitive action");
  assert.match(self.reason, /cannot approve its own/);
  assert.match(self.reason, /no skip-level authority grants/, "and cites the rule, because it looks like an inconvenience");

  const revoked = canGrantApproval({ granter: { ...owner, revokedAt: NOW }, forPrincipal: "p-git" });
  assert.equal(revoked.ok, false);
  assert.match(revoked.reason, /revoked/);
  assert.equal(canGrantApproval({ granter: null, forPrincipal: "p-git" }).ok, false, "and there is no granting without a granter");
});

// ── 9 ────────────────────────────────────────────────────────────────────────────────────
// Section 16's "fixed toolsets", asserted rather than trusted: "a jira-automation agent never picks up git
// access 'just this once'", and the reason utility agents exist at all is that the capability to push code or
// post to Slack "isn't duplicated into every worker's toolset".
testCase("the presets are fixed toolsets", () => {
  for (const [name, caps] of Object.entries(PRESETS)) {
    assert.deepEqual(validateCapabilities([...caps]).problems, [], `${name}'s set is valid`);
    assert.equal(caps.includes("*"), false);
  }
  const worker = PRESETS.worker;
  for (const forbidden of ["run:start", "git:push", "jira:create", "slack:post-bot", "task:approve", "principal:mint"]) {
    assert.equal(worker.includes(forbidden), false, `a worker must not hold ${forbidden} — that is why utility agents exist`);
  }
  assert.equal(PRESETS.reviewer.includes("review:record"), true, "a reviewer may record verdicts…");
  assert.equal(PRESETS.reviewer.includes("task:approve"), false, "…and may not approve the task: §13's rule approves it, and one reviewer is not a quorum");

  // The CTO delegates side effects (§16), so it holds none of them itself.
  for (const forbidden of ["git:push", "git:push-protected", "jira:create", "slack:post-bot", "slack:post-as-user", "principal:mint"]) {
    assert.equal(PRESETS.cto.includes(forbidden), false, `the CTO delegates ${forbidden} rather than holding it`);
  }
  assert.equal(PRESETS.cto.includes("approve:sensitive"), true, "but it does hold the second signature");

  // ONE DOMAIN EACH, asserted as an allow-list rather than as selected exclusions. The first version checked
  // the worker comprehensively and the others only for a few forbidden strings, so a reviewer could have
  // gained `git:push` — or `utility:jira` `slack:post-bot` — without either suite noticing. Named by the
  // Phase 7 review (sol), and it is the difference between "these three are absent" and "only these are
  // present": a fixed toolset is a statement about the whole set.
  const ALLOWED_DOMAINS = {
    worker: ["read", "ask"],
    reviewer: ["read", "observe", "review"],
    "utility:git": ["read", "git"],
    "utility:jira": ["read", "jira"],
    "utility:slack": ["read", "slack"],
    // The CTO runs the dashboard and delegates side effects, so it may hold registry and lifecycle domains and
    // NOT `git:` or `slack:` — which the loop below enforces rather than a hand-listed exclusion.
    cto: ["read", "observe", "run", "ask", "task", "harness", "session", "approve"],
  };
  for (const [name, domains] of Object.entries(ALLOWED_DOMAINS)) {
    for (const cap of PRESETS[name]) {
      const domain = cap.split(":")[0];
      assert.ok(domains.includes(domain),
        `${name} holds ${cap}, whose domain "${domain}" is outside its fixed toolset (${domains.join(", ")})`);
    }
  }
  // The owner is the deliberate exception: it holds everything, which is why it is the only principal that can
  // grow authority (`principal:mint`).
  assert.deepEqual([...PRESETS.owner].sort(), [...CAPABILITIES].sort());
  assert.equal(PRESETS["utility:slack"].includes("slack:post-as-user"), false,
    "as-user posting stays out of the preset while §14.5's identity binding is backlog — v1 posts as the bot only");
  // Only the owner holds everything, and only the owner and the CTO hold the second signature.
  const withApproval = Object.entries(PRESETS).filter(([, caps]) => caps.includes("approve:sensitive")).map(([k]) => k);
  assert.deepEqual(withApproval.sort(), ["cto", "owner"]);
});

if (failed > 0) {
  console.error(`\n${failed} capability case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: capability-based authorization (pure)");
