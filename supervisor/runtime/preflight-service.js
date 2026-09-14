// preflight-service.js — extracted from runtime/supervisor.js (ChatGPT review, 2026-09-14: one of the
// "natural extraction seams" the review asked for — its own lifecycle (start -> wait for a real turn ->
// classify -> confirmed-kill cleanup -> record model_health) and its own dedicated tests
// (runtime/test/preflight.test.js). PURE CODE MOVE — every line of logic below is unchanged from its
// original position in supervisor.js; only the wrapping factory and this file's own imports are new.
//
// Real dependencies, traced before extracting: `database`, `logger`, the raw `adapters` registry (for
// `discardSession`), `harnessCache`, and four composition-root functions this subsystem calls into but
// does not own — `adapterFor`, `harnessOf`, `start`, `reap`. All four are passed in as closures; by the
// time `preflight()`/`discardPreflightRun()` are actually INVOKED (never at construction time), every
// one of them is already a real, assigned function on the composition root.

import { recordModelHealth, deletePreflightRun, listPreflightRuns } from "../db/index.js";

/** The prompt. Short and boring on purpose: this measures reachability, not capability. */
const PREFLIGHT_PROMPT = "Reply with the single word: ok";

/**
 * createPreflightService({ database, logger, adapters, harnessCache, adapterFor, harnessOf, start, reap })
 * -> { preflight, discardPreflightRun, sweepPreflightRuns }
 */
