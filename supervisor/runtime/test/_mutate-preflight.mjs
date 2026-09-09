#!/usr/bin/env node
// _mutate-preflight.mjs — mutation harness for preflight session cleanup (PLAN.md 12.1).
//
// Same standing rule as the other harnesses: new code has no "pre-fix" version, so each mechanism
// is broken one at a time and the test must fail AT THE CASE that claims to protect it, BY
// ASSERTION. A mutation that merely crashes proves nothing (Group 5), and a mutation credited to
// the wrong case proves nothing either — which is what the runner's case attribution is for.
//
// What makes this feature unusually worth mutating: the two requirements pull in OPPOSITE
// directions. A preflight row must be invisible to humans AND visible to reconciliation, and it
// contains the codebase's only destructive delete. Every mutation below is a plausible
// simplification that would look correct in review:
//
//   * "just filter preflights out of listOpenRuns too, for consistency" -> leaks live processes
//   * "the guard is redundant, the caller only passes preflights"        -> deletes real history
//   * "sweep every preflight row, that's what cleanup means"             -> deletes live rows
//
// Usage: node runtime/test/_mutate-preflight.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  db: path.join(SUPERVISOR, 'db/index.js'),
  supervisor: path.join(SUPERVISOR, 'runtime/supervisor.js'),
  adapter: path.join(SUPERVISOR, 'adapters/claude-code/adapter.js'),
};

// `preflight.test.js` prints NUMBERED cases ("  3. ..."), so the runner's own lastCase attribution
// works there and is more informative than a name -- it says WHICH case broke. `breaksCase` is for
// the adapter-style suites that print `PASS: <name>` instead, where lastCase is always 0.
const PREFLIGHT = 'runtime/test/preflight.test.js';
const ADAPTER = 'adapters/claude-code/test/test-claude-code-adapter.mjs';

