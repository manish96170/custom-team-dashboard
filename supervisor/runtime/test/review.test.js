// review.test.js — configurable reviews WIRED INTO THE SUPERVISOR (PLAN.md section 13, migration 0009).
//
// `domain/test/review.test.js` proves the rule without a database. This proves the things it cannot: that the
// profile is imported and ADDRESSABLE BY HASH, that a verdict is stored revision-bound and per-dimension,
// that findings are verified before they are stored rather than after, and that `approved` is a transition
// only the rule can make.
//
// THE ONE THAT MATTERS MOST is case 6. Phase 5 made the state machine enforce its own diagram; before that,
// `canTransition` was documentation. The same trap is available here: a review rule nothing consults is a
// rule the first caller in a hurry routes around, and `recordTransition` will happily take
// `awaiting-review -> approved` from anybody who passes two verdicts. `approveTask` is the only path that
// checks §13's rule, so the test asserts both that it refuses AND that the state did not move.
//
// Cases:
//   1. boot imports `review-profiles.json` into `review_profiles`, addressed by content hash
//   2. a profile EDIT adds a row rather than rewriting the one older verdicts point at
//   3. a verdict is stored per-dimension and revision-bound; a reviewer revising it REPLACES its own row
//   4. findings are verified BEFORE storage, and a verifier's REFUTED never reaches the coder
//   5. no verifier configured -> `unverified`, delivered and labelled, never silently confirmed
//   6. `approveTask` refuses with reasons and does NOT move the task; a satisfied review moves it
//   7. a new commit invalidates the approval — the same task is refused again after a revision
//   8. `reviewFindings` diffs against the previous round
//   9. model diversity is validated at assignment and surfaces as a blocker
//  10. the snapshot carries the EVALUATED review status, for the TUI's review bar
//  11. the review surface is reachable over the wire
//  12. a reviewer can re-review the same dimension in one round after a NEW COMMIT (was impossible)
//  13. verdicts are evaluated under the profile they were JUDGED under, not the current file
//  14. a verdict's identity (worker, slot, dimension) comes from the registry, never from the request
//  15. `approveTask` derives round and commit authoritatively and refuses a stale round
//  16. an approval cannot slip past a verdict whose verification is still in flight
//  17. a REFUTED finding reaches the coder through neither `ranked` nor `diff`
//  18. one authenticated token cannot manufacture the distinct-reviewer quorum by claiming a second
//      worker's identity; two genuinely distinct reviewers still can (added 2026-09-11)
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import {
  openDb, closeDb, upsertHarness, createWorker, createTask, recordTransition,
  listReviewProfiles, listReviewVerdicts, latestReviewRound, getReviewProfile, recordReviewVerdict,
  latestTaskHandoff,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { createIpcServer } from "../../ipc/server.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { CONFIG_FILENAME } from "../../config/review-profiles.js";
import { makeScratchDir, rmScratchDir, runTest, sleep } from "./_helpers.js";
import { sockPath } from "../../paths.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

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

/** Walk a task to `awaiting-review` through the real state machine. */
function walkToReview(db, taskId, actor = "tester") {
  let from = "created";
  for (const to of ["starting", "planning", "implementing", "awaiting-review"]) {
    recordTransition(db, { id: `tr-${taskId}-${to}`, taskId, fromState: from, toState: to, actor });
    from = to;
  }
}

await runTest("configurable reviews", async () => {
  const stateDir = makeScratchDir("supervisor-review-test");
  const configPath = path.join(stateDir, CONFIG_FILENAME);
  let db;
  let supervisor;
  let ipc;
  const harnesses = [];

  function makeSupervisor(opts = {}) {
    const fake = createFakeHarness({ label: "review" });
    harnesses.push(fake);
    return createSupervisor({ db, stateDir, adapters: { fake }, askSweepIntervalMs: 0, logger: quiet, ...opts });
  }

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake" });
    upsertHarness(db, { id: "other", displayName: "Other" });

    // A profile file with a quorum of 2 and one non-default profile, so precedence is exercised for real.
    fs.writeFileSync(configPath, `{
      "schemaVersion": 1,
      "profiles": {
        "default": {
          "dimensions": [
            { "id": "correctness", "blocking": true,  "prompt": "does it work" },
            { "id": "security",    "blocking": true,  "prompt": "what can go wrong" },
            { "id": "perf",        "blocking": false, "prompt": "what gets slower" }
          ],
          "quorum": { "required": 2, "parentCounts": false }
        },
        "hotfix": { "extends": "default", "quorum": { "required": 1 }, "dimensions": ["correctness"] }
      },
      "perTeam": { "team-hot": "hotfix" }
    }`);

    // ── 1 ────────────────────────────────────────────────────────────────────────────
    {
      supervisor = makeSupervisor();
      const booted = await supervisor.boot();
      assert.ok(booted.reviews, "boot reports what it imported (PLAN.md §3: imported on startup)");
      assert.equal(booted.reviews.source, "file");
      assert.deepEqual(booted.reviews.profiles.sort(), ["default", "hotfix"]);

      const stored = listReviewProfiles(db);
      assert.equal(stored.length, 2, `both profiles are in review_profiles; got ${stored.length}`);
      const def = stored.find((p) => p.id === "default");
      assert.ok(def.hash, "each is addressed by a content hash — that is what makes a stored verdict interpretable later");
      assert.equal(def.config.quorum.required, 2, "and the RESOLVED config is what was stored, not the raw file");
      assert.ok(getReviewProfile(db, { id: "default", hash: def.hash }), "and it is retrievable by (id, hash)");

      // Idempotent: re-importing the same file must not churn rows or rewrite `imported_at`.
      const again = supervisor.importReviewProfiles();
      assert.equal(again.imported, 0, "an identical re-import writes nothing");
      assert.equal(listReviewProfiles(db).length, 2);
      assert.equal(listReviewProfiles(db).find((p) => p.id === "default").importedAt, def.importedAt,
        "and does not move `imported_at` — 'when did this profile first appear' has to stay answerable");
      console.log("  1. boot imported the profiles, addressed by content hash");
    }

    // ── 2 ────────────────────────────────────────────────────────────────────────────
    // Migration 0009's whole reason: a verdict recorded under a profile must stay interpretable after the
    // profile is edited. Rewriting the row in place would silently change the meaning of stored judgements.
    {
      const before = listReviewProfiles(db).find((p) => p.id === "default");
      fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace('"required": 2', '"required": 3'));
      const res = supervisor.importReviewProfiles();
      assert.equal(res.imported, 1, "an edited profile is a NEW row");
      const rows = listReviewProfiles(db).filter((p) => p.id === "default");
      assert.equal(rows.length, 2, "both versions coexist");
      assert.ok(rows.some((r) => r.hash === before.hash && r.config.quorum.required === 2),
        "the OLD one is untouched, so a verdict judged under it still means what it meant");
      assert.ok(rows.some((r) => r.config.quorum.required === 3), "and the new one is available");

      // Put it back, so the rest of the cases run under a quorum of 2.
      fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace('"required": 3', '"required": 2'));
      supervisor.importReviewProfiles();
      console.log("  2. editing a profile adds a row rather than rewriting history");
    }

    // ── 3 ────────────────────────────────────────────────────────────────────────────
    {
      createTask(db, { id: "t1", title: "review me", type: "feature" });
      createWorker(db, { workerId: "w-code", nickname: "purus", role: "coder", taskId: "t1" });
      createWorker(db, { workerId: "w-r1", nickname: "aluna", role: "reviewer", taskId: "t1" });
      createWorker(db, { workerId: "w-r2", nickname: "zterra", role: "reviewer", taskId: "t1" });
      walkToReview(db, "t1");

      await supervisor.recordVerdict({
        taskId: "t1", workerId: "w-r1", slot: "reviewer1", round: 1, commitSha: "sha1",
        dimension: "correctness", verdict: "changes-requested",
        findings: [{ file: "a.js", line: 7, summary: "off by one" }],
      });
      let rows = listReviewVerdicts(db, "t1");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].commitSha, "sha1", "revision-bound: the commit is part of the record");
      assert.equal(rows[0].dimension, "correctness", "and so is the dimension");
      assert.ok(rows[0].profileId && rows[0].profileHash,
        "with the profile it was judged under — otherwise 'was correctness blocking then' is unanswerable");

      // The same reviewer changing its mind on the SAME dimension and round REPLACES its row. Appending
      // would leave "which of these two is current" unanswerable from the data.
      await supervisor.recordVerdict({
        taskId: "t1", workerId: "w-r1", slot: "reviewer1", round: 1, commitSha: "sha1",
        dimension: "correctness", verdict: "approved",
      });
      rows = listReviewVerdicts(db, "t1");
      assert.equal(rows.length, 1, `a revised opinion replaces its own row; found ${rows.length}`);
      assert.equal(rows[0].verdict, "approved");

      // ...but the same reviewer on a DIFFERENT dimension is a different row, which is the point of
      // per-dimension verdicts.
      await supervisor.recordVerdict({
        taskId: "t1", workerId: "w-r1", slot: "reviewer1", round: 1, commitSha: "sha1",
        dimension: "security", verdict: "approved",
      });
      assert.equal(listReviewVerdicts(db, "t1").length, 2);
      assert.equal(latestReviewRound(db, "t1"), 1);
      // And the vocabulary is enforced at the write boundary.
      assert.throws(
        () => recordReviewVerdict(db, { taskId: "t1", workerId: "w-r1", round: 1, commitSha: "sha1", dimension: "x", verdict: "lgtm" }),
        /is not one of approved, changes-requested, abstain/,
      );
      assert.throws(
        () => recordReviewVerdict(db, { taskId: "t1", workerId: "w-r1", round: 0, commitSha: "s", dimension: "x", verdict: "approved" }),
        /round must be a positive integer/,
      );
      console.log("  3. verdicts are per-dimension and revision-bound; a revision replaces its own row");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    // Section 13: findings that fail verification "never arrive". Verification therefore happens BEFORE
    // storage — a finding stored as confirmed and filtered later is one query away from a coder anyway.
    {
      const seen = [];
      // ORDERING IS ASSERTED FROM INSIDE THE VERIFIER, which is the only place it can be observed. Awaiting
      // `recordVerdict` and inspecting the stored row afterwards proves the row ends up verified — it does
      // NOT prove verification came first, so a version that stored the raw findings and updated them after
      // verifying would pass. A concurrent reader could then deliver an unverified finding. Named by the
      // Phase 6 review (sol).
      let rowsAtVerifyTime = null;
      const verifying = makeSupervisor({
        findingVerifier: async (finding) => {
          seen.push(finding.summary);
          rowsAtVerifyTime = listReviewVerdicts(db, "t1").filter((x) => x.workerId === "w-r2").length;
          return finding.summary.includes("real")
            ? { verdict: "CONFIRMED", note: "reproduced" }
            : { verdict: "REFUTED", note: "could not reproduce" };
        },
      });
      await verifying.boot();

      const res = await verifying.recordVerdict({
        taskId: "t1", workerId: "w-r2", slot: "reviewer2", round: 1, commitSha: "sha1",
        dimension: "correctness", verdict: "changes-requested",
        findings: [
          { file: "a.js", line: 1, summary: "a real bug" },
          { file: "b.js", line: 2, summary: "imagined problem" },
        ],
      });
      assert.deepEqual(seen, ["a real bug", "imagined problem"], "every finding goes through the pass");
      assert.equal(rowsAtVerifyTime, 0,
        "and NOTHING was stored yet when the verifier ran — findings that fail verification never arrive, "
        + "which is only true if the write happens after the pass");
      assert.equal(res.findings.find((f) => f.file === "a.js").verdict, "CONFIRMED");
      assert.equal(res.findings.find((f) => f.file === "b.js").verdict, "REFUTED");
      assert.equal(res.findings.find((f) => f.file === "a.js").verifierNote, "reproduced",
        "with the verifier's reason kept, so a REFUTED finding can be argued with");

      // The verdicts are STORED with their verification, and the coder's list drops the refuted one.
      const stored = listReviewVerdicts(db, "t1").find((v) => v.workerId === "w-r2");
      assert.equal(stored.findings.length, 2, "both are stored — the record is complete");
      const delivered = verifying.reviewFindings("t1").ranked;
      assert.deepEqual(delivered.map((f) => f.file), ["a.js"],
        "but only the CONFIRMED one is delivered — that is what `verifyFindings` is for");
      assert.equal(delivered[0].at, "a.js:1", "with file:line, which is the deliverable");

      // A verifier that throws must not lose the finding.
      const brokenVerifier = makeSupervisor({ findingVerifier: async () => { throw new Error("verifier exploded"); } });
      await brokenVerifier.boot();
      const kept = await brokenVerifier.recordVerdict({
        taskId: "t1", workerId: "w-r2", slot: "reviewer2", round: 1, commitSha: "sha1",
        dimension: "perf", verdict: "changes-requested", findings: [{ file: "c.js", summary: "slow loop" }],
      });
      assert.equal(kept.findings[0].verdict, "unverified", "a failed verification keeps the finding");
      assert.match(kept.findings[0].verifierNote, /verification failed/, "and says what happened to it");
      console.log("  4. findings are verified before storage, and REFUTED ones never reach the coder");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    {
      createTask(db, { id: "t-unv", title: "no verifier", type: "feature" });
      createWorker(db, { workerId: "w-u1", nickname: "u-one", role: "reviewer", taskId: "t-unv" });
      const res = await supervisor.recordVerdict({
        taskId: "t-unv", workerId: "w-u1", slot: "reviewer1", round: 1, commitSha: "sha1",
        dimension: "correctness", verdict: "changes-requested", findings: [{ file: "x.js", line: 3, summary: "suspicious" }],
      });
      assert.equal(res.findings[0].verdict, "unverified",
        "with no verifier configured, a finding is UNVERIFIED — not confirmed, which would be a lie");
      const delivered = supervisor.reviewFindings("t-unv").ranked;
      assert.equal(delivered.length, 1, "and it is still delivered, because dropping it would lose a real finding");
      assert.equal(delivered[0].verdict, "unverified", "labelled, so the coder knows nothing checked it");
      console.log("  5. with no verifier, findings are unverified — delivered and labelled");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    // THE CASE THAT MATTERS. A rule nothing consults is documentation; Phase 5 learned this about the state
    // machine and the same trap is available here.
    {
      const status = supervisor.reviewStatus("t1");
      assert.equal(status.approved, false, `precondition: t1 is not approvable yet — ${JSON.stringify(status.reasons)}`);

      const refused = await supervisor.approveTask("t1", { actor: "cto" });
      assert.equal(refused.approved, false);
      assert.ok(refused.refused.length > 0, "and it says WHY, in reasons a human can act on");
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t1'").get().state, "awaiting-review",
        "and the task DID NOT MOVE — a refusal that transitions anyway is worse than no rule at all");

      // Satisfy the rule properly: two distinct reviewers, both blocking dimensions, no change requests.
      for (const [worker, slot] of [["w-r1", "reviewer1"], ["w-r2", "reviewer2"]]) {
        for (const dim of ["correctness", "security"]) {
          await supervisor.recordVerdict({
            taskId: "t1", workerId: worker, slot, round: 1, commitSha: "sha1", dimension: dim, verdict: "approved",
          });
        }
      }
      // The `perf` change request from case 4 is on a NON-blocking dimension and must still block, because
      // this profile's `changeRequestBlocks` is on.
      const stillBlocked = await supervisor.approveTask("t1", { actor: "cto" });
      assert.equal(stillBlocked.approved, false, "the non-blocking dimension's change request still blocks");
      assert.match(stillBlocked.refused.join(" "), /non-blocking dimension "perf"/);

      // Withdraw it (the reviewer says it is fine now) and the review is satisfied.
      await supervisor.recordVerdict({
        taskId: "t1", workerId: "w-r2", slot: "reviewer2", round: 1, commitSha: "sha1", dimension: "perf", verdict: "approved",
      });
      const approved = await supervisor.approveTask("t1", { actor: "cto" });
      assert.equal(approved.approved, true, `a satisfied review must approve; refused: ${JSON.stringify(approved.refused)}`);
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t1'").get().state, "approved");
      assert.ok(latestTaskHandoff(db, "t1"), "and the handoff was regenerated on the transition (Rule 4)");

      // A verdict on a DECIDED task is refused rather than silently accumulating rows that make
      // `reviewStatus` disagree with `tasks.state`. PLAN.md §6 has no edge back from `approved`, so inventing
      // one here would be the speculative-state mistake §6 warns against — the refusal names the way forward
      // instead.
      await assert.rejects(
        () => supervisor.recordVerdict({
          taskId: "t1", workerId: "w-r1", round: 2, commitSha: "sha2", dimension: "correctness", verdict: "changes-requested",
        }),
        /cannot change a decision that has already been made/,
        "a verdict after approval must be refused, or the dashboard shows a blocked review for a task the system considers done",
      );

      // And §6's hard rule is untouched: an approved review is still not a merge.
      assert.throws(
        () => recordTransition(db, { id: "tr-merge-t1", taskId: "t1", fromState: "approved", toState: "merged", actor: "cto" }),
        /no autonomous merges/,
        "green reviews are explicitly not a human approval",
      );
      console.log("  6. approveTask refuses with reasons and does not move the task; a satisfied review moves it");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    // "Approvals die when the commit changes." Asserted on a task that was ALREADY approved, because that is
    // the case where a stale approval does real damage.
    {
      const before = supervisor.reviewStatus("t1", { commitSha: "sha1" });
      assert.equal(before.approved, true, "precondition: approved against sha1");

      const after = supervisor.reviewStatus("t1", { commitSha: "sha2" });
      assert.equal(after.approved, false, "the same verdicts do NOT approve a different commit");
      assert.equal(after.counted, 0, "none of them count against the new revision");
      assert.match(after.reasons.join(" "), /no approval for this revision/);
      console.log("  7. a new commit invalidates the approval");
    }

    // ── 8 ────────────────────────────────────────────────────────────────────────────
    {
      createTask(db, { id: "t-diff", title: "two rounds", type: "feature" });
      createWorker(db, { workerId: "w-d1", nickname: "d-one", role: "reviewer", taskId: "t-diff" });
      const round = async (r, findings) => supervisor.recordVerdict({
        taskId: "t-diff", workerId: "w-d1", slot: "reviewer1", round: r, commitSha: `sha-${r}`,
        dimension: "correctness", verdict: "changes-requested", findings,
      });
      await round(1, [
        { file: "a.js", line: 1, summary: "Off by one" },
        { file: "b.js", line: 2, summary: "Missing await" },
      ]);
      await round(2, [
        { file: "a.js", line: 1, summary: "off by   one" },
        { file: "c.js", line: 3, summary: "New problem" },
      ]);
      const out = supervisor.reviewFindings("t-diff");
      assert.equal(out.round, 2, "the newest round by default");
      assert.deepEqual(out.diff.added.map((f) => f.file), ["c.js"]);
      assert.deepEqual(out.diff.persisting.map((f) => f.file), ["a.js"],
        "casing and whitespace do not make a finding new (a REPHRASING does — see domain/test/review.test.js case 8)");
      assert.deepEqual(out.diff.resolved.map((f) => f.file), ["b.js"],
        "and what stopped being reported is the only evidence round 1 produced anything");
      console.log("  8. reviewFindings diffs against the previous round");
    }

    // ── 9 ────────────────────────────────────────────────────────────────────────────
    // Section 13 promotes model diversity from a habit to "a validated profile property". The evidence for
    // the rule is PLAN.md's own review: four models on two harnesses, and the best findings each appeared in
    // exactly one of them.
    {
      createTask(db, { id: "t-div", title: "same harness twice", type: "feature" });
      createWorker(db, { workerId: "w-dc", nickname: "coder-d", role: "coder", taskId: "t-div" });
      createWorker(db, { workerId: "w-dr1", nickname: "a-rev", role: "reviewer", taskId: "t-div" });
      createWorker(db, { workerId: "w-dr2", nickname: "b-rev", role: "reviewer", taskId: "t-div" });

      const res = await supervisor.assignTask("t-div", {
        // Both reviewers deliberately on ONE harness — the violation.
        overrides: {
          coder: { harnessId: "fake" },
          reviewer1: { harnessId: "fake" },
          reviewer2: { harnessId: "fake" },
        },
        actor: "tester", cwd: stateDir,
      });
      const violation = res.failures.find((f) => f.kind === "model-diversity");
      assert.ok(violation, `the violation must be reported; failures were ${JSON.stringify(res.failures)}`);
      assert.match(violation.reason, /requires distinct reviewer harnesses/);
      assert.equal(res.assigned, true,
        "and it is REPORTED, not refused — two reviewers on one harness is a weaker review, not an unsafe one, and blocking real work over a config problem is the wrong trade");

      // Impossible to miss: it takes the same route to the handoff a failed role does.
      const doc = latestTaskHandoff(db, "t-div").doc;
      const blockers = doc.slice(doc.indexOf("## Blockers"), doc.indexOf("## Current diff shape"));
      assert.match(blockers, /review diversity/, "and it lands in the handoff's Blockers");
      assert.match(blockers, /reassign a reviewer to another harness/, "with the action that fixes it");

      // Two harnesses: no violation.
      createTask(db, { id: "t-div2", title: "two harnesses", type: "feature" });
      createWorker(db, { workerId: "w-d2c", nickname: "coder-e", role: "coder", taskId: "t-div2" });
      createWorker(db, { workerId: "w-d2r1", nickname: "a-rev2", role: "reviewer", taskId: "t-div2" });
      createWorker(db, { workerId: "w-d2r2", nickname: "b-rev2", role: "reviewer", taskId: "t-div2" });
      const ok = await supervisor.assignTask("t-div2", {
        overrides: {
          coder: { harnessId: "fake" },
          reviewer1: { harnessId: "fake" },
          reviewer2: { harnessId: "other" },
        },
        actor: "tester", cwd: stateDir,
      });
      assert.equal(ok.failures.some((f) => f.kind === "model-diversity"), false,
        "distinct harnesses satisfy the profile");
      console.log("  9. model diversity is validated at assignment and surfaces as a blocker");
    }

    // ── 10 ───────────────────────────────────────────────────────────────────────────
    // The TUI's review bar (ROADMAP Phase 6's "review-pane wiring"). The snapshot has to carry the
    // EVALUATED rule, not the raw verdicts — a dashboard that re-evaluated section 13 for itself is how it
    // comes to disagree with the system it is displaying.
    {
      const handlers = supervisor.commandHandlers();
      const snap = await handlers.tuiSnapshot({ id: "s-rev", cmd: "tuiSnapshot" });
      assert.ok(snap.reviews, "the snapshot carries review summaries");
      // t1 is APPROVED by now, and a finished review must NOT keep a bar on screen. The first version of
      // this case asserted the opposite — that an approved task stays in the map — which made the client's
      // "the bar clears" test vacuous at the backend boundary, since the only thing that ever cleared it was
      // a fixture supplying an empty map by hand. Named by the Phase 6 review (sol).
      assert.equal("t1" in snap.reviews, false,
        "an approved task has no review in flight, so it must not appear — the TUI clears the bar by ABSENCE");

      const inFlight = snap.reviews["t-diff"];
      assert.ok(inFlight, "a task whose review is still open IS reported");
      assert.equal(inFlight.approved, false, "with the rule already applied");
      assert.ok(inFlight.quorum.required >= 1);
      assert.ok(inFlight.profile.id, "and which profile governed it");
      assert.ok(Number.isInteger(inFlight.findingCount),
        "and a real finding COUNT beside the truncated list — rendering the slice's length reported 5 for any number above 5");

      assert.ok(inFlight.reasons.length > 0, "with reasons, which is what makes the bar actionable");

      // Only tasks that HAVE a review — evaluating the rule for every task on every tick would be work in
      // proportion to the registry rather than to what is under review.
      assert.equal("t-unv" in snap.reviews, true, "t-unv has a verdict, so it is included");
      assert.equal("t-div" in snap.reviews, false, "a task with no verdicts has no review to report");
      console.log("  10. the snapshot carries the evaluated review status for the TUI's bar");
    }

    // ── 11 ───────────────────────────────────────────────────────────────────────────
    // The review surface is used by clients over a socket, and a function that works in-process and fails
    // when addressed by name is invisible to all of them (FINDINGS §32).
    {
      ipc = createIpcServer({ commands: supervisor.commandHandlers() });
      const sock = sockPath(stateDir);
      await ipc.listen(sock);

      const status = await request(sock, { id: "r1", cmd: "reviewStatus", taskId: "t1" });
      assert.equal(status.ok, true, `reviewStatus over the wire; got ${JSON.stringify(status)}`);
      assert.equal(status.status.approved, true);
      assert.ok(status.status.profile.id, "with the profile that governed it");
      assert.ok(status.status.profile.reason, "and why that profile applied");

      const profiles = await request(sock, { id: "r2", cmd: "reviewProfiles" });
      assert.equal(profiles.ok, true);
      assert.ok(profiles.profiles.length >= 2);

      const findings = await request(sock, { id: "r3", cmd: "reviewFindings", taskId: "t-diff" });
      assert.equal(findings.ok, true);
      assert.equal(findings.diff.added.length, 1);

      const verdict = await request(sock, {
        id: "r4", cmd: "recordVerdict", taskId: "t-diff", workerId: "w-d1", slot: "reviewer1",
        round: 3, commitSha: "sha-3", dimension: "correctness", verdict: "approved",
      });
      assert.equal(verdict.ok, true, `recordVerdict over the wire; got ${JSON.stringify(verdict)}`);
      assert.equal(latestReviewRound(db, "t-diff"), 3, "and it really wrote a row");

      const refused = await request(sock, { id: "r5", cmd: "approveTask", taskId: "t-diff" });
      assert.equal(refused.ok, true, "the command succeeded...");
      assert.equal(refused.result.approved, false, "...and the REVIEW refused, which is a different thing");
      assert.ok(refused.result.refused.length > 0);
      console.log("  11. the review surface works over a real socket");
    }

    // ── 12 ───────────────────────────────────────────────────────────────────────────
    // A reviewer re-reviewing the same dimension in the same round after a new commit. This was IMPOSSIBLE:
    // `commit_sha` is part of the uniqueness tuple but was not part of the generated primary key, so the
    // second write hit `UNIQUE constraint failed: review_verdicts.id` instead of its intended conflict
    // target — revision-bound re-review inside a round could not be recorded at all. Found by the Phase 6
    // review (sol) and reproduced before fixing; the pre-existing case 7 could not catch it because it only
    // EVALUATES `sha1` rows against a supplied `sha2` and never attempts the second write.
    {
      createTask(db, { id: "t-recommit", title: "re-review", type: "feature" });
      createWorker(db, { workerId: "w-rc", nickname: "rc", role: "reviewer", taskId: "t-recommit" });
      const base = { taskId: "t-recommit", workerId: "w-rc", round: 1, dimension: "correctness" };
      await supervisor.recordVerdict({ ...base, commitSha: "sha-a", verdict: "changes-requested" });
      // The write that used to throw, WRAPPED so that a refusal is an assertion failure rather than a bare
      // crash — the mutation harness only credits a mutation caught by a real `AssertionError`, and the
      // regression here is precisely "this throws" (FINDINGS §22.1's rule, and mutation R16 relies on it).
      try {
        await supervisor.recordVerdict({ ...base, commitSha: "sha-b", verdict: "approved" });
      } catch (err) {
        assert.fail(
          "a reviewer must be able to re-review the same dimension in the same round after a NEW COMMIT; "
          + `the write was refused: ${err.message}`,
        );
      }

      const rows = listReviewVerdicts(db, "t-recommit");
      assert.equal(rows.length, 2, `both commits' verdicts coexist in one round; got ${rows.length}`);
      assert.deepEqual(rows.map((r) => r.commitSha).sort(), ["sha-a", "sha-b"]);
      // ...and the same reviewer revising the SAME commit still replaces rather than appending.
      await supervisor.recordVerdict({ ...base, commitSha: "sha-b", verdict: "changes-requested" });
      const after = listReviewVerdicts(db, "t-recommit");
      assert.equal(after.length, 2, "a revision of one commit's verdict replaces it");
      assert.equal(after.find((r) => r.commitSha === "sha-b").verdict, "changes-requested");
      console.log("  12. a reviewer can re-review the same dimension in one round after a new commit");
    }

    // ── 13 ───────────────────────────────────────────────────────────────────────────
    // THE POINT OF CONTENT-ADDRESSING, which was built, stored, and never read. `reviewStatus` selected the
    // profile from the CURRENT file and ignored the `(profile_id, profile_hash)` every verdict carries — so
    // loosening a profile reinterpreted judgements already made, which is precisely what migration 0009's
    // header promises cannot happen. Verified before fixing: an insufficient set of verdicts approved a task
    // after the rule was relaxed. Found by the Phase 6 review (sol).
    {
      createTask(db, { id: "t-reint", title: "reinterpret", type: "feature" });
      createWorker(db, { workerId: "w-ri1", nickname: "a-ri", role: "reviewer", taskId: "t-reint" });
      walkToReview(db, "t-reint");
      // One reviewer, one dimension, under the strict profile (quorum 2, correctness + security blocking).
      await supervisor.recordVerdict({
        taskId: "t-reint", workerId: "w-ri1", round: 1, commitSha: "sha1", dimension: "correctness", verdict: "approved",
      });
      const strictHash = listReviewVerdicts(db, "t-reint")[0].profileHash;
      assert.ok(strictHash, "precondition: the verdict records the profile it was judged under");
      assert.equal(supervisor.reviewStatus("t-reint").approved, false, "precondition: not approvable under the strict rule");

      // Now loosen the profile on disk and re-import: one dimension, quorum 1.
      const original = fs.readFileSync(configPath, "utf8");
      fs.writeFileSync(configPath, `{
        "profiles": {
          "default": {
            "dimensions": [ { "id": "correctness", "blocking": true, "prompt": "does it work" } ],
            "quorum": { "required": 1, "parentCounts": false }
          }
        }
      }`);
      supervisor.importReviewProfiles();

      const after = supervisor.reviewStatus("t-reint");
      assert.equal(after.approved, false,
        "the SAME verdicts must not approve under a rule they were not judged under — that is what the profile hash is for");
      assert.equal(after.profile.hash, strictHash, "so the evaluation uses the round's profile, not the current file");
      assert.match(after.profile.reason, /judged under/, "and says which profile it used, because that is surprising");
      const refused = await supervisor.approveTask("t-reint", { actor: "cto" });
      assert.equal(refused.approved, false, "and the transition is refused with it");

      // MIXED hashes in one round are refused outright rather than merged: a verdict count assembled from two
      // different rule sets means nothing.
      await supervisor.recordVerdict({
        taskId: "t-reint", workerId: "w-ri1", round: 1, commitSha: "sha1", dimension: "correctness", verdict: "approved",
      });
      const mixedRows = listReviewVerdicts(db, "t-reint");
      assert.equal(new Set(mixedRows.map((r) => r.profileHash)).size, 1,
        "note: re-recording under the new profile REPLACES the row, so this round is single-hash again");
      const nowLoose = supervisor.reviewStatus("t-reint");
      assert.equal(nowLoose.approved, true,
        "a verdict recorded UNDER the loosened profile does approve under it — the rule is not frozen, only the interpretation of past judgements");

      fs.writeFileSync(configPath, original);
      supervisor.importReviewProfiles();
      console.log("  13. verdicts are evaluated under the profile they were judged under");
    }

    // ── 14 ───────────────────────────────────────────────────────────────────────────
    // THE IDENTITY BOUNDARY. `workerId`, `slot` and `dimension` came off the socket and the rule counted them,
    // so a caller could reach quorum with a worker from another task, satisfy `parentRequired` by declaring
    // `slot: "parent"`, and pad the count with a dimension no profile defines. Verified before fixing: all
    // three were accepted and the task approved on manufactured identity. Found by the Phase 6 review (sol).
    {
      createTask(db, { id: "t-ident", title: "identity", type: "feature" });
      createWorker(db, { workerId: "w-id-r", nickname: "id-rev", role: "reviewer", taskId: "t-ident" });
      createWorker(db, { workerId: "w-id-c", nickname: "id-coder", role: "coder", taskId: "t-ident" });
      createTask(db, { id: "t-elsewhere", title: "elsewhere", type: "feature" });
      createWorker(db, { workerId: "w-elsewhere", nickname: "far", role: "reviewer", taskId: "t-elsewhere" });
      walkToReview(db, "t-ident");
      const v = { taskId: "t-ident", round: 1, commitSha: "sha1", dimension: "correctness", verdict: "approved" };

      await assert.rejects(
        () => supervisor.recordVerdict({ ...v, workerId: "w-elsewhere" }),
        /is on task t-elsewhere, not t-ident/,
        "a worker from another task cannot cast a verdict — quorum counts it, so membership is a registry fact",
      );
      await assert.rejects(
        () => supervisor.recordVerdict({ ...v, workerId: "w-id-c" }),
        /only a reviewer may record a verdict/,
        "and neither can a coder on the same task",
      );
      await assert.rejects(
        () => supervisor.recordVerdict({ ...v, workerId: "w-id-r", dimension: "not-a-dimension" }),
        /is not a dimension of review profile/,
        "an invented dimension would count toward quorum while satisfying nothing",
      );
      await assert.rejects(
        () => supervisor.recordVerdict({ ...v, workerId: "no-such-worker" }),
        /no such worker/,
      );

      // The SLOT is derived, not accepted: `slot === "parent"` is what `parentRequired` checks, so a caller
      // that could declare it would be certifying its own authority.
      const res = await supervisor.recordVerdict({ ...v, workerId: "w-id-r", slot: "parent" });
      assert.equal(res.slot, "reviewer1", `the registry's slot wins over the caller's claim; got ${res.slot}`);
      assert.equal(listReviewVerdicts(db, "t-ident")[0].slot, "reviewer1", "and that is what was stored");
      console.log("  14. a verdict's identity comes from the registry, never from the request");
    }

    // ── 15 ───────────────────────────────────────────────────────────────────────────
    // `approveTask` took `round` and `commitSha` from the caller and passed them into the guard, so the rule
    // was correct and the CALLER chose which reality to apply it to: a green round 1 could be approved while
    // round 2 held a change request. Verified before fixing — the task moved to `approved`. Found by the
    // Phase 6 review (sol).
    {
      createTask(db, { id: "t-stale", title: "stale round", type: "feature" });
      createWorker(db, { workerId: "w-st1", nickname: "a-st", role: "reviewer", taskId: "t-stale" });
      createWorker(db, { workerId: "w-st2", nickname: "b-st", role: "reviewer", taskId: "t-stale" });
      walkToReview(db, "t-stale");
      // A fully green round 1.
      for (const w of ["w-st1", "w-st2"]) {
        for (const d of ["correctness", "security"]) {
          await supervisor.recordVerdict({ taskId: "t-stale", workerId: w, round: 1, commitSha: "sha1", dimension: d, verdict: "approved" });
        }
      }
      assert.equal((await supervisor.approveTask("t-stale", { actor: "cto", round: 1 })).approved, true,
        "precondition: round 1 is genuinely approvable, and naming the CURRENT round is allowed");

      // Now a round 2 change request on a fresh task in the same shape, and an attempt to approve round 1.
      createTask(db, { id: "t-stale2", title: "stale round 2", type: "feature" });
      createWorker(db, { workerId: "w-s21", nickname: "a-s2", role: "reviewer", taskId: "t-stale2" });
      createWorker(db, { workerId: "w-s22", nickname: "b-s2", role: "reviewer", taskId: "t-stale2" });
      walkToReview(db, "t-stale2");
      for (const w of ["w-s21", "w-s22"]) {
        for (const d of ["correctness", "security"]) {
          await supervisor.recordVerdict({ taskId: "t-stale2", workerId: w, round: 1, commitSha: "sha1", dimension: d, verdict: "approved" });
        }
      }
      await supervisor.recordVerdict({ taskId: "t-stale2", workerId: "w-s21", round: 2, commitSha: "sha2", dimension: "security", verdict: "changes-requested" });

      const stale = await supervisor.approveTask("t-stale2", { actor: "cto", round: 1, commitSha: "sha1" });
      assert.equal(stale.approved, false, "approving an older round must be refused, however green that round was");
      assert.match(stale.refused.join(" "), /not the current review round \(2\)/, "and the refusal names the current round");
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-stale2'").get().state, "awaiting-review",
        "and the task did not move");

      // With no arguments at all it evaluates round 2, which is blocked.
      const current = await supervisor.approveTask("t-stale2", { actor: "cto" });
      assert.equal(current.approved, false);
      assert.equal(current.status.round, 2, "the round is derived, not supplied");
      console.log("  15. approveTask derives the round authoritatively and refuses a stale one");
    }

    // ── 16 ───────────────────────────────────────────────────────────────────────────
    // THE RACE. `recordVerdict` awaits a verifier that may call a model and IPC handlers run concurrently, so
    // a synchronous `approveTask` could evaluate the stored rows mid-verification and transition the task —
    // after which the change request landed on an already-approved task, whose own `reviewStatus()` then
    // reported it blocked. Verified before fixing. Both paths now take the same per-task lock, which is why
    // `approveTask` is async.
    {
      let release;
      const gate = new Promise((r) => { release = r; });
      const slowVerifier = makeSupervisor({ findingVerifier: async () => { await gate; return { verdict: "CONFIRMED" }; } });
      await slowVerifier.boot();

      createTask(db, { id: "t-race", title: "race", type: "feature" });
      createWorker(db, { workerId: "w-rc1", nickname: "a-rc", role: "reviewer", taskId: "t-race" });
      createWorker(db, { workerId: "w-rc2", nickname: "b-rc", role: "reviewer", taskId: "t-race" });
      walkToReview(db, "t-race");
      // A satisfying set first — no findings, so the verifier is never called and these do not block.
      for (const w of ["w-rc1", "w-rc2"]) {
        for (const d of ["correctness", "security"]) {
          await slowVerifier.recordVerdict({ taskId: "t-race", workerId: w, round: 1, commitSha: "sha1", dimension: d, verdict: "approved" });
        }
      }
      // ...then a change request whose verification blocks, and an approval attempt during it.
      const slow = slowVerifier.recordVerdict({
        taskId: "t-race", workerId: "w-rc1", round: 1, commitSha: "sha1", dimension: "security",
        verdict: "changes-requested", findings: [{ file: "b.js", line: 2, summary: "a real problem" }],
      });
      await sleep(50);
      const approving = slowVerifier.approveTask("t-race", { actor: "cto" });
      await sleep(50);
      release();
      await slow;
      const approved = await approving;
      const finalStatus = slowVerifier.reviewStatus("t-race");

      assert.equal(approved.approved, finalStatus.approved,
        "the transition's verdict and the review's own verdict must agree — an approved task whose review reports it blocked is the failure this lock exists for");
      assert.equal(approved.approved, false, "and here the pending change request wins, because it was in flight first");
      assert.equal(db.prepare("SELECT state FROM tasks WHERE id='t-race'").get().state, "awaiting-review");
      console.log("  16. an approval cannot slip past a verdict whose verification is still running");
    }

    // ── 17 ───────────────────────────────────────────────────────────────────────────
    // A REFUTED finding reached the coder through `diff.added` while `ranked` was busy excluding it — the
    // whole object goes over the socket, so the second pass was a formality by a side door. Found by the
    // Phase 6 review (sol).
    {
      const refuting = makeSupervisor({ findingVerifier: async () => ({ verdict: "REFUTED", note: "could not reproduce" }) });
      await refuting.boot();
      createTask(db, { id: "t-ref", title: "refuted", type: "feature" });
      createWorker(db, { workerId: "w-ref", nickname: "ref", role: "reviewer", taskId: "t-ref" });
      walkToReview(db, "t-ref");
      await refuting.recordVerdict({
        taskId: "t-ref", workerId: "w-ref", round: 1, commitSha: "sha1", dimension: "correctness",
        verdict: "changes-requested", findings: [{ file: "a.js", line: 1, summary: "not real" }],
      });

      const out = refuting.reviewFindings("t-ref");
      assert.deepEqual(out.ranked, [], "a REFUTED finding is not delivered...");
      assert.deepEqual(out.diff.added, [], "...and does not arrive through the diff either");
      assert.deepEqual(out.diff.persisting, []);
      assert.deepEqual(out.diff.resolved, []);
      // It is still STORED — the record of what a reviewer said is complete; only delivery is filtered.
      assert.equal(listReviewVerdicts(db, "t-ref")[0].findings[0].verdict, "REFUTED",
        "the verdict row keeps it, because the record of what a reviewer claimed is not the same as what a coder is handed");
      console.log("  17. a REFUTED finding reaches the coder through neither ranked nor diff");
    }

    // ── 18 ───────────────────────────────────────────────────────────────────────────
    // ONE AUTHENTICATED TOKEN CANNOT MANUFACTURE THE DISTINCT-REVIEWER QUORUM BY CLAIMING TWO WORKER
    // IDENTITIES. Case 14 already made a verdict's registry facts (task membership, role, dimension, slot)
    // immune to the REQUEST — but `_principal` was never checked against the request's own `workerId`, so a
    // single reviewer token could still submit under a SECOND real reviewer's identity and satisfy "two
    // distinct reviewers" alone. Verified before fixing: the cross-identity call succeeded. Codex review
    // (`codexdoc/REVIEW-NOTES.md` finding 3), fixed 2026-09-11.
    {
      createTask(db, { id: "t-quorum-attack", title: "quorum manufacture attempt", type: "feature" });
      createWorker(db, { workerId: "w-qa1", nickname: "qa1", role: "reviewer", taskId: "t-quorum-attack" });
      createWorker(db, { workerId: "w-qa2", nickname: "qa2", role: "reviewer", taskId: "t-quorum-attack" });
      walkToReview(db, "t-quorum-attack");

      const wrapped = supervisor.authorizedCommandHandlers();
      const qa1 = supervisor.ensureWorkerPrincipal("w-qa1", { rotate: true });

      // The attack: qa1's OWN token, claiming to BE qa2. `recordVerdict` throws on every other identity
      // violation too (case 14: wrong task, wrong role, invented dimension) — this is the same style, not
      // a `{ok:false}` return.
      await assert.rejects(
        () => wrapped.recordVerdict({
          id: "atk1", token: qa1.token, taskId: "t-quorum-attack", workerId: "w-qa2",
          round: 1, commitSha: "sha1", dimension: "correctness", verdict: "approved",
        }),
        /OWN worker identity/,
        "one token cannot record a verdict under a DIFFERENT worker's identity",
      );
      assert.equal(listReviewVerdicts(db, "t-quorum-attack").length, 0, "the attack must not have stored anything");

      // The honest path: qa1 records its OWN two dimensions.
      for (const dimension of ["correctness", "security"]) {
        const res = await wrapped.recordVerdict({
          id: `honest-qa1-${dimension}`, token: qa1.token, taskId: "t-quorum-attack", workerId: "w-qa1",
          round: 1, commitSha: "sha1", dimension, verdict: "approved",
        });
        assert.equal(res.ok, true, JSON.stringify(res));
      }

      const ownerToken = fs.readFileSync(path.join(stateDir, "owner.token"), "utf8").trim();
      const stillShort = await wrapped.approveTask({ id: "app1", token: ownerToken, taskId: "t-quorum-attack", round: 1 });
      assert.equal(stillShort.result.approved, false, "one real reviewer is not a quorum of two, even though qa1's own verdicts are legitimate");

      // A GENUINE second identity — qa2's own token — must still be able to reach real quorum. The fix
      // must block IMPERSONATION, not reviewing itself.
      const qa2 = supervisor.ensureWorkerPrincipal("w-qa2", { rotate: true });
      for (const dimension of ["correctness", "security"]) {
        const res = await wrapped.recordVerdict({
          id: `honest-qa2-${dimension}`, token: qa2.token, taskId: "t-quorum-attack", workerId: "w-qa2",
          round: 1, commitSha: "sha1", dimension, verdict: "approved",
        });
        assert.equal(res.ok, true, JSON.stringify(res));
      }
      const nowApproved = await wrapped.approveTask({ id: "app2", token: ownerToken, taskId: "t-quorum-attack", round: 1 });
      assert.equal(nowApproved.result.approved, true, `two GENUINELY distinct reviewers must still approve; got ${JSON.stringify(nowApproved)}`);
      console.log("  18. one token cannot manufacture the distinct-reviewer quorum by impersonating a second worker; two genuine reviewers still can");
    }
  } finally {
    try { if (ipc) await ipc.shutdown(); } catch { /* teardown */ }
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* teardown */ }
    for (const h of harnesses) { try { await h.disposeAll?.({ graceMs: 300 }); } catch { /* teardown */ } }
    try { if (db) closeDb(db); } catch { /* teardown */ }
    await sleep(150);
    rmScratchDir(stateDir);
  }
});
