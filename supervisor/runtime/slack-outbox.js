// slack-outbox.js — the DELIVERY half of Phase 9 (Slack outbound), 2026-09-14. `runtime/supervisor.js`
// WRITES an `outbox` row on a real task transition (`db/index.js`'s `writeOutboxEvent`); this module
// DRAINS it — the same producer/consumer split `runtime/mcp-pool.js` keeps from `db/index.js`'s own
// claim/attach primitives, applied to a different resource.
//
// A short-lived CLI spawn, not a resident process — `team-slack-bridge`'s `post.js` runs once per
// message and exits, so this uses the same `execFile`(promisified)-per-call shape `agents/
// git-create-push.js` already uses for git, not `runtime/spawn.js`'s `spawnManaged` (built for a
// long-lived, process-group-owned child, which this is not).
//
// IDEMPOTENCY IS THE SIBLING REPO'S JOB, NOT THIS MODULE'S — measured, not assumed, before writing this:
// `team-slack-bridge/core/post.js` claims an `idempotencyKey` in its own `node:sqlite`-backed ledger
// BEFORE calling Slack, and returns the previous result on a repeat key instead of posting twice
// (`core/ledger.js`'s `claim`/`complete`). Passing the SAME `outbox.id` as `--idempotency-key` on every
// drain attempt for the same row is therefore enough — a crash between a successful post and this
// module's own `markOutboxDelivered` write leaves the row undelivered, a later drain retries with the
// identical key, and the bridge's ledger recognizes it and returns the first result rather than posting
// again. This module does not build a second ledger.
//
// BOT-ONLY, NEVER `--as-user` — PLAN.md §14.5. There is no code path in this file that can pass
// `--as-user`; it is not a config option `config/slack-notifications.js` even exposes.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { listUndeliveredOutboxEvents, markOutboxDelivered } from "../db/index.js";

const execFileAsync = promisify(execFile);

/** One human-readable line per event type this phase actually produces (`approveTask`/`mergeTask`'s own
 *  transitions) — deliberately small and closed, like `EXIT_REASON_FOR_STATUS` elsewhere in this
 *  codebase; an event type this function doesn't recognize is refused rather than posted as a guess. */
function renderText(eventType, payload) {
  const title = payload?.title ?? "(untitled)";
  const taskId = payload?.taskId ?? "?";
  if (eventType === "task-approved") return `:white_check_mark: Task approved: "${title}" (${taskId})`;
  if (eventType === "task-merged") return `:rocket: Task merged: "${title}" (${taskId})`;
  return null;
}

/**
 * createSlackOutboxDrain({ db, logger, loadConfig }) -> { drain }
 *
 * `loadConfig` is injected (defaults to the real `config/slack-notifications.js`) so a test can supply a
 * fixed config with no filesystem read — same "inject rather than hard-wire" reasoning `createSupervisor`
 * already uses for `digestFn`.
 */
export function createSlackOutboxDrain({ db, logger = console, loadConfig, stateDir } = {}) {
  async function drain() {
    const config = loadConfig({ stateDir });
    // "No integration is ever a hard dependency" (PLAN.md §2.10 / team-slack-bridge PLAN.md §2) — the
    // built-in default is `enabled: false`, and an operator who never configures a channel gets a
    // genuine no-op here, not a warning log on every tick.
    if (!config.enabled || !config.channel) return { drained: 0, delivered: 0, failed: 0 };

    const pending = listUndeliveredOutboxEvents(db);
    let delivered = 0;
    let failed = 0;
    for (const event of pending) {
      const text = renderText(event.eventType, event.payload);
      if (!text) {
        // An event type this drain does not know how to render is left undelivered forever by design —
        // marking it "delivered" would silently drop a real event; retrying it would spin forever on the
        // same unrenderable payload. Logged once per drain tick so it is visible, not swallowed.
        logger.warn?.(`[slack-outbox] event ${event.id} has unrecognized eventType "${event.eventType}" — leaving undelivered`);
        failed += 1;
        continue;
      }
      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [
            path.join(config.bridgePath, "post.js"),
            "--json", "--channel", config.channel, "--text", text, "--idempotency-key", event.id,
          ],
          { encoding: "utf8", timeout: 30_000 },
        );
        const result = JSON.parse(stdout);
        if (result.ok) {
          markOutboxDelivered(db, event.id);
          delivered += 1;
        } else {
          logger.warn?.(`[slack-outbox] event ${event.id} not delivered (bridge reported ${JSON.stringify(result)}) — will retry`);
          failed += 1;
        }
      } catch (err) {
        // Non-fatal, same posture as every other best-effort background write in this codebase
        // (`taskHandoff`, `applyClearPolicy`) — a delivery failure must never crash the drain loop or the
        // transition that produced the event; the row simply stays undelivered for the next tick.
        logger.warn?.(`[slack-outbox] event ${event.id} failed to post (non-fatal, will retry): ${err.message}`);
        failed += 1;
      }
    }
    return { drained: pending.length, delivered, failed };
  }

  return { drain };
}
