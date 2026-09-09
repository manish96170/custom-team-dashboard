// review.test.js — PLAN.md section 13's review rule and profile resolution. Pure. Phase 6.
//
// THE RULE UNDER TEST, quoted from the design so the assertions can be checked against it rather than against
// my paraphrase of it:
//
//   "A task reaches `approved` only when every **blocking** dimension has ≥1 current-round approval, quorum
//    is met, and there are **zero** current-round change requests."
//
// Three independent conditions. Cases 1-6 take them one at a time and then together, because a rule with
// three clauses has three ways to be quietly wrong and passing the happy path proves none of them.
//
// WHAT MAKES THIS WORTH PURE TESTS: every one of these conditions decides whether code merges reviewed. The
// state machine's guard (`canTransition`) can only ask "how many verdicts"; this is where "which dimensions,
// from which reviewers, against which commit" is decided, and none of it needs a database or a model.
//
// Cases:
//   1. the happy path, and each of the three conditions failing alone
//   2. quorum counts DISTINCT REVIEWERS, not verdicts — and honours `parentCounts` / `parentRequired`
//   3. `revisionBound`: an approval dies with the commit; a change request does NOT
//   4. `changeRequestBlocks` covers NON-blocking dimensions too
//   5. an `abstain` is neither an approval nor a block, and does not count toward quorum
//   6. every refusal names what is missing, because "not approved" is not actionable
//   7. findings are ranked, REFUTED never ships, and `unverified` is delivered labelled
//   8. `diffFindings` reports added / persisting / resolved — and a REPHRASED finding reads as new
//   9. profile resolution: `extends`, bare-id dimension selection, per-FIELD quorum merge
//  10. a malformed profile file THROWS and names the mistake; a missing one does not
//  11. profile precedence: perPath beats perTeam beats default, and says why
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import {
  VERDICTS, FINDING_VERDICTS, isVerdict,
  currentVerdicts, blockingDimensions, evaluateReview, rankFindings, diffFindings,
} from "../review.js";
import {
  loadReviewProfiles, profileFor, matchGlob, profileHash, BUILT_IN_DEFAULT, MODEL_DIVERSITY,
} from "../../config/review-profiles.js";

let failed = 0;
let n = 0;
/**
 * Numbered output and the WHOLE error, for `_mutate-runner.mjs` rather than for a human: it locates the
 * broken case by scanning `^  N.` lines and only credits a mutation caught by a real `AssertionError`.
 */
function testCase(name, fn) {
  n += 1;
  try { fn(); console.log(`  ${n}. ${name}`); } catch (err) {
    failed += 1;
    console.error(`  FAIL: ${name}`);
    console.error(err);
  }
}

/** The built-in default: correctness/security/tests blocking, quorum 2, parent does not count. */
const PROFILE = { ...BUILT_IN_DEFAULT, id: "default" };
const AT = { round: 1, commitSha: "abc123" };

/** One verdict row, in the shape `listReviewVerdicts` returns. */
const v = (workerId, dimension, verdict, extra = {}) => ({
  workerId, dimension, verdict, slot: extra.slot ?? "reviewer1", round: 1, commitSha: "abc123", ...extra,
});

/** Two reviewers approving every blocking dimension — the shape that SHOULD approve. */
function fullyApproved() {
  const out = [];
  for (const w of ["r1", "r2"]) {
    for (const d of ["correctness", "security", "tests"]) out.push(v(w, d, "approved", { slot: w === "r1" ? "reviewer1" : "reviewer2" }));
  }
  return out;
}

