#!/usr/bin/env node
// _mutate-review.mjs — mutation harness for configurable reviews (PLAN.md section 13). Phase 6.
//
// Same standing rule: break one mechanism, and the suite must fail BY ASSERTION at the case that protects
// it. A mutation that merely crashes proves nothing.
//
// WHY THIS SET IS THE MOST CONSEQUENTIAL IN THE PROJECT: every mutation below makes the system approve code
// that a human intended to be reviewed. None of them throws, none of them is visible in a happy path, and
// each one is a plausible simplification somebody would defend in review — "surely one approval per task is
// enough", "surely a change request on a non-blocking dimension shouldn't block", "surely we can count
// verdicts instead of reviewers". Section 13 exists because all four independent reviews of PLAN.md found the
// original review model rigid and underspecified; these are the ways the fix silently un-fixes itself.
//
// R1 and R6 are the two to read. R1 counts verdicts rather than distinct reviewers, so one thorough reviewer
// satisfies a quorum of two. R6 lets `approveTask` transition even when the rule refused — the same shape as
// the pre-Phase-5 state machine, where `canTransition` computed a verdict nothing consulted.
//
// Usage: node runtime/test/_mutate-review.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  review: path.join(SUPERVISOR, 'domain/review.js'),
  config: path.join(SUPERVISOR, 'config/review-profiles.js'),
  supervisor: path.join(SUPERVISOR, 'runtime/supervisor.js'),
  db: path.join(SUPERVISOR, 'db/index.js'),
};

const PURE = 'domain/test/review.test.js';
const WIRED = 'runtime/test/review.test.js';

