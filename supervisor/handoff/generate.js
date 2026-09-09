// generate.js — the tier-3 task handoff (PLAN.md section 8, Rule 4).
//
// WHAT THIS IS
//
// Rule 4's three tiers over one `event_log`: tier 1 is raw events for humans in panes, tier 2 is a
// per-turn digest for a resumed worker, tier 3 is a rolling ~1 page task handoff read by the CTO,
// leads, reviewers, and any new or cleared worker. **Hard rule: no agent ever reads tier 1** --
// without it the CTO's context explodes at roughly three concurrent workers, which is exactly the
// scale the project targets. Tier 3 is also the shared task memory section 1 promised.
//
// PURE, AND DETERMINISTIC, ON PURPOSE
//
// This makes no model call. Rule 4 says tier 2 is written "by the cheapest available model", and
// that is true of tier 2 -- but a tier-3 document assembled from structured facts (what state the
// task is in, which transitions happened, what is blocked, what the diff looks like) does not need
// a model to write it, and there are three reasons not to use one here:
//
//   1. It is testable. A generator whose output depends on a model can be checked for shape but
//      never for content, and "prove the mechanism, not just the schema" is the actual requirement.
//   2. It is free, so it can run on every state transition (Rule 5's whole premise: clearing is
//      routine BECAUSE tier 3 is cheap). A model call per transition is a recurring cost on the
//      most frequent event in the system.
//   3. It cannot hallucinate. A handoff that invents a decision nobody made is worse than no
//      handoff, because its readers are agents that will act on it.
//
// The seam for a model is `assumptions`, and it is now FED BY TIER 2 rather than guessed here
// (domain/turn-digest.js). Tier 2 is the only layer that sees a worker's own words, so it is the only
// layer that can say what the worker treated as true; tier 3 quotes those digests and attributes each
// one to its turn. When no digest states an assumption this section is still empty -- but it now says
// which of the two reasons applies, because "nobody assumed anything" and "nothing was digested" are
// different facts and a reader acts differently on each.
//
// THE ONE PLACE THIS READS TIER 1
//
// `runs` and open `asks` are structured rows, not tier-1 events, so most of this touches no
// transcript at all. Where it does look at `event_log` it counts and classifies rather than quoting,
// and it is code rather than an agent -- Rule 4's prohibition is on AGENTS reading tier 1, since the
// thing that turns tier 1 into a summary must by definition read it. Nothing here copies transcript
// text into the document.

import { execFileSync } from "node:child_process";
import { listTaskTurnDigests } from "../db/index.js";

/** Rule 4: "rolling ~1 page". ~4000 chars is about a page of prose, or ~1000 tokens. */
export const DEFAULT_BUDGET_CHARS = 4000;

/**
 * How many items each list section keeps. Bounded per-section rather than only globally, so that
 * one very long section cannot starve the others -- a task with 200 transitions would otherwise
 * push the blockers off the end of the page, and blockers are the most actionable thing in the
 * document.
 */
const SECTION_LIMITS = { decisions: 12, artifacts: 20, blockers: 15, workers: 10, assumptions: 8 };

/** Newest-first, because a handoff is read to find out where things stand now. */
const byNewest = (a, b) => String(b.at ?? b.created_at ?? "").localeCompare(String(a.at ?? a.created_at ?? ""));

/**
 * `git diff --stat` for the task's branch, or an honest note about why there is none.
 *
 * Best-effort and never throws: a handoff must be producible for a task with no repo, no worktree,
 * or a `base_rev` that no longer exists. Returning a note is the useful behaviour -- "no diff
 * information available (no worktree recorded)" tells a reader something, whereas a thrown error
 * loses the other five sections too.
 */
