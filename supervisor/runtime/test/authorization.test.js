// authorization.test.js — capability-based authorization WIRED IN (PLAN.md §16, §14.5; migration 0010). Phase 7.
//
// `domain/test/capabilities.test.js` proves the decision without a database. This proves the things it cannot:
// that a principal exists to be resolved, that the SOCKET refuses a request without one, that a worker's
// principal is minted with role-derived capabilities and delivered in its child environment, that every
// outcome is journalled, and that the sensitive class really needs a second signature bound to the arguments.
//
// THE CASE THAT MATTERS MOST is 8: the real `ipc/daemon.js`, spawned as a process, refusing an unauthenticated
// command over its own socket. Everything above it could be true while the daemon still handed out the raw
// command map — which is exactly the shape of defect the Phase 6 review found three times (§37.10: a mechanism
// built, documented, and never consulted). `commandHandlers()` versus `authorizedCommandHandlers()` is one
// identifier's difference at one call site, and nothing but this case notices which one is there.
//
// Cases:
//   1. boot mints the owner principal, writes its token 0600, and is idempotent across boots
//   2. EVERY registered command has a declared capability — fail closed, self-maintaining
//   3. over a real socket: no token is refused, the owner's token is allowed
//   4. a worker's principal is role-derived, delivered in the child's env, and cannot start runs
//   5. the journal records allowed / refused / done, and an unauthenticated refusal has no principal to blame
//   6. the sensitive class: `mergeTask` needs a second signature bound to these arguments, single-use
//   7. one approval cannot be spent by two CONCURRENT requests — the write guard, not the read filter
//   8. revocation takes effect on the next request, and says when it happened
//   9. THE REAL DAEMON refuses an unauthenticated command over its own socket
//  10. a RESTARTED worker gets a fresh token for the same identity, and its old token stops working
//  11. a transition records the AUTHENTICATED principal, not the `actor` a caller claims
//  12. an expired approval does not mask a valid one granted earlier
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  openDb, closeDb, upsertHarness, createWorker, createTask, recordTransition,
  listPrincipals, principalForWorker, listJournal, journalHasDone, getPrincipal,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createIpcServer } from "../../ipc/server.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { COMMAND_CAPABILITIES, assertCoversCommands, argsHash } from "../../domain/capabilities.js";
import { makeScratchDir, rmScratchDir, runTest, sleep, waitFor } from "./_helpers.js";
import { sockPath } from "../../paths.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function request(sock, cmd, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = "";
    const done = (fn, v) => { try { c.destroy(); } catch { /* gone */ } fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`timed out waiting for ${cmd.cmd}`)), timeoutMs);
    c.setEncoding("utf8");
    c.on("connect", () => c.write(`${JSON.stringify(cmd)}\n`));
    c.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      try { done(resolve, JSON.parse(buf.slice(0, nl))); } catch (e) { done(reject, e); }
    });
    c.on("error", (err) => { clearTimeout(timer); done(reject, err); });
  });
}

