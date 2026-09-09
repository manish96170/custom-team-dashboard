// reconcile.js — startup reconciliation and the real `reap` command (TODO.md Group 5).
//
// PLAN.md section 4: "for every `runs` row not already terminal, verify PID + process
// group + start time actually match a live process", with three outcomes and not two:
//
//   lost                — verification fails outright; the process is genuinely gone.
//   orphaned-unmanaged  — verification PASSES (pid + pgid + start time all match) but no
//                         adapter handle is bound to it. Still running, no longer ours.
//   finished            — only ever written by the adapter's own completion path. This
//                         module never writes it; that is the invariant, not a detail.
//
// **`orphaned-unmanaged` is a lifecycle STATE, not a terminal outcome** (migration 0003,
// decided after Group 6). It was originally written as `ended_at` + `exit_reason`, which
// closed the row of a process this module had just verified to be RUNNING — and since the
// input set here is `ended_at IS NULL`, that made a live unmanaged process invisible to every
// later boot. Now the row stays open with `lifecycle = 'orphaned-unmanaged'`, is re-examined
// (and re-logged to `orphan_sightings`) on every boot, and gets its terminal write when
// something real happens: `lost` when the process dies, `reaped` when we kill it.
//
// What was missing before this file existed: `orphaned-unmanaged` was a dead-end state
// reachable only by `list`. Nothing could act on it, because there was no `reap` -- and
// no reap was possible, because the adapters spawned children into the SUPERVISOR's
// process group, so the recorded pgid was the supervisor's own and "kill this run's
// group" meant "kill the supervisor and every sibling run". runtime/spawn.js fixed the
// ownership; this file is the half that finally uses it.
//
// Two refusals here are load-bearing, and both are refusals to kill:
//
//   1. pid reuse. A recorded pid that is alive again as an unrelated process verifies
//      *live* on pid alone. `proc_lstart` (migration 0002) is what distinguishes them; a
//      start-time mismatch means the run is `lost` and the live stranger is left alone.
//   2. shared process groups. `opencode serve` is pooled per cwd, so several runs record
//      the same pgid. Killing that group to end one run would kill its siblings, so reap
//      refuses the group kill while any other open run shares the group and asks the
//      adapter to end just the session instead.

import { verifyProcIdentity, readProcInfo } from "./procinfo.js";
import { killProcessGroup } from "./spawn.js";
import {
  listOpenRuns,
  getRun,
  reconcileRun,
  markRunOrphaned,
  markRunReaped,
  closeOpenAsksForRun,
  endRun,
  listOpenRunsSharingProcessGroup,
} from "../db/index.js";

/** The two outcomes reconciliation is allowed to write. `finished` is deliberately absent. */
export const RECONCILE_OUTCOMES = Object.freeze(["lost", "orphaned-unmanaged"]);

/**
 * Classify one open run row. Pure: reads the OS and the adapter registry, writes nothing.
 *
 * @param {object} row a `runs` row
 * @param {{ hasHandle: (runId: string) => boolean }} ctx
 */
export async function classifyRun(row, { hasHandle }) {
  if (row.pid == null) {
    // The row was created but the spawn never got far enough to record a verified
    // identity -- so there is nothing to verify and nothing to reap.
    return { outcome: "lost", reason: "no process identity was ever recorded for this run", observed: null };
  }

  const verification = await verifyProcIdentity({
    pid: row.pid,
    pgid: row.process_group ?? null,
    lstart: row.proc_lstart ?? null,
  });

  if (!verification.ok) {
    return { outcome: "lost", reason: verification.reason, observed: verification.observed };
  }

  // Verified alive. The only remaining question is whether it is still OURS.
  if (hasHandle(row.run_id)) {
    // A live process we still hold a handle for is not reconciliation's business: it is
    // an ordinary in-flight run. Returning null (rather than an outcome) keeps the
    // "reconciliation never ends a healthy run" property explicit.
    return { outcome: null, reason: "run is alive and still bound to an adapter handle", observed: verification.observed };
  }

  return {
    outcome: "orphaned-unmanaged",
    reason: "process verified alive (pid + pgid + start time all match) but no adapter handle is bound to it",
    observed: verification.observed,
  };
}

/**
 * Reconcile every non-terminal run row. Runs before any lifecycle status is trusted
 * anywhere else in the system (PLAN.md section 4).
 *
 * @param {{ db: object, hasHandle?: (runId: string) => boolean, logger?: object }} opts
 * @returns {Promise<{ examined: number, lost: string[], orphaned: string[], alive: string[], details: object[] }>}
 */