// ── 1 ────────────────────────────────────────────────────────────────────────────────────
testCase("the happy path approves, and each of the three conditions blocks on its own", () => {
  const ok = evaluateReview(fullyApproved(), PROFILE, AT);
  assert.equal(ok.approved, true, `two reviewers approving every blocking dimension must approve; reasons: ${ok.reasons}`);
  assert.deepEqual(ok.reasons, []);

  // (a) a blocking dimension with NO approval.
  const missingTests = fullyApproved().filter((x) => x.dimension !== "tests");
  const a = evaluateReview(missingTests, PROFILE, AT);
  assert.equal(a.approved, false, "every BLOCKING dimension needs an approval, not just some of them");
  assert.match(a.reasons.join(" "), /"tests" has no approval/);

  // (b) quorum short: one reviewer approving everything is not two reviewers.
  const oneReviewer = fullyApproved().filter((x) => x.workerId === "r1");
  const b = evaluateReview(oneReviewer, PROFILE, AT);
  assert.equal(b.approved, false, "one reviewer approving five dimensions has not met a quorum of two");
  assert.match(b.reasons.join(" "), /quorum not met: 1 of 2/);

  // (c) a single change request, with everything else green.
  const withChange = [...fullyApproved(), v("r2", "correctness", "changes-requested", { slot: "reviewer2" })];
  const c = evaluateReview(withChange, PROFILE, AT);
  assert.equal(c.approved, false, "ZERO current-round change requests — one is enough to block");
  assert.equal(c.changeRequests.length, 1);
});

