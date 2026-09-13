// utility-instructions.test.js — real prompt text for the 4 utility-task roles (domain/utility-instructions.js),
// pure, added 2026-09-11.
//
// Cases:
//   1. each of the 4 utility roles gets real, role-specific instruction text naming its own tool(s)
//   2. every template embeds the task's id and title, so a runner can't lose track of which task it is
//   3. every template repeats the "raise an ask, do not guess" rule
//   4. a non-utility role gets null, not a guess — assignTask's own generic sentence covers it instead
//   5. a missing task id or title throws rather than silently building an incomplete instruction

import assert from "node:assert/strict";
import { instructionForRole, UTILITY_ROLES } from "../utility-instructions.js";

let failed = false;
function testCase(name, fn) {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed = true;
    console.error(`  FAIL — ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

const task = { id: "t-1", title: "push the hotfix to main" };

testCase("each of the 4 utility roles gets real, role-specific instruction text naming its own tool", () => {
  assert.equal(UTILITY_ROLES.length, 4);
  assert.match(instructionForRole("git-push-runner", task), /gitPush/);
  assert.match(instructionForRole("jira-runner", task), /Jira/);
  assert.match(instructionForRole("awsquery-runner", task), /AWS query/);
  assert.match(instructionForRole("slack-runner", task), /Slack/);
});

testCase("every template embeds the task's id and title", () => {
  for (const role of UTILITY_ROLES) {
    const text = instructionForRole(role, task);
    assert.match(text, /t-1/, `${role} must name the task id`);
    assert.match(text, /push the hotfix to main/, `${role} must include the task title`);
  }
});

testCase('every template repeats the "raise an ask, do not guess" rule', () => {
  for (const role of UTILITY_ROLES) {
    assert.match(instructionForRole(role, task), /ask/i, `${role} must tell the runner to raise an ask rather than guess`);
  }
});

testCase("a non-utility role gets null, not a guess", () => {
  assert.equal(instructionForRole("coder", task), null);
  assert.equal(instructionForRole("reviewer", task), null);
  assert.equal(instructionForRole("some-role-nobody-declared", task), null);
});

testCase("a missing task id or title throws rather than silently building an incomplete instruction", () => {
  assert.throws(() => instructionForRole("git-push-runner", { title: "x" }), /id is required/);
  assert.throws(() => instructionForRole("git-push-runner", { id: "t-1" }), /title is required/);
});

if (failed) {
  console.error("\nFAIL: utility instructions");
  process.exit(1);
}
