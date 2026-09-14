// slack-notifications.js — read `slack-notifications.json` (PLAN.md §14, ROADMAP.md's Phase 9).
//
// Same shape as `config/mcp-pools.js`, deliberately: user-authored config declaring how outbound Slack
// notifications are delivered (the channel, and where the `team-slack-bridge` sibling repo's CLI lives),
// read on demand rather than imported into a table. Missing file -> built-in default (DISABLED); malformed
// -> THROWS.
//
// DISABLED BY DEFAULT, ON PURPOSE — PLAN.md §2.10 (via `team-slack-bridge`'s own PLAN.md §2): "No
// integration is ever a hard dependency of the dashboard. It must run correctly with zero integrations
// configured." Unlike `mcp-pools.js`'s `leo-mcp` entry (which has a real built-in pool config because
// every utility-lane role already declares a need for it), there is no default CHANNEL a fresh install
// could possibly know to post to — so the built-in default is `enabled: false`, and `runtime/
// slack-outbox.js`'s drain is a no-op until an operator configures a real channel.
//
// BOT-ONLY, NEVER AS-USER — PLAN.md §14.5: "v1 posts as the bot only; as-user posting moves to backlog
// until the `callerIdentity` mechanism above actually exists." This module has no `asUser` field at all —
// not because the underlying CLI (`team-slack-bridge`'s `post.js --as-user`) lacks the flag, but because
// this integration point (the supervisor daemon itself posting an automatic summary, no human/worker in
// the loop) is exactly the shape §14.5 says must not use it. Adding the field would just be adding the
// footgun back.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONFIG_FILENAME = "slack-notifications.json";

function defaultTeamSlackBridgePath() {
  if (process.env.TEAM_SLACK_BRIDGE_PATH) return process.env.TEAM_SLACK_BRIDGE_PATH;
  // supervisor/config/ -> supervisor/ -> custom-team-dashboard/ -> siblings/ -> team-slack-bridge/
  return path.resolve(__dirname, "..", "..", "..", "team-slack-bridge");
}

export const BUILT_IN_DEFAULTS = Object.freeze({
  enabled: false,
  channel: null,
  bridgePath: defaultTeamSlackBridgePath(),
});

const TOP_LEVEL_KEYS = Object.freeze(["enabled", "channel", "bridgePath"]);

/** Load and validate the file. Returns `{ enabled, channel, bridgePath, source, path }`. */
export function loadSlackNotifications({ stateDir, fileText } = {}) {
  let text = fileText;
  let filePath = null;
  if (text === undefined) {
    if (!stateDir) throw new Error("loadSlackNotifications: stateDir is required (or pass fileText)");
    filePath = path.join(stateDir, CONFIG_FILENAME);
    if (!fs.existsSync(filePath)) {
      return { ...BUILT_IN_DEFAULTS, source: "built-in", path: filePath };
    }
    text = fs.readFileSync(filePath, "utf8");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILENAME} must be a JSON object`);
  }
  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      throw new Error(`${CONFIG_FILENAME}: unknown top-level key "${key}" (allowed: ${TOP_LEVEL_KEYS.join(", ")})`);
    }
  }
  if (parsed.enabled !== undefined && typeof parsed.enabled !== "boolean") {
    throw new Error(`${CONFIG_FILENAME}: "enabled" must be a boolean`);
  }
  if (parsed.channel !== undefined && parsed.channel !== null && (typeof parsed.channel !== "string" || !parsed.channel)) {
    throw new Error(`${CONFIG_FILENAME}: "channel" must be a non-empty string or null`);
  }
  if (parsed.bridgePath !== undefined && (typeof parsed.bridgePath !== "string" || !parsed.bridgePath)) {
    throw new Error(`${CONFIG_FILENAME}: "bridgePath" must be a non-empty string`);
  }
  const enabled = parsed.enabled ?? BUILT_IN_DEFAULTS.enabled;
  const channel = parsed.channel ?? BUILT_IN_DEFAULTS.channel;
  // A caller who enables notifications but never names a channel has left the config half-finished —
  // refuse to load rather than silently drain into a no-op nobody asked for (the built-in default's own
  // `enabled: false` is the ONLY way this module is silent by design; an explicit `enabled: true` earns a
  // real check).
  if (enabled && !channel) {
    throw new Error(`${CONFIG_FILENAME}: "enabled": true requires a non-empty "channel" too`);
  }
  return {
    enabled,
    channel,
    bridgePath: parsed.bridgePath ?? BUILT_IN_DEFAULTS.bridgePath,
    source: "file",
    path: filePath,
  };
}