export function createPreflightService({ database, logger, adapters, harnessCache, adapterFor, harnessOf, start, reap }) {
  /**
   * Classify a failure into something section 12.3 can GROUP.
   *
   * A free-text provider message cannot answer "is everything on Bedrock failing?", which is the
   * question the denylist is for. The message is kept separately in `detail` for a human.
   */
  function classifyPreflightError(err) {
    const m = String(err?.message ?? err ?? "").toLowerCase();
    if (m.includes("timed out") || m.includes("timeout")) return "timeout";
    if (m.includes("enoent") || m.includes("spawn")) return "spawn-failed";
    if (m.includes("credential") || m.includes("unauthor") || m.includes("forbidden")
        || m.includes("expired") || m.includes("api key") || m.includes("auth")) return "auth";
    if (m.includes("throttl") || m.includes("rate limit") || m.includes("quota")) return "throttled";
    return "harness-error";
  }

  /**
   * preflight({ harnessId, workerId, cwd, model, timeoutMs }) -> the verdict.
   *
   * Cheap enough to run liberally, which is the whole design constraint: a check nobody runs
   * because it is expensive protects nothing.
   */
  async function preflight({
    harnessId,
    workerId,
    cwd,
    model = null,
    timeoutMs = 60_000,
    prompt = PREFLIGHT_PROMPT,
  } = {}) {
    if (!harnessId) throw new Error("preflight: harnessId is required");
    if (!workerId) throw new Error("preflight: workerId is required");
    if (!cwd) throw new Error("preflight: cwd is required");
    // Called for its throw, not its value: an unknown harness must fail here rather than after a
    // `runs` row exists. `adapterFor` is the single place that knows what is registered.
    adapterFor(harnessId);

    const startedAt = Date.now();
    let runId = null;
    let verdict = null;

    try {
      // The TIGHTEST environment available (PLAN.md 4.1): answering "ok" needs no MCP servers, no
      // hooks and no skills, and every one of those is pure cost on a check whose point is being
      // cheap. `ephemeral` adds `--no-session-persistence` where the harness supports it, so there
      // is no harness-side session to clean up at all -- not writing it beats deleting it, because
      // a delete can fail and a crash can pre-empt it.
      //
      // `envProfile` is NOT passed to harnesses that refuse it (OpenCode), so this builds the spec
      // per harness rather than sending one shape everywhere and hoping. The refusal is deliberate
      // over there and working around it here would defeat the point of having it.
      const spec = {
        prompt,
        cwd,
        isPreflight: true,
        ephemeral: true,
        ...(model ? { model } : {}),
        ...(harnessId === "claude-code" ? { envProfile: "none", approvalMode: "off" } : {}),
      };

      ({ runId } = await start({ harnessId, workerId, spec }));

      // Wait for the harness to actually produce a turn. `turn.end` is the normalized terminal
      // event both adapters emit (Group 4 finding B4), so this does not care which harness it is.
      const deadline = startedAt + timeoutMs;
      let sawTurnEnd = null;
      for (;;) {
        const events = database
          .prepare(`SELECT type, payload_json FROM event_log WHERE run_id = ? ORDER BY seq`)
          .all(runId);
        sawTurnEnd = events.find((e) => e.type === "turn.end");
        if (sawTurnEnd) break;
        // A process that died without ever producing a turn is a distinct, useful outcome: the
        // binary ran but the model never answered.
        const died = events.find((e) => e.type === "process.exit" || e.type === "process.error");
        if (died) {
          verdict = { reachable: false, errorClass: "no-response", detail: `process ended before any turn (${died.type})` };
          break;
        }
        if (Date.now() > deadline) {
          verdict = { reachable: false, errorClass: "timeout", detail: `no turn within ${timeoutMs}ms` };
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      if (!verdict && sawTurnEnd) {
        const payload = sawTurnEnd.payload_json ? JSON.parse(sawTurnEnd.payload_json) : {};
        // BOTH fields, not either alone. `turn.end` carries a normalized `status`
        // (completed|error|aborted) and a derived `isError` (Group 4 finding B4), but not every
        // adapter sets both on every path -- the fake harness emits `status` with no `isError`, so
        // trusting `isError` alone would read an errored turn as a success. `aborted` counts as a
        // failure here too: an interrupted turn did not demonstrate the model answering, which is
        // the only thing this check claims to establish.
        const failed = payload.isError === true || (payload.status && payload.status !== "completed");
        verdict = failed
          ? { reachable: false, errorClass: "harness-error", detail: `turn.end status=${payload.status ?? "?"} isError=${payload.isError ?? "?"}` }
          : { reachable: true, errorClass: "ok", detail: null };
      }
    } catch (err) {
      verdict = { reachable: false, errorClass: classifyPreflightError(err), detail: String(err?.message ?? err) };
    }

    // ── cleanup, and it runs on EVERY path ───────────────────────────────────────────────
    // Recorded BEFORE the cleanup, so a cleanup failure cannot cost us the verdict. The whole
    // point of the check is the verdict; tidying up is bookkeeping and must not outrank it.
    const latencyMs = Date.now() - startedAt;
    try {
      recordModelHealth(database, {
        harnessId,
        providerId: model?.providerID ?? model?.providerId ?? "",
        modelId: typeof model === "string" ? model : (model?.modelID ?? model?.modelId ?? ""),
        reachable: verdict.reachable,
        errorClass: verdict.errorClass,
        detail: verdict.detail,
        latencyMs,
      });
    } catch (err) {
      logger.error?.(`[supervisor] preflight verdict could not be recorded: ${err.message}`);
    }

    const cleanup = runId ? await discardPreflightRun(runId, harnessId) : { deleted: false, reason: "never started" };
    return { ...verdict, latencyMs, harnessId, cleanup };
  }

  /**
   * Stop a preflight run, drop the harness's own session record where it can be dropped, and
   * delete the rows.
   *
   * Separate from `preflight()` because reconciliation needs it too: a preflight that CRASHED is
   * found by the ordinary orphan path (PLAN.md 12.1 -- "the same reconciliation path, not a second
   * mechanism"), and once that path has done its terminal write the row still has to be removed.
   */
  async function discardPreflightRun(runId, harnessId = harnessOf(runId)) {
    const adapter = harnessId ? adapters[harnessId] : null;

    // EXTERNAL REVIEW (ChatGPT, 2026-09-14) finding 1, confirmed real: `adapter.stop()` returning
    // is NOT proof the OS process is dead. Claude Code's own `stop()` (adapters/claude-code/
    // adapter.js) fires SIGINT and only SCHEDULES a SIGKILL fallback 3s later via a bare
    // `setTimeout` — it is synchronous and returns immediately, awaiting neither the grace period
    // nor confirmed death. The old code here `await`ed that no-op promise and proceeded straight to
    // deleting rows, which could report cleanup "complete" while the real process was still alive
    // for up to 3+ seconds (longer if it doesn't even respond to SIGKILL promptly).
    //
    // `reap()` (this file, wired to `reconcile.js`'s `reapRun`) already exists as the ONE real,
    // tested, confirmed-kill mechanism in this codebase — `killProcessGroup`'s SIGTERM -> poll ->
    // SIGKILL -> poll-again sequence, gated on the OS actually reporting the group gone, not a fixed
    // delay. It already handles exactly the two cases a preflight can be in: a run-owned process
    // (Claude Code) gets killed and CONFIRMED directly by pgid; a process sharing a pooled group
    // (OpenCode) is ended via `adapterStop` instead of a group-kill, so a preflight sharing a
    // resident `opencode serve` with real work never collaterally kills it. `createRun`'s own
    // default (`started_by: 'preflight'` when `isPreflight: true`) is already accepted by `reapRun`'s
    // ownership refusal — this reuse was anticipated, not bolted on.
    const reaped = await reap(runId);
    // `reapRun` (`reconcile.js`) returns several distinct refusal shapes, and only TWO of them mean
    // "a kill/session-end was actually attempted and could not be confirmed" — the genuinely unsafe
    // case this check exists for. The others (no identity was ever recorded; the recorded identity
    // is incomplete; live verification found nothing matching) all mean "there is nothing here that
    // could still be running" and are perfectly safe to proceed past — distinguished structurally
    // (each real-kill-attempt return includes `pgid`; each shared-group refusal includes
    // `sharedWith`), not by matching a `reason` string that could drift out of sync with this check.
    const killAttemptedButUnconfirmed =
      (Object.hasOwn(reaped, "pgid") && reaped.reaped !== true)
      || (Object.hasOwn(reaped, "sharedWith") && reaped.sessionEnded !== true);
    if (killAttemptedButUnconfirmed) {
      // Deleting the rows now would manufacture exactly the invisible-orphan bug this whole
      // codebase exists to prevent — a still-running process with no row anything will ever look
      // at again. Refuse instead of silently declaring success.
      logger.warn?.(
        `[supervisor] preflight ${runId} could not be confirmed ended (${reaped.reason ?? reaped.note ?? "unknown"}); `
        + "refusing to delete its rows — it may still be running",
      );
      return { deleted: false, reason: `not confirmed ended: ${reaped.reason ?? reaped.note ?? "unknown"}`, reapResult: reaped };
    }
    // `reap()` above already closes the pump on confirmed success (`result.reaped === true ||
    // result.sessionEnded === true`) — the exact same call `pump.closeRun(runId)` this function used
    // to make directly, now made exactly once instead of the risk of two teardown paths disagreeing.

    let sessionDiscarded = null;
    if (typeof adapter?.discardSession === "function") {
      sessionDiscarded = await adapter.discardSession(runId);
      if (!sessionDiscarded.discarded) {
        logger.warn?.(`[supervisor] preflight ${runId}: harness session not discarded (${sessionDiscarded.reason})`);
      }
    }

    try {
      const removed = deletePreflightRun(database, runId);
      harnessCache.delete(runId);
      // NOT dropping pump state here. It is retained for completed runs on purpose (see
      // runtime/FINDINGS.md's open items: that state is what `status()`/`list()` read for
      // `derived`, so releasing it makes a just-finished run report `derived: null`). An earlier
      // draft called a `pump.forget()` that does not exist, via `?.` -- so it silently did nothing
      // and read as though cleanup were happening. Bounded retention is the real fix and is
      // tracked there, not worked around here.
      return { ...removed, sessionDiscarded };
    } catch (err) {
      // A refusal here means the runId was not a preflight, which is a caller bug and must be
      // loud: this is the only destructive delete in the codebase.
      logger.error?.(`[supervisor] preflight rows for ${runId} were NOT deleted: ${err.message}`);
      return { deleted: false, reason: err.message, sessionDiscarded };
    }
  }

  /**
   * Sweep preflight rows that outlived their check -- a supervisor killed mid-preflight leaves one.
   *
   * Only TERMINAL preflights are deleted. An OPEN one may still be running (its own supervisor may
   * be alive and mid-check), and deleting the row of a live process is how you manufacture an
   * orphan nothing can ever reap -- the exact bug migration 0003 exists to prevent. So this waits
   * for reconciliation to reach a terminal state first, and only then removes the row.
   */
  async function sweepPreflightRuns() {
    const stale = listPreflightRuns(database).filter((r) => r.ended_at !== null);
    const swept = [];
    for (const row of stale) {
      const result = await discardPreflightRun(row.run_id, row.harness_id);
      if (result.deleted) swept.push(row.run_id);
    }
    if (swept.length) logger.log?.(`[supervisor] swept ${swept.length} finished preflight run(s)`);
    return { swept };
  }

  return { preflight, discardPreflightRun, sweepPreflightRuns };
}
