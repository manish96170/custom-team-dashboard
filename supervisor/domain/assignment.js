// assignment.js — plan a task's harness/model assignment (PLAN.md section 11). Pure.
//
// PLAN.md §11's assignment step, split the way everything else here is split: this file DECIDES, and
// `supervisor.assignTask()` ACTS. Deciding is "which roles does this task need, which worker fills each
// one, and which harness/model does each get"; acting is starting processes, writing rows and transitioning
// state. Keeping the decision pure is what makes the whole table of cases — a task with no reviewers, an
// override for one field, a role with no worker — assertable without spawning anything.
//
// THREE VOCABULARIES MEET HERE, and the mapping between them is this file's real job:
//
//   * the WORKFLOW PROFILE speaks in roles a task needs: `coder`, `reviewer`, `reviewer`
//     (domain/workflow-profiles.js)
//   * `harness-defaults.json` speaks in configured slots: `coder`, `reviewer1`, `reviewer2`,
//     `parentReviewer` (PLAN.md §11's own table)
//   * the REGISTRY speaks in workers, which have a role and a persistent nickname (PLAN.md §1)
//
// So "the second reviewer on this task uses OpenCode" needs all three to line up, and the ordering rule
// that makes them line up — reviewers are numbered in a STABLE order — belongs in one place rather than in
// each caller.
//
// WHAT THIS DELIBERATELY DOES NOT DO: create workers. A worker is a persistent named identity with a
// nickname a human recognises ("Purus"), not a slot to be filled by whatever the assignment step invents.
// Generating names here would be inventing registry policy, which is the CTO's (PLAN.md §8, Rule 6, and
// §16's typed commands). A role with no worker is reported as UNFILLABLE, with a reason a human can act
// on, rather than papered over.

import { profileFor, rolesFor, workRolesFor } from "./workflow-profiles.js";
import { assignmentFor } from "../config/harness-defaults.js";

/**
 * Profile role -> the config slots it draws from, in order.
 *
 * `reviewer` maps to `reviewer1` then `reviewer2` because PLAN.md §11 configures those two separately and
 * on purpose: its own example gives reviewer2 a different harness entirely (OpenCode rather than Claude
 * Code), which is the point — two reviewers on different harnesses catch different things. A single
 * `reviewer` config key would have quietly made them identical.
 */
const CONFIG_SLOTS = Object.freeze({
  coder: Object.freeze(["coder"]),
  reviewer: Object.freeze(["reviewer1", "reviewer2"]),
  parentReviewer: Object.freeze(["parentReviewer"]),
});

/**
 * Workers of one role, in a STABLE order.
 *
 * By nickname, because that is the only field guaranteed present, human-meaningful and stable — ordering by
 * insertion would make "which reviewer is reviewer2" change when a row was rewritten, and the answer to
 * that question decides which harness they run on.
 */
function workersOfRole(workers, role) {
  return workers
    .filter((w) => w.role === role)
    .sort((a, b) => String(a.nickname ?? a.workerId).localeCompare(String(b.nickname ?? b.workerId)));
}

/**
 * Plan the assignment.
 *
 * @param {{
 *   task: { id: string, type?: string, teamId?: string|null },
 *   workers: Array<{ workerId: string, role: string, nickname?: string }>,
 *   config: object,                                   // loadHarnessDefaults() result
 *   overrides?: Record<string, object>,               // configSlot -> { harnessId?, model?, effort? }
 *   openRunWorkerIds?: string[],                      // workers that already have a live run
 * }} input
 *
 * @returns {{ taskId, type, profile, slots, unfillable, startable }}
 */