export async function reconcileOnBoot({ db, hasHandle = () => false, logger = console } = {}) {
  const open = listOpenRuns(db);
  const summary = { examined: open.length, lost: [], orphaned: [], stillOrphaned: [], alive: [], adopted: [], details: [] };

  for (const row of open) {
    // ADOPTED SESSIONS ARE NOT OURS TO RECONCILE (migration 0007). A session a person started by
    // hand is structurally identical to an `orphaned-unmanaged` process -- live, and no handle --
    // so without this it would be journalled as an orphan sighting on every boot and offered up for
    // reaping. Reap group-kills, so that is somebody's live session, mid-sentence.
    //
    // The one thing the supervisor legitimately decides about an adopted run is whether its process
    // is still there: an adopted session whose process has gone IS finished, and leaving the row
    // open forever would be the invisible-orphan bug in reverse. So the ORPHAN branch is skipped
    // and the `lost` branch is not.
    if (row.lifecycle === "adopted") {
      // IDENTITY, not bare liveness. `readProcInfo(pid).alive` alone cannot tell "still the person's
      // session" from "that pid was reused by something else", so a reused pid would keep a finished
      // adopted row open forever and the backstop would never fire. Raised by the same review.
      //
      // Same call shape as `classifyRun` above — `verifyProcIdentity` takes the RECORDED identity and
      // reads the OS itself, and it treats a null pgid/lstart as a wildcard (it compares only the
      // fields it was given), which is the correct behaviour for an adopted row whose hook reported a
      // pid but whose pgid could not be read.
      const alive = row.pid == null
        ? false
        : (await verifyProcIdentity({ pid: row.pid, pgid: row.process_group ?? null, lstart: row.proc_lstart ?? null })).ok;
      if (alive) {
        summary.adopted.push(row.run_id);
        summary.alive.push(row.run_id);
        summary.details.push({
          runId: row.run_id,
          outcome: null,
          reason: "adopted session, still running -- visible but not ours to reap",
          pid: row.pid,
        });
        continue;
      }
      const closed = reconcileRun(db, row.run_id, { exitReason: "lost" });
      if (closed) closeOpenAsksForRun(db, row.run_id, { reason: "lost" });
      summary.lost.push(row.run_id);
      summary.details.push({
        runId: row.run_id,
        outcome: "lost",
        reason: "adopted session's process is gone",
        pid: row.pid,
      });
      continue;
    }

    const { outcome, reason, observed } = await classifyRun(row, { hasHandle });
    summary.details.push({ runId: row.run_id, outcome, reason, pid: row.pid, observed });

    if (outcome === null) {
      summary.alive.push(row.run_id);
      continue;
    }

    if (outcome === "orphaned-unmanaged") {
      // NOT a terminal write (migration 0003). The process is verified *still running*, so
      // `ended_at` stays NULL and this row stays in `listOpenRuns()` — which is exactly what
      // makes the next boot re-examine it instead of losing a live process forever. Its real
      // terminal transition comes later: `lost` once the process is gone, or `reaped` once we
      // kill it. Before this, the row was closed here and a live orphan became invisible.
      // markRunOrphaned writes the lifecycle state AND the sighting in one transaction — see its
      // header: doing them as two calls from here let a crash in between produce an orphan whose
      // journal says it was first seen on a later boot than it really was.
      const { changed, alreadyOrphaned } = markRunOrphaned(db, row.run_id, { note: reason });
      if (changed !== 1) {
        logger.warn?.(`[reconcile] run ${row.run_id} was closed by another path mid-reconciliation; leaving it alone`);
        continue;
      }
      // PLAN.md section 4 still applies: an unmanaged run cannot answer its own asks, so they
      // are closed even though the row itself stays open. Idempotent — a repeat sighting finds
      // nothing left to close.
      const asksClosed = closeOpenAsksForRun(db, row.run_id, { reason: "orphaned-unmanaged" });
      (alreadyOrphaned ? summary.stillOrphaned : summary.orphaned).push(row.run_id);
      logger.log?.(
        `[reconcile] ${row.run_id} -> orphaned-unmanaged (${alreadyOrphaned ? "still, seen again" : "new"}); ` +
          `row left OPEN, closed ${asksClosed} open ask(s)`,
      );
      continue;
    }

    // One transaction for the terminal write and its ask bookkeeping (0003 review): a crash
    // between the two left a `lost` run with an unresolved ask that nothing could ever reach
    // again — later boots only examine open rows, and the sweep only touches rows with a
    // deadline, which this ask would never be given.
    const closeLost = db.transaction(() => {
      const changed = reconcileRun(db, row.run_id, { exitReason: outcome });
      if (changed !== 1) return { changed, asksClosed: 0 };
      return { changed, asksClosed: closeOpenAsksForRun(db, row.run_id, { reason: outcome }) };
    });
    const { changed, asksClosed } = closeLost();
    if (changed !== 1) {
      // Something closed the row between listOpenRuns() and here. Not an error -- the
      // `AND ended_at IS NULL` guard in reconcileRun exists precisely so the first writer
      // wins -- but worth logging rather than silently reporting an outcome we did not write.
      logger.warn?.(`[reconcile] run ${row.run_id} was already closed by another path; not overwriting`);
      continue;
    }
    summary.lost.push(row.run_id);
    // A previously-orphaned row reaching `lost` is the terminal transition migration 0003
    // promises: we watched a live unmanaged process until it died, then booked it honestly.
    const wasOrphan = row.lifecycle === "orphaned-unmanaged";
    logger.log?.(
      `[reconcile] ${row.run_id} -> ${outcome} (${reason})${wasOrphan ? " [was orphaned-unmanaged; terminal now]" : ""}; ` +
        `closed ${asksClosed} open ask(s)`,
    );
  }

  return summary;
}

