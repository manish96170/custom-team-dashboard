// adoption.test.js — adopting a session a HUMAN started (ROADMAP Phase 3, migration 0007).
//
// THE RISK THIS SUITE EXISTS FOR
//
// An adopted session is structurally identical to migration 0003's `orphaned-unmanaged`: a live
// process the supervisor did not spawn and holds no handle for. If it were recorded that way, every
// mechanism built for orphans would apply to it — reconciliation would journal it as an orphan
// sighting on every boot, `orphans()` would offer it up for cleanup, and a reap GROUP-KILLS. That is
// somebody's live session, mid-sentence.
//
// Cases 3 and 4 are the two that matter. Everything else is bookkeeping around them.
//
// Cases:
//   1. a session is adopted with an OS-verified identity, and is idempotent on (harness, session)
//   2. adoption refuses a pid that is not alive
//   3. reconciliation leaves a live adopted session ALONE — no orphan state, no sighting, not in orphans()
//   4. reap REFUSES an adopted session, and force is the only way past it
//   5. an adopted session whose process is gone IS closed as `lost` — the backstop when no hook fired
//   6. releaseSession closes it on report, and is idempotent
//   7. an adopted run is reported as NOT controllable, and has no stdio to control
//   8. the hook client never breaks the session: no supervisor, bad payload, missing worker id
//   9. THE INVARIANT: the supervisor only ever kills a process it started itself
//  10. the adoption crash window: a hook-provenance row is refused even if its lifecycle says managed
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb,
  closeDb,
  upsertHarness,
  createWorker,
  createTask,
  createRun,
  getRun,
  listOpenRuns,
  listAdoptedRuns,
  findAdoptedRun,
  listOrphanSightings,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { reap } from "../reconcile.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, sleep } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, "../../hooks/claude-session-hook.mjs");

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

/** Run the hook script with a payload on stdin. Resolves { code, stdout, stderr }. */
function runHook(args, payload, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [HOOK, ...args], { env: { ...process.env, ...env }, timeout: 15_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

/**
 * A real, long-lived process to stand in for "somebody's `claude` session".
 *
 * A real OS process rather than a fabricated pid, because every guard under test reads the pid back
 * from the OS (`readProcInfo`): a made-up pid would be classified as gone and the interesting paths
 * would never run.
 *
 * **DETACHED, so it leads its own process group — and this is not hygiene, it is the difference
 * between a test and a self-destruct.** `reap` group-kills. The first version of this used
 * `execFile`, which leaves the child in the TEST RUNNER's process group, so case 4's `force: true`
 * reap killed the test process itself: exit 144, no output, nothing to debug from. That is exactly
 * the defect `runtime/spawn.js` exists to prevent one layer down — a child inheriting the
 * supervisor's group means "kill this run's group" means "kill the supervisor" — reproduced here by
 * hand. `detached: true` makes pgid === pid, so the kill reaches this process and nothing else.
 */
function spawnBystander() {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", "sleep 120"], { detached: true, stdio: "ignore" });
    // Not unref'd: the test wants to know it is there, and every one is killed in the `finally`.
    child.on("error", () => {});
    setTimeout(() => resolve(child), 150);
  });
}

/** Assert a bystander really did get its own group, so a group-kill cannot reach the test runner. */
async function assertOwnGroup(child) {
  const { readProcInfo } = await import("../procinfo.js");
  const info = await readProcInfo(child.pid);
  assert.equal(info.alive, true, `bystander ${child.pid} should be alive`);
  assert.equal(info.pgid, child.pid,
    `bystander must LEAD its own process group (pgid ${info.pgid} !== pid ${child.pid}); otherwise a `
    + `group-kill in this suite reaches the test runner`);
}