export function planAssignment({ task, workers = [], config, overrides = {}, openRunWorkerIds = [] } = {}) {
  if (!task?.id) throw new Error("planAssignment: a task with an id is required");
  if (!config) throw new Error("planAssignment: a harness-defaults config is required (loadHarnessDefaults)");

  const profile = profileFor(task.type);
  const roles = rolesFor(task.type);
  const open = new Set(openRunWorkerIds);

  // How many of each role the profile asks for, so `reviewer` appearing twice consumes reviewer1 AND
  // reviewer2 rather than resolving to the same slot twice.
  const takenByRole = new Map();
  const usedWorkers = new Set();
  const slots = [];
  const unfillable = [];

  for (const role of roles) {
    const n = takenByRole.get(role) ?? 0;
    takenByRole.set(role, n + 1);
    const configSlot = (CONFIG_SLOTS[role] ?? [role])[n] ?? `${role}${n + 1}`;

    const candidates = workersOfRole(workers, role).filter((w) => !usedWorkers.has(w.workerId));
    const worker = candidates[0] ?? null;
    const configured = assignmentFor(config, configSlot, { teamId: task.teamId ?? null });
    const override = overrides[configSlot] ?? null;

    if (!worker) {
      // Named precisely, because the fix differs: no worker at all is a registry action, whereas a
      // missing config entry is a file to edit.
      unfillable.push({
        role,
        configSlot,
        reason: `no worker with role "${role}" exists on task ${task.id} for slot ${configSlot} `
          + "— a worker is a persistent named identity and is created by the registry, not invented here",
      });
      continue;
    }
    if (!configured && !override) {
      unfillable.push({
        role,
        configSlot,
        workerId: worker.workerId,
        reason: `no harness configured for slot "${configSlot}" (harness-defaults.json, PLAN.md section 11)`,
      });
      continue;
    }

    usedWorkers.add(worker.workerId);
    const merged = { ...(configured ?? {}), ...(override ?? {}) };
    if (!merged.harnessId) {
      unfillable.push({
        role, configSlot, workerId: worker.workerId,
        reason: `slot "${configSlot}" has no harnessId, so there is nothing to start it on`,
      });
      continue;
    }
    slots.push({
      role,
      configSlot,
      workerId: worker.workerId,
      nickname: worker.nickname ?? worker.workerId,
      harnessId: merged.harnessId,
      model: merged.model ?? null,
      effort: merged.effort ?? null,
      // Where this came from, so a human can answer "who chose this model" without reading code.
      // `override` beats a per-team entry beats the global default beats the built-in table.
      source: override ? "override" : (configured?.overridden ? "perTeam" : config.source ?? "file"),
      // Already running: the retry path must not start a second run for a worker that is working.
      alreadyRunning: open.has(worker.workerId),
    });
  }

  return {
    taskId: task.id,
    type: task.type ?? null,
    profile: { type: profile.type, requiredVerdicts: profile.requiredVerdicts, reviewRequired: profile.reviewRequired },
    slots,
    unfillable,
    // What a caller would actually start now. Separated from `slots` so "nothing to do" is a fact the
    // caller reads rather than an empty loop it discovers.
    startable: slots.filter((s) => !s.alreadyRunning),
  };
}

/**
 * Is this plan worth acting on at all?
 *
 * A WORK-BEARING slot is the gate — which roles count as "work" is looked up from the CURRENT profile
 * (`workflow-profiles.js`'s `workRoles`), not a hardcoded two-name check. That hardcode was real: it only
 * ever recognized `coder`/`parentReviewer`, so the four utility-task roles added in PLAN.md §16.2
 * (`git-push-runner`/`jira-runner`/`awsquery-runner`/`slack-runner`) were refused before launch even with
 * a correctly-configured worker present — nobody could do the work, according to a condition that had
 * never heard of them. Codex review (`codexdoc/REVIEW-NOTES.md` finding 7), fixed 2026-09-11. A task
 * whose reviewers cannot be filled is still worth starting — the work can begin and the reviewers can be
 * retried — but a task with nobody to do the WORK is not a degraded start, it is no start, and beginning
 * it would move the task out of `created` for no reason.
 *
 * `reviewRequired: false` profiles (adhoc, chore, the utility-task lane) have no reviewers to miss, so
 * the same rule reads correctly for them without a special case.
 */
export function isActionable(plan) {
  const workRoles = workRolesFor(plan.type);
  const hasWork = plan.slots.some((s) => workRoles.includes(s.role));
  if (hasWork) return { ok: true };
  const why = plan.unfillable.map((u) => u.reason).join("; ") || "the workflow profile asked for no roles";
  return {
    ok: false,
    reason: `task ${plan.taskId} has nobody to do the work: ${why}`,
  };
}
