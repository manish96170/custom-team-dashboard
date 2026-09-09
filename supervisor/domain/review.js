// review.js — PLAN.md section 13's review rule, as a PURE module. Phase 6.
//
// THE RULE THIS FILE EXISTS FOR, quoted so it cannot drift:
//
//   "A task reaches `approved` (section 6) only when every **blocking** dimension has ≥1 current-round
//    approval, quorum is met, and there are **zero** current-round change requests."
//
// Three independent conditions, and each one is a different failure if it goes missing. They are evaluated
// separately and reported separately for exactly that reason: "not approved" is not an actionable answer,
// and "security has no approval yet; quorum is 1 of 2" is.
//
// WHAT "CURRENT ROUND" MEANS, and why it is the whole design
//
// Section 13 opens with what all four reviews independently found wrong: "verdicts that outlive the commit
// they judged". So a verdict is bound to a `(round, commitSha)` pair and NOTHING here counts a verdict from
// another one. `revisionBound: true` makes that strict — a new commit invalidates every approval against the
// old one, because an approval is a statement about code, not about a task.
//
// The subtle half is that `revisionBound: false` must NOT mean "count everything". It means approvals survive
// a commit change within the same round, which is a weaker claim than it sounds: a change request from an
// EARLIER commit is still current unless it was withdrawn, because nobody said it was fixed. Treating
// "revision-bound is off" as "ignore commits entirely" would let a stale approval and a stale change request
// cancel out, and the task would approve on the strength of two obsolete opinions.
//
// WHAT IS DELIBERATELY NOT HERE: any model call, any database access, any notion of who to ask next. This
// file answers "given these verdicts and this profile, is the task approvable, and if not, why not" — which
// is the question the state machine's guard needs, and the one that has to be assertable as a table.

/** The three verdicts a reviewer may return, per dimension. */
export const VERDICTS = Object.freeze(["approved", "changes-requested", "abstain"]);

/** What a finding's verification pass can conclude. See `rankFindings` for why `unverified` exists. */
export const FINDING_VERDICTS = Object.freeze(["CONFIRMED", "PLAUSIBLE", "REFUTED", "unverified"]);

export const isVerdict = (v) => VERDICTS.includes(v);

/**
 * The verdicts that count right now.
 *
 * `round` is compared always; `commitSha` only when the profile is revision-bound. An APPROVAL from another
 * commit is dropped under `revisionBound`, and a CHANGE REQUEST from another commit is kept — see the header:
 * nobody has said it was fixed, and dropping it would let two obsolete opinions cancel out.
 */
export function currentVerdicts(verdicts, { round, commitSha, revisionBound = true } = {}) {
  return (verdicts ?? []).filter((v) => {
    if (Number(v.round) !== Number(round)) return false;
    if (!revisionBound) return true;
    if (v.commitSha === commitSha) return true;
    // The asymmetry, stated in code because it is the part a reader will not expect.
    return v.verdict === "changes-requested";
  });
}

/**
 * Which dimensions the profile requires an approval on.
 *
 * A profile may list its dimensions as full objects or, when it `extends` another, as bare id strings —
 * section 13's own `hotfix` example does the latter (`"dimensions": ["correctness", "security"]`). The
 * config loader resolves that, so anything reaching here is a list of objects; this is the reader that
 * keeps the "blocking" question in one place.
 */
export function blockingDimensions(profile) {
  return (profile?.dimensions ?? []).filter((d) => d.blocking === true).map((d) => d.id);
}

/**
 * Evaluate a task's review state.
 *
 * @param {Array} verdicts  rows shaped like `{ workerId, slot, round, commitSha, dimension, verdict }`
 * @param {object} profile  a RESOLVED review profile (config/review-profiles.js)
 * @param {{ round: number, commitSha: string }} at  which revision is being judged
 *
 * @returns {{
 *   approved: boolean,
 *   reasons: string[],          // why not, in the order a human would want to act on them
 *   dimensions: object,         // per blocking dimension: approvals, changeRequests, satisfied
 *   quorum: { required, distinctReviewers, met, parentCounts },
 *   changeRequests: Array,      // current-round change requests, which block outright
 *   counted: number,
 * }}
 */
