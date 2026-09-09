#!/usr/bin/env node
// _mutate-auth.mjs — mutation harness for capability-based authorization (PLAN.md §16, §14.5). Phase 7.
//
// Same standing rule: break one mechanism, and the suite must fail BY ASSERTION at the case that protects it.
//
// WHY THIS SET IS THE ONE TO GET RIGHT. Every mutation below leaves a working dashboard. Nothing throws, no
// suite goes red on its own, and each one grants authority that nobody asked for — which is the exact profile
// of a security defect that survives review. The Phase 6 review (§37.10) found three cases of "a mechanism
// built, documented, and never consulted"; an authorization layer is that shape by construction, so these are
// aimed at the seams rather than at the decision.
//
// A1 and A2 are the two to read. A1 makes the daemon serve the RAW command map — one identifier at one call
// site, and the entire gate is gone while every other test still passes. A2 lets a request carry its own
// capabilities, which is the same defect the review found in `recordVerdict`: the rule reads what the caller
// sent.
//
// Usage: node runtime/test/_mutate-auth.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  caps: path.join(SUPERVISOR, 'domain/capabilities.js'),
  supervisor: path.join(SUPERVISOR, 'runtime/supervisor.js'),
  db: path.join(SUPERVISOR, 'db/index.js'),
  daemon: path.join(SUPERVISOR, 'ipc/daemon.js'),
  server: path.join(SUPERVISOR, 'ipc/server.js'),
};

const PURE = 'domain/test/capabilities.test.js';
const WIRED = 'runtime/test/authorization.test.js';