const MUTATIONS = [
  {
    name: 'P1-preflight-hidden-from-reconciliation',
    file: F.db,
    why: "Filtering preflights out of `listOpenRuns` as well as out of the display list. This is the most inviting wrong simplification in the feature -- it reads as consistency -- and it turns 'a preflight leaves nothing behind' into 'a preflight can leak a live process nobody can see or reap'. Case 2 asserts both directions of this at once for exactly this reason.",
    breaks: 'preflight case 2 (visible to reconciliation while hidden from humans)',
    test: PREFLIGHT,
    find: `  return db.prepare(\`SELECT * FROM runs WHERE ended_at IS NULL ORDER BY started_at\`).all();
}

/**
 * Runs a human (or the CTO) should see: everything except preflights.`,
    replace: `  return db.prepare(\`SELECT * FROM runs WHERE ended_at IS NULL AND is_preflight = 0 ORDER BY started_at\`).all(); // MUTANT
}

/**
 * Runs a human (or the CTO) should see: everything except preflights.`,
  },
  {
    name: 'P2-preflight-visible-to-humans',
    file: F.db,
    why: "Showing preflight runs in the human-facing list. The history pollution the whole feature exists to prevent: 'who did what' becomes twenty sessions saying 'hi'. It pollutes just as effectively WHILE the checks run, which is why the exclusion is a read-time filter rather than something that only becomes true once the row is deleted.",
    breaks: 'preflight case 2 (excluded from the display list even while running)',
    test: PREFLIGHT,
    find: `  const where = openOnly ? \`WHERE is_preflight = 0 AND ended_at IS NULL\` : \`WHERE is_preflight = 0\`;`,
    replace: `  const where = openOnly ? \`WHERE ended_at IS NULL\` : \`\`; // MUTANT: preflights shown to humans`,
  },
  {
    name: 'P3-destructive-delete-guard-removed',
    file: F.db,
    why: "Dropping the is_preflight guard on the only destructive delete in the codebase. Everything else here CLOSES rows and keeps them; this one removes them permanently. A caller passing the wrong runId would silently destroy a real worker's history, and the guard is checked in the DATABASE precisely because the caller is what would be wrong.",
    breaks: 'preflight case 5 (a real run is refused)',
    test: PREFLIGHT,
    find: `  if (!row.is_preflight) {
    throw new Error(`,
    replace: `  if (false) {
    throw new Error(`,
  },
  {
    name: 'P4-children-not-deleted',
    file: F.db,
    why: 'Deleting the run row without its event_log rows. The foreign key would reject it outright -- but a mutation that only crashes proves nothing, so what this really tests is that case 6 asserts on the CHILD counts rather than only on the run being gone. Orphaned event rows would be both unreadable and undeletable.',
    // Observed to fail at case 1, not 6, and that is correct rather than a mis-attribution: with
    // the event rows left behind, the `runs` DELETE hits the foreign key, the transaction rolls
    // back, and case 1's `cleanup.deleted` is already false. Case 1 is simply the EARLIEST case
    // that depends on this mechanism. Case 6 is still the one that asserts the child COUNTS.
    breaks: 'preflight case 1 (cleanup.deleted) — first; case 6 asserts the child counts',
    test: PREFLIGHT,
    find: `    const events = db.prepare(\`DELETE FROM event_log WHERE run_id = ?\`).run(runId).changes;`,
    replace: `    const events = 0; // MUTANT: event rows left behind`,
  },
  {
    name: 'P5-sweep-deletes-open-preflights',
    file: F.supervisor,
    why: "Sweeping every preflight row instead of only terminal ones. An OPEN preflight may still be running under a live supervisor, and deleting the row of a live process manufactures an orphan nothing can ever reap -- migration 0003's invisible-orphan bug arriving by a new route.",
    breaks: 'preflight case 8 (an OPEN preflight survives the sweep)',
    test: PREFLIGHT,
    find: `    const stale = listPreflightRuns(database).filter((r) => r.ended_at !== null);`,
    replace: `    const stale = listPreflightRuns(database); // MUTANT: sweeps live preflights too`,
  },
  {
    name: 'P6-verdict-recorded-after-cleanup',
    file: F.supervisor,
    why: "Recording the verdict only when cleanup succeeded. The verdict is the POINT of the check and tidying up is bookkeeping; letting a cleanup failure cost the verdict inverts that. Mutated as 'skip the record entirely' because that is the observable end state of the ordering being wrong.",
    breaks: 'preflight case 4 (the verdict outlives the deleted session)',
    test: PREFLIGHT,
    find: `      recordModelHealth(database, {
        harnessId,`,
    replace: `      if (globalThis.__SKIP_HEALTH__ ?? true) throw new Error('MUTANT: verdict not recorded');
      recordModelHealth(database, {
        harnessId,`,
  },
  {
    name: 'P7-failed-check-skips-cleanup',
    file: F.supervisor,
    why: 'Cleaning up only after a PASSING check. A failing preflight writes exactly the same rows as a passing one, and a model that is unreachable is the case most likely to be re-checked repeatedly -- so this leaks the most history precisely where it is worst.',
    breaks: 'preflight case 3 (a FAILED check cleans up just as thoroughly)',
    test: PREFLIGHT,
    find: `    const cleanup = runId ? await discardPreflightRun(runId, harnessId) : { deleted: false, reason: "never started" };`,
    replace: `    const cleanup = (runId && verdict.reachable) ? await discardPreflightRun(runId, harnessId) : { deleted: false, reason: "MUTANT: only successes are cleaned up" };`,
  },
  {
    name: 'P8-preflight-not-marked-at-insert',
    file: F.db,
    why: "Not persisting the preflight flag. It has to be set at INSERT time, because a preflight SIGKILLed before its cleanup must be recognisable as one by the reconciliation that finds it -- and nothing can set a flag after a SIGKILL. Without it every preflight row is indistinguishable from a real worker run, so the guard in P3 can never fire and the sweep can never find anything.",
    // Observed to fail at case 1, not 2: an unmarked row makes `deletePreflightRun` refuse, so
    // case 1's cleanup already fails. Again the earliest dependent case, not a wrong reason.
    breaks: 'preflight case 1 (cleanup of an unmarked row is refused) — first; case 2 asserts the flag directly',
    test: PREFLIGHT,
    find: `    is_preflight: r.isPreflight ? 1 : 0,`,
    replace: `    is_preflight: 0, // MUTANT: never marked`,
  },
  {
    name: 'P10-rows-deleted-while-pump-attached',
    file: F.supervisor,
    why: "Deleting the rows without detaching the pump first. The pump keeps consuming the adapter's stream, and every event it then persists for a deleted run violates the event_log foreign key. Found on the REAL CLI, not by reading: each preflight logged \"recordEvent failed ... FOREIGN KEY constraint failed\" as the tail of the stream landed after the delete. Non-fatal, so nothing broke -- which is exactly why it needs a test rather than a reader noticing the warning.",
    breaks: 'preflight case 9 (the pump is closed before the rows go)',
    test: PREFLIGHT,
    // Anchored on the comment, because `pump.closeRun(runId)` appears three times in
    // supervisor.js (stop, reap, and here) and the harness correctly refuses an ambiguous pattern.
    find: `    pump.closeRun(runId);

    let sessionDiscarded = null;`,
    replace: `    // MUTANT: rows deleted with the pump still attached

    let sessionDiscarded = null;`,
  },
  {
    name: 'P9-ephemeral-flag-not-passed',
    breaksCase: 'env: an ephemeral session leaves no harness-side history',
    file: F.adapter,
    why: "Dropping `--no-session-persistence` for an ephemeral session. The harness then writes a session to disk that nothing will ever delete -- and NOT writing it is strictly better than deleting it, because a delete can fail and a SIGKILL between the check and its cleanup pre-empts the delete entirely, which is exactly the case a preflight has to survive.",
    breaks: "adapter \"env: an ephemeral session leaves no harness-side history\"",
    test: ADAPTER,
    find: `  if (spec.ephemeral) args.push('--no-session-persistence');`,
    replace: `  // MUTANT: ephemeral sessions still persist`,
  },
];

const exitCode = await runMutations(MUTATIONS, {
  cwd: SUPERVISOR,
  filter: process.argv[2],
});
process.exit(exitCode);
