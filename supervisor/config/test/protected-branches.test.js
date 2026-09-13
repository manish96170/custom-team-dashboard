// protected-branches.test.js — `config/protected-branches.js`, pure. No prior dedicated test existed for
// this module before review-sol-2026-09-13.md finding 31: an unknown/misspelled top-level key (e.g.
// "branch" instead of "branches") was silently ignored and fell straight through to the built-in default
// with no indication the file's real content was never read — an administrator could believe a real
// destination was protected when `gitPush` would have authorized it anyway.
//
// Cases:
//   1. no file at all -> the built-in default, unchanged behavior
//   2. a well-formed file is read as-is
//   3. a misspelled top-level key ("branch" instead of "branches") THROWS, naming the bad key
//   4. an extra, unrecognized top-level key alongside a valid "branches" THROWS too
//   5. an empty object (no "branches" key at all) THROWS rather than silently defaulting
//   6. "branches" must be a non-empty array of non-empty strings
//   7. duplicate entries in "branches" THROW
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import { loadProtectedBranches, BUILT_IN_DEFAULTS, CONFIG_FILENAME } from "../protected-branches.js";

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

testCase("no file at all falls back to the built-in default, unchanged", () => {
  const result = loadProtectedBranches({ fileText: undefined, stateDir: "/tmp/definitely-does-not-exist-ctd" });
  assert.deepEqual(result.branches, [...BUILT_IN_DEFAULTS.branches]);
  assert.equal(result.source, "built-in");
});

testCase("a well-formed file is read as-is", () => {
  const result = loadProtectedBranches({ fileText: JSON.stringify({ branches: ["main", "release"] }) });
  assert.deepEqual(result.branches, ["main", "release"]);
  assert.equal(result.source, "file");
});

testCase(`a misspelled top-level key ("branch" instead of "branches") throws, naming the bad key`, () => {
  assert.throws(
    () => loadProtectedBranches({ fileText: JSON.stringify({ branch: ["main"] }) }),
    (err) => {
      assert.match(err.message, /unknown key\(s\) branch/);
      assert.match(err.message, new RegExp(CONFIG_FILENAME.replace(".", "\\.")));
      return true;
    },
  );
});

testCase(`an extra, unrecognized top-level key alongside a valid "branches" throws too`, () => {
  assert.throws(
    () => loadProtectedBranches({ fileText: JSON.stringify({ branches: ["main"], extra: true }) }),
    /unknown key\(s\) extra/,
  );
});

testCase(`an empty object (no "branches" key at all) throws rather than silently defaulting`, () => {
  assert.throws(() => loadProtectedBranches({ fileText: "{}" }), /has no "branches" key/);
});

testCase(`"branches" must be a non-empty array of non-empty strings`, () => {
  assert.throws(() => loadProtectedBranches({ fileText: JSON.stringify({ branches: [] }) }), /non-empty array/);
  assert.throws(() => loadProtectedBranches({ fileText: JSON.stringify({ branches: ["main", ""] }) }), /non-empty array/);
  assert.throws(() => loadProtectedBranches({ fileText: JSON.stringify({ branches: ["main", 123] }) }), /non-empty array/);
  assert.throws(() => loadProtectedBranches({ fileText: JSON.stringify({ branches: "main" }) }), /non-empty array/);
});

testCase(`duplicate entries in "branches" throw`, () => {
  assert.throws(
    () => loadProtectedBranches({ fileText: JSON.stringify({ branches: ["main", "main"] }) }),
    /duplicate entries/,
  );
});

if (failed > 0) {
  console.error(`\n${failed} protected-branches case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: protected-branches config (pure)");
