// mcp-manifest.js — PLAN.md §21.2, the lazy capability router's v1 scope. Pure.
//
// WHAT THIS TURNED OUT TO ACTUALLY NEED, INVESTIGATED BEFORE DESIGNING ANYTHING (2026-09-11)
//
// §21.2's original framing assumed a harness-level "defer tool schemas until asked for by name"
// mechanism might exist to hook into, modeled on this project's own experience with Claude Code's
// deferred-tool `ToolSearch` pattern. Checked before building: `adapters/claude-code/worker-env.js`
// (measured against real `claude` CLI behavior, see its own header) shows the ONLY control this
// codebase has over what MCP tooling a spawned session sees is `spec.mcpConfig` — an explicit list of
// `--mcp-config <file>` paths, combined with `--strict-mcp-config` so NOTHING outside that list loads.
// There is no per-turn, ask-for-it-by-name deferral inside a spawned Claude Code session for arbitrary
// MCP servers — that is a property of THIS session's own harness (Claude Code driving itself), not
// something a spawned sub-session's `--mcp-config` can opt into. OpenCode's adapter shows no equivalent
// mechanism either. **So the harness-integration half of "lazy discovery" does not exist yet to build
// against — this is not a gap in this module, it is an honest ceiling on what's possible today.**
//
// WHAT'S ACTUALLY BUILT HERE, GIVEN THAT CEILING
//
// The real, available lever is `spec.mcpConfig`'s SET, not its lazy discovery: today a caller decides
// that list ad hoc, per call. This module computes the MINIMAL manifest for a role — which named,
// pooled (§21.1) MCP configs it actually needs — so a role gets `--mcp-config` for exactly its own
// declared needs and nothing else, rather than however many servers happened to be on hand. That is
// strictly narrower than "every configured server, every turn," even though it is not per-turn lazy
// discovery. `manifestForRole` is pure and returns the same answer for the same inputs.
//
// UPDATE, same day: a later pass DID wire `manifestForRole`'s pool-name list into `start()`'s
// attach/detach lifecycle (`runtime/mcp-pool.js`) — real pool rows, real attachments, tested. It did
// NOT end up wiring the result into `spec.mcpConfig`, though an even later pass briefly tried: doing so
// meant handing the adapter a non-string marker object where its own contract (`string | string[]`, a
// real config file path) expects one — corrected in `runtime/supervisor.js`, see
// `codexdoc/review-luna-2026-09-11.md` finding 2. So the honest state is: role->pool-name resolution
// AND the pool lifecycle are both real; a spawned worker session getting an actual usable MCP
// connection from it is still not, because no `--mcp-config` value naming a pooled (non-file,
// non-stdio-command) server has ever been measured to work.

/**
 * Declared per-role MCP needs, by POOL NAME (matching `runtime/mcp-pool.js`'s `attach(name, config)`
 * identity) — not a file path directly, so a role's declaration is stable even if the underlying config
 * (and therefore its `config_hash`) changes. Utility-task-lane roles (PLAN.md §16.2) are the first real
 * candidates: each already has a fixed, narrow toolset by construction (domain/capabilities.js's
 * `utility:*` presets), so declaring a fixed MCP need per role is the same discipline applied one layer
 * up. A role absent from this map needs none — not an error, an honest "nothing declared yet."
 */
export const ROLE_MCP_NEEDS = Object.freeze({
  "git-push-runner": Object.freeze(["leo-mcp"]),
  "jira-runner": Object.freeze(["leo-mcp"]),
  "slack-runner": Object.freeze(["leo-mcp"]),
  // awsquery-runner declares none here on purpose: its AWS access today is via a configured AWS MCP
  // server that is not this project's own pooled config — see PLAN.md §16.2's own note that its
  // responsibility is answering "is it there or not, what pattern," not owning a specific MCP identity.
});

/**
 * The minimal MCP manifest for a role: `{ role, pools: string[], configPaths: string[] }`.
 *
 * `configPaths` is resolved from `registeredConfigs` (a `{ name: filePath }` map the caller supplies —
 * this module does not know how config files are laid out, only how to pick the minimal SET of names a
 * role needs). A pool name a role needs but that isn't in `registeredConfigs` is reported in
 * `missing`, not silently dropped — the same "never guess an underspecified request" discipline the
 * utility-task lane's "ask, don't guess" rule already applies one layer up.
 */
export function manifestForRole(role, { registeredConfigs = {} } = {}) {
  const pools = [...(ROLE_MCP_NEEDS[role] ?? [])];
  const configPaths = [];
  const missing = [];
  for (const name of pools) {
    const p = registeredConfigs[name];
    if (p) configPaths.push(p);
    else missing.push(name);
  }
  return { role, pools, configPaths, missing };
}

/** Every role with a declared MCP need — for a UI/CLI that wants the real list rather than a hardcoded one. */
export const ROLES_WITH_MCP_NEEDS = Object.freeze(Object.keys(ROLE_MCP_NEEDS));