await runTest("capability-based authorization", async () => {
  const stateDir = makeScratchDir("supervisor-auth-test");
  let db;
  let supervisor;
  let ipc;
  const harnesses = [];
  let daemon = null;

  function makeSupervisor(opts = {}) {
    const fake = createFakeHarness({ label: "auth" });
    harnesses.push(fake);
    return createSupervisor({ db, stateDir, adapters: { fake }, askSweepIntervalMs: 0, logger: quiet, ...opts });
  }

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake" });
    createTask(db, { id: "t1", title: "auth", type: "chore" });
    createWorker(db, { workerId: "w-coder", nickname: "purus", role: "coder", taskId: "t1" });
    createWorker(db, { workerId: "w-rev", nickname: "luna", role: "reviewer", taskId: "t1" });

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    let ownerToken;
    {
      supervisor = makeSupervisor();
      const booted = await supervisor.boot();
      assert.ok(booted.owner?.id, "boot reports the owner principal it ensured");
      assert.equal(booted.owner.minted, true, "minted on a fresh state dir");

      const tokenFile = path.join(stateDir, "owner.token");
      assert.ok(fs.existsSync(tokenFile), "and wrote its token to the state dir");
      const mode = fs.statSync(tokenFile).mode & 0o777;
      assert.equal(mode, 0o600,
        `the token file is 0600 — it is the one file whose CONTENTS are a credential; got 0${mode.toString(8)}`);
      ownerToken = fs.readFileSync(tokenFile, "utf8").trim();
      assert.ok(ownerToken.length >= 32, "and the token is long enough not to be guessed");

      // The DATABASE holds only the hash. A leaked database must not be a set of working credentials.
      const rows = db.prepare("SELECT * FROM principals").all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].token_sha256.length, 64);
      assert.equal(JSON.stringify(rows).includes(ownerToken), false,
        "the token itself must appear nowhere in the row — only its sha256");

      // AND IT MUST NOT BE LOGGED. The first version proved only that the row has no plaintext token, so it
      // would have survived `logger.log(token)` — a credential in a log file is a credential, and this project's
      // logs are printed to a terminal and captured by tests. Named by the Phase 7 review (sol).
      const captured = [];
      const recording = createSupervisor({
        db, stateDir, adapters: { fake: createFakeHarness({ label: "logcheck" }) }, askSweepIntervalMs: 0,
        logger: { log: (...a) => captured.push(a.join(" ")), warn: (...a) => captured.push(a.join(" ")), error: (...a) => captured.push(a.join(" ")) },
      });
      await recording.boot();
      const rotated = recording.ensureWorkerPrincipal("w-rev", { rotate: true });
      const logText = captured.join("\n");
      assert.equal(logText.includes(ownerToken), false, "the owner's token must never reach the logger");
      if (rotated.token) {
        assert.equal(logText.includes(rotated.token), false, "and neither must a worker's");
      }
      assert.ok(logText.length > 0, "…and the logger was genuinely capturing, or this proves nothing");
      await recording.shutdown({ timeoutMs: 2000 });

      // Idempotent: a second boot must not mint a new owner, or a TUI holding the old token is locked out.
      const again = await supervisor.boot();
      assert.equal(again.owner.minted, false);
      assert.equal(again.owner.id, booted.owner.id);
      // HUMAN principals: the log-capture check above minted a worker principal for `w-rev`, and "no second
      // OWNER" is the claim that matters — a second owner would lock out whoever holds the first token.
      assert.equal(listPrincipals(db).filter((pr) => pr.kind === "human").length, 1,
        "and no second owner principal appeared");
      console.log("  1. boot minted the owner principal, token 0600, idempotent across boots");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    // Self-maintaining, and the same shape as the wire suite's coverage probe (§32): enumerate what EXISTS and
    // assert the policy covers it, so adding a command without deciding its authority is a failing test rather
    // than a silent hole. Fail-closed means such a command is refused — this case is what turns that from a
    // safe default into a noticed one.
    {
      const names = Object.keys(supervisor.commandHandlers());
      const cover = assertCoversCommands(names);
      assert.deepEqual(cover.missing, [],
        `every command must declare a required capability; undeclared: ${cover.missing.join(", ")}`);
      assert.deepEqual(cover.stale, [],
        `and the policy must not name commands that no longer exist: ${cover.stale.join(", ")}`);
      assert.ok(names.length >= 30, `expected the full surface; found ${names.length}`);
      console.log(`  2. all ${names.length} commands declare a capability, and the policy has no stale entries`);
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      ipc = createIpcServer({ commands: supervisor.authorizedCommandHandlers() });
      const sock = sockPath(stateDir);
      await ipc.listen(sock);

      const anon = await request(sock, { id: "a1", cmd: "list" });
      assert.equal(anon.ok, false, "a request with no token is refused");
      assert.equal(anon.refused, "unauthorized");
      assert.match(anon.error, /requires capability "read:registry"/, "and the refusal names what it needed");

      const bogus = await request(sock, { id: "a2", cmd: "list", token: "not-a-real-token" });
      assert.equal(bogus.ok, false, "and so is a wrong one");
      // Deliberately the SAME message: distinguishing "unknown token" from "no token" only helps someone
      // guessing tokens.
      assert.equal(bogus.error, anon.error);

      const ok = await request(sock, { id: "a3", cmd: "list", token: ownerToken });
      assert.equal(ok.ok, true, `the owner's token is allowed; got ${JSON.stringify(ok)}`);
      assert.ok(Array.isArray(ok.runs));
      console.log("  3. the socket refuses a request without a principal and serves one with it");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    {
      const { runId, principalId } = await supervisor.start({
        harnessId: "fake", workerId: "w-coder", spec: { cwd: stateDir, prompt: "auth test" },
      });
      assert.ok(principalId, "starting a run mints (or finds) the worker's principal");
      const wp = principalForWorker(db, "w-coder");
      assert.equal(wp.id, principalId);
      assert.equal(wp.kind, "worker");
      // ROLE-DERIVED, not request-derived: a coder holds neither `run:start` nor any utility capability, which
      // is §16's whole reason for utility agents existing.
      assert.deepEqual(wp.capabilities, ["read:registry", "ask:answer"]);
      const rev = supervisor.ensureWorkerPrincipal("w-rev");
      assert.ok(rev.principal.capabilities.includes("review:record"), "a reviewer may record verdicts…");
      assert.equal(rev.principal.capabilities.includes("task:approve"), false, "…and may not approve the task");

      // The token reaches the CHILD, through the one channel the supervisor controls.
      const child = harnesses[0]._runs?.get(runId) ?? null;
      assert.ok(child, "precondition: the fake harness kept the run");
      assert.ok(child.spec?.env?.CTD_PRINCIPAL_TOKEN, "the worker's token is in its spawn environment");
      assert.notEqual(child.spec.env.CTD_PRINCIPAL_TOKEN, ownerToken, "and it is NOT the owner's");

      // And it buys exactly what its role allows.
      const sock = sockPath(stateDir);
      const workerToken = child.spec.env.CTD_PRINCIPAL_TOKEN;
      const canRead = await request(sock, { id: "w1", cmd: "list", token: workerToken });
      assert.equal(canRead.ok, true, "a worker may read the registry");
      const cannotStart = await request(sock, {
        id: "w2", cmd: "start", token: workerToken, harnessId: "fake", workerId: "w-coder", spec: { cwd: stateDir },
      });
      assert.equal(cannotStart.ok, false, "and may not start runs");
      assert.match(cannotStart.error, /does not hold "run:start"/);
      const cannotObserve = await request(sock, { id: "w3", cmd: "tuiChat", token: workerToken, target: "w-coder", text: "hi" });
      assert.equal(cannotObserve.ok, false, "nor type at another worker");

      // AN EXPLICIT ESCALATION ATTEMPT. The capability set must come from the principal ROW, never from the
      // payload — §37.10's first rule. Without this request nothing exercises that: mutation A2 lets a caller
      // supply its own `capabilities` and every other assertion here still passed, because no test had ever
      // tried. The names are guesses at what a mutation would plausibly read.
      const escalation = await request(sock, {
        id: "w4", cmd: "start", token: workerToken, harnessId: "fake", workerId: "w-coder", spec: { cwd: stateDir },
        capabilities: ["run:start", "task:merge"], principal: { capabilities: ["run:start"] }, caps: ["run:start"],
      });
      assert.equal(escalation.ok, false,
        "a request that names its own capabilities must be refused exactly like one that does not — the decision reads the row, not the payload");
      assert.match(escalation.error, /does not hold "run:start"/);
      await supervisor.stop(runId);
      console.log("  4. a worker's principal is role-derived, delivered in its environment, and limited");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    // §14.5: "Refusals are logged, never silently dropped." A denial that leaves no trace cannot be audited and
    // cannot tell "nobody tried" from "somebody tried and was stopped".
    {
      const before = listJournal(db, { limit: 500 }).length;
      const sock = sockPath(stateDir);
      const wp = principalForWorker(db, "w-coder");
      // A fresh token for the same worker principal: case 4's run has been stopped, and a rotated token is what
      // a new run would get (see `ensureWorkerPrincipal`).
      const workerTokenForJournal = supervisor.ensureWorkerPrincipal("w-coder", { rotate: true }).token;
      await request(sock, { id: "j1", cmd: "orphans", token: ownerToken });
      const entries = listJournal(db, { limit: 500 });
      assert.ok(entries.length > before, "an allowed command is journalled");
      // ATTRIBUTED TO THE CALLER, which the first version did not check: it searched for any global
      // `read:registry` row and would have passed with every successful action journalled as the owner. Named
      // by the Phase 7 review (sol). The owner made this request, so the owner's id is what must be on it.
      const ownerId = listPrincipals(db).find((pr) => pr.kind === "human").id;
      const allowed = entries.find((e) => e.action === "read:registry" && e.outcome === "allowed" && e.principalId === ownerId);
      const done = entries.find((e) => e.action === "read:registry" && e.outcome === "done" && e.principalId === ownerId);
      assert.ok(allowed, "the decision itself, attributed to the principal that made the request…");
      assert.ok(done, "…and the outcome, because §16's dedup question is 'did I already DO this'");

      // And a WORKER's successful action is attributed to the worker, not to whoever happens to be first in the
      // table — the assertion that makes the one above non-vacuous.
      const workerRead = await request(sock, { id: "j3", cmd: "list", token: workerTokenForJournal });
      assert.equal(workerRead.ok, true);
      const workerRows = listJournal(db, { principalId: wp.id }).filter((e) => e.outcome === "done");
      assert.ok(workerRows.length >= 1, "a worker's successful read is journalled against the WORKER");
      assert.notEqual(wp.id, ownerId, "…which is only meaningful because they are different principals");

      // The worker was refused more than once in case 4 (`start`, then `tuiChat`), and `listJournal` is newest
      // first — so this looks for the run:start refusal by name rather than assuming which one is on top. The
      // first version asserted `[0].action === "run:start"` and got `run:input`, which is a fixture-ordering
      // assumption masquerading as a fact about the journal.
      const refusals = listJournal(db, { principalId: wp.id }).filter((e) => e.outcome === "refused");
      assert.ok(refusals.length >= 2, `every refusal is journalled; found ${refusals.length}`);
      const startRefusal = refusals.find((e) => e.action === "run:start");
      assert.ok(startRefusal, "including the one for the capability the worker does not hold");
      assert.match(startRefusal.detail, /does not hold/, "with the reason");

      // An UNAUTHENTICATED refusal has no principal to attribute, so it is logged and not journalled —
      // inventing an identity for it would make every identity in the journal less trustworthy.
      const journalledBefore = listJournal(db, { limit: 500 }).length;
      await request(sock, { id: "j2", cmd: "list" });
      assert.equal(listJournal(db, { limit: 500 }).length, journalledBefore,
        "an anonymous refusal adds no journal row — there is no principal to blame, and a fabricated one would poison the log");

      // §16's actual query.
      const hash = argsHash({ taskId: "t1" });
      assert.equal(journalHasDone(db, { principalId: wp.id, action: "jira:create", argsSha256: hash }).done, false,
        "'did I already file this ticket' answers no before it happens");
      console.log("  5. allowed, refused and done are journalled; an anonymous refusal has no principal to blame");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    // THE SENSITIVE CLASS, end to end. §6's "no autonomous merges" and §16's second signature turn out to be
    // the same mechanism: reaching `mergeTask` requires an approval bound to these arguments, so
    // `humanApproved` becomes an artifact rather than a boolean a caller passes.
    {
      const sock = sockPath(stateDir);
      createTask(db, { id: "t-merge", title: "merge me", type: "chore" });
      createWorker(db, { workerId: "w-m", nickname: "m", role: "reviewer", taskId: "t-merge" });
      let from = "created";
      for (const to of ["starting", "planning", "implementing", "awaiting-review", "approved"]) {
        recordTransition(db, {
          id: `tr-m-${to}`, taskId: "t-merge", fromState: from, toState: to, actor: "tester",
          ...(to === "approved" ? { reviewerVerdicts: 2 } : {}),
        });
        from = to;
      }
      // A CTO principal: it holds `task:merge`, which is necessary and not sufficient.
      const cto = supervisor.mintNamedPrincipal({ preset: "cto", displayName: "cto (test)" });

      const noApproval = await request(sock, { id: "m1", cmd: "mergeTask", token: cto.token, taskId: "t-merge" });
      assert.equal(noApproval.ok, false, "holding task:merge is not enough");
      assert.equal(noApproval.needsApproval, true, "and the refusal says an approval is what is missing");
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-merge'").get().state, "approved",
        "and the task did not move");

      // A self-approval is refused, which is what makes "no skip-level authority grants" mean anything — the
      // CTO holds `approve:sensitive` too, so this is exactly the loophole that has to be closed.
      const selfGrant = await request(sock, {
        id: "m2", cmd: "grantApproval", token: cto.token, forPrincipal: cto.id, action: "task:merge", args: { taskId: "t-merge" },
      });
      assert.equal(selfGrant.ok, false);
      assert.match(selfGrant.refused, /cannot approve its own/);

      // The owner grants it, bound to THESE arguments.
      const grant = await request(sock, {
        id: "m3", cmd: "grantApproval", token: ownerToken, forPrincipal: cto.id, action: "task:merge", args: { taskId: "t-merge" },
      });
      assert.equal(grant.ok, true, `the owner may grant; got ${JSON.stringify(grant)}`);

      // An approval for THESE arguments does not authorise others.
      createTask(db, { id: "t-other", title: "other", type: "chore" });
      const wrongTask = await request(sock, { id: "m4", cmd: "mergeTask", token: cto.token, taskId: "t-other" });
      assert.equal(wrongTask.ok, false, "the approval is bound to the arguments, not to the capability");

      const merged = await request(sock, { id: "m5", cmd: "mergeTask", token: cto.token, taskId: "t-merge" });
      assert.equal(merged.ok, true, `with the approval it proceeds; got ${JSON.stringify(merged)}`);
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-merge'").get().state, "merged");

      // SINGLE USE. An approval that can be replayed is a standing permission wearing a decision's clothes.
      //
      // ASSERTED ON THE REASON, not merely on `ok: false`. Mutation A6 removes the `consumed_at IS NULL` guard
      // from the spend, and the replay still failed — because the task was already `merged` and the state
      // machine refused a no-op transition. The case passed for a reason that had nothing to do with the
      // approval, which is the same vacuity §37.10 catalogues. Now it must be refused BY AUTHORIZATION.
      const replay = await request(sock, { id: "m6", cmd: "mergeTask", token: cto.token, taskId: "t-merge" });
      assert.equal(replay.ok, false, "the same approval cannot be spent twice");
      assert.equal(replay.refused, "unauthorized",
        "and refused by the GATE, not by the state machine happening to reject a no-op transition");
      assert.match(replay.error, /second principal's approval|already used/,
        "with a reason about the approval");
      console.log("  6. a sensitive action needs a second signature bound to its arguments, spent once");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    // THE CONCURRENT DOUBLE-SPEND, which is the only thing the `consumed_at IS NULL` guard in the WRITE is for.
    // Case 6's sequential replay is refused by the READ (`findSensitiveApproval` filters consumed rows), so it
    // passed with the write guard removed — a third vacuous assertion in this suite, all three found by the
    // mutation harness rather than by reading. Two requests, one approval: exactly one may be authorised, and
    // the other must be refused BY THE GATE rather than by whatever the second call happens to hit.
    {
      const sock = sockPath(stateDir);
      createTask(db, { id: "t-race-merge", title: "double spend", type: "chore" });
      let from = "created";
      for (const to of ["starting", "planning", "implementing", "awaiting-review", "approved"]) {
        recordTransition(db, {
          id: `tr-rm-${to}`, taskId: "t-race-merge", fromState: from, toState: to, actor: "tester",
          ...(to === "approved" ? { reviewerVerdicts: 2 } : {}),
        });
        from = to;
      }
      const cto2 = supervisor.mintNamedPrincipal({ preset: "cto", displayName: "cto (race)" });
      const granted = await request(sock, {
        id: "rm1", cmd: "grantApproval", token: ownerToken, forPrincipal: cto2.id,
        action: "task:merge", args: { taskId: "t-race-merge" },
      });
      assert.equal(granted.ok, true, "precondition: one approval exists");

      // IN-PROCESS, deliberately, and this is the interesting part of the case. Two real socket connections do
      // NOT interleave inside the wrapper's decision window: the server finishes parsing and dispatching the
      // first frame before the second arrives, so the whole find -> authorize -> consume sequence completes for
      // one request before the other starts. Measured — mutation A6b inserts an await into that window and
      // removes the write guard, and the socket version of this case still passed.
      //
      // Calling the authorized handlers directly puts both requests in flight in the same turn, which is where
      // the window actually is. The socket is the trust boundary; the RACE is intra-process.
      const handlers = supervisor.authorizedCommandHandlers();
      const cmd = { cmd: "mergeTask", token: cto2.token, taskId: "t-race-merge" };
      // A REJECTION IS TURNED INTO A VALUE, so that a double-spend fails this case BY ASSERTION rather than by
      // crashing it. Without this, the second merge throws inside the state machine ("already in merged") and
      // the suite dies with an unhandled rejection — which the mutation harness correctly refuses to credit,
      // since a crash proves nothing about the mechanism under test (FINDINGS §22.1).
      const settle = (p) => p.then((r) => r, (err) => ({ ok: false, threw: err.message }));
      const [a, b] = await Promise.all([
        settle(handlers.mergeTask({ ...cmd, id: "rm2" })),
        settle(handlers.mergeTask({ ...cmd, id: "rm3" })),
      ]);
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      assert.equal(winners.length, 1, `exactly one of two concurrent merges may proceed; got ${JSON.stringify([a, b])}`);
      assert.equal(losers[0].threw, undefined,
        `the loser must be REFUSED, not crash — a second merge that gets past the gate and dies in the state `
        + `machine is a double-spend that happened to be caught by something else; got ${JSON.stringify(losers[0])}`);
      assert.equal(losers[0].refused, "unauthorized",
        `and the other is refused BY AUTHORIZATION — single use has to be enforced by the write, because a `
        + `check-then-write lets both requests read 'unconsumed' and proceed; got ${JSON.stringify(losers[0])}`);
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-race-merge'").get().state, "merged");
      console.log("  7. one approval cannot be spent by two concurrent requests");
    }

    // ── 8 ────────────────────────────────────────────────────────────────────────────
    {
      const sock = sockPath(stateDir);
      const doomed = supervisor.mintNamedPrincipal({ preset: "utility:jira", displayName: "jira (test)" });
      assert.equal((await request(sock, { id: "r1", cmd: "list", token: doomed.token })).ok, true, "precondition: it works");
      const revoked = supervisor.revokePrincipal(doomed.id);
      assert.equal(revoked.revoked, true);
      const after = await request(sock, { id: "r2", cmd: "list", token: doomed.token });
      assert.equal(after.ok, false, "revocation takes effect on the next request");
      assert.match(after.error, /was revoked at/, "and says when — 'revoked' and 'unknown' are different facts");
      // Revocation is a timestamp, not a delete: the row survives so the audit trail does.
      assert.ok(getPrincipal(db, doomed.id), "the principal row still exists");
      assert.equal(supervisor.revokePrincipal(doomed.id).revoked, false, "and revoking twice is not a second event");
      console.log("  8. revocation takes effect immediately and stays auditable");
    }

    // ── 9 ────────────────────────────────────────────────────────────────────────────
    // THE REAL DAEMON. Everything above could hold while `ipc/daemon.js` still handed out the RAW command map —
    // one identifier at one call site, and nothing else in the suite would notice. This spawns the actual
    // daemon and asks its socket.
    {
      const daemonDir = makeScratchDir("supervisor-auth-daemon");
      const daemonPath = path.join(__dirname, "..", "..", "ipc", "daemon.js");
      daemon = spawn(process.execPath, [daemonPath], {
        env: {
          ...process.env,
          SUPERVISOR_STATE_DIR: daemonDir,
          CTD_STATE_DIR: daemonDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let out = "";
      daemon.stdout.on("data", (d) => { out += d.toString(); });
      daemon.stderr.on("data", (d) => { out += d.toString(); });

      const daemonSock = sockPath(daemonDir);
      try {
        await waitFor(() => fs.existsSync(daemonSock), { timeoutMs: 15000, pollMs: 100, what: "the daemon to listen" });
        const anon = await request(daemonSock, { id: "d1", cmd: "list" });
        assert.equal(anon.ok, false,
          `the REAL daemon must refuse an unauthenticated command; got ${JSON.stringify(anon)} — `
          + "if this passes with ok:true, daemon.js is handing out commandHandlers() instead of authorizedCommandHandlers()");
        assert.equal(anon.refused, "unauthorized");

        // …and accepts the owner token it minted for itself, which proves the refusal above is enforcement
        // rather than a broken daemon.
        const token = fs.readFileSync(path.join(daemonDir, "owner.token"), "utf8").trim();
        const authed = await request(daemonSock, { id: "d2", cmd: "list", token });
        assert.equal(authed.ok, true, `and serve the owner; got ${JSON.stringify(authed)}`);
        // A COMMAND THE DEMO SWITCH IMPLEMENTS. `startLongLived` exists only in `ipc/server.js`'s built-in
        // cases, so if those ever act as a fallback for a real command surface it is both §27.5's defect
        // (a mock answering plausibly for an unregistered name) and an authorization bypass — the wrapper
        // wraps the map and cannot wrap a case statement. Mutation A12 restores the fallback, and nothing
        // else in the suite noticed.
        const demoName = await request(daemonSock, { id: "d3", cmd: "startLongLived", token });
        assert.equal(demoName.ok, false,
          `a command only the demo switch implements must be refused, not served; got ${JSON.stringify(demoName)}`);
        assert.match(demoName.error, /unknown cmd/, "and refused as unknown rather than answered by a mock");
        const nonsense = await request(daemonSock, { id: "d4", cmd: "definitelyNotACommand", token });
        assert.match(nonsense.error, /unknown cmd/);
        assert.match(out, /listening on/, "the daemon logged that it was serving");
        console.log("  9. the real daemon refuses an unauthenticated command and serves the owner");
      } finally {
        try { process.kill(-daemon.pid, "SIGTERM"); } catch { /* already gone */ }
        await sleep(600);
        try { process.kill(-daemon.pid, "SIGKILL"); } catch { /* gone */ }
        rmScratchDir(daemonDir);
      }
    }

    // ── 10 ───────────────────────────────────────────────────────────────────────────
    // A WORKER'S SECOND RUN. `ensureWorkerPrincipal` returned the existing principal with no token, so every run
    // after the first launched with no credential and every callback it made was refused — authorization worked
    // for exactly one run per worker. Case 4 could not see it because it starts each worker once. Found by the
    // Phase 7 review (sol).
    {
      const sock = sockPath(stateDir);
      createWorker(db, { workerId: "w-twice", nickname: "twice", role: "coder", taskId: "t1" });
      const first = await supervisor.start({ harnessId: "fake", workerId: "w-twice", spec: { cwd: stateDir, prompt: "one" } });
      const firstToken = harnesses[0]._runs.get(first.runId)?.spec?.env?.CTD_PRINCIPAL_TOKEN;
      assert.ok(firstToken, "precondition: the first run got a token");
      assert.equal(first.principalDelivery, "env");
      await supervisor.stop(first.runId);

      const second = await supervisor.start({ harnessId: "fake", workerId: "w-twice", spec: { cwd: stateDir, prompt: "two" } });
      const secondToken = harnesses[0]._runs.get(second.runId)?.spec?.env?.CTD_PRINCIPAL_TOKEN;
      assert.ok(secondToken, "the SECOND run must get a working token too, or authorization is single-use per worker");
      assert.equal(second.principalDelivery, "env");
      assert.notEqual(secondToken, firstToken, "and a fresh one — the old token was handed to a process that has exited");
      assert.equal(second.principalId, first.principalId,
        "while the IDENTITY is the same: a worker is durable (§3's identity split), its credential is not");

      // The new token works…
      assert.equal((await request(sock, { id: "t2", cmd: "list", token: secondToken })).ok, true);
      // …and the old one no longer does, which is the point of rotating rather than re-issuing.
      const stale = await request(sock, { id: "t3", cmd: "list", token: firstToken });
      assert.equal(stale.ok, false, "the previous run's token stops working once the worker is restarted");
      await supervisor.stop(second.runId);
      console.log("  10. a restarted worker gets a fresh token for the same identity, and the old one dies");
    }

    // ── 11 ───────────────────────────────────────────────────────────────────────────
    // THE ACTOR IS THE PRINCIPAL. The wrapper resolved an identity and then handed the raw request to the
    // handler, which took `actor` from the payload and defaulted it to "owner" — so a CTO merge was written into
    // the transition journal as the owner's, and any string a caller sent was persisted as an identity. The
    // authorization journal held the truth while the task history held a fiction. Found by the Phase 7 review.
    {
      const sock = sockPath(stateDir);
      createTask(db, { id: "t-actor", title: "who did it", type: "chore" });
      let from = "created";
      for (const to of ["starting", "planning", "implementing", "awaiting-review", "approved"]) {
        recordTransition(db, {
          id: `tr-actor-${to}`, taskId: "t-actor", fromState: from, toState: to, actor: "tester",
          ...(to === "approved" ? { reviewerVerdicts: 2 } : {}),
        });
        from = to;
      }
      const cto3 = supervisor.mintNamedPrincipal({ preset: "cto", displayName: "cto (actor)" });
      const ownerId2 = listPrincipals(db).find((pr) => pr.kind === "human").id;
      await request(sock, {
        id: "ac1", cmd: "grantApproval", token: ownerToken, forPrincipal: cto3.id,
        action: "task:merge", args: { taskId: "t-actor" },
      });
      // A LIE in the payload is refused BEFORE it can be recorded, and for a reason worth knowing: the approval
      // was bound to `{ taskId }`, and adding `actor` changes the argument hash — so an extra field makes it a
      // different act. Two properties in one assertion, and neither was obvious until this case was written.
      const lied = await request(sock, { id: "ac2", cmd: "mergeTask", token: cto3.token, taskId: "t-actor", actor: "somebody-else" });
      assert.equal(lied.ok, false, "an extra argument is a different act, so the approval does not cover it");
      assert.equal(lied.needsApproval, true);

      // The honest request, with no `actor` at all — which is the path the default used to poison.
      const merged = await request(sock, { id: "ac3", cmd: "mergeTask", token: cto3.token, taskId: "t-actor" });
      assert.equal(merged.ok, true, `precondition: the merge is authorised; got ${JSON.stringify(merged)}`);

      const journalled = db.prepare("SELECT actor FROM transition_journal WHERE task_id = 't-actor' AND to_state = 'merged'").get();
      assert.equal(journalled.actor, cto3.id,
        `the transition must record the AUTHENTICATED principal, not the caller's claim; got ${journalled.actor}`);
      assert.notEqual(journalled.actor, "somebody-else", "an unverified string must never become an identity");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transition_journal WHERE actor = 'somebody-else'").get().n, 0,
        "and it must not appear anywhere in the journal");

      // A NON-SENSITIVE command carrying an actor, because that is where the substitution is actually reachable:
      // `mergeTask` is protected by the argument hash (adding `actor` changes the act), so a mutation that
      // prefers `cmd.actor` survives there. `assignTask` takes an actor and needs no approval, which makes it
      // the honest place to prove the rule. Mutation A18 preferred the caller's claim and only this catches it.
      createTask(db, { id: "t-actor2", title: "assignment actor", type: "chore" });
      createWorker(db, { workerId: "w-a2", nickname: "a2", role: "coder", taskId: "t-actor2" });
      const assigned = await request(sock, {
        id: "ac4", cmd: "assignTask", token: ownerToken, taskId: "t-actor2",
        overrides: { coder: { harnessId: "fake" } }, actor: "somebody-else", cwd: stateDir,
      });
      assert.equal(assigned.ok, true, `precondition: the assignment ran; got ${JSON.stringify(assigned)}`);
      const assignActor = db.prepare("SELECT actor FROM transition_journal WHERE task_id = 't-actor2' ORDER BY id LIMIT 1").get();
      assert.equal(assignActor.actor, ownerId2,
        `an assignment's transition must record the authenticated principal; got ${assignActor.actor}`);
      const record = JSON.parse(db.prepare("SELECT harness_assignments_json AS j FROM tasks WHERE id='t-actor2'").get().j);
      assert.equal(record.actor, ownerId2, "and so must the assignment record itself");
      for (const st of assigned.started ?? []) { try { await supervisor.stop(st.runId); } catch { /* already gone */ } }
      assert.notEqual(journalled.actor, "owner", "nor the default that hid this for a while");
      console.log("  11. a transition records the authenticated principal, not the actor a caller claims");
    }

    // ── 12 ───────────────────────────────────────────────────────────────────────────
    // TWO PENDING APPROVALS, the newer one expired. `findSensitiveApproval` took "the newest unconsumed" and let
    // the decision judge expiry, so a newer short-TTL approval MASKED an older valid one and the action was
    // refused as expired while a good approval sat unused beside it. Found by the Phase 7 review (sol).
    {
      const sock = sockPath(stateDir);
      createTask(db, { id: "t-two-approvals", title: "masking", type: "chore" });
      let from = "created";
      for (const to of ["starting", "planning", "implementing", "awaiting-review", "approved"]) {
        recordTransition(db, {
          id: `tr-2a-${to}`, taskId: "t-two-approvals", fromState: from, toState: to, actor: "tester",
          ...(to === "approved" ? { reviewerVerdicts: 2 } : {}),
        });
        from = to;
      }
      const cto4 = supervisor.mintNamedPrincipal({ preset: "cto", displayName: "cto (masking)" });
      const args = { taskId: "t-two-approvals" };
      // A long-lived approval…
      const good = await request(sock, {
        id: "ta1", cmd: "grantApproval", token: ownerToken, forPrincipal: cto4.id, action: "task:merge", args,
      });
      assert.equal(good.ok, true);
      // …then a newer one that expires almost immediately.
      const shortLived = await request(sock, {
        id: "ta2", cmd: "grantApproval", token: ownerToken, forPrincipal: cto4.id, action: "task:merge", args, ttlMs: 30,
      });
      assert.equal(shortLived.ok, true);
      await sleep(80);

      const merged = await request(sock, { id: "ta3", cmd: "mergeTask", token: cto4.token, taskId: "t-two-approvals" });
      assert.equal(merged.ok, true,
        `an expired newer approval must not mask a valid older one; got ${JSON.stringify(merged)}`);
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-two-approvals'").get().state, "merged");
      console.log("  12. an expired approval does not mask a valid one granted earlier");
    }
  } finally {
    try { if (ipc) await ipc.shutdown(); } catch { /* teardown */ }
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* teardown */ }
    for (const h of harnesses) { try { await h.disposeAll?.({ graceMs: 300 }); } catch { /* teardown */ } }
    try { if (db) closeDb(db); } catch { /* teardown */ }
    if (daemon) { try { process.kill(-daemon.pid, "SIGKILL"); } catch { /* gone */ } }
    await sleep(200);
    rmScratchDir(stateDir);
  }
});
