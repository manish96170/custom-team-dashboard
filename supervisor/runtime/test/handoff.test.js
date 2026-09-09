// handoff.test.js — the tier-3 task handoff (PLAN.md section 8, Rule 4).
//
// The Phase 2 requirement is "generated at least once here, even if only manually triggered —
// prove the mechanism, not just the schema". So these cases do not check that a table exists; they
// check that a real document comes out with real facts in it, that it stays inside Rule 4's one-page
// budget, and that the two things a summary can do wrong are prevented:
//
//   * inventing content it has no source for  -> `Assumptions` only ever QUOTES tier 2, never infers
//   * looking complete while being truncated  -> truncation is stated in the document itself
//
// A handoff's readers are AGENTS that will act on it, which is why both of those are failures rather
// than blemishes.
//
// Cases:
//   1. a real handoff is generated and persisted, with all six of Rule 4's sections
//   2. it reports the facts it was given — state, transitions, workers, runs
//   3. open asks and orphans appear as BLOCKERS; nothing blocked says so
//   4. `Assumptions` quotes tier-2 digests, and each of the two empty cases says which kind it is
//   5. the one-page budget is enforced, and a truncated handoff SAYS it was truncated
//   6. `sources` records what the document was built from, so it is auditable
//   7. regeneration APPENDS (history is kept) and the newest is what a reader gets
//   8. preflight runs are excluded — a handoff is the most human-facing view there is
//   9. a missing worktree/base_rev degrades to a note, and never loses the other sections
//  10. a transition MOVES tasks.state (the defect the Phase 2 gate run exposed)
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import {
  openDb,
  closeDb,
  upsertHarness,
  createWorker,
  createTask,
  createRun,
  createAsk,
  recordEvent,
  recordTransition,
  latestTaskHandoff,
  listTaskHandoffs,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { generateTaskHandoff, renderHandoff, collectHandoffFacts, DEFAULT_BUDGET_CHARS } from "../../handoff/generate.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

const SECTIONS = ["## Goal", "## Decisions", "## Assumptions", "## Artifacts", "## Blockers", "## Current diff shape"];

/**
 * One named section of the document.
 *
 * Needed because searching the WHOLE document for a state is a VACUOUS assertion: the state also
 * appears in the journal-derived Decisions list, so "the handoff shows in-review" passed while the
 * Goal section still said `created`. That is how a real defect hid -- `recordTransition` journalled
 * the move without updating `tasks.state` -- and it was the Phase 2 gate run, not this suite, that
 * exposed it. Assert against the section that is supposed to carry the fact.
 */
function section(doc, heading) {
  const start = doc.indexOf(heading);
  if (start < 0) return "";
  const next = SECTIONS.map((h) => doc.indexOf(h, start + heading.length)).filter((i) => i > 0);
  return doc.slice(start, next.length ? Math.min(...next) : doc.length);
}

await runTest("tier-3 task handoff", async () => {
  const stateDir = makeScratchDir("supervisor-handoff-test");
  let db;
  let supervisor;

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createTask(db, { id: "t1", title: "Wire the approval round trip", type: "feature" });
    createWorker(db, { workerId: "w-coder", nickname: "coder-1", role: "coder", taskId: "t1" });
    createWorker(db, { workerId: "w-rev", nickname: "reviewer-1", role: "reviewer", taskId: "t1" });

    supervisor = createSupervisor({ db, adapters: { fake: createFakeHarness({ label: "handoff" }) }, logger: quiet, askSweepIntervalMs: 0 });
    await supervisor.boot();

    // A task with real history on it: two transitions, two workers, one finished run, one open run.
    // PLAN.md section 6's real state names. These used to be `in-progress` / `in-review`, which appear
    // nowhere in the design — the drift `canTransition` now makes impossible (Phase 5).
    //
    // Wrapped in a catch that ASSERTS, because this walk is setup rather than a numbered case: each
    // step passes the state the previous one should have produced, so a regression that journals a
    // transition without moving `tasks.state` makes step two throw a stale-`fromState` error before any
    // case runs. Without `assert.fail` that surfaces as a bare crash, and the mutation harness credits
    // a crash to nothing (FINDINGS §22.1's rule).
    try {
      recordTransition(db, { id: "tr2", taskId: "t1", fromState: "created", toState: "starting", actor: "cto" });
      recordTransition(db, { id: "tr3", taskId: "t1", fromState: "starting", toState: "planning", actor: "coder-1" });
      recordTransition(db, { id: "tr4", taskId: "t1", fromState: "planning", toState: "implementing", actor: "coder-1" });
    } catch (err) {
      assert.fail(
        "the setup walk created -> starting -> planning -> implementing must succeed; each step passes "
        + `the state the previous one should have produced, so this failing means a transition did not `
        + `move tasks.state: ${err.message}`,
      );
    }
    assert.equal(db.prepare("SELECT state FROM tasks WHERE id = 't1'").get().state, "implementing",
      "and the task must actually be in the state the walk left it in");
    createRun(db, { runId: "r-done", workerId: "w-coder", harnessId: "fake", prompt: "implement it" });
    db.prepare(`UPDATE runs SET ended_at = datetime('now'), exit_reason = 'finished' WHERE run_id = 'r-done'`).run();
    createRun(db, { runId: "r-open", workerId: "w-rev", harnessId: "fake", prompt: "review it" });
    for (let i = 0; i < 5; i += 1) {
      recordEvent(db, { runId: "r-done", tier: 1, type: "assistant.delta", payload: { text: `chunk ${i}` } });
    }

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    let first;
    {
      first = supervisor.taskHandoff("t1", { reason: "manual" });
      assert.ok(first.id, "the handoff must be persisted, not just returned");
      assert.ok(first.doc.length > 0);
      for (const heading of SECTIONS) {
        assert.ok(first.doc.includes(heading), `Rule 4's "${heading}" section is missing from the document`);
      }
      const stored = latestTaskHandoff(db, "t1");
      assert.equal(stored.doc, first.doc, "what was stored is what was returned");
      assert.equal(stored.reason, "manual");
      console.log("  1. a handoff was generated, persisted, and has all six Rule 4 sections");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    {
      const goal = section(first.doc, "## Goal");
      assert.ok(goal.includes("Wire the approval round trip"), "the goal must be the task's actual title");
      // In the GOAL section specifically. `tasks.state` is the authoritative column, and searching
      // the whole document would also match the Decisions list — which is exactly how the
      // journal-vs-column divergence went unnoticed until the gate run.
      assert.ok(goal.includes("implementing"),
        `the Goal must carry the task's CURRENT state from tasks.state; got:\n${goal}`);
      assert.ok(first.doc.includes("`starting` → `planning`"), "transitions appear as decisions, with direction");
      assert.ok(first.doc.includes("coder-1") && first.doc.includes("reviewer-1"),
        "both workers on the task are named, so a reader knows who to ask");
      assert.ok(/Runs: 2 total, 1 still open/.test(first.doc), `run counts must be real; got:\n${first.doc}`);
      assert.ok(/5 tier-1 event\(s\)/.test(first.doc), "activity is COUNTED — the one place tier 1 is touched, never quoted");
      console.log("  2. the document reports the facts it was given, not a template");
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      assert.ok(first.doc.includes("_Nothing is blocked._"), "with nothing blocked, say so plainly");

      createAsk(db, { id: "ask-1", runId: "r-open", taskId: "t1", kind: "tool-approval", question: "may I force-push?" });
      db.prepare(`UPDATE runs SET lifecycle = 'orphaned-unmanaged', pid = 4242 WHERE run_id = 'r-open'`).run();

      const withBlockers = supervisor.taskHandoff("t1", { reason: "manual" });
      assert.ok(withBlockers.doc.includes("may I force-push?"), "an unresolved ask IS a blocker — a worker is stopped on it");
      assert.ok(withBlockers.doc.includes("awaiting approval"), "and its kind is stated, because the action differs");
      assert.ok(withBlockers.doc.includes("orphaned process"), "an orphan is a blocker too: it needs reaping or adopting");
      assert.ok(withBlockers.doc.includes("4242"), "with the pid, so it is actionable rather than a notification");
      assert.equal(withBlockers.doc.includes("_Nothing is blocked._"), false);
      console.log("  3. asks and orphans surfaced as actionable blockers");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    // The most important negative in the file. A handoff read by agents that will act on it must
    // never invent a decision or an assumption nobody made.
    //
    // Three branches now that tier 2 feeds this section, and the reason all three are asserted is that
    // the two empty ones are DIFFERENT FACTS: "no turn has been summarised" and "every turn was
    // summarised and none stated an assumption" look identical in a document that says only "none", and
    // a reader acts differently on each — the first means go and look, the second means there is nothing
    // to look at.
    {
      const noSource = section(latestTaskHandoff(db, "t1").doc, "## Assumptions");
      assert.ok(noSource.includes("None recorded"), "with no tier-2 digest at all, the section is empty");
      assert.ok(/no tier-2 source/.test(noSource), "and says the SOURCE is missing, not that nothing was assumed");
      assert.ok(/worse than/.test(noSource), "and says WHY it is empty, so nobody 'helpfully' fills it in with a guess");

      // A digested turn that stated nothing. This is what the extractive digester always produces
      // (domain/turn-digest.js: it cannot label an assumption without inventing one).
      recordEvent(db, {
        runId: "r-done", tier: 2, type: "turn.digest",
        payload: { turnIndex: 0, summary: "used Read, Edit.", assumptions: [], source: "extractive" },
      });
      const digestedNone = section(supervisor.taskHandoff("t1", { reason: "manual" }).doc, "## Assumptions");
      assert.ok(digestedNone.includes("None stated"), "a digested turn with no assumption reads differently");
      assert.ok(/1 turn\(s\) have been digested/.test(digestedNone),
        "and says how many turns were summarised, which is what makes the emptiness a finding rather than a gap");
      assert.equal(/no tier-2 source/.test(digestedNone), false, "and no longer claims the source is missing");

      // ...and one that did. Quoted, with attribution, because a reader who cannot check an assumption
      // has to either trust it or discard it.
      recordEvent(db, {
        runId: "r-done", tier: 2, type: "turn.digest",
        payload: {
          turnIndex: 1,
          summary: "wired the approval path.",
          assumptions: ["the socket is already listening when a hook fires"],
          source: "model",
        },
      });
      const quoted = section(supervisor.taskHandoff("t1", { reason: "manual" }).doc, "## Assumptions");
      assert.ok(quoted.includes("the socket is already listening when a hook fires"),
        "a stated assumption must reach the handoff verbatim — this is the section's whole purpose");
      assert.ok(quoted.includes("r-done") && /turn 1/.test(quoted),
        "attributed to the run and turn it came from, so it can be checked rather than trusted");
      assert.equal(quoted.includes("None stated"), false, "and the empty notice is gone");

      // Restated in a later turn — one assumption to a reader, however many turns mentioned it. Listing
      // it twice would read as two independent statements of something nobody verified.
      recordEvent(db, {
        runId: "r-done", tier: 2, type: "turn.digest",
        payload: {
          turnIndex: 2,
          summary: "kept going.",
          assumptions: ["The socket is   ALREADY listening when a hook fires"],
          source: "model",
        },
      });
      const restated = section(supervisor.taskHandoff("t1", { reason: "manual" }).doc, "## Assumptions");
      const occurrences = (restated.match(/already listening when a hook fires/gi) ?? []).length;
      assert.equal(occurrences, 1,
        `a restated assumption is listed once, whatever its casing or spacing; found ${occurrences} in:\n${restated}`);

      // The negative that holds in ALL THREE branches: nothing here may be tier 3's own inference.
      for (const [label, sec] of [["no source", noSource], ["digested, none", digestedNone], ["quoted", quoted]]) {
        assert.equal(/\bI assume\b|\blikely\b|\bprobably\b/.test(sec), false,
          `the Assumptions section must not contain inferred language (${label})`);
      }
      console.log("  4. Assumptions quotes tier 2, and both empty cases say WHICH kind of empty they are");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    {
      const generous = supervisor.taskHandoff("t1", { reason: "manual" });
      assert.equal(generous.truncated, false, "precondition: this task's handoff fits in one page");
      assert.ok(generous.chars <= DEFAULT_BUDGET_CHARS, `a handoff must fit Rule 4's budget; got ${generous.chars}`);

      const tiny = supervisor.taskHandoff("t1", { reason: "manual", budgetChars: 400 });
      assert.equal(tiny.truncated, true, "a document over budget must be truncated");
      assert.ok(tiny.chars <= 400 + 200, "and cut to roughly the budget, plus the notice");
      assert.ok(tiny.doc.includes("handoff truncated"),
        "and SAY it was truncated — one that looks complete would have its reader treat a missing blocker as an absent one");
      assert.equal(latestTaskHandoff(db, "t1").truncated, 1, "the truncation is recorded on the row too");
      console.log("  5. the one-page budget is enforced, and truncation is stated in the document");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    {
      const h = supervisor.taskHandoff("t1", { reason: "state-transition" });
      assert.equal(h.sources.taskId, "t1");
      assert.equal(h.sources.transitions, 3, "sources record what it SAW, beside what it said");
      assert.equal(h.sources.runs, 2);
      assert.equal(h.sources.openAsks, 1);
      assert.deepEqual(h.sources.askIds, ["ask-1"], "by id, so a claim in the document can be traced to its row");
      assert.equal(h.sources.orphans, 1);
      // Both tier-2 numbers, from case 4's two digests: one stated an assumption, the other did not.
      assert.equal(h.sources.digestedTurns, 3, "how many turns tier 2 summarised");
      assert.equal(h.sources.assumptions, 1, "and how many of them stated an assumption — a different number");

      const stored = JSON.parse(latestTaskHandoff(db, "t1").sources_json);
      assert.deepEqual(stored, h.sources, "and are persisted, or the audit trail dies with the process");
      console.log("  6. sources are recorded and persisted, making the summary auditable");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    {
      const history = listTaskHandoffs(db, "t1");
      assert.ok(history.length >= 5, `regeneration APPENDS; expected the earlier handoffs to survive, got ${history.length}`);
      assert.ok(history[0].id > history[1].id, "newest first");
      assert.equal(latestTaskHandoff(db, "t1").id, history[0].id, "and 'current' means newest");
      assert.equal(history[0].reason, "state-transition", "the trigger is recorded, so Rule 5's claim is checkable later");
      console.log("  7. regeneration appends and keeps history; the newest is current");
    }

    // ── 8 ────────────────────────────────────────────────────────────────────────────
    // A handoff is the most human-facing document in the system, so migration 0005's rule applies
    // with full force: a preflight is not work anyone should read about.
    {
      createWorker(db, { workerId: "w-pf", nickname: "preflight-worker", role: "worker", taskId: "t1" });
      createRun(db, { runId: "r-preflight", workerId: "w-pf", harnessId: "fake", prompt: "reply ok", isPreflight: true });

      const h = supervisor.taskHandoff("t1", { reason: "manual" });
      assert.equal(h.sources.runs, 2, `preflight runs must not be counted; got ${h.sources.runs}`);
      assert.equal(h.doc.includes("preflight-worker"), false, "nor its worker named");
      console.log("  8. preflight runs are excluded from the handoff entirely");
    }

    // ── 9 ────────────────────────────────────────────────────────────────────────────
    // A generator that throws because git is unhappy loses the other five sections, which is the
    // wrong trade: the blockers matter more than the diff.
    {
      const noWorktree = generateTaskHandoff(db, "t1");
      assert.ok(noWorktree.doc.includes("no diff information: no worktree recorded"),
        "a task with no worktree gets a note, not an error");
      assert.equal(noWorktree.sources.diffAvailable, false, "and the sources say the diff was unavailable");
      for (const heading of SECTIONS) assert.ok(noWorktree.doc.includes(heading), `${heading} survived the missing diff`);

      // ...and a git command that fails outright degrades the same way rather than propagating.
      db.prepare(`UPDATE tasks SET worktree_id = '/definitely/not/a/path', base_rev = 'deadbeef' WHERE id = 't1'`).run();
      // Called through a catch so that "the error escaped" is an ASSERTION failure rather than an
      // uncaught throw. The mutation harness only credits a mutation caught by a real
      // AssertionError, and this case's whole mechanism is "a git failure must NOT propagate" — so
      // letting it propagate and end the suite would report the crash as the proof.
      let brokenGit;
      try {
        brokenGit = generateTaskHandoff(db, "t1", {
          exec: () => { throw Object.assign(new Error("fatal: not a git repository"), { shortMessage: "fatal: not a git repository" }); },
        });
      } catch (err) {
        assert.fail(`a failing git call must degrade to a note, not propagate; it threw ${err.message}`);
      }
      assert.ok(brokenGit.doc.includes("no diff information: fatal: not a git repository"),
        "a failing git call is reported, with its reason");
      assert.equal(brokenGit.sources.diffAvailable, false);
      for (const heading of SECTIONS) assert.ok(brokenGit.doc.includes(heading), `${heading} survived the git failure`);
      console.log("  9. a missing worktree and a failing git call both degrade to a note");
    }

    // ── 10 ───────────────────────────────────────────────────────────────────────────
    // The defect the Phase 2 gate run exposed: `recordTransition` journalled a move without
    // updating `tasks.state`, so the handoff's Goal and its own Decisions list disagreed about what
    // state the task was in. Two sources of truth for one fact.
    {
      const before = db.prepare("SELECT state, updated_at FROM tasks WHERE id = 't1'").get();
      recordTransition(db, { id: "tr5", taskId: "t1", fromState: "implementing", toState: "awaiting-review", actor: "reviewer-1" });
      const after = db.prepare("SELECT state, updated_at FROM tasks WHERE id = 't1'").get();
      assert.equal(after.state, "awaiting-review", "a transition must MOVE the task, not just journal it");
      assert.notEqual(after.updated_at, before.updated_at,
        "and move updated_at with it, or the task is invisible to anything ordering by recency");

      const h = supervisor.taskHandoff("t1", { reason: "state-transition" });
      assert.ok(section(h.doc, "## Goal").includes("awaiting-review"),
        "and the handoff's Goal must reflect it — the assertion that used to search the whole document passed while this was broken");

      // A transition from a state the task is NOT in is a lost update, and is refused.
      assert.throws(
        () => recordTransition(db, { id: "tr6", taskId: "t1", fromState: "created", toState: "approved", actor: "someone" }),
        /is in state "awaiting-review", not "created"/,
        "a stale fromState must be refused rather than silently clobbering the current state",
      );
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id = 't1'").get().state, "awaiting-review",
        "and the refusal must leave the state alone");
      // And an ILLEGAL transition is refused too — Phase 5 made PLAN.md section 6's diagram a
      // constraint rather than documentation. Distinct from the stale-`fromState` case above: that one
      // is concurrency control (the task moved under you), this one is policy (that edge does not
      // exist). Both have to hold, and a mutation that computes legality then ignores it only fails
      // here.
      assert.throws(
        () => recordTransition(db, { id: "tr7", taskId: "t1", fromState: "awaiting-review", toState: "merged", actor: "someone", humanApproved: true }),
        /not an edge in the state machine/,
        "awaiting-review -> merged skips `approved`, so it must be refused",
      );
      assert.throws(
        () => recordTransition(db, { id: "tr8", taskId: "t1", fromState: "awaiting-review", toState: "in-review", actor: "someone" }),
        /is not a task state/,
        "and an invented state name must be refused by name",
      );
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id = 't1'").get().state, "awaiting-review",
        "neither refusal may move the task");
      console.log("  10. a transition moves the task's state, and a stale fromState is refused");
    }

    // Print one for real — the Phase 2 requirement is "generated at least once here".
    db.prepare(`UPDATE tasks SET worktree_id = NULL, base_rev = NULL WHERE id = 't1'`).run();
    const final = generateTaskHandoff(db, "t1", { now: "2026-09-07T00:00:00.000Z" });
    console.log("");
    console.log("  ── the generated tier-3 handoff, verbatim ─────────────────────────────");
    for (const line of final.doc.split("\n")) console.log(`  | ${line}`);
    console.log("  ──────────────────────────────────────────────────────────────────────");
  } finally {
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* best effort */ }
    try { if (db) closeDb(db); } catch { /* best effort */ }
    rmScratchDir(stateDir);
  }
});
