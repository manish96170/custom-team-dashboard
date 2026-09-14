// supervisor.js — the composition root Group 5 exists to build: the real database, the
// real adapters, one supervisor-owned event consumer per run, `harnessOf` routing that
// survives a restart, startup reconciliation, a real `reap`, and deterministic teardown.
//
// Before this file, ipc/server.js was wired to `persistence-stub.js` and
// `mock-adapter.js`. Those stubs said so in their own headers ("swapping in the real
// module should be a constructor-argument change") -- this is that change, plus the
// lifecycle work that only becomes possible once a real adapter and a real schema are on
// both ends of it.
//
// Routing is the part worth reading twice. `harnessOf(runId)` cannot live only in memory:
// after a supervisor restart the only thing that survived is the database, and every
// command aimed at a pre-restart run (`reap`, `stop`, `observe`) needs to know which
// adapter owns it. So the map is a CACHE over the `runs.harness_id` column, populated
// from persisted rows on boot and read through to the database on a miss. Without that,
// `orphaned-unmanaged` really is the dead-end state the review called it: a row you can
// list and nothing more.

import {
  openDb,
  closeDb,
  createTask,
  createWorker,
  createRun,
  endRun,
  closeOpenAsksForRun,
  bumpRunGeneration,
  recordEvent,
  recordRunProcess,
  getRun,
  reopenRun,
  listOpenRuns,
  listOrphanedRuns,
  listOrphanSightings,
  scheduleAskAutoClose,
  sweepExpiredAsks,
  ASK_AUTO_CLOSE_GRACE_MS,
  createAsk,
  getAsk,
  answerAsk as answerAskRow,
  withdrawAsk,
  markAskDelivered,
  listPendingAsks,
  listUndeliveredAnswers,
  taskIdForRun,
  workerIdForRun,
  claimTaskWorktreeSlot,
  finalizeTaskWorktreeSlot,
  releaseTaskWorktreeClaim,
  reclaimStaleTaskWorktreeClaim,
  WORKTREE_CLAIM_PENDING,
  sleepSync,
  parseJsonColumn,
  redactResolvedAskPayload,
  listRunsForDisplay,
  upsertHarness,
  markRunAdopted,
  findAdoptedRun,
  listAdoptedRuns,
  deletePreflightRun,
  listPreflightRuns,
  recordModelHealth,
  getModelHealth,
  listModelHealth,
  recordTaskHandoff,
  recordTransition,
  mintPrincipal,
  principalByTokenHash,
  principalForWorker,
  rotatePrincipalToken,
  getPrincipal,
  listPrincipals,
  revokePrincipal,
  journalAppend,
  journalHasDone,
  listJournal,
  grantSensitiveApproval,
  findSensitiveApproval,
  consumeSensitiveApproval,
  importReviewProfile,
  getReviewProfile,
  recordReviewVerdict,
  listReviewVerdicts,
  latestReviewRound,
  listReviewProfiles,
  listTurnDigests,
  listTier1EventsSince,
  listTaskTurnDigests,
  latestTaskHandoff,
  listTaskHandoffs,
  tryAcquireLease,
  getLease,
  releaseLeaseRow,
  renewLeaseRow,
  sweepExpiredLeases,
  listActiveLeases,
  setAttachmentRunId,
  listOpenAttachmentsForRun,
  MAX_LEASE_TTL_MS,
  writeOutboxEvent,
} from "../db/index.js";
import { loadResources } from "../config/resources.js";
import { loadProtectedBranches } from "../config/protected-branches.js";
import { loadSlackNotifications } from "../config/slack-notifications.js";
import { createSlackOutboxDrain } from "./slack-outbox.js";
import { runFightLoop, resolvePushDestination } from "../agents/git-create-push.js";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createEventPump } from "./event-pump.js";
import { generateTaskHandoff } from "../handoff/generate.js";
import { loadHarnessDefaults, assignmentFor } from "../config/harness-defaults.js";
import { decideClear } from "../domain/clear-policy.js";
import { classifySessionAction } from "../domain/session-intent.js";
import { loadReviewProfiles, profileFor as profileForReview } from "../config/review-profiles.js";
import { evaluateReview, rankFindings, diffFindings, FINDING_VERDICTS } from "../domain/review.js";
import {
  authorize, canGrantApproval, argsHash, requireArgs, PRESETS, COMMAND_CAPABILITIES, isSensitive,
} from "../domain/capabilities.js";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

// review-sol-2026-09-13.md finding 23: the worktree lifecycle (create/status/discard/request) used to
// run every git call through `execFileSync` — blocking the WHOLE daemon event loop for as long as the
// child runs (a real `git worktree add`/`remove` can legitimately take up to its own internal timeout).
// Not just this call's own logic — every socket command, ask, digest, and lease-renewal timer on the
// SAME daemon process stalls too, for however long the git process takes. `execFile` (promisified) waits
// on the child via libuv without blocking the event loop — the exact fix `agents/git-create-push.js`
// already applies to its own git calls (see that file's own `execFileAsync`). The sequence of git calls
// and what they mean is UNCHANGED here too — only how each one is awaited.
const execFileAsync = promisify(execFile);
import fs from "node:fs";
import { planAssignment, isActionable } from "../domain/assignment.js";
import { isTerminal, autoBlockTarget } from "../domain/task-states.js";
import { instructionForRole } from "../domain/utility-instructions.js";
import { rolesFor } from "../domain/workflow-profiles.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractiveDigest, DIGEST_BUDGET_CHARS } from "../domain/turn-digest.js";
import { runConformance, formatReport } from "../conformance/suite.js";
import { reconcileOnBoot, reap as reapRun } from "./reconcile.js";
import { readProcInfo } from "./procinfo.js";
import { createMcpPool } from "./mcp-pool.js";
import { manifestForRole, ROLE_MCP_NEEDS, ROLE_MCP_TOOL_ALLOWLIST } from "../domain/mcp-manifest.js";
import { poolConfigFor } from "../config/mcp-pools.js";

/** turn.end status (derived by the pump) -> the `runs.exit_reason` written when the
 * adapter's own stream ends. `finished` is written ONLY from here -- the adapter's
 * completion path -- never by reconciliation (PLAN.md section 4). */
const EXIT_REASON_FOR_STATUS = {
  completed: "finished",
  error: "errored",
  aborted: "interrupted",
};

/**
 * The utility-task lane's role -> capability-preset map (PLAN.md §16.2). Module-scoped (not local to
 * `ensureWorkerPrincipal`) so `start()`'s MCP-pool wiring can ask "is this a utility-task role" using
 * the SAME signal `ensureWorkerPrincipal` already uses, rather than inventing a second way to detect
 * the same four roles. `domain/mcp-manifest.js`'s `ROLE_MCP_NEEDS` answers a different question (which
 * pool configs a role wants) and deliberately is not merged with this one — a role can be a utility-task
 * role with no declared MCP need (`awsquery-runner` today), and the two maps drifting independently is
 * more honest than forcing one to imply the other.
 */
const UTILITY_TASK_PRESETS = Object.freeze({
  "git-push-runner": "utility:git",
  "jira-runner": "utility:jira",
  "awsquery-runner": "utility:awsquery",
  "slack-runner": "utility:slack",
});

// The stdio<->socket bridge `start()` points a pooled MCP server's `--mcp-config` entry at
// (review-sol-2026-09-13.md finding 13) — see `mcp-stdio-proxy.js`'s own header for why this exists
// instead of naming the socket directly. Exported so a test can assert against it directly rather than
// re-deriving the same path a second, independent way.
export const MCP_STDIO_PROXY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-stdio-proxy.js");

/**
 * @param {{
 *   db?: object, stateDir?: string,
 *   adapters: Record<string, object>,   // harnessId -> adapter module
 *   logger?: object,
 * }} opts
 */