export function diffShape(task, { exec = execFileSync } = {}) {
  if (!task?.worktree_id) return { text: "no diff information: no worktree recorded for this task", ok: false };
  if (!task?.base_rev) return { text: "no diff information: no base_rev recorded, so there is nothing to diff against", ok: false };
  try {
    const out = exec("git", ["diff", "--stat", `${task.base_rev}..HEAD`], {
      cwd: task.worktree_id,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    const text = String(out).trim();
    return text ? { text, ok: true } : { text: "no changes yet against base_rev", ok: true };
  } catch (err) {
    // A wrong `base_rev`, a missing worktree, git not installed -- all the same shape to a reader:
    // the diff could not be read, and here is why.
    return { text: `no diff information: ${String(err?.shortMessage ?? err?.message ?? err).split("\n")[0]}`, ok: false };
  }
}

/**
 * Assemble the facts a handoff is made of. Separated from rendering so the SOURCES can be asserted
 * directly -- "which transitions and which asks did this see" is the first question anyone asks of a
 * summary they do not trust, and a summary nobody trusts is worse than none.
 */
export function collectHandoffFacts(db, taskId, { exec } = {}) {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);

  const transitions = db
    .prepare(`SELECT * FROM transition_journal WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT ?`)
    .all(taskId, SECTION_LIMITS.decisions + 1);

  // Runs reach a task through their worker, the same join `taskIdForRun` uses. Preflight runs are
  // EXCLUDED: they are not work anyone should read about (migration 0005), and a handoff is the
  // most human-facing view in the system.
  const runs = db
    .prepare(
      `SELECT r.*, w.nickname AS worker_nickname, w.role AS worker_role
         FROM runs r JOIN workers w ON w.worker_id = r.worker_id
        WHERE w.task_id = ? AND r.is_preflight = 0
        ORDER BY r.started_at DESC`,
    )
    .all(taskId);

  const openRuns = runs.filter((r) => r.ended_at === null);
  const orphans = openRuns.filter((r) => r.lifecycle === "orphaned-unmanaged");

  // Blockers, from structured rows rather than from transcript text. An unresolved ask IS a
  // blocker, definitionally -- a worker is stopped waiting for it.
  const asks = runs.length
    ? db
        .prepare(
          `SELECT * FROM asks WHERE resolved = 0 AND run_id IN (${runs.map(() => "?").join(",")})
            ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...runs.map((r) => r.run_id), SECTION_LIMITS.blockers)
    : [];

  // Counted, never quoted: this is the only place tier 1 is touched, and it contributes a shape
  // (how much happened, and whether any of it errored) rather than any transcript content.
  const activity = runs.length
    ? db
        .prepare(
          `SELECT type, COUNT(*) AS n FROM event_log
            WHERE tier = 1 AND run_id IN (${runs.map(() => "?").join(",")})
            GROUP BY type ORDER BY n DESC`,
        )
        .all(...runs.map((r) => r.run_id))
    : [];

  // Tier 2, the source for `assumptions`. NOT tier 1: these rows are already summaries, so reading them
  // is the intended direction of Rule 4's cascade (1 -> 2 -> 3) rather than an exception to it. Only the
  // digests that actually carry an assumption are kept, but `digestedTurns` records how many were seen
  // so the empty case can distinguish "nothing assumed" from "nothing digested".
  const digests = listTaskTurnDigests(db, taskId);
  const assumptions = [];
  // DE-DUPLICATED BY TEXT, first occurrence kept. The same assumption restated in a later turn is one
  // assumption to a reader, and listing it twice would suggest two independent statements of it --
  // inflating the evidence for something nobody verified, in the section most likely to be acted on.
  const seen = new Set();
  for (const d of digests) {
    for (const a of Array.isArray(d.assumptions) ? d.assumptions : []) {
      if (typeof a !== "string" || !a.trim()) continue;
      const text = a.trim();
      const norm = text.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(norm)) continue;
      seen.add(norm);
      assumptions.push({ text, runId: d.runId, turnIndex: d.turnIndex, source: d.source });
    }
  }

  // Roles that failed to start (PLAN.md section 11's partial-start compensation). A BLOCKER, because that
  // is what it is: the task is running with a role missing, and the only thing that fixes it is somebody
  // retrying the assignment. Recording the failure and never surfacing it is how "not stuck in `starting`
  // forever" turns into "silently short a reviewer forever" instead.
  let assignmentFailures = [];
  if (task.harness_assignments_json) {
    try {
      const record = JSON.parse(task.harness_assignments_json);
      assignmentFailures = (record?.report?.failures ?? record?.unfillable ?? [])
        .filter((f) => f && (f.reason || f.role));
    } catch { /* a malformed record must not cost the other five sections */ }
  }

  const diff = diffShape(task, exec ? { exec } : {});

  return {
    task, transitions, runs, openRuns, orphans, asks, activity, diff,
    assumptions, digestedTurns: digests.length, assignmentFailures,
  };
}

/**
 * Render the six sections Rule 4 names: goal, decisions, assumptions, artifacts, blockers, and the
 * current diff shape. In that order, because it is the order a reader needs them: what are we doing,
 * what has been decided, what is unverified, what exists, what is stuck, what does the code look like.
 */
export function renderHandoff(facts, { budgetChars = DEFAULT_BUDGET_CHARS, now = new Date().toISOString() } = {}) {
  const { task, transitions, runs, openRuns, orphans, asks, activity, diff } = facts;
  // Defaulted, so a caller that assembled facts before tier 2 existed still renders rather than throwing.
  const assumptions = facts.assumptions ?? [];
  const digestedTurns = facts.digestedTurns ?? 0;
  const L = [];

  L.push(`# Task handoff — ${task.title}`);
  L.push("");
  L.push(`_tier 3 (PLAN.md section 8, Rule 4). Generated ${now}. Read this instead of any transcript._`);
  L.push("");

  // ── goal ──────────────────────────────────────────────────────────────────────────
  L.push("## Goal");
  L.push("");
  L.push(`**${task.title}** — a ${task.type}, currently \`${task.state}\`.`);
  if (task.branch) L.push(`Branch \`${task.branch}\`${task.base_rev ? ` from \`${task.base_rev}\`` : ""}.`);
  if (task.source) L.push(`Source: ${task.source}.`);
  L.push("");

  // ── decisions ─────────────────────────────────────────────────────────────────────
  L.push("## Decisions");
  L.push("");
  if (!transitions.length) {
    L.push("_No state transitions recorded yet, so nothing has been decided that outlives a single run._");
  } else {
    const shown = transitions.slice(0, SECTION_LIMITS.decisions);
    for (const t of shown) {
      L.push(`- \`${t.from_state ?? "(new)"}\` → \`${t.to_state}\` by **${t.actor}** at ${t.at}`);
    }
    if (transitions.length > SECTION_LIMITS.decisions) {
      L.push(`- _…and ${transitions.length - SECTION_LIMITS.decisions} earlier transition(s), omitted to stay within one page_`);
    }
  }
  L.push("");

  // ── assumptions ───────────────────────────────────────────────────────────────────
  // QUOTED FROM TIER 2, never inferred here. Every line is something a worker's own digest recorded,
  // attributed to the turn it came from so a reader can go and check it. Nothing in this section is
  // generated by tier 3 itself: inventing an assumption would be the worst possible failure for a
  // document whose readers are agents that will act on it.
  L.push("## Assumptions");
  L.push("");
  if (assumptions.length) {
    for (const a of assumptions.slice(0, SECTION_LIMITS.assumptions)) {
      L.push(`- ${a.text} _(run \`${a.runId}\` turn ${a.turnIndex}${a.source === "extractive" ? "" : `, ${a.source}`})_`);
    }
    if (assumptions.length > SECTION_LIMITS.assumptions) {
      L.push(`- _…and ${assumptions.length - SECTION_LIMITS.assumptions} earlier assumption(s), omitted to stay within one page_`);
    }
  } else if (digestedTurns) {
    // The two empty cases are DIFFERENT facts, and a reader acts differently on each: this one means
    // the turns were summarised and none of them stated an assumption.
    L.push(`_None stated. ${digestedTurns} turn(s) have been digested (tier 2) and none recorded an`
      + " assumption. Left empty rather than inferred — a handoff that invents an assumption is worse"
      + " than one that admits it has none._");
  } else {
    L.push("_None recorded. No turn has been digested for this task yet, so there is no tier-2 source to"
      + " quote from. Left empty rather than inferred — a handoff that invents an assumption is worse"
      + " than one that admits it has none._");
  }
  L.push("");

  // ── artifacts ─────────────────────────────────────────────────────────────────────
  L.push("## Artifacts");
  L.push("");
  if (task.worktree_id) L.push(`- Worktree: \`${task.worktree_id}\``);
  if (task.repo_id) L.push(`- Repo: \`${task.repo_id}\``);
  const workers = [...new Map(runs.map((r) => [r.worker_id, r])).values()].slice(0, SECTION_LIMITS.workers);
  if (workers.length) {
    L.push(`- Workers on this task: ${workers.map((w) => `**${w.worker_nickname}** (${w.worker_role})`).join(", ")}`);
  }
  L.push(`- Runs: ${runs.length} total, ${openRuns.length} still open`);
  if (activity.length) {
    const total = activity.reduce((n, a) => n + a.n, 0);
    const errors = activity.filter((a) => a.type === "process.error" || a.type === "stdin.error").reduce((n, a) => n + a.n, 0);
    L.push(`- Recorded activity: ${total} tier-1 event(s)${errors ? `, including ${errors} error event(s)` : ""}`);
  }
  if (!task.worktree_id && !runs.length) L.push("_Nothing has been produced yet._");
  L.push("");

  // ── blockers ──────────────────────────────────────────────────────────────────────
  // First actionable section, and the reason limits are per-section: a task with 200 transitions
  // must not push its blockers off the end of the page.
  L.push("## Blockers");
  L.push("");
  const blockerLines = [];
  for (const a of asks) {
    const kind = a.kind === "tool-approval" ? "awaiting approval" : "awaiting an answer";
    blockerLines.push(`- **${kind}**: ${a.question ?? "(no question text)"} _(ask \`${a.id}\`, since ${a.created_at})_`);
  }
  for (const r of orphans) {
    blockerLines.push(`- **orphaned process**: run \`${r.run_id}\` is running unmanaged (pid ${r.pid}); it needs reaping or adopting`);
  }
  for (const f of (facts.assignmentFailures ?? []).slice(0, SECTION_LIMITS.blockers)) {
    const label = f.kind === "model-diversity" ? "review diversity" : "role not started";
    const fix = f.kind === "model-diversity" ? "reassign a reviewer to another harness" : "retry the assignment";
    blockerLines.push(`- **${label}**: \`${f.role ?? f.configSlot ?? "?"}\` — ${f.reason ?? "no reason recorded"} _(${fix})_`);
  }
  if (!blockerLines.length) L.push("_Nothing is blocked._");
  else L.push(...blockerLines);
  L.push("");

  // ── current diff shape ────────────────────────────────────────────────────────────
  L.push("## Current diff shape");
  L.push("");
  L.push("```");
  L.push(diff.text);
  L.push("```");
  L.push("");

  let doc = L.join("\n");
  let truncated = false;
  if (doc.length > budgetChars) {
    // Cut at a line boundary so the document never ends mid-sentence, and SAY it was cut. A
    // truncated handoff that looks complete is the failure mode worth preventing: its reader would
    // treat a missing blocker as an absent one.
    const keep = doc.slice(0, budgetChars);
    doc = `${keep.slice(0, keep.lastIndexOf("\n"))}\n\n_[handoff truncated at ${budgetChars} characters to stay within Rule 4's one-page budget — sections after this point were dropped]_\n`;
    truncated = true;
  }
  return { doc, truncated, chars: doc.length };
}

/**
 * The whole thing: facts -> document -> the record of what it was built from.
 *
 * `sources` is returned rather than derived by a caller so that what the handoff SAW is recorded
 * beside what it SAID.
 */
export function generateTaskHandoff(db, taskId, { budgetChars = DEFAULT_BUDGET_CHARS, now, exec } = {}) {
  const facts = collectHandoffFacts(db, taskId, { exec });
  const rendered = renderHandoff(facts, { budgetChars, ...(now ? { now } : {}) });
  return {
    ...rendered,
    sources: {
      taskId,
      taskState: facts.task.state,
      transitions: facts.transitions.length,
      runs: facts.runs.length,
      openRuns: facts.openRuns.length,
      orphans: facts.orphans.length,
      openAsks: facts.asks.length,
      askIds: facts.asks.map((a) => a.id),
      tier1Events: facts.activity.reduce((n, a) => n + a.n, 0),
      // Both numbers, not just the one that made it into the document: "0 assumptions from 14 digested
      // turns" and "0 assumptions from 0 digested turns" are the same section and different facts.
      digestedTurns: facts.digestedTurns ?? 0,
      assumptions: (facts.assumptions ?? []).length,
      diffAvailable: facts.diff.ok,
    },
  };
}
