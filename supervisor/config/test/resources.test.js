// resources.test.js — `config/resources.js`, pure. No prior dedicated test existed for this module
// before review-sol-2026-09-13.md finding 32: a misspelled top-level key (e.g. "resource" instead of
// "resources") was silently treated as "nothing declared" and fell straight through to the built-in
// defaults, with no indication the file's real content was never read.
//
// Cases:
//   1. no file at all -> the built-in defaults, unchanged behavior
//   2. a well-formed file is read as-is, merged per-name with the built-ins
//   3. a misspelled top-level key ("resource" instead of "resources") THROWS
//   4. an unrecognized top-level key alongside a valid one THROWS too
//   5. per-resource validation (kind/capacity) still works, unchanged
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import { loadResources, BUILT_IN_DEFAULTS, CONFIG_FILENAME } from "../resources.js";

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

testCase("no file at all falls back to the built-in defaults, unchanged", () => {
  const result = loadResources({ fileText: undefined, stateDir: "/tmp/definitely-does-not-exist-ctd" });
  assert.deepEqual(result.resources, BUILT_IN_DEFAULTS.resources);
  assert.equal(result.memoryHeadroomPercent, BUILT_IN_DEFAULTS.memoryHeadroomPercent);
  assert.equal(result.source, "built-in");
});

testCase("a well-formed file is read as-is, merged per-name with the built-ins", () => {
  const result = loadResources({ fileText: JSON.stringify({ resources: { "custom:lock": { kind: "exclusive" } }, memoryHeadroomPercent: 25 }) });
  assert.deepEqual(result.resources["custom:lock"], { kind: "exclusive" });
  assert.deepEqual(result.resources["git:identity"], BUILT_IN_DEFAULTS.resources["git:identity"], "built-ins must survive alongside a file addition");
  assert.equal(result.memoryHeadroomPercent, 25);
  assert.equal(result.source, "file");
});

testCase(`a misspelled top-level key ("resource" instead of "resources") throws`, () => {
  assert.throws(
    () => loadResources({ fileText: JSON.stringify({ resource: { "git:identity": { kind: "exclusive" } } }) }),
    (err) => {
      assert.match(err.message, /unknown top-level key\(s\) resource/);
      assert.match(err.message, new RegExp(CONFIG_FILENAME.replace(".", "\\.")));
      return true;
    },
  );
});

testCase("an unrecognized top-level key alongside a valid one throws too", () => {
  assert.throws(
    () => loadResources({ fileText: JSON.stringify({ resources: {}, extra: true }) }),
    /unknown top-level key\(s\) extra/,
  );
});

testCase("per-resource validation (kind/capacity) still works, unchanged", () => {
  assert.throws(() => loadResources({ fileText: JSON.stringify({ resources: { x: { kind: "bogus" } } }) }), /must be "exclusive" or "counted"/);
  assert.throws(() => loadResources({ fileText: JSON.stringify({ resources: { x: { kind: "counted" } } }) }), /must be a positive integer/);
  assert.throws(() => loadResources({ fileText: JSON.stringify({ resources: { x: { kind: "exclusive", bogusKey: 1 } } }) }), /unknown key\(s\) bogusKey/);
});

if (failed > 0) {
  console.error(`\n${failed} resources case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: resources config (pure)");