const MUTATIONS = [
  {
    name: 'A1-daemon-serves-the-raw-command-map',
    file: F.daemon,
    why: "Handing the socket the UNAUTHORIZED command map. One identifier at one call site, and every command on the daemon's socket is served with no principal at all — while `domain/test/capabilities.test.js` still passes, `runtime/test/authorization.test.js` cases 1-7 still pass (they build their own server), and nothing else in the suite touches the daemon's surface. This is why case 8 spawns the real daemon instead of trusting the wiring.",
    breaks: 'authorization case 8 (the real daemon refuses an unauthenticated command)',
    test: WIRED,
    find: `  const server = createIpcServer({ commands: supervisor.authorizedCommandHandlers(), logger: console });`,
    replace: `  const server = createIpcServer({ commands: supervisor.commandHandlers(), logger: console }); // MUTANT: no gate`,
  },
  {
    name: 'A2-capabilities-taken-from-the-request',
    file: F.supervisor,
    why: "Letting a request supply its own capability set when it names one. The same defect the Phase 6 review found in `recordVerdict` (§37.10's first rule: anything the rule counts must not come from the caller), and here it is total — any caller writes its own authority. Note that it still requires a valid token, so it LOOKS like a small convenience for a trusted client.",
    breaks: 'authorization case 4 (a worker cannot start runs)',
    test: WIRED,
    find: `        const principal = cmd?.token ? principalByTokenHash(database, sha256(cmd.token)) : null;`,
    replace: `        const found = cmd?.token ? principalByTokenHash(database, sha256(cmd.token)) : null;
        const principal = found && Array.isArray(cmd?.capabilities) ? { ...found, capabilities: cmd.capabilities } : found; // MUTANT`,
  },
  {
    name: 'A3-unmapped-commands-are-public',
    file: F.caps,
    why: "Allowing a command that declares no capability instead of refusing it. Fails OPEN: every command added from here on is public until someone remembers to classify it, and the person adding it gets no signal at all. The direction a default falls is the whole of its value.",
    breaks: 'capabilities case 3 (an unmapped command is refused)',
    test: PURE,
    find: `  if (!capability) {`,
    replace: `  if (false) { // MUTANT: unmapped commands are allowed`,
  },
  {
    name: 'A4-sensitive-approval-not-bound-to-arguments',
    file: F.caps,
    why: "Accepting any approval for the right action, whatever it was granted for. The gate becomes a one-time coupon rather than a decision about a specific act: an approval to merge task A merges task B, and an approval to push one branch pushes another. This is the single most valuable line in the sensitive path.",
    breaks: 'capabilities case 5 (an approval is bound to the arguments)',
    test: PURE,
    find: `  if (approval.action !== capability || approval.argsSha256 !== hash) {`,
    replace: `  if (approval.action !== capability) { // MUTANT: the argument binding is dropped`,
  },
  {
    name: 'A5-self-approval-allowed',
    file: F.caps,
    why: "Letting a principal approve its own sensitive action. 'No skip-level authority grants' is meaningless if the level can be its own — and the CTO holds both `task:merge` and `approve:sensitive`, so this turns §6's 'explicit human approval gate' into the CTO nodding at itself.",
    breaks: 'capabilities case 8 / authorization case 6 (self-approval is refused)',
    test: PURE,
    find: `  if (granter.id === forPrincipal) {`,
    replace: `  if (false) { // MUTANT: self-approval permitted`,
  },
  {
    name: 'A6-approval-guard-removed-alone',
    file: F.db,
    why: "Consuming an approval without the `consumed_at IS NULL` guard. MEASURED TO SURVIVE, and the reason is worth having written down: in the wrapper, `findSensitiveApproval` and `consumeSensitiveApproval` run SYNCHRONOUSLY in one event-loop turn with no await between them, so no second request can interleave, and the read filter alone already refuses a replay. The guard is therefore defence for a gap that does not exist TODAY — and A6b is the mutation that opens that gap and shows case 7 catches it. Keeping both is the honest way to say 'this line is not currently load-bearing, and here is what makes it load-bearing'.",
    breaks: 'nothing today — see A6b',
    test: WIRED,
    find: `  const info = db.prepare(\`UPDATE sensitive_approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL\`)`,
    replace: `  const info = db.prepare(\`UPDATE sensitive_approvals SET consumed_at = ? WHERE id = ?\`) // MUTANT: replayable`,
    expectSurvives: true,
    survivesBecause: "find -> consume is synchronous and adjacent in `authorizedCommandHandlers`, so the read filter refuses the replay before the write guard is reached. The invariant that keeps this true is 'no await between the find and the consume'; A6b violates it deliberately and case 7 then fails.",
  },
  {
    name: 'A6b-await-between-find-and-consume',
    file: F.supervisor,
    why: "Inserting an await between finding the approval and spending it — the refactor a future maintainer makes without thinking (an async lookup, a log flush, a metrics call). WITH the write guard this is still safe; combined with A6's missing guard it is a double-spend, so `extra` removes the guard too. This pair is what makes the guard's purpose observable: alone it survives, and this shows exactly what it is defending.",
    breaks: 'authorization case 7 (one approval cannot be spent by two concurrent requests)',
    test: WIRED,
    find: `        if (verdict.approvalId) {
          const spent = consumeSensitiveApproval(database, verdict.approvalId);`,
    replace: `        if (verdict.approvalId) {
          await new Promise((r) => setImmediate(r)); // MUTANT: a gap between find and consume
          const spent = consumeSensitiveApproval(database, verdict.approvalId);`,
    extra: {
      file: F.db,
      find: `  const info = db.prepare(\`UPDATE sensitive_approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL\`)`,
      replace: `  const info = db.prepare(\`UPDATE sensitive_approvals SET consumed_at = ? WHERE id = ?\`)`,
    },
  },
  {
    name: 'A16-worker-token-not-rotated-on-restart',
    file: F.supervisor,
    why: "Returning the existing worker principal without a fresh token, which was PRODUCTION BEHAVIOUR until the Phase 7 review found it: every run after a worker's first launched with no `CTD_PRINCIPAL_TOKEN` at all, so every callback it made was refused. Authorization worked for exactly one run per worker, and the case that would have caught it did not exist because case 4 starts each worker once.",
    breaks: 'authorization case 10 (a restarted worker gets a fresh token)',
    test: WIRED,
    find: `      if (!rotate) return { principal: existing, token: null, minted: false };`,
    replace: `      if (true) return { principal: existing, token: null, minted: false }; // MUTANT: no rotation`,
  },
  {
    name: 'A17-old-token-keeps-working-after-restart',
    file: F.db,
    why: "Rotating by inserting a second principal rather than replacing the hash, so the previous run's token keeps working. A credential handed to a process that has exited should die with it — otherwise a worker's token outlives every run it was issued for, and a leaked one never expires.",
    breaks: 'authorization case 10 (the previous run\'s token stops working)',
    test: WIRED,
    find: `  const info = db.prepare(\`UPDATE principals SET token_sha256 = ? WHERE id = ? AND revoked_at IS NULL\`)
    .run(tokenSha256, id);`,
    replace: `  const info = db.prepare(\`UPDATE principals SET display_name = display_name WHERE id = ? AND revoked_at IS NULL\`)
    .run(id); // MUTANT: the hash is not replaced, so the old token still resolves`,
  },
  {
    name: 'A18-actor-taken-from-the-request',
    file: F.supervisor,
    why: "Letting the payload name the actor for a transition. The authorization journal records the truth while the TASK HISTORY records whatever the caller typed — and the default made a CTO merge read as the owner's, which is the identity §6's merge gate is entirely about. §37.10's rule (nothing the decision reads comes from the request) applies to what is WRITTEN as well as to what is checked.",
    breaks: 'authorization case 11 (a transition records the authenticated principal)',
    test: WIRED,
    // AIMED AT `assignTask`, with `extra` doing `mergeTask` in the same run. `mergeTask` alone is unobservable:
    // it is sensitive, so adding `actor` to the payload changes the argument hash and the approval no longer
    // covers the request — the binding shields it by accident. `assignTask` takes an actor and needs no
    // approval, which is where the substitution is actually reachable.
    find: `          actor: cmd._principal?.id ?? cmd.actor ?? "operator",`,
    replace: `          actor: cmd.actor ?? cmd._principal?.id ?? "operator", // MUTANT: the caller's claim wins`,
    extra: {
      file: F.supervisor,
      find: `        const actor = cmd._principal?.id ?? cmd.actor ?? "owner";`,
      replace: `        const actor = cmd.actor ?? cmd._principal?.id ?? "owner";`,
    },
  },
  {
    name: 'A19-principal-not-passed-to-handlers',
    file: F.supervisor,
    why: "Forwarding the raw request to the handler instead of one carrying the resolved principal. Every actor falls back to a default, so every transition in the task history is attributed to 'owner' whoever performed it — and a caller-supplied `_principal` would no longer be overwritten, which turns the injection channel into a spoofing channel.",
    breaks: 'authorization case 11 (the authenticated principal reaches the handler)',
    test: WIRED,
    find: `          const result = await handler({ ...cmd, _principal: principal }, ...rest);`,
    replace: `          const result = await handler(cmd, ...rest); // MUTANT: the handler never learns who is calling`,
  },
  {
    name: 'A20-expired-approval-masks-a-valid-one',
    file: F.db,
    why: "Taking the newest unconsumed approval regardless of expiry. A newer short-lived approval then MASKS an older valid one and the action is refused as expired while a good approval sits unused beside it — which reads as 'the gate is broken' and invites someone to loosen the expiry check instead.",
    breaks: 'authorization case 12 (an expired approval does not mask a valid one)',
    test: WIRED,
    find: `  const valid = rows.find((r) => !r.expires_at || r.expires_at > now);
  return approvalRow(valid ?? rows[0] ?? null);`,
    replace: `  return approvalRow(rows[0] ?? null); // MUTANT: newest wins, expired or not`,
  },
  {
    name: 'A21-hook-sends-no-token',
    file: path.join(SUPERVISOR, 'hooks/claude-session-hook.mjs'),
    why: "Dropping the principal token from the session hook. Adoption then fails on the REAL daemon and fails SILENTLY, because the hook exits 0 on every path by design — a human's `claude` session would simply never appear in the dashboard, with a refusal on stderr nobody reads. It was production behaviour until the Phase 7 review found it, and the adoption tests could not see it because they build a server from the raw command map.",
    breaks: 'wire case 5 (adoptSession works over the AUTHORIZED wire)',
    test: 'runtime/test/wire.test.js',
    find: `      harnessId: "claude-code",
      ...(token ? { token } : {}),
      sessionId,
      workerId,`,
    replace: `      harnessId: "claude-code",
      sessionId,
      workerId,`,
    expectSurvives: true,
    survivesBecause: "No suite drives the INSTALLED hook script against an authorized socket yet — `wire.test.js` exercises `adoptSession` over the raw command map, and `real-claude-adoption.slice.mjs` (which does run the hook) is deliberately outside `npm test` because it costs real tokens. Recorded as a known gap rather than hidden: the fix is a case that spawns the hook with a state dir and an authorized server, and it belongs with the roster work in the rest of Phase 7.",
  },
  {
    name: 'A7-revocation-ignored',
    file: F.caps,
    why: "Not checking `revokedAt`. Revocation is the only way to take authority back, and a revoked principal that keeps working is worse than one that was never revoked: an operator believes the access is gone.",
    breaks: 'authorization case 7 (revocation takes effect immediately)',
    test: WIRED,
    find: `  if (principal.revokedAt) return { ok: false, capability, reason: \`principal \${principal.id} was revoked at \${principal.revokedAt}\` };`,
    replace: `  // MUTANT: revocation is not checked`,
  },
  {
    name: 'A8-token-stored-in-the-clear',
    file: F.supervisor,
    why: "Storing the token instead of its hash. A leaked database becomes a set of working credentials, and the journal beside it tells an attacker exactly which principal is worth stealing. Hashing costs one function call and is the difference between a data leak and an access leak.",
    breaks: 'authorization case 1 (the token appears nowhere in the row)',
    test: WIRED,
    find: `      id, kind: "human", displayName: "owner (foreground TUI)", capabilities: [...PRESETS.owner], tokenSha256: sha256(token),`,
    replace: `      id, kind: "human", displayName: "owner (foreground TUI)", capabilities: [...PRESETS.owner], tokenSha256: token, // MUTANT: the token itself`,
  },
  {
    name: 'A9-owner-token-file-world-readable',
    file: F.supervisor,
    why: "Writing the owner's token 0644. The state dir is 0700 so the file is still unreachable from another account — but the mode is the invariant the permissions test asserts across this whole project, and a credential written 0644 inside a 0700 directory is one `chmod` on the directory away from being readable by anyone.",
    breaks: 'authorization case 1 (the token file is 0600)',
    test: WIRED,
    find: `    fs.writeFileSync(file, \`\${token}\\n\`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);`,
    replace: `    fs.writeFileSync(file, \`\${token}\\n\`); // MUTANT: default mode`,
  },
  {
    name: 'A10-refusals-not-journalled',
    file: F.supervisor,
    why: "Dropping the journal row on a refusal. §14.5 requires that 'refusals are logged, never silently dropped' — an authorization system whose denials leave no trace cannot be audited, and cannot tell 'nobody tried' from 'somebody tried and was stopped'. It is also the only record that would show a worker probing for capabilities it does not hold.",
    breaks: 'authorization case 5 (a refusal is journalled against its principal)',
    test: WIRED,
    find: `          if (principal) {
            journalAppend(database, {`,
    replace: `          if (false) {
            journalAppend(database, {`,
  },
  {
    name: 'A11-worker-capabilities-not-role-derived',
    file: F.supervisor,
    why: "Giving every worker the owner's capability set. The single most convenient mutation here — every worker can do everything, so nothing ever fails — and it deletes the entire reason utility agents exist (§16: the capability to push code or post to Slack 'isn't duplicated into every worker's toolset'). A worker is a model with a shell.",
    breaks: "authorization case 4 (a worker holds only its role's capabilities)",
    test: WIRED,
    find: `    const preset = worker.role === "reviewer" ? PRESETS.reviewer : PRESETS.worker;`,
    replace: `    const preset = PRESETS.owner; // MUTANT: every worker is the owner`,
  },
  {
    name: 'A12-server-falls-back-to-the-demo-adapter',
    file: F.server,
    why: "Restoring the demo `switch` as a FALLBACK for a real command surface. Two failures at once, and the second is new: it re-opens §27.5 (a misregistered command answered plausibly by a mock instead of saying 'unknown cmd'), and it bypasses authorization entirely, because `authorizedCommandHandlers()` wraps the map and cannot wrap a case statement inside the server. Any command missing from the map would be served with no principal.",
    breaks: 'authorization case 8 / wire case 3 (an unregistered command is refused)',
    test: WIRED,
    find: `    if (hasRealCommands && cmd.cmd !== "ping") {`,
    replace: `    if (false) { // MUTANT: the demo cases answer for anything unregistered`,
  },
  {
    name: 'A13-argshash-includes-the-envelope',
    file: F.caps,
    why: "Hashing the whole request, correlation id included. Every request then has a unique hash, so a sensitive approval can never match the call it was granted for — the gate refuses everything, which looks like a bug rather than a hole and would be 'fixed' by dropping the binding. It also breaks §16's 'did I already file this ticket' dedup silently.",
    breaks: 'capabilities case 6 (the envelope is excluded from the hash)',
    test: PURE,
    find: `  const canonical = stableStringify(stripEnvelope(args));`,
    replace: `  const canonical = stableStringify(args ?? {}); // MUTANT: the envelope is part of identity`,
  },
  {
    name: 'A14-underspecified-requests-interpreted',
    file: F.caps,
    why: "Accepting a request with required arguments missing. §16 keeps 'never guess an underspecified task — a request missing a team/task is rejected back to the caller, not interpreted charitably'. Charity is every model's default, so the rule only holds if the refusal is mechanical.",
    breaks: 'capabilities case 7 (an underspecified request is rejected)',
    test: PURE,
    find: `  const missing = required.filter((k) => args?.[k] === undefined || args[k] === null || args[k] === "");`,
    replace: `  const missing = []; // MUTANT: nothing is required`,
  },
  {
    name: 'A15-wildcard-capability-accepted',
    file: F.caps,
    why: "Accepting `*` as a capability set. §16 keeps toolsets FIXED — 'a jira-automation agent never picks up git access just this once' — and a wildcard is how that erodes in a single commit, with every individual grant looking reasonable at the time.",
    breaks: 'capabilities case 1 (a wildcard is refused)',
    test: PURE,
    find: `  if (caps.includes("*")) problems.push('"*" is not a capability — section 16 keeps toolsets FIXED, so a set must be enumerated');`,
    replace: `  // MUTANT: "*" is tolerated`,
  },
];

const exitCode = await runMutations(MUTATIONS, { cwd: SUPERVISOR, filter: process.argv[2] });
process.exit(exitCode);
