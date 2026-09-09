// STATUS (Group 5): superseded in production. supervisor/runtime/supervisor.js now owns
// persistence via the real supervisor/db/index.js, and ipc/daemon.js wires that in through
// createIpcServer({ commands }). This module survives only as server.js's DEFAULT so the
// adversarial tests in ipc/test/ can exercise the socket layer without a database — it is
// a test fixture now, not a placeholder awaiting integration. Do not build on it.
//
// persistence-stub.js — a documented STUB standing in for supervisor/db/index.js,
// which is owned by a different agent in this session (see this directory's
// FINDINGS.md, "Integration boundary"). Nothing in supervisor/ipc/ imports,
// edits, or reimplements supervisor/db/ or supervisor/lock/ — per instructions,
// if this module needed those, it would import their exported functions, not
// duplicate them. As of this writing supervisor/db/index.js already exists and
// exports functions with matching names/shapes (createRun, recordEvent, endRun,
// createAsk, answerAsk, ...) — swapping this stub for the real module in Group 5
// should be a constructor-argument change in server.js, not a rewrite.
//
// The interface below is intentionally the smallest slice server.js actually
// calls (createRun, recordEvent, endRun) — it does not attempt to model the
// whole schema from PLAN.md section 3, only the calls the ipc layer makes on
// the persistence boundary while dispatching commands.
//
// Contract (must match on real integration):
//   createRun({ runId, harnessId?, workerId?, prompt?, ... }) -> Promise<void>
//   recordEvent({ runId, tier, type, payload, ts? })           -> Promise<void>
//   endRun(runId, { endedAt?, exitReason? })                   -> Promise<void>

export function createPersistenceStub({ log = false, logger = console } = {}) {
  const runs = new Map();
  const events = [];

  async function createRun(row) {
    runs.set(row.runId, { ...row, createdAt: new Date().toISOString() });
    if (log) logger.log?.(`[persistence-stub] createRun ${row.runId}`);
  }

  async function recordEvent(e) {
    events.push({ ...e, ts: e.ts ?? new Date().toISOString() });
    if (log) logger.log?.(`[persistence-stub] recordEvent ${e.runId} ${e.type}`);
  }

  async function endRun(runId, patch = {}) {
    const row = runs.get(runId);
    if (row) Object.assign(row, patch, { endedAt: patch.endedAt ?? new Date().toISOString() });
    if (log) logger.log?.(`[persistence-stub] endRun ${runId}`);
  }

  /** Test/demo-only introspection — not part of the contract real db/index.js needs to satisfy. */
  function _inspect() {
    return { runs: [...runs.values()], events: [...events] };
  }

  return { createRun, recordEvent, endRun, _inspect };
}
