// slack-notifications.test.js — `config/slack-notifications.js`, pure. ROADMAP.md Phase 9 (Slack
// outbound), 2026-09-14.
//
// Cases:
//   1. no file at all -> the built-in default (DISABLED, no channel) — "no integration is ever a hard
//      dependency" holds by construction
//   2. a well-formed enabled file is read as-is
//   3. an unknown top-level key throws
//   4. "enabled" must be a boolean
//   5. "channel" must be a non-empty string or null
//   6. "bridgePath" must be a non-empty string
//   7. enabled: true with no channel throws — a half-finished config is refused, not silently a no-op
//   8. enabled: false with no channel is fine (the built-in default's own shape)
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import { loadSlackNotifications, BUILT_IN_DEFAULTS, CONFIG_FILENAME } from "../slack-notifications.js";

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

testCase("no file at all falls back to the built-in default (disabled, no channel), unchanged", () => {
  const result = loadSlackNotifications({ fileText: undefined, stateDir: "/tmp/definitely-does-not-exist-ctd" });
  assert.equal(result.enabled, BUILT_IN_DEFAULTS.enabled);
  assert.equal(result.channel, BUILT_IN_DEFAULTS.channel);
  assert.equal(result.enabled, false, "the built-in default must be disabled — no channel to post to on a fresh install");
  assert.equal(result.source, "built-in");
});

testCase("a well-formed enabled file is read as-is", () => {
  const result = loadSlackNotifications({ fileText: JSON.stringify({ enabled: true, channel: "#team-updates", bridgePath: "/tmp/bridge" }) });
  assert.equal(result.enabled, true);
  assert.equal(result.channel, "#team-updates");
  assert.equal(result.bridgePath, "/tmp/bridge");
});

testCase(`an unknown top-level key throws`, () => {
  assert.throws(() => loadSlackNotifications({ fileText: JSON.stringify({ enabled: true, channel: "#x", asUser: true }) }), /unknown top-level key "asUser"/);
});

testCase(`"enabled" must be a boolean`, () => {
  assert.throws(() => loadSlackNotifications({ fileText: JSON.stringify({ enabled: "yes", channel: "#x" }) }), /"enabled" must be a boolean/);
});

testCase(`"channel" must be a non-empty string or null`, () => {
  assert.throws(() => loadSlackNotifications({ fileText: JSON.stringify({ channel: "" }) }), /"channel" must be a non-empty string or null/);
  assert.throws(() => loadSlackNotifications({ fileText: JSON.stringify({ channel: 123 }) }), /"channel" must be a non-empty string or null/);
  assert.doesNotThrow(() => loadSlackNotifications({ fileText: JSON.stringify({ channel: null }) }));
});

testCase(`"bridgePath" must be a non-empty string`, () => {
  assert.throws(() => loadSlackNotifications({ fileText: JSON.stringify({ bridgePath: "" }) }), /"bridgePath" must be a non-empty string/);
  assert.throws(() => loadSlackNotifications({ fileText: JSON.stringify({ bridgePath: 123 }) }), /"bridgePath" must be a non-empty string/);
});

testCase(`"enabled": true with no "channel" throws — a half-finished config is refused, not a silent no-op`, () => {
  assert.throws(() => loadSlackNotifications({ fileText: JSON.stringify({ enabled: true }) }), /"enabled": true requires a non-empty "channel"/);
});

testCase(`"enabled": false with no channel is fine, matching the built-in default's own shape`, () => {
  const result = loadSlackNotifications({ fileText: JSON.stringify({ enabled: false }) });
  assert.equal(result.enabled, false);
  assert.equal(result.channel, null);
});

if (failed > 0) {
  console.error(`\n${failed} slack-notifications case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: slack-notifications config (pure)");
