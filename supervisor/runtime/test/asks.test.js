// asks.test.js — the ask auto-close grace period (migration 0003).
//
// The gap this closes: `closeOpenAsksForRun` was called by reconciliation and by `reap`, but
// never by the adapter's own completion path — so a run that finished NORMALLY with an
// unanswered approval question left that question unresolved forever, blocking its task. The
// three terminal paths disagreed about the same question, and only one of them was ever
// noticed.
//
// The decision (2026-09-06): natural completion closes them too, but only after a **five
// minute grace**, because a run finishing does not mean the human who was asked has walked
// away. `lost` / `orphaned-unmanaged` / `reaped` still close immediately — those runs are gone
// or unmanaged, so nothing could ever answer them.
//
// The grace is a persisted deadline (`asks.auto_close_at`), not an in-memory timer, for one
// reason worth stating: a supervisor that crashes during the grace would otherwise strand the
// ask exactly the way the original bug did. Case 4 is that case.
//
// Cases:
//   1. natural completion schedules the deadline and leaves the ask ANSWERABLE
//   2. a human answer during the grace wins, and the sweep never touches it
//   3. once the deadline passes, the sweep closes it as system-resolved (not user-answered)
//   4. the deadline survives a crash: a brand-new supervisor's boot sweeps it
//   5. `reap` still closes asks immediately, with no grace at all
//   6. so does a deliberate `stop` — which used to be the one terminal path that ignored asks
//   7. a second completion cannot push an existing deadline further out
//   8. a late human answer cannot overwrite an ask the sweep already closed
//   9. an ask created AFTER its run ended is still given a deadline, not stranded
//
// Standing rule (TODO.md Group 6): every case asserts. This script cannot exit 0 with a
// broken claim.

