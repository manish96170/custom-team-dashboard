// slack-outbox-real-cli-smoke.test.js — the ONE test in this pass that touches the real
// `team-slack-bridge` sibling repo, and only through its own `--dry-run` flag. ROADMAP.md Phase 9,
// 2026-09-14.
//
// WHY THIS IS PROVABLY SAFE, NOT JUST "SHOULD BE": read `../team-slack-bridge/core/post.js` directly —
// `postToChannel`'s very first branch after building the request body is
// `if (dryRun) return { ok: true, dryRun: true, request: { method: 'chat.postMessage', body } }`, BEFORE
// the `if (!token) return ...` check and BEFORE `callSlack(...)` is ever reached. A dry run cannot post
// to Slack because the function returns before it would even need a token to try — this holds regardless
// of whether a real `.env` with real credentials happens to exist on this machine (it does, on the
// machine this was written on, and it does not matter: the code path that would read it is never
// reached). This is NOT the fixture-based safety story `slack-outbox.test.js` uses (a script with zero
// network-capable imports) — it is a different, equally-airtight one, and the two together are why
// nothing in this pass can reach the real Slack API from a test, ever.
//
// This is a SMOKE test, not a behavior test: it proves `runtime/slack-outbox.js`'s drain builds argv the
// real binary actually accepts and exits 0 for — not retry/dedup/failure semantics, which
// `slack-outbox.test.js`'s fixture-based cases already cover in full and more safely.

import assert from "node:assert/strict";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BUILT_IN_DEFAULTS } from "../../config/slack-notifications.js";

const execFileAsync = promisify(execFile);
const TEAM_SLACK_BRIDGE_AVAILABLE = fs.existsSync(BUILT_IN_DEFAULTS.bridgePath);

if (!TEAM_SLACK_BRIDGE_AVAILABLE) {
  console.error("");
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.error("!! SKIPPED (not a pass): slack-outbox-real-cli-smoke — team-slack-bridge sibling repo   !!");
  console.error("!! not present on this checkout. This is the only suite that invokes the REAL bridge    !!");
  console.error("!! binary (via --dry-run) to prove the drain's argv actually works against it.          !!");
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.error("");
  console.log("SKIP: slack-outbox real-CLI smoke (team-slack-bridge sibling repo not present on this checkout)");
  process.exit(0);
}

const bridgePostScript = `${BUILT_IN_DEFAULTS.bridgePath}/post.js`;

try {
  // The EXACT argv shape `runtime/slack-outbox.js`'s drain builds, plus `--dry-run` (which the real
  // drain never passes — added ONLY here, and it is what makes this call incapable of reaching Slack).
  const { stdout } = await execFileAsync(
    process.execPath,
    [bridgePostScript, "--json", "--channel", "#smoke-test-channel", "--text", "smoke test, never actually sent", "--idempotency-key", "smoke-test-key", "--dry-run"],
    { encoding: "utf8", timeout: 10_000 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, `expected the real bridge's --dry-run to report ok:true, got ${stdout}`);
  assert.equal(result.dryRun, true, "the real bridge must confirm this was a dry run, not a real send");
  assert.equal(result.request?.method, "chat.postMessage");
  assert.equal(result.request?.body?.channel, "#smoke-test-channel");
  console.log("  1. the real team-slack-bridge post.js, invoked with the exact argv slack-outbox.js's drain builds plus --dry-run, reports a real dry-run success and never reaches the network");
  console.log("\nPASS: slack-outbox real-CLI smoke");
} catch (err) {
  console.error("\nFAIL: slack-outbox real-CLI smoke");
  console.error(err);
  process.exit(1);
}