export function evaluateReview(verdicts, profile, { round, commitSha } = {}) {
  if (!profile) throw new Error("evaluateReview: a resolved review profile is required");
  const revisionBound = profile.revisionBound !== false;
  const current = currentVerdicts(verdicts, { round, commitSha, revisionBound });

  const blocking = blockingDimensions(profile);
  const dimensions = {};
  for (const id of blocking) {
    const forDim = current.filter((v) => v.dimension === id);
    const approvals = forDim.filter((v) => v.verdict === "approved");
    const changes = forDim.filter((v) => v.verdict === "changes-requested");
    dimensions[id] = {
      approvals: approvals.length,
      changeRequests: changes.length,
      // "≥1 current-round approval" — one is the bar per dimension; the COUNT of reviewers is quorum's
      // job, and conflating the two is how "two reviewers" silently became "two approvals on one
      // dimension and none on the others".
      satisfied: approvals.length >= 1 && changes.length === 0,
      approvedBy: approvals.map((v) => v.workerId),
    };
  }

  // Quorum counts DISTINCT REVIEWERS, not verdicts. A single reviewer that approved five dimensions has
  // not met a quorum of two, and counting rows would say it had.
  const quorumCfg = profile.quorum ?? {};
  const parentCounts = quorumCfg.parentCounts === true;
  const countable = current.filter((v) => (parentCounts ? true : v.slot !== "parent"));
  const distinctReviewers = new Set(
    countable.filter((v) => v.verdict !== "abstain").map((v) => v.workerId),
  );
  const required = Number.isInteger(quorumCfg.required) ? quorumCfg.required : 2;
  const quorumMet = distinctReviewers.size >= required;

  // The parent reviewer, when required, is a separate condition from quorum — `parentRequired: true` with
  // `parentCounts: false` is a coherent and deliberate combination (the parent must weigh in, and its
  // opinion is not one of the N).
  const parentRequired = quorumCfg.parentRequired === true;
  const parentApproved = current.some((v) => v.slot === "parent" && v.verdict === "approved");

  const changeRequests = profile.changeRequestBlocks === false
    ? []
    : current.filter((v) => v.verdict === "changes-requested");

  const reasons = [];
  for (const id of blocking) {
    const d = dimensions[id];
    if (d.changeRequests > 0) reasons.push(`blocking dimension "${id}" has ${d.changeRequests} change request(s)`);
    else if (d.approvals === 0) reasons.push(`blocking dimension "${id}" has no approval for this revision`);
  }
  if (!quorumMet) {
    reasons.push(
      `quorum not met: ${distinctReviewers.size} of ${required} distinct reviewer(s)`
      + `${parentCounts ? "" : " (the parent reviewer does not count toward quorum in this profile)"}`,
    );
  }
  if (parentRequired && !parentApproved) reasons.push("the parent reviewer's approval is required by this profile");
  // Listed last and separately from the per-dimension reasons: a change request on a NON-blocking dimension
  // still blocks approval when `changeRequestBlocks` is on, which is easy to miss and is what the profile
  // flag actually says ("any current-round change request blocks approval").
  const nonBlockingChanges = changeRequests.filter((v) => !blocking.includes(v.dimension));
  for (const v of nonBlockingChanges) {
    reasons.push(`change request on non-blocking dimension "${v.dimension}" — this profile's changeRequestBlocks is on`);
  }

  return {
    approved: reasons.length === 0,
    reasons,
    dimensions,
    quorum: { required, distinctReviewers: distinctReviewers.size, met: quorumMet, parentCounts, parentRequired, parentApproved },
    changeRequests: changeRequests.map((v) => ({ workerId: v.workerId, slot: v.slot, dimension: v.dimension })),
    counted: current.length,
    revisionBound,
  };
}

/**
 * What a coder is handed: confirmed findings, ranked, with `file:line`.
 *
 * Section 13: "the coder receives a ranked list of confirmed findings with `file:line`, not a review
 * transcript." So a REFUTED finding never arrives — that is the point of `verifyFindings`, and delivering it
 * anyway would make the verification pass a formality.
 *
 * `unverified` is its own verdict and is DELIVERED, labelled. The alternative would be to treat an
 * unverified finding as confirmed (dishonest — nothing checked it) or to drop it (worse — a real finding
 * disappears because no verifier was configured). Its rank is below CONFIRMED and PLAUSIBLE, so a coder
 * reads what is known to be real first.
 */
export function rankFindings(findings, { includeRefuted = false } = {}) {
  const ORDER = { CONFIRMED: 0, PLAUSIBLE: 1, unverified: 2, REFUTED: 3 };
  return (findings ?? [])
    .filter((f) => f && (includeRefuted || f.verdict !== "REFUTED"))
    .map((f) => ({
      ...f,
      // `file:line` is the deliverable, so it is built here rather than left to each consumer to format
      // (and to get wrong when `line` is absent).
      at: f.file ? `${f.file}${Number.isInteger(f.line) ? `:${f.line}` : ""}` : null,
      verdict: FINDING_VERDICTS.includes(f.verdict) ? f.verdict : "unverified",
    }))
    .sort((a, b) => (ORDER[a.verdict] ?? 9) - (ORDER[b.verdict] ?? 9));
}

/**
 * Diff two rounds' findings — section 13: "store findings so a re-review can diff against the previous
 * round instead of re-deriving it — round 3's second pass should cost a fraction of round 3's first."
 *
 * Identity is `file:line:summary`, normalised. Not a content hash of the whole object: a verifier's verdict
 * or a reviewer's wording can change between rounds while the finding is plainly the same one, and a
 * too-strict identity reports every persisting finding as new — which would cost MORE than re-deriving,
 * since the coder then re-reads everything.
 */
export function diffFindings(previous, next) {
  const key = (f) => [
    String(f?.file ?? "").trim().toLowerCase(),
    Number.isInteger(f?.line) ? f.line : "",
    String(f?.summary ?? "").trim().toLowerCase().replace(/\s+/g, " "),
  ].join(":");

  const before = new Map((previous ?? []).map((f) => [key(f), f]));
  const after = new Map((next ?? []).map((f) => [key(f), f]));
  const added = [...after].filter(([k]) => !before.has(k)).map(([, f]) => f);
  const persisting = [...after].filter(([k]) => before.has(k)).map(([, f]) => f);
  // "Resolved" is a claim about what the coder fixed, and it is the reason a diff is worth storing: a
  // finding that stops being reported is the only evidence a round produced anything.
  const resolved = [...before].filter(([k]) => !after.has(k)).map(([, f]) => f);
  return { added, persisting, resolved };
}