export function createSupervisor({
  db,
  stateDir,
  adapters,
  logger = console,
  // Ask auto-close (migration 0003). Both are injectable so a test does not have to wait five
  // real minutes, and so the sweep can be driven deterministically instead of by a timer.
  askGraceMs = ASK_AUTO_CLOSE_GRACE_MS,
  askSweepIntervalMs = 30_000,
  /**
   * How a tier-2 turn digest is produced (PLAN.md section 8, Rule 4).
   *
   * Defaults to the EXTRACTIVE digester: free, deterministic, and incapable of inventing an assumption
   * nobody stated. Rule 4 says "by the cheapest available model", and `domain/turn-digest.js`'s header
   * records why the default deviates — a model call on the most frequent event in the system, producing
   * text no test can check, for a reader that will act on it.
   *
   * Injected rather than hard-wired so a model-backed digester is a one-line swap and so every test is
   * free. Signature: `(turnEvents, { budgetChars }) -> digest | Promise<digest>`.
   */
  digester = extractiveDigest,
  /** `false` turns tier 2 off entirely — a digest per turn is still a write per turn. */
  digestTurns = true,
  /**
   * How a review finding is adversarially verified (PLAN.md section 13's `verifyFindings`).
   *
   * `null` by default, and that is not a stub: deciding whether a finding is real means reading the code,
   * which needs a model. With no verifier, findings are recorded as `unverified` and delivered LABELLED —
   * because treating them as confirmed would be a lie and dropping them would lose real findings.
   * Signature: `(finding, { profile, taskId }) -> { verdict: 'CONFIRMED'|'PLAUSIBLE'|'REFUTED', note? }`.
   */
  findingVerifier = null,
} = {}) {
  if (!adapters || Object.keys(adapters).length === 0) {
    throw new Error("createSupervisor: at least one adapter is required (harnessId -> adapter module)");
  }
  const ownsDb = !db;
  const database = db ?? openDb({ stateDir });

  /** Cache over `runs.harness_id`. Never the source of truth -- see the header. */
  const harnessCache = new Map();

  const persistence = {
    // The pump's persistence contract, satisfied by the real writer. better-sqlite3 is
    // synchronous, so there is no await here to forget.
    async recordEvent(row) {
      recordEvent(database, row);
    },
  };
  const pump = createEventPump({ persistence, logger });
  // PLAN.md §21.1, wired into a real start/end path 2026-09-11. One manager per supervisor process,
  // same lifetime as `pump` — its `_liveChildren` map is only meaningful for THIS process's own spawns.
  const mcpPool = createMcpPool({ db: database, logger });
  // ROADMAP.md Phase 9 (Slack outbound), 2026-09-14. `loadConfig` re-reads `stateDirOf()` on every drain
  // tick, same "declare, don't cache" contract `config/mcp-pools.js`'s own `poolConfigFor` already keeps
  // — this is a closure over the function, not its return value, so it stays correct even though
  // `stateDirOf` itself is defined further down this same constructor.
  const slackOutbox = createSlackOutboxDrain({
    db: database, logger,
    loadConfig: (opts) => loadSlackNotifications({ ...opts, stateDir: stateDirOf() }),
  });

  /**
   * Where this supervisor's state directory is.
   *
   * Derived from the OPEN DATABASE's own path when the caller passed a `db` rather than a `stateDir` —
   * which most tests and the demo do. `better-sqlite3` exposes the file it opened, so this is a fact
   * rather than a guess, and it means `harness-defaults.json` is looked for beside the database that
   * defines the installation rather than in whatever directory the process happens to be running in.
   */
  function stateDirOf() {
    if (stateDir) return stateDir;
    const file = database?.name;
    return file ? path.dirname(file) : process.cwd();
  }

  function adapterFor(harnessId) {
    const adapter = adapters[harnessId];
    if (!adapter) throw new Error(`no adapter registered for harness "${harnessId}" (have: ${Object.keys(adapters).join(", ")})`);
    return adapter;
  }

  /**
   * Which harness owns this run. Memory first, then the database — a run created before
   * this process started is routable purely from its persisted row.
   */
  function harnessOf(runId) {
    const cached = harnessCache.get(runId);
    if (cached) return cached;
    const row = getRun(database, runId);
    if (!row) return null;
    harnessCache.set(runId, row.harness_id);
    return row.harness_id;
  }

  /**
   * Detach every MCP-pool attachment a run held, best-effort, after the run's terminal write has
   * already committed. NOT awaited by callers on purpose — `detach()` may have to kill a real process
   * (`killProcessGroup`'s grace period), and a run ending must not block on that any more than a lease
   * release does. Failures are logged, never thrown: a stuck detach is a pool-hygiene problem for the
   * next `reconcileOnBoot`/idle-drain sweep to catch, not a reason to fail the run's own terminal write,
   * which has already committed by the time this is called.
   */
  function scheduleAttachmentDetach(runId) {
    let ids;
    try {
      ids = listOpenAttachmentsForRun(database, runId);
    } catch (err) {
      logger.warn?.(`[supervisor] could not list mcp-pool attachments for run ${runId}: ${err.message}`);
      return;
    }
    for (const id of ids) {
      mcpPool.detach(id).catch((err) => {
        logger.warn?.(`[supervisor] mcp-pool detach ${id} for run ${runId} failed (best-effort): ${err.message}`);
      });
    }
  }

  function routeOrThrow(runId) {
    const harnessId = harnessOf(runId);
    if (!harnessId) throw new Error(`unknown runId: ${runId}`);
    return { harnessId, adapter: adapterFor(harnessId) };
  }

  /** True while some adapter still holds a live handle for this run. */
  function hasHandle(runId) {
    const harnessId = harnessOf(runId);
    if (!harnessId) return false;
    const adapter = adapters[harnessId];
    if (!adapter?.listRuns) return false;
    return adapter.listRuns().includes(runId);
  }

  /**
   * Boot: rehydrate routing from persisted rows, then reconcile. In that order, because
   * reconciliation's `hasHandle` check routes through `harnessOf`.
   */
  async function boot({ reconcile = true, sweepAsksOnBoot = true } = {}) {
    const open = listOpenRuns(database);
    for (const row of open) harnessCache.set(row.run_id, row.harness_id);
    logger.log?.(`[supervisor] rehydrated routing for ${open.length} open run(s) from persisted rows`);
    const reconciliation = reconcile ? await reconcileOnBoot({ db: database, hasHandle, logger }) : null;
    // Boot reconciliation closes asks for every run it reconciles (`reconcile.js`), which can leave a
    // task `blocked` with nothing left open if that was its only run — same reconcile this file's other
    // ask-closing paths already do.
    if (reconcile) reconcileAutoBlockedTasks();
    // A run reconciled to `lost` is no longer cooperating (same reasoning `endRun` already applies to
    // leases) — its MCP-pool attachments, if any, must not wait for the pool's own idle sweep.
    for (const runId of reconciliation?.lost ?? []) scheduleAttachmentDetach(runId);
    // §21.1's own boot-time reconciliation: every `mcp_pool` row claiming `starting`/`ready` predates
    // THIS process's in-memory child map, so it's either genuinely dead or an orphan from a previous
    // boot of this same daemon — see `mcp-pool.js`'s `reconcileOnBoot` for why neither case is reusable.
    const mcpPoolReconciliation = reconcile ? await mcpPool.reconcileOnBoot() : null;
    // The grace period is persisted precisely so a crash during it does not strand the ask, so
    // boot has to be one of the places that sweeps — a timer alone would only ever fire in
    // processes that stayed alive.
    const asksAutoClosed = sweepAsksOnBoot ? sweepAsks() : 0;
    // Same reasoning, same timer: a lease holder SIGKILLed mid-hold must not deadlock every future
    // waiter, and re-using `askSweepTimer`'s interval rather than starting a second one is deliberate —
    // this codebase's own review rule against building a mechanism that already exists a few lines away.
    const leasesSwept = sweepAsksOnBoot ? sweepLeases() : 0;
    // Same reuse, same reasoning, Phase 9: an outbox row written right before a crash must not wait for
    // this process to happen to still be alive later — boot is one of the places that has to drain it,
    // same as the ask/lease sweeps just above.
    if (sweepAsksOnBoot) slackOutbox.drain().catch((err) => logger.warn?.(`[supervisor] boot slack-outbox drain failed (non-fatal): ${err.message}`));
    if (askSweepIntervalMs > 0 && !askSweepTimer) {
      askSweepTimer = setInterval(() => {
        sweepAsks(); sweepLeases();
        slackOutbox.drain().catch((err) => logger.warn?.(`[supervisor] slack-outbox drain failed (non-fatal): ${err.message}`));
      }, askSweepIntervalMs);
      // Bookkeeping must not be the reason a process refuses to exit.
      askSweepTimer.unref?.();
    }
    // After the sweep, so an answer whose grace has just expired is not redelivered to a
    // request the sweep is about to close. Answers are durable before they are delivered
    // (0004), so this is the boot half of that guarantee.
    const redelivery = await deliverPendingAnswers();
    // After reconciliation, because that is what gives a crashed preflight its terminal state --
    // and this only deletes TERMINAL preflight rows. A supervisor SIGKILLed mid-check leaves a
    // preflight row behind, and PLAN.md 12.1 requires it be cleaned up by this same path rather
    // than by a second mechanism.
    const preflights = await sweepPreflightRuns();
    // PLAN.md section 3: `review-profiles.json` is "imported into the `review_profiles` table on supervisor
    // startup/file-change". Startup is here. Non-fatal on a malformed file: the supervisor must still boot
    // and be able to SAY what is wrong, rather than refusing to start over a config typo.
    // The owner principal (PLAN.md §16). Minted at boot because the socket is enforced from the moment it
    // listens, and a daemon with no owner principal is a daemon nobody can talk to.
    let owner = null;
    try {
      const ensured = ensureOwnerPrincipal();
      owner = { id: ensured.principal.id, minted: ensured.minted, tokenFile: path.join(stateDirOf(), OWNER_TOKEN_FILE) };
    } catch (err) {
      owner = { error: err.message };
      logger.warn?.(`[supervisor] could not ensure the owner principal: ${err.message}`);
    }
    let reviews = null;
    try {
      reviews = importReviewProfiles();
    } catch (err) {
      reviews = { error: err.message };
      logger.warn?.(`[supervisor] review-profiles.json could not be imported: ${err.message}`);
    }
    return {
      rehydrated: open.map((r) => r.run_id), reconciliation, asksAutoClosed, leasesSwept, redelivery,
      preflights, reviews, owner, mcpPoolReconciliation,
    };
  }

  /**
   * Persist the OS-verified process identity of a just-started run.
   *
   * Only ever writes what the identity promise *verified*. An unverified identity is left
   * as NULL rather than filled in with the pid we asked for: a recorded pid with no
   * verified pgid/start-time would be reaped later on pid alone, which is the pid-reuse
   * footgun runtime/reconcile.js refuses to walk into.
   */
  async function persistIdentity(runId, adapter) {
    if (!adapter.processIdentity) return { verified: false, reason: "adapter does not expose processIdentity()" };
    let identity;
    try {
      identity = await adapter.processIdentity(runId);
    } catch (err) {
      // spawnManaged rejects when the child came back in someone else's process group --
      // it has already killed it. The run is over before it began; say so honestly.
      logger.warn?.(`[supervisor] run ${runId} could not be owned: ${err.message}`);
      endRun(database, runId, { exitReason: "errored" });
      scheduleAttachmentDetach(runId);
      pump.closeRun(runId);
      throw err;
    }
    if (identity.verified) {
      recordRunProcess(database, runId, {
        pid: identity.pid,
        processGroup: identity.pgid,
        procLstart: identity.lstart,
        spawnDepth: identity.spawnDepth ?? null,
        cwd: identity.cwd ?? null,
        harnessSessionId: identity.harnessSessionId ?? null,
      });
    } else {
      logger.warn?.(`[supervisor] run ${runId} has no verified process identity (${identity.reason}); recording none`);
      recordRunProcess(database, runId, {
        spawnDepth: identity.spawnDepth ?? null,
        cwd: identity.cwd ?? null,
        harnessSessionId: identity.harnessSessionId ?? null,
      });
    }
    return identity;
  }

  /**
   * Start a run: spawn it, persist the row, attach the supervisor's own consumer, then
   * record the verified identity.
   *
   * The pump is attached BEFORE the identity round-trip on purpose: identity verification
   * is a real `ps` call taking tens of milliseconds, and a fast first event must not be
   * able to arrive before anyone is consuming.
   */
  /**
   * The pump's end-of-stream hook: the adapter's own completion path, and the only writer
   * of `finished`. Shared by `start()` and `resume()` so a resumed generation books its
   * completion exactly the way the first one did.
   *
   * No pre-read of `ended_at` here on purpose — `endRun`'s `WHERE ended_at IS NULL` makes
   * "first writer wins" atomic, so a run that finishes at the same instant a client stops
   * it keeps the reason of whichever landed first instead of the reason of whichever ran
   * its UPDATE last.
   */
  function onEndHook(runId) {
    return ({ derived }) => {
      // A deliberate terminal action in flight outranks the status derived from the stream
      // ending. When the supervisor kills a run, the adapter stream ends *because of* the
      // kill and derives `error` -> "errored"; the truthful cause is "reaped". Before
      // `endRun` became first-writer-wins this sorted itself out by accident (reap's
      // unguarded UPDATE overwrote whatever the hook wrote, most of the time), which is
      // exactly the clobbering the guard exists to stop — so the intent is now explicit.
      const reason = terminalIntent.get(runId) ?? EXIT_REASON_FOR_STATUS[derived.terminalStatus] ?? "errored";
      // Closing the run and scheduling its unanswered asks' grace are ONE transaction: a
      // crash between them would strand the ask exactly the way the pre-0003 code did
      // (better-sqlite3 is synchronous, so this is a real atomic unit, not a hopeful one).
      closeAndScheduleAsks(runId, reason);
    };
  }

  /**
   * Reasons that mean "the run ended on its own", as opposed to "we deliberately ended it".
   * Only these get the ask grace period: the distinction is *who decided*, not whether the run
   * succeeded. A deliberate `stop`/`reap` is a human already acting on this run, so leaving its
   * approval question open for five more minutes helps nobody.
   */
  const SELF_ENDED_REASONS = new Set(["finished", "errored", "interrupted"]);

  /**
   * Terminal write plus ask bookkeeping, atomically (one `db.transaction`, so a crash cannot
   * land between closing the run and dealing with its asks — which is the failure this whole
   * mechanism exists to prevent).
   *
   * A run that ends *by itself* does not close its unanswered asks outright: it gives them a
   * grace period (`asks.auto_close_at`), because a run finishing does not mean the human who
   * was asked has walked away. Everything else — `stop`, `reap`, reconciliation — closes them
   * immediately, because the run is gone, unmanaged, or was just deliberately ended.
   *
   * Which writer gets here matters and is why this is centralised: killing a run ends its
   * adapter stream, so the terminal write frequently comes from the pump's `onEnd` hook rather
   * than from `stop`/`reap` themselves (Group 6, concurrency case 5). The hook carries the
   * deliberate `terminalIntent` reason, so the decision below is made on the REASON, not on
   * which function happened to win the race.
   */
  const closeAndScheduleAsks = database.transaction((runId, reason) => {
    const closed = endRun(database, runId, { exitReason: reason });
    // Only the first writer does the bookkeeping — if someone else already closed this run,
    // theirs stands.
    if (closed !== 1) return closed;
    if (SELF_ENDED_REASONS.has(reason)) scheduleAskAutoClose(database, runId, { graceMs: askGraceMs });
    else { closeOpenAsksForRun(database, runId, { reason }); reconcileAutoBlockedTasks(); }
    // Fires async detaches without awaiting them — safe inside this synchronous transaction callback
    // because `scheduleAttachmentDetach` itself never awaits, only kicks work off. See its own comment.
    scheduleAttachmentDetach(runId);
    return closed;
  });

  // ── the approval / question round trip (Phase 2, PLAN.md section 7) ─────────────────
  //
  // Measured on `claude` 2.1.263 (adapters/FINDINGS.md): the harness sends a `can_use_tool`
  // control request and PARKS the worker's turn until it gets an answer, with no deadline of
  // its own. Two consequences drive everything below.
  //
  // First, a parked request means a worker is genuinely stopped. So the ask row is written
  // from the pump's `onEvent` hook — the one consumer that is always attached — rather than
  // from a client, which may not be connected at all.
  //
  // Second, and less obvious: if we cannot record the ask, we must not simply log and move
  // on. The pump treats an `onEvent` hook throw as non-fatal (correctly — one bad event must
  // not kill the stream), so a failed insert would leave the worker parked forever with
  // nothing in the database to show why. The fallback is therefore to DENY the request, which
  // at least returns control to the worker with a readable reason.

  /**
   * One line describing what is being asked, for a list view or a badge. Kept short on
   * purpose: the full structure is in `payload_json`, and a question's own text is usually
   * better than anything we could synthesise from it.
   */
  function summariseApprovalRequest(event) {
    if (event.requiresUserInteraction) {
      const questions = event.input?.questions ?? [];
      if (questions.length === 1) return questions[0].question;
      if (questions.length > 1) return `${questions.length} questions: ${questions.map((q) => q.header ?? q.question).join("; ")}`;
      return `${event.displayName ?? event.toolName} needs an answer`;
    }
    // `description` is the harness's own one-liner for the call (a URL for WebFetch, a
    // command for Bash) and is what a human actually needs to see.
    return event.description ? `${event.toolName}: ${event.description}` : `${event.toolName} requires approval`;
  }

  /**
   * The minimum an `approval.request` event must carry to be actionable.
   *
   * Added after review, and it is not defensive boilerplate — it is a real cross-adapter bug.
   * `adapters/opencode/adapter.js` ALREADY emits `type: 'approval.request'`, with a completely
   * different shape (`approvalID`, `permission`, `patterns`, `tool` — no `requestId`, no
   * `toolName`, no `input`), and its own config sets bash/edit/write to "ask", so this is its
   * default behaviour rather than an edge case. Without this check an OpenCode permission event
   * produced an ask row reading "undefined requires approval" with `harness_request_id = NULL` —
   * and because the unique guard is partial (`WHERE harness_request_id IS NOT NULL`), every
   * repeat of that event inserted ANOTHER row. This is Group 4's finding B4 again: two adapters
   * silently diverged on an event contract and the supervisor read one shape against both.
   */
  function approvalRequestProblem(event) {
    if (typeof event.requestId !== "string" || event.requestId.length === 0) {
      return "no string `requestId` — nothing to correlate an answer back to";
    }
    if (typeof event.toolName !== "string" || event.toolName.length === 0) {
      return "no string `toolName` — a human cannot be asked to approve an unnamed call";
    }
    if (event.requiresUserInteraction && !Array.isArray(event.input?.questions)) {
      return "`requiresUserInteraction` with no `input.questions` array — there is nothing to answer";
    }
    return null;
  }

  /**
   * Is this request STILL parked on the adapter?
   *
   * Found while writing the regression test for generation reuse, and not by any reviewer: after
   * `resume()`, `pump.resetRun()` + `attach()` starts a fresh `observe()`, and the adapters' own
   * `observe()` implementations yield from the beginning of their buffered event log. So the whole
   * event history is REPLAYED — including `approval.request` events for requests that were
   * answered generations ago. Recording those again produced phantom asks: a resumed run showed
   * up as blocked on tool calls that had long since run, and because the generation was read from
   * the run row rather than the event, they were stamped with the CURRENT generation, which
   * defeated the pinning that the same review had just asked us to strengthen.
   *
   * The honest test is not "have I seen this event before" but "is a worker actually waiting":
   * an ask exists to unblock a parked request, so if nothing is parked there is nothing to ask.
   * That also covers the ordinary case of an answer landing between the event being emitted and
   * this hook running.
   */
  function stillParked(runId, event) {
    try {
      const { adapter } = routeOrThrow(runId);
      if (typeof adapter.pendingApprovals !== "function") return true; // cannot tell; assume live
      return adapter.pendingApprovals(runId).some(
        (p) => p.requestId === event.requestId && (event.generation == null || p.generation === event.generation),
      );
    } catch {
      // Unroutable or unknown to the adapter: nothing is parked that we could unblock.
      return false;
    }
  }

  /**
   * The ask/task lifecycle wiring `codexdoc/REVIEW-NOTES.md` finding 16 found missing:
   * `domain/task-states.js`'s `autoBlockTarget` was built and tested in isolation, but nothing in
   * this file ever called it — a task could sit in `implementing` with a real open ask, or in
   * `blocked` with nothing left open, forever, because "entered automatically when an ask is
   * created, clears automatically when answered" (PLAN.md section 6) was a sentence, not a wire.
   *
   * Two hooks below, not one: opening an ask names its OWN task (from the event that just parked),
   * so that side calls `recordTransition` directly. Closing an ask can happen from several different
   * places (`answerAsk`, `closeOpenAsksForRun`'s two call sites, the grace-expiry sweep,
   * `withdrawApprovalAsk`), and "was this the LAST open ask for the task" is cheaper and more
   * robust to answer by RE-QUERYING current state than by threading a running tally through every
   * one of them — `blocked` tasks are rare, so a full scan of just that set after any closure is
   * effectively free.
   */
  function anyOpenAskForTask(taskId) {
    if (!taskId) return false;
    return !!database.prepare(`SELECT 1 FROM asks WHERE task_id = ? AND resolved = 0 LIMIT 1`).get(taskId);
  }

  /** Called once, right after an ask row is actually created — the one place that already knows
   *  exactly which task just gained an open ask. */
  function syncBlockedOnAskOpened(taskId) {
    if (!taskId) return;
    const task = database.prepare(`SELECT state FROM tasks WHERE id = ?`).get(taskId);
    if (!task) return;
    const target = autoBlockTarget(task.state, { askOpen: true });
    if (!target) return;
    try {
      recordTransition(database, {
        id: `tr-autoblock-${taskId}-${Date.now()}`, taskId, fromState: task.state, toState: target,
        actor: "supervisor:ask", askOpen: true,
      });
    } catch (err) {
      // Best-effort: a legality/staleness refusal just means the task already moved on (a human
      // transitioned it in the same instant) — not fatal to the ask-recording path that triggered this.
      logger.warn?.(`[supervisor] syncBlockedOnAskOpened(${taskId}): ${err.message}`);
    }
  }

  /** Called after ANY ask-closing operation. Re-checks every currently-`blocked` task rather than
   *  trusting the caller to know whether IT was the last open ask. */
  function reconcileAutoBlockedTasks() {
    const blocked = database.prepare(`SELECT id, state FROM tasks WHERE state = 'blocked'`).all();
    for (const t of blocked) {
      const askOpen = anyOpenAskForTask(t.id);
      const target = autoBlockTarget(t.state, { askOpen });
      if (!target) continue;
      try {
        recordTransition(database, {
          id: `tr-autounblock-${t.id}-${Date.now()}`, taskId: t.id, fromState: t.state, toState: target,
          actor: "supervisor:ask", askOpen,
        });
      } catch (err) {
        logger.warn?.(`[supervisor] reconcileAutoBlockedTasks(${t.id}): ${err.message}`);
      }
    }
  }

  /** Turn a live parked harness request into an `asks` row. */
  function recordApprovalAsk(runId, event) {
    const run = getRun(database, runId);
    const askId = `ask_${randomUUID()}`;

    const problem = approvalRequestProblem(event);
    if (problem) {
      // Refuse loudly rather than writing an unanswerable row. Denying is not possible either
      // (there is no id to deny), so the honest outcome is a loud log: the alternative is a
      // database full of rows that describe nothing.
      logger.error?.(
        `[supervisor] refusing to record an approval.request from run ${runId}: ${problem}. The adapter's event contract is wrong; see supervisor/adapters/FINDINGS.md.`,
      );
      return null;
    }

    if (!stillParked(runId, event)) {
      // A replay (see stillParked) or an already-settled request. Writing a row here would show a
      // worker as blocked on something it is not blocked on.
      return null;
    }

    const taskId = taskIdForRun(database, runId);
    try {
      createAsk(database, {
        id: askId,
        runId,
        taskId,
        // The wire tells these apart by `requires_user_interaction`, so we record the
        // distinction the harness makes rather than inventing one of our own.
        kind: event.requiresUserInteraction ? "question" : "tool-approval",
        question: summariseApprovalRequest(event),
        payload: {
          toolName: event.toolName,
          displayName: event.displayName,
          description: event.description,
          input: event.input,
          // Passed through verbatim: this is the harness's "always allow this rule" offer in
          // its own vocabulary, and a UI that wants to show that option needs it unaltered.
          suggestions: event.suggestions,
          requiresUserInteraction: event.requiresUserInteraction,
        },
        harnessRequestId: event.requestId,
        harnessToolUseId: event.toolUseId,
        // From the EVENT, not the run row: the adapter stamps the generation of the process that
        // actually parked the request. Reading the run row instead meant a replayed event was
        // labelled with whatever generation happened to be current when it was re-processed.
        generation: event.generation ?? run?.generation ?? null,
        graceMs: askGraceMs,
      });
      logger.log?.(`[supervisor] run ${runId} is blocked on ${event.toolName} (ask ${askId})`);
      syncBlockedOnAskOpened(taskId);
      return askId;
    } catch (err) {
      // A UNIQUE violation usually means the pump re-delivered an event we have already
      // recorded — its contract is "eviction is never silent", not "delivery is exactly once" —
      // and that is a no-op rather than a failure.
      //
      // But it is only a no-op if the row it collided with is REALLY this request: both reviewers
      // found that a blanket swallow left a worker parked forever the moment a request id was
      // reused. The index is now keyed by generation too, so a collision means a genuine repeat;
      // this checks that rather than assuming it, and falls through to the deny path when the
      // existing row is something else.
      if (/UNIQUE/i.test(String(err?.message))) {
        const existing = database
          .prepare(`SELECT id, resolved FROM asks WHERE run_id = ? AND harness_request_id = ? AND generation IS ?`)
          .get(runId, event.requestId, event.generation ?? run?.generation ?? null);
        if (existing) return existing.id;
        logger.error?.(
          `[supervisor] run ${runId}'s parked request ${event.requestId} collided with an ask row that is not its own; treating as unrecordable`,
        );
      }

      logger.error?.(
        `[supervisor] could not record the ask for run ${runId}'s parked request ${event.requestId} (${err.message}); denying it so the worker is not stuck forever`,
      );
      try {
        const { adapter } = routeOrThrow(runId);
        // Not awaited: this hook is synchronous from the pump's point of view and the deny is a
        // best-effort last resort. The rejection is handled so a failed deny cannot become an
        // unhandled rejection and take the daemon down (findings B7/B8).
        Promise.resolve(
          adapter.answerApproval?.(runId, event.requestId, {
            behavior: "deny",
            message: "The dashboard could not record this request, so it was refused rather than left waiting. Nothing is wrong with the request itself.",
          }),
        ).catch((denyErr) => {
          logger.error?.(`[supervisor] and the fallback deny also failed for run ${runId} (${denyErr.message}); this worker is parked`);
        });
      } catch (denyErr) {
        logger.error?.(`[supervisor] and the fallback deny also failed for run ${runId} (${denyErr.message}); this worker is parked`);
      }
      return null;
    }
  }

  /** The harness withdrew a request (turn interrupted, or another client answered it). */
  function withdrawApprovalAsk(runId, event) {
    // Deliberately NOT filtered to `resolved = 0`. The whole race both reviewers found is that a
    // human can answer in the window between the harness cancelling and this hook running, so the
    // row we need to settle is often already resolved — and `withdrawAsk` is what knows the
    // difference: it withdraws an open ask, and abandons the *delivery* of an answered one whose
    // request no longer exists. Filtering first meant the answered case never reached it and the
    // row was retried on every boot forever. Newest row first, because a reused request id can
    // legitimately have one row per generation.
    const row = database
      .prepare(
        `SELECT id FROM asks WHERE run_id = ? AND harness_request_id = ?
          ORDER BY resolved ASC, created_at DESC LIMIT 1`,
      )
      .get(runId, event.requestId);
    if (!row) return;
    const reason = event.reason ?? "harness-withdrew";
    const changed = withdrawAsk(database, row.id, { reason });
    if (changed > 0) {
      logger.log?.(`[supervisor] ask ${row.id} was withdrawn by the harness (${reason})`);
      reconcileAutoBlockedTasks();
    }
  }

  /**
   * The pump's per-event hook. Only approval traffic is acted on here; everything else is
   * already persisted by the pump itself.
   */
  function onEventHook(runId) {
    return (event) => {
      if (event?.type === "approval.request") recordApprovalAsk(runId, event);
      else if (event?.type === "approval.withdrawn") withdrawApprovalAsk(runId, event);
      else if (event?.type === "turn.end") {
        writeTurnDigest(runId);
        // Rule 5, Phase 8: "always" (the four utility-runner roles) fires here, once per turn — not
        // assumed satisfied by "a utility run is one-shot", because nothing in this runtime actually
        // stops an operator from `resume()`ing or sending a second turn to one (verified: no such
        // restriction exists before writing this). Fire-and-forget, same convention as
        // `writeTurnDigest`'s own unawaited call just above.
        applyClearPolicyForRun(runId, "turn-end")
          .catch((err) => logger.warn?.(`[supervisor] clear-policy: turn-end for run ${runId} failed (non-fatal): ${err.message}`));
      }
    };
  }

  // ── tier 2: one digest per turn (PLAN.md section 8, Rule 4) ─────────────────────────
  //
  // Written at `turn.end`, ≤150 tokens, read by a resumed worker "for current state only" — and by
  // tier 3, whose `Assumptions` section has been empty since it was built precisely because this tier
  // did not exist (FINDINGS §24).

  /**
   * Digest the turn that just ended.
   *
   * NOT AWAITED by the caller, and that is deliberate: this runs inside the pump's `onEvent` hook, which
   * is synchronous from the pump's point of view, and a digester that talks to a model would otherwise
   * stall the one consumer that keeps `event_log` growing. The pump treats a hook throw as non-fatal,
   * but "non-fatal" is not a reason to hand it a rejected promise, so every failure is caught here.
   *
   * A FAILED DIGEST IS NEVER FATAL TO THE RUN. Tier 2 is a convenience for whoever reads the run later;
   * losing one is a worse handoff, and losing the run would be a worse outcome by a wide margin.
   */
  function writeTurnDigest(runId) {
    if (!digestTurns) return;
    Promise.resolve()
      .then(async () => {
        // The turn is read back from `event_log` rather than accumulated in memory, so a digest written
        // after a `resume()` sees the same history any other reader would — the pump replays from the
        // start of the adapter's buffered log, so an in-memory accumulator would double-count.
        const rows = database
          .prepare(`SELECT type, payload_json FROM event_log WHERE run_id = ? AND tier = 1 ORDER BY seq`)
          .all(runId)
          .map((r) => ({ type: r.type, payload: r.payload_json ? JSON.parse(r.payload_json) : {} }));

        const { splitTurns, turnKey } = await import("../domain/turn-digest.js");
        const turns = splitTurns(rows);
        if (!turns.length) return;

        // Only the turn that just ended, and only if it has no digest yet. Idempotent on BOTH keys,
        // because they catch different repeats and neither is enough alone:
        //
        //   * `turnIndex` catches `turn.end` being seen twice against the same log (the cheap case).
        //   * `turnKey` catches a REPLAY, where the index has moved: after a `resume()` the pump
        //     re-persists the whole buffered log (§18: "anything reading the pump's stream must assume
        //     replay"), so one real turn occupies two slices and an index-only check digests it again.
        //     The duplicate would then reach tier 3 as a second worker stating the same assumption.
        const turnIndex = turns.length - 1;
        const key = turnKey(turns[turnIndex]);
        const already = listTurnDigests(database, runId, { limit: 200 })
          .some((d) => d.turnKey === key || d.turnIndex === turnIndex);
        if (already) return;

        const digest = await digester(turns[turnIndex], { budgetChars: DIGEST_BUDGET_CHARS });
        recordEvent(database, {
          runId,
          tier: 2,
          type: "turn.digest",
          payload: {
            turnIndex,
            turnKey: key,
            summary: digest.summary,
            assumptions: digest.assumptions ?? [],
            source: digest.source ?? "unknown",
          },
        });
      })
      .catch((err) => {
        logger.warn?.(`[supervisor] tier-2 digest failed for run ${runId} (non-fatal): ${err.message}`);
      });
  }

  /** A run's tier-2 digests, oldest first — what a resumed worker is handed. */
  function turnDigests(runId, opts) {
    return listTurnDigests(database, runId, opts ?? {});
  }

  /**
   * Hand an answered ask to the harness that is waiting for it.
   *
   * Separate from `answerAsk` because the two can fail independently and only one of them is
   * allowed to lose data: the answer is already durable by the time this runs, so a failure
   * here is recorded against the row (`delivery_error`) and the row STAYS in the redelivery
   * queue rather than being marked delivered. An undelivered answer recorded as delivered
   * would leave a worker parked while the dashboard shows the question resolved.
   */
  async function deliverAnswer(ask) {
    if (!ask.harness_request_id) return { delivered: false, reason: "nothing was parked on this ask" };

    // Only a real decision is deliverable. A supervisor close (`closed`) or a harness withdrawal
    // (`withdrawn`) must never reach a harness: the old code mapped every decision that was not
    // exactly "deny" to an ALLOW, so a reconciled orphan's closed asks would have handed a parked
    // worker an approval nobody gave. `listUndeliveredAnswers` filters these out too; this is the
    // second gate, because the function is also called directly by `answerAsk`.
    if (!["allow", "deny", "answered"].includes(ask.decision)) {
      const reason = `ask ${ask.id} has decision "${ask.decision}", which is not a deliverable answer`;
      markAskDelivered(database, ask.id, { error: reason, abandon: true });
      return { delivered: false, reason };
    }

    const abandon = (reason) => {
      markAskDelivered(database, ask.id, { error: reason, abandon: true });
      logger.warn?.(`[supervisor] ask ${ask.id} can never be delivered (${reason}); giving up rather than retrying forever`);
      return { delivered: false, reason, abandoned: true };
    };

    let adapter;
    try {
      ({ adapter } = routeOrThrow(ask.run_id));
    } catch (err) {
      // An unroutable run is not going to become routable: the row would otherwise be retried on
      // every boot for the lifetime of the database.
      return abandon(err.message);
    }
    if (typeof adapter.answerApproval !== "function") {
      return abandon(`the adapter for run ${ask.run_id} cannot answer parked requests`);
    }

    const decision = ask.decision === "deny"
      ? { behavior: "deny", message: ask.answer || "Denied by the dashboard operator." }
      : {
          behavior: "allow",
          // A question is answered by allowing the tool call with the answers folded into its
          // input — measured; a bare `allow` runs it with no answers and the model is told
          // "The user did not answer the questions."
          ...(ask.kind === "question" ? { updatedInput: buildAnsweredInput(ask) } : {}),
        };

    try {
      // Awaited: the adapter resolves only once the write was accepted by the pipe, and any
      // adapter whose answer is a network call (OpenCode's will be) is a promise. Not awaiting
      // would stamp `delivered_at` for a delivery still in flight and swallow its rejection.
      await adapter.answerApproval(ask.run_id, ask.harness_request_id, decision, {
        // The authorization check: the answer was recorded against this generation, and the
        // adapter refuses if the parked request belongs to a different one.
        expectGeneration: ask.generation,
      });
      markAskDelivered(database, ask.id);
      return { delivered: true, behavior: decision.behavior };
    } catch (err) {
      // `permanent` is set by the adapter for "there is no such parked request", "it belongs to a
      // replaced process", and "that decision is malformed" — none of which a retry can fix.
      if (err?.permanent) return abandon(err.message);
      markAskDelivered(database, ask.id, { error: err.message });
      logger.warn?.(`[supervisor] ask ${ask.id} was answered but could not be delivered (${err.message}); it stays in the redelivery queue`);
      return { delivered: false, reason: err.message };
    }
  }

  /** The original tool input with the human's answers folded in, as the harness expects. */
  function buildAnsweredInput(ask) {
    // `parseJsonColumn` never throws. The old unguarded parse ran BEFORE the delivery try/catch,
    // so malformed JSON in a column threw after the answer was already persisted — leaving the row
    // resolved, undelivered, and with no recorded failure — and boot's redelivery loop had no
    // per-row guard, so one such row could reject boot and strand every other answer.
    const payload = parseJsonColumn(ask.payload_json, {});
    const answers = parseJsonColumn(ask.answer_json, {});
    const input = payload && typeof payload.input === "object" && payload.input !== null ? payload.input : {};
    return { ...input, answers };
  }

  /**
   * Why a proposed answer is not a valid answer to THIS ask, or null.
   *
   * A question is only answered if the answers are keyed by the exact question text — measured:
   * anything else and the model is told "The user did not answer the questions" while the row
   * claims delivered. Both reviewers found that the old check (`answers && typeof answers ===
   * "object"`) accepted an array, an empty object, or keys belonging to some other question, and
   * that prose or a bare `allow` produced `updatedInput.answers = {}`.
   */
  function answerShapeProblem(ask, { allow, answers }) {
    if (ask.kind !== "question") return null;
    // Denying a question is always legitimate: it is how an operator dismisses one.
    if (allow === false) return null;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      return "a question needs `answers`: an object keyed by the exact question text (or `allow: false` to decline it)";
    }
    const keys = Object.keys(answers);
    if (keys.length === 0) return "`answers` is empty — that would tell the worker nobody answered";

    const payload = parseJsonColumn(ask.payload_json, {});
    const asked = (payload.input?.questions ?? []).map((q) => q?.question).filter((q) => typeof q === "string");
    // A redacted payload (a resolved ask whose input has been reduced) has no questions to check
    // against; there is nothing to validate, and refusing would be worse than allowing it through.
    if (asked.length === 0) return null;
    const unknown = keys.filter((k) => !asked.includes(k));
    if (unknown.length > 0) {
      return `\`answers\` has ${unknown.length} key(s) that were never asked (${unknown.slice(0, 3).map((k) => JSON.stringify(k)).join(", ")}); keys must match the question text exactly`;
    }
    const unanswered = asked.filter((q) => !keys.includes(q));
    if (unanswered.length > 0) {
      return `${unanswered.length} of ${asked.length} question(s) unanswered (${unanswered.slice(0, 3).map((q) => JSON.stringify(q)).join(", ")})`;
    }
    return null;
  }

  /**
   * Answer an ask, then deliver it. In that order, and that ordering is the requirement:
   * PLAN.md section 7 — "persists the answer *before* marking resolved (ordering matters — a
   * crash between those two steps must not lose the answer)".
   *
   * `allow` (boolean) decides a tool approval; `answers` (a map of question text to chosen
   * option label) answers a question. A tool approval answered with neither is refused rather
   * than guessed at — defaulting a missing approval to "allow" is exactly the failure mode
   * this whole control plane exists to prevent.
   */
  async function answerAsk(askId, { allow, answers, answer, answeredBy = "human" } = {}) {
    const ask = getAsk(database, askId);
    if (!ask) throw new Error(`unknown askId: ${askId}`);
    if (ask.resolved) {
      return { askId, answered: false, reason: `ask ${askId} is already resolved (${ask.answered_by ?? "unknown"})`, delivered: false };
    }

    let decision;
    let answerText = answer ?? null;
    let answerJson;
    if (ask.kind === "tool-approval") {
      if (typeof allow !== "boolean") {
        throw new Error(`answerAsk: ask ${askId} is a tool approval and needs an explicit boolean \`allow\``);
      }
      decision = allow ? "allow" : "deny";
      answerText = answerText ?? (allow ? "[allowed by the dashboard operator]" : "Denied by the dashboard operator.");
    } else {
      // A question. Validated BEFORE anything is written: an invalid answer that got persisted
      // would resolve the ask and then be "delivered" as an allow carrying nothing, which reads
      // to the worker as a human who ignored it.
      const problem = answerShapeProblem(ask, { allow, answers });
      if (problem) throw new Error(`answerAsk: ask ${askId} cannot be answered — ${problem}`);
      if (allow === false) {
        decision = "deny";
        answerText = answerText ?? "Declined by the dashboard operator.";
      } else {
        decision = "answered";
        answerJson = answers;
        answerText = answerText ?? Object.entries(answers).map(([q, a]) => `${q} => ${a}`).join("; ");
      }
    }

    const changed = answerAskRow(database, askId, { answer: answerText, answeredBy, decision, answerJson });
    if (changed !== 1) {
      // Lost a race with the sweep or another answerer. Theirs stands — the `resolved = 0`
      // guard is what makes "an answer during the grace wins" mean anything.
      const now = getAsk(database, askId);
      return { askId, answered: false, reason: `ask ${askId} was resolved by ${now?.answered_by ?? "someone else"} first`, delivered: false };
    }
    reconcileAutoBlockedTasks();

    const delivery = await deliverAnswer(getAsk(database, askId));
    // Only once the payload is no longer needed for delivery: `buildAnsweredInput` reads
    // `payload.input`, so reducing it any earlier would send the harness an empty tool input.
    redactResolvedAskPayload(database, askId);
    return { askId, answered: true, decision, ...delivery };
  }

  /**
   * Redeliver answers that are durable but never reached a harness. Called on boot.
   *
   * After a supervisor restart most of these will fail, and that is correct rather than
   * disappointing: the child was spawned by the dead supervisor, so its stdio went with it and
   * nobody can answer its parked request any more. The failure is recorded, the run gets
   * classified as an orphan by reconciliation, and closing an orphan's asks (0003) settles the
   * row. What this loop exists for is the narrower case that IS recoverable — the answer was
   * written, delivery threw transiently, and the process is still ours.
   */
  async function deliverPendingAnswers() {
    const pending = listUndeliveredAnswers(database);
    let delivered = 0;
    let abandoned = 0;
    for (const ask of pending) {
      // Per-row guard. `boot()` calls this unguarded, so without it one row that throws for a
      // reason nothing anticipated would reject boot and strand every other pending answer —
      // the blast radius the consolidated review rated severe even while judging the trigger
      // unlikely. A redelivery loop is precisely where "unlikely" rows accumulate.
      try {
        const result = await deliverAnswer(ask);
        if (result.delivered) delivered += 1;
        if (result.abandoned) abandoned += 1;
      } catch (err) {
        abandoned += 1;
        markAskDelivered(database, ask.id, { error: `redelivery threw: ${err.message}`, abandon: true });
        logger.warn?.(`[supervisor] redelivery of ask ${ask.id} threw (${err.message}); abandoned so it cannot block the queue`);
      }
    }
    if (pending.length > 0) {
      logger.log?.(
        `[supervisor] redelivery: ${delivered} of ${pending.length} previously undelivered answer(s) reached their harness, ${abandoned} abandoned`,
      );
    }
    return { attempted: pending.length, delivered, abandoned };
  }

  /** Close every ask whose grace has expired. Called on boot and on a timer. */
  function sweepAsks() {
    try {
      const closed = sweepExpiredAsks(database);
      if (closed > 0) {
        logger.log?.(`[supervisor] auto-closed ${closed} ask(s) whose grace period expired`);
        reconcileAutoBlockedTasks();
      }
      return closed;
    } catch (err) {
      // A sweep that throws must never take the daemon down — it is bookkeeping on a timer.
      logger.warn?.(`[supervisor] ask sweep failed (non-fatal): ${err.message}`);
      return 0;
    }
  }

  /** Release every resource lease whose TTL expired without a renewal (PLAN.md §20). Same shape as
   *  `sweepAsks`, called from the same boot/timer sites rather than a second mechanism. */
  function sweepLeases() {
    try {
      const released = sweepExpiredLeases(database);
      if (released > 0) logger.log?.(`[supervisor] released ${released} resource lease(s) whose TTL expired unrenewed`);
      return released;
    } catch (err) {
      logger.warn?.(`[supervisor] lease sweep failed (non-fatal): ${err.message}`);
      return 0;
    }
  }

  let askSweepTimer = null;

  /**
   * runId -> the exit_reason a deliberate operation intends to write, held only for the
   * duration of that operation. Cleared when the operation completes without ending the
   * run, so a run that survives a refused reap and finishes naturally later is still
   * booked with its own derived reason.
   */
  const terminalIntent = new Map();

  async function withTerminalIntent(runId, reason, fn) {
    // Save/restore rather than set/delete: these nest. `reap()` holds "reaped" while, on
    // the shared-process-group path, it ends just this session through the adapter — an
    // inner "stopped" that must not clear the outer intent when it returns.
    const had = terminalIntent.has(runId);
    const previous = terminalIntent.get(runId);
    terminalIntent.set(runId, reason);
    try {
      return await fn();
    } finally {
      if (had) terminalIntent.set(runId, previous);
      else terminalIntent.delete(runId);
    }
  }

  /**
   * Attach to every pooled MCP server a `role` declares (`ROLE_MCP_NEEDS`), and build the real
   * `spec.mcpConfig`-shaped `{ mcpServers }` object for whichever of them the current harness can
   * actually be handed (`canDeliverMcpConfig`) — extracted from `start()` (review-consolidated-
   * 2026-09-14.md finding 2) so `resume()` can call the exact same logic for a NEW generation, rather
   * than replaying whatever `spec.mcpConfig` generation 1 happened to have (which, by the time a
   * resume happens, names a socket `detach()` has already torn down and removed).
   *
   * review-consolidated-2026-09-14.md finding 1: every entry this builds also carries `--allow-tools`,
   * bounding the pooled server's tool surface to exactly what `ROLE_MCP_TOOL_ALLOWLIST` declares for
   * this role — attaching to a pool no longer means reaching its ENTIRE tool surface.
   *
   * `undeliveredNeeds` (finding 4) names every declared need that did NOT end up with a real,
   * deliverable `mcpServersForConfig` entry — no registered pool config, the attach itself throwing, or
   * `canDeliverMcpConfig` being false. `start()`/`resume()` use this to decide whether to refuse rather
   * than silently hand a role no tool at all.
   */
  async function attachMcpPoolsForRole(role, { principalId, canDeliverMcpConfig, harnessId, workerId } = {}) {
    const mcpAttachmentIds = [];
    const mcpServersForConfig = {};
    const undeliveredNeeds = [];
    const declaredMcpNeeds = ROLE_MCP_NEEDS[role] ?? [];
    if (!declaredMcpNeeds.length) return { mcpAttachmentIds, mcpServersForConfig, undeliveredNeeds };
    const registeredConfigs = {};
    for (const name of declaredMcpNeeds) {
      if (poolConfigFor(name, { stateDir: stateDirOf() })) registeredConfigs[name] = name;
    }
    const manifest = manifestForRole(role, { registeredConfigs });
    if (manifest.missing.length) {
      logger.warn?.(`[supervisor] role "${role}" declares MCP need(s) [${manifest.missing.join(", ")}] with no registered pool config`);
      undeliveredNeeds.push(...manifest.missing);
    }
    for (const poolName of manifest.pools) {
      const poolConfig = poolConfigFor(poolName, { stateDir: stateDirOf() });
      if (!poolConfig) continue; // already warned + recorded above via `manifest.missing`
      try {
        const attached = await mcpPool.attach(poolName, poolConfig, { principalId: principalId ?? null, runId: null });
        mcpAttachmentIds.push(attached.attachmentId);
        if (canDeliverMcpConfig && attached.socketPath) {
          const allowedTools = ROLE_MCP_TOOL_ALLOWLIST[role] ?? [];
          const args = [MCP_STDIO_PROXY_PATH, "--socket", attached.socketPath];
          if (allowedTools.length) args.push("--allow-tools", allowedTools.join(","));
          mcpServersForConfig[poolName] = { command: process.execPath, args };
        } else {
          if (!canDeliverMcpConfig) {
            logger.warn?.(`[supervisor] harness ${harnessId} cannot deliver an mcpConfig (mcpConfigDelivery: false) — run for ${workerId} attaches to pool "${poolName}" for bookkeeping only, with no usable tool`);
          }
          undeliveredNeeds.push(poolName);
        }
      } catch (err) {
        // Non-fatal at the ATTACH level — a run that can't attach still gets a chance to start/resume
        // in degraded mode if the caller opts in; `start()`/`resume()` decide whether that's allowed.
        logger.warn?.(`[supervisor] run for ${workerId} could not attach to mcp pool "${poolName}": ${err.message}`);
        undeliveredNeeds.push(poolName);
      }
    }
    return { mcpAttachmentIds, mcpServersForConfig, undeliveredNeeds };
  }

  async function start({ harnessId, workerId, spec }) {
    if (!harnessId) throw new Error("start: harnessId is required");
    if (!workerId) throw new Error("start: workerId is required");
    if (!spec?.cwd) throw new Error("start: spec.cwd is required");
    const adapter = adapterFor(harnessId);

    // The worker's principal token, delivered by the one channel the supervisor controls: the child's
    // environment. This is what makes a worker's requests attributable at all — and its limit is stated in the
    // authorization block above, because an env var is inherited by descendants.
    let workerPrincipal = null;
    let principalDelivery = "none";
    try {
      // `rotate: true`: this is a NEW run, so it needs a working credential even when the identity already
      // exists.
      const ensured = ensureWorkerPrincipal(workerId, { rotate: true });
      workerPrincipal = ensured.principal;
      // DELIVERY DEPENDS ON A DECLARED CAPABILITY, which is what the matrix is for. An environment belongs to a
      // PROCESS, so a `pooled` harness — one `opencode serve` shared by every run in a cwd — cannot be handed a
      // per-run credential this way: the second run would inherit the first one's. The same constraint the
      // worker-environment work hit (adapters/FINDINGS.md), and the reason `residentProcess` carries its value
      // as a string rather than a boolean.
      const resident = adapter.capabilities?.()?.residentProcess ?? "per-run";
      if (ensured.token && resident === "pooled") {
        principalDelivery = "undeliverable-pooled";
        logger.warn?.(
          `[supervisor] harness ${harnessId} is pooled (residentProcess: pooled), so run ${workerId}'s principal `
          + `${ensured.principal.id} cannot be delivered in a per-run environment — it exists for attribution, `
          + "and that worker cannot authenticate callbacks until a per-run channel exists",
        );
      } else if (ensured.token) {
        spec = { ...spec, env: { ...(spec.env ?? {}), CTD_PRINCIPAL_TOKEN: ensured.token } };
        principalDelivery = "env";
      } else {
        // Reached only when rotation itself failed (a principal revoked between the read and the update), so the
        // run proceeds with an identity and no credential — logged, because that worker's callbacks will be
        // refused and the reason should not have to be guessed.
        principalDelivery = "no-credential";
        logger.warn?.(`[supervisor] run for ${workerId} has a principal but no fresh token; its callbacks will be refused`);
      }
    } catch (err) {
      // Non-fatal: a run that cannot be given a principal can still be supervised, it just cannot call back.
      // Failing the start would make authorization a availability risk, which is the wrong trade for a local
      // tool — but it is logged, because a worker with no principal will be refused if it ever asks.
      logger.warn?.(`[supervisor] run for ${workerId} starts without a principal: ${err.message}`);
    }

    // PLAN.md §21.1/§21.2, wired 2026-09-11: a utility-task-lane role (§16.2) that declares an MCP need
    // (`domain/mcp-manifest.js`'s `ROLE_MCP_NEEDS`) attaches to its pooled server(s) BEFORE the adapter
    // spawns — the attach/detach LIFECYCLE bookkeeping is real and tested (`mcp-pool.js`,
    // `mcp-pool-wiring.test.js`).
    //
    // review-consolidated-2026-09-14.md finding 8: a preflight's whole design constraint is being cheap
    // and needing no MCP servers at all (`spec.isPreflight`'s own intent) — spawning/attaching a real
    // pooled process for one anyway paid its full teardown cost for nothing, AND did so with the host
    // approval round trip disabled (`approvalMode: 'off'`), the one configuration in the tree where a
    // delivered tool surface would have no approval prompt in front of it at all. Skip entirely.
    const workerRow = database.prepare(`SELECT role FROM workers WHERE worker_id = ?`).get(workerId);
    const mcpAttach = spec.isPreflight
      ? { mcpAttachmentIds: [], mcpServersForConfig: {}, undeliveredNeeds: [] }
      : await attachMcpPoolsForRole(workerRow?.role, {
        principalId: workerPrincipal?.id ?? null,
        canDeliverMcpConfig: adapter.capabilities?.()?.mcpConfigDelivery === "file-or-json-string",
        harnessId, workerId,
      });
    const mcpAttachmentIds = mcpAttach.mcpAttachmentIds;
    // review-consolidated-2026-09-14.md finding 4: a role with a declared MCP need used to start
    // completely normally even when that need went entirely undelivered — the worker's own instructions
    // still told it to use the tool, silently. FAIL CLOSED BY DEFAULT (owner decision, 2026-09-14):
    // refuse before ever spawning the adapter's process, unless the caller explicitly opts into the
    // degraded run with `spec.allowDegradedMcp: true`. Whatever DID attach must still be detached —
    // nothing here should be left resident for a run that never starts.
    if (mcpAttach.undeliveredNeeds.length && !spec.allowDegradedMcp) {
      for (const attachmentId of mcpAttachmentIds) {
        mcpPool.detach(attachmentId).catch((detachErr) => {
          logger.warn?.(`[supervisor] mcp-pool detach ${attachmentId} after refusing undelivered-MCP start for ${workerId} failed (best-effort): ${detachErr.message}`);
        });
      }
      throw new Error(
        `start: role "${workerRow?.role}" declares MCP need(s) [${mcpAttach.undeliveredNeeds.join(", ")}] that could `
        + "not be delivered — refusing rather than starting a tool-less run silently; pass "
        + "spec.allowDegradedMcp: true to start anyway with no tool for the undelivered need(s)",
      );
    }
    if (Object.keys(mcpAttach.mcpServersForConfig).length) {
      spec = { ...spec, mcpConfig: [...(spec.mcpConfig ? [].concat(spec.mcpConfig) : []), JSON.stringify({ mcpServers: mcpAttach.mcpServersForConfig })] };
    }

    // `mcpAttachmentIds` (if any) were made BEFORE this call, because the pooled config has to be in
    // `spec` at spawn time — so a throw HERE, not just a `createRun` failure afterward, must also
    // detach them. Before this fix there was no try/catch around this call at all: an adapter.start()
    // failure propagated straight out of `start()`, leaking every attachment made above with no run
    // ID for anything to ever clean them up by (`endRun`/reconciliation only look up attachments BY
    // run_id, and none exists yet at this point). Found in review
    // (`codexdoc/review-luna-2026-09-11.md` finding 4), fixed 2026-09-11.
    let runId;
    try {
      runId = await adapter.start(spec);
    } catch (err) {
      for (const attachmentId of mcpAttachmentIds) {
        mcpPool.detach(attachmentId).catch((detachErr) => {
          logger.warn?.(`[supervisor] mcp-pool detach ${attachmentId} after failed adapter.start() for ${workerId} failed (best-effort): ${detachErr.message}`);
        });
      }
      throw err;
    }
    // The child is ALIVE from here on, so every failure below has to kill it. Without this, a
    // persistence failure (e.g. an unknown `workerId` tripping the `runs.worker_id` foreign key)
    // left a running detached process with no row at all: not in `list()`, not routable by
    // `harnessOf`, invisible to reconciliation forever — the very orphan this module exists to
    // prevent, manufactured by an error path. Verified before fixing: `start()` rejected with
    // "FOREIGN KEY constraint failed" and the child was still running with no row.
    try {
      createRun(database, {
        runId,
        workerId,
        harnessId,
        prompt: spec.prompt,
        persistFullPrompt: spec.persistFullPrompt,
        // 0005 / PLAN.md 12.1. Marked at INSERT time, because a preflight that is SIGKILLed
        // before its cleanup has to be recognisable as one by the reconciliation that finds it.
        isPreflight: spec.isPreflight === true,
      });
    } catch (err) {
      logger.warn?.(`[supervisor] could not persist run ${runId} (${err.message}); killing the child rather than orphaning it`);
      // `mcp_pool_attachments.run_id` has a REAL foreign key to `runs.run_id` (migration 0013) — these
      // attachments were made with `run_id: NULL` and never backfilled (that happens below, only once
      // `createRun` has actually succeeded), so they must be detached by ID directly here, not via a
      // `WHERE run_id = ?` lookup that would find nothing.
      for (const attachmentId of mcpAttachmentIds) {
        mcpPool.detach(attachmentId).catch((detachErr) => {
          logger.warn?.(`[supervisor] mcp-pool detach ${attachmentId} after failed createRun for ${runId} failed (best-effort): ${detachErr.message}`);
        });
      }
      try {
        await adapter.stop(runId);
      } catch (stopErr) {
        // Nothing else can clean this up, so say so loudly rather than swallowing it.
        logger.error?.(`[supervisor] run ${runId} could not be persisted OR stopped (${stopErr.message}); a process may be leaked`);
      }
      throw err;
    }
    // Backfill now that `runs.run_id` actually exists — attaching had to happen BEFORE `adapter.start()`
    // returned a runId (the pooled config needs to be in `spec` at spawn time), and backfilling had to
    // wait until AFTER `createRun()` committed, or this UPDATE would itself violate the same foreign
    // key. See `setAttachmentRunId`'s own doc comment for the (accepted, sub-millisecond) crash window
    // between here and there.
    for (const attachmentId of mcpAttachmentIds) setAttachmentRunId(database, attachmentId, runId);
    harnessCache.set(runId, harnessId);

    pump.attach(runId, adapter.observe(runId), { onEvent: onEventHook(runId), onEnd: onEndHook(runId) });

    const identity = await persistIdentity(runId, adapter);
    return { runId, harnessId, identity, principalId: workerPrincipal?.id ?? null, principalDelivery };
  }

  async function stop(runId) {
    const { adapter } = routeOrThrow(runId);
    await withTerminalIntent(runId, "stopped", () => adapter.stop(runId));
    pump.closeRun(runId);
    // Routed through the same helper as every other terminal write, so a deliberately stopped
    // run closes its open asks instead of leaving them for nobody: before this, `stop` was the
    // one terminal path that touched `runs` and ignored `asks` entirely.
    // `endRun` is guarded (`WHERE ended_at IS NULL`); `changes === 0` means the run had
    // already ended, which is information, not an error.
    const closed = closeAndScheduleAsks(runId, "stopped");
    return { runId, closed: closed === 1 };
  }

  async function sendInput(runId, input) {
    const { adapter } = routeOrThrow(runId);
    await adapter.sendInput(runId, input);
    return { runId };
  }

  async function interrupt(runId) {
    const { adapter } = routeOrThrow(runId);
    await adapter.interrupt(runId);
    return { runId };
  }

  /**
   * clearContext / resume — Group 4 built the adapter surface; this is the routing Group 5
   * owes it. Both are routed through `harnessOf`, so both work on a run created before
   * this supervisor process existed.
   *
   * Neither is uniform across harnesses and this does not pretend otherwise (PLAN.md
   * section 4): Claude Code's clear mints a new session id, OpenCode's only summarizes.
   * The adapter's own ack is passed back verbatim rather than flattened into a boolean.
   */
  async function clearContext(runId) {
    const { harnessId, adapter } = routeOrThrow(runId);
    if (!adapter.clearContext) return { runId, harnessId, supported: false };
    const ack = await adapter.clearContext(runId);
    return { runId, harnessId, supported: true, ack };
  }

  /**
   * clearContext / resume — Group 4 built the adapter surface; this is the routing Group 5
   * owes it. Both are routed through `harnessOf`, so both work on a run created before
   * this supervisor process existed.
   *
   * Neither is uniform across harnesses and this does not pretend otherwise (PLAN.md
   * section 4): Claude Code's clear mints a new session id, OpenCode's only summarizes.
   * The adapter's own ack is passed back verbatim rather than flattened into a boolean.
   */
  async function clearContext(runId) {
    const { harnessId, adapter } = routeOrThrow(runId);
    if (!adapter.clearContext) return { runId, harnessId, supported: false };
    const ack = await adapter.clearContext(runId);
    return { runId, harnessId, supported: true, ack };
  }

  /**
   * resetSession(runId, { requestedAction, explicitKillConfirmed, respawnSpec }) — Phase 8, PLAN.md §7's
   * clean-vs-kill rule ENFORCED, not just declared: this is the one real call site
   * `domain/session-intent.js`'s pure decision was built for.
   *
   * `requestedAction: "kill-respawn"` without `explicitKillConfirmed: true` is refused down to a soft
   * clear — same "never infer destructive intent from a loose signal" guarantee §7's own prose states,
   * enforced structurally here rather than left as an unconsulted pure function.
   *
   * A respawn needs a NEW process, which needs a spec — this function does not attempt to reconstruct
   * one from the ended run's own history (a genuinely separate, harder problem: `runs` does not persist
   * the full original `spec`, only `prompt`). The caller must supply `respawnSpec: { harnessId, workerId,
   * spec }` for the kill-respawn path; a `clear` never needs one. Missing it on an authorized kill is a
   * caller error, refused rather than guessed at.
   */
  async function resetSession(runId, { requestedAction, explicitKillConfirmed, respawnSpec = null } = {}) {
    const decision = classifySessionAction({ requestedAction, explicitKillConfirmed });
    if (decision.action === "clear") {
      const result = await clearContext(runId);
      return { runId, action: "clear", ...(decision.refused ? { refused: decision.refused } : {}), result };
    }
    // decision.action === "kill-respawn", and only reachable with explicitKillConfirmed === true.
    if (!respawnSpec?.harnessId || !respawnSpec?.workerId || !respawnSpec?.spec) {
      throw new Error(
        "resetSession: an authorized kill-respawn requires respawnSpec: { harnessId, workerId, spec } — "
        + "this function does not reconstruct a respawn spec from the ended run's own history",
      );
    }
    const stopped = await stop(runId);
    const started = await start(respawnSpec);
    return { runId, action: "kill-respawn", stopped, started };
  }

  /**
   * PLAN.md §8 Rule 5 (Phase 8, item 39's remaining half) — resolve the `clearPolicy` that actually
   * applies to a worker's role on a task, via `config/harness-defaults.js`'s own `assignmentFor`.
   *
   * The CONFIG vocabulary (`reviewer1`/`reviewer2`/`parentReviewer`) is not quite the workflow-profile
   * vocabulary a `workers.role` row holds (`coder`/`reviewer`/`parentReviewer`) — `derivedSlotFor` (below,
   * in the review path) already solves exactly this translation, so this reuses the SAME
   * assignment-record-first, stable-nickname-order fallback rather than inventing a second mechanism.
   * (Unlike `derivedSlotFor`, this does NOT rename `parentReviewer` to `"parent"` — that rename is
   * §13's review-quorum vocabulary, not `harness-defaults.json`'s.)
   */
  function configSlotForWorker(taskId, worker) {
    const record = readAssignmentRecord(taskId);
    const assigned = record?.slots?.find((sl) => sl.workerId === worker.workerId)?.configSlot;
    if (assigned) return assigned;
    if (worker.role !== "reviewer") return worker.role;
    const reviewers = database
      .prepare(`SELECT worker_id AS workerId, nickname FROM workers WHERE task_id = ? AND role = 'reviewer'`)
      .all(taskId)
      .sort((a, b) => String(a.nickname ?? a.workerId).localeCompare(String(b.nickname ?? b.workerId)));
    const idx = reviewers.findIndex((r) => r.workerId === worker.workerId);
    return idx <= 0 ? "reviewer1" : `reviewer${idx + 1}`;
  }

  /**
   * Best-effort, non-fatal clear for one run — gated by `domain/clear-policy.js`'s pure decision and the
   * target adapter's own declared `capabilities().clearContext`. Never throws: matching the
   * `taskHandoff(...)` try/catch already sitting beside every real trigger call site this is invoked
   * from, a clearing failure must never fail the transition/verdict/turn it is attached to.
   */
  async function maybeClearRun(runId, { clearPolicy, trigger }) {
    try {
      const { adapter } = routeOrThrow(runId);
      const clearContextCapability = adapter.capabilities?.()?.clearContext ?? false;
      const decision = decideClear({ clearPolicy, trigger, clearContextCapability });
      if (!decision.clear) return { runId, cleared: false, reason: decision.reason };
      const result = await clearContext(runId);
      return { runId, cleared: true, result };
    } catch (err) {
      logger.warn?.(`[supervisor] clear-policy: could not clear run ${runId} (trigger "${trigger}"): ${err.message}`);
      return { runId, cleared: false, reason: err.message };
    }
  }

  /**
   * Apply `trigger` to every OPEN run belonging to a worker of one of `roles` on `taskId` — the function
   * every real trigger call site below calls, fire-and-forget (`.catch()`, never `await`ed from a
   * transition/verdict path), same "a background write must never block or fail the thing that triggered
   * it" convention `writeTurnDigest`/`mcpPool.detach(...).catch(...)` already use in this file.
   *
   * See `domain/clear-policy.js`'s own header for exactly which triggers this runtime raises and why the
   * others (a change-request round concluding, since `awaiting-review` -> `fixing` is not automatically
   * driven yet) are not wired here — this function does not guess at call sites that do not exist.
   */
  async function applyClearPolicy(taskId, { roles, trigger }) {
    const workers = database
      .prepare(`SELECT worker_id AS workerId, nickname, role FROM workers WHERE task_id = ?`)
      .all(taskId)
      .filter((w) => roles.includes(w.role));
    if (!workers.length) return [];
    const config = loadHarnessDefaults({ stateDir: stateDirOf() });
    const task = database.prepare(`SELECT team_id FROM tasks WHERE id = ?`).get(taskId);
    const results = [];
    for (const worker of workers) {
      const configSlot = configSlotForWorker(taskId, worker);
      const clearPolicy = assignmentFor(config, configSlot, { teamId: task?.team_id ?? null })?.clearPolicy;
      if (!clearPolicy) continue;
      const openRunIds = database
        .prepare(`SELECT run_id AS runId FROM runs WHERE worker_id = ? AND ended_at IS NULL`)
        .all(worker.workerId)
        .map((r) => r.runId);
      for (const runId of openRunIds) results.push(await maybeClearRun(runId, { clearPolicy, trigger }));
    }
    return results;
  }

  /**
   * The single-run shape `applyClearPolicy` doesn't fit: the "always" policy's real trigger
   * (`onEventHook`'s `turn.end`) already has a `runId` in hand and no reason to re-derive every OTHER
   * open run for that worker's task — `applyClearPolicy` is task-scoped because its own triggers
   * (`state-transition`/`review-round-concluded`) are task events with no run of their own to start
   * from. Same resolution chain (`configSlotForWorker` + `assignmentFor`), just entered from a run
   * instead of a task.
   */
  async function applyClearPolicyForRun(runId, trigger) {
    const workerId = workerIdForRun(database, runId);
    if (!workerId) return { runId, cleared: false, reason: "no worker found for this run" };
    const worker = database
      .prepare(`SELECT worker_id AS workerId, nickname, role, task_id AS taskId FROM workers WHERE worker_id = ?`)
      .get(workerId);
    if (!worker?.taskId) return { runId, cleared: false, reason: "worker has no task" };
    const config = loadHarnessDefaults({ stateDir: stateDirOf() });
    const task = database.prepare(`SELECT team_id FROM tasks WHERE id = ?`).get(worker.taskId);
    const configSlot = configSlotForWorker(worker.taskId, worker);
    const clearPolicy = assignmentFor(config, configSlot, { teamId: task?.team_id ?? null })?.clearPolicy;
    if (!clearPolicy) return { runId, cleared: false, reason: `no clearPolicy configured for slot "${configSlot}"` };
    return maybeClearRun(runId, { clearPolicy, trigger });
  }

  async function resume(runId, { allowDegradedMcp = false } = {}) {
    const { harnessId, adapter } = routeOrThrow(runId);
    // review-sol-2026-09-13.md finding 8's remaining half: `resume` had NO task-state awareness at all —
    // it would happily reopen a CLOSED run whose task is already terminal, putting a `merged`/`cancelled`
    // task back into "has an open run" with no coordination against `discardTaskWorktree`'s own
    // terminal-task-only-with-zero-open-runs invariant (and, worse, against a worktree that may already
    // have been discarded out from under it). `assignTask` already refuses a terminal task outright for
    // a NEW run (finding 13/luna); this closes the same door for reopening an OLD one. A run with no task
    // at all (a preflight, or a worker row that predates this join) is unaffected — there is no terminal
    // state to conflict with.
    const taskId = taskIdForRun(database, runId);
    if (taskId) {
      const task = database.prepare(`SELECT state FROM tasks WHERE id = ?`).get(taskId);
      if (task && isTerminal(task.state)) {
        return {
          ok: false, refused: "task-terminal",
          error: `run ${runId}'s task ${taskId} is "${task.state}" — resume refuses to reopen a run whose `
            + "task is already terminal; there is no reopen-task transition, so a resumed run here would be "
            + "invisible to every check that assumes a terminal task has no open runs",
        };
      }
    }
    if (!adapter.resume) return { runId, harnessId, resumed: false, result: "unsupported" };

    // review-consolidated-2026-09-14.md finding 2: `resume()` used to call `adapter.resume(runId)` with
    // nothing else — the adapter rebuilds its argv from the run's OWN captured `spec`, which for a
    // utility run still names the ORIGINAL generation's `--mcp-config`, pointing at a socket `detach()`
    // (called when the first generation's run ended) has already killed the server behind and removed
    // from disk. The resumed process's proxy would exit non-zero against a dead socket, silently leaving
    // the resumed run with no MCP tool at all. Re-run the exact same attach logic `start()` uses, for a
    // FRESH set of attachments and a FRESH socket, and hand the adapter the new config as an override
    // for this specific generation rather than trusting it to still be valid.
    const resumeWorkerId = workerIdForRun(database, runId);
    const resumeWorkerRow = resumeWorkerId ? database.prepare(`SELECT role FROM workers WHERE worker_id = ?`).get(resumeWorkerId) : null;
    const resumeMcpAttach = resumeWorkerRow?.role
      ? await attachMcpPoolsForRole(resumeWorkerRow.role, {
        principalId: principalForWorker(database, resumeWorkerId)?.id ?? null,
        canDeliverMcpConfig: adapter.capabilities?.()?.mcpConfigDelivery === "file-or-json-string",
        harnessId, workerId: resumeWorkerId,
      })
      : { mcpAttachmentIds: [], mcpServersForConfig: {}, undeliveredNeeds: [] };
    // review-consolidated-2026-09-14.md finding 4: same fail-closed-by-default posture as `start()` —
    // a resumed generation must not silently lose its declared tool either. Detach whatever attached
    // before refusing; nothing should be left resident for a resume that never happens.
    if (resumeMcpAttach.undeliveredNeeds.length && !allowDegradedMcp) {
      for (const attachmentId of resumeMcpAttach.mcpAttachmentIds) {
        mcpPool.detach(attachmentId).catch((detachErr) => {
          logger.warn?.(`[supervisor] mcp-pool detach ${attachmentId} after refusing undelivered-MCP resume for ${runId} failed (best-effort): ${detachErr.message}`);
        });
      }
      return {
        ok: false, refused: "mcp-required-unavailable",
        error: `resume: role "${resumeWorkerRow?.role}" declares MCP need(s) [${resumeMcpAttach.undeliveredNeeds.join(", ")}] `
          + "that could not be delivered for the new generation — refusing rather than resuming a tool-less run "
          + "silently; pass { allowDegradedMcp: true } to resume anyway with no tool for the undelivered need(s)",
      };
    }
    const specOverride = Object.keys(resumeMcpAttach.mcpServersForConfig).length
      ? { mcpConfig: [JSON.stringify({ mcpServers: resumeMcpAttach.mcpServersForConfig })] }
      : undefined;

    let result;
    try {
      result = await adapter.resume(runId, specOverride ? { specOverride } : undefined);
    } catch (err) {
      for (const attachmentId of resumeMcpAttach.mcpAttachmentIds) {
        mcpPool.detach(attachmentId).catch((detachErr) => {
          logger.warn?.(`[supervisor] mcp-pool detach ${attachmentId} after failed adapter.resume() for ${runId} failed (best-effort): ${detachErr.message}`);
        });
      }
      throw err;
    }
    if (result === "unsupported") {
      for (const attachmentId of resumeMcpAttach.mcpAttachmentIds) {
        mcpPool.detach(attachmentId).catch((detachErr) => {
          logger.warn?.(`[supervisor] mcp-pool detach ${attachmentId} after unsupported adapter.resume() for ${runId} failed (best-effort): ${detachErr.message}`);
        });
      }
      return { runId, harnessId, resumed: false, result };
    }
    // Backfill the fresh attachments to this run — mirrors `start()`'s own backfill; `runId` already
    // exists here (unlike `start()`, which has to wait for `createRun` to commit first).
    for (const attachmentId of resumeMcpAttach.mcpAttachmentIds) setAttachmentRunId(database, attachmentId, runId);
    // A resumed run is LIVE again, so its row must not still be terminal. Leaving it closed was
    // the invisible-orphan bug in another costume (verified: `resumed: true, generation: 2` over a
    // live process whose row still read `finished`): `listOpenRuns()` could not see it, so boot
    // reconciliation never examined it, `list()` never showed it, the shared-pgid refusal never
    // counted it, and generation 2's own completion write was rejected by `endRun`'s
    // `ended_at IS NULL` guard — which also meant its asks were never scheduled.
    const reopened = reopenRun(database, runId) === 1;
    // A resumed run is a NEW process: its recorded identity must be replaced, or a later
    // reap verifies against the identity of the process that already exited.
    const identity = await persistIdentity(runId, adapter);
    // ...and a new process needs a new consumer. The pump's `attach()` is a no-op while
    // `state.consumer` is set, and after the first process ended that state is `done: true`
    // with a resolved consumer — so without resetting it, the resumed process's events are
    // consumed by nobody: `event_log` stops growing, `derived()` keeps reporting the old
    // terminal status, and `observe` reports a live run as finished. Reset, bump the
    // generation (seq restarts at 1, so the old numbering must not be reused), re-attach.
    let generation = null;
    if (pump.has(runId)) {
      pump.resetRun(runId);
      generation = bumpRunGeneration(database, runId);
    }
    pump.attach(runId, adapter.observe(runId), { onEvent: onEventHook(runId), onEnd: onEndHook(runId) });
    return { runId, harnessId, resumed: true, result, identity, generation, reopened };
  }

  async function reap(runId) {
    const harnessId = harnessOf(runId);
    const adapter = harnessId ? adapters[harnessId] : null;
    const result = await withTerminalIntent(runId, "reaped", () =>
      reapRun({
        db: database,
        runId,
        hasHandle,
        // Only meaningful when the group is shared and a handle still exists; reap says so
        // explicitly when it isn't.
        adapterStop: adapter?.stop ? (id) => withTerminalIntent(id, "stopped", () => adapter.stop(id)) : undefined,
        logger,
      }),
    );
    // `reapRun` (`reconcile.js`) closes the run's open asks itself on a real reap/stop — this file's
    // ask/task-blocking wiring lives here, not there, so the reconcile is done on return rather than
    // inside a module that has no notion of task state at all.
    reconcileAutoBlockedTasks();
    // Only tear down the pump when the run actually ended. A refused reap (shared process
    // group, pid-reuse mismatch, a kill that didn't take) leaves a LIVE process behind;
    // closing its pump would stop persisting and fanning out the events of a run that is
    // still working, and nothing would ever re-attach a consumer to it.
    if (result.reaped === true || result.sessionEnded === true) pump.closeRun(runId);
    return { runId, harnessId, ...result };
  }

  /**
   * Every run the database still considers open, annotated with what is actually true now.
   *
   * Since migration 0003 this includes **live orphans** (`lifecycle: 'orphaned-unmanaged'`,
   * `managed: false`) — a still-running process nobody holds a handle for. Before 0003 those
   * rows were closed by reconciliation and so could not appear here at all, which is precisely
   * why an unreaped orphan was invisible after the next restart.
   */
  function list() {
    return listOpenRuns(database).map((row) => ({
      runId: row.run_id,
      harnessId: row.harness_id,
      pid: row.pid,
      processGroup: row.process_group,
      startedAt: row.started_at,
      lifecycle: row.lifecycle,
      orphaned: row.lifecycle === "orphaned-unmanaged",
      managed: hasHandle(row.run_id),
      derived: pump.derived(row.run_id),
    }));
  }

  /**
   * The "show me every process nobody is managing" view — the shortcut migration 0003 exists to
   * make possible. One row per live orphan, with enough to recognise it by eye (the prompt
   * preview stands in for a title, plus cwd, pid and pgid) and enough to judge how long it has
   * been going on (first/last sighting and a count, from the `orphan_sightings` journal).
   */
  function orphans() {
    return listOrphanedRuns(database).map((row) => ({
      runId: row.run_id,
      harnessId: row.harness_id,
      workerId: row.worker_id,
      title: row.prompt_preview ?? null,
      cwd: row.cwd,
      pid: row.pid,
      processGroup: row.process_group,
      startedAt: row.started_at,
      reconciledAt: row.reconciled_at,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      sightings: row.sighting_count,
      managed: hasHandle(row.run_id),
      // An orphan whose recorded identity is incomplete (schema-v1 rows: a pid with no
      // `proc_lstart`) can be classified but NOT reaped — `reap` refuses an identity it cannot
      // verify, and rightly so, since killing on pid alone is the pid-reuse footgun. Such a row
      // would otherwise reappear every boot with no way to resolve it and no hint why, so the
      // view says so out loud instead of looking like an ordinary reapable orphan.
      identityComplete: row.process_group != null && row.proc_lstart != null,
    }));
  }

  /**
   * Every unresolved ask, shaped for a caller rather than for SQL.
   *
   * `answerable` is the field that matters and the reason this is not just a SELECT: an ask
   * row can be open while the thing that was waiting for it is gone — the process was killed,
   * or a `resume()` replaced it — and a UI that offered an approve button there would let a
   * human make a decision that goes nowhere. It is computed from whether the adapter still
   * holds the parked request, which is the only honest source for it.
   */
  function asks({ runId = null } = {}) {
    return listPendingAsks(database, { runId }).map((row) => {
      let parked = null;
      if (row.harness_request_id) {
        try {
          const { adapter } = routeOrThrow(row.run_id);
          parked = adapter.pendingApprovals?.(row.run_id)?.some((p) => p.requestId === row.harness_request_id) ?? null;
        } catch {
          // Unroutable run (never started here, or already forgotten): not answerable.
          parked = false;
        }
      }
      return {
        askId: row.id,
        runId: row.run_id,
        taskId: row.task_id,
        kind: row.kind,
        question: row.question,
        // Never a bare JSON.parse on a read path: one malformed row would otherwise fail the
        // whole pending list for every client, not just its own entry.
        payload: parseJsonColumn(row.payload_json),
        createdAt: row.created_at,
        autoCloseAt: row.auto_close_at,
        harnessRequestId: row.harness_request_id,
        generation: row.generation,
        // null for an ask with no parked request at all (a plain "I am blocked" ask): there is
        // nothing to be stale about, so it is neither answerable nor not.
        answerable: row.harness_request_id ? parked === true : null,
      };
    });
  }

  function status(runId) {
    const row = getRun(database, runId);
    if (!row) return null;
    return {
      runId,
      harnessId: row.harness_id,
      pid: row.pid,
      processGroup: row.process_group,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      exitReason: row.exit_reason,
      reconciledAt: row.reconciled_at,
      lifecycle: row.lifecycle,
      orphaned: row.lifecycle === "orphaned-unmanaged" && row.ended_at === null,
      reapedAt: row.reaped_at,
      managed: hasHandle(runId),
      // Derived from the pump's stream, never asserted.
      derived: pump.derived(runId),
    };
  }

  // ── preflight: verify a harness/model, keep the verdict, leave nothing behind ──────────
  //
  // PLAN.md 12.1. Verifying that a harness/model combination is reachable means starting a REAL
  // session and sending a REAL prompt, which writes a real `runs` row and real `event_log` rows.
  // None of that is work anyone will ever want to read, and all of it pollutes the history a human
  // or the CTO reads back -- "who did what" becomes twenty sessions saying "hi". So cleanup is part
  // of the check rather than a tidy-up someone remembers later.
  //
  // WHAT SURVIVES: one `model_health` row -- reachable, an error CLASS, latency, when. That is a
  // fact about the model, which is why it outlives the session; section 12.3's denylist and the
  // settings surface read it and neither wants a run id.

  /** The prompt. Short and boring on purpose: this measures reachability, not capability. */
  const PREFLIGHT_PROMPT = "Reply with the single word: ok";

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
    try {
      await adapter?.stop?.(runId);
    } catch (err) {
      logger.warn?.(`[supervisor] preflight ${runId} would not stop cleanly: ${err.message}`);
    }

    // Only where the harness kept a session at all. Claude Code preflights pass
    // `--no-session-persistence`, so there is nothing to delete; OpenCode has no such flag, so its
    // adapter deletes BY THE ID IT CREATED -- never by enumerating, because its session store is
    // global and enumerating would read other projects' history.
    // Detach the pump BEFORE the rows go, and this ordering is load-bearing rather than tidy.
    // The pump keeps consuming the adapter's stream until it is closed, and every event it
    // persists for a deleted run violates the `event_log.run_id` foreign key. Measured on the real
    // CLI before this line existed: each preflight logged
    // "[pump] recordEvent failed ... FOREIGN KEY constraint failed" as the tail of the stream
    // arrived after the delete. Non-fatal, but it is a run whose state the pump still holds and a
    // warning on every single check -- and log noise that is expected is log noise nobody reads.
    //
    // `closeRun` is the same call `stop`/`reap` use, so this is not a preflight-specific mechanism.
    pump.closeRun(runId);

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

  // ── tier-3 task handoffs (PLAN.md section 8, Rule 4) ────────────────────────────────
  //
  // "Summaries, not transcripts, cross a worker boundary." Tier 3 is the rolling ~1 page that the
  // CTO, leads, reviewers and any new or cleared worker read INSTEAD of a transcript -- the hard
  // rule being that no agent ever reads tier 1, without which the CTO's context explodes at about
  // three concurrent workers.
  //
  // Deterministic and free (no model call), which is what makes Rule 5 possible: clearing is
  // routine BECAUSE tier 3 is cheap, so a per-transition model call would be a recurring cost on
  // the most frequent event in the system. See handoff/generate.js for why, and for the one seam
  // (`assumptions`) that is deliberately left empty rather than guessed.

  /**
   * taskHandoff(taskId, { reason }) -> { id, doc, truncated, chars, sources }
   *
   * Generates AND persists. Splitting those would invite a caller to generate one and forget to
   * store it, and the value of a handoff is that the NEXT reader finds it already there.
   */
  function taskHandoff(taskId, { reason = "manual", budgetChars, now } = {}) {
    if (!taskId) throw new Error("taskHandoff: taskId is required");
    const generated = generateTaskHandoff(database, taskId, {
      ...(Number.isInteger(budgetChars) ? { budgetChars } : {}),
      ...(now ? { now } : {}),
    });
    const id = recordTaskHandoff(database, { taskId, reason, ...generated });
    return { id, ...generated };
  }

  /** The current handoff for a task, or null. What a resumed or cleared worker is handed. */
  function currentTaskHandoff(taskId) {
    return latestTaskHandoff(database, taskId);
  }

  /** The regeneration history — kept because "what changed between these two" is worth asking. */
  function taskHandoffHistory(taskId, opts) {
    return listTaskHandoffs(database, taskId, opts ?? {});
  }

  // ── capability-based authorization (PLAN.md sections 16 and 14.5, migration 0010) ─────
  //
  // Section 16's replacement for the original fixed hop chain: "every caller carries an immutable principal and
  // a set of capabilities". The decision itself is pure (`domain/capabilities.js`); this is the part that mints
  // identities, resolves an incoming token into one, and enforces at the ONE place a request crosses from
  // outside to inside.
  //
  // WHAT A PRINCIPAL IS BUILT FROM, and the honest limit — measured, not assumed. Section 14.5 asks for "a
  // socket peer credential"; there is none available from pure Node
  // (`adapters/claude-code/probe/peercred-probe.mjs`, evidence 17: `remoteAddress` is undefined and the handle
  // exposes only bind/listen/connect/open/fchmod). So identity is two things stacked:
  //
  //   1. the state dir is 0700, so only the local user can reach the socket at all — that is the USER;
  //   2. a token the supervisor mints, delivered by a channel it controls — that is WHICH PRINCIPAL.
  //
  // A token in a child's environment is visible to that child's descendants, so a worker principal identifies
  // a RUN AND EVERYTHING IT SPAWNS. That is an honest boundary for a local single-user tool and would not be
  // one on a shared host; it is written down here and in migration 0010 rather than left for someone to
  // discover.

  /** The owner's token file. 0600, inside the 0700 state dir — the same "only this user" boundary. */
  const OWNER_TOKEN_FILE = "owner.token";

  const sha256 = (text) => createHash("sha256").update(String(text)).digest("hex");

  /**
   * Ensure the owner principal exists, and return its token.
   *
   * Idempotent, and the token file is the source of truth for "what was minted": if the file is present and its
   * hash matches a live principal, nothing is re-minted. A fresh token on every boot would invalidate any
   * client holding the old one — including a TUI that is still running.
   */
  function ensureOwnerPrincipal() {
    const file = path.join(stateDirOf(), OWNER_TOKEN_FILE);
    if (fs.existsSync(file)) {
      const token = fs.readFileSync(file, "utf8").trim();
      const existing = principalByTokenHash(database, sha256(token));
      if (existing && !existing.revokedAt) return { principal: existing, token, minted: false };
    }
    const token = randomBytes(32).toString("hex");
    const id = `p-owner-${randomUUID().slice(0, 8)}`;
    mintPrincipal(database, {
      id, kind: "human", displayName: "owner (foreground TUI)", capabilities: [...PRESETS.owner], tokenSha256: sha256(token),
    });
    // 0600 BEFORE the write, not after: a file created 0644 and chmodded is readable for the width of that
    // gap, and this is the one file whose contents are a credential. Same reasoning as db/paths.js's mode
    // handling.
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    logger.log?.(`[supervisor] minted owner principal ${id}; token in ${file} (0600)`);
    return { principal: getPrincipal(database, id), token, minted: true };
  }

  /**
   * The principal a worker run speaks as.
   *
   * A worker's capabilities come from its ROLE, not from the request or from a flag: a reviewer may record
   * verdicts, a coder may not, and neither may start runs or touch a utility capability. Section 16's reason
   * for utility agents at all is that "the capability to push code, file a Jira ticket, or post to Slack isn't
   * duplicated into every worker's toolset".
   */
  function ensureWorkerPrincipal(workerId, { rotate = false } = {}) {
    const existing = principalForWorker(database, workerId);
    if (existing) {
      // ROTATE for a new run, and that is the difference between authorization working once and working. A
      // principal is durable (§3's identity split: a worker survives clear and respawn); its CREDENTIAL is
      // not, because only a hash is stored and the old token was handed to a process that is now gone. So a
      // restart gets a fresh token for the SAME identity, and the previous run's token stops working — which
      // is what you want from a credential whose holder has exited.
      //
      // Found by the Phase 7 review (sol): without this, every run after a worker's first launched with no
      // token at all and every callback it made was refused.
      if (!rotate) return { principal: existing, token: null, minted: false };
      const token = randomBytes(32).toString("hex");
      const { rotated } = rotatePrincipalToken(database, existing.id, sha256(token));
      if (!rotated) return { principal: existing, token: null, minted: false, rotated: false };
      return { principal: getPrincipal(database, existing.id), token, minted: false, rotated: true };
    }
    const worker = database.prepare(`SELECT worker_id, nickname, role FROM workers WHERE worker_id = ?`).get(workerId);
    if (!worker) throw new Error(`ensureWorkerPrincipal: no such worker ${workerId}`);
    // The utility-task lane (PLAN.md §16.2, added 2026-09-11): these four roles are spawned exactly like
    // any other worker (a run under a task), but their fixed toolset is a UTILITY preset, not the
    // generic worker one — a git-push-runner needs `git:push`/`git:push-protected`, which `PRESETS.worker`
    // deliberately does not carry. `kind: "utility"` too, matching migration 0010's own description of
    // that kind ("a narrow single-purpose agent") rather than the generic "worker" kind, even though it
    // is dispatched through the same run/task machinery as a coder or reviewer. (Map is module-scoped —
    // see its own comment above — so `start()`'s MCP-pool wiring reuses this exact signal.)
    const utilityPresetName = UTILITY_TASK_PRESETS[worker.role];
    const preset = utilityPresetName ? PRESETS[utilityPresetName] : worker.role === "reviewer" ? PRESETS.reviewer : PRESETS.worker;
    const kind = utilityPresetName ? "utility" : "worker";
    const token = randomBytes(32).toString("hex");
    const id = `p-w-${workerId}-${randomUUID().slice(0, 6)}`;
    mintPrincipal(database, {
      id, kind, displayName: `${worker.nickname} (${worker.role})`, workerId,
      capabilities: [...preset], tokenSha256: sha256(token),
    });
    return { principal: getPrincipal(database, id), token, minted: true };
  }

  /**
   * Mint a principal for anything else — a utility agent, the CTO.
   *
   * `capabilities` must be a named PRESET, not an arbitrary list from the caller. Section 16 keeps toolsets
   * fixed, and "mint me a principal with these capabilities" is precisely how a caller grants itself authority
   * it does not hold. The preset name is the whole vocabulary.
   */
  function mintNamedPrincipal({ preset, displayName, id = null } = {}) {
    const caps = PRESETS[preset];
    if (!caps) throw new Error(`mintNamedPrincipal: "${preset}" is not a preset (have: ${Object.keys(PRESETS).join(", ")})`);
    const token = randomBytes(32).toString("hex");
    const principalId = id ?? `p-${preset.replace(/[^a-z0-9]+/gi, "-")}-${randomUUID().slice(0, 8)}`;
    mintPrincipal(database, {
      id: principalId, kind: preset.startsWith("utility") ? "utility" : preset,
      displayName: displayName ?? preset, capabilities: [...caps], tokenSha256: sha256(token),
    });
    return { id: principalId, token, capabilities: [...caps] };
  }

  /**
   * The enforcement wrapper — the ONE place a request becomes an authorization decision.
   *
   * `commandHandlers()` stays the raw in-process map: anything holding the supervisor object is already inside
   * the process and has full authority by construction. THE SOCKET is the trust boundary, so this is what a
   * socket server must be given, and `ipc/daemon.js` is the caller that matters.
   *
   * Every outcome is journalled, allow and refuse alike (§14.5: "refusals are logged, never silently
   * dropped"). A denial that leaves no trace cannot be audited, and cannot tell "nobody tried" from "somebody
   * tried and was stopped".
   */
  function authorizedCommandHandlers() {
    const raw = commandHandlers();
    const wrapped = {};
    for (const [name, handler] of Object.entries(raw)) {
      wrapped[name] = async (cmd, ...rest) => {
        // The principal is resolved from the TOKEN HASH. Nothing about the decision comes from the payload —
        // §37.10's first rule, and the Phase 6 review is what made it a rule rather than a preference.
        const principal = cmd?.token ? principalByTokenHash(database, sha256(cmd.token)) : null;
        const capability = COMMAND_CAPABILITIES[name];
        const hash = argsHash(cmd ?? {});
        const approval = principal && capability && isSensitive(capability)
          ? findSensitiveApproval(database, { action: capability, argsSha256: hash, forPrincipal: principal.id })
          : null;
        const verdict = authorize({ principal, command: name, args: cmd ?? {}, approval });

        if (!verdict.ok) {
          if (principal) {
            journalAppend(database, {
              principalId: principal.id, action: capability ?? name, argsSha256: hash,
              argsPreview: `${name} ${JSON.stringify(cmd?.taskId ?? cmd?.runId ?? "")}`.slice(0, 200),
              taskId: cmd?.taskId ?? null, outcome: "refused", detail: verdict.reason,
            });
          }
          // An unauthenticated caller is refused WITHOUT a journal row, because there is no principal to
          // attribute it to — inventing one would make the journal's own identities untrustworthy. The
          // supervisor log still records it.
          else logger.warn?.(`[supervisor] refused unauthenticated "${name}": ${verdict.reason}`);
          return { id: cmd?.id, ok: false, error: verdict.reason, refused: "unauthorized", needsApproval: verdict.needsApproval === true };
        }

        // A sensitive action's approval is SPENT BEFORE the work, and only if the spend wins: the conditional
        // UPDATE is what makes single-use real, so two concurrent requests cannot both proceed on one decision.
        if (verdict.approvalId) {
          const spent = consumeSensitiveApproval(database, verdict.approvalId);
          if (!spent.consumed) {
            journalAppend(database, {
              principalId: principal.id, action: capability, argsSha256: hash, outcome: "refused",
              detail: "the approval was consumed by another request first",
            });
            return { id: cmd?.id, ok: false, error: "that approval was already used", refused: "unauthorized" };
          }
        }

        journalAppend(database, {
          principalId: principal.id, action: capability, argsSha256: hash,
          argsPreview: `${name} ${JSON.stringify(cmd?.taskId ?? cmd?.runId ?? "")}`.slice(0, 200),
          taskId: cmd?.taskId ?? null, outcome: "allowed",
        });
        try {
          // The RESOLVED principal is handed to the handler, and a caller-supplied `_principal` cannot survive
          // this spread — it is overwritten. Without it, `mergeTask` took its `actor` from the request and
          // defaulted to "owner", so a CTO merge was recorded in the transition journal as the owner's, and any
          // string a caller sent was persisted as an identity. The authorization journal had the truth and the
          // task history had a fiction. Found by the Phase 7 review (sol) — §37.10's rule again, one layer up.
          const result = await handler({ ...cmd, _principal: principal }, ...rest);
          // `done` rather than a second `allowed`: §16's dedup question is "did I already DO this", and an
          // attempt that failed must not answer it yes.
          journalAppend(database, {
            principalId: principal.id, action: capability, argsSha256: hash, taskId: cmd?.taskId ?? null,
            outcome: result?.ok === false ? "failed" : "done",
            detail: result?.ok === false ? String(result.error).slice(0, 500) : null,
          });
          return result;
        } catch (err) {
          journalAppend(database, {
            principalId: principal.id, action: capability, argsSha256: hash, taskId: cmd?.taskId ?? null,
            outcome: "failed", detail: err.message,
          });
          throw err;
        }
      };
    }
    return wrapped;
  }

  // ── configurable reviews (PLAN.md section 13, migration 0009) ─────────────────────────
  //
  // Section 13's rule, which every function below serves: "a task reaches `approved` only when every
  // BLOCKING dimension has ≥1 current-round approval, quorum is met, and there are ZERO current-round change
  // requests." The rule itself is pure (`domain/review.js`); this is the I/O around it — importing the
  // profile, recording verdicts, verifying findings, and refusing an approval that has not earned it.

  /**
   * Import `review-profiles.json` into `review_profiles` (PLAN.md section 3's rule for this file).
   *
   * Called from `boot()` and on demand. Each resolved profile is stored under its CONTENT HASH, so an edit
   * adds a row rather than mutating the one older verdicts point at — see migration 0009's header for why a
   * verdict must stay interpretable after its profile changes.
   */
  function importReviewProfiles() {
    const config = loadReviewProfiles({ stateDir: stateDirOf() });
    let imported = 0;
    for (const profile of Object.values(config.profiles)) {
      if (importReviewProfile(database, { id: profile.id, hash: profile.hash, config: profile }).imported) imported += 1;
    }
    reviewConfig = config;
    return { source: config.source, profiles: Object.keys(config.profiles), imported };
  }

  /** The config, cached per boot and refreshed by `importReviewProfiles()` — never read stale from disk. */
  let reviewConfig = null;

  function reviewConfigOf() {
    if (!reviewConfig) importReviewProfiles();
    return reviewConfig;
  }

  /**
   * Which profile governs this task, and why.
   *
   * `paths` are the files the task actually changes, so section 13's `perPath` rule can apply — the whole
   * point of that rule is that `packages/payments/**` is stricter than whatever the owning team normally
   * does. Derived from the task's diff when git can see it, because asking a caller to supply them means the
   * strict profile applies only when somebody remembered.
   */
  function reviewProfileForTask(taskId, { paths = null } = {}) {
    const task = database.prepare(`SELECT id, team_id, worktree_id, base_rev FROM tasks WHERE id = ?`).get(taskId);
    if (!task) throw new Error(`reviewProfileForTask: no such task ${taskId}`);
    const changed = paths ?? changedPathsFor(task);
    const { profile, reason } = profileForReview(reviewConfigOf(), { teamId: task.team_id, paths: changed });
    return { profile, reason, paths: changed };
  }

  /**
   * The worktree's current HEAD, or null when git cannot say.
   *
   * Best-effort and never throws, for the same reason `changedPathsFor` does not: a task with no worktree has
   * no HEAD, and failing an approval because git is unhappy would block work on an unrelated problem. When it
   * IS available it is authoritative — an approval is a statement about the code that is there now.
   */
  function currentHeadFor(taskId) {
    const task = database.prepare(`SELECT worktree_id FROM tasks WHERE id = ?`).get(taskId);
    if (!task?.worktree_id) return null;
    try {
      return String(execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: task.worktree_id, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
      })).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * The files a task has changed, best-effort.
   *
   * Never throws, and an empty list is an honest answer: a task with no worktree, no `base_rev`, or a git
   * that cannot read it has no known paths, so `perPath` cannot apply and the team/default profile governs.
   * The alternative — failing the review because git is unhappy — would block work on an unrelated problem.
   */
  function changedPathsFor(task) {
    if (!task?.worktree_id || !task?.base_rev) return [];
    try {
      const out = execFileSync("git", ["diff", "--name-only", `${task.base_rev}..HEAD`], {
        cwd: task.worktree_id, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
      });
      return String(out).split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Record a reviewer's verdict on one dimension, verifying its findings first.
   *
   * VERIFICATION HAPPENS HERE, before the verdict is stored, because section 13 says findings that fail
   * verification "never arrive" — and a finding stored as confirmed and filtered later would be one query
   * away from reaching a coder anyway.
   */
  async function recordVerdict(v) {
    // SERIALIZED PER TASK. `recordVerdict` awaits a verifier that may call a model, and IPC handlers run
    // concurrently — so without this, `approveTask` could evaluate the stored rows during that await and
    // transition the task, after which the delayed change request landed on an already-approved task. Found
    // by the Phase 6 review (sol); the mutex is what makes "the rule was true when the transition happened"
    // an actual guarantee rather than a usually-true one.
    return withTaskLock(v.taskId, async () => {
      const { profile } = reviewProfileForTask(v.taskId);
      // ── the identity boundary ────────────────────────────────────────────────────────
      //
      // Everything below was previously taken from the socket payload on trust, and the review rule then
      // counted it: a caller could reach quorum with a worker from another task, claim `slot: "parent"` to
      // satisfy `parentRequired`, or invent a dimension that no profile defines. Verified before fixing —
      // all three were accepted and the task approved on manufactured identity.
      //
      // The rule: a verdict's IDENTITY is a property of the registry, not of the request. The only thing the
      // caller supplies is the judgement.
      const task = database.prepare(`SELECT id, state FROM tasks WHERE id = ?`).get(v.taskId);
      if (!task) throw new Error(`recordVerdict: no such task ${v.taskId}`);
      // The AUTHENTICATED principal, not the request, decides which worker's verdict this is — same
      // "identity is a registry fact, not a request field" reasoning as the slot/dimension checks below,
      // extended to cover a gap those checks did not: without this, a single reviewer token could submit
      // verdicts under TWO DIFFERENT valid `workerId`s (both real reviewers on the task) and manufacture
      // the "two distinct reviewers" quorum by itself. Found by both codex reviews
      // (`codexdoc/review-phase7-uncommitted.md`'s scope excluded this file; `codexdoc/REVIEW-NOTES.md`
      // finding 3), fixed 2026-09-11. A principal with no `workerId` (owner/CTO) is not restricted here —
      // an owner/CTO recording on a worker's behalf is a future, separately-audited capability, not
      // something to silently allow OR silently block by accident while fixing worker impersonation.
      if (v._principal?.workerId && v._principal.workerId !== v.workerId) {
        throw new Error(
          `recordVerdict: principal is authenticated as worker ${v._principal.workerId}, not ${v.workerId} — `
          + "a reviewer can only record a verdict under its OWN worker identity",
        );
      }
      const worker = database
        .prepare(`SELECT worker_id AS workerId, nickname, role, task_id AS taskId FROM workers WHERE worker_id = ?`)
        .get(v.workerId);
      if (!worker) throw new Error(`recordVerdict: no such worker ${v.workerId}`);
      if (worker.taskId !== v.taskId) {
        throw new Error(
          `recordVerdict: worker ${v.workerId} is on task ${worker.taskId ?? "(none)"}, not ${v.taskId} — `
          + "a verdict counts toward quorum, so who may cast one is a registry fact, not a request field",
        );
      }
      if (worker.role !== "reviewer") {
        throw new Error(`recordVerdict: worker ${v.workerId} has role "${worker.role}", and only a reviewer may record a verdict`);
      }
      const dimensions = (profile.dimensions ?? []).map((d) => d.id);
      if (!dimensions.includes(v.dimension)) {
        throw new Error(
          `recordVerdict: "${v.dimension}" is not a dimension of review profile "${profile.id}" `
          + `(has: ${dimensions.join(", ")}) — an invented dimension would count toward quorum while satisfying nothing`,
        );
      }
      // The SLOT is derived, never accepted. `slot === "parent"` is what `parentRequired` checks, so letting
      // a caller declare it makes that guard self-certifying.
      const slot = derivedSlotFor(v.taskId, worker);
      if (v.slot && v.slot !== slot) {
        logger.warn?.(
          `[supervisor] recordVerdict: ignoring caller-supplied slot "${v.slot}" for ${v.workerId}; `
          + `the registry says "${slot}"`,
        );
      }
      // A verdict on an already-approved task is REFUSED rather than silently invalidating the approval.
      // PLAN.md §6 has no `approved -> awaiting-review` edge, and inventing one here would be exactly the
      // kind of speculative state §6 warns against — so the refusal names the legal way forward.
      if (task.state === "approved" || task.state === "merged") {
        throw new Error(
          `recordVerdict: task ${v.taskId} is "${task.state}"; a verdict cannot change a decision that has `
          + "already been made — start a new round by moving the task back through the state machine first",
        );
      }

      const findings = profile.verifyFindings === false
        ? (v.findings ?? []).map((f) => ({ ...f, verdict: f.verdict ?? "unverified" }))
        : await verifyFindings(v.findings ?? [], { profile, taskId: v.taskId });
      recordReviewVerdict(database, {
        ...v,
        slot,
        findings,
        profileId: profile.id,
        profileHash: profile.hash,
      });
      return { recorded: true, slot, findings, profile: { id: profile.id, hash: profile.hash } };
    });
  }

  /**
   * Which review slot a worker actually holds — from the assignment record, else from the same stable
   * ordering `planAssignment` uses.
   *
   * `parentReviewer` maps to the slot name `parent`, because that is the string §13's quorum rules and
   * `evaluateReview` speak. Two vocabularies meeting is exactly the kind of seam that gets papered over with
   * a caller-supplied string, which is how the guard became self-certifying in the first place.
   */
  function derivedSlotFor(taskId, worker) {
    const record = readAssignmentRecord(taskId);
    const assigned = record?.slots?.find((sl) => sl.workerId === worker.workerId)?.configSlot;
    if (assigned) return assigned === "parentReviewer" ? "parent" : assigned;
    const reviewers = database
      .prepare(`SELECT worker_id AS workerId, nickname FROM workers WHERE task_id = ? AND role = 'reviewer'`)
      .all(taskId)
      .sort((a, b) => String(a.nickname ?? a.workerId).localeCompare(String(b.nickname ?? b.workerId)));
    const idx = reviewers.findIndex((r) => r.workerId === worker.workerId);
    return idx <= 0 ? "reviewer1" : `reviewer${idx + 1}`;
  }

  /**
   * Per-task serialization for the review path.
   *
   * A promise chain per task id, not a global lock: two tasks being reviewed at once must not queue behind
   * each other, and the invariant that matters is per task ("the rule held for THIS task at the moment it
   * transitioned"). Entries are dropped when their chain drains, so this does not grow with task count.
   */
  const taskLocks = new Map();
  function withTaskLock(taskId, fn) {
    const previous = taskLocks.get(taskId) ?? Promise.resolve();
    // `.then(fn, fn)` on purpose: a rejected predecessor must not block the queue behind it forever.
    const result = previous.then(fn, fn);
    // The QUEUE holds a promise that is settled either way, for two reasons: a caller whose work threw must
    // not block the next caller, and the queue's own promise must never be the one nobody handles. The first
    // version chained a `.finally()` off `result` for map cleanup — which derives a THIRD promise that
    // rejects with the caller's error and has no handler, so a refused verdict became an unhandled rejection
    // that killed the process. Caught immediately by re-running the reproduction script, which is why that
    // script exists.
    const queued = result.then(() => {}, () => {});
    taskLocks.set(taskId, queued);
    // Drop the entry once its chain has drained, so this does not grow with task count. Guarded by identity:
    // a later caller may already have replaced it, and deleting theirs would let two calls run at once.
    queued.then(() => { if (taskLocks.get(taskId) === queued) taskLocks.delete(taskId); });
    return result;
  }

  /**
   * Section 13's adversarial second pass: "each finding through a verification pass before it reaches the
   * coder — findings that fail verification never arrive."
   *
   * THE DEFAULT VERIFIER DOES NOT CONFIRM ANYTHING, and that is the honest boundary. Deciding whether a
   * finding is real means reading the code, which needs a model; with no verifier configured, a finding is
   * marked `unverified` and DELIVERED as such. The two alternatives are both worse: treating it as CONFIRMED
   * is a lie (nothing checked it), and dropping it loses a real finding because of a missing configuration.
   * Same shape as the tier-2 digester (`domain/turn-digest.js`) — injectable, free by default, and labelled
   * so a reader always knows which they have.
   */
  async function verifyFindings(findings, { profile, taskId } = {}) {
    const out = [];
    for (const f of findings ?? []) {
      if (!f) continue;
      if (!findingVerifier) { out.push({ ...f, verdict: "unverified" }); continue; }
      try {
        const result = await findingVerifier(f, { profile, taskId });
        const verdict = FINDING_VERDICTS.includes(result?.verdict) ? result.verdict : "unverified";
        out.push({ ...f, verdict, verifierNote: result?.note ?? null });
      } catch (err) {
        // A verifier that throws must not lose the finding. `unverified` with the reason attached is the
        // outcome that keeps the finding and stays honest about what happened to it.
        logger.warn?.(`[supervisor] finding verification failed (non-fatal): ${err.message}`);
        out.push({ ...f, verdict: "unverified", verifierNote: `verification failed: ${err.message}` });
      }
    }
    return out;
  }

  /**
   * reviewStatus(taskId, { round, commitSha }) -> the full evaluation
   *
   * Returns reasons, not just a boolean. "Not approved" is not actionable; "security has no approval for this
   * revision; quorum is 1 of 2" is, and it is what a pane and a CTO both need to say next.
   */
  function reviewStatus(taskId, { round = null, commitSha = null } = {}) {
    const current = reviewProfileForTask(taskId);
    const verdicts = listReviewVerdicts(database, taskId);
    const effectiveRound = round ?? latestReviewRound(database, taskId) ?? 0;
    const inRound = verdicts.filter((v) => v.round === effectiveRound);
    // The commit under review, defaulting to the newest one any verdict in this round judged. A caller that
    // supplies nothing is asking "where does this task stand", and the answer has to be about the revision
    // the reviewers were actually looking at.
    const effectiveCommit = commitSha ?? inRound[inRound.length - 1]?.commitSha ?? null;

    // ── THE PROFILE A ROUND IS JUDGED UNDER IS THE ONE ITS VERDICTS WERE RECORDED UNDER ──────────
    //
    // Migration 0009 stores every profile content-addressed and stamps every verdict with the
    // `(profile_id, profile_hash)` it was judged under, precisely so an edit cannot rewrite the meaning of a
    // judgement already made. This function then ignored both and evaluated against the CURRENT file —
    // verified before fixing: loosening a profile from "correctness + security, quorum 2" to "correctness,
    // quorum 1" made an old, insufficient set of verdicts approve the task. The mechanism that was supposed
    // to prevent reinterpretation was built, stored, and never read.
    //
    // MIXED HASHES IN ONE ROUND ARE REFUSED rather than merged. Combining judgements made under two different
    // rule sets produces a verdict count that means nothing, and the honest answer — "the rules changed
    // mid-round, start a new one" — is also the actionable one.
    const hashes = [...new Set(inRound.map((v) => v.profileHash).filter(Boolean))];
    let profile = current.profile;
    let reason = current.reason;
    let profileConflict = null;
    if (hashes.length === 1 && hashes[0] !== current.profile.hash) {
      const stored = getReviewProfile(database, { id: inRound[0].profileId ?? current.profile.id, hash: hashes[0] });
      if (stored?.config) {
        profile = { ...stored.config, id: stored.id, hash: stored.hash };
        reason = `the profile this round was judged under (${stored.id}@${stored.hash.slice(0, 8)}), not the current one`;
      }
    } else if (hashes.length > 1) {
      profileConflict = `this round's verdicts were judged under ${hashes.length} different profile versions `
        + `(${hashes.map((h) => h.slice(0, 8)).join(", ")}) — start a new round rather than combining them`;
    }

    const evaluation = evaluateReview(verdicts, profile, { round: effectiveRound, commitSha: effectiveCommit });
    if (profileConflict) {
      evaluation.approved = false;
      evaluation.reasons = [profileConflict, ...evaluation.reasons];
    }
    return {
      taskId,
      round: effectiveRound,
      commitSha: effectiveCommit,
      profile: { id: profile.id, hash: profile.hash, reason },
      ...evaluation,
      findings: rankFindings(inRound.flatMap((v) => v.findings ?? [])),
      findingCount: inRound.reduce((n, v) => n + rankFindings(v.findings ?? []).length, 0),
    };
  }

  /**
   * approveTask(taskId, ...) -> moves `awaiting-review` -> `approved`, or REFUSES with reasons.
   *
   * The one path that may make that transition. It exists so the rule is enforced by the system rather than
   * by whoever calls `recordTransition` remembering to check — which is exactly the gap Phase 5 closed for
   * the state machine itself (`canTransition` was documentation until something consulted it).
   *
   * Note what this does NOT do: merge. Section 6's hard rule stands untouched — `merged` needs an explicit
   * human approval, and no number of green reviews is one.
   */
  async function approveTask(taskId, opts = {}) {
    // THE SAME LOCK `recordVerdict` takes, which is the point. Verified before fixing: with a change request
    // whose verification was blocked on a deferred promise, a synchronous `approveTask` evaluated the stored
    // rows, transitioned the task to `approved`, and the change request landed afterwards — leaving an
    // approved task whose own `reviewStatus()` reported it blocked. Async is a real signature change and the
    // right one: "the rule held at the moment of the transition" cannot be guaranteed by a function that
    // cannot wait for the writes in flight.
    return withTaskLock(taskId, () => approveTaskLocked(taskId, opts));
  }

  function approveTaskLocked(taskId, { actor = "cto", round = null, commitSha = null } = {}) {
    // ── ROUND AND COMMIT ARE AUTHORITATIVE, NOT ARGUMENTS ────────────────────────────────
    //
    // Both were taken from the caller and passed straight into the guard. Verified before fixing: with a
    // green round 1 at `sha1` and a change request in round 2 at `sha2`, `approveTask({ round: 1, commitSha:
    // "sha1" })` evaluated round 1 and moved the task to `approved`. The rule was correct and the caller
    // chose which reality to apply it to.
    //
    // So: the round is the LATEST recorded round, the commit is the worktree's current HEAD when git can see
    // it, and a caller that names either one must name the same value the system does. Naming them is still
    // allowed — it is how a caller says "I believe this is current", which is worth being able to refuse.
    const authoritativeRound = latestReviewRound(database, taskId) ?? 0;
    if (round !== null && Number(round) !== Number(authoritativeRound)) {
      return {
        taskId,
        approved: false,
        refused: [
          `round ${round} is not the current review round (${authoritativeRound}) — approving an older round `
          + "would ignore every verdict recorded since",
        ],
      };
    }
    const head = currentHeadFor(taskId);
    if (head && commitSha !== null && commitSha !== head) {
      return {
        taskId,
        approved: false,
        refused: [`commit ${commitSha} is not the worktree's current HEAD (${head}) — an approval is a statement about the code that is there now`],
      };
    }
    const status = reviewStatus(taskId, { round: authoritativeRound, commitSha: commitSha ?? head ?? null });
    if (!status.approved) {
      return { taskId, approved: false, refused: status.reasons, status };
    }
    recordTransition(database, {
      id: `tr-approve-${taskId}-${Date.now()}`,
      taskId,
      fromState: "awaiting-review",
      toState: "approved",
      actor,
      // The review rule has already checked quorum per-dimension, so the state machine's simpler count is
      // satisfied from the same evaluation rather than from a second, independent tally.
      reviewerVerdicts: status.quorum.distinctReviewers,
      requiredVerdicts: status.quorum.required,
    });
    // Rule 4: the handoff is regenerated on transition, and an approval is the transition a reader most
    // wants the current document for.
    try { taskHandoff(taskId, { reason: "state-transition" }); } catch (err) {
      logger.warn?.(`[supervisor] approveTask ${taskId}: handoff regeneration failed (non-fatal): ${err.message}`);
    }
    // Rule 5, Phase 8: the coder's own "state-transition" moment, AND the only round-concluding event
    // this runtime actually implements (`awaiting-review` -> `approved` means no more rounds) — see
    // `domain/clear-policy.js`'s header for why a change-request round ending is NOT wired here (nothing
    // drives `awaiting-review` -> `fixing` automatically yet).
    applyClearPolicy(taskId, { roles: ["coder"], trigger: "state-transition" })
      .catch((err) => logger.warn?.(`[supervisor] approveTask ${taskId}: coder clear-policy failed (non-fatal): ${err.message}`));
    applyClearPolicy(taskId, { roles: ["reviewer", "parentReviewer"], trigger: "review-round-concluded" })
      .catch((err) => logger.warn?.(`[supervisor] approveTask ${taskId}: reviewer clear-policy failed (non-fatal): ${err.message}`));
    // ROADMAP.md Phase 9 (Slack outbound): "task state transition to approved/merged posts a summary" —
    // via the outbox, never a synchronous call (that's the whole point of the table). Best-effort, same
    // convention as the handoff/clear-policy writes just above: a failure to WRITE the outbox row must
    // never fail the approval itself, and delivery is a separate, later concern `slack-outbox.js` owns.
    try {
      const t = database.prepare(`SELECT title FROM tasks WHERE id = ?`).get(taskId);
      writeOutboxEvent(database, {
        id: `outbox-approve-${taskId}-${Date.now()}`,
        eventType: "task-approved",
        payload: { taskId, title: t?.title ?? null, actor },
      });
    } catch (err) {
      logger.warn?.(`[supervisor] approveTask ${taskId}: outbox write failed (non-fatal): ${err.message}`);
    }
    return { taskId, approved: true, status };
  }

  /**
   * What a coder is handed after a round: confirmed findings, ranked, plus the diff against the round before.
   *
   * Section 13: "store findings so a re-review can diff against the previous round instead of re-deriving it
   * — round 3's second pass should cost a fraction of round 3's first." The diff is the mechanism that makes
   * that true, and `resolved` is the only evidence a round produced anything.
   */
  function reviewFindings(taskId, { round = null } = {}) {
    const effectiveRound = round ?? latestReviewRound(database, taskId) ?? 0;
    const all = listReviewVerdicts(database, taskId);
    const thisRound = all.filter((v) => v.round === effectiveRound).flatMap((v) => v.findings ?? []);
    const prevRound = all.filter((v) => v.round === effectiveRound - 1).flatMap((v) => v.findings ?? []);
    // REFUTED findings are filtered out of the DIFF as well, not just out of `ranked`. This whole object goes
    // over the socket to whoever is fixing the code, so a finding that failed verification reached the coder
    // through `diff.added` while `ranked` was busy excluding it — which made the second pass a formality by a
    // side door. Found by the Phase 6 review (sol).
    const shipped = (list) => rankFindings(list);
    return {
      taskId,
      round: effectiveRound,
      ranked: shipped(thisRound),
      diff: diffFindings(shipped(prevRound), shipped(thisRound)),
    };
  }

  // ── harness/model assignment (PLAN.md section 11) ────────────────────────────────────
  //
  // §11's assignment step, which "fires anywhere a task is about to get a run started". A task exists in
  // `created` first; this is what moves it into a running state, and it is the single path that does —
  // "one picker, one config source, everywhere" (§11), so requests-panel accept, start-a-new-team and
  // click-to-start all land here rather than each calling `start()` their own way.
  //
  // TWO PROPERTIES ROADMAP ASKS FOR BY NAME, and each is a real failure this prevents:
  //
  //   * **Idempotency keys.** A confirm button that is double-clicked, or a retried socket request, must
  //     not start two runs for one worker. The key is CLAIMED before any process is spawned — after, and
  //     the window between the first `await` and the write is exactly where the duplicate happens.
  //   * **Partial-start compensation.** "A start that partially succeeds must not leave an orphaned run
  //     with no task, or a task stuck in `starting` forever."
  //
  // THE COMPENSATION DECISION, and it was a real fork. When the coder starts and a reviewer does not:
  // (A) kill the coder and mark the task `start-failed`, or (B) keep the coder, move the task on, and
  // record the failed role as retryable. **B**, and two independent models were asked because it is a
  // judgement rather than a fact — both picked B, with the same caveat: partial startup must never
  // silently become a completed task. It cannot here, and not by convention: `approved` needs the
  // profile's reviewer verdicts (domain/workflow-profiles.js) and `merged` needs an explicit human
  // approval, which PLAN.md §6 calls a hard rule. Killing a working coder because a reviewer failed to
  // spawn throws away real work to preserve a symmetry nothing needs.
  //
  // When NOTHING starts, the task goes to `start-failed` rather than sitting in `starting` — that is the
  // "stuck forever" half, and it is the state PLAN.md §6 already has for it.

  /** The assignment record's shape, stored on `tasks.harness_assignments_json` (§11's own instruction). */
  function readAssignmentRecord(taskId) {
    const row = database.prepare(`SELECT harness_assignments_json AS j FROM tasks WHERE id = ?`).get(taskId);
    if (!row) throw new Error(`assignTask: no such task ${taskId}`);
    if (!row.j) return null;
    try { return JSON.parse(row.j); } catch { return null; }
  }

  function writeAssignmentRecord(taskId, record) {
    database.prepare(`UPDATE tasks SET harness_assignments_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(record), new Date().toISOString(), taskId);
  }

  /**
   * assignTask(taskId, { overrides, actor, idempotencyKey }) -> a report
   *
   * Confirms an assignment and starts the runs. Returns what happened rather than throwing on a partial
   * failure: a caller that gets an exception cannot tell which half succeeded, and here that difference is
   * the whole point.
   */
  async function assignTask(taskId, { overrides = {}, actor = "operator", idempotencyKey = null, cwd = null, allowDegradedMcp = false } = {}) {
    if (!taskId) throw new Error("assignTask: taskId is required");
    const task = database.prepare(`SELECT id, title, type, team_id, state, worktree_id FROM tasks WHERE id = ?`).get(taskId);
    if (!task) throw new Error(`assignTask: no such task ${taskId}`);

    // Refuse a terminal task outright — `codexdoc/review-luna-2026-09-11.md` finding 7: without this,
    // `assignTask` could start a brand-new open run for a task already in `merged`/`cancelled`/etc. with
    // no coordination against `discardTaskWorktree`'s own (point-in-time) open-run check, so a discard
    // that observed zero open runs and a start landing right after it could delete a worktree out from
    // under the run it just created. There is no "reopen a terminal task" transition today, so this is
    // not yet the general "one lifecycle reservation for create/discard/assign" the finding asks for —
    // it closes the specific race by removing the only way assignTask could ever race a terminal-task
    // discard in the first place.
    if (isTerminal(task.state)) {
      return {
        ok: false, assigned: false, refused: "task-terminal",
        error: `task ${taskId} is "${task.state}" — assignTask refuses to start new runs on a terminal task; `
          + "there is no reopen transition, so a terminal task must not grow a new open run for "
          + "discardTaskWorktree's open-run check to remain meaningful",
      };
    }

    // ── the idempotency claim, BEFORE anything is spawned ────────────────────────────────
    const existing = readAssignmentRecord(taskId);
    if (idempotencyKey && existing?.idempotencyKey === idempotencyKey) {
      // Two distinct answers, and a caller needs to tell them apart: a completed assignment is a result to
      // show, whereas an in-flight one means "your first click is still working" — and retrying THAT is
      // what would double-start.
      return existing.status === "in-progress"
        ? { taskId, idempotent: true, inProgress: true, record: existing }
        : { taskId, idempotent: true, ...existing.report, record: existing };
    }

    const workers = database
      .prepare(`SELECT worker_id AS workerId, nickname, role FROM workers WHERE task_id = ?`)
      .all(taskId);
    const openRunWorkerIds = listRunsForDisplay(database, { openOnly: true }).map((r) => r.worker_id);
    const config = loadHarnessDefaults({ stateDir: stateDirOf() });
    const plan = planAssignment({
      task: { id: task.id, type: task.type, teamId: task.team_id },
      workers, config, overrides, openRunWorkerIds,
    });

    // MODEL DIVERSITY (PLAN.md section 13: "promote that to a validated profile property"). Section 11's
    // config already puts reviewer2 on a different harness than reviewer1; this is what makes the profile's
    // claim true rather than customary. Reported, not refused: two reviewers sharing a harness is a weaker
    // review, not an unsafe one, and blocking the work would trade a real cost for a configuration problem.
    // It is impossible to miss, though — it lands in the assignment record and therefore in the handoff's
    // Blockers, the same route a failed role takes.
    const diversity = checkModelDiversity(taskId, plan);

    const actionable = isActionable(plan);
    if (!actionable.ok) {
      // The task stays in `created`, which is the honest state: nothing was started, so nothing changed.
      return { taskId, assigned: false, refused: actionable.reason, plan };
    }

    const record = {
      idempotencyKey,
      actor,
      status: "in-progress",
      startedAt: new Date().toISOString(),
      configSource: config.source,
      slots: plan.slots.map(({ role, configSlot, workerId, harnessId, model, effort, source }) =>
        ({ role, configSlot, workerId, harnessId, model, effort, source })),
      unfillable: plan.unfillable,
      ...(diversity.violation ? { diversity } : {}),
    };
    writeAssignmentRecord(taskId, record);

    // `created` -> `starting` BEFORE the spawns, because that is what the state means: a task whose
    // processes are being started is `starting`. Recording it afterwards would leave a window in which
    // live runs belong to a task that claims not to have begun.
    if (task.state === "created") {
      recordTransition(database, {
        id: `tr-assign-${taskId}-${Date.now()}`,
        taskId, fromState: "created", toState: "starting", actor,
      });
    }

    const started = [];
    const failures = [...plan.unfillable.map((u) => ({ ...u, kind: "unfillable" }))];
    if (diversity.violation) failures.push({ kind: "model-diversity", role: "reviewer", reason: diversity.reason });
    for (const slot of plan.startable) {
      try {
        const { runId } = await start({
          harnessId: slot.harnessId,
          workerId: slot.workerId,
          spec: {
            cwd: cwd ?? task.worktree_id ?? process.cwd(),
            // A utility role (§16.2) gets REAL instructions naming its own tool and repeating the
            // "raise an ask, don't guess" rule — every other role keeps the existing generic sentence.
            prompt: instructionForRole(slot.role, task) ?? `Task ${taskId} (${task.type ?? "task"}), role ${slot.role}.`,
            ...(slot.model ? { model: slot.model } : {}),
            ...(slot.effort ? { effort: slot.effort } : {}),
            // review-consolidated-2026-09-14.md finding 4: passed through from assignTask's own caller
            // so a real operator/CTO can explicitly accept a degraded (tool-less) utility run rather than
            // assignTask's per-slot compensation silently swallowing the refusal as an ordinary
            // "start-failed" — the SAME opt-in `start()` itself requires, not a second mechanism.
            allowDegradedMcp,
          },
        });
        started.push({ ...slot, runId });
      } catch (err) {
        // Kept, not thrown. This is the compensation decision: one role failing to spawn must not undo the
        // ones that worked, and the failure has to be VISIBLE rather than logged — see the handoff's
        // Blockers section, which reads this record.
        failures.push({ kind: "start-failed", role: slot.role, configSlot: slot.configSlot, workerId: slot.workerId, reason: err.message });
        logger.warn?.(`[supervisor] assignTask ${taskId}: ${slot.role} (${slot.workerId}) failed to start: ${err.message}`);
      }
    }

    // ── compensation ─────────────────────────────────────────────────────────────────────
    const alreadyRunning = plan.slots.filter((s) => s.alreadyRunning);
    const live = started.length + alreadyRunning.length;
    let finalState = database.prepare(`SELECT state FROM tasks WHERE id = ?`).get(taskId).state;
    if (live === 0 && finalState === "starting") {
      // NOTHING is running, so the task must not sit in `starting` waiting for a process that will never
      // report. `start-failed` is the state PLAN.md §6 already has for exactly this.
      recordTransition(database, {
        id: `tr-assign-failed-${taskId}-${Date.now()}`,
        taskId, fromState: "starting", toState: "start-failed", actor,
      });
      finalState = "start-failed";
    } else if (live > 0 && finalState === "starting") {
      recordTransition(database, {
        id: `tr-assign-planning-${taskId}-${Date.now()}`,
        taskId, fromState: "starting", toState: "planning", actor,
      });
      finalState = "planning";
    }

    const report = {
      assigned: live > 0,
      started: started.map(({ role, workerId, runId, harnessId, model, effort }) => ({ role, workerId, runId, harnessId, model, effort })),
      alreadyRunning: alreadyRunning.map(({ role, workerId }) => ({ role, workerId })),
      failures,
      state: finalState,
      // A partial start is a first-class outcome, named rather than inferred from two array lengths.
      partial: live > 0 && failures.some((f) => f.kind === "start-failed"),
      requiredVerdicts: plan.profile.requiredVerdicts,
    };
    writeAssignmentRecord(taskId, { ...record, status: "done", finishedAt: new Date().toISOString(), report });

    // Tier 3 regenerated here, because §11's confirmation is a state transition and Rule 4 says the
    // handoff is "regenerated on transition" — and because the failed roles are blockers a reader needs.
    try { taskHandoff(taskId, { reason: "state-transition" }); } catch (err) {
      logger.warn?.(`[supervisor] assignTask ${taskId}: handoff regeneration failed (non-fatal): ${err.message}`);
    }
    // Rule 5, Phase 8: deliberately NOT an `applyClearPolicy` call site, unlike `approveTaskLocked`'s and
    // `mergeTask`'s otherwise-identical `taskHandoff` calls. Every run this transition could apply to
    // (`started`) was spawned in THIS SAME call, moments ago — a brand-new process has no context to
    // clear, so wiring this site would be a call that always resolves to nothing, not a real trigger.

    return { taskId, plan, ...report };
  }

  /**
   * createUtilityTask({ type, title, teamId, actor }) -> one call for the whole utility-task lane
   * dispatch (PLAN.md §16.2) — item 13's own "not built, deliberately out of scope" note named exactly
   * this gap: creating the task, minting its one worker, and assigning it were three separate calls a
   * caller had to make itself, in the right order, with the right role name. This is a thin composition
   * in front of `assignTask` — the same idempotency, partial-start compensation and terminal-task guard
   * apply, because this calls it rather than reimplementing any part of it.
   */
  async function createUtilityTask({ type, title, teamId = null, actor = "operator", overrides = {}, cwd = null, allowDegradedMcp = false } = {}) {
    if (!type) throw new Error("createUtilityTask: type is required");
    if (!title) throw new Error("createUtilityTask: title is required");
    const roles = rolesFor(type);
    if (roles.length !== 1 || !UTILITY_TASK_PRESETS[roles[0]]) {
      throw new Error(
        `createUtilityTask: "${type}" is not a utility task type `
        + `(have: git-push-task, jira-task, awsquery-task, slack-task)`,
      );
    }
    const role = roles[0];
    const taskId = `t-${type}-${randomUUID().slice(0, 8)}`;
    const workerId = `w-${type}-${randomUUID().slice(0, 6)}`;
    createTask(database, { id: taskId, title, type, teamId });
    createWorker(database, { workerId, nickname: role, role, teamId, taskId });
    const assigned = await assignTask(taskId, { actor, overrides, ...(cwd ? { cwd } : {}), allowDegradedMcp });
    return { taskId, workerId, role, ...assigned };
  }

  /**
   * Does this plan satisfy the review profile's `modelDiversity`?
   *
   * `require-distinct-harness` means the reviewers must not all be on one harness. The evidence for the rule
   * is in section 13 and is unusually direct: the four independent reviews that produced PLAN.md's own
   * revision ran on two harnesses, and "the highest-value individual findings each appeared in exactly one of
   * them". Homogeneous reviewers agree more and find less.
   */
  function checkModelDiversity(taskId, plan) {
    let profile;
    try { ({ profile } = reviewProfileForTask(taskId)); } catch { return { violation: false, reason: null }; }
    if (profile?.modelDiversity !== "require-distinct-harness") return { violation: false, reason: null, required: false };
    const reviewers = plan.slots.filter((s) => s.role === "reviewer" || s.role === "parentReviewer");
    const harnesses = new Set(reviewers.map((s) => s.harnessId));
    if (reviewers.length < 2 || harnesses.size > 1) {
      return { violation: false, required: true, harnesses: [...harnesses] };
    }
    return {
      violation: true,
      required: true,
      harnesses: [...harnesses],
      reason: `review profile "${profile.id}" requires distinct reviewer harnesses, but ${reviewers.length} reviewer(s) `
        + `are all on "${[...harnesses][0]}" — homogeneous reviewers agree more and find less (PLAN.md section 13)`,
    };
  }

  /** What the assignment step would do, without doing it — what §11's picker shows pre-filled. */
  function assignmentPreview(taskId, { overrides = {} } = {}) {
    const task = database.prepare(`SELECT id, type, team_id FROM tasks WHERE id = ?`).get(taskId);
    if (!task) throw new Error(`assignmentPreview: no such task ${taskId}`);
    const workers = database
      .prepare(`SELECT worker_id AS workerId, nickname, role FROM workers WHERE task_id = ?`)
      .all(taskId);
    const openRunWorkerIds = listRunsForDisplay(database, { openOnly: true }).map((r) => r.worker_id);
    const config = loadHarnessDefaults({ stateDir: stateDirOf() });
    return planAssignment({
      task: { id: task.id, type: task.type, teamId: task.team_id },
      workers, config, overrides, openRunWorkerIds,
    });
  }

  // ── harness onboarding via conformance (PLAN.md section 9) ──────────────────────────
  //
  // Section 9 replaced runtime code-generation for new harnesses with: declare a capability matrix,
  // pass a conformance suite, and only THEN flip `harnesses.status` to `active`. An adapter with no
  // usable matrix, or whose declared capabilities do not hold, lands in the `wrapper` (degraded)
  // tier -- which is always marked as such and never silently treated as equivalent.
  //
  // The status flip is the point. Before this, `upsertHarness` was called with whatever status the
  // caller felt like and nothing ever verified a claim, so "active" meant "someone typed active".

  /**
   * onboardHarness({ harnessId, spec }) -> the conformance report, with the tier persisted.
   *
   * The report is returned in full rather than just the tier, because "it failed" is not actionable
   * and "interrupt was declared 'turn' but the run did not survive it" is.
   */
  async function onboardHarness({ harnessId, spec, timeoutMs } = {}) {
    if (!harnessId) throw new Error("onboardHarness: harnessId is required");
    if (!spec?.cwd) throw new Error("onboardHarness: spec.cwd is required — a conformance run is a real run");
    const adapter = adapterFor(harnessId);

    const report = await runConformance(adapter, {
      harnessId,
      spec: { prompt: "Reply with the single word: ok", ...spec },
      ...(Number.isInteger(timeoutMs) ? { timeoutMs } : {}),
    });

    // Persisted so nothing downstream has to re-run a real harness to find out whether it is
    // trusted. `capabilities` goes in beside the status: a tier without the declaration it was
    // derived from cannot be reviewed later.
    upsertHarness(database, {
      id: harnessId,
      displayName: harnessId,
      status: report.verdict.tier,
      capabilities: report.declared ?? null,
      onboardedAt: new Date().toISOString(),
    });

    if (!report.verdict.passed) {
      logger.warn?.(`[supervisor] harness ${harnessId} is DEGRADED (${report.verdict.tier}): ${report.verdict.reason}`);
    }
    return report;
  }

  /** The conformance report as text — what an operator reads before trusting a harness. */
  function conformanceReport(report) {
    return formatReport(report);
  }

  // ── adopting a session a HUMAN started (ROADMAP Phase 3, migration 0007) ────────────
  //
  // The supervisor normally spawns and owns everything it knows about. This is the other case: a
  // person ran `claude` in their own terminal and a hook in that session reports it, so the
  // dashboard can SEE it. ROADMAP is explicit that this is the only thing a hook is needed for --
  // "if the supervisor spawns and owns a process, it already knows that process's status".
  //
  // WHAT AN ADOPTED RUN CANNOT DO, stated because pretending otherwise would be the overclaim the
  // conformance matrix exists to prevent: there is no stdio, so no `observe()`, no `sendInput`, no
  // `interrupt`, and no approval round trip. A session started by hand answers its own permission
  // prompts in its own terminal, where the person already is. Adoption buys VISIBILITY, not control.
  //
  // The hook is a CLIENT over the socket (PLAN.md section 4: "nothing else talks to SQLite
  // directly"). That is what removes the write-conflict class ROADMAP mentions -- hooks never write.

  /**
   * adoptSession({ harnessId, sessionId, cwd, pid, transcriptPath, workerId }) -> the run row.
   *
   * Idempotent on (harnessId, sessionId): a `SessionStart` hook can fire more than once for one
   * session (`source` has values beyond `startup`, e.g. a resume), and a second report must find the
   * existing row rather than create a rival one claiming to be a different run.
   */
  async function adoptSession({ harnessId, sessionId, cwd, pid, transcriptPath = null, workerId } = {}) {
    if (!harnessId) throw new Error("adoptSession: harnessId is required");
    if (!sessionId) throw new Error("adoptSession: sessionId is required — it is the identity of the thing being adopted");
    if (!workerId) throw new Error("adoptSession: workerId is required (which worker does this session belong to?)");

    const existing = findAdoptedRun(database, { harnessId, sessionId });
    if (existing) return { runId: existing.run_id, adopted: false, reason: "already adopted" };

    // Verified against the OS, not trusted from the hook. The hook reports a pid it read from its
    // own environment, and a pid alone is not an identity -- pgid and start time are what make a
    // later `readProcInfo` able to tell "still the same process" from "that pid was reused". This is
    // the same standard `spawnManaged` holds its own children to.
    let identity = { pid: null, pgid: null, lstart: null };
    if (Number.isInteger(pid) && pid > 0) {
      const info = await readProcInfo(pid);
      if (!info.alive) {
        return { adopted: false, reason: `pid ${pid} is not alive; refusing to adopt a session that is already gone` };
      }
      identity = { pid, pgid: info.pgid, lstart: info.lstart };
    }

    const runId = `adopted_${randomUUID()}`;
    // ONE TRANSACTION, and this is a safety property rather than tidiness.
    //
    // These used to be two statements. `createRun` defaults `lifecycle` to 'managed' (migration 0003)
    // and `markRunAdopted` then sets it to 'adopted' — so a crash BETWEEN them left an open row with
    // `started_by = 'hook'`, a verified pid, no handle, and `lifecycle = 'managed'`. On the next boot
    // reconciliation reads that as an orphan, relabels it `orphaned-unmanaged`, and `reap` proceeds:
    // the adopted-session refusal keys on `lifecycle`, which the row no longer had.
    //
    // REPRODUCED, and it kills the process: with a complete identity the reap returned
    // `reaped: true` and the stand-in for the person's session was gone. The only reason it survived
    // the first attempt is that `createRun` does not record `proc_lstart`, so reap's
    // incomplete-identity refusal happened to fire first — an accident of a DIFFERENT guard, not
    // design. Found by big-pickle's review of Phases 3-5.
    database.transaction(() => {
      createRun(database, {
        runId,
        workerId,
        harnessId,
        harnessSessionId: sessionId,
        // 0008: reported by a hook, not started by us. The value the reaper must never act on.
        startedBy: "hook",
        // A prompt we never saw. Recording the truth rather than a placeholder that reads like content.
        prompt: "[adopted session — the dashboard did not start this and has no prompt for it]",
        pid: identity.pid,
        processGroup: identity.pgid,
      });
      markRunAdopted(database, runId, { ...identity, transcriptPath, cwd });
    })();

    logger.log?.(`[supervisor] adopted ${harnessId} session ${sessionId} as ${runId} (pid ${identity.pid ?? "unknown"})`);
    return { runId, adopted: true, ...identity, transcriptPath };
  }

  /**
   * releaseSession({ harnessId, sessionId, reason }) -> closes an adopted run.
   *
   * The other end of the hook pair. Closing on a report rather than waiting for reconciliation to
   * notice the process is gone means the dashboard stops showing a finished session as live -- and
   * reconciliation remains the backstop for a session whose hook never fired, which is the case a
   * crashed terminal produces.
   */
  function releaseSession({ harnessId, sessionId, reason = "released" } = {}) {
    const row = findAdoptedRun(database, { harnessId, sessionId });
    if (!row) return { released: false, reason: `no adopted session ${sessionId} for ${harnessId}` };
    if (row.ended_at) return { released: false, runId: row.run_id, reason: "already closed" };
    const closed = endRun(database, row.run_id, { exitReason: reason });
    if (closed) {
      closeOpenAsksForRun(database, row.run_id, { reason });
      reconcileAutoBlockedTasks();
      scheduleAttachmentDetach(row.run_id);
    }
    return { released: closed === 1, runId: row.run_id };
  }

  /** Every adopted session the dashboard currently believes is live. */
  function adoptedSessions() {
    return listAdoptedRuns(database).map((r) => ({
      runId: r.run_id,
      harnessId: r.harness_id,
      sessionId: r.harness_session_id,
      workerId: r.worker_id,
      pid: r.pid,
      processGroup: r.process_group,
      transcriptPath: r.transcript_path,
      adoptedAt: r.adopted_at,
      startedAt: r.started_at,
      // Stated on every row, because the difference between an adopted and a managed run is the
      // whole point and a UI that showed them identically would invite an operator to try to
      // interrupt something the supervisor cannot reach.
      controllable: false,
    }));
  }

  /**
   * Deterministic teardown. Bounded at every step, and in an order that matters: stop
   * consuming first (so no event arrives mid-dispose), then kill the harness processes
   * (including pooled `opencode serve` servers, which outlive their parent by design),
   * then close the database last so the disposal path can still write.
   */
  async function shutdown({ timeoutMs = 5000 } = {}) {
    const result = { pump: null, adapters: {}, dbClosed: false, timedOut: false, disposeTimedOut: false };

    // Stop the ask sweep before anything can close the database under it.
    if (askSweepTimer) {
      clearInterval(askSweepTimer);
      askSweepTimer = null;
    }

    // Two budgets, not one shared clock. Previously the pump wait and the whole shutdown
    // raced independent timers of comparable length, so a genuinely stuck consumer could
    // burn the entire budget and `adapter.disposeAll()` — the step that actually kills
    // harness processes and pooled `opencode serve` servers — was never started, or was
    // started and not awaited, while `closeDb()` ran anyway. Killing processes is the part
    // that must not be skippable, so it gets a floor of its own.
    const pumpBudget = Math.max(1, Math.min(2000, Math.floor(timeoutMs * 0.4)));
    const disposeBudget = Math.max(1, timeoutMs - pumpBudget);

    result.pump = await withTimeout(pump.closeAll({ timeoutMs: pumpBudget }), pumpBudget + 250, null);
    if (result.pump === null) result.timedOut = true;

    const dispose = (async () => {
      for (const [harnessId, adapter] of Object.entries(adapters)) {
        if (!adapter.disposeAll) continue;
        try {
          result.adapters[harnessId] = await adapter.disposeAll();
        } catch (err) {
          result.adapters[harnessId] = { error: String(err?.message ?? err) };
        }
      }
      // review-sol-2026-09-13.md finding 22 (shutdown half): pooled MCP processes were never disposed
      // on shutdown at all — this call, BEFORE `closeDb()` below, is what closes that gap. Same
      // best-effort, never-block-teardown-on-a-write-failure discipline `mcp-pool.js`'s own `disposeAll`
      // already applies internally.
      try {
        result.mcpPool = await mcpPool.disposeAll();
      } catch (err) {
        result.mcpPool = { error: String(err?.message ?? err) };
      }
      return true;
    })();
    // Still bounded — an adapter that hangs forever must not hold the daemon open — but
    // bounded on its own budget rather than on whatever the pump left over.
    if ((await withTimeout(dispose, disposeBudget, false)) === false) {
      result.disposeTimedOut = true;
      result.timedOut = true;
    }

    if (ownsDb) {
      closeDb(database);
      result.dbClosed = true;
    }
    return result;
  }

  /** Race a promise against a cleared timer, resolving `fallback` if the timer wins. The
   * `clearTimeout` matters: an abandoned timer keeps the event loop alive for its full
   * duration, which turns a fast clean shutdown into a multi-second one. */
  async function withTimeout(promise, ms, fallback) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((r) => {
          timer = setTimeout(() => r(fallback), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The map handed to createIpcServer({ commands }). Every handler returns the response
   * object the server writes; `observe` returns null because it writes its own frames.
   */
  /**
   * A run's events -> transcript lines, with CONSECUTIVE `assistant.delta` events joined.
   *
   * Only `assistant.delta` coalesces, and only when adjacent — the same rule the pane follows
   * (runtime/FINDINGS.md §19: "so prose reads as prose and everything else is a discrete row").
   * Without it a turn renders one fragment per line ("echo:dem" / "o work f" / "or w-lint"), which is
   * what the demo showed and is the whole reason to look at a UI rather than only test it.
   */
  function collapseTranscript(rows) {
    const out = [];
    let prose = null;
    const flushProse = () => {
      if (prose !== null) { const t = prose.replace(/\s+/g, " ").trim(); if (t) out.push(t); prose = null; }
    };
    for (const e of rows) {
      if (e.type === "assistant.delta") {
        let p = null;
        try { p = e.payload_json ? JSON.parse(e.payload_json) : null; } catch { /* unparseable */ }
        prose = (prose ?? "") + (p?.text ?? "");
        continue;
      }
      flushProse();
      out.push(renderEventLine(e));
    }
    flushProse();
    return out;
  }

  /**
   * One run's transcript SINCE A CURSOR, plus the new cursor and whatever gap there was.
   *
   * This is the replay-by-cursor half of FLOWS §5, in the form a polling client can use: the TUI holds
   * `{ runId -> lastSeq }`, sends it, and appends what comes back. Switching to a pane therefore resumes
   * where that pane left off instead of re-reading a fixed window, and a gap is ANNOUNCED rather than
   * silently closed up.
   *
   * THE TRAILING-PROSE PROBLEM, and why the cursor is held back.
   *
   * `assistant.delta` events coalesce into one line, and a poll can land in the MIDDLE of a turn's
   * prose. Advancing the cursor past those deltas would emit half a sentence as a finished line and the
   * rest as a second line on the next tick — the "one fragment per line" defect the demo already found
   * (§28), arriving from a new direction. So the cursor stops at the last event that is NOT part of a
   * trailing run of deltas, and that unfinished prose is returned as a PROVISIONAL last line: the client
   * replaces it each tick until it settles. Same idea as the pane's `replacesPrevious`, for a client
   * that polls instead of streaming.
   */
  function transcriptSince(runId, afterSeq = 0, limit = 200) {
    const { rows, skipped } = listTier1EventsSince(database, runId, { afterSeq, limit });
    if (!rows.length) return { lines: [], provisional: null, cursor: afterSeq, skipped };

    let cut = rows.length;
    while (cut > 0 && rows[cut - 1].type === "assistant.delta") cut -= 1;
    const settled = rows.slice(0, cut);
    const trailing = rows.slice(cut);

    // The cursor is the last SETTLED event. When a whole batch is trailing prose it does not move at
    // all, which is correct: nothing in that batch is final yet.
    const cursor = settled.length ? settled[settled.length - 1].seq : afterSeq;
    const provisionalLines = trailing.length ? collapseTranscript(trailing) : [];
    return {
      lines: collapseTranscript(settled),
      // At most one line: a run of deltas coalesces into exactly one, and `null` means "nothing
      // in flight", which the client needs in order to clear a provisional line that has settled.
      provisional: provisionalLines[0] ?? null,
      cursor,
      skipped,
    };
  }

  /**
   * One event -> one transcript line for the TUI.
   *
   * Deliberately lossy and deliberately NOT the pane's renderer: the pane coalesces `assistant.delta`
   * into flowing prose because it is a reading surface, whereas a TUI pane is a few dozen lines of
   * situational awareness. Reusing the pane's renderer here would drag its cursor/gap machinery into a
   * read-only projection that has no cursor.
   */
  function renderEventLine(e) {
    let p = null;
    try { p = e.payload_json ? JSON.parse(e.payload_json) : null; } catch { /* unparseable payload */ }
    switch (e.type) {
      case "assistant.delta": return (p?.text ?? "").replace(/\s+/g, " ").trim();
      case "tool.start": return `· ${p?.toolName ?? "tool"}`;
      case "tool.result": return p?.isError ? "· tool failed" : "· tool ok";
      case "approval.request": return `⚑ needs approval: ${p?.toolName ?? "?"}`;
      case "turn.end": return `— turn ${p?.status ?? "ended"}`;
      case "worker.env": return `· env: ${p?.profile ?? "?"}`;
      // An unknown type is SHOWN, never dropped — the same rule the pane follows, and for the same
      // reason: the event set grows, and "ignore" must not come to mean "hide".
      default: return `· ${e.type}`;
    }
  }

  /**
   * Pending inbound requests, for the TUI's Requests panel (FLOWS §6a; PLAN.md section 14.4).
   *
   * READ-ONLY, and pending only. The panel is "collapsed by default when there are zero pending
   * requests; appears the moment one lands", so an empty list is the normal case and is what makes the
   * panel cost no screen space. Nothing here CREATES a request — the Slack inbound path that does is
   * still backlog, and a panel that could accept work nothing can produce would be a lie about what
   * exists. Reading the table means the panel is real the day rows appear, without a second change.
   */
  function pendingRequests({ limit = 20 } = {}) {
    return database
      .prepare(`SELECT id, type, channel, mentioned_handle, raw_text, posted_by, created_at
                  FROM requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?`)
      .all(limit)
      .map((r) => ({
        id: r.id,
        type: r.type,
        channel: r.channel,
        from: r.posted_by,
        mentioned: r.mentioned_handle,
        text: r.raw_text,
        createdAt: r.created_at,
      }));
  }

  /**
   * Review status per task that HAS one, for the TUI's review bar (PLAN.md section 13).
   *
   * Only tasks with at least one recorded verdict: a task nobody has reviewed has no review to report, and
   * evaluating the rule for every task on every tick would be work in proportion to the whole registry
   * rather than to what is actually under review.
   *
   * Errors are swallowed per task — a malformed profile must not blank the entire dashboard, and the review
   * bar's absence is a survivable degradation where a failed snapshot is not.
   */
  function reviewSummaries() {
    // Only tasks whose review is IN FLIGHT. This selected every task that had ever recorded a verdict, so an
    // approved task kept a review bar forever — and the TUI clears the bar by the task's ABSENCE from this
    // map, which meant `state.review` never went null in production however carefully the client handled it.
    // The clearing test passed because its fixture supplied an empty map by hand. Found by the Phase 6
    // review (sol), which also named that vacuity.
    const taskIds = database
      .prepare(
        `SELECT DISTINCT v.task_id FROM review_verdicts v
           JOIN tasks t ON t.id = v.task_id
          WHERE t.state NOT IN ('approved', 'merged', 'failed', 'cancelled', 'start-failed')`,
      )
      .all().map((r) => r.task_id);
    const out = {};
    for (const taskId of taskIds) {
      try {
        const s = reviewStatus(taskId);
        out[taskId] = {
          round: s.round,
          commitSha: s.commitSha,
          approved: s.approved,
          reasons: s.reasons,
          dimensions: s.dimensions,
          quorum: s.quorum,
          // The top few AND a real count. Sending only the slice and rendering `findings.length` meant the
          // bar said "5 finding(s)" for any number above five — a wrong number is worse than a truncated
          // list, because nothing about it looks truncated. Found by the Phase 6 review (sol).
          findings: s.findings.slice(0, 5),
          findingCount: s.findingCount ?? s.findings.length,
          profile: s.profile,
        };
      } catch (err) {
        logger.warn?.(`[supervisor] review summary for ${taskId} failed (non-fatal): ${err.message}`);
      }
    }
    return out;
  }

  /**
   * mergeTask(taskId) -> the `approved` -> `merged` transition, and nothing else.
   *
   * WHERE §6's HARD RULE AND §16's SENSITIVE CLASS TURN OUT TO BE THE SAME MECHANISM. Section 6 says `merged`
   * "requires an explicit human/senior approval gate — no autonomous merges, even with all reviews green", and
   * the state machine enforces that by demanding `humanApproved: true`. Until now that was a boolean a caller
   * passed, which is a promise rather than evidence.
   *
   * `task:merge` is in section 16's sensitive class, so reaching this command already required a second
   * principal's approval, bound to these exact arguments, single-use and expiring — recorded in
   * `sensitive_approvals` with who granted it and when. So `humanApproved` is now justified by an artifact:
   * the flag is set here because the authorization layer has already proven a human (or the CTO, the only
   * other holder of `approve:sensitive`) approved THIS merge.
   *
   * It does not touch git. Merging code is the `git-create-push` agent's job (§16's roster); this moves the
   * task, which is the part the supervisor owns.
   */
  function mergeTask(taskId, { actor = "owner", approvalId = null } = {}) {
    if (!taskId) throw new Error("mergeTask: taskId is required");
    const task = database.prepare(`SELECT id, state, title FROM tasks WHERE id = ?`).get(taskId);
    if (!task) throw new Error(`mergeTask: no such task ${taskId}`);
    recordTransition(database, {
      id: `tr-merge-${taskId}-${Date.now()}`,
      taskId,
      fromState: task.state,
      toState: "merged",
      actor,
      // Justified by the consumed approval, not asserted by the caller. See the note above.
      humanApproved: true,
    });
    try { taskHandoff(taskId, { reason: "state-transition" }); } catch (err) {
      logger.warn?.(`[supervisor] mergeTask ${taskId}: handoff regeneration failed (non-fatal): ${err.message}`);
    }
    // Rule 5, Phase 8: the coder's own run, if still open at merge time, gets one last state-transition
    // clear — `maybeClearRun` is a no-op if there is nothing open to clear, so this costs nothing when
    // the coder's run already ended before the merge (the common case).
    applyClearPolicy(taskId, { roles: ["coder"], trigger: "state-transition" })
      .catch((err) => logger.warn?.(`[supervisor] mergeTask ${taskId}: coder clear-policy failed (non-fatal): ${err.message}`));
    // ROADMAP.md Phase 9 — see `approveTaskLocked`'s identical outbox write for the full reasoning.
    try {
      writeOutboxEvent(database, {
        id: `outbox-merge-${taskId}-${Date.now()}`,
        eventType: "task-merged",
        payload: { taskId, title: task.title ?? null, actor },
      });
    } catch (err) {
      logger.warn?.(`[supervisor] mergeTask ${taskId}: outbox write failed (non-fatal): ${err.message}`);
    }
    return { taskId, merged: true, approvalId, from: task.state };
  }

  /**
   * Resolve a linked worktree's main repo root by asking git, rather than assuming a path convention.
   *
   * Used by `discardTaskWorktree`/`requestWorktree`, which only have a worktree path in hand (not the
   * original `repoPath` a caller supplied to `createTaskWorktree`) — `git worktree remove`/`git worktree add`
   * both need to run with the repo root as `cwd`, and re-deriving it via git is robust to whatever path
   * convention `createTaskWorktree` uses, rather than hard-coding "three `dirname()` calls up".
   */
  async function repoRootFromWorktree(worktreePath) {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
        cwd: worktreePath, encoding: "utf8", timeout: 10_000,
      });
      const raw = String(stdout).trim();
      const commonDir = path.isAbsolute(raw) ? raw : path.resolve(worktreePath, raw);
      return path.dirname(commonDir); // commonDir is "<repoRoot>/.git"
    } catch {
      return null;
    }
  }

  /**
   * createTaskWorktree(taskId, { repoPath, branch }) -> the shared per-task worktree (PLAN.md §7).
   *
   * ONE worktree per task, not one per session or run: a task's coder(s) and reviewer(s) are deliberately
   * looking at the same revision (§13's quorum on one commit), so every worker later assigned to the task
   * attaches to this same path through `assignTask`'s existing `cwd ?? task.worktree_id` fallback — nothing
   * downstream needs to change for that to work.
   *
   * `repoPath` is caller-supplied on purpose. `tasks.repo_id` exists in the schema but nothing anywhere reads
   * or writes it (checked, not assumed) — inventing a repo-path registry here would be a second, unrequested
   * design decision. This follows the same pattern `assignTask({ cwd })` already uses for the same reason.
   *
   * Idempotent: if the task already has a `worktree_id` and that path still exists on disk, this returns it
   * rather than re-running `git worktree add` — a retried `start`, or a caller that doesn't know whether an
   * earlier attempt actually landed, is safe to call again.
   */
  /**
   * Cross-process creation race, added 2026-09-11 (`codexdoc/review-phase7-uncommitted.md` finding 2,
   * blocking): two processes could both read `worktree_id = NULL` for the same task, both run real
   * `git worktree add` in parallel, and both get `created: true` back — Git's per-repo lock has nothing
   * to say about the per-TASK invariant "one worktree, one registered path." Fixed with the same
   * "claim a status marker before doing the real work, only the winner proceeds" pattern already proven
   * for `mcp-pool.js`'s `claimPoolSlot`: `claimTaskWorktreeSlot` reserves the slot with
   * `WORKTREE_CLAIM_PENDING` inside a `BEGIN IMMEDIATE` compare-and-swap, so exactly one caller ever runs
   * git for a given task at a time. A caller that loses the claim polls (bounded, ~2s total) for the
   * winner's real result rather than racing it or hanging forever.
   */
  // How long a PENDING claim can sit unfinalized before another caller is allowed to try recovering it
  // (`codexdoc/review-luna-2026-09-11.md` finding 6). Deliberately far above the poll budget below (a
  // real `git worktree add` has its own 30s timeout) — this is "the claimant probably crashed", not
  // "the claimant is slow."
  const STALE_WORKTREE_CLAIM_MS = 60_000;

  /** `.git/ctd-worktrees/<taskId>` is the one deterministic path every claimant for a given
   *  `(repoPath, taskId)` pair computes — used both by a normal claim and by stale-claim recovery to
   *  check whether a dead claimant's git work already landed before deciding whether to redo it. */
  function taskWorktreePath(resolvedRepoPath, taskId) {
    return path.join(resolvedRepoPath, ".git", "ctd-worktrees", taskId);
  }

  /** A real linked worktree has a `.git` FILE (not a repo) pointing back at the main repo's gitdir —
   *  cheap, local, no git invocation needed, sufficient to tell "the crashed claimant already finished"
   *  from "nothing happened yet." */
  function looksLikeRealWorktree(worktreePath) {
    try {
      return fs.existsSync(worktreePath) && fs.existsSync(path.join(worktreePath, ".git"));
    } catch {
      return false;
    }
  }

  async function runGitWorktreeAdd({ resolvedRepoPath, worktreePath, worktreeBranch }) {
    try {
      await execFileAsync("git", ["worktree", "add", "-b", worktreeBranch, worktreePath], {
        cwd: resolvedRepoPath, timeout: 30_000,
      });
      return { ok: true };
    } catch {
      // The branch may already exist — a prior partial attempt, or one created out of band — so retry
      // attaching to it before giving up, rather than treating "branch exists" as a hard failure.
      try {
        await execFileAsync("git", ["worktree", "add", worktreePath, worktreeBranch], {
          cwd: resolvedRepoPath, timeout: 30_000,
        });
        return { ok: true };
      } catch (err2) {
        return { ok: false, error: err2 };
      }
    }
  }

  async function createTaskWorktree(taskId, { repoPath, branch, principal = null } = {}) {
    if (!taskId) throw new Error("createTaskWorktree: taskId is required");
    // review-sol-2026-09-13.md finding 2 (create side): same ownership boundary as `discardTaskWorktree`
    // below — a worker/reviewer principal may create a worktree only for the task it is assigned to.
    if (principal?.workerId) {
      const assignedTaskId = database.prepare(`SELECT task_id FROM workers WHERE worker_id = ?`).get(principal.workerId)?.task_id ?? null;
      if (assignedTaskId !== taskId) {
        return {
          ok: false, refused: "not-your-task",
          error: `principal is authenticated as worker ${principal.workerId}, assigned to task ${assignedTaskId ?? "(none)"}, `
            + `not ${taskId} — a worker may only create the worktree of its own currently-assigned task`,
        };
      }
    }
    if (!repoPath) {
      throw new Error(
        "createTaskWorktree: repoPath is required — there is no repo-path registry (tasks.repo_id is unused), "
        + "so the caller must say where the repo lives",
      );
    }
    // Canonicalized once, up front — this is both the identity a mismatch is checked against
    // (`codexdoc/review-luna-2026-09-11.md` finding 5) and the value persisted alongside the claim.
    const resolvedRepoPath = path.resolve(repoPath);

    const POLL_ATTEMPTS = 40;
    const POLL_INTERVAL_MS = 50;

    for (let attempt = 0; attempt <= POLL_ATTEMPTS; attempt += 1) {
      const task = database
        .prepare(`SELECT id, worktree_id, branch, worktree_repo_path FROM tasks WHERE id = ?`)
        .get(taskId);
      if (!task) throw new Error(`createTaskWorktree: no such task ${taskId}`);

      // Finding 5: a conflicting caller must be refused, not handed someone else's repo/branch as if it
      // were idempotent success — checked against BOTH an already-finalized worktree (below) and a
      // still-pending claim (further down), because the row now carries this identity from claim time.
      const repoMismatch = task.worktree_repo_path && task.worktree_repo_path !== resolvedRepoPath;
      const branchMismatch = branch && task.branch && branch !== task.branch;
      const mismatchResult = (kind) => ({
        ok: false, refused: kind,
        error: kind === "worktree-repo-mismatch"
          ? `task ${taskId}'s worktree is bound to ${task.worktree_repo_path}, not ${resolvedRepoPath} — `
            + "refusing to hand a conflicting caller a different repository's worktree"
          : `task ${taskId}'s worktree is bound to branch "${task.branch}", not "${branch}"`,
      });

      if (task.worktree_id && task.worktree_id !== WORKTREE_CLAIM_PENDING && fs.existsSync(task.worktree_id)) {
        if (repoMismatch) return mismatchResult("worktree-repo-mismatch");
        if (branchMismatch) return mismatchResult("worktree-branch-mismatch");
        return { taskId, worktreeId: task.worktree_id, branch: task.branch, created: false };
      }

      if (task.worktree_id === WORKTREE_CLAIM_PENDING) {
        if (repoMismatch) return mismatchResult("worktree-repo-mismatch");
        if (branchMismatch) return mismatchResult("worktree-branch-mismatch");

        // A DIFFERENT caller is claiming right now — wait for its result rather than racing it.
        if (attempt === POLL_ATTEMPTS) {
          // Finding 6: the poll budget alone can't tell "a real, still-running claimant" from "a dead
          // one" — a real `git worktree add` can legitimately take up to its own 30s timeout. Only
          // treat this as recoverable once the claim has sat unfinalized far longer than any real
          // attempt should.
          const staleBeforeIso = new Date(Date.now() - STALE_WORKTREE_CLAIM_MS).toISOString();
          const reclaim = reclaimStaleTaskWorktreeClaim(database, taskId, { staleBeforeIso });
          if (!reclaim.reclaimed) {
            return {
              ok: false, refused: "worktree-claim-pending",
              error: `another process is creating task ${taskId}'s worktree — retry shortly`,
            };
          }

          // We now own the previously-stale claim, under a FRESH token (finding 9) — the original
          // claimant, if it wakes up later and still holds only its OLD token, can no longer finalize or
          // release this claim; only this reclaim's own `claimToken` can from this point on. The dead
          // claimant may have finished the real `git worktree add` before it died — check disk before
          // redoing work that already landed.
          const worktreeBranch = task.branch ?? branch ?? `ctd/${taskId}`;
          const worktreePath = taskWorktreePath(resolvedRepoPath, taskId);

          // review-consolidated-2026-09-14.md finding 3: the dead claimant might not have been a CREATE
          // at all — a `discardTaskWorktree` call can crash after `git worktree remove` (the directory is
          // genuinely, deliberately gone) but before finalizing to NULL. Without this check, seeing "no
          // directory" below reads identically to "a create never got that far" and this function's own
          // recovery would run `git worktree add`, REVERSING a completed, deliberate deletion. `op` is
          // whatever the DEAD claimant recorded when it claimed (see migration 0017) — a discard op with
          // no real directory on disk means the deletion already happened; refuse instead of redoing.
          if (reclaim.op === "discard" && !looksLikeRealWorktree(worktreePath)) {
            const finalizedAsDiscarded = finalizeTaskWorktreeSlot(database, taskId, {
              worktreeId: null, branch: null, repoPath: null, claimToken: reclaim.claimToken,
            });
            return {
              ok: false, refused: "worktree-was-discarded",
              error: `task ${taskId}'s worktree was already discarded by a crashed process (its claim just `
                + `recovered) — refusing to recreate a worktree that was deliberately deleted`
                + (finalizedAsDiscarded.finalized ? "" : "; the task row may still show a stale claim, investigate manually"),
            };
          }

          if (looksLikeRealWorktree(worktreePath)) {
            const finalizedAdopt = finalizeTaskWorktreeSlot(database, taskId, {
              worktreeId: worktreePath, branch: worktreeBranch, repoPath: resolvedRepoPath, claimToken: reclaim.claimToken,
            });
            // review-sol-2026-09-13.md finding 9's other half: a `finalized: false` here means a THIRD
            // party reclaimed this same claim out from under us (our own reclaim itself sat unfinalized
            // past the stale window) — retry rather than reporting success for a write that did not land.
            if (!finalizedAdopt.finalized) {
              return {
                ok: false, refused: "worktree-claim-superseded",
                error: `task ${taskId}'s worktree claim was reclaimed by another process before this adoption could finalize — retry`,
              };
            }
            return {
              taskId, worktreeId: worktreePath, branch: worktreeBranch, created: false,
              recoveredFromCrashedClaim: true,
            };
          }

          fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
          const added = await runGitWorktreeAdd({ resolvedRepoPath, worktreePath, worktreeBranch });
          if (!added.ok) {
            releaseTaskWorktreeClaim(database, taskId, { previousValue: null, claimToken: reclaim.claimToken });
            return { ok: false, error: added.error.message, refused: "git-worktree-add-failed" };
          }
          const finalizedRedo = finalizeTaskWorktreeSlot(database, taskId, {
            worktreeId: worktreePath, branch: worktreeBranch, repoPath: resolvedRepoPath, claimToken: reclaim.claimToken,
          });
          if (!finalizedRedo.finalized) {
            return {
              ok: false, refused: "worktree-claim-superseded",
              error: `task ${taskId}'s worktree claim was reclaimed by another process before this redo could finalize — retry`,
            };
          }
          return {
            taskId, worktreeId: worktreePath, branch: worktreeBranch, created: true,
            recoveredFromCrashedClaim: true,
          };
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      // `task.worktree_id` is NULL, or a stale path nothing exists at any more — attempt the claim.
      const worktreeBranch = branch ?? task.branch ?? `ctd/${taskId}`;
      const claim = claimTaskWorktreeSlot(database, taskId, {
        previousValue: task.worktree_id, repoPath: resolvedRepoPath, branch: worktreeBranch, op: "create",
      });
      if (!claim.claimed) {
        // Something changed between our read and our claim attempt (another claim landed, or a result
        // did) — re-read and decide again rather than assuming we permanently lost.
        continue;
      }

      // We hold the claim: we are the ONLY caller running git for this task right now.
      const worktreePath = taskWorktreePath(resolvedRepoPath, taskId);
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

      const added = await runGitWorktreeAdd({ resolvedRepoPath, worktreePath, worktreeBranch });
      if (!added.ok) {
        releaseTaskWorktreeClaim(database, taskId, {
          previousValue: task.worktree_id, previousBranch: task.branch, previousRepoPath: task.worktree_repo_path,
          claimToken: claim.claimToken,
        });
        return { ok: false, error: added.error.message, refused: "git-worktree-add-failed" };
      }

      const finalized = finalizeTaskWorktreeSlot(database, taskId, {
        worktreeId: worktreePath, branch: worktreeBranch, repoPath: resolvedRepoPath, claimToken: claim.claimToken,
      });
      if (!finalized.finalized) {
        // finding 9's other half: our own claim sat unfinalized long enough that a later caller's
        // `reclaimStaleTaskWorktreeClaim` minted a NEW token and took it over before this real `git
        // worktree add` (which just succeeded) could finalize. The work on disk is real and will be
        // discovered/adopted by whoever now holds the claim (`looksLikeRealWorktree`, above) — reporting
        // success here for a write that did not land would be the exact lie this fix exists to prevent.
        return {
          ok: false, refused: "worktree-claim-superseded",
          error: `task ${taskId}'s worktree claim was reclaimed by another process before this could finalize — retry`,
        };
      }
      return { taskId, worktreeId: worktreePath, branch: worktreeBranch, created: true };
    }

    // Unreachable in practice — the pending-poll branch above returns at its own budget — but a loop
    // that could theoretically fall through must not return `undefined`.
    return { ok: false, refused: "worktree-claim-timeout", error: `could not claim task ${taskId}'s worktree slot` };
  }

  /**
   * discardTaskWorktree(taskId) -> removes the shared worktree once the task no longer needs it.
   *
   * Refuses on a non-terminal task, the same "refuse rather than silently do something surprising" pattern
   * `reap` already uses for an adopted run — a worker or reviewer could still be attached to this path, and
   * removing it out from under a live run is exactly the accident §7's clean-vs-kill rule exists to prevent
   * elsewhere.
   */
  /** `git status --porcelain` against a worktree path — empty output means clean. Returns `false` (not
   *  dirty) if git itself can't answer, since a discard should not be blocked on an unreadable tree; the
   *  caller-facing consequence is the same "refuse rather than guess" posture as everywhere else here. */
  /**
   * review-sol-2026-09-13.md finding 7: this used to return a bare boolean, and its `catch` returned
   * `false` — meaning "clean" — for a `git status` failure OR timeout, not just a genuinely clean
   * worktree. `discardTaskWorktree`'s caller then ran `git worktree remove --force` on that "clean"
   * verdict, so a permissions error, repo corruption, or a slow disk authorized destroying real
   * uncommitted work that was never actually checked. Now returns one of three states so "could not
   * tell" is a distinguishable, refusable outcome rather than silently downgraded to "clean".
   */
  async function worktreeStatus(worktreePath) {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd: worktreePath, encoding: "utf8", timeout: 10_000,
      });
      return { state: String(stdout).trim().length > 0 ? "dirty" : "clean" };
    } catch (err) {
      return { state: "error", error: err.message };
    }
  }

  async function discardTaskWorktree(taskId, { actor = "owner", force = false, principal = null } = {}) {
    if (!taskId) throw new Error("discardTaskWorktree: taskId is required");
    // review-sol-2026-09-13.md finding 2: `task:worktree` is granted to `worker`/`reviewer` so a run can
    // `requestWorktree` its own overlay (that self-service case is already ownership-bound, see
    // `requestWorktree` above) — but `discardTaskWorktree` took ANY taskId with no ownership check at
    // all, so a worker assigned to task A could force-discard task B's worktree, and `force: true` was
    // reachable by a worker-backed principal at all. A worker/reviewer principal may act only on the
    // task it is CURRENTLY assigned to (`workers.task_id`), and may never pass `force: true` — that is
    // reserved for owner/CTO (no `workerId` on the principal), same boundary `requestWorktree` draws.
    if (principal?.workerId) {
      if (force) {
        return {
          ok: false, refused: "force-not-permitted",
          error: "a worker/reviewer principal may not force-discard a worktree — force is reserved for owner/CTO",
        };
      }
      const assignedTaskId = database.prepare(`SELECT task_id FROM workers WHERE worker_id = ?`).get(principal.workerId)?.task_id ?? null;
      if (assignedTaskId !== taskId) {
        return {
          ok: false, refused: "not-your-task",
          error: `principal is authenticated as worker ${principal.workerId}, assigned to task ${assignedTaskId ?? "(none)"}, `
            + `not ${taskId} — a worker may only discard the worktree of its own currently-assigned task`,
        };
      }
    }
    const task = database
      .prepare(`SELECT id, state, worktree_id, branch, worktree_repo_path FROM tasks WHERE id = ?`)
      .get(taskId);
    if (!task) throw new Error(`discardTaskWorktree: no such task ${taskId}`);
    if (!isTerminal(task.state)) {
      return {
        ok: false, refused: "not-terminal",
        error: `task ${taskId} is "${task.state}", not terminal — refusing to discard a worktree work may still be attached to`,
      };
    }
    if (!task.worktree_id) return { taskId, discarded: false, reason: "no worktree to discard" };
    // Someone else (a concurrent createTaskWorktree redo/adoption, or another discard that landed the
    // instant before this read) already holds the slot — `claimTaskWorktreeSlot`'s CAS is keyed on
    // `previousValue` matching the CURRENT row, so passing the pending marker itself through as
    // `previousValue` would incorrectly "succeed" at re-claiming an already-claimed slot and mint a
    // second, competing token. Refuse instead of racing it — UNLESS the claim has gone stale, in which
    // case a caller that only ever refused here forever is exactly review-consolidated-2026-09-14.md
    // finding 3's "permanently wedged discard": nothing but manual DB surgery could ever clear it, since
    // `reclaimStaleTaskWorktreeClaim` (before this fix) had exactly one caller — `createTaskWorktree`.
    if (task.worktree_id === WORKTREE_CLAIM_PENDING) {
      const staleBeforeIso = new Date(Date.now() - STALE_WORKTREE_CLAIM_MS).toISOString();
      const reclaim = reclaimStaleTaskWorktreeClaim(database, taskId, { staleBeforeIso });
      if (!reclaim.reclaimed) {
        return {
          ok: false, refused: "worktree-claim-conflict",
          error: `task ${taskId}'s worktree slot is already claimed by another in-flight create/discard — retry shortly`,
        };
      }
      // We now hold the previously-stale claim under a fresh token. Whatever the dead claimant was
      // doing, THIS call's own goal is always the same end state: no worktree, `worktree_id = NULL`.
      // `task.worktree_repo_path`/`task.branch` are the values recorded AT CLAIM TIME (migration 0014),
      // which for a legitimate crashed discard are the task's own real values, read and re-passed
      // unchanged by discard's own claim call below — that is what lets us reconstruct the real,
      // deterministic worktree path here even though `task.worktree_id` itself is just the marker.
      const recoveredWorktreePath = task.worktree_repo_path ? taskWorktreePath(task.worktree_repo_path, taskId) : null;
      if (recoveredWorktreePath && looksLikeRealWorktree(recoveredWorktreePath)) {
        const openRunsDuringRecovery = database.prepare(
          `SELECT r.run_id AS runId FROM runs r JOIN workers w ON r.worker_id = w.worker_id
            WHERE w.task_id = ? AND r.ended_at IS NULL`,
        ).all(taskId);
        if (openRunsDuringRecovery.length > 0) {
          // Leave the claim pending under our fresh token rather than releasing it back to a marker a
          // dead process no longer controls — a later retry (after this run ends, or after another
          // stale window) will reclaim it again and can proceed once it's actually safe to.
          return {
            ok: false, refused: "open-run",
            error: `task ${taskId} has ${openRunsDuringRecovery.length} open run(s) still assigned — `
              + "refusing to finish a crashed discard's removal while one is live; stop or reap them first",
          };
        }
        const recoveryRepoRoot = await repoRootFromWorktree(recoveredWorktreePath) ?? task.worktree_repo_path;
        try {
          await execFileAsync("git", ["worktree", "remove", "--force", recoveredWorktreePath], {
            cwd: recoveryRepoRoot, timeout: 30_000,
          });
        } catch (err) {
          return { ok: false, error: err.message, refused: "git-worktree-remove-failed" };
        }
      }
      // Either the directory never existed by the time we got here (the crashed process's own `git
      // worktree remove` already succeeded before it died) or we just finished removing it above —
      // either way, the end state is the same: finalize to NULL.
      const finalizedRecovery = finalizeTaskWorktreeSlot(database, taskId, {
        worktreeId: null, branch: null, repoPath: null, claimToken: reclaim.claimToken,
      });
      if (!finalizedRecovery.finalized) {
        return {
          ok: false, refused: "worktree-claim-superseded",
          error: `task ${taskId}'s worktree was removed on disk, but the claim was superseded before the `
            + "database could be finalized — the task row may still show a stale claim; investigate manually",
        };
      }
      return { taskId, discarded: true, actor, recoveredFromCrashedClaim: true };
    }

    // review-sol-2026-09-13.md finding 8: everything below used to be a plain check-then-act against
    // `task.worktree_id` with no reservation of its own — the open-run check, the clean/dirty check, and
    // `git worktree remove` could all observe a safe state and still race a CONCURRENT
    // `createTaskWorktree`/`assignTask` call landing in the same window, which uses `task.worktree_id`
    // (including mid-removal) as a spawn `cwd`. Claiming the slot with the SAME CAS `createTaskWorktree`
    // itself uses closes that: it flips `worktree_id` to the pending marker atomically, so a concurrent
    // `createTaskWorktree` sees `WORKTREE_CLAIM_PENDING` and polls (never a half-removed directory), and
    // `assignTask`'s `cwd: task.worktree_id` resolution — which cannot itself hold this claim — spawns
    // against the marker string and fails loudly instead of writing into a directory about to be deleted.
    const claim = claimTaskWorktreeSlot(database, taskId, {
      previousValue: task.worktree_id, repoPath: task.worktree_repo_path ?? null, branch: task.branch ?? null, op: "discard",
    });
    if (!claim.claimed) {
      return {
        ok: false, refused: "worktree-claim-conflict",
        error: `task ${taskId}'s worktree slot changed before discard could claim it (now: ${claim.currentValue ?? "(none)"}) `
          + "— another create/discard is in progress for this task, retry",
      };
    }
    const releaseClaim = () => releaseTaskWorktreeClaim(database, taskId, {
      previousValue: task.worktree_id, previousBranch: task.branch, previousRepoPath: task.worktree_repo_path,
      claimToken: claim.claimToken,
    });

    // TASK STATE AND RUN TERMINATION ARE SEPARATE MECHANISMS — `mergeTask` itself moves a task to
    // `merged` without stopping any run using it, so "terminal task state" was never actually the safety
    // backstop this function's comment above claimed. An open run can still be writing into this exact
    // worktree when the task above it is already cancelled/failed/merged. Found by both codex reviews
    // (`codexdoc/review-phase7-uncommitted.md` finding 3, `codexdoc/REVIEW-NOTES.md` finding 4), fixed
    // 2026-09-11. `runs` carries no task_id of its own (task attribution is via the worker's CURRENT
    // assignment) — same join `changedPathsFor`/other task-scoped run lookups already use.
    const openRuns = database.prepare(
      `SELECT r.run_id AS runId FROM runs r JOIN workers w ON r.worker_id = w.worker_id
        WHERE w.task_id = ? AND r.ended_at IS NULL`,
    ).all(taskId);
    if (openRuns.length > 0) {
      releaseClaim();
      return {
        ok: false, refused: "open-run",
        error: `task ${taskId} has ${openRuns.length} open run(s) still assigned (${openRuns.map((r) => r.runId).join(", ")}) — `
          + "terminal task state alone is not a filesystem-lifecycle lock; stop or reap them first",
      };
    }

    // The open-run check above protects a LIVE worker, not the DATA a dead one already produced —
    // `codexdoc/review-luna-2026-09-11.md` finding 8: a terminal task with no open run can still have an
    // uncommitted file sitting in its worktree, and the unconditional `--force` below deleted it with no
    // trace. Refuse by default; `force: true` is the explicit, named override, not a default no one chose.
    // Note: `force` reaching this point at all means the caller was owner/CTO — the check above already
    // refused it for a worker/reviewer principal.
    if (!force) {
      const status = await worktreeStatus(task.worktree_id);
      if (status.state !== "clean") {
        releaseClaim();
        return {
          ok: false, refused: status.state === "dirty" ? "worktree-dirty" : "worktree-status-unknown",
          error: status.state === "dirty"
            ? `task ${taskId}'s worktree has uncommitted changes — pass { force: true } to discard them anyway`
            : `could not determine whether task ${taskId}'s worktree is clean (${status.error}) — `
              + "refusing to discard on an unverified status; pass { force: true } to discard anyway",
        };
      }
    }

    const repoRoot = await repoRootFromWorktree(task.worktree_id);
    if (!repoRoot) {
      releaseClaim();
      return { ok: false, refused: "git-error", error: `could not resolve the repo root for ${task.worktree_id}` };
    }
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", task.worktree_id], {
        cwd: repoRoot, timeout: 30_000,
      });
    } catch (err) {
      releaseClaim();
      return { ok: false, error: err.message, refused: "git-worktree-remove-failed" };
    }

    const finalized = finalizeTaskWorktreeSlot(database, taskId, {
      worktreeId: null, branch: null, repoPath: null, claimToken: claim.claimToken,
    });
    if (!finalized.finalized) {
      // The claim sat unfinalized long enough (or was otherwise superseded) that this write did not
      // land — the git-level removal already happened, but reporting `discarded: true` here would claim
      // a database write that did not take effect.
      return {
        ok: false, refused: "worktree-claim-superseded",
        error: `task ${taskId}'s worktree was removed on disk, but the claim was superseded before the database `
          + "could be finalized — the task row may still show a stale worktree_id; investigate manually",
      };
    }

    return { taskId, discarded: true, actor };
  }

  /**
   * requestWorktree(runId, { reason }) -> an isolated OVERLAY worktree for one run (PLAN.md §7's explicit
   * opt-out from the task's shared worktree).
   *
   * The default is the task's ONE shared worktree, created by `createTaskWorktree`; this exists only for a
   * run that needs isolated testing/experimentation it does not want landing in the shared tree. `reason` is
   * required — §16's "never guess an underspecified request" — and logged to `agent_journal`, the same
   * "task history, not memory" log every other command already writes through `authorizedCommandHandlers()`,
   * so it is queryable later: which runs branched off for isolated work, and why. (That wrapper already
   * journals this call generically on every outcome; the extra call below mirrors `grantApproval`'s own
   * pattern of a SECOND, human-readable entry carrying detail the generic one does not capture — here, the
   * actual reason text, not just the command name and taskId.)
   *
   * Branches off the task's CURRENT HEAD, at a path alongside the shared worktree rather than nested inside
   * it, so discarding one never touches the other.
   */
  async function requestWorktree(runId, { reason, principal = null } = {}) {
    if (!runId) throw new Error("requestWorktree: runId is required");
    if (!reason) {
      return { ok: false, refused: "missing-reason", error: "a reason is required for an isolated worktree request" };
    }
    // Cross-run ownership binding, added 2026-09-11 (`codexdoc/review-phase7-uncommitted.md` finding 4):
    // a worker-backed principal may only request an overlay for ITS OWN run — without this, worker A's
    // token could request (and later be journaled as the requester of) an overlay for worker B's run. A
    // principal with no `workerId` (owner/CTO) is unrestricted — that delegation question is deliberately
    // not decided here, same boundary `recordVerdict`'s sibling fix drew.
    if (principal?.workerId && workerIdForRun(database, runId) !== principal.workerId) {
      return {
        ok: false, refused: "not-your-run",
        error: `principal is authenticated as worker ${principal.workerId}, which does not own run ${runId} — `
          + "a worker may only request an overlay for its own run",
      };
    }

    const taskId = taskIdForRun(database, runId);
    if (!taskId) return { ok: false, refused: "no-task", error: `no task found for run ${runId}` };
    const task = database.prepare(`SELECT id, worktree_id FROM tasks WHERE id = ?`).get(taskId);
    if (!task?.worktree_id) {
      return { ok: false, refused: "no-shared-worktree", error: `task ${taskId} has no shared worktree yet — create one first` };
    }

    const repoRoot = await repoRootFromWorktree(task.worktree_id);
    if (!repoRoot) {
      return { ok: false, refused: "git-error", error: `could not resolve the repo root for ${task.worktree_id}` };
    }

    const overlayPath = path.join(repoRoot, ".git", "ctd-overlays", runId);
    // A DIFFERENT top-level ref namespace than the task branch (`ctd/<taskId>`), not a child of it: git
    // refs are a filesystem-like hierarchy, so `refs/heads/ctd/<taskId>/overlay-<runId>` cannot coexist
    // with `refs/heads/ctd/<taskId>` — "cannot lock ref ... refs/heads/ctd/<taskId> exists" (measured, not
    // assumed; hit this exact collision while building this).
    const overlayBranch = `ctd-overlay/${taskId}/${runId}`;
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });

    try {
      await execFileAsync("git", ["worktree", "add", "-b", overlayBranch, overlayPath, "HEAD"], {
        cwd: task.worktree_id, timeout: 30_000,
      });
    } catch (err) {
      return { ok: false, error: err.message, refused: "git-worktree-add-failed" };
    }

    if (principal) {
      const hash = argsHash({ runId, reason });
      journalAppend(database, {
        principalId: principal.id, action: "task:worktree", argsSha256: hash, taskId,
        argsPreview: `requestWorktree ${runId}: ${reason}`.slice(0, 200), outcome: "done", detail: reason,
      });
    }

    return { runId, taskId, worktreePath: overlayPath, branch: overlayBranch, sharedWorktreePath: task.worktree_id };
  }

  /**
   * gitCreatePush(taskId, { runId, principal, message, remote, targetBranch, ttlMs }) -> PLAN.md §8 Rule
   * 2's `push()` contract (Phase 7 step 5, 2026-09-10): `{ status: 'pushed'|'blocked'|'failed', mrUrl?,
   * attempts, unresolved? }`.
   *
   * The actual stage/commit/classify/autofix/push mechanics live in `agents/git-create-push.js`'s
   * `runFightLoop` — pure with respect to the database, so it's testable against a real repo with no
   * supervisor at all. This function is the glue: resolve the task's shared worktree (§7), acquire
   * `git:identity` (§20) BEFORE anything else, run the loop, and release the lease in a `finally` no
   * matter how the loop ends — a thrown error mid-loop must not leave `git:identity` held until its TTL
   * sweep catches up, the same reasoning `endRun`'s lease release exists for on the run side.
   *
   * TWO WIRE COMMANDS CALL THIS, `gitPush` and `gitPushProtected` — see `agents/git-create-push.js`'s own
   * header for why the protected/non-protected split is which command you call, not a flag in here.
   *
   * `mrUrl` is never set here — opening a PR/MR needs real credentials and network, which is exactly the
   * class of thing this project keeps out of `npm test` (see `real-*.slice.mjs` elsewhere in this repo).
   * `real-git-create-push.slice.mjs` is the manual-run counterpart for a human to exercise that path
   * against a real sandbox repo.
   */
  async function gitCreatePush(taskId, {
    runId = null, principal = null, message, remote = "origin", targetBranch = null, ttlMs, paths = null,
  } = {}) {
    if (!taskId) throw new Error("gitCreatePush: taskId is required");
    if (!message) throw new Error("gitCreatePush: message is required");
    const task = database.prepare(`SELECT id, worktree_id FROM tasks WHERE id = ?`).get(taskId);
    if (!task) throw new Error(`gitCreatePush: no such task ${taskId}`);
    if (!task.worktree_id) {
      return {
        status: "failed",
        attempts: [],
        unresolved: {
          class: "hook-other",
          oneParagraphDiagnosis: `task ${taskId} has no shared worktree yet — create one with createTaskWorktree first.`,
          files: [],
        },
      };
    }

    const lease = acquireLease({
      resourceName: "git:identity", principal, runId, reason: `git-create-push:${taskId}`,
      ...(ttlMs ? { ttlMs } : {}),
    });
    if (!lease.granted) {
      const holder = lease.blockedBy?.[0];
      return {
        status: "blocked",
        attempts: [],
        unresolved: {
          class: "hook-other",
          oneParagraphDiagnosis: holder
            ? `git:identity is held by principal ${holder.principalId} (acquired ${holder.acquiredAt}) — retry once it is released.`
            : `git:identity could not be acquired (${lease.refused ?? "unknown reason"}) — retry later.`,
          files: [],
        },
      };
    }

    try {
      return await runFightLoop({ cwd: task.worktree_id, message, remote, targetBranch, paths });
    } finally {
      releaseLease({ leaseId: lease.lease.id, principal });
    }
  }

  /**
   * The declared-resources config (PLAN.md §20.1), read on demand — same reasoning as
   * `harness-defaults.js`: a human lowering `memoryHeadroomPercent` mid-session expects the very
   * next `acquireLease` to see it, not the next restart.
   */
  function resourcesConfig() {
    return loadResources({ stateDir: stateDirOf() });
  }

  /**
   * acquireLease({ resourceName, principal, runId, reason, ttlMs }) -> a claim, or a refusal naming
   * who holds it (PLAN.md §20). Claim-BEFORE-side-effect: the caller must call this before doing the
   * thing the lease protects, never after — the same rule every idempotency key in this codebase
   * already follows.
   *
   * §20.2's queue visibility, without a blocking wait: this is a multi-process daemon with no
   * in-process queue to block a caller's connection on, so a refusal is a NON-BLOCKING check that
   * names every current holder (`blockedBy`) rather than making the caller hang. There is no FIFO
   * "position" concept here on purpose — a `counted` resource is a semaphore, not a mutex queue, so
   * "3rd in line" is not a well-defined question when up to `capacity` holders can be admitted in any
   * order the moment one releases. A caller that needs to wait retries later (or the pane surfaces
   * `blockedBy` and lets a human decide), rather than this function inventing an ordering promise it
   * cannot keep for a semaphore.
   *
   * `host:heavy-job` specifically samples `os.freemem()`/`os.totalmem()` and REFUSES below the
   * configured headroom, rather than granting-with-a-warning: this resource exists to prevent the
   * exact OOM incident PLAN.md §20 documents, and a resource named for that purpose that still grants
   * under pressure would defeat its own point. The sampled numbers are surfaced either way (§20.3:
   * "a human sees the number, not just a refusal"), on the grant path too, so a healthy grant is
   * still informative about how much headroom is left.
   */
  function acquireLease({ resourceName, principal, runId = null, reason = null, ttlMs } = {}) {
    if (!resourceName) return { granted: false, refused: "missing-resource-name" };
    if (!principal) return { granted: false, refused: "no-principal" };
    // Cross-run ownership binding, added 2026-09-11 (`codexdoc/review-phase7-uncommitted.md` finding 4):
    // without this, worker A's token could acquire a lease "for" worker B's run — and since a lease is
    // released alongside the RUN it names (`endRun`), ending B's run would release A's lease while A
    // remained its recorded holder, an ownership mismatch the whole way through. A principal with no
    // `workerId` (owner/CTO) is unrestricted — same boundary `recordVerdict`'s sibling fix drew; that
    // delegation question is deliberately not decided here.
    if (runId && principal.workerId && workerIdForRun(database, runId) !== principal.workerId) {
      return {
        granted: false, refused: "not-your-run",
        error: `principal is authenticated as worker ${principal.workerId}, which does not own run ${runId} — `
          + "a worker may only acquire a lease naming its own run",
      };
    }
    const config = resourcesConfig();
    const declared = config.resources[resourceName];
    if (!declared) {
      return { granted: false, refused: "unknown-resource", error: `"${resourceName}" is not declared in resources.json (PLAN.md §20.1)` };
    }

    let memory = null;
    if (resourceName === "host:heavy-job") {
      const freeBytes = os.freemem();
      const totalBytes = os.totalmem();
      const freePercent = (freeBytes / totalBytes) * 100;
      memory = { freeBytes, totalBytes, freePercent, headroomPercent: config.memoryHeadroomPercent };
      if (freePercent < config.memoryHeadroomPercent) {
        return {
          granted: false, refused: "host-memory-pressure", memory,
          error: `free memory ${freePercent.toFixed(1)}% is below the configured headroom of `
            + `${config.memoryHeadroomPercent}% — refusing "host:heavy-job" to avoid the OOM incident §20 exists for`,
        };
      }
    }

    const result = tryAcquireLease(database, {
      resourceName, kind: declared.kind, capacity: declared.capacity ?? null,
      holderPrincipalId: principal.id, holderRunId: runId, reason, ttlMs,
    });
    return memory ? { ...result, memory } : result;
  }

  /** releaseLease({ leaseId, principal }) — refuses on a lease it does not hold, or one already released. */
  function releaseLease({ leaseId, principal } = {}) {
    if (!leaseId) return { released: false, refused: "missing-lease-id" };
    const lease = getLease(database, leaseId);
    if (!lease) return { released: false, refused: "no-such-lease" };
    if (!principal || lease.holderPrincipalId !== principal.id) {
      return { released: false, refused: "not-the-holder", error: "only the principal that acquired a lease may release it" };
    }
    return releaseLeaseRow(database, leaseId);
  }

  /** renewLease({ leaseId, principal, ttlMs }) — bumps the heartbeat/TTL of a live lease this principal holds. */
  function renewLease({ leaseId, principal, ttlMs } = {}) {
    if (!leaseId) return { renewed: false, refused: "missing-lease-id" };
    const lease = getLease(database, leaseId);
    if (!lease) return { renewed: false, refused: "no-such-lease" };
    if (!principal || lease.holderPrincipalId !== principal.id) {
      return { renewed: false, refused: "not-the-holder", error: "only the principal that acquired a lease may renew it" };
    }
    return renewLeaseRow(database, leaseId, { ttlMs });
  }

  /**
   * Grant a second-signature approval for one sensitive action on one set of arguments.
   *
   * The granter is resolved from a TOKEN, like every other principal, and `canGrantApproval` enforces the two
   * rules section 16 keeps: the granter must hold `approve:sensitive`, and **it cannot be the same principal**
   * — "no skip-level authority grants" is meaningless if the level can be its own.
   */
  function grantApproval({ granterToken, forPrincipal, action, args = {}, ttlMs = 15 * 60 * 1000 } = {}) {
    const granter = granterToken ? principalByTokenHash(database, sha256(granterToken)) : null;
    const allowed = canGrantApproval({ granter, forPrincipal });
    if (!allowed.ok) return { granted: false, refused: allowed.reason };
    if (!isSensitive(action)) {
      return { granted: false, refused: `"${action}" is not in the sensitive class, so it needs no approval` };
    }
    const target = getPrincipal(database, forPrincipal);
    if (!target) return { granted: false, refused: `no such principal ${forPrincipal}` };
    const id = `sa-${randomUUID().slice(0, 12)}`;
    const hash = argsHash(args);
    grantSensitiveApproval(database, {
      id, action, argsSha256: hash, forPrincipal, grantedBy: granter.id,
      // Expiring, because a decision made about a diff that has since changed is not a current decision — the
      // same reasoning that makes review verdicts revision-bound (§13).
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    });
    journalAppend(database, {
      principalId: granter.id, action: "approve:sensitive", argsSha256: hash,
      argsPreview: `granted ${action} to ${forPrincipal}`, outcome: "done",
    });
    return { granted: true, id, action, argsSha256: hash, expiresInMs: ttlMs };
  }

  function commandHandlers() {
    return {
      start: async (cmd) => {
        const { runId, harnessId, identity } = await start({
          harnessId: cmd.harnessId,
          workerId: cmd.workerId,
          spec: cmd.spec ?? {},
        });
        return { id: cmd.id, ok: true, runId, harnessId, identityVerified: !!identity?.verified };
      },
      sendInput: async (cmd) => ({ id: cmd.id, ok: true, ...(await sendInput(cmd.runId, cmd.input)) }),
      interrupt: async (cmd) => ({ id: cmd.id, ok: true, ...(await interrupt(cmd.runId)) }),
      stop: async (cmd) => ({ id: cmd.id, ok: true, ...(await stop(cmd.runId)) }),
      clearContext: async (cmd) => ({ id: cmd.id, ok: true, ...(await clearContext(cmd.runId)) }),
      resume: async (cmd) => ({ id: cmd.id, ok: true, ...(await resume(cmd.runId, { allowDegradedMcp: cmd.allowDegradedMcp === true })) }),
      // PLAN.md §7's clean-vs-kill rule, enforced (Phase 8) — see `resetSession`'s own doc comment.
      resetSession: async (cmd) => ({
        id: cmd.id, ok: true,
        ...(await resetSession(cmd.runId, {
          requestedAction: cmd.requestedAction, explicitKillConfirmed: cmd.explicitKillConfirmed === true,
          respawnSpec: cmd.respawnSpec ?? null,
        })),
      }),
      reap: async (cmd) => ({ id: cmd.id, ok: true, ...(await reap(cmd.runId)) }),
      list: async (cmd) => ({ id: cmd.id, ok: true, runs: list() }),
      orphans: async (cmd) => ({
        id: cmd.id,
        ok: true,
        orphans: orphans(),
        // The sightings journal on request only — history is usually larger than the answer.
        sightings: cmd.withSightings ? listOrphanSightings(database, cmd.runId ?? null) : undefined,
      }),
      status: async (cmd) => {
        const s = status(cmd.runId);
        if (!s) return { id: cmd.id, ok: false, error: `unknown runId: ${cmd.runId}` };
        return { id: cmd.id, ok: true, status: s };
      },
      reconcile: async (cmd) => {
        const reconciliation = await reconcileOnBoot({ db: database, hasHandle, logger });
        reconcileAutoBlockedTasks();
        return { id: cmd.id, ok: true, reconciliation };
      },

      /**
       * Every question a worker is currently blocked on. This is the command the tree badge
       * and the approval UI read; `runId` narrows it to one pane.
       */
      asks: async (cmd) => ({ id: cmd.id, ok: true, asks: asks({ runId: cmd.runId ?? null }) }),
      // PLAN.md 12.1. Exposed over the wire because the CTO and the settings surface are clients
      // of the supervisor like everything else (section 2) -- neither gets its own database handle.
      preflight: async (cmd) => ({
        id: cmd.id,
        ok: true,
        result: await preflight({
          harnessId: cmd.harnessId,
          workerId: cmd.workerId,
          cwd: cmd.cwd,
          model: cmd.model ?? null,
          ...(Number.isInteger(cmd.timeoutMs) ? { timeoutMs: cmd.timeoutMs } : {}),
        }),
      }),
      modelHealth: async (cmd) => ({ id: cmd.id, ok: true, health: listModelHealth(database) }),
      // Over the wire because tier 3's readers -- the CTO, leads, reviewers -- are clients of the
      // supervisor like everything else (section 2), and none of them holds a database handle.
      // Hooks reach these over the socket; they never touch SQLite (PLAN.md section 4).
      adoptSession: async (cmd) => ({ id: cmd.id, ok: true, ...(await adoptSession(cmd)) }),
      releaseSession: async (cmd) => ({ id: cmd.id, ok: true, ...releaseSession(cmd) }),
      adoptedSessions: async (cmd) => ({ id: cmd.id, ok: true, sessions: adoptedSessions() }),
      // ── the TUI's read surface (Phase 4) ───────────────────────────────────────────
      // One command rather than five, because the TUI redraws on a timer and five round trips per
      // tick is five chances to render a half-consistent picture: teams from one instant and workers
      // from the next. One snapshot is atomic enough to render from.
      //
      // READ-ONLY. The TUI is a client like the pane and the hooks (PLAN.md section 4) — every
      // mutation goes back as its own command.
      tuiSnapshot: async (cmd) => {
        const teams = database.prepare("SELECT id, name, hidden_from_top_bar AS h FROM teams ORDER BY name").all()
          .map((t) => ({ id: t.id, name: t.name, hiddenFromTopBar: !!t.h }));
        const tasks = database.prepare("SELECT id, title, team_id, state, type FROM tasks ORDER BY created_at").all()
          .map((t) => ({ id: t.id, title: t.title, teamId: t.team_id, state: t.state, type: t.type }));
        const workers = database.prepare("SELECT worker_id, nickname, role, task_id, team_id FROM workers ORDER BY nickname").all()
          .map((w) => ({ workerId: w.worker_id, nickname: w.nickname, role: w.role, taskId: w.task_id, teamId: w.team_id }));
        // Preflight runs are excluded from `list()` already; the transcript projection follows the
        // same rule for the same reason (migration 0005).
        //
        // REPLAY BY CURSOR (FLOWS §5). The client sends `cursors: { runId -> lastSeq }` and gets back
        // only what is new, plus the cursor to send next time and any gap. A client that sends no cursor
        // for a run gets a bounded backfill from the start — which is what a freshly switched-to pane
        // wants — and is told how much was left out.
        //
        // Tier 1 ONLY: `event_log` also holds tier-2 digests now (Rule 4), and a digest is a summary
        // written FOR AGENTS. Rule 4's hard rule is about the other direction, but showing a digest in a
        // human's pane would still be wrong — the human has the transcript it was made from, right there.
        // `tuiSnapshot` requires only `read:registry` (COMMAND_CAPABILITIES) so that a utility principal's
        // own registry-adjacent tooling can call it, but the transcript fields below hand over a worker's
        // RAW tier-1 output — the exact thing `observe:run` exists to gate (`observe`'s own capability).
        // `codexdoc/REVIEW-NOTES.md` finding 9: an AUTHENTICATED registry-only principal (any `utility:*`
        // preset, or the plain `worker` preset — neither holds `observe:run`) could call this command over
        // the real socket and get every run's transcript despite never holding the capability that gates
        // transcript access everywhere else. Checked in the PRODUCER, not left to the TUI's own rendering
        // to decide.
        //
        // NO principal at all (`cmd._principal` undefined) is UNRESTRICTED here — same boundary
        // `requestWorktree`'s cross-run binding fix already drew ("a principal with no workerId is
        // unrestricted — that delegation question is deliberately not decided here"): this only binds an
        // AUTHENTICATED principal to what it actually holds, it does not newly require authentication on a
        // caller that never had it (the raw, unauthenticated `commandHandlers()` map several existing
        // tests exercise directly, never through the real socket a real attacker would use).
        const canObserveTranscripts = !cmd._principal
          || (cmd._principal.capabilities ?? []).includes("observe:run");

        const cursorsIn = cmd.cursors ?? {};
        const transcriptLimit = Number.isInteger(cmd.transcriptLimit) && cmd.transcriptLimit > 0
          ? Math.min(cmd.transcriptLimit, 2000)
          : 200;
        const transcripts = {};
        const provisional = {};
        const cursors = {};
        const gaps = {};
        if (canObserveTranscripts) {
          for (const r of listRunsForDisplay(database, { openOnly: false })) {
            const after = Number.isInteger(cursorsIn[r.run_id]) ? cursorsIn[r.run_id] : 0;
            const slice = transcriptSince(r.run_id, after, transcriptLimit);
            transcripts[r.run_id] = slice.lines;
            provisional[r.run_id] = slice.provisional;
            cursors[r.run_id] = slice.cursor;
            if (slice.skipped) gaps[r.run_id] = slice.skipped;
          }
        }
        // The runs, projected for the TUI. NOT reused from `list()`: that projection has no
        // `workerId` and no `endedAt`, so a pane could never match a run to its worker and every pane
        // fell through to "empty" — found by looking at the rendered frame, which is what a demo mode
        // is for. Widening `list()` would have changed a contract several other callers depend on.
        // The last thing each run said, for FLOWS section 5's "last-active dev run (by most-recent-message,
        // unless pinned)". One grouped query rather than one per run: this runs on every tick.
        const lastEventAt = new Map(
          database.prepare(
            `SELECT run_id, MAX(ts) AS ts FROM event_log WHERE tier = 1 GROUP BY run_id`,
          ).all().map((r) => [r.run_id, r.ts]),
        );
        // Which harnesses are DEGRADED (PLAN.md §9: a `wrapper`-tier harness "is always explicitly marked
        // as such in the UI — never silently treated as equivalent to a real, conformance-passing
        // adapter"). Read from `harnesses.status`, which `onboardHarness` writes from the conformance
        // verdict, so the mark follows the measurement rather than a second list someone maintains.
        const harnessTier = new Map(
          database.prepare("SELECT id, status FROM harnesses").all().map((h) => [h.id, h.status]),
        );
        const runs = listRunsForDisplay(database).map((r) => ({
          runId: r.run_id,
          workerId: r.worker_id,
          // `?? started_at`, so a run that has said nothing is ordered by when it began rather than
          // sorting last forever -- a worker that has just started is the most recently active thing
          // on its task, not the least.
          lastEventAt: lastEventAt.get(r.run_id) ?? r.started_at,
          harnessId: r.harness_id,
          harnessTier: harnessTier.get(r.harness_id) ?? null,
          degraded: harnessTier.get(r.harness_id) === "wrapper",
          endedAt: r.ended_at,
          exitReason: r.exit_reason,
          lifecycle: r.lifecycle,
          // An adopted session is visible but not controllable (migration 0007) — the pane must say so
          // rather than showing its last output as if it were live.
          controllable: r.lifecycle !== "adopted",
        }));
        return {
          id: cmd.id, ok: true, teams, tasks, workers, transcripts, provisional, cursors, gaps, runs,
          requests: pendingRequests(),
          reviews: reviewSummaries(),
          asks: asks({ runId: null }).map((a) => ({ runId: a.runId, question: a.question ?? "(tool approval)" })),
        };
      },
      // The bottom chat bar. A stub that REFUSES rather than pretends: the CTO agent is Phase 6, and a
      // chat box that silently swallowed messages would be worse than one that says so.
      tuiChat: async (cmd) => {
        if (cmd.target === "cto") {
          return { id: cmd.id, ok: false, error: "the CTO agent does not exist yet (PLAN.md section 2, Phase 6) — this bar is wired, its recipient is not" };
        }
        // `listRunsForDisplay`, NOT `list()`: that projection carries no `workerId` and no `endedAt`, so
        // `r.workerId === cmd.target` was `undefined === "<id>"` and every direct message was refused
        // with "no open run for worker X". The identical defect was already fixed for the TUI's panes
        // (§28.4) and missed here, because the pure state tests assert the MODEL and never the wire.
        const runId = listRunsForDisplay(database, { openOnly: true })
          .find((r) => r.worker_id === cmd.target)?.run_id;
        if (!runId) return { id: cmd.id, ok: false, error: `no open run for worker ${cmd.target}` };
        await sendInput(runId, cmd.text);
        return { id: cmd.id, ok: true, runId };
      },
      onboardHarness: async (cmd) => ({
        id: cmd.id,
        ok: true,
        report: await onboardHarness({ harnessId: cmd.harnessId, spec: cmd.spec, timeoutMs: cmd.timeoutMs }),
      }),
      turnDigests: async (cmd) => ({ id: cmd.id, ok: true, digests: turnDigests(cmd.runId) }),
      // §11's "one picker, one config source, everywhere": every start-work path goes through these two
      // rather than calling `start()` its own way.
      // §13's review surface. `recordVerdict` is async because verification may call a model.
      // Fields listed explicitly rather than spreading `cmd`. The first version did `cmd.verdict ?? cmd`
      // to allow a nested payload, and `verdict` is ALSO a field name — so the string "approved" was passed
      // as the whole verdict object and the handler failed with "no such task undefined". A command whose
      // envelope key collides with one of its own fields has to be destructured, not forwarded.
      recordVerdict: async (cmd) => {
        const v = cmd.verdict && typeof cmd.verdict === "object" ? cmd.verdict : cmd;
        return {
          id: cmd.id, ok: true,
          ...(await recordVerdict({
            taskId: v.taskId, workerId: v.workerId, slot: v.slot, round: v.round,
            commitSha: v.commitSha, dimension: v.dimension, verdict: v.verdict, findings: v.findings,
            // The RESOLVED principal, same pattern `mergeTask`'s `actor` already uses — not from `v`,
            // which is exactly the payload a forged identity would try to smuggle it through.
            _principal: cmd._principal ?? null,
          })),
        };
      },
      reviewStatus: async (cmd) => ({
        id: cmd.id, ok: true,
        status: reviewStatus(cmd.taskId, { round: cmd.round ?? null, commitSha: cmd.commitSha ?? null }),
      }),
      reviewFindings: async (cmd) => ({ id: cmd.id, ok: true, ...reviewFindings(cmd.taskId, { round: cmd.round ?? null }) }),
      approveTask: async (cmd) => ({
        id: cmd.id, ok: true,
        // Same rule as `mergeTask`: the authenticated principal is the actor.
        result: await approveTask(cmd.taskId, {
          actor: cmd._principal?.id ?? cmd.actor ?? "cto",
          round: cmd.round ?? null, commitSha: cmd.commitSha ?? null,
        }),
      }),
      reviewProfiles: async (cmd) => ({ id: cmd.id, ok: true, profiles: listReviewProfiles(database) }),
      // §16's authorization surface. `mintPrincipal` takes a PRESET NAME, never a capability list — see
      // `mintNamedPrincipal` for why a caller-supplied set is how a caller grants itself authority.
      principals: async (cmd) => ({ id: cmd.id, ok: true, principals: listPrincipals(database, { includeRevoked: cmd.includeRevoked === true }) }),
      journal: async (cmd) => ({
        id: cmd.id, ok: true,
        entries: listJournal(database, { principalId: cmd.principalId ?? null, taskId: cmd.taskId ?? null, limit: cmd.limit ?? 100 }),
      }),
      mintPrincipal: async (cmd) => {
        const missing = requireArgs(cmd, ["preset"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        return { id: cmd.id, ok: true, ...mintNamedPrincipal({ preset: cmd.preset, displayName: cmd.displayName }) };
      },
      revokePrincipal: async (cmd) => {
        const missing = requireArgs(cmd, ["principalId"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        return { id: cmd.id, ok: true, ...revokePrincipal(database, cmd.principalId) };
      },
      // Sensitive (§16): reaching this handler at all means the authorization layer already consumed a second
      // principal's approval bound to this exact `taskId`.
      mergeTask: async (cmd) => {
        const missing = requireArgs(cmd, ["taskId"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        // The actor is the AUTHENTICATED principal when there is one. `cmd.actor` is accepted only in-process
        // (where there is no principal because the caller holds the supervisor object), and never in preference
        // to a resolved identity — an unverified string in the transition journal is a fiction that outlives the
        // request that told it.
        const actor = cmd._principal?.id ?? cmd.actor ?? "owner";
        return { id: cmd.id, ok: true, ...mergeTask(cmd.taskId, { actor }) };
      },
      // §7's worktree lifecycle (added 2026-09-10). `createTaskWorktree`/`discardTaskWorktree` operate on the
      // task's ONE shared worktree; `requestWorktree` is a run's explicit opt-out for isolated testing.
      createTaskWorktree: async (cmd) => {
        const missing = requireArgs(cmd, ["taskId", "repoPath"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        return {
          id: cmd.id, ok: true,
          ...(await createTaskWorktree(cmd.taskId, { repoPath: cmd.repoPath, branch: cmd.branch ?? null, principal: cmd._principal ?? null })),
        };
      },
      discardTaskWorktree: async (cmd) => {
        const missing = requireArgs(cmd, ["taskId"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        const actor = cmd._principal?.id ?? cmd.actor ?? "owner";
        return {
          id: cmd.id, ok: true,
          ...(await discardTaskWorktree(cmd.taskId, { actor, force: cmd.force === true, principal: cmd._principal ?? null })),
        };
      },
      requestWorktree: async (cmd) => {
        const missing = requireArgs(cmd, ["runId", "reason"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        return { id: cmd.id, ok: true, ...(await requestWorktree(cmd.runId, { reason: cmd.reason, principal: cmd._principal ?? null })) };
      },
      // §20's resource leases (added 2026-09-10). `_principal` is always the wrapper-resolved one
      // (`authorizedCommandHandlers`'s own note above `mergeTask`: a caller-supplied identity cannot
      // survive the spread) — the same reason the holder is never trusted from the raw command.
      acquireLease: async (cmd) => {
        const missing = requireArgs(cmd, ["resourceName"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        // Refused HERE as a clean `{ok:false}`, not left to the DB primitive's throw — a caller sending
        // a bad ttlMs gets the same refusal shape every other expected-refusal case in this handler
        // returns, not an exception. `tryAcquireLease` itself ALSO validates (defense in depth, per
        // review finding 5: "don't rely on just one layer" — this wire check is bypassable by any
        // direct in-process caller, the DB-level one is not).
        if (cmd.ttlMs !== undefined && (!Number.isInteger(cmd.ttlMs) || cmd.ttlMs <= 0 || cmd.ttlMs > MAX_LEASE_TTL_MS)) {
          return { id: cmd.id, ok: false, error: `ttlMs must be a positive integer no greater than ${MAX_LEASE_TTL_MS}ms, got ${JSON.stringify(cmd.ttlMs)}` };
        }
        const result = acquireLease({
          resourceName: cmd.resourceName, principal: cmd._principal ?? null, runId: cmd.runId ?? null,
          reason: cmd.reason ?? null, ...(cmd.ttlMs !== undefined ? { ttlMs: cmd.ttlMs } : {}),
        });
        return { id: cmd.id, ok: result.granted === true, ...result };
      },
      releaseLease: async (cmd) => {
        const missing = requireArgs(cmd, ["leaseId"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        const result = releaseLease({ leaseId: cmd.leaseId, principal: cmd._principal ?? null });
        return { id: cmd.id, ok: result.released === true, ...result };
      },
      renewLease: async (cmd) => {
        const missing = requireArgs(cmd, ["leaseId"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        // Same wire-level check as acquireLease, same reasoning — fixed 2026-09-11 (review finding 5).
        if (cmd.ttlMs !== undefined && (!Number.isInteger(cmd.ttlMs) || cmd.ttlMs <= 0 || cmd.ttlMs > MAX_LEASE_TTL_MS)) {
          return { id: cmd.id, ok: false, error: `ttlMs must be a positive integer no greater than ${MAX_LEASE_TTL_MS}ms, got ${JSON.stringify(cmd.ttlMs)}` };
        }
        const result = renewLease({
          leaseId: cmd.leaseId, principal: cmd._principal ?? null,
          ...(cmd.ttlMs !== undefined ? { ttlMs: cmd.ttlMs } : {}),
        });
        return { id: cmd.id, ok: result.renewed === true, ...result };
      },
      // §16's git-create-push agent (added 2026-09-10). Two commands, one fight loop
      // (`agents/git-create-push.js`'s own header explains why): `gitPush` needs only `git:push`;
      // `gitPushProtected` needs `git:push-protected`, which is SENSITIVE — reaching this handler at all
      // means the authorization wrapper already consumed a second principal's approval bound to these
      // exact arguments, the same guarantee `mergeTask` relies on for `task:merge`.
      gitPush: async (cmd) => {
        const missing = requireArgs(cmd, ["taskId", "message"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        // review-sol-2026-09-13.md finding 4: neither git command bound the CALLER to a task at all —
        // any worker-backed principal (including the git-utility runner ITSELF, if its token leaked or
        // its model was compromised) could name any task's worktree, not just the one it was actually
        // dispatched to work on. A worker/utility principal may push only the task it is currently
        // assigned to (`workers.task_id`); owner/CTO (no `workerId`) remain unrestricted, same boundary
        // `createTaskWorktree`/`discardTaskWorktree` already draw.
        if (cmd._principal?.workerId) {
          const assignedTaskId = database.prepare(`SELECT task_id FROM workers WHERE worker_id = ?`).get(cmd._principal.workerId)?.task_id ?? null;
          if (assignedTaskId !== cmd.taskId) {
            return {
              id: cmd.id, ok: false,
              error: `principal is authenticated as worker ${cmd._principal.workerId}, assigned to task ${assignedTaskId ?? "(none)"}, `
                + `not ${cmd.taskId} — a worker may only push the task it is currently assigned to`,
            };
          }
        }
        // Classify the ACTUAL destination server-side before doing anything else — which command a
        // caller invoked used to be the ONLY thing deciding whether a push needed `gitPushProtected`'s
        // second signature, so a caller could always choose the cheap path for a push that should have
        // required it. Found by both codex reviews, fixed 2026-09-11. `gitPushProtected` needs no
        // equivalent check: reaching ITS handler already required the sensitive approval regardless of
        // the destination, which is the strictly stricter path and is never the one being bypassed.
        const taskRow = database.prepare(`SELECT worktree_id FROM tasks WHERE id = ?`).get(cmd.taskId);
        // review-sol-2026-09-13.md finding 6: this classified `destination` and then passed the
        // CALLER'S ORIGINAL `targetBranch` (often null) through to `gitCreatePush` -> `runFightLoop`,
        // which — when given null — re-resolves the worktree's current branch INDEPENDENTLY at push
        // time via its own `rev-parse`. Anything that switched the worktree's checked-out branch
        // between this classification and that later push (another process, a concurrent operation)
        // meant the authorization decision above was made about a branch name that was no longer the
        // one actually pushed. Fixed: the classified `destination` is now PINNED as the explicit
        // `targetBranch` passed onward, so the fight loop's push step uses exactly the name that was
        // just checked against the protected list, never re-derives it from a HEAD that may have moved.
        let pinnedTargetBranch = cmd.targetBranch ?? null;
        if (taskRow?.worktree_id) {
          let destination;
          try {
            destination = await resolvePushDestination({ cwd: taskRow.worktree_id, targetBranch: cmd.targetBranch ?? null });
          } catch (err) {
            // Can't resolve the destination (a broken worktree, e.g.) -- fail closed rather than push
            // blind. `gitCreatePush` below will hit the same git call and report it properly either way.
            return { id: cmd.id, ok: false, error: `could not resolve the push destination: ${err.message}` };
          }
          const { branches: protectedBranches } = loadProtectedBranches({ stateDir: stateDirOf() });
          if (protectedBranches.includes(destination)) {
            return {
              id: cmd.id, ok: false,
              error: `"${destination}" is a protected destination — use gitPushProtected, which requires a second principal's approval`,
            };
          }
          pinnedTargetBranch = destination;
        }
        const result = await gitCreatePush(cmd.taskId, {
          runId: cmd.runId ?? null, principal: cmd._principal ?? null, message: cmd.message,
          remote: cmd.remote ?? "origin", targetBranch: pinnedTargetBranch, paths: cmd.paths ?? null,
        });
        return { id: cmd.id, ok: result.status === "pushed", ...result };
      },
      gitPushProtected: async (cmd) => {
        const missing = requireArgs(cmd, ["taskId", "message"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        // Same task-ownership boundary as `gitPush` above (finding 4) — reaching this handler already
        // required the sensitive second-signature approval, but that approves WHICH push, not whether
        // the caller was ever dispatched to this task's worktree at all.
        if (cmd._principal?.workerId) {
          const assignedTaskId = database.prepare(`SELECT task_id FROM workers WHERE worker_id = ?`).get(cmd._principal.workerId)?.task_id ?? null;
          if (assignedTaskId !== cmd.taskId) {
            return {
              id: cmd.id, ok: false,
              error: `principal is authenticated as worker ${cmd._principal.workerId}, assigned to task ${assignedTaskId ?? "(none)"}, `
                + `not ${cmd.taskId} — a worker may only push the task it is currently assigned to`,
            };
          }
        }
        const result = await gitCreatePush(cmd.taskId, {
          runId: cmd.runId ?? null, principal: cmd._principal ?? null, message: cmd.message,
          remote: cmd.remote ?? "origin", targetBranch: cmd.targetBranch ?? null, paths: cmd.paths ?? null,
        });
        return { id: cmd.id, ok: result.status === "pushed", ...result };
      },
      grantApproval: async (cmd) => {
        const missing = requireArgs(cmd, ["forPrincipal", "action"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        // The granter is the CALLER's own token, taken from the envelope — a caller cannot grant on behalf of
        // someone else, because there is nowhere to say so.
        const result = grantApproval({
          granterToken: cmd.token, forPrincipal: cmd.forPrincipal, action: cmd.action,
          args: cmd.args ?? {}, ...(Number.isInteger(cmd.ttlMs) ? { ttlMs: cmd.ttlMs } : {}),
        });
        return { id: cmd.id, ok: result.granted === true, ...result };
      },
      assignmentPreview: async (cmd) => ({
        id: cmd.id, ok: true, preview: assignmentPreview(cmd.taskId, { overrides: cmd.overrides ?? {} }),
      }),
      assignTask: async (cmd) => ({
        id: cmd.id, ok: true,
        result: await assignTask(cmd.taskId, {
          overrides: cmd.overrides ?? {},
          actor: cmd._principal?.id ?? cmd.actor ?? "operator",
          idempotencyKey: cmd.idempotencyKey ?? null,
          ...(cmd.cwd ? { cwd: cmd.cwd } : {}),
          allowDegradedMcp: cmd.allowDegradedMcp === true,
        }),
      }),
      // The utility-task lane's dispatch convenience (§16.2, item 13's own "not built" note) — one call
      // instead of createTask + createWorker + assignTask done separately, in the right order, by hand.
      createUtilityTask: async (cmd) => {
        const missing = requireArgs(cmd, ["type", "title"]);
        if (!missing.ok) return { id: cmd.id, ok: false, error: missing.reason };
        try {
          const result = await createUtilityTask({
            type: cmd.type, title: cmd.title, teamId: cmd.teamId ?? null,
            actor: cmd._principal?.id ?? cmd.actor ?? "operator",
            overrides: cmd.overrides ?? {}, cwd: cmd.cwd ?? null,
            allowDegradedMcp: cmd.allowDegradedMcp === true,
          });
          return { id: cmd.id, ok: true, ...result };
        } catch (err) {
          return { id: cmd.id, ok: false, error: err.message };
        }
      },
      taskHandoff: async (cmd) => ({
        id: cmd.id,
        ok: true,
        handoff: cmd.generate === false
          ? currentTaskHandoff(cmd.taskId)
          : taskHandoff(cmd.taskId, { reason: cmd.reason ?? "manual" }),
      }),

      /**
       * Answer one. Returns `answered` and `delivered` separately, on purpose: an answer that
       * was recorded but could not be handed to the worker is a real, distinguishable outcome
       * (the process died while a human was typing), and a client that treats "answered" as
       * "the worker has it" would show a run as unblocked while it is still parked.
       */
      answerAsk: async (cmd) => {
        try {
          // `codexdoc/REVIEW-NOTES.md` finding 6: `ask:answer` is on the plain `worker`/`reviewer`
          // presets (so a run is never stuck if its own principal disappears), but the wire handler
          // used to forward the caller's `answeredBy` verbatim, defaulting to "human" — a worker
          // could answer its OWN parked ask (a tool approval, or a question) and have that recorded
          // as if a human had decided it. Same cross-run ownership boundary `requestWorktree`/
          // `acquireLease` already draw: a WORKER-backed principal may not resolve a decision on the
          // run IT OWNS — that decision is what the ask exists to reserve for a human/CTO.
          const ask = getAsk(database, cmd.askId);
          if (!ask) return { id: cmd.id, ok: false, error: `unknown askId: ${cmd.askId}` };
          if (cmd._principal?.workerId && workerIdForRun(database, ask.run_id) === cmd._principal.workerId) {
            return {
              id: cmd.id, ok: false,
              error: `principal is authenticated as worker ${cmd._principal.workerId}, which owns run ${ask.run_id} — `
                + "a worker may not answer its own ask; that decision is reserved for a human/CTO",
            };
          }
          // review-sol-2026-09-13.md finding 3: the self-run check above closes ONE worker approving
          // its own parked ask, but said nothing about worker A deciding worker B's — and a
          // "tool-approval" ask (a side-effecting tool the harness itself parked for a decision, kind
          // "tool-approval" — see `createAsk`'s call site) is exactly the decision `ask:answer`'s own
          // preset comment says is "reserved for a human/CTO". A `kind: "worker"`/`"utility"` principal
          // may still answer a plain `"question"` ask (the collaborative-unblock case that capability
          // grant exists for), but never a tool-approval, regardless of whose run it is.
          if (ask.kind === "tool-approval" && (cmd._principal?.kind === "worker" || cmd._principal?.kind === "utility")) {
            return {
              id: cmd.id, ok: false,
              error: `principal ${cmd._principal.id} (${cmd._principal.kind}) may not decide a tool-approval ask — `
                + "that decision is reserved for a human/CTO regardless of which run raised it",
            };
          }
          // Attribution is DERIVED from the authenticated principal, never trusted from the request —
          // the same "nothing the decision reads from the request" rule already enforced elsewhere
          // (the capability set itself, `recordVerdict`'s workerId binding). A caller-supplied
          // `answeredBy` is honored only when there is NO principal at all — the unauthenticated
          // in-process path several existing tests call directly (`supervisor.answerAsk(...)`, not
          // through the wire), which this fix does not newly require authentication on.
          const answeredBy = cmd._principal
            ? (cmd._principal.kind === "human" ? "human" : cmd._principal.id)
            : (cmd.answeredBy ?? "human");
          // Awaited inside the try, so a rejected delivery becomes an `ok: false` reply rather
          // than an unhandled rejection that the client never hears about.
          return { id: cmd.id, ok: true, ...(await answerAsk(cmd.askId, { ...cmd, answeredBy })) };
        } catch (err) {
          return { id: cmd.id, ok: false, error: String(err?.message ?? err) };
        }
      },

      /**
       * Fan-out from the supervisor's own consumer — this connection gets its own cursor
       * and does NOT become the run's consumer. Ends when the run's stream ends, when the
       * peer disconnects (`signal`), or when teardown closes the run.
       */
      observe: async (cmd, { socket, safeWrite, signal }) => {
        const { id, runId } = cmd;
        if (!harnessOf(runId)) return { id, ok: false, error: `unknown runId: ${runId}` };
        try {
          for await (const frame of pump.subscribe(runId, { signal, fromSeq: cmd.fromSeq })) {
            if (socket.destroyed || signal?.aborted) break;
            if (frame.gap) safeWrite(socket, { id, gap: frame.gap, fromSeq: frame.fromSeq });
            else safeWrite(socket, { id, seq: frame.seq, event: frame.event });
          }
          if (!socket.destroyed && !signal?.aborted) safeWrite(socket, { id, ok: true, done: true });
        } catch (err) {
          safeWrite(socket, { id, ok: false, error: String(err?.message ?? err) });
        }
        return null;
      },
    };
  }

  return {
    db: database,
    pump,
    boot,
    harnessOf,
    hasHandle,
    start,
    stop,
    sendInput,
    interrupt,
    clearContext,
    resetSession,
    resume,
    reap,
    list,
    orphans,
    status,
    asks,
    answerAsk,
    deliverPendingAnswers,
    sweepAsks,
    preflight,
    discardPreflightRun,
    sweepPreflightRuns,
    modelHealth: () => listModelHealth(database),
    // Phase 7: capability-based authorization (PLAN.md §16)
    authorizedCommandHandlers,
    ensureOwnerPrincipal,
    ensureWorkerPrincipal,
    mintNamedPrincipal,
    principals: (opts) => listPrincipals(database, opts ?? {}),
    revokePrincipal: (id) => revokePrincipal(database, id),
    journal: (opts) => listJournal(database, opts ?? {}),
    journalHasDone: (q) => journalHasDone(database, q),
    grantApproval,
    mergeTask,
    createTaskWorktree,
    discardTaskWorktree,
    requestWorktree,
    acquireLease,
    releaseLease,
    renewLease,
    gitCreatePush,
    sweepLeases,
    listActiveLeases: (resourceName) => listActiveLeases(database, resourceName),
    importReviewProfiles,
    reviewProfiles: () => listReviewProfiles(database),
    reviewProfileForTask,
    recordVerdict,
    reviewStatus,
    reviewFindings,
    approveTask,
    assignTask,
    createUtilityTask,
    assignmentPreview,
    taskHandoff,
    currentTaskHandoff,
    taskHandoffHistory,
    turnDigests,
    onboardHarness,
    conformanceReport,
    adoptSession,
    releaseSession,
    adoptedSessions,
    shutdown,
    commandHandlers,
  };
}
