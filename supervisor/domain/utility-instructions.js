// utility-instructions.js — real prompt text for the utility-task lane's 4 roles (PLAN.md §16.2), added
// 2026-09-11. Pure, no database, no supervisor.
//
// WHAT GAP THIS CLOSES
//
// §16.2 (`domain/workflow-profiles.js`, `runtime/supervisor.js`'s `UTILITY_TASK_PRESETS`) wired the
// role/capability/model MACHINERY for `git-push-runner`/`jira-runner`/`awsquery-runner`/`slack-runner`,
// but `assignTask`'s own prompt for every role — utility or not — was one generic sentence:
// `Task ${taskId} (${task.type}), role ${slot.role}.` A spawned utility runner got no more instruction
// than its own role NAME — nothing telling it which tool to reach for, nothing repeating this project's
// own "never guess an underspecified request, raise an ask instead" rule (§7/§16) for a role that has no
// judgment to spend guessing with by design.
//
// WHAT THIS DOES NOT DO
//
// It does not invent a second place to store task-specific detail. `task.title` is already the
// human-readable summary every task type carries (`createTask`'s own `title` field) — these templates
// read it, they do not require a new column or a second free-text field competing with it.
export const UTILITY_ROLES = Object.freeze(["git-push-runner", "jira-runner", "awsquery-runner", "slack-runner"]);

const TEMPLATES = Object.freeze({
  "git-push-runner": (task) =>
    `You are git-push-runner for task ${task.id}: "${task.title}". `
    + `Use the gitPush supervisor command (or gitPushProtected if the destination is a protected branch — `
    + `do not try to work around that by choosing gitPush instead) to stage, commit, and push exactly what `
    + `this task describes, inside the task's shared worktree. If the destination, message, or scope is `
    + `not clear from the task title, raise an ask rather than guessing — this role has no judgment to `
    + `spend guessing with.`,
  "jira-runner": (task) =>
    `You are jira-runner for task ${task.id}: "${task.title}". `
    + `Use leo-mcp's Jira tools to do exactly what this task describes. Some of those tools (including `
    + `jira_create_ticket) are deliberate stubs until a human verifies the field map against a live Jira `
    + `schema — if a tool refuses for that reason, report the refusal honestly rather than working around `
    + `it. If the ticket, project, or field values are not clear from the task title, raise an ask rather `
    + `than guessing.`,
  "awsquery-runner": (task) =>
    `You are awsquery-runner for task ${task.id}: "${task.title}". `
    + `Run exactly the read-only AWS query this task describes. You hold no side-effecting capability by `
    + `design (read:registry only) — if the task's own title asks for a mutation, refuse it and raise an `
    + `ask instead of attempting the mutation through some other channel.`,
  "slack-runner": (task) =>
    `You are slack-runner for task ${task.id}: "${task.title}". `
    + `Use leo-mcp's Slack tools (or the slack:post-bot supervisor capability) to post exactly what this `
    + `task describes. If the destination channel or the message content is not clear from the task title, `
    + `raise an ask rather than guessing.`,
});

/**
 * The real instruction text for a utility role's run, or `null` for any role this module does not cover
 * (every non-utility role — `coder`, `reviewer`, `cto`, etc. — keeps `assignTask`'s existing generic
 * sentence unchanged; this module is additive, not a replacement for the general case).
 */
export function instructionForRole(role, task) {
  const template = TEMPLATES[role];
  if (!template) return null;
  if (!task?.id) throw new Error("instructionForRole: task.id is required");
  if (!task?.title) throw new Error("instructionForRole: task.title is required");
  return template(task);
}
