// assignment.test.js — harness/model assignment (PLAN.md section 11) and per-task-type workflow profiles.
//
// ROADMAP's Phase 5 asked for three things by name, and each has a case here for a specific reason:
//
//   * **`harness-defaults.json`** — read from disk, per-role, global with per-team override. The override
//     must merge PER FIELD; whole-object replacement works until someone writes a partial override, which
//     is the only kind anyone writes.
//   * **Idempotency keys** — a double-clicked confirm button must not start two runs for one worker. The
//     key is claimed BEFORE any spawn, because the window between the first `await` and the write is
//     exactly where the duplicate happens.
//   * **Partial-start compensation** — "a start that partially succeeds must not leave an orphaned run
//     with no task, or a task stuck in `starting` forever."
//
// And the profiles, whose whole point is that they change behaviour without adding state machine edges: an
// `adhoc` task has no reviewers (PLAN.md §10) and therefore needs ZERO reviewer verdicts to be approved,
// while a `feature` task needs two. That is a guard parameter, not a second diagram.
//
// Cases:
//   1. the config loads: built-in defaults when absent, the file when present, per-FIELD team override
//   2. a malformed config THROWS and a missing one does not — loud on a typo, quiet on absence
//   3. a plan fills the profile's roles from real workers, and names what it cannot fill
//   4. `assignTask` starts a run per role, records the assignment, and moves created -> starting -> planning
//   5. the same idempotency key does not start anything twice
//   6. a PARTIAL start keeps what worked, records the failure, and does not sit in `starting`
//   7. when NOTHING starts, the task lands in `start-failed` rather than `starting`
//   8. a task with nobody to do the work is refused, and stays in `created`
//   9. profiles: an adhoc task needs no verdicts to be approved; a feature task needs two
//  10. a failed role reaches the tier-3 handoff as a BLOCKER
//  11. a utility-task-lane task type (PLAN.md §16.2) actually starts a real run through assignTask,
//      not just its pieces tested in isolation (added 2026-09-11)
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  openDb, closeDb, upsertHarness, createWorker, createTask, recordTransition, latestTaskHandoff,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { loadHarnessDefaults, assignmentFor, BUILT_IN_DEFAULTS, CONFIG_FILENAME } from "../../config/harness-defaults.js";
import { planAssignment, isActionable } from "../../domain/assignment.js";
import { profileFor, rolesFor, requiredVerdictsFor } from "../../domain/workflow-profiles.js";
import { makeScratchDir, rmScratchDir, runTest, sleep } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