await runTest("adoption of externally-started sessions", async () => {
  const stateDir = makeScratchDir("supervisor-adoption-test");
  let db;
  let supervisor;
  const bystanders = [];

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "claude-code", displayName: "Claude Code" });
    createTask(db, { id: "t1", title: "adoption", type: "feature" });
    createWorker(db, { workerId: "w-human", nickname: "the-human", role: "coder", taskId: "t1" });

    supervisor = createSupervisor({
      db,
      adapters: { "claude-code": createFakeHarness({ label: "adopt" }) },
      logger: quiet,
      askSweepIntervalMs: 0,
    });
    await supervisor.boot();

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    let adoptedRunId;
    let bystander;
    {
      bystander = await spawnBystander();
      bystanders.push(bystander);
      await assertOwnGroup(bystander);
      const res = await supervisor.adoptSession({
        harnessId: "claude-code",
        sessionId: "sess-abc",
        workerId: "w-human",
        cwd: stateDir,
        pid: bystander.pid,
        transcriptPath: "/tmp/fake-transcript.jsonl",
      });
      assert.equal(res.adopted, true, `adoption should have succeeded: ${JSON.stringify(res)}`);
      adoptedRunId = res.runId;

      const row = getRun(db, adoptedRunId);
      assert.equal(row.lifecycle, "adopted", "its own lifecycle, NOT orphaned-unmanaged");
      assert.equal(row.ended_at, null, "and it is open — the session is running");
      assert.equal(row.pid, bystander.pid);
      // Verified against the OS rather than trusted from the hook: a pid alone is not an identity.
      assert.ok(row.process_group, "the pgid was read back from the OS");
      assert.ok(row.proc_lstart, "as was the start time, which is what makes pid reuse detectable");
      assert.equal(row.transcript_path, "/tmp/fake-transcript.jsonl",
        "the transcript path is kept — it is the ONLY route to an adopted session's events");
      assert.ok(row.adopted_at, "and when we learned about it, separate from when the session began");

      // Idempotent: a SessionStart hook can fire more than once for one session.
      //
      // Called through a catch, because there are TWO defences here and the test must pin down which
      // one it wants. `adoptSession` checks for an existing row; migration 0007's UNIQUE index would
      // also reject a duplicate. Defence in depth is good, but a hook must get a clean answer rather
      // than a SQLite constraint error — so a throw here is a failure, not an acceptable outcome, and
      // asserting that makes the mutation that removes the check fail by assertion rather than crash.
      let again;
      try {
        again = await supervisor.adoptSession({
          harnessId: "claude-code", sessionId: "sess-abc", workerId: "w-human", cwd: stateDir, pid: bystander.pid,
        });
      } catch (err) {
        assert.fail(
          `a repeat adoption must resolve cleanly, not throw — the UNIQUE index is a backstop, not the `
          + `interface a hook talks to. It threw: ${err.message}`,
        );
      }
      assert.equal(again.adopted, false, "a second report must not create a rival row");
      assert.equal(again.runId, adoptedRunId, "it must find the existing one");
      assert.equal(listAdoptedRuns(db).length, 1);
      console.log("  1. adopted with an OS-verified identity, and idempotent on (harness, session)");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    {
      // A pid that has certainly exited: spawn one and wait for it.
      const shortLived = await new Promise((resolve) => {
        const c = execFile("/bin/sh", ["-c", "exit 0"], () => setTimeout(() => resolve(c), 150));
      });
      const res = await supervisor.adoptSession({
        harnessId: "claude-code", sessionId: "sess-dead", workerId: "w-human", cwd: stateDir, pid: shortLived.pid,
      });
      assert.equal(res.adopted, false, "adopting an already-dead session must be refused");
      assert.match(res.reason, /not alive/);
      assert.equal(findAdoptedRun(db, { harnessId: "claude-code", sessionId: "sess-dead" }), null,
        "and must leave no row behind");
      console.log("  2. adoption refused a pid that was not alive");
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    // THE GUARD. Without it, a boot turns somebody's session into an orphan sighting and a
    // reap candidate.
    {
      const before = listOrphanSightings(db, adoptedRunId).length;
      const boot = await supervisor.boot();

      const row = getRun(db, adoptedRunId);
      assert.equal(row.lifecycle, "adopted", "reconciliation must NOT relabel it orphaned-unmanaged");
      assert.equal(row.ended_at, null, "nor close it — the process is running");
      assert.equal(listOrphanSightings(db, adoptedRunId).length, before,
        "and must NOT journal an orphan sighting for somebody's live session");
      assert.deepEqual(supervisor.orphans().map((o) => o.runId).filter((id) => id === adoptedRunId), [],
        "it must not appear in orphans() — that list is what invites a reap");
      assert.ok(boot.reconciliation.alive.includes(adoptedRunId), "it is reported as alive");
      assert.ok(boot.reconciliation.adopted.includes(adoptedRunId), "and named as adopted, not merely skipped");
      assert.deepEqual(boot.reconciliation.orphaned, [], "nothing was orphaned by this boot");
      console.log("  3. reconciliation left the live adopted session alone, and said why");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    // The second guard. `reap` group-kills, so this is the difference between a tidy-up and
    // terminating a person's work.
    {
      const refused = await reap({ db, runId: adoptedRunId, hasHandle: () => false, logger: quiet });
      assert.equal(refused.reaped, false, "reap must refuse an adopted session");
      assert.equal(refused.refused, "adopted", "and say WHY, in a form a caller can branch on");
      assert.match(refused.reason, /person started it/);
      assert.equal(getRun(db, adoptedRunId).ended_at, null, "the row is untouched");

      // Still alive, which is the assertion that makes this case about behaviour and not wording.
      let killed = false;
      try { process.kill(bystander.pid, 0); } catch { killed = true; }
      assert.equal(killed, false, "and the person's process is STILL RUNNING");

      // `force` is the escape hatch for a stale row, and it must actually work — refusing forever
      // would make a stale adopted row unresolvable.
      const forced = await reap({ db, runId: adoptedRunId, hasHandle: () => false, logger: quiet, force: true });
      assert.notEqual(forced.refused, "adopted", `force must bypass the refusal; got ${JSON.stringify(forced)}`);
      console.log("  4. reap refused the adopted session and left the process running; force bypassed it");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    // The backstop: a session whose hook never fired (a crashed terminal) must still be closed once
    // its process is gone, or the dashboard shows a finished session as live forever.
    {
      const shortBystander = await spawnBystander();
      const res = await supervisor.adoptSession({
        harnessId: "claude-code", sessionId: "sess-gone", workerId: "w-human", cwd: stateDir, pid: shortBystander.pid,
      });
      assert.equal(res.adopted, true);
      shortBystander.kill("SIGKILL");
      await sleep(300);

      const boot = await supervisor.boot();
      const row = getRun(db, res.runId);
      assert.ok(row.ended_at, "an adopted session whose process is gone must be closed");
      assert.equal(row.exit_reason, "lost", "as lost — we never owned it, so it was not reaped or stopped");
      assert.ok(boot.reconciliation.lost.includes(res.runId));
      console.log("  5. an adopted session whose process died was closed as lost");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    {
      const live = await spawnBystander();
      bystanders.push(live);
      const res = await supervisor.adoptSession({
        harnessId: "claude-code", sessionId: "sess-release", workerId: "w-human", cwd: stateDir, pid: live.pid,
      });
      const released = supervisor.releaseSession({ harnessId: "claude-code", sessionId: "sess-release" });
      assert.equal(released.released, true);
      assert.ok(getRun(db, res.runId).ended_at, "release closes the row on report, without waiting for reconciliation");

      const twice = supervisor.releaseSession({ harnessId: "claude-code", sessionId: "sess-release" });
      assert.equal(twice.released, false, "a second release is a no-op, not an error");
      assert.match(twice.reason, /already closed/);

      const unknown = supervisor.releaseSession({ harnessId: "claude-code", sessionId: "never-adopted" });
      assert.equal(unknown.released, false, "releasing something never adopted is refused cleanly");
      console.log("  6. releaseSession closed it on report, idempotently");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    // Honesty about what adoption buys. Presenting an adopted run as controllable would invite an
    // operator to try to interrupt something the supervisor cannot reach — the same class of
    // overclaim the conformance matrix exists to prevent.
    {
      // Its OWN session: case 4 deliberately force-reaped `sess-abc`, so that row is closed and
      // `adoptedSessions()` correctly no longer lists it. Reusing it here was a test-ordering bug —
      // the assertion failed for a reason that had nothing to do with what this case is about.
      const live = await spawnBystander();
      bystanders.push(live);
      const res = await supervisor.adoptSession({
        harnessId: "claude-code", sessionId: "sess-visible", workerId: "w-human", cwd: stateDir,
        pid: live.pid, transcriptPath: "/tmp/fake-transcript.jsonl",
      });
      assert.equal(res.adopted, true);

      const sessions = supervisor.adoptedSessions();
      const one = sessions.find((x) => x.sessionId === "sess-visible");
      assert.ok(one, "the adopted session is listed");
      assert.equal(one.controllable, false, "and explicitly marked NOT controllable");
      assert.equal(one.transcriptPath, "/tmp/fake-transcript.jsonl", "with the only route to its events");
      // There is genuinely no handle: that is what `controllable: false` is reporting.
      assert.equal(supervisor.hasHandle(one.runId), false,
        "the supervisor holds no adapter handle for it, which is why it cannot be controlled");
      console.log("  7. an adopted run is reported as visible but not controllable");
    }

    // ── 8 ────────────────────────────────────────────────────────────────────────────
    // The hook runs inside somebody's interactive session. Every one of these must exit 0 and print
    // nothing on stdout — a Claude Code hook's stdout can be injected into the session's context, and
    // a hook that fails loudly would make installing the dashboard a reason for a terminal to misbehave.
    {
      const noSupervisor = await runHook(["adopt"], { session_id: "s1", cwd: stateDir },
        { SUPERVISOR_STATE_DIR: "/nonexistent/ctd-no-daemon", CTD_ADOPT_WORKER_ID: "w-human" });
      assert.equal(noSupervisor.code, 0, "no supervisor running must exit 0 — that is the COMMON case");
      assert.equal(noSupervisor.stdout, "", "and print nothing on stdout");

      const badPayload = await runHook(["adopt"], "this is not json",
        { SUPERVISOR_STATE_DIR: stateDir, CTD_ADOPT_WORKER_ID: "w-human" });
      assert.equal(badPayload.code, 0, "an unparseable payload must exit 0");
      assert.equal(badPayload.stdout, "");

      const noWorker = await runHook(["adopt"], { session_id: "s2", cwd: stateDir }, { SUPERVISOR_STATE_DIR: stateDir });
      assert.equal(noWorker.code, 0, "a missing CTD_ADOPT_WORKER_ID must exit 0 rather than erroring at the user");
      assert.equal(noWorker.stdout, "");
      assert.equal(findAdoptedRun(db, { harnessId: "claude-code", sessionId: "s2" }), null,
        "and must adopt nothing — a wrong attribution is worse than none");

      const noSession = await runHook(["adopt"], { cwd: stateDir },
        { SUPERVISOR_STATE_DIR: stateDir, CTD_ADOPT_WORKER_ID: "w-human" });
      assert.equal(noSession.code, 0, "a payload with no session_id must exit 0");
      console.log("  8. the hook exited 0 and stayed silent on every failure path");
    }
    // ── 9 ────────────────────────────────────────────────────────────────────────────
    // THE INVARIANT, asserted directly instead of inferred: **the supervisor only ever kills a
    // process it started itself.** It was previously implicit in three separate mechanisms, which is
    // exactly the kind of safety property that quietly stops being true.
    {
      // (a) A process the dashboard never knew about is UNREACHABLE by either dangerous path. This is
      // the case the owner was worried about, and the reason it is safe is structural: reconciliation
      // reads `listOpenRuns` and `reap` needs a runId from a row, so no row means nothing can name it.
      const stranger = await spawnBystander();
      bystanders.push(stranger);
      await assertOwnGroup(stranger);

      const rowsBefore = listOpenRuns(db).length;
      await supervisor.boot();
      assert.equal(
        listOpenRuns(db).some((r) => r.pid === stranger.pid), false,
        "a process the dashboard never started must not appear in the run table at all",
      );
      assert.equal(listOpenRuns(db).length, rowsBefore,
        "and reconciliation must not invent a row for it");
      let strangerDead = false;
      try { process.kill(stranger.pid, 0); } catch { strangerDead = true; }
      assert.equal(strangerDead, false, "and it must still be running after a full boot + reconciliation");

      // (b) Provenance is recorded, and the DEFAULT is the load-bearing half. An unstated origin must
      // mean "we started it" — if it meant "unknown", every row from a path that forgot to say so
      // would fall outside the reapable set and silently stop being cleanable. That failure runs in
      // the SAFE direction, which is precisely why nothing would notice it.
      createRun(db, { runId: "prov-default", workerId: "w-human", harnessId: "claude-code", prompt: "spawned by us" });
      assert.equal(db.prepare("SELECT started_by FROM runs WHERE run_id = 'prov-default'").get().started_by,
        "dashboard", "a run created with no stated origin must be recorded as dashboard-started");

      const adopted = db.prepare("SELECT started_by FROM runs WHERE lifecycle = 'adopted' LIMIT 1").get();
      assert.equal(adopted.started_by, "hook", "an adopted session records that a hook reported it");

      const reapable = db.prepare(
        "SELECT run_id, started_by, lifecycle FROM runs WHERE ended_at IS NULL AND started_by != 'dashboard'",
      ).all();
      for (const r of reapable) {
        const refused = await reap({ db, runId: r.run_id, hasHandle: () => false, logger: quiet });
        assert.equal(refused.reaped, false,
          `nothing the dashboard did not start may be reaped; run ${r.run_id} (started_by=${r.started_by}) was`);
      }
      console.log("  9. the invariant holds: only what the dashboard started is reapable");
    }
    // ── 10 ───────────────────────────────────────────────────────────────────────────
    // THE CRASH WINDOW, found by big-pickle's review of Phases 3-5 and verified to kill a real process.
    //
    // Adoption used to be two statements: `createRun` (whose `lifecycle` defaults to 'managed') then
    // `markRunAdopted`. A crash between them left an open row with `started_by = 'hook'`, a verified
    // pid, no handle, and `lifecycle = 'managed'` — which reconciliation reads as an orphan and `reap`
    // then kills. Reproduced before fixing: with a complete identity, `reap` returned `reaped: true`
    // and the stand-in process was gone. The first attempt survived only because `createRun` does not
    // record `proc_lstart`, so reap's incomplete-identity refusal fired first — an accident of a
    // DIFFERENT guard, not design.
    //
    // Two fixes, and this case checks both, because either alone leaves the invariant resting on the
    // other: adoption is now one transaction (the window does not exist), AND the reap refusal keys on
    // `started_by` as well as `lifecycle` (so the guard matches the claim even if a row is malformed).
    {
      const live = await spawnBystander();
      bystanders.push(live);
      await assertOwnGroup(live);
      const info = await (await import("../procinfo.js")).readProcInfo(live.pid);

      // Hand-build exactly what the crash window used to leave behind, including the lstart that made
      // it lethal — a malformed row no code path can produce any more, which is the point: the guard
      // must hold for it anyway.
      createRun(db, {
        runId: "half-adopted", workerId: "w-human", harnessId: "claude-code",
        prompt: "[adopted session]", pid: live.pid, processGroup: info.pgid, startedBy: "hook",
      });
      db.prepare("UPDATE runs SET proc_lstart = ? WHERE run_id = 'half-adopted'").run(info.lstart);
      assert.equal(getRun(db, "half-adopted").lifecycle, "managed",
        "precondition: this row looks managed, which is what made it reapable");

      const refused = await reap({ db, runId: "half-adopted", hasHandle: () => false, logger: quiet });
      assert.equal(refused.reaped, false,
        "a row that says it came from a hook must NOT be reaped, even with lifecycle 'managed'");
      assert.equal(refused.refused, "adopted");
      assert.match(refused.reason, /started_by=hook/, "and the refusal must name why");

      let dead = false;
      try { process.kill(live.pid, 0); } catch { dead = true; }
      assert.equal(dead, false, "and the process must still be running");

      // ...and the window itself is gone: a real adoption writes both facts or neither.
      const bystander2 = await spawnBystander();
      bystanders.push(bystander2);
      const res = await supervisor.adoptSession({
        harnessId: "claude-code", sessionId: "sess-atomic", workerId: "w-human", cwd: stateDir, pid: bystander2.pid,
      });
      assert.equal(res.adopted, true);
      assert.equal(getRun(db, res.runId).lifecycle, "adopted",
        "adoption is atomic: no observable state has the identity without the lifecycle");
      console.log("  10. a hook-provenance row is refused even when its lifecycle says managed");
    }
  } finally {
    for (const b of bystanders) { try { b.kill("SIGKILL"); } catch { /* already gone */ } }
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* best effort */ }
    try { if (db) closeDb(db); } catch { /* best effort */ }
    rmScratchDir(stateDir);
  }
});
