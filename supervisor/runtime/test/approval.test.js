// approval.test.js — Phase 2's approval round trip, end to end through the supervisor:
// a harness parks a request, an `asks` row appears, a human answers over the supervisor's
// own API, the answer is persisted and then delivered, and the parked worker resumes.
//
// The harness here is `_fake-harness-child.js`, but the protocol it speaks was MEASURED
// against `claude` 2.1.263 first (adapters/claude-code/probe/, recorded in
// adapters/FINDINGS.md): a `can_use_tool` control request, a turn that parks indefinitely
// with no deadline of its own, `{behavior:'allow'|'deny'}` back, a deny message that reaches
// the model verbatim, a question answered by `updatedInput.answers`, and either side able to
// withdraw. The fake parks for real — it emits nothing further until answered — because a
// harness that carried on regardless would let every case below pass while the real one
// deadlocked.
//
// The case worth reading first is 5: an answer is durable BEFORE it is delivered. That is the
// only ordering in this file that data loss depends on (PLAN.md section 7).

import assert from "node:assert/strict";
import {
  openDb,
  closeDb,
  upsertHarness,
  createWorker,
  createTask,
  listUndeliveredAnswers,
  closeOpenAsksForRun,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { killProcessGroup } from "../spawn.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, waitFor, sleep } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error() {} };

const askRow = (db, id) => db.prepare("SELECT * FROM asks WHERE id = ?").get(id);
const eventsOf = (db, runId) =>
  db.prepare("SELECT type, payload_json FROM event_log WHERE run_id = ? ORDER BY seq").all(runId).map((r) => ({
    type: r.type,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null,
  }));

/** Ask the fake harness to block on a request, and wait for the ask row to exist. */
async function parkRequest(supervisor, harness, runId, request) {
  harness._runs.get(runId).child.stdin.write(`${JSON.stringify({ type: "ask", ...request })}\n`);
  return waitFor(
    () => supervisor.asks({ runId }).find((a) => a.harnessRequestId === request.requestId),
    { timeoutMs: 5000, what: `an ask row for parked request ${request.requestId}` },
  );
}

await runTest("approval round trip", async () => {
  const stateDir = makeScratchDir("supervisor-approval-test");
  const liveGroups = new Set();
  let db;
  let supervisor;
  let harness;

  const startRun = async (prompt) => {
    const { runId } = await supervisor.start({ harnessId: "fake", workerId: "w1", spec: { cwd: stateDir, prompt } });
    liveGroups.add(db.prepare("SELECT process_group FROM runs WHERE run_id = ?").get(runId).process_group);
    return runId;
  };

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createTask(db, { id: "t1", title: "approval slice", type: "feature" });
    createWorker(db, { workerId: "w1", nickname: "tester", role: "worker", taskId: "t1" });

    harness = createFakeHarness({ label: "approval" });
    supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askGraceMs: 400, askSweepIntervalMs: 0 });
    await supervisor.boot();

    // ── 1. a parked request becomes an ask, and the run stays OPEN ──────────────────
    {
      const runId = await startRun("case 1");
      const ask = await parkRequest(supervisor, harness, runId, {
        requestId: "req-allow",
        toolName: "Bash",
        description: "rm -rf build/",
        input: { command: "rm -rf build/" },
      });

      assert.equal(ask.kind, "tool-approval", "a tool call is an approval, not a question");
      assert.equal(ask.question, "Bash: rm -rf build/", `the summary should name the tool and what it wants: ${ask.question}`);
      assert.equal(ask.answerable, true, "the harness is still parked on it, so it can be answered");
      assert.equal(ask.taskId, "t1", "the task comes from the run's worker, not from the caller");
      assert.deepEqual(ask.payload.input, { command: "rm -rf build/" }, "the full tool input is kept for a human to read");
      assert.ok(ask.payload.suggestions, "the harness's own always-allow offer is passed through verbatim");

      const row = db.prepare("SELECT ended_at, generation FROM runs WHERE run_id = ?").get(runId);
      assert.equal(row.ended_at, null, "a run blocked on an approval has NOT ended — it is waiting");
      assert.equal(askRow(db, ask.askId).generation, row.generation, "the ask is pinned to the generation that parked it");
      // No auto_close_at: the grace exists for asks on a COMPLETED run. This run is live and
      // parked, and a deadline here would silently answer for the human.
      assert.equal(askRow(db, ask.askId).auto_close_at, null, "a live parked request gets no deadline");

      console.log(`  1. a parked Bash request became ask ${ask.askId}, answerable, run still open with no deadline`);

      // ── 2. allow: persisted, then delivered, and the worker resumes ────────────────
      const result = await supervisor.answerAsk(ask.askId, { allow: true, answeredBy: "operator" });
      assert.equal(result.answered, true);
      assert.equal(result.delivered, true, "the harness was parked, so the answer must have reached it");
      assert.equal(result.decision, "allow");

      const after = askRow(db, ask.askId);
      assert.equal(after.resolved, 1);
      assert.equal(after.decision, "allow");
      assert.equal(after.answered_by, "operator");
      assert.ok(after.answered_at, "the answer is durable");
      assert.ok(after.delivered_at, "and it reached the harness");
      assert.equal(after.delivery_error, null);

      // The proof that it was a real round trip rather than a database update: the parked
      // worker only emits again once answered.
      const toolResult = await waitFor(
        () => eventsOf(db, runId).find((e) => e.type === "tool.result"),
        { timeoutMs: 5000, what: "the unparked worker to report the decision it received" },
      );
      assert.equal(toolResult.payload.behavior, "allow", "the worker saw an allow");
      assert.equal(supervisor.asks({ runId }).length, 0, "nothing is blocked on this run any more");
      console.log("  2. allow was persisted then delivered; the parked worker resumed and saw it");
    }

    // ── 3. deny carries the human's reason to the worker, verbatim ──────────────────
    {
      const runId = await startRun("case 3");
      const ask = await parkRequest(supervisor, harness, runId, {
        requestId: "req-deny",
        toolName: "Bash",
        description: "git push --force",
        input: { command: "git push --force" },
      });
      const reason = "Not on main. Open a PR instead.";
      const result = await supervisor.answerAsk(ask.askId, { allow: false, answer: reason, answeredBy: "operator" });
      assert.equal(result.delivered, true);
      assert.equal(result.decision, "deny");

      const toolResult = await waitFor(() => eventsOf(db, runId).find((e) => e.type === "tool.result"), {
        timeoutMs: 5000,
        what: "the denied worker to resume",
      });
      assert.equal(toolResult.payload.behavior, "deny");
      // Measured on the real harness: this text becomes the tool_result the model reads, so a
      // human's stated reason is visible to the worker rather than a generic refusal.
      assert.equal(toolResult.payload.message, reason, "the deny message must reach the worker unaltered");
      assert.equal(askRow(db, ask.askId).answer, reason);
      console.log("  3. deny delivered the operator's reason to the worker, word for word");
    }

    // ── 4. a QUESTION is answered with answers, not with a bare allow ───────────────
    {
      const runId = await startRun("case 4");
      const question = "Tabs or spaces?";
      const ask = await parkRequest(supervisor, harness, runId, {
        requestId: "req-question",
        toolName: "AskUserQuestion",
        requiresUserInteraction: true,
        input: { questions: [{ question, header: "Indentation", options: [{ label: "Spaces" }, { label: "Tabs" }] }] },
      });
      assert.equal(ask.kind, "question", "requires_user_interaction is what tells a question from an approval");
      assert.equal(ask.question, question, "a question's own text beats anything we could synthesise");

      const result = await supervisor.answerAsk(ask.askId, { answers: { [question]: "Spaces" }, answeredBy: "operator" });
      assert.equal(result.answered, true);
      assert.equal(result.delivered, true);
      assert.equal(result.decision, "answered");

      const toolResult = await waitFor(() => eventsOf(db, runId).find((e) => e.type === "tool.result"), {
        timeoutMs: 5000,
        what: "the answered worker to resume",
      });
      // This is the shape the real CLI requires. A bare `allow` runs the tool with no answers
      // and tells the model "The user did not answer the questions" — measured, and the reason
      // this assertion is about updatedInput rather than just about behavior.
      assert.equal(toolResult.payload.behavior, "allow");
      // Asserted BEFORE dereferencing. Without this, a regression that dropped `updatedInput`
      // made the next line throw a TypeError, and the mutation harness credited the crash to
      // this case's assertion -- exactly the wrong-reason failure it is supposed to reject.
      assert.ok(
        toolResult.payload.updatedInput,
        "the answer must ride back in updatedInput; a bare allow runs the tool with no answers and the model is told the user did not answer",
      );
      assert.deepEqual(
        toolResult.payload.updatedInput.answers,
        { [question]: "Spaces" },
        "the answers must ride back inside updatedInput, keyed by the exact question text",
      );
      assert.deepEqual(
        toolResult.payload.updatedInput.questions,
        ask.payload.input.questions,
        "and the rest of the original input must be preserved alongside them",
      );
      console.log("  4. a question was answered via updatedInput.answers, with the original input preserved");
    }

    // ── 5. the answer is durable BEFORE it is delivered ─────────────────────────────
    // The ordering PLAN.md section 7 requires. A delivery failure must leave the human's
    // decision written down and retryable, never lost with the attempt — and it must NOT be
    // recorded as delivered, or the dashboard would show a resolved question while the worker
    // is still parked.
    {
      const runId = await startRun("case 5");
      const ask = await parkRequest(supervisor, harness, runId, {
        requestId: "req-transient",
        toolName: "Write",
        description: "src/index.js",
        input: { file_path: "src/index.js" },
      });

      harness._runs.get(runId).failNextAnswer = true;
      const result = await supervisor.answerAsk(ask.askId, { allow: true, answeredBy: "operator" });
      assert.equal(result.answered, true, "the answer was accepted");
      assert.equal(result.delivered, false, "but delivery failed");

      const stuck = askRow(db, ask.askId);
      assert.equal(stuck.resolved, 1, "the ask is settled — a human decided");
      assert.ok(stuck.answered_at, "and the decision is durable");
      assert.equal(stuck.delivered_at, null, "while delivered_at stays NULL, because nothing arrived");
      assert.match(stuck.delivery_error, /simulated delivery failure/, "the reason is recorded, not inferred from silence");

      const queue = listUndeliveredAnswers(db);
      assert.deepEqual(queue.map((a) => a.id), [ask.askId], "so it sits in the redelivery queue");

      const redelivery = await supervisor.deliverPendingAnswers();
      assert.deepEqual(redelivery, { attempted: 1, delivered: 1, abandoned: 0 }, "and a retry gets it there");
      const fixed = askRow(db, ask.askId);
      assert.ok(fixed.delivered_at, "delivered_at is stamped by the retry");
      assert.equal(fixed.delivery_error, null, "and the stale error is cleared");
      assert.deepEqual(listUndeliveredAnswers(db), [], "the queue drains");

      const toolResult = await waitFor(() => eventsOf(db, runId).find((e) => e.type === "tool.result"), {
        timeoutMs: 5000,
        what: "the worker to resume after the redelivery",
      });
      assert.equal(toolResult.payload.behavior, "allow", "the worker got the answer a human gave before the failure");
      console.log("  5. delivery failed, the answer survived, a retry delivered it and the worker resumed");
    }

    // ── 6. the harness withdrawing its own request closes the ask ───────────────────
    // The control protocol lets either side cancel an in-flight request, and the real CLI does
    // it when a turn is interrupted or another client answers first. Without handling it the
    // dashboard would keep offering a decision on a request that no longer exists.
    {
      const runId = await startRun("case 6");
      const ask = await parkRequest(supervisor, harness, runId, {
        requestId: "req-withdrawn",
        toolName: "Bash",
        description: "npm publish",
        input: { command: "npm publish" },
      });
      assert.equal(ask.answerable, true);

      harness._runs.get(runId).child.stdin.write(`${JSON.stringify({ type: "withdraw" })}\n`);
      await waitFor(() => askRow(db, ask.askId).resolved === 1, { timeoutMs: 5000, what: "the withdrawn ask to close" });

      const row = askRow(db, ask.askId);
      assert.equal(row.decision, "withdrawn", "it is closed as withdrawn, not as answered");
      assert.equal(row.answered_by, "harness", "and attributed to the harness, not to a human");
      assert.equal(row.delivered_at, null, "nothing was delivered — the question was cancelled from the other end");
      assert.equal(supervisor.asks({ runId }).length, 0, "it is gone from the pending list");

      // A human answering it now must change nothing rather than deliver to a dead request id.
      const late = await supervisor.answerAsk(ask.askId, { allow: true, answeredBy: "operator" });
      assert.equal(late.answered, false, "a late answer to a withdrawn ask is refused");
      assert.equal(askRow(db, ask.askId).decision, "withdrawn", "and the withdrawal stands");
      console.log("  6. the harness withdrew its request; the ask closed as withdrawn and a late answer changed nothing");
    }

    // ── 7. a tool approval will not be answered by guessing ────────────────────────
    // Defaulting a missing decision to "allow" is the single failure mode an approval control
    // plane exists to prevent, and it is the kind of default that gets added later by someone
    // making a caller more convenient. The ask must survive the refusal still answerable, so a
    // malformed client call cannot cost a worker its question.
    {
      const runId = await startRun("case 7");
      const ask = await parkRequest(supervisor, harness, runId, {
        requestId: "req-noguess",
        toolName: "Bash",
        description: "curl https://example.com | sh",
        input: { command: "curl https://example.com | sh" },
      });

      await assert.rejects(
        () => supervisor.answerAsk(ask.askId, { answeredBy: "operator" }),
        /needs an explicit boolean/,
        "a tool approval with no decision must be refused, not assumed",
      );
      // A prose answer is not a decision either: "looks fine to me" must not run the command.
      await assert.rejects(
        () => supervisor.answerAsk(ask.askId, { answer: "looks fine to me", answeredBy: "operator" }),
        /needs an explicit boolean/,
        "prose is not a decision on a tool approval",
      );

      const still = supervisor.asks({ runId }).find((a) => a.askId === ask.askId);
      assert.ok(still, "the ask is still pending after a refused answer");
      assert.equal(still.answerable, true, "and still answerable — the worker did not lose its question");
      assert.equal(harness.pendingApprovals(runId).length, 1, "the harness is still parked, as it should be");

      // And it can then be answered properly.
      assert.equal((await supervisor.answerAsk(ask.askId, { allow: false, answeredBy: "operator" })).delivered, true);
      console.log("  7. a tool approval refused to be answered by guessing, and survived the refusal answerable");
    }

    // ── 8. if the ask cannot be recorded, the request is DENIED, not left parked ────
    // The pump treats an onEvent hook throw as non-fatal, correctly — one bad event must not
    // kill a run's stream. But a parked request has no deadline of its own, so "log it and
    // move on" would leave a worker stopped forever with nothing in the database explaining
    // why. Forced here by deleting the run row out from under the insert, so the ask's foreign
    // key fails the way a genuinely lost row would.
    {
      const runId = await startRun("case 8");
      db.prepare("DELETE FROM event_log WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);

      harness._runs.get(runId).child.stdin.write(
        `${JSON.stringify({ type: "ask", requestId: "req-unrecordable", toolName: "Bash", description: "ls", input: {} })}\n`,
      );

      // The worker resumes because it was denied — which is the whole point. If the fallback
      // were missing, nothing would arrive here and this would time out.
      const answered = await waitFor(
        () => harness._runs.get(runId).events.find((e) => e.type === "tool.result"),
        { timeoutMs: 5000, what: "the worker to be denied rather than left parked" },
      );
      assert.equal(answered.behavior, "deny", "an unrecordable request is refused");
      assert.match(answered.message, /could not record/i, "and the worker is told why, in plain terms");
      assert.equal(harness.pendingApprovals(runId).length, 0, "nothing is left parked");
      console.log("  8. an ask that could not be recorded was denied, so the worker was not stranded");
    }
    // ────────────────────────────────────────────────────────────────────────────────
    // Cases 9-14 are regressions for the three-model code review of this feature
    // (review-phase2/, 2026-09-07). Each one had a real defect behind it; the mechanisms are
    // recorded in review-phase2/verdicts.md and in runtime/FINDINGS.md section 17.
    // ────────────────────────────────────────────────────────────────────────────────

    // ── 9. a question will not be "answered" by anything that is not an answer ─────
    // Both reviewers found this. The old check accepted any truthy object, so an array, an
    // empty object, prose, or a bare `allow: true` all resolved the ask and then delivered
    // `updatedInput.answers = {}` — the worker is told "The user did not answer the questions"
    // while the row says delivered. Silent, and it looks like the human ignored the worker.
    {
      const runId = await startRun("case 9");
      const question = "Which package manager?";
      const ask = await parkRequest(supervisor, harness, runId, {
        requestId: "req-badanswers",
        toolName: "AskUserQuestion",
        requiresUserInteraction: true,
        input: { questions: [{ question, header: "Tooling", options: [{ label: "pnpm" }, { label: "npm" }] }] },
      });

      for (const [bad, why] of [
        [{ answers: [] }, "an array is not a question-keyed map"],
        [{ answers: {} }, "an empty map answers nothing"],
        [{ answers: { "Some other question": "pnpm" } }, "keys must be the questions that were actually asked"],
        [{ answer: "pnpm" }, "prose alone is not a keyed answer"],
        [{ allow: true }, "allowing a question without answers runs it with none"],
      ]) {
        await assert.rejects(
          () => supervisor.answerAsk(ask.askId, { ...bad, answeredBy: "operator" }),
          /cannot be answered/,
          `should refuse: ${why}`,
        );
      }
      assert.equal(askRow(db, ask.askId).resolved, 0, "every refusal left the ask answerable");

      // Declining is different from answering badly, and must still work.
      const declined = await supervisor.answerAsk(ask.askId, { allow: false, answeredBy: "operator" });
      assert.equal(declined.decision, "deny", "a question can be declined outright");
      assert.equal(declined.delivered, true);
      console.log("  9. five malformed answers to a question were refused; declining it still works");
    }

    // ── 10. a request id reused by a new process generation is a NEW ask ────────────
    // Both reviewers found this. The unique index used to span the whole life of a logical run,
    // so a second generation reusing an id collided with the FIRST generation's row; the catch
    // treated every UNIQUE error as a benign pump redelivery and returned, leaving the new
    // worker parked with no ask row anyone could answer.
    {
      const runId = await startRun("case 10");
      const reusedId = "req-reused";
      const first = await parkRequest(supervisor, harness, runId, {
        requestId: reusedId,
        toolName: "Bash",
        description: "make build",
        input: { command: "make build" },
      });
      assert.equal((await supervisor.answerAsk(first.askId, { allow: true, answeredBy: "operator" })).delivered, true);
      const gen1 = db.prepare("SELECT generation FROM runs WHERE run_id = ?").get(runId).generation;

      // End the process and resume: a new OS process, a new generation, same runId.
      harness._runs.get(runId).child.stdin.write(`${JSON.stringify({ type: "exit" })}\n`);
      await waitFor(() => db.prepare("SELECT ended_at FROM runs WHERE run_id = ?").get(runId).ended_at, {
        timeoutMs: 5000,
        what: "the run to end so it can be resumed",
      });
      const resumed = await supervisor.resume(runId);
      assert.equal(resumed.resumed, true, "the run resumed");
      const gen2 = db.prepare("SELECT generation FROM runs WHERE run_id = ?").get(runId).generation;
      assert.ok(gen2 > gen1, `the generation advanced (${gen1} -> ${gen2})`);
      liveGroups.add(db.prepare("SELECT process_group FROM runs WHERE run_id = ?").get(runId).process_group);

      // The new process parks the SAME id. This must produce a second, answerable ask.
      const second = await parkRequest(supervisor, harness, runId, {
        requestId: reusedId,
        toolName: "Bash",
        description: "make test",
        input: { command: "make test" },
      });
      assert.notEqual(second.askId, first.askId, "the reused id produced a NEW ask, not a swallowed duplicate");
      assert.equal(second.generation, gen2, "pinned to the generation that actually asked");
      assert.equal(second.answerable, true, "and the new worker can be unblocked");
      assert.equal((await supervisor.answerAsk(second.askId, { allow: false, answer: "no tests here", answeredBy: "operator" })).delivered, true);
      console.log(`  10. generation ${gen1} and ${gen2} both used request id "${reusedId}" and each got its own answerable ask`);
    }

    // ── 11. a supervisor-closed ask is never delivered to a harness ─────────────────
    // The worst defect the review found: `deliverAnswer` mapped every decision that was not
    // exactly "deny" to an ALLOW, and `closeOpenAsksForRun` (reconciliation, and the auto-close
    // sweep) writes `decision = 'closed'` on a row that keeps `answered_at`. On an orphaned run —
    // which by design keeps `ended_at IS NULL` — those rows satisfied the redelivery predicate.
    // A worker could have been handed an approval no human ever gave.
    {
      const runId = await startRun("case 11");
      const ask = await parkRequest(supervisor, harness, runId, {
        requestId: "req-closed",
        toolName: "Bash",
        description: "rm -rf /",
        input: { command: "rm -rf /" },
      });
      // Close it the way reconciliation does, on a run that is still open.
      const closed = closeOpenAsksForRun(db, runId, { reason: "run-reconciled" });
      assert.equal(closed, 1, "reconciliation closed the ask");
      const row = askRow(db, ask.askId);
      assert.equal(row.decision, "closed");
      assert.ok(row.answered_at, "a close stamps answered_at, which is what made it look deliverable");
      assert.equal(row.delivered_at, null);

      assert.deepEqual(listUndeliveredAnswers(db, { runId }), [], "a closed ask is NOT in the redelivery queue");
      // And the second gate: even asked directly, delivery refuses rather than defaulting to allow.
      const attempt = await supervisor.deliverPendingAnswers();
      assert.equal(attempt.attempted, 0, "boot redelivery has nothing to do");
      assert.equal(
        harness.pendingApprovals(runId).length,
        1,
        "the harness is still parked — nothing was auto-approved on its behalf",
      );
      console.log("  11. a reconciliation-closed ask stayed out of the redelivery queue and was never delivered as an allow");
    }

    // ── 12. an answer racing a harness withdrawal leaves the queue ──────────────────
    // Both reviewers found this. The adapter drops the parked entry the instant the cancel
    // arrives, so an answer in that window persists and then fails delivery; `withdrawAsk`'s
    // `resolved = 0` guard then matched nothing, and the row was answered, undelivered and
    // retried on every boot forever.
    {
      const runId = await startRun("case 12");
      const ask = await parkRequest(supervisor, harness, runId, {
        requestId: "req-race",
        toolName: "Bash",
        description: "git commit",
        input: { command: "git commit" },
      });

      // Answer while delivery is guaranteed to fail, then let the withdrawal land — the same
      // end state as the real race, reached deterministically.
      harness._runs.get(runId).failNextAnswer = true;
      const answered = await supervisor.answerAsk(ask.askId, { allow: true, answeredBy: "operator" });
      assert.equal(answered.answered, true);
      assert.equal(answered.delivered, false, "delivery failed, so the row is queued for retry");
      assert.equal(listUndeliveredAnswers(db, { runId }).length, 1, "and it really is queued");

      harness._runs.get(runId).child.stdin.write(`${JSON.stringify({ type: "withdraw" })}\n`);
      await waitFor(() => askRow(db, ask.askId).delivery_abandoned_at, {
        timeoutMs: 5000,
        what: "the withdrawal to abandon the undeliverable answer",
      });

      const row = askRow(db, ask.askId);
      assert.equal(row.decision, "allow", "the human's decision is preserved — somebody did decide");
      assert.equal(row.delivered_at, null, "nothing was delivered");
      assert.match(row.delivery_error, /withdrew/i, "and the reason it can never be delivered is recorded");
      assert.deepEqual(listUndeliveredAnswers(db, { runId }), [], "the row has left the redelivery queue for good");
      assert.deepEqual(await supervisor.deliverPendingAnswers(), { attempted: 0, delivered: 0, abandoned: 0 });
      console.log("  12. an answer that raced a withdrawal was abandoned, keeping the decision but ending the retries");
    }

    // ── 13. an approval.request with the wrong shape writes no row ──────────────────
    // Found by neither opencode reviewer and rated LOW by the consolidation, because both
    // assumed only Claude Code's well-formed events reach this hook. In fact
    // `adapters/opencode/adapter.js` ALREADY emits `type: 'approval.request'` with a different
    // shape (`approvalID`, `permission`, `tool` — no `requestId`, no `toolName`) and its own
    // config sets bash/edit/write to "ask", so it is that adapter's DEFAULT behaviour. Rows would
    // have read "undefined requires approval" with a NULL request id — and since the unique index
    // is partial, every repeat inserted another one.
    {
      const runId = await startRun("case 13");
      const before = db.prepare("SELECT COUNT(*) AS n FROM asks WHERE run_id = ?").get(runId).n;

      // A REAL parked request first, so the "is anything actually waiting" guard is satisfied and
      // only the shape check can refuse what follows. Without this the two guards overlap and the
      // case cannot tell them apart — which a mutation run proved: removing the shape check left
      // this case passing, because the replay guard was quietly doing the work.
      const real = await parkRequest(supervisor, harness, runId, {
        requestId: "req-shape",
        toolName: "Bash",
        description: "ls",
        input: { command: "ls" },
      });
      const beforeMalformed = db.prepare("SELECT COUNT(*) AS n FROM asks WHERE run_id = ?").get(runId).n;

      const emit = (event) => {
        const run = harness._runs.get(runId);
        run.events.push(event);
        for (const wake of run.waiters) wake();
        run.waiters.clear();
      };

      // Exactly what the OpenCode adapter emits today: no requestId, no toolName.
      for (let i = 0; i < 3; i += 1) {
        emit({ type: "approval.request", approvalID: "perm-1", permission: "bash", patterns: ["*"], tool: "bash" });
      }
      // A second parked request whose ask row is then DELETED. That is the only state in which a
      // malformed event can reach the insert: `stillParked` is satisfied (the harness really is
      // waiting on this id) and the unique guard has nothing to collide with. Both of those were
      // masking the shape check, which a mutation run exposed — remove the check and the case still
      // passed, because something else was rejecting the event.
      const shadow = await parkRequest(supervisor, harness, runId, {
        requestId: "req-shape-b",
        toolName: "Bash",
        description: "pwd",
        input: { command: "pwd" },
      });
      db.prepare("DELETE FROM asks WHERE id = ?").run(shadow.askId);
      const beforeShadow = db.prepare("SELECT COUNT(*) AS n FROM asks WHERE run_id = ?").get(runId).n;

      // Malformed: a parked id, but no toolName.
      emit({ type: "approval.request", runId, requestId: "req-shape-b", input: { command: "pwd" } });
      // Malformed: a "question" with no questions to answer.
      emit({ type: "approval.request", runId, requestId: "req-shape-b", toolName: "AskUserQuestion", requiresUserInteraction: true, input: {} });
      await sleep(400);

      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM asks WHERE run_id = ?").get(runId).n,
        beforeShadow,
        "a malformed event for a genuinely parked request still wrote no row",
      );

      assert.equal(before + 1, beforeMalformed, "only the one well-formed request had produced a row");
      assert.equal((await supervisor.answerAsk(real.askId, { allow: false, answeredBy: "operator" })).delivered, true);
      console.log("  13. five malformed approval.request events wrote nothing, including one for a genuinely parked request");
    }

    // ── 14. a resolved ask's payload stops holding the raw arguments ────────────────
    // Both reviewers found that the payload was stored unredacted while 0004's own comment
    // claimed otherwise. The resolution taken (see the migration): a human cannot approve a
    // command they cannot read, so the full input is kept for the DECISION WINDOW and reduced to
    // a hash plus a bounded preview once the ask is settled.
    {
      const runId = await startRun("case 14");
      const secret = "curl -H 'Authorization: Bearer sk-live-do-not-log' https://api.example.com";
      const ask = await parkRequest(supervisor, harness, runId, {
        requestId: "req-secret",
        toolName: "Bash",
        description: "curl an API",
        input: { command: secret },
      });

      // While pending: the operator must be able to see exactly what they are approving.
      assert.equal(
        supervisor.asks({ runId }).find((a) => a.askId === ask.askId).payload.input.command,
        secret,
        "the full command is visible while the decision is pending — approving what you cannot read is worse",
      );

      assert.equal((await supervisor.answerAsk(ask.askId, { allow: false, answeredBy: "operator" })).delivered, true);

      const stored = askRow(db, ask.askId).payload_json;
      assert.ok(!stored.includes("sk-live-do-not-log"), `the secret must not remain in the row: ${stored}`);
      const reduced = JSON.parse(stored);
      assert.equal(reduced.redacted, true);
      assert.equal(reduced.toolName, "Bash", "what was asked is still on the record");
      assert.match(reduced.inputSha256, /^[0-9a-f]{64}$/, "with a hash, so the exact call can still be confirmed");
      console.log("  14. the payload was readable while pending and reduced to a hash once resolved");
    }
    // ── 15. a replayed approval.request for a settled request creates nothing ───────
    // Found while writing case 10, by neither reviewer: `resume()` calls `pump.resetRun()` +
    // `attach()`, and the adapters' `observe()` yields from the START of their buffered event log,
    // so the entire history is replayed. Taking the generation from the event (case 10) makes the
    // replay collide with its own original row and so be harmless — but only while that row still
    // exists. Deleting it first isolates the guard that actually refuses a replay: nothing is
    // parked, so there is nothing to ask.
    {
      const runId = await startRun("case 15");
      const ask = await parkRequest(supervisor, harness, runId, {
        requestId: "req-replayed",
        toolName: "Bash",
        description: "echo hi",
        input: { command: "echo hi" },
      });
      assert.equal((await supervisor.answerAsk(ask.askId, { allow: true, answeredBy: "operator" })).delivered, true);
      // The row is gone — as it would be for a request that was never recordable, or after any
      // future retention pruning.
      db.prepare("DELETE FROM asks WHERE id = ?").run(ask.askId);
      assert.equal(harness.pendingApprovals(runId).length, 0, "and nothing is parked any more");

      // Replay the historical event, exactly as re-attaching does.
      const run = harness._runs.get(runId);
      const historical = run.events.find((e) => e.type === "approval.request" && e.requestId === "req-replayed");
      assert.ok(historical, "the historical event is still in the adapter's log, which is why replay happens");
      run.events.push(historical);
      for (const wake of run.waiters) wake();
      run.waiters.clear();
      await sleep(400);

      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM asks WHERE run_id = ? AND harness_request_id = 'req-replayed'").get(runId).n,
        0,
        "a replayed request that nothing is parked on must not reappear as a pending ask",
      );
      assert.equal(supervisor.asks({ runId }).length, 0, "so the run is not shown as blocked on a settled call");
      console.log("  15. a replayed approval.request for a request nothing is waiting on created no phantom ask");
    }
  } finally {
    if (supervisor) await supervisor.shutdown({ timeoutMs: 4000 }).catch(() => {});
    if (harness) await harness.disposeAll({ graceMs: 200 }).catch(() => {});
    // Belt and braces: any group this test verified must not outlive it.
    for (const pgid of liveGroups) {
      if (Number.isInteger(pgid) && pgid > 1) await killProcessGroup(pgid, { graceMs: 100 }).catch(() => {});
    }
    if (db) closeDb(db);
    rmScratchDir(stateDir);
  }
});
