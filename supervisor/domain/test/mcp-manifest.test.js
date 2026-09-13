// mcp-manifest.test.js — PLAN.md §21.2's v1 scope (domain/mcp-manifest.js), pure, added 2026-09-11.
//
// Cases:
//   1. a role with a declared need resolves to exactly its pool(s), nothing more
//   2. a role with no declared need gets an empty manifest, not an error
//   3. a declared pool name absent from registeredConfigs is reported as missing, not silently dropped
//   4. ROLES_WITH_MCP_NEEDS matches ROLE_MCP_NEEDS's own keys, so a UI listing roles can't drift from it

import assert from "node:assert/strict";
import { manifestForRole, ROLE_MCP_NEEDS, ROLES_WITH_MCP_NEEDS } from "../mcp-manifest.js";

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

testCase("a role with a declared need resolves to exactly its pool(s)", () => {
  const m = manifestForRole("git-push-runner", { registeredConfigs: { "leo-mcp": "/etc/leo-mcp.json" } });
  assert.deepEqual(m.pools, ["leo-mcp"]);
  assert.deepEqual(m.configPaths, ["/etc/leo-mcp.json"]);
  assert.deepEqual(m.missing, []);
});

testCase("a role with no declared need gets an empty manifest, not an error", () => {
  const m = manifestForRole("awsquery-runner", { registeredConfigs: { "leo-mcp": "/etc/leo-mcp.json" } });
  assert.deepEqual(m.pools, []);
  assert.deepEqual(m.configPaths, []);
  const unknown = manifestForRole("some-role-nobody-declared", {});
  assert.deepEqual(unknown.pools, []);
});

testCase("a declared pool absent from registeredConfigs is reported missing, not silently dropped", () => {
  const m = manifestForRole("jira-runner", { registeredConfigs: {} });
  assert.deepEqual(m.pools, ["leo-mcp"]);
  assert.deepEqual(m.configPaths, [], "no path resolved for an unregistered pool");
  assert.deepEqual(m.missing, ["leo-mcp"], "the gap must be visible, not swallowed");
});

testCase("ROLES_WITH_MCP_NEEDS cannot drift from ROLE_MCP_NEEDS's own keys", () => {
  assert.deepEqual([...ROLES_WITH_MCP_NEEDS].sort(), Object.keys(ROLE_MCP_NEEDS).sort());
});

if (failed) {
  console.error("\nFAIL: mcp manifest (§21.2)");
  process.exit(1);
}
console.log("\nPASS: mcp manifest (§21.2)");