const MUTATIONS = [
  {
    name: 'R1-quorum-counts-verdicts-not-reviewers',
    breaksCase: 'quorum counts distinct reviewers, and honours parentCounts / parentRequired',
    file: F.review,
    why: "Counting verdict ROWS instead of distinct reviewers. One reviewer approving five dimensions then satisfies a quorum of two, so a task ships with a single pair of eyes on it while the dashboard reports the quorum as met. Note that this is invisible in every test with two cooperating reviewers -- it only shows up in the case that matters, which is one reviewer being thorough.",
    breaks: 'review case 2 (three approvals from one reviewer is ONE reviewer)',
    test: PURE,
    find: `  const distinctReviewers = new Set(
    countable.filter((v) => v.verdict !== "abstain").map((v) => v.workerId),
  );`,
    replace: `  const distinctReviewers = countable.filter((v) => v.verdict !== "abstain"); // MUTANT: rows, not reviewers`,
  },
  {
    name: 'R2-blocking-dimensions-not-all-required',
    breaksCase: 'the happy path approves, and each of the three conditions blocks on its own',
    file: F.review,
    why: "Approving when SOME blocking dimension has an approval rather than every one. Section 13 says 'every blocking dimension has >=1 current-round approval' -- so this ships code where correctness was approved and security was never looked at, which is the single most valuable thing per-dimension verdicts were introduced to prevent.",
    breaks: 'review case 1 (a blocking dimension with no approval)',
    test: PURE,
    find: `  for (const id of blocking) {
    const d = dimensions[id];
    if (d.changeRequests > 0) reasons.push(\`blocking dimension "\${id}" has \${d.changeRequests} change request(s)\`);
    else if (d.approvals === 0) reasons.push(\`blocking dimension "\${id}" has no approval for this revision\`);
  }`,
    replace: `  if (blocking.length && blocking.every((id) => dimensions[id].approvals === 0)) {
    reasons.push("no blocking dimension has an approval"); // MUTANT: only ALL-missing blocks
  }`,
  },
  {
    name: 'R3-stale-approval-survives-the-commit',
    breaksCase: 'revisionBound kills a stale approval but keeps a stale change request',
    file: F.review,
    why: "Letting an approval of an earlier commit approve the current one. This is section 13's opening complaint verbatim -- 'verdicts that outlive the commit they judged' -- and it is the failure with the widest blast radius: a reviewer approves, the coder pushes anything at all, and the approval still stands.",
    breaks: 'review case 3 (an approval of a different commit does not approve this one)',
    test: PURE,
    find: `    if (!revisionBound) return true;
    if (v.commitSha === commitSha) return true;`,
    replace: `    if (true) return true; // MUTANT: the commit is ignored`,
  },
  {
    name: 'R4-stale-change-request-dropped',
    breaksCase: 'revisionBound kills a stale approval but keeps a stale change request',
    file: F.review,
    why: "Dropping a change request from an earlier commit along with the approvals. The asymmetry is deliberate: nobody has said the problem was fixed, so a new commit must not silently clear it. Symmetric treatment lets a stale approval and a stale change request cancel out, and the task approves on the strength of two obsolete opinions.",
    breaks: 'review case 3 (a change request from an earlier commit is still current)',
    test: PURE,
    find: `    return v.verdict === "changes-requested";`,
    replace: `    return false; // MUTANT: stale change requests are dropped too`,
  },
  {
    name: 'R5-change-request-only-blocks-its-own-dimension',
    breaksCase: 'changeRequestBlocks covers non-blocking dimensions too',
    file: F.review,
    why: "Treating a change request on a non-blocking dimension as advisory. The profile flag says 'any current-round change request blocks approval', and 'non-blocking' describes whether an APPROVAL is required there -- not whether a reviewer's objection counts. A reviewer who found a real performance problem would watch it merge.",
    breaks: 'review case 4 (a change request on a non-blocking dimension still blocks)',
    test: PURE,
    find: `  const nonBlockingChanges = changeRequests.filter((v) => !blocking.includes(v.dimension));`,
    replace: `  const nonBlockingChanges = []; // MUTANT: objections outside blocking dimensions are advisory`,
  },
  {
    name: 'R6-approveTask-transitions-anyway',
    file: F.supervisor,
    why: "Evaluating the review rule and then transitioning regardless. The exact shape of the defect Phase 5 fixed one layer down, where `canTransition` computed a verdict nothing consulted: a rule nothing enforces is a comment. Worse here, because the refusal REASONS are still returned, so a caller sees 'refused' in the payload while the task sits in `approved`.",
    breaks: 'review case 6 (a refusal does not move the task)',
    test: WIRED,
    find: `    if (!status.approved) {
      return { taskId, approved: false, refused: status.reasons, status };
    }`,
    replace: `    if (false) { /* MUTANT: the rule is computed and ignored */ }`,
  },
  {
    name: 'R7-findings-verified-after-storage',
    file: F.supervisor,
    why: "Storing findings unverified and leaving the filter to the reader. Section 13 says findings that fail verification 'never arrive'; a REFUTED finding stored as if confirmed is one query away from a coder, and the whole point of the second pass is that a coder's time is not spent on findings that do not reproduce.",
    breaks: 'review case 4 (a REFUTED finding never reaches the coder)',
    test: WIRED,
    // RE-ANCHORED, and re-aimed at the ORDER rather than at verification's existence — the Phase 6 review
    // (sol) pointed out that removing verification altogether is caught for a different reason than this
    // mutation's name claims. This version stores the raw findings FIRST and rewrites them after verifying,
    // which is exactly the version that used to pass: the stored row ends up correct, and a concurrent reader
    // in between is handed an unverified finding.
    find: `      const findings = profile.verifyFindings === false
        ? (v.findings ?? []).map((f) => ({ ...f, verdict: f.verdict ?? "unverified" }))
        : await verifyFindings(v.findings ?? [], { profile, taskId: v.taskId });
      recordReviewVerdict(database, {`,
    replace: `      recordReviewVerdict(database, { ...v, slot, findings: v.findings ?? [], profileId: profile.id, profileHash: profile.hash });
      const findings = profile.verifyFindings === false
        ? (v.findings ?? []).map((f) => ({ ...f, verdict: f.verdict ?? "unverified" }))
        : await verifyFindings(v.findings ?? [], { profile, taskId: v.taskId }); // MUTANT: stored first, verified after
      recordReviewVerdict(database, {`,
  },
  {
    name: 'R8-unverified-findings-called-confirmed',
    breaksCase: 'findings are ranked, REFUTED never ships, unverified is delivered labelled',
    file: F.review,
    why: "Promoting a finding with no verdict to CONFIRMED. It is the tempting default -- a reviewer reported it, after all -- and it is a lie the coder cannot detect: `unverified` exists precisely so 'nothing checked this' is visible rather than dressed up as verified. Same boundary as the tier-2 digester's `source` field.",
    breaks: 'review case 7 (a finding with no verdict is unverified)',
    test: PURE,
    find: `      verdict: FINDING_VERDICTS.includes(f.verdict) ? f.verdict : "unverified",`,
    replace: `      verdict: FINDING_VERDICTS.includes(f.verdict) ? f.verdict : "CONFIRMED", // MUTANT: assumed real`,
  },
  {
    name: 'R9-profile-edit-rewrites-history',
    file: F.db,
    why: "Replacing a profile row on re-import instead of inserting a new one. RATIONALE CORRECTED after the Phase 6 review (sol) pointed out that the original claim was wrong: `INSERT OR REPLACE` cannot overwrite an EDITED profile, because a changed profile has a different `(id, config_hash)` primary key. What it actually breaks is idempotence for an unchanged one -- `imported_at` is rewritten on every boot, so 'when did this profile first appear' stops being answerable, which is the question anyone asks when a stored verdict's meaning is in doubt. The reinterpretation failure it was originally credited with is mutation R17 instead.",
    breaks: 'review cases 1 and 2 (an identical re-import writes nothing; an edit adds a row)',
    test: WIRED,
    find: `    \`INSERT OR IGNORE INTO review_profiles (id, config_hash, config_json, imported_at) VALUES (?, ?, ?, ?)\`,`,
    replace: `    \`INSERT OR REPLACE INTO review_profiles (id, config_hash, config_json, imported_at) VALUES (?, ?, ?, ?)\`, // MUTANT`,
  },
  {
    name: 'R10-reviewer-revision-appends-a-second-row',
    file: F.db,
    why: "Appending when a reviewer revises its own verdict on the same dimension and round, instead of replacing. 'Which of these two is current' then has no answer in the data, and the rule counts current-round verdicts -- so a reviewer who requested changes and then approved has BOTH on record, and the change request blocks forever.",
    breaks: 'review case 3 (a revised opinion replaces its own row)',
    test: WIRED,
    find: `     ON CONFLICT (task_id, round, commit_sha, worker_id, dimension) DO UPDATE SET
       verdict = excluded.verdict,
       findings_json = excluded.findings_json,
       slot = excluded.slot,
       profile_id = excluded.profile_id,
       profile_hash = excluded.profile_hash,
       at = excluded.at\`,`,
    // `DO NOTHING`, which is VALID SQL — the first version replaced only the `DO UPDATE SET` line and left
    // the assignments dangling, so the mutant was a syntax error and the suite crashed rather than
    // asserting. A mutation that cannot parse proves nothing (the runner says so), and the fix is to mutate
    // a whole statement rather than a line of one.
    replace: `     ON CONFLICT (task_id, round, commit_sha, worker_id, dimension) DO NOTHING\`,`,
  },
  {
    name: 'R11-dimension-selection-invents-dimensions',
    breaksCase: 'a malformed profile file throws and names the mistake; a missing one does not',
    file: F.config,
    why: "Tolerating a dimension id the parent profile does not define. The profile then reviews FEWER dimensions than its author wrote -- and in the limit reviews nothing, which means every blocking dimension is trivially satisfied and the task approves with no review at all. A silent typo in a config file becoming 'approve everything' is the worst failure available in this module.",
    breaks: 'review case 10 (selecting an undefined dimension is refused)',
    test: PURE,
    find: `      if (!found) {
        throw new Error(`,
    replace: `      if (false) {
        throw new Error(`,
  },
  {
    name: 'R12-quorum-override-resets-the-rest',
    breaksCase: 'profile resolution: extends, bare-id dimensions, per-field quorum merge',
    file: F.config,
    why: "Replacing the whole `quorum` object when a profile overrides one field. Section 13's own `hotfix` example overrides only `required`, so this silently drops `parentCounts` -- and `parentCounts: undefined` is falsy in the same direction, which is exactly why it survives casual testing. The bug surfaces the day a profile needs the parent to count.",
    breaks: 'review case 9 (quorum merges per field)',
    test: PURE,
    find: `  merged.quorum = { ...(base.quorum ?? {}), ...(own.quorum ?? {}) };`,
    replace: `  merged.quorum = own.quorum ? { ...own.quorum } : { ...(base.quorum ?? {}) }; // MUTANT: whole-object replacement`,
  },
  {
    name: 'R13-perTeam-beats-perPath',
    breaksCase: 'profile precedence is perPath > perTeam > default, and says why',
    file: F.config,
    why: "Letting a team's habitual profile win over a path rule. The reason section 13 has `perPath` at all is that `packages/payments/**` must be stricter than whatever the owning team normally does -- so inverting the precedence removes the strictness exactly where it was asked for, and nowhere else.",
    breaks: 'review case 11 (the path rule wins over the team profile)',
    test: PURE,
    find: `  for (const rule of config.perPath ?? []) {`,
    replace: `  if (teamId && config.perTeam?.[teamId]) {
    const n = config.perTeam[teamId];
    return { profile: config.profiles[n], reason: \`perTeam "\${teamId}" -> "\${n}"\` }; // MUTANT: team wins
  }
  for (const rule of config.perPath ?? []) {`,
  },
  {
    name: 'R14-findings-diff-too-strict',
    breaksCase: 'diffFindings reports added, persisting and resolved',
    file: F.review,
    why: "Identifying a finding by its whole content, so a reworded or re-verified finding reads as new. Section 13's reason for storing findings is that 'round 3's second pass should cost a fraction of round 3's first' -- and a diff that reports everything as new costs MORE than re-deriving, because the coder re-reads the whole list and the `resolved` set (the only evidence a round achieved anything) is always empty.",
    breaks: 'review case 8 (a reworded finding is the same finding)',
    test: PURE,
    find: `  const key = (f) => [
    String(f?.file ?? "").trim().toLowerCase(),
    Number.isInteger(f?.line) ? f.line : "",
    String(f?.summary ?? "").trim().toLowerCase().replace(/\\s+/g, " "),
  ].join(":");`,
    replace: `  const key = (f) => JSON.stringify(f); // MUTANT: whole-object identity`,
  },
  {
    name: 'R16-verdict-id-ignores-the-commit',
    file: F.db,
    why: "Leaving the commit out of the generated verdict id. THIS WAS PRODUCTION BEHAVIOUR until the Phase 6 review (sol) found it: `commit_sha` is part of the uniqueness tuple but was not part of the primary key, so a reviewer re-reviewing the same dimension in the same round after a new commit hit `UNIQUE constraint failed: review_verdicts.id` instead of its intended conflict target. Revision-bound re-review inside a round -- the exact workflow section 13 is built around -- could not be recorded at all, and the pre-existing round/commit test could not see it because it only EVALUATES stored rows and never attempts the second write.",
    breaks: 'review case 12 (a reviewer can re-review after a new commit)',
    test: WIRED,
    find: `    id: v.id ?? \`rv-\${v.taskId}-\${v.round}-\${v.commitSha}-\${v.workerId}-\${v.dimension}\`,`,
    replace: `    id: v.id ?? \`rv-\${v.taskId}-\${v.round}-\${v.workerId}-\${v.dimension}\`, // MUTANT: commit dropped from the id`,
  },
  {
    name: 'R17-verdicts-reinterpreted-under-the-current-profile',
    file: F.supervisor,
    why: "Evaluating a round under the CURRENT profile instead of the one its verdicts were judged under. This was production behaviour too: migration 0009 stores every profile content-addressed and stamps every verdict with its hash precisely to prevent this, and `reviewStatus` read neither -- so loosening a profile made an insufficient set of verdicts approve the task. A mechanism that is built, stored and never read is the most expensive kind of dead code, because the document says it is protecting you.",
    breaks: 'review case 13 (verdicts are evaluated under the profile they were judged under)',
    test: WIRED,
    find: `    if (hashes.length === 1 && hashes[0] !== current.profile.hash) {`,
    replace: `    if (false) { // MUTANT: the round's own profile is ignored`,
  },
  {
    name: 'R18-verdict-identity-taken-from-the-request',
    file: F.supervisor,
    why: "Trusting the `workerId` a caller sends. Quorum counts distinct worker ids, so a caller could reach a quorum of two by naming any second worker -- one on another task entirely -- and the review rule would report the quorum as met. The rule itself stays correct; its INPUT is forged, which is why this had to be fixed at the boundary rather than in `evaluateReview`.",
    breaks: 'review case 14 (a worker from another task cannot cast a verdict)',
    test: WIRED,
    find: `      if (worker.taskId !== v.taskId) {`,
    replace: `      if (false) { // MUTANT: membership unchecked`,
  },
  {
    name: 'R19-slot-taken-from-the-request',
    file: F.supervisor,
    why: "Accepting the `slot` a caller declares. `slot === \"parent\"` is what `parentRequired` checks, so a caller that can set it is certifying its own authority -- the profile's parent-reviewer requirement becomes a field in the request that satisfies it. Deriving the slot from the assignment record is what makes that guard mean anything.",
    breaks: 'review case 14 (the registry\'s slot wins over the caller\'s claim)',
    test: WIRED,
    find: `      const slot = derivedSlotFor(v.taskId, worker);`,
    replace: `      const slot = v.slot ?? derivedSlotFor(v.taskId, worker); // MUTANT: the caller may declare its slot`,
  },
  {
    name: 'R20-invented-dimensions-accepted',
    file: F.supervisor,
    why: "Accepting a dimension no profile defines. It satisfies no blocking dimension, so it looks harmless -- and it counts toward QUORUM, which is the whole point: a reviewer can pad the distinct-reviewer count with judgements about nothing.",
    breaks: 'review case 14 (an invented dimension is refused)',
    test: WIRED,
    find: `      if (!dimensions.includes(v.dimension)) {`,
    replace: `      if (false) { // MUTANT: any dimension name is accepted`,
  },
  {
    name: 'R21-approveTask-trusts-the-round-it-is-given',
    file: F.supervisor,
    why: "Letting the caller choose which round the rule is applied to. Production behaviour before the Phase 6 review: with a green round 1 and a change request in round 2, `approveTask({ round: 1 })` evaluated round 1 and transitioned the task. The rule was correct and the caller picked the reality -- which is worse than a broken rule, because every log line reads as a legitimate approval.",
    breaks: 'review case 15 (approving an older round is refused)',
    test: WIRED,
    find: `    if (round !== null && Number(round) !== Number(authoritativeRound)) {`,
    replace: `    if (false) { // MUTANT: the caller's round is used as-is`,
  },
  {
    name: 'R22-approval-not-serialized-against-verdicts',
    file: F.supervisor,
    why: "Approving without taking the per-task lock. `recordVerdict` awaits a verifier that may call a model and IPC handlers run concurrently, so an approval evaluated the stored rows mid-verification and transitioned the task -- after which the change request landed on an already-approved task whose own `reviewStatus()` reported it blocked. The two answers disagreeing is the observable failure, and it needs a deferred-promise verifier to produce deterministically.",
    breaks: 'review case 16 (an approval cannot slip past a verdict in flight)',
    test: WIRED,
    find: `    return withTaskLock(taskId, () => approveTaskLocked(taskId, opts));`,
    replace: `    return Promise.resolve(approveTaskLocked(taskId, opts)); // MUTANT: no serialization`,
  },
  {
    name: 'R23-refuted-findings-reach-the-coder-through-the-diff',
    file: F.supervisor,
    why: "Diffing the raw findings instead of the delivered ones. `ranked` excluded REFUTED findings while `diff.added` shipped them, and the whole object goes over the socket to whoever is fixing the code -- so the adversarial second pass was a formality by a side door. Production behaviour until the Phase 6 review (sol) found it.",
    breaks: 'review case 17 (a REFUTED finding arrives through neither ranked nor diff)',
    test: WIRED,
    find: `      diff: diffFindings(shipped(prevRound), shipped(thisRound)),`,
    replace: `      diff: diffFindings(prevRound, thisRound), // MUTANT: unfiltered`,
  },
  {
    name: 'R24-finished-tasks-keep-a-review-bar',
    file: F.supervisor,
    why: "Reporting a review for every task that ever recorded a verdict. The TUI clears its review bar by the task's ABSENCE from this map, so an approved task kept a bar forever -- and the client-side clearing test passed because its fixture supplied an empty map by hand. Two vacuities meeting: the backend never cleared, and nothing noticed because the test never asked the backend.",
    breaks: 'review case 10 (an approved task is absent from the snapshot)',
    test: WIRED,
    find: `          WHERE t.state NOT IN ('approved', 'merged', 'failed', 'cancelled', 'start-failed')\`,`,
    replace: `          WHERE 1 = 1 /* MUTANT: finished tasks keep their review bar */\`,`,
  },
  {
    name: 'R25-finding-count-is-the-truncated-length',
    file: F.supervisor,
    why: "Sending only the first five findings and no total. The bar then renders the slice's length, so six findings and sixty both read as '5 finding(s)' -- a wrong number rather than a truncated list, and nothing about it looks truncated.",
    breaks: 'review case 10 (the snapshot carries a real finding count)',
    test: WIRED,
    find: `          findingCount: s.findingCount ?? s.findings.length,`,
    replace: `          // MUTANT: no count is sent`,
  },
  {
    name: 'R26-top-level-config-typos-ignored',
    breaksCase: 'a malformed profile file throws and names the mistake; a missing one does not',
    file: F.config,
    why: "Not validating top-level keys. `perPaths` instead of `perPath` loads cleanly and applies the DEFAULT profile to paths somebody deliberately made stricter -- the one typo in this file that is both invisible and consequential. Found by the Phase 6 review (sol).",
    breaks: 'review case 10 pure (an unknown top-level key is refused)',
    test: PURE,
    find: `  const unknownTop = Object.keys(parsed).filter((k) => !TOP_LEVEL.includes(k));`,
    replace: `  const unknownTop = []; // MUTANT: top-level typos ignored`,
  },
  {
    name: 'R27-verdict-recorded-after-approval',
    file: F.supervisor,
    why: "Allowing a verdict on a task that is already approved or merged. It cannot change the decision (PLAN.md section 6 has no edge back from `approved`), so it silently accumulates rows that make `reviewStatus` disagree with `tasks.state` -- the dashboard then shows a blocked review for a task the system considers done.",
    breaks: 'review case 16 / 6 (a decided task refuses further verdicts)',
    test: WIRED,
    find: `      if (task.state === "approved" || task.state === "merged") {`,
    replace: `      if (false) { // MUTANT: verdicts accepted after the decision`,
  },
  {
    name: 'R15-model-diversity-not-checked',
    file: F.supervisor,
    why: "Not validating the profile's `modelDiversity`. Section 13 promotes it from a habit to 'a validated profile property' on specific evidence -- the four reviews that produced PLAN.md's own revision ran on two harnesses, and the highest-value findings each appeared in exactly one of them. Unchecked, two reviewers quietly end up on one model and the review looks twice as thorough as it is.",
    breaks: 'review case 9 (a diversity violation is reported)',
    test: WIRED,
    find: `    const diversity = checkModelDiversity(taskId, plan);`,
    replace: `    const diversity = { violation: false }; // MUTANT: never checked`,
  },
];

const exitCode = await runMutations(MUTATIONS, { cwd: SUPERVISOR, filter: process.argv[2] });
process.exit(exitCode);