await runTest("harness/model assignment", async () => {
  const stateDir = makeScratchDir("supervisor-assignment-test");
  let db;
  let supervisor;
  const harnesses = [];

  /** A supervisor whose `fake` harness can be told to fail the next start, for the partial-start cases. */
  function makeSupervisor(extra = {}) {
    const fake = createFakeHarness({ label: "assign" });
    harnesses.push(fake);
    const adapters = { fake, ...extra.adapters };
    const s = createSupervisor({ db, stateDir, adapters, askSweepIntervalMs: 0, logger: quiet });
    return s;
  }

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake" });

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    {
      const absent = loadHarnessDefaults({ stateDir });
      assert.equal(absent.source, "built-in", "a MISSING file is normal — nothing ships one");
      assert.deepEqual(absent.global.coder, BUILT_IN_DEFAULTS.coder, "and PLAN.md §11's own table is the fallback");

      // PLAN.md §11's example verbatim, comments and all: a file copied from the design must load.
      const written = `{
        // the design document's own example
        "global": {
          "coder":          { "harnessId": "claude-code", "model": "sonnet",  "effort": "medium" },
          "reviewer2":      { "harnessId": "opencode",    "model": "gpt-5.6", "effort": "medium" }
        },
        "perTeam": {
          "vite-migration": { "reviewer2": { "model": "gpt-5.6-luna" } }
        }
      }`;
      const cfg = loadHarnessDefaults({ fileText: written });
      assert.equal(cfg.source, "file");
      assert.equal(cfg.global.reviewer2.harnessId, "opencode");
      assert.equal(cfg.global.parentReviewer.harnessId, "claude-code", "roles the file omits fall back to built-ins");

      // PER FIELD. The override sets only the model; the harness must survive.
      const overridden = assignmentFor(cfg, "reviewer2", { teamId: "vite-migration" });
      assert.equal(overridden.model, "gpt-5.6-luna", "the per-team override applies");
      assert.equal(overridden.harnessId, "opencode",
        "and merges per FIELD — a partial override must not blank the harness, which is the only kind of override anyone writes");
      assert.equal(overridden.overridden, true, "and says it was overridden, so a human can trace the choice");
      assert.equal(assignmentFor(cfg, "reviewer2", { teamId: "other-team" }).model, "gpt-5.6",
        "another team is unaffected");
      console.log("  1. the config loads, and a per-team override merges per field");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    // Loud on a typo, quiet on absence — the asymmetry is deliberate. Someone who wrote `modell` intended
    // to change something, and running with their intent silently dropped is the intent-versus-reality
    // mismatch FINDINGS §31 exists to prevent.
    {
      assert.throws(() => loadHarnessDefaults({ fileText: "{ not json" }), /not valid JSON/);
      assert.throws(() => loadHarnessDefaults({ fileText: '["an","array"]' }), /must be a JSON object/);
      assert.throws(
        () => loadHarnessDefaults({ fileText: '{"global":{"coder":{"modell":"opus"}}}' }),
        /unknown key\(s\) modell/,
        "a misspelled key must be reported, not ignored — ignoring it makes the setting appear to have no effect",
      );
      assert.throws(() => loadHarnessDefaults({ fileText: '{"global":{"coder":{"harnessId":42}}}' }), /must be a string/);
      // clearPolicy is a real ASSIGNMENT_KEYS member (so it isn't reported as an unknown key), but its
      // VALUE was never checked against CLEAR_POLICIES until now — a typo used to pass silently, which
      // is exactly the "malformed file throws" asymmetry this case is about.
      assert.throws(
        () => loadHarnessDefaults({ fileText: '{"global":{"coder":{"clearPolicy":"on-demandd"}}}' }),
        /clearPolicy.*must be one of/,
        "an unrecognized clearPolicy value must be reported, not silently accepted",
      );
      const validPolicy = loadHarnessDefaults({ fileText: '{"global":{"coder":{"clearPolicy":"always"}}}' });
      assert.equal(validPolicy.global.coder.clearPolicy, "always", "a recognized clearPolicy value must load through unchanged");
      console.log("  2. a malformed config throws and names the mistake; a missing one does not");
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      const config = loadHarnessDefaults({ stateDir });
      // Listed in the OPPOSITE order to the one the plan must produce, so "stable order" is a real claim:
      // with the reviewers already sorted, insertion order and nickname order agree and the assertion would
      // pass for either implementation.
      const workers = [
        { workerId: "w-c", nickname: "purus", role: "coder" },
        { workerId: "w-r2", nickname: "zterra", role: "reviewer" },
        { workerId: "w-r1", nickname: "aluna", role: "reviewer" },
      ];
      const plan = planAssignment({ task: { id: "t", type: "feature" }, workers, config });
      assert.deepEqual(plan.slots.map((s) => s.configSlot), ["coder", "reviewer1", "reviewer2"],
        "the profile's two reviewers consume reviewer1 AND reviewer2, not the same slot twice");
      assert.deepEqual(plan.slots.map((s) => s.workerId), ["w-c", "w-r1", "w-r2"],
        "reviewers are numbered in a STABLE order (by nickname), because which one is reviewer2 decides its harness");
      assert.equal(plan.slots[2].harnessId, "opencode",
        "and PLAN.md §11's point survives: reviewer2 is on a DIFFERENT harness, which is why the slots are configured separately");

      // A role with no worker is named, not papered over — a worker is a persistent named identity and is
      // not something the assignment step invents.
      const short = planAssignment({ task: { id: "t", type: "feature" }, workers: [workers[0]], config });
      assert.equal(short.slots.length, 1);
      assert.equal(short.unfillable.length, 2);
      assert.match(short.unfillable[0].reason, /no worker with role "reviewer"/);
      assert.equal(isActionable(short).ok, true, "and it is still actionable: the coder can work while reviewers are retried");

      const noCoder = planAssignment({ task: { id: "t", type: "feature" }, workers: [workers[1]], config }); // reviewers only
      assert.equal(isActionable(noCoder).ok, false, "but a task with nobody to do the WORK is not");
      assert.match(isActionable(noCoder).reason, /nobody to do the work/);
      console.log("  3. a plan fills the profile's roles in a stable order and names what it cannot fill");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    // A `chore`: one coder, no reviewers, so the whole happy path fits in one start.
    {
      createTask(db, { id: "t-ok", title: "assign me", type: "chore" });
      createWorker(db, { workerId: "w-ok", nickname: "purus", role: "coder", taskId: "t-ok" });
      supervisor = makeSupervisor();
      await supervisor.boot();

      const preview = supervisor.assignmentPreview("t-ok");
      assert.deepEqual(preview.slots.map((s) => s.role), ["coder"], "a chore needs one coder (workflow profile)");
      assert.equal(preview.slots[0].harnessId, "claude-code", "pre-filled from the config, which is what §11's picker shows");

      // ...but this test has no `claude-code` adapter, so the override is what makes the start real. That
      // is also exactly §11's "changing the dropdown before confirming overrides for this one task
      // instance only".
      const res = await supervisor.assignTask("t-ok", { overrides: { coder: { harnessId: "fake" } }, actor: "tester", cwd: stateDir });
      assert.equal(res.assigned, true, `the assignment must start something; got ${JSON.stringify(res)}`);
      assert.equal(res.started.length, 1);
      assert.equal(res.started[0].harnessId, "fake", "the override won, for this instance");
      assert.equal(res.state, "planning", "created -> starting -> planning, walked through the real state machine");
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-ok'").get().state, "planning");

      // Recorded on the task, which is §11's own instruction.
      const record = JSON.parse(db.prepare("SELECT harness_assignments_json AS j FROM tasks WHERE id='t-ok'").get().j);
      assert.equal(record.status, "done");
      assert.equal(record.slots[0].workerId, "w-ok");
      assert.equal(record.report.started[0].runId, res.started[0].runId, "with the run it actually started");
      // The stored default is NOT rewritten by an override (§11).
      assert.equal(loadHarnessDefaults({ stateDir }).global.coder.harnessId, "claude-code",
        "an override changes this task instance, never the stored default");
      console.log("  4. assignTask started the role, recorded it, and walked the task to planning");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    // The double-clicked confirm button.
    {
      createTask(db, { id: "t-idem", title: "click twice", type: "chore" });
      createWorker(db, { workerId: "w-idem", nickname: "twice", role: "coder", taskId: "t-idem" });

      const opts = { overrides: { coder: { harnessId: "fake" } }, actor: "tester", idempotencyKey: "key-1", cwd: stateDir };

      // CONCURRENTLY, and that is the whole point of the case. Two SEQUENTIAL calls prove only that a
      // finished assignment is remembered — which is true even if the key is claimed after the spawns,
      // since by then the record exists. Mutation N1 moves the claim below the spawns and a sequential
      // test passed it. The duplicate-start window is the gap between the first `await` and the write, so
      // the second call has to arrive INSIDE that window or the assertion is about something else.
      const [first, second] = await Promise.all([
        supervisor.assignTask("t-idem", opts),
        supervisor.assignTask("t-idem", opts),
      ]);
      const winners = [first, second].filter((r) => r.started?.length);
      const echoes = [first, second].filter((r) => r.idempotent);
      assert.equal(winners.length, 1, `exactly one of two concurrent confirms may start anything; got ${JSON.stringify([first, second])}`);
      assert.equal(echoes.length, 1, "and the other must recognise the key rather than doing the work again");

      const runsForWorker = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE worker_id = 'w-idem'").get().n;
      assert.equal(runsForWorker, 1, `exactly one run for one confirm; found ${runsForWorker}`);
      // A different key is a genuine retry, and there is nothing left to start because the worker is busy.
      const retry = await supervisor.assignTask("t-idem", { ...opts, idempotencyKey: "key-2" });
      assert.equal(retry.started.length, 0, "a retry must not start a second run for a worker that is working");
      assert.equal(retry.alreadyRunning.length, 1, "it reports the role as already running instead");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE worker_id = 'w-idem'").get().n, 1);
      console.log("  5. one idempotency key, one start — and a retry skips a worker that is already running");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    // THE COMPENSATION DECISION, asserted. The coder starts, the reviewer's harness does not exist, and the
    // task must keep the coder and move on rather than sit in `starting` or throw away real work.
    {
      createTask(db, { id: "t-partial", title: "half a start", type: "bug" });
      createWorker(db, { workerId: "w-pc", nickname: "coder-p", role: "coder", taskId: "t-partial" });
      createWorker(db, { workerId: "w-pr", nickname: "rev-p", role: "reviewer", taskId: "t-partial" });

      const res = await supervisor.assignTask("t-partial", {
        overrides: { coder: { harnessId: "fake" }, reviewer1: { harnessId: "does-not-exist" } },
        actor: "tester", cwd: stateDir,
      });
      assert.equal(res.partial, true, "a partial start is a named outcome, not two array lengths to compare");
      assert.equal(res.started.length, 1, "the coder started");
      assert.equal(res.started[0].workerId, "w-pc");
      assert.equal(res.state, "planning", "and the task moved on — NOT stuck in `starting` forever");
      const failure = res.failures.find((f) => f.kind === "start-failed");
      assert.ok(failure, `the failure must be recorded; got ${JSON.stringify(res.failures)}`);
      assert.equal(failure.role, "reviewer");
      assert.match(failure.reason, /no adapter registered/, "with the real reason, so a retry is informed");

      // The coder is genuinely still alive: "keep what worked" is the whole decision.
      const coderRun = db.prepare("SELECT ended_at FROM runs WHERE worker_id = 'w-pc'").get();
      assert.equal(coderRun.ended_at, null, "the run that worked was NOT killed to preserve a symmetry nothing needs");

      // And a partial start cannot become a completed task by accident: the profile's verdicts still gate
      // `approved`, and `merged` still needs a human. This is the caveat both reviewers raised.
      assert.equal(requiredVerdictsFor("bug"), 1);
      assert.throws(
        () => recordTransition(db, { id: "tr-p1", taskId: "t-partial", fromState: "planning", toState: "merged", actor: "tester", humanApproved: true }),
        /not an edge/,
        "a partially-started task has no shortcut to merged",
      );
      console.log("  6. a partial start kept the coder, recorded the failure, and moved the task on");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    {
      createTask(db, { id: "t-none", title: "nothing starts", type: "chore" });
      createWorker(db, { workerId: "w-none", nickname: "doomed", role: "coder", taskId: "t-none" });
      const res = await supervisor.assignTask("t-none", {
        overrides: { coder: { harnessId: "also-not-real" } }, actor: "tester", cwd: stateDir,
      });
      assert.equal(res.assigned, false);
      assert.equal(res.state, "start-failed",
        "with NOTHING running, the task must not sit in `starting` waiting for a process that will never report");
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-none'").get().state, "start-failed");
      // And `start-failed` is a state you can come back from, explicitly (PLAN.md §6).
      recordTransition(db, { id: "tr-retry", taskId: "t-none", fromState: "start-failed", toState: "created", actor: "tester", explicitRetry: true });
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-none'").get().state, "created");
      console.log("  7. when nothing starts, the task lands in start-failed and can be retried");
    }

    // ── 8 ────────────────────────────────────────────────────────────────────────────
    {
      createTask(db, { id: "t-empty", title: "no workers at all", type: "feature" });
      const res = await supervisor.assignTask("t-empty", { actor: "tester", cwd: stateDir });
      assert.equal(res.assigned, false);
      assert.match(res.refused, /nobody to do the work/);
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-empty'").get().state, "created",
        "nothing was started, so nothing changed — the task stays where it was");
      assert.equal(db.prepare("SELECT harness_assignments_json AS j FROM tasks WHERE id='t-empty'").get().j, null,
        "and no assignment record was written for an assignment that did not happen");
      console.log("  8. a task with nobody to do the work is refused and stays in created");
    }

    // ── 9 ────────────────────────────────────────────────────────────────────────────
    // The profiles' one connection to the state machine, and the reason it is a guard parameter rather than
    // a per-type diagram: PLAN.md §6 warns against adopting states before a runtime exists to test them,
    // and four diagrams would be that warning ignored.
    {
      assert.deepEqual(rolesFor("adhoc"), ["coder"], "PLAN.md §10: an adhoc task is one worker and no reviewers");
      assert.equal(requiredVerdictsFor("adhoc"), 0);
      assert.equal(requiredVerdictsFor("feature"), 2);
      assert.equal(profileFor("something-new").isDefault, true, "an unprofiled type still works, on the stricter default");
      assert.equal(requiredVerdictsFor("something-new"), 2, "and the stricter default is TWO verdicts, not zero");

      createTask(db, { id: "t-adhoc", title: "one-off", type: "adhoc" });
      let s = "created";
      for (const to of ["starting", "planning", "implementing", "awaiting-review"]) {
        recordTransition(db, { id: `tr-a-${to}`, taskId: "t-adhoc", fromState: s, toState: to, actor: "tester" });
        s = to;
      }
      // ZERO verdicts, from the profile, without the caller passing a number: an adhoc task has no
      // reviewers, so under the default of 2 it could never be approved at all.
      //
      // Wrapped so that a REFUSAL is an assertion failure rather than a bare throw. `recordTransition`
      // throws when it refuses, and the mutation harness only credits a mutation caught by a real
      // `AssertionError` — mutation N7 (ignore the task type) made this line throw, which proved nothing
      // until it was wrapped. Same rule as FINDINGS §22.1, in a new file.
      try {
        recordTransition(db, { id: "tr-a-app", taskId: "t-adhoc", fromState: "awaiting-review", toState: "approved", actor: "tester", reviewerVerdicts: 0 });
      } catch (err) {
        assert.fail(
          "an adhoc task has NO reviewers (PLAN.md §10), so its profile requires zero verdicts and this "
          + `must be allowed; the transition was refused: ${err.message}`,
        );
      }
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-adhoc'").get().state, "approved");

      // A feature task with zero verdicts is refused by the same mechanism — the profile supplies the
      // number, so this asserts the type actually reaches the guard.
      createTask(db, { id: "t-feat", title: "needs review", type: "feature" });
      s = "created";
      for (const to of ["starting", "planning", "implementing", "awaiting-review"]) {
        recordTransition(db, { id: `tr-f-${to}`, taskId: "t-feat", fromState: s, toState: to, actor: "tester" });
        s = to;
      }
      assert.throws(
        () => recordTransition(db, { id: "tr-f-app", taskId: "t-feat", fromState: "awaiting-review", toState: "approved", actor: "tester", reviewerVerdicts: 0 }),
        /needs 2 reviewer verdict/,
        "the SAME transition on a feature task is refused — the profile is what makes the difference",
      );
      // And no reviewers never means no human: §6's hard rule is untouched by any profile.
      assert.throws(
        () => recordTransition(db, { id: "tr-a-merge", taskId: "t-adhoc", fromState: "approved", toState: "merged", actor: "tester" }),
        /no autonomous merges/,
        "an adhoc task with zero required verdicts STILL cannot merge without a human",
      );
      console.log("  9. profiles change the verdict requirement per type, without adding a single edge");
    }

    // ── 10 ───────────────────────────────────────────────────────────────────────────
    // Recording a failure and never surfacing it is how "not stuck in starting forever" becomes "silently
    // short a reviewer forever" instead.
    {
      const doc = latestTaskHandoff(db, "t-partial")?.doc;
      assert.ok(doc, "the assignment regenerated the handoff (Rule 4: regenerated on transition)");
      const blockers = doc.slice(doc.indexOf("## Blockers"), doc.indexOf("## Current diff shape"));
      assert.match(blockers, /role not started/, "a role that failed to start is a BLOCKER a human can act on");
      assert.match(blockers, /reviewer/);
      assert.match(blockers, /retry the assignment/, "and the document says what to do about it");
      console.log("  10. a failed role reaches the tier-3 handoff as a blocker");
    }

    // ── 11 ───────────────────────────────────────────────────────────────────────────
    // THE UTILITY-TASK LANE (PLAN.md §16.2) IS ACTUALLY REACHABLE THROUGH assignTask, not just its
    // pieces in isolation. Testing rolesFor()/ensureWorkerPrincipal() separately (as the first pass of
    // this lane did) was NOT sufficient — `isActionable` had never heard of these roles and refused
    // every one of these four task types before launch, even with a correctly-configured worker present.
    // Codex review (`codexdoc/REVIEW-NOTES.md` finding 7), fixed 2026-09-11.
    {
      createTask(db, { id: "t-util", title: "a real git-push-task", type: "git-push-task" });
      createWorker(db, { workerId: "w-util", nickname: "runner", role: "git-push-runner", taskId: "t-util" });

      const preview = supervisor.assignmentPreview("t-util");
      assert.deepEqual(preview.slots.map((s) => s.role), ["git-push-runner"]);

      // review-consolidated-2026-09-14.md finding 4: the fake harness declares no `mcpConfigDelivery`,
      // so a git-push-runner's declared `leo-mcp` need can never be delivered here — `assignTask` now
      // fails closed on that by default. This case is about the utility-task lane reaching `assignTask`
      // at all, not about MCP delivery, so it opts into the degraded run explicitly.
      const res = await supervisor.assignTask("t-util", {
        overrides: { "git-push-runner": { harnessId: "fake" } }, actor: "tester", cwd: stateDir,
        allowDegradedMcp: true,
      });
      assert.equal(res.assigned, true, `a real run must actually start for a utility task; got ${JSON.stringify(res)}`);
      assert.equal(res.started.length, 1);
      assert.equal(res.started[0].role, "git-push-runner");
      assert.equal(res.state, "planning", "created -> starting -> planning, the same real state machine every task walks");
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-util'").get().state, "planning");
      console.log("  11. a git-push-task's real run starts through assignTask — the utility-task lane is actually reachable");
    }
  } finally {
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* teardown */ }
    for (const h of harnesses) { try { await h.disposeAll?.({ graceMs: 300 }); } catch { /* teardown */ } }
    try { if (db) closeDb(db); } catch { /* teardown */ }
    await sleep(150);
    // The config file, if a case wrote one.
    try { fs.rmSync(path.join(stateDir, CONFIG_FILENAME), { force: true }); } catch { /* best effort */ }
    rmScratchDir(stateDir);
  }
});