/**
 * reap(runId) — verify pid + pgid + lstart, then kill the process group.
 *
 * Never kills on pid alone, and never kills a group shared with another open run. Returns
 * a result object rather than throwing for the ordinary refusals: "I did not kill this and
 * here is exactly why" is the useful answer for both of them.
 *
 * @param {{ db, runId, adapterStop?, hasHandle?, graceMs?, logger? }} opts
 *   adapterStop(runId) — used instead of a group kill when the group is shared, so one
 *   session can be ended without killing its siblings. Optional: without a handle (after a
 *   restart) there is nothing to call, and reap says so instead of pretending.
 */
export async function reap({
  db,
  runId,
  adapterStop,
  hasHandle = () => false,
  graceMs = 2000,
  logger = console,
  // Test seam. A kill that fails (EPERM, or a process wedged in an uninterruptible wait)
  // is the case the row-closing gate below exists for, and there is no safe way to provoke
  // a real one: the only pgid a normal user is guaranteed to get EPERM on is 1, and
  // `process.kill(-1, sig)` is a broadcast to every process the user owns. So the kill is
  // injectable, and the default is the real thing.
  killGroup = killProcessGroup,
  // Opt-in, and deliberately not plumbed through the wire command: see the adopted refusal below.
  force = false,
} = {}) {
  const row = getRun(db, runId);
  if (!row) return { reaped: false, reason: `unknown runId: ${runId}` };

  // THE MOST IMPORTANT REFUSAL IN THIS FUNCTION: an ADOPTED session belongs to a person
  // (migration 0007). Reap group-kills, so honouring a reap here would terminate a live session
  // somebody is sitting in front of. Every other refusal below is about not killing the WRONG
  // process; this one is about not killing a RIGHT process we were never asked to own.
  //
  // `force` exists because a stale adopted row -- a pid since reused, a hook that never reported the
  // session ending -- is a real situation, and refusing forever would make it unresolvable. It is
  // opt-in and is NOT reachable from the wire command by default.
  // Keyed on PROVENANCE as well as lifecycle, and the second half is the one that makes the claim true.
  //
  // The stated invariant is "the supervisor only ever kills a process it started itself" (migration
  // 0008), which is a fact about `started_by`. Checking only `lifecycle` made the MECHANISM narrower
  // than the CLAIM, and a review found the gap: a crash between `createRun` and `markRunAdopted` left a
  // row with `started_by = 'hook'` and `lifecycle = 'managed'`, reconciliation relabelled it
  // `orphaned-unmanaged`, and the reap went through — verified, it killed the process. The window is
  // closed at the source (adoption is one transaction now), but a guard that only holds because the
  // write path is correct is not a guard. This makes the two agree.
  //
  // `started_by` defaults to 'dashboard' precisely so an unstated origin can still be reaped; anything
  // that says it came from somewhere else is refused.
  if (!force && (row.lifecycle === "adopted" || (row.started_by && row.started_by !== "dashboard" && row.started_by !== "preflight"))) {
    return {
      reaped: false,
      refused: "adopted",
      reason:
        `run ${runId} was not started by the dashboard (started_by=${row.started_by ?? "unknown"}, `
        + `lifecycle=${row.lifecycle}): a person started it outside the dashboard, so the supervisor `
        + `will not kill it. Stop it where it is running, or pass force:true if you are certain this `
        + `row is stale.`,
    };
  }

  if (row.pid == null) {
    const closed = row.ended_at ? 0 : reconcileRun(db, runId, { exitReason: "lost" });
    if (closed) closeOpenAsksForRun(db, runId, { reason: "lost" });
    return { reaped: false, reason: "no process identity was ever recorded for this run", markedLost: closed === 1 };
  }

  // Refusal #0: an incomplete identity is not an identity. `verifyProcIdentity` treats a
  // null recorded pgid/lstart as a wildcard (it only compares the fields it was given), so
  // a row carrying a pid with no start time would verify on pid alone — the pid-reuse
  // footgun, arrived at by a different road. Rows like that are not hypothetical: schema v1
  // (`db/migrations/0001_initial.sql`) had `pid` and `process_group` but no `proc_lstart`
  // column at all, so any run row written before migration 0002 has exactly this shape.
  // Refuse to kill, and don't mark it lost either — we genuinely do not know what it is.
  if (row.process_group == null || row.proc_lstart == null) {
    logger.warn?.(
      `[reap] refusing to kill for run ${runId}: recorded identity is incomplete ` +
        `(pid=${row.pid}, process_group=${row.process_group}, proc_lstart=${row.proc_lstart})`,
    );
    return {
      reaped: false,
      reason: "refused: recorded process identity is incomplete (no process group or no start time)",
      observed: { pid: row.pid, processGroup: row.process_group, procLstart: row.proc_lstart },
    };
  }

  const verification = await verifyProcIdentity({
    pid: row.pid,
    pgid: row.process_group,
    lstart: row.proc_lstart,
  });

  if (!verification.ok) {
    // Refusal #1: nothing of ours is running under that pid. Killing anyway is how a
    // supervisor kills a stranger's process after a pid rollover.
    const closed = row.ended_at ? 0 : reconcileRun(db, runId, { exitReason: "lost" });
    if (closed) closeOpenAsksForRun(db, runId, { reason: "lost" });
    logger.warn?.(`[reap] refusing to kill for run ${runId}: ${verification.reason}`);
    return {
      reaped: false,
      reason: `refused: ${verification.reason}`,
      markedLost: closed === 1,
      observed: verification.observed,
    };
  }

  const pgid = row.process_group;
  const siblings = listOpenRunsSharingProcessGroup(db, pgid, runId);
  if (siblings.length > 0) {
    // Refusal #2: the group is shared (pooled `opencode serve`). End just this session — UNLESS
    // every run in the group is an unmanaged orphan, in which case there is no session to
    // preserve and refusing forever is the worse answer. See below.
    //
    // The escape hatch exists because 0003 created the deadlock it resolves, and the review found
    // it: an orphan's row now stays OPEN, so two orphans sharing a pooled pgid each count as the
    // other's live sibling. After a restart there is no adapter handle to end a session with, so
    // both refusals stood forever and nothing could ever kill either process. (Verified as
    // adapter-dependent, which is why the check below is on the HANDLE, not on the call: the
    // Claude Code adapter's `stop()` throws for an unknown runId — deadlock — while OpenCode's
    // returns silently, which was worse, because reap then reported `sessionEnded: true` for a
    // session it had not touched and closed the row over a live process.)
    const everySiblingIsUnmanagedOrphan = siblings.every(
      (r) => r.lifecycle === "orphaned-unmanaged" && !hasHandle(r.run_id),
    );
    const weAreUnmanagedOrphan = row.lifecycle === "orphaned-unmanaged" && !hasHandle(runId);

    if (everySiblingIsUnmanagedOrphan && weAreUnmanagedOrphan) {
      const kill = await killGroup(pgid, { graceMs });
      if (kill.killed) markRunReaped(db, runId);
      const closeAll = db.transaction(() => {
        const closedIds = [];
        for (const r of [row, ...siblings]) {
          if (r.ended_at) continue;
          if (endRun(db, r.run_id, { exitReason: "reaped", reapedAt: new Date().toISOString() }) === 1) {
            closeOpenAsksForRun(db, r.run_id, { reason: "reaped" });
            closedIds.push(r.run_id);
          }
        }
        return closedIds;
      });
      const closedIds = kill.killed ? closeAll() : [];
      logger.log?.(
        kill.killed
          ? `[reap] run ${runId}: process group ${pgid} held ONLY unmanaged orphans (${[runId, ...siblings.map((r) => r.run_id)].join(", ")}); ` +
              `killed the group and closed all of them`
          : `[reap] run ${runId}: all-orphan process group ${pgid} SURVIVED the kill (${kill.note ?? "still alive"}); rows left open`,
      );
      return {
        reaped: kill.killed,
        pgid,
        escalated: kill.escalated,
        note: kill.note,
        sharedWith: siblings.map((r) => r.run_id),
        allOrphanGroup: true,
        runClosed: closedIds.includes(runId),
        alsoClosed: closedIds.filter((id) => id !== runId),
      };
    }

    // A session can only be *ended* through a handle we still hold. Asking an adapter to stop a
    // run it has never heard of either throws (Claude Code) or silently succeeds (OpenCode) — and
    // treating the silent case as success is how a row gets closed over a live session.
    const hadHandle = hasHandle(runId);
    const sessionEnded = hadHandle && adapterStop ? await Promise.resolve(adapterStop(runId)).then(() => true, () => false) : false;
    // Only close the row if the session really ended. Closing it on a failed/absent
    // adapterStop loses the run twice over: its session keeps running, and — because the
    // shared-group refusal is answered from `listOpenRunsSharingProcessGroup` — a later
    // reap of the *sibling* no longer sees an open run on that pgid and kills the whole
    // group, taking this still-live session with it.
    const closeSession = db.transaction(() => {
      const closed = endRun(db, runId, { exitReason: "stopped" });
      if (closed === 1) closeOpenAsksForRun(db, runId, { reason: "stopped" });
      return closed;
    });
    const closed = sessionEnded ? closeSession() : 0;
    logger.warn?.(
      `[reap] run ${runId} shares process group ${pgid} with ${siblings.length} other open run(s); ` +
        `killed no processes and ${sessionEnded ? "ended the session via the adapter" : hadHandle ? "failed to end the session via the adapter" : "holds no adapter handle, so there is no session it can end"}`,
    );
    return {
      reaped: false,
      reason: "refused: process group is shared with other open runs",
      sharedWith: siblings.map((r) => r.run_id),
      hadHandle,
      sessionEnded,
      runClosed: closed === 1,
    };
  }

  const kill = await killGroup(pgid, { graceMs });
  // Gate the terminal write on the kill actually having worked. A row closed as "reaped"
  // over a group that survived (EPERM, or a process that ignores SIGKILL because it is
  // stuck in an uninterruptible wait) is the worst of both: the process is alive and no
  // longer appears in `listOpenRuns()`, so nothing will ever try to reap it again.
  //
  // `reaped_at` is stamped UNCONDITIONALLY on a successful kill, separately from the terminal
  // write (0003 review): "we killed the process group" and "we wrote the terminal row" are
  // different facts and they come apart two ways, both verified — the pump's `onEnd` hook can win
  // the terminal write because killing the run ends its stream, and reaping a row some other path
  // already closed used to kill a live process and record nothing at all (`exit_reason` stayed
  // `finished`, `reaped_at` stayed NULL).
  if (kill.killed) markRunReaped(db, runId);
  const closeReaped = db.transaction(() => {
    const c = endRun(db, runId, { exitReason: "reaped", reapedAt: new Date().toISOString() });
    if (c === 1) closeOpenAsksForRun(db, runId, { reason: "reaped" });
    return c;
  });
  const closed = kill.killed && !row.ended_at ? closeReaped() : 0;

  // The sibling check above is a point-in-time read and the kill takes up to `graceMs`, so a run
  // CAN be recorded onto this pgid while the kill is in flight (a pooled `opencode serve` reused
  // by a run whose identity landed a moment later). Narrow, but not imaginary — and silence is
  // the part that would make it dangerous, so it is reported rather than swallowed. The real fix
  // is a reservation on the pgid at the adapter's pool boundary, which belongs with the pooling
  // work in Phase 2, not here.
  const appeared = kill.killed ? listOpenRunsSharingProcessGroup(db, pgid, runId) : [];
  if (appeared.length > 0) {
    logger.warn?.(
      `[reap] run ${runId}: ${appeared.length} run(s) (${appeared.map((r) => r.run_id).join(", ")}) were recorded on ` +
        `process group ${pgid} WHILE it was being killed; they may have been collateral`,
    );
  }
  if (kill.killed) logger.log?.(`[reap] run ${runId}: killed process group ${pgid} (escalated=${kill.escalated})`);
  else logger.warn?.(`[reap] run ${runId}: process group ${pgid} SURVIVED the kill (${kill.note ?? "still alive"}); leaving the row open`);
  return {
    reaped: kill.killed,
    pgid,
    escalated: kill.escalated,
    note: kill.note,
    runClosed: closed === 1,
    // True when the kill happened but the row had already been closed by another path — the
    // reason `reaped_at` is stamped separately from `exit_reason`.
    alreadyClosed: kill.killed && !!row.ended_at,
    collateralRisk: appeared.map((r) => r.run_id),
    hadHandle: hasHandle(runId),
  };
}
