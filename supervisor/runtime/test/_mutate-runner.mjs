// _mutate-runner.mjs — the shared machinery for this project's mutation harnesses.
//
// New code has no "pre-fix" version, so the standing rule (every regression test must be observed
// FAILING against the code it protects) is satisfied the way Group 5, migration 0003 and Phase 2 all
// did it: break one mechanism at a time and confirm the test fails AT THE CASE that claims to
// protect it. A mutation that PASSES means either the mechanism is not load-bearing or the assertion
// is not really testing it — both are findings, not noise.
//
// EXTRACTED into its own module because the checks below are the part that has already lied once,
// and one copy of them is easier to keep honest than several. From `runtime/FINDINGS.md` (the 0003
// review): a shell helper verified "did the mutation apply?" with `grep -F "$replacement"`, which for
// a MULTI-LINE replacement matches when any single line matches — so an unapplied mutation looked
// applied, its test passed, and the result read as "this fix is not load-bearing".
//
// Hence, here:
//   * the pattern must occur EXACTLY ONCE (not "at least once"),
//   * the file contents must actually differ after the substitution,
//   * every file is restored from its ORIGINAL BYTES, never by a reverse substitution,
//   * and "caught" requires an `AssertionError` — a mutation that crashes the module proves only
//     that broken code is broken (Group 5's ReferenceError lesson).
//
// ONE OPERATIONAL NOTE, measured rather than assumed: a test that does not RUN TO COMPLETION never
// runs its `finally`, so its detached harness children survive. Two ways to cause that, and both are
// things a developer does casually:
//
//   * this harness killing a test that exceeds its timeout;
//   * piping a test's output through `head`, which closes the pipe early and kills the test with
//     SIGPIPE. Measured: a complete `concurrency.test.js` run adds 0 survivors, the same run through
//     `| head -4` adds 7. `| tail -N` is SAFE, because tail reads to the end.
//
// The suites do not leak when they finish. So if `ps` shows strays, check how the run you are looking
// at ended before concluding a suite leaks — every stray seen while building Phase 2 came from a run
// that was cut short, not from a suite.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

function runNode(script, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script], { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function applyOnce(file, find, replace) {
  const before = fs.readFileSync(file, 'utf8');
  const occurrences = before.split(find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`pattern must occur exactly once in ${path.basename(file)}, found ${occurrences}`);
  }
  const after = before.replace(find, replace);
  if (after === before) throw new Error(`replacement did not change ${path.basename(file)}`);
  fs.writeFileSync(file, after);
  return before;
}

/**
 * Apply each mutation, run its test, restore, and report.
 *
 * A mutation is `{ name, file, find, replace, test, breaks, why, extra?, expectSurvives? }`.
 * `extra` is a second substitution needed to make the first one reachable. `expectSurvives` inverts
 * the expectation — use it only with a written reason, because "nothing covers this" is a finding.
 *
 * @returns {Promise<number>} process exit code: 0 when every mutation behaved as expected.
 */
export async function runMutations(mutations, { cwd, timeoutMs = 240_000, filter } = {}) {
  const selected = filter ? mutations.filter((m) => m.name.includes(filter)) : mutations;
  if (selected.length === 0) {
    console.error(`no mutation matched "${filter}"`);
    return 1;
  }

  const results = [];
  for (const m of selected) {
    const originals = new Map();
    try {
      originals.set(m.file, applyOnce(m.file, m.find, m.replace));
      if (m.extra) {
        if (!originals.has(m.extra.file)) originals.set(m.extra.file, fs.readFileSync(m.extra.file, 'utf8'));
        applyOnce(m.extra.file, m.extra.find, m.extra.replace);
      }

      const { code, stdout, stderr } = await runNode(m.test, cwd, timeoutMs);
      const out = `${stdout}\n${stderr}`;
      const failed = code !== 0;
      // The last "  N." line printed is the last case that PASSED, so the case the mutation broke is
      // the one after it. A case prints its line only AFTER its assertions, so "no case printed"
      // means it died inside case 1 — NOT that it crashed.
      const lastCase = [...out.matchAll(/^ {2}(\d+)\./gm)].map((x) => Number(x[1])).pop() ?? 0;
      // An `AssertionError` and nothing else. This used to also accept any line beginning
      // `FAIL: `, and the adapter-style suites print that for EVERY caught exception — so a
      // mutation that made the code throw an ordinary runtime error was reported as "caught by
      // the assertion that protects it". Verified against mutation E8, which made
      // `readFileSync` propagate `EISDIR`: the output contained no `AssertionError` at all, yet
      // the run said OK. That is the wrong-reason failure `breaksCase` was added to eliminate,
      // surviving one level up — "a mutation that crashes the module proves nothing" (Group 5).
      //
      // Consequence, and it is the point: a mutation whose mechanism is "an error now escapes"
      // has to be met by a test that CATCHES it and asserts, not by letting the throw end the
      // suite.
      const assertionFailure = /AssertionError/.test(out);

      // `lastCase` only works for suites that number their cases ("  3. ..."). The
      // adapter-style suites print `PASS: <name>` / `FAIL: <name>` instead, so for those
      // `lastCase` is always 0 and "FAILED at case 1" means nothing — the mutation would be
      // reported OK on the strength of the suite failing ANYWHERE. A mutation that fails
      // for the wrong reason proves nothing, which this project has now been bitten by
      // three times (Group 5's ReferenceError, round three's shared-pgid fixture, M21).
      //
      // So a mutation may name `breaksCase`: the exact case name the suite prints. When it
      // does, the failure must be attributed to THAT case.
      const namedCaseFailed = m.breaksCase
        ? out.includes(`FAIL: ${m.breaksCase}`)
        : null;
      results.push({ ...m, failed, lastCase, namedCaseFailed, crashed: failed && !assertionFailure });
    } catch (err) {
      results.push({ ...m, error: err.message });
    } finally {
      for (const [file, contents] of originals) fs.writeFileSync(file, contents);
    }
  }

  console.log('\n=== mutation results ===\n');
  let bad = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`ERROR   ${r.name}: ${r.error}`);
      bad += 1;
      continue;
    }
    const wantFail = !r.expectSurvives;
    // When `breaksCase` is named, failing SOMEWHERE is not enough — it has to be there.
    const attributed = r.namedCaseFailed === null || r.namedCaseFailed === true;
    const ok = wantFail ? r.failed && !r.crashed && attributed : !r.failed;
    if (!ok) bad += 1;
    console.log(`${ok ? 'OK     ' : 'PROBLEM'} ${r.name}`);
    console.log(`        expected: ${wantFail ? `caught (breaks ${r.breaks})` : 'SURVIVES (nothing covers it yet)'}`);
    const where = r.breaksCase
      ? (r.namedCaseFailed ? `at the named case "${r.breaksCase}"` : `NOT at the named case "${r.breaksCase}" — it failed somewhere else, which proves nothing`)
      : `at case ${r.lastCase + 1}`;
    console.log(
      `        observed: ${r.failed ? `test FAILED ${where}` : 'test passed'}${r.crashed ? ' — NOT an assertion failure (a crash); proves nothing' : ''}`,
    );
  }
  console.log(`\n${results.length - bad}/${results.length} mutations behaved as expected.`);
  return bad === 0 ? 0 : 1;
}