import assert from "node:assert/strict";
import {
  openDb,
  closeDb,
  upsertHarness,
  createWorker,
  createTask,
  createAsk,
  answerAsk,
  getRun,
  scheduleAskAutoClose,
  ASK_AUTO_CLOSE_GRACE_MS,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { signalProcessGroup } from "../procinfo.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, waitFor } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

/** Start a run, give it an unanswered ask, then end it through the adapter's own path. */
async function startRunWithAsk(supervisor, harness, db, stateDir, { askId, complete = true }) {
  const { runId } = await supervisor.start({
    harnessId: "fake",
    workerId: "w1",
    spec: { cwd: stateDir, prompt: `ask test ${askId}` },
  });
  createAsk(db, { id: askId, runId, taskId: "t1", question: "may I write to main?" });
  if (complete) {
    harness._runs.get(runId).child.stdin.write(`${JSON.stringify({ type: "exit" })}\n`);
    await waitFor(() => getRun(db, runId).ended_at, { timeoutMs: 5000, what: `run ${runId} to complete naturally` });
  }
  return runId;
}

const ask = (db, id) => db.prepare("SELECT * FROM asks WHERE id = ?").get(id);

await runTest("asks", async () => {
  const stateDir = makeScratchDir("supervisor-asks-test");
  const liveGroups = new Set();
  let db;
  let supervisor;
  let harness;

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createWorker(db, { workerId: "w1", nickname: "tester", role: "worker" });
    createTask(db, { id: "t1", title: "ask lifecycle", type: "feature" });

    harness = createFakeHarness({ label: "asks" });
    // A 400ms grace instead of five real minutes, and no background timer: the sweep is driven
    // explicitly so nothing here depends on interval scheduling.
    supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askGraceMs: 400, askSweepIntervalMs: 0 });
    await supervisor.boot();

    // ---- 1. natural completion schedules a deadline and leaves the ask answerable -------
    {
      const runId = await startRunWithAsk(supervisor, harness, db, stateDir, { askId: "ask-grace" });
      const row = getRun(db, runId);
      assert.equal(row.exit_reason, "finished", "the run must have completed through the adapter's own path");

      const a = ask(db, "ask-grace");
      assert.equal(a.resolved, 0, "the ask must still be OPEN during the grace — a human may be mid-answer");
      assert.ok(a.auto_close_at, "completion must schedule a deadline rather than closing outright");
      const deadline = new Date(a.auto_close_at).getTime();
      const endedAt = new Date(row.ended_at).getTime();
      assert.ok(deadline > endedAt, `the deadline must be after completion (${a.auto_close_at} vs ${row.ended_at})`);
      assert.ok(deadline - endedAt <= 5000, "with the injected 400ms grace the deadline must be close to completion");
      // A sweep BEFORE the deadline must do nothing at all.
      assert.equal(supervisor.sweepAsks(), 0, "the sweep must not close an ask whose grace has not expired");
      assert.equal(ask(db, "ask-grace").resolved, 0);
      console.log(`  1. natural completion scheduled auto_close_at and left the ask answerable (grace 400ms)`);
    }

    // ---- 2. a human answer during the grace wins ----------------------------------------
    {
      const runId = await startRunWithAsk(supervisor, harness, db, stateDir, { askId: "ask-answered" });
      assert.ok(ask(db, "ask-answered").auto_close_at, "the deadline should have been scheduled");
      answerAsk(db, "ask-answered", { answer: "yes, go ahead", answeredBy: "manish" });

      await waitFor(() => Date.now() > new Date(ask(db, "ask-answered").auto_close_at).getTime(), {
        timeoutMs: 3000,
        what: "the grace period to expire",
      });
      supervisor.sweepAsks();
      const a = ask(db, "ask-answered");
      assert.equal(a.resolved, 1);
      assert.equal(a.answered_by, "manish", "a human answer during the grace must not be overwritten by the sweep");
      assert.equal(a.answer, "yes, go ahead", "and their answer text must survive verbatim");
      console.log(`  2. an answer given during the grace won; the sweep left it untouched (run ${runId.split("-").pop()})`);
    }

    // ---- 3. once the deadline passes, the sweep closes it as system-resolved -------------
    {
      // Its own ask: the sweep is global by design (it is one UPDATE over every expired row),
      // so case 2's sweep has already dealt with case 1's ask. Asserting "exactly one" needs a
      // row this case owns.
      await startRunWithAsk(supervisor, harness, db, stateDir, { askId: "ask-expired" });
      assert.equal(ask(db, "ask-expired").resolved, 0, "it starts open, inside its grace");
      await waitFor(() => Date.now() > new Date(ask(db, "ask-expired").auto_close_at).getTime(), {
        timeoutMs: 3000,
        what: "the ask's grace to expire",
      });
      const closed = supervisor.sweepAsks();
      assert.equal(closed, 1, `exactly one expired ask should have been closed, got ${closed}`);
      const a = ask(db, "ask-expired");
      assert.equal(a.resolved, 1, "an unanswered ask must not block its task forever");
      assert.equal(a.answered_by, "supervisor:auto-close", "it must be distinguishable from a human answer");
      assert.match(a.answer, /run-completed/, `the answer should say why it closed: ${a.answer}`);
      // Migration 0004 split the one old column in two, and this assertion is the reason the
      // split was worth making: an auto-close writes `answered_at` (the row is settled and
      // durable) but leaves `delivered_at` NULL, because nothing was handed to a harness —
      // the run had already finished. The old code stamped `delivered_at` here, which read as
      // "the answer reached the worker" for an answer that never went anywhere.
      assert.ok(a.answered_at, "answered_at is stamped so the row is not half-written");
      assert.equal(a.delivered_at, null, "but nothing was delivered to a harness, and the row must not claim otherwise");
      assert.equal(supervisor.sweepAsks(), 0, "a second sweep must find nothing left to do");
      // Case 1's ask was closed the same way, by case 2's sweep.
      assert.equal(ask(db, "ask-grace").answered_by, "supervisor:auto-close", "case 1's ask closed by the same mechanism");
      console.log("  3. after the grace expired, the sweep closed it as supervisor:auto-close, not as a user answer");
    }

    // ---- 4. the deadline survives a crash: a new supervisor's boot sweeps it -------------
    {
      const runId = await startRunWithAsk(supervisor, harness, db, stateDir, { askId: "ask-crash" });
      assert.equal(ask(db, "ask-crash").resolved, 0);
      // Rewrite the deadline into the past — the same state a supervisor that was SIGKILLed
      // mid-grace leaves behind, without waiting for real time to pass.
      db.prepare("UPDATE asks SET auto_close_at = ? WHERE id = 'ask-crash'").run(new Date(Date.now() - 60_000).toISOString());

      // A brand-new supervisor over the same database — no in-memory timer survived, so if boot
      // did not sweep, this ask would be stranded exactly as the original bug stranded it.
      const restarted = createSupervisor({
        db,
        adapters: { fake: createFakeHarness({ label: "asks-restart" }) },
        logger: quiet,
        askSweepIntervalMs: 0,
      });
      const boot = await restarted.boot();
      assert.ok(boot.asksAutoClosed >= 1, `boot must sweep expired asks, closed ${boot.asksAutoClosed}`);
      const a = ask(db, "ask-crash");
      assert.equal(a.resolved, 1, "a deadline that expired while nothing was running must still be honoured");
      assert.equal(a.answered_by, "supervisor:auto-close");
      console.log(`  4. a deadline that expired with no supervisor running was swept on the next boot (run ${runId.split("-").pop()})`);
    }

    // ---- 5. reap closes asks immediately, with no grace ---------------------------------
    {
      const runId = await startRunWithAsk(supervisor, harness, db, stateDir, { askId: "ask-reaped", complete: false });
      const row = getRun(db, runId);
      liveGroups.add(row.process_group);
      const result = await supervisor.reap(runId);
      assert.equal(result.reaped, true, `reap should have killed the group: ${JSON.stringify(result)}`);
      const a = ask(db, "ask-reaped");
      assert.equal(a.resolved, 1, "a reaped run cannot answer anything, so its ask closes at once");
      assert.equal(a.auto_close_at, null, "and it must never have been given a grace period");
      assert.equal(a.answered_by, "supervisor:reconciliation");
      assert.match(a.answer, /reaped/, `the answer should name the cause: ${a.answer}`);
      console.log("  5. reap closed the ask immediately, with no grace — nothing was left that could answer it");
    }

    // ---- 6. a deliberate stop closes asks immediately too -------------------------------
    {
      const runId = await startRunWithAsk(supervisor, harness, db, stateDir, { askId: "ask-stopped", complete: false });
      liveGroups.add(getRun(db, runId).process_group);
      const res = await supervisor.stop(runId);
      assert.equal(res.closed, true, `stop should have closed the run: ${JSON.stringify(res)}`);
      assert.equal(getRun(db, runId).exit_reason, "stopped");
      const a = ask(db, "ask-stopped");
      assert.equal(a.resolved, 1, "a deliberately stopped run must not leave its ask open — a human is already acting on it");
      assert.equal(a.auto_close_at, null, "and it must not be given a grace period");
      assert.match(a.answer, /stopped/, `the answer should name the cause: ${a.answer}`);
      console.log("  6. a deliberate stop closed the ask at once (this path used to ignore asks entirely)");
    }

    // ---- 7. a second completion cannot push an existing deadline out --------------------
    {
      const runId = await startRunWithAsk(supervisor, harness, db, stateDir, { askId: "ask-once" });
      const first = ask(db, "ask-once").auto_close_at;
      assert.ok(first);
      // Whatever calls it again — a resumed generation completing, a duplicate terminal write —
      // must not be able to keep the ask open indefinitely by re-arming the grace.
      const again = scheduleAskAutoClose(db, runId, { graceMs: 60 * 60 * 1000 });
      assert.equal(again.scheduled, 0, "an ask that already has a deadline must not be rescheduled");
      assert.equal(ask(db, "ask-once").auto_close_at, first, "and its deadline must be unchanged");
      assert.ok(ASK_AUTO_CLOSE_GRACE_MS === 5 * 60 * 1000, "the shipped default grace is five minutes");
      console.log("  7. a repeat completion could not extend an existing deadline (default grace is 5 minutes)");
    }

    // ---- 8. a late answer cannot overwrite a system-closed ask --------------------------
    // Every closing statement in db/index.js is guarded by `resolved = 0` — `answerAsk` was not
    // (all three 0003 reviewers found it). Verified failing: swept the ask, then answered it, and
    // `answered_by` flipped from `supervisor:auto-close` to the human. "An answer during the grace
    // wins" only means something if an answer after it does not.
    {
      const runId = await startRunWithAsk(supervisor, harness, db, stateDir, { askId: "ask-late" });
      await waitFor(() => Date.now() > new Date(ask(db, "ask-late").auto_close_at).getTime(), {
        timeoutMs: 3000,
        what: "the grace to expire",
      });
      supervisor.sweepAsks();
      assert.equal(ask(db, "ask-late").answered_by, "supervisor:auto-close");

      const changed = answerAsk(db, "ask-late", { answer: "too late", answeredBy: "manish" });
      assert.equal(changed, 0, "a late answer must change nothing, and must say so");
      const a = ask(db, "ask-late");
      assert.equal(a.answered_by, "supervisor:auto-close", "the system resolution must stand");
      assert.notEqual(a.answer, "too late", "and the late answer text must not be written");
      console.log(`  8. an answer after the grace changed 0 rows; the system resolution stood (run ${runId.split("-").pop()})`);
    }

    // ---- 9. an ask created after its run ended is not stranded --------------------------
    // Verified failing: every closing path only touches asks that exist when it runs, and the
    // sweep only looks at rows with a deadline — so an ask inserted a moment after completion had
    // `resolved = 0, auto_close_at = NULL` and was unreachable by every mechanism, forever.
    {
      const { runId } = await supervisor.start({ harnessId: "fake", workerId: "w1", spec: { cwd: stateDir, prompt: "late ask" } });
      liveGroups.add(getRun(db, runId).process_group);
      harness._runs.get(runId).child.stdin.write(`${JSON.stringify({ type: "exit" })}\n`);
      await waitFor(() => getRun(db, runId).ended_at, { timeoutMs: 5000, what: "the run to complete" });

      createAsk(db, { id: "ask-after-end", runId, taskId: "t1", question: "asked too late", graceMs: 300 });
      const scheduled = ask(db, "ask-after-end");
      assert.equal(scheduled.resolved, 0, "it starts open — a human may still want to see it");
      assert.ok(scheduled.auto_close_at, "but it MUST have a deadline, or nothing will ever close it");

      await waitFor(() => Date.now() > new Date(scheduled.auto_close_at).getTime(), { timeoutMs: 3000, what: "its grace to expire" });
      assert.ok(supervisor.sweepAsks() >= 1, "and the sweep must then close it");
      assert.equal(ask(db, "ask-after-end").answered_by, "supervisor:auto-close");
      console.log("  9. an ask inserted after its run ended got a deadline and was swept, instead of blocking forever");
    }
  } finally {
    if (supervisor) await supervisor.shutdown({ timeoutMs: 1500 }).catch(() => {});
    if (harness) await harness.disposeAll().catch(() => {});
    for (const pgid of liveGroups) signalProcessGroup(pgid, "SIGKILL");
    if (db) closeDb(db);
    rmScratchDir(stateDir);
  }
});