// ── 2 ────────────────────────────────────────────────────────────────────────────────────
// Counting VERDICTS instead of reviewers is the version of this that works until one reviewer is thorough.
testCase("quorum counts distinct reviewers, and honours parentCounts / parentRequired", () => {
  const one = fullyApproved().filter((x) => x.workerId === "r1");
  assert.equal(evaluateReview(one, PROFILE, AT).quorum.distinctReviewers, 1,
    "three approvals from one reviewer is ONE reviewer");

  // The parent does not count by default (`parentCounts: false` in section 13's own table).
  const parentInstead = [
    ...one,
    ...["correctness", "security", "tests"].map((d) => v("parent", d, "approved", { slot: "parent" })),
  ];
  const noCount = evaluateReview(parentInstead, PROFILE, AT);
  assert.equal(noCount.quorum.distinctReviewers, 1, "the parent reviewer is excluded from quorum in this profile");
  assert.equal(noCount.approved, false);
  assert.match(noCount.reasons.join(" "), /parent reviewer does not count/,
    "and the refusal SAYS so — otherwise 'quorum not met: 1 of 2' with two visible approvers is baffling");

  // Flip the flag and the same verdicts pass.
  const counts = evaluateReview(parentInstead, { ...PROFILE, quorum: { ...PROFILE.quorum, parentCounts: true } }, AT);
  assert.equal(counts.quorum.distinctReviewers, 2);
  assert.equal(counts.approved, true);

  // `parentRequired` is a SEPARATE condition from quorum: "the parent must weigh in, and its opinion is not
  // one of the N" is a coherent combination, and this is the case that proves they are not the same knob.
  const required = { ...PROFILE, quorum: { required: 2, parentCounts: false, parentRequired: true } };
  const withoutParent = evaluateReview(fullyApproved(), required, AT);
  assert.equal(withoutParent.approved, false, "quorum met, parent absent, and the profile requires it");
  assert.match(withoutParent.reasons.join(" "), /parent reviewer's approval is required/);
  const withParent = evaluateReview([...fullyApproved(), v("parent", "correctness", "approved", { slot: "parent" })], required, AT);
  assert.equal(withParent.approved, true);
});

// ── 3 ────────────────────────────────────────────────────────────────────────────────────
// Section 13's opening complaint: "verdicts that outlive the commit they judged". The ASYMMETRY is the part
// worth asserting — a stale approval dies, a stale change request does not, because nobody said it was fixed.
testCase("revisionBound kills a stale approval but keeps a stale change request", () => {
  const stale = fullyApproved().map((x) => ({ ...x, commitSha: "old111" }));
  const evaluated = evaluateReview(stale, PROFILE, AT);
  assert.equal(evaluated.approved, false, "an approval of a different commit must not approve this one");
  assert.equal(evaluated.counted, 0, "and is not counted at all");

  // The other direction: a change request from the previous commit still blocks.
  const mixed = [...fullyApproved(), v("r2", "security", "changes-requested", { slot: "reviewer2", commitSha: "old111" })];
  const blocked = evaluateReview(mixed, PROFILE, AT);
  assert.equal(blocked.approved, false,
    "a change request from an earlier commit is STILL current — nobody has said it was fixed");
  assert.equal(blocked.changeRequests.length, 1);

  // With revisionBound off, approvals survive the commit change within the round...
  const loose = { ...PROFILE, revisionBound: false };
  assert.equal(evaluateReview(stale, loose, AT).approved, true, "revisionBound: false lets them survive");
  // ...but a ROUND boundary is absolute either way: a verdict from round 1 says nothing about round 2.
  const otherRound = fullyApproved().map((x) => ({ ...x, round: 1 }));
  assert.equal(evaluateReview(otherRound, loose, { round: 2, commitSha: "abc123" }).counted, 0,
    "a round boundary is not negotiable — `revisionBound: false` is about commits, not rounds");
  assert.equal(currentVerdicts(otherRound, { round: 2, commitSha: "abc123", revisionBound: false }).length, 0);
});

// ── 4 ────────────────────────────────────────────────────────────────────────────────────
// "any current-round change request blocks approval" — ANY, including on a dimension nobody marked blocking.
// Easy to implement as "blocking dimensions only" and be wrong in a way no happy path reveals.
testCase("changeRequestBlocks covers non-blocking dimensions too", () => {
  assert.equal(blockingDimensions(PROFILE).includes("performance"), false, "precondition: performance is not blocking");
  const withPerf = [...fullyApproved(), v("r2", "performance", "changes-requested", { slot: "reviewer2" })];
  const blocked = evaluateReview(withPerf, PROFILE, AT);
  assert.equal(blocked.approved, false,
    "a change request on a NON-blocking dimension still blocks when changeRequestBlocks is on");
  assert.match(blocked.reasons.join(" "), /non-blocking dimension "performance"/,
    "and the reason says why, because 'performance is not blocking' makes this look like a bug");

  // Turn the flag off and the same state approves — which is what the flag is for.
  const off = evaluateReview(withPerf, { ...PROFILE, changeRequestBlocks: false }, AT);
  assert.equal(off.approved, true);
  assert.deepEqual(off.changeRequests, []);
});

// ── 5 ────────────────────────────────────────────────────────────────────────────────────
testCase("an abstain is neither an approval nor a block, and does not fill quorum", () => {
  assert.deepEqual(VERDICTS, ["approved", "changes-requested", "abstain"]);
  assert.equal(isVerdict("looks-fine"), false, "an unknown verdict is not a verdict");

  const abstained = [
    ...fullyApproved().filter((x) => x.workerId === "r1"),
    ...["correctness", "security", "tests"].map((d) => v("r2", d, "abstain", { slot: "reviewer2" })),
  ];
  const e = evaluateReview(abstained, PROFILE, AT);
  assert.equal(e.quorum.distinctReviewers, 1, "abstaining does not fill a quorum slot");
  assert.equal(e.approved, false);
  assert.equal(e.changeRequests.length, 0, "but it does not block either — that is what abstain MEANS");
  assert.equal(e.dimensions.correctness.approvals, 1, "and the other reviewer's approval still stands");
});

// ── 6 ────────────────────────────────────────────────────────────────────────────────────
testCase("every refusal names what is missing", () => {
  const nothing = evaluateReview([], PROFILE, AT);
  assert.equal(nothing.approved, false);
  // One reason per unsatisfied blocking dimension, plus quorum. A single "not approved" would send a human
  // to read the verdict table by hand.
  for (const d of ["correctness", "security", "tests"]) {
    assert.ok(nothing.reasons.some((r) => r.includes(`"${d}"`)), `the refusal must name ${d}; got ${nothing.reasons}`);
  }
  assert.ok(nothing.reasons.some((r) => /quorum/.test(r)));
  assert.equal(nothing.dimensions.correctness.satisfied, false);
  assert.deepEqual(nothing.dimensions.correctness.approvedBy, [], "and reports WHO approved, for a UI that shows it");
  assert.throws(() => evaluateReview([], null, AT), /resolved review profile is required/,
    "and evaluating with no profile is refused rather than defaulted — an invented profile would decide merges");
});

// ── 7 ────────────────────────────────────────────────────────────────────────────────────
// Section 13: "the coder receives a ranked list of confirmed findings with `file:line`, not a review
// transcript", and findings that fail verification "never arrive".
testCase("findings are ranked, REFUTED never ships, unverified is delivered labelled", () => {
  const ranked = rankFindings([
    { file: "b.js", line: 2, summary: "maybe", verdict: "PLAUSIBLE" },
    { file: "c.js", summary: "nobody checked", verdict: "unverified" },
    { file: "d.js", line: 9, summary: "not real", verdict: "REFUTED" },
    { file: "a.js", line: 42, summary: "real bug", verdict: "CONFIRMED" },
  ]);
  assert.deepEqual(ranked.map((f) => f.verdict), ["CONFIRMED", "PLAUSIBLE", "unverified"],
    "CONFIRMED first, REFUTED absent — delivering a refuted finding would make verification a formality");
  assert.equal(ranked[0].at, "a.js:42", "`file:line` is the deliverable, built once here rather than per consumer");
  assert.equal(ranked[2].at, "c.js", "and degrades to the file when there is no line");
  assert.equal(rankFindings([{ file: "x", summary: "s" }])[0].verdict, "unverified",
    "a finding with NO verdict is unverified, never assumed confirmed");
  assert.equal(rankFindings([{ file: "x", summary: "s", verdict: "looks bad to me" }])[0].verdict, "unverified",
    "and an unrecognised verdict is not trusted either");
  assert.equal(rankFindings(null).length, 0);
  assert.equal(rankFindings([{ file: "d", summary: "s", verdict: "REFUTED" }], { includeRefuted: true }).length, 1,
    "a reviewer's own view can still show refuted findings — the filter is about what reaches the CODER");
  assert.deepEqual(FINDING_VERDICTS, ["CONFIRMED", "PLAUSIBLE", "REFUTED", "unverified"]);
});

// ── 8 ────────────────────────────────────────────────────────────────────────────────────
// "Store findings so a re-review can diff against the previous round instead of re-deriving it."
testCase("diffFindings reports added, persisting and resolved, and a rephrasing reads as new", () => {
  const prev = [
    { file: "a.js", line: 1, summary: "Off by one", verdict: "CONFIRMED" },
    { file: "b.js", line: 2, summary: "Missing await", verdict: "CONFIRMED" },
  ];
  const next = [
    { file: "a.js", line: 1, summary: "off by   one", verdict: "PLAUSIBLE" },  // same finding, reworded/re-verified
    { file: "c.js", line: 3, summary: "New problem", verdict: "CONFIRMED" },
  ];
  const d = diffFindings(prev, next);
  assert.deepEqual(d.added.map((f) => f.file), ["c.js"]);
  assert.deepEqual(d.persisting.map((f) => f.file), ["a.js"],
    "identity is file:line:summary NORMALISED, so casing and whitespace do not make a finding new — and neither does a changed verifier verdict");

  // WHAT NORMALISATION DOES NOT COVER, stated because the first version of this case called `"Off by one"` vs
  // `"off by   one"` a "rewording" and it is not one — those two strings are identical after normalisation, so
  // the assertion above proves tolerance of FORMATTING, not of rephrasing. Named by the Phase 6 review (sol).
  //
  // A genuinely rephrased finding IS treated as new, and that is a deliberate trade rather than an oversight:
  // the summary is part of the identity because two different problems on one line are two findings, and
  // dropping it from the key would merge them. The cost is that a reviewer who rewrites its wording produces
  // one `resolved` plus one `added`, which overstates progress on that round.
  const rephrased = diffFindings(
    [{ file: "a.js", line: 1, summary: "Off by one" }],
    [{ file: "a.js", line: 1, summary: "Index can exceed the array bounds" }],
  );
  assert.deepEqual(rephrased.persisting, [],
    "a rephrased finding is NOT recognised as the same finding — the summary is part of the identity");
  assert.equal(rephrased.added.length, 1);
  assert.equal(rephrased.resolved.length, 1,
    "it reads as one resolved and one added, which overstates progress — the price of keeping two findings on one line distinct");
  assert.deepEqual(d.resolved.map((f) => f.file), ["b.js"],
    "and a finding that stopped being reported is the only evidence the round produced anything");
  assert.deepEqual(diffFindings(null, null), { added: [], persisting: [], resolved: [] });
});

// ── 9 ────────────────────────────────────────────────────────────────────────────────────
// Section 13's own example, which is the reason `extends` is a small language rather than a merge: `hotfix`
// overrides `dimensions` with BARE ID STRINGS.
testCase("profile resolution: extends, bare-id dimensions, per-field quorum merge", () => {
  const cfg = loadReviewProfiles({
    fileText: `{
      "schemaVersion": 1,
      "profiles": {
        "hotfix":    { "extends": "default", "quorum": { "required": 1 },
                       "dimensions": ["correctness", "security"], "effort": "high" },
        "docs-only": { "extends": "default", "quorum": { "required": 1 },
                       "dimensions": ["correctness"], "verifyFindings": false, "effort": "low" }
      }
    }`,
  });
  const hotfix = cfg.profiles.hotfix;
  assert.deepEqual(hotfix.dimensions.map((d) => d.id), ["correctness", "security"],
    "a string list SELECTS from the parent's dimensions");
  assert.equal(hotfix.dimensions[0].blocking, true, "and carries the parent's `blocking`, not a default");
  assert.ok(hotfix.dimensions[0].prompt, "and its prompt — otherwise the reviewer is asked nothing");
  assert.equal(hotfix.quorum.required, 1);
  assert.equal(hotfix.quorum.parentCounts, false,
    "quorum merges per FIELD: overriding `required` must not reset `parentCounts` to nothing");
  assert.equal(hotfix.verifyFindings, true, "and unmentioned keys are inherited");
  assert.equal(cfg.profiles["docs-only"].verifyFindings, false, "...while a mentioned one is overridden");
  assert.ok(cfg.profiles.default, "a file with no `default` still gets one — perTeam/perPath may name any profile");

  // The hash is content-addressed and stable, which is what makes a stored verdict interpretable later.
  assert.equal(profileHash({ a: 1, b: 2 }), profileHash({ b: 2, a: 1 }), "key order is not identity");
  assert.notEqual(profileHash({ quorum: { required: 1 } }), profileHash({ quorum: { required: 2 } }),
    "but a changed rule IS a different profile");
  assert.equal(hotfix.hash.length, 16);
  assert.deepEqual(MODEL_DIVERSITY, ["require-distinct-harness", "any"]);
});

// ── 10 ───────────────────────────────────────────────────────────────────────────────────
// Loud on a typo, quiet on absence — the same asymmetry as `harness-defaults.json`, with higher stakes: these
// mistakes change whether code merges reviewed.
testCase("a malformed profile file throws and names the mistake; a missing one does not", () => {
  const ok = loadReviewProfiles({ fileText: '{"profiles":{}}' });
  assert.equal(ok.source, "built-in", "an empty profiles block falls back to the built-in default");
  assert.equal(ok.profiles.default.quorum.required, 2);

  assert.throws(() => loadReviewProfiles({ fileText: "{ not json" }), /not valid JSON/);
  assert.throws(() => loadReviewProfiles({ fileText: '{"schemaVersion":9,"profiles":{}}' }), /schemaVersion 9 is not supported/);
  assert.throws(
    () => loadReviewProfiles({ fileText: '{"profiles":{"p":{"quorum":{"requiredd":1}}}}' }),
    /unknown quorum key "requiredd"/,
    "a misspelled quorum key must be reported — silently ignoring it changes how many reviewers are needed",
  );
  assert.throws(() => loadReviewProfiles({ fileText: '{"profiles":{"p":{"blockign":true}}}' }), /unknown key "blockign"/);
  assert.throws(() => loadReviewProfiles({ fileText: '{"profiles":{"p":{"quorum":{"required":-1}}}}' }), /non-negative integer/);
  assert.throws(
    () => loadReviewProfiles({ fileText: '{"profiles":{"p":{"extends":"default","dimensions":["nonexistent"]}}}' }),
    /selects dimension "nonexistent"/,
    "selecting a dimension the parent does not define must fail — a profile that silently reviewed NOTHING would approve code with no blocking dimension unsatisfied",
  );
  assert.throws(() => loadReviewProfiles({ fileText: '{"profiles":{"a":{"extends":"b"},"b":{"extends":"a"}}}' }), /extends itself/,
    "a cycle is named rather than overflowing the stack at supervisor startup");
  assert.throws(
    () => loadReviewProfiles({ fileText: '{"profiles":{"d":{}},"perPath":[{"glob":"x/**","profile":"missing"}]}' }),
    /names profile "missing"/,
    "a path rule pointing at a missing profile would silently apply no extra strictness — which is the opposite of what it was written for",
  );
  assert.throws(() => loadReviewProfiles({ fileText: '{"profiles":{"p":{"modelDiversity":"whatever"}}}' }), /modelDiversity/);
  // TOP-LEVEL keys too. `perPaths` for `perPath` loaded cleanly and applied the DEFAULT profile to paths
  // somebody had deliberately made stricter — invisible and consequential, which is the worst combination in
  // a config file. Named by the Phase 6 review (sol); the validation existed before this assertion did.
  assert.throws(
    () => loadReviewProfiles({ fileText: '{"profiles":{"default":{}},"perPaths":[{"glob":"x/**","profile":"default"}]}' }),
    /unknown top-level key\(s\) perPaths/,
    "a misspelled routing key must be refused, not silently ignored",
  );
  assert.throws(() => loadReviewProfiles({ fileText: '{"profiles":{"default":{}},"perTeams":{"a":"default"}}' }), /unknown top-level key/);
  // A hand-written dimension defaults to NOT blocking: a dimension nobody marked must not become a merge gate.
  const hand = loadReviewProfiles({ fileText: '{"profiles":{"default":{"dimensions":[{"id":"style"}]}}}' });
  assert.equal(hand.profiles.default.dimensions[0].blocking, false);
});

// ── 11 ───────────────────────────────────────────────────────────────────────────────────
// perPath beats perTeam because it is the narrower statement: a team profile is a habit, `packages/payments/**`
// is a property of the code being changed.
testCase("profile precedence is perPath > perTeam > default, and says why", () => {
  const cfg = loadReviewProfiles({
    fileText: `{
      "profiles": {
        "default":  { "quorum": { "required": 2 } },
        "hotfix":   { "extends": "default", "quorum": { "required": 1 } },
        "payments": { "extends": "default", "quorum": { "required": 3 } }
      },
      "perTeam": { "vite": "hotfix" },
      "perPath": [ { "glob": "packages/payments/**", "profile": "payments" } ]
    }`,
  });

  const both = profileFor(cfg, { teamId: "vite", paths: ["packages/payments/charge.ts"] });
  assert.equal(both.profile.id, "payments", "the path rule wins over the team's own profile");
  assert.match(both.reason, /perPath .* matched packages\/payments\/charge\.ts/, "and says which file matched");

  assert.equal(profileFor(cfg, { teamId: "vite", paths: ["src/app.ts"] }).profile.id, "hotfix");
  assert.match(profileFor(cfg, { teamId: "vite", paths: [] }).reason, /perTeam "vite"/);
  assert.equal(profileFor(cfg, { teamId: "unknown-team", paths: [] }).profile.id, "default");
  assert.match(profileFor(cfg, {}).reason, /the default profile/);

  // The matcher, which is small on purpose.
  assert.equal(matchGlob("packages/payments/**", "packages/payments/deep/nested/x.ts"), true);
  assert.equal(matchGlob("packages/payments/**", "packages/other/x.ts"), false);
  assert.equal(matchGlob("src/*.ts", "src/a.ts"), true);
  assert.equal(matchGlob("src/*.ts", "src/a/b.ts"), false, "a single star does not cross a path separator");
  assert.equal(matchGlob("a.b", "axb"), false, "and a dot is a literal dot, not any character");
});

if (failed > 0) {
  console.error(`\n${failed} review case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: review rule + profile resolution");
