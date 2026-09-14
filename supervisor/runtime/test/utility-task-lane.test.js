// utility-task-lane.test.js — PLAN.md §16.2, the utility-task lane, added 2026-09-11.
//
// Four narrow adhoc roles (git-push-runner, jira-runner, awsquery-runner, slack-runner), each resolving
// to its own cheap-model harness-defaults entry and its own fixed UTILITY capability preset — not the
// generic worker preset a coder/reviewer gets. This is config/wiring on top of everything already
// built (workflow-profiles, harness-defaults, capabilities, ensureWorkerPrincipal); nothing here spawns
// a real harness or touches git — that's already covered by git-create-push's own tests.
//
// Cases:
//   1. each new task type resolves to exactly its own single role (workflow-profiles.js)
//   2. each new role has its own cheap-model harness-defaults entry (config/harness-defaults.js)
//   3. a worker minted for each role gets kind:"utility" and its role-specific fixed toolset — not the
//      generic worker preset, and not another role's toolset
//   4. the capability/coverage wiring for the new utility:awsquery preset is intact
//   5. createUtilityTask dispatches task+worker+assign in one call, with a real per-role prompt
//   6. createUtilityTask refuses a non-utility task type

import assert from "node:assert/strict";
import { openDb, closeDb, upsertHarness, createTask, createWorker } from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import { rolesFor, requiredVerdictsFor } from "../../domain/workflow-profiles.js";
import { instructionForRole } from "../../domain/utility-instructions.js";
import { BUILT_IN_DEFAULTS } from "../../config/harness-defaults.js";
import { PRESETS, assertCoversCommands } from "../../domain/capabilities.js";
import { createFakeHarness } from "./_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };

const ROLE_BY_TASK_TYPE = {
  "git-push-task": "git-push-runner",
  "jira-task": "jira-runner",
  "awsquery-task": "awsquery-runner",
  "slack-task": "slack-runner",
};
const PRESET_BY_ROLE = {
  "git-push-runner": "utility:git",
  "jira-runner": "utility:jira",
  "awsquery-runner": "utility:awsquery",
  "slack-runner": "utility:slack",
};

await runTest("utility-task lane", async () => {
  // ── 1 ──────────────────────────────────────────────────────────────────────────────
  {
    for (const [type, role] of Object.entries(ROLE_BY_TASK_TYPE)) {
      assert.deepEqual(rolesFor(type), [role], `${type} must want exactly one worker, role "${role}"`);
      assert.equal(requiredVerdictsFor(type), 0, `${type} is adhoc-shaped: zero required verdicts`);
    }
    console.log("  1. each utility-task type resolves to exactly its own single role, zero required verdicts");
  }

  // ── 2 ──────────────────────────────────────────────────────────────────────────────
  {
    for (const role of Object.values(ROLE_BY_TASK_TYPE)) {
      const spec = BUILT_IN_DEFAULTS[role];
      assert.ok(spec, `BUILT_IN_DEFAULTS must have an entry for "${role}"`);
      assert.equal(spec.model, "haiku", `${role} must default to a cheap model`);
      assert.equal(spec.effort, "low", `${role} must default to low effort`);
    }
    console.log("  2. each role has its own cheap-model, low-effort harness-defaults entry");
  }

  // ── 3 ──────────────────────────────────────────────────────────────────────────────
  const stateDir = makeScratchDir("supervisor-utility-task-lane-test");
  let db;
  let supervisor;
  const harness = createFakeHarness({ label: "utility-task" });
  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    supervisor = createSupervisor({
      db, adapters: { fake: harness }, logger: quiet, askSweepIntervalMs: 0,
    });
    await supervisor.boot();

    let i = 0;
    for (const [role, presetName] of Object.entries(PRESET_BY_ROLE)) {
      i += 1;
      const taskId = `t-util-${i}`;
      const workerId = `w-util-${i}`;
      createTask(db, { id: taskId, title: `utility task ${role}`, type: "adhoc" });
      createWorker(db, { workerId, nickname: role, role, taskId });

      const { principal } = supervisor.ensureWorkerPrincipal(workerId);
      assert.equal(principal.kind, "utility", `a ${role} principal must be minted as kind "utility", not "worker"`);
      assert.deepEqual(
        [...principal.capabilities].sort(), [...PRESETS[presetName]].sort(),
        `a ${role} principal must hold exactly ${presetName}'s fixed toolset`,
      );

      // Negative check, not just a positive one: a git-push-runner must NOT also be able to do a
      // DIFFERENT role's job — that is the whole point of a fixed-toolset preset over a generic one.
      for (const [otherRole, otherPreset] of Object.entries(PRESET_BY_ROLE)) {
        if (otherRole === role) continue;
        for (const cap of PRESETS[otherPreset]) {
          if (cap === "read:registry") continue; // every utility role shares this one, by design
          assert.equal(
            principal.capabilities.includes(cap), false,
            `a ${role} principal must NOT hold "${cap}", which belongs to ${otherRole}'s toolset (${otherPreset})`,
          );
        }
      }
    }
    console.log("  3. each role's principal is minted kind:\"utility\" with exactly its own fixed toolset, no borrowing");

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    {
      assert.ok(PRESETS["utility:awsquery"], "utility:awsquery must exist as a named preset");
      assert.deepEqual([...PRESETS["utility:awsquery"]], ["read:registry"]);
      const cover = assertCoversCommands(Object.keys(supervisor.commandHandlers()));
      assert.deepEqual(cover.missing, [], "no real command should be left without a declared capability");
      assert.deepEqual(cover.stale, [], "and the policy must not name commands that no longer exist");
      console.log("  4. utility:awsquery is read-only by construction, and the real coverage check still passes");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    // The dispatch convenience (item 13's own "not built" note): one call does createTask + createWorker
    // + assignTask, in the right order, with the right role — and the started run's prompt is REAL
    // instruction text (finding 16.2's other gap), not the generic "Task t1 (type), role x." sentence.
    {
      // review-consolidated-2026-09-14.md finding 4: the fake harness can't deliver an mcpConfig, so
      // this case (about dispatch + real prompt text, not MCP delivery) opts into the degraded run.
      const dispatched = await supervisor.createUtilityTask({
        type: "git-push-task", title: "push the hotfix", overrides: { "git-push-runner": { harnessId: "fake" } }, cwd: stateDir,
        allowDegradedMcp: true,
      });
      assert.equal(dispatched.role, "git-push-runner");
      assert.equal(dispatched.assigned, true, JSON.stringify(dispatched));
      assert.equal(dispatched.started.length, 1);
      const runId = dispatched.started[0].runId;
      const run = harness._runs.get(runId);
      assert.ok(run, "the dispatched task must have actually started a real run through the fake harness");
      assert.equal(
        run.spec.prompt,
        instructionForRole("git-push-runner", { id: dispatched.taskId, title: "push the hotfix" }),
        "the started run must carry the real per-role instruction text, not the generic sentence",
      );
      console.log("  5. createUtilityTask dispatches task+worker+assign in one call, and the run's prompt is real per-role instruction text");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    {
      await assert.rejects(
        () => supervisor.createUtilityTask({ type: "not-a-real-type", title: "x" }),
        /not a utility task type/,
      );
      console.log("  6. createUtilityTask refuses a type that isn't one of the four utility task types");
    }
  } finally {
    try { await supervisor?.shutdown?.({ timeoutMs: 2000 }); } catch { /* best-effort teardown */ }
    try { closeDb(db); } catch { /* already closed */ }
    rmScratchDir(stateDir);
  }
});
