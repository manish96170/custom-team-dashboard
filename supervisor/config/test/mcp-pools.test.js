// mcp-pools.test.js — `config/mcp-pools.js`, pure. No prior dedicated test existed for this module
// before review-sol-2026-09-13.md finding 32: `args`/`env`/`cwd` were accepted with no shape check at
// all, deferring a real config mistake to a confusing spawn failure later inside `runtime/mcp-pool.js`,
// rather than failing loudly at load time the way this file's own header claims ("malformed -> THROWS").
//
// Cases:
//   1. no file at all -> the built-in leo-mcp default, unchanged behavior
//   2. a well-formed file is read as-is
//   3. an unknown top-level key throws
//   4. an unknown per-pool key throws (pre-existing behavior, still covered)
//   5. a non-empty "command" string is still required
//   6. "args" must be an array of strings
//   7. "cwd" must be a string or null
//   8. "env" must be a plain object of string values
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import { loadMcpPools, poolConfigFor, BUILT_IN_DEFAULTS, CONFIG_FILENAME } from "../mcp-pools.js";

let failed = 0;
let n = 0;
function testCase(name, fn) {
  n += 1;
  try { fn(); console.log(`  ${n}. ${name}`); } catch (err) {
    failed += 1;
    console.error(`  ${n}. FAIL: ${name}`);
    console.error(err);
  }
}

testCase("no file at all falls back to the built-in leo-mcp default, unchanged", () => {
  const result = loadMcpPools({ fileText: undefined, stateDir: "/tmp/definitely-does-not-exist-ctd" });
  assert.deepEqual(result.pools, BUILT_IN_DEFAULTS.pools);
  assert.equal(result.source, "built-in");
});

testCase("a well-formed file is read as-is", () => {
  const result = loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", args: ["server.js"], cwd: "/tmp", env: { TOKEN: "x" } } } }) });
  assert.deepEqual(result.pools.custom, { command: "node", args: ["server.js"], cwd: "/tmp", env: { TOKEN: "x" } });
});

testCase("an unknown top-level key throws", () => {
  assert.throws(
    () => loadMcpPools({ fileText: JSON.stringify({ pool: {} }) }),
    (err) => {
      assert.match(err.message, /must be an object with a "pools" object/);
      assert.match(err.message, new RegExp(CONFIG_FILENAME.replace(".", "\\.")));
      return true;
    },
  );
});

testCase("an unknown per-pool key throws", () => {
  assert.throws(
    () => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", bogus: 1 } } }) }),
    /unknown key "bogus"/,
  );
});

testCase(`a non-empty "command" string is still required`, () => {
  assert.throws(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: {} } }) }), /non-empty "command" string/);
  assert.throws(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "" } } }) }), /non-empty "command" string/);
  assert.throws(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: 123 } } }) }), /non-empty "command" string/);
});

testCase(`"args" must be an array of strings`, () => {
  assert.throws(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", args: "not-an-array" } } }) }), /"args" must be an array of strings/);
  assert.throws(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", args: [1, 2] } } }) }), /"args" must be an array of strings/);
  // Still accepted: no args at all, or a genuinely valid array.
  assert.doesNotThrow(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node" } } }) }));
  assert.doesNotThrow(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", args: ["a", "b"] } } }) }));
});

testCase(`"cwd" must be a string or null`, () => {
  assert.throws(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", cwd: 123 } } }) }), /"cwd" must be a string or null/);
  assert.doesNotThrow(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", cwd: null } } }) }));
  assert.doesNotThrow(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", cwd: "/tmp" } } }) }));
});

testCase(`"env" must be a plain object of string values`, () => {
  assert.throws(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", env: "not-an-object" } } }) }), /"env" must be a plain object of string values/);
  assert.throws(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", env: [1, 2] } } }) }), /"env" must be a plain object of string values/);
  assert.throws(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", env: { PORT: 8080 } } } }) }), /"env" must be a plain object of string values/);
  assert.doesNotThrow(() => loadMcpPools({ fileText: JSON.stringify({ pools: { custom: { command: "node", env: { PORT: "8080" } } } }) }));
});

testCase("poolConfigFor still resolves a named pool through the same validated path", () => {
  const config = poolConfigFor("leo-mcp", { fileText: undefined, stateDir: "/tmp/definitely-does-not-exist-ctd" });
  assert.equal(config.command, "node");
});

if (failed > 0) {
  console.error(`\n${failed} mcp-pools case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: mcp-pools config (pure)");
