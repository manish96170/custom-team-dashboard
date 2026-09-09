#!/usr/bin/env node
// _mutate-turndigest.mjs — mutation harness for tier-2 per-turn digests (PLAN.md section 8, Rule 4).
//
// Same standing rule: break one mechanism, and the suite must fail BY ASSERTION at the case that
// protects it. A mutation that merely crashes proves nothing.
//
// WHAT MAKES A DIGEST UNUSUALLY WORTH MUTATING: every way it can be wrong is silent. A digest that
// exceeds its budget, quotes half a sentence, or states an assumption nobody made still looks exactly
// like a digest — and its reader is a RESUMED WORKER that will act on it. There is no error path where
// these show up; there is only a worker confidently doing the wrong thing three turns later.
//
// D1 and D5 are the two to read. D1 fabricates an assumption from prose, which is the failure the whole
// extractive design exists to prevent. D5 makes the supervisor stop writing digests at all, which is
// invisible to every deterministic suite that does not count tier-2 rows — the tier would simply not
// exist while the code that implements it sat there passing its own unit tests.
//
// Usage: node runtime/test/_mutate-turndigest.mjs [substring-of-mutation-name]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutations } from './_mutate-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(__dirname, '../..');

const F = {
  digest: path.join(SUPERVISOR, 'domain/turn-digest.js'),
  supervisor: path.join(SUPERVISOR, 'runtime/supervisor.js'),
  gen: path.join(SUPERVISOR, 'handoff/generate.js'),
};

const DIGEST = 'domain/test/turn-digest.test.js';
const HANDOFF = 'runtime/test/handoff.test.js';
const WIRING = 'runtime/test/turn-digest-wiring.test.js';

const MUTATIONS = [
  {
    name: 'D1-assumptions-inferred-from-prose',
    breaksCase: 'an extractive digest states NO assumptions — it cannot invent one',
    file: F.digest,
    why: "Fabricating an assumption by pattern-matching the worker's prose. The single worst failure available to this module: a resumed worker reads tier 2 as fact and acts on it, so an inferred assumption becomes a real decision nobody made. Note how plausible the mutant looks — it only fires on sentences that really do sound like assumptions, which is exactly why it needs a mutation rather than review.",
    breaks: 'turn-digest case 4 (an extractive digest states no assumptions)',
    test: DIGEST,
    find: `    assumptions: [],
    source: "extractive",`,
    replace: `    assumptions: (f.prose.match(/[^.]*\\b(assum\\w+|probably|should be fine)\\b[^.]*\\./gi) ?? []).slice(0, 3), // MUTANT: inferred
    source: "extractive",`,
  },
  {
    name: 'D2-budget-not-enforced',
    breaksCase: 'the digest stays inside the budget, and says when it cut something',
    file: F.digest,
    why: "Not enforcing Rule 4's '≤150 tokens per turn'. An unbounded digest is a transcript with extra steps: it reintroduces the very context cost the tier exists to remove, and it does so per turn — the most frequent event in the system. Nothing fails, everything just gets more expensive.",
    breaks: 'turn-digest case 3 (the digest fits the budget)',
    test: DIGEST,
    find: `  if (text.length <= max) return text;`,
    replace: `  if (true) return text; // MUTANT: budget ignored`,
  },
  {
    name: 'D3-in-flight-turn-digested',
    breaksCase: 'splitTurns slices on turn.end and drops the in-flight trailing turn',
    file: F.digest,
    why: "Digesting a turn that has not ended. Rule 4 says the digest is written at `turn.end` for a reason: a summary of a half-finished turn is wrong the moment the turn continues, and it is written to an append-only log where the wrong version stays. It also happens to look fine in every test that only ever feeds it complete turns.",
    breaks: 'turn-digest case 1 (an unfinished turn is not digested)',
    test: DIGEST,
    find: `  return turns;`,
    replace: `  if (current.length) turns.push(current); // MUTANT: in-flight turn digested
  return turns;`,
  },
  {
    name: 'D4-model-reply-trusted',
    breaksCase: 'a model reply is bounded and validated, never trusted',
    file: F.digest,
    why: 'Storing whatever the model returned. This is the boundary where a generated string becomes a stored fact, so it is the one place strictness is not optional: an over-budget summary defeats the tier, and a flood of 50 "assumptions" propagates straight into the tier-3 handoff that agents act on.',
    breaks: 'turn-digest case 9 (a model reply is bounded)',
    test: DIGEST,
    find: `    summary: clip(parsed.summary.replace(/\\s+/g, " ").trim(), budgetChars),
    assumptions,`,
    replace: `    summary: parsed.summary, // MUTANT: unbounded
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],`,
  },
  {
    name: 'D5-no-digest-written-at-turn-end',
    file: F.supervisor,
    why: "Never writing a digest. The tier stops existing while every one of its own unit tests keeps passing, because the pure module is fine and nothing calls it. This is the mutation that justifies asserting tier-2 ROWS in a runtime suite rather than trusting that a wired function stays wired -- the same blind spot as the wire-surface defects (FINDINGS 27.5).",
    breaks: 'wiring case 1 (a tier-2 digest row is written at turn.end)',
    test: WIRING,
    find: `      else if (event?.type === "turn.end") writeTurnDigest(runId);`,
    replace: `      else if (event?.type === "turn.end") void runId; // MUTANT: no digest written`,
  },
  {
    name: 'D6-digest-not-idempotent',
    file: F.supervisor,
    why: "Writing a digest without checking whether that turn already has one. Replay is normal here -- the pump re-reads events after a reconnect -- so this silently duplicates every digest, and tier 3 then lists the same assumption several times as if several turns had stated it. Duplication that inflates evidence is worse than duplication that merely wastes rows.",
    breaks: 'wiring case 3 (a replayed turn is not digested twice)',
    test: WIRING,
    find: `.some((d) => d.turnKey === key || d.turnIndex === turnIndex)`,
    replace: `.some(() => false) // MUTANT: not idempotent`,
  },
  {
    name: 'D7-digest-failure-closes-the-stream',
    file: F.supervisor,
    why: "Treating a digest failure as fatal to the run's event stream. Tier 2 is a convenience for whoever reads the run later; tier 1 is the record of what actually happened. Trading the second for the first is the wrong direction -- a bad digest should cost a missing summary, never a transcript that silently stops growing while the worker keeps working.",
    breaks: 'wiring case 4 (the run keeps persisting after a digest failure)',
    test: WIRING,
    find: '        logger.warn?.(`[supervisor] tier-2 digest failed for run ${runId} (non-fatal): ${err.message}`);',
    replace: '        pump.closeRun(runId); // MUTANT: a failed digest kills the stream',
  },
  {
    name: 'D9-turnkey-hashes-the-whole-slice',
    file: F.digest,
    why: "Keying a turn on its whole event slice instead of on the turn proper (the events at and after the last `turn.start`). THIS IS A REAL DEFECT THAT SHIPPED for one iteration: a replay seam prefixes the slice with the previous session's trailing events, so the replayed copy of a turn hashes differently and gets a second digest. Kept as a mutation because the first version of the wiring assertion -- 'all keys are distinct' -- passed while it was broken, since a duplicate that gets past the guard does so precisely by having a different key.",
    breaks: 'wiring case 3 (a replayed turn is not digested twice)',
    test: WIRING,
    find: `    if (all[i].type === "turn.start") { from = i; break; }`,
    replace: `    void all[i]; // MUTANT: key over the whole slice, prefix and all`,
  },
  {
    name: 'D10-tier3-lists-the-same-assumption-twice',
    file: F.gen,
    why: 'Listing a restated assumption once per digest that mentions it. The same assumption appearing three times reads as three independent statements of it, which INFLATES THE EVIDENCE for something nobody verified -- in the section of the most widely-read document most likely to be acted on.',
    breaks: 'handoff case 4 (an assumption appears once)',
    test: HANDOFF,
    find: `      if (seen.has(norm)) continue;`,
    replace: `      if (false) continue; // MUTANT: duplicates kept`,
  },
  {
    name: 'D8-tier3-reads-tier1-instead-of-tier2',
    file: F.gen,
    why: "Pointing tier 3's assumptions at the raw event log instead of the digests. Rule 4's hard rule is that no agent reads tier 1, and the handoff is the most widely-read document in the system -- so this is the cascade collapsing in the one place it matters most. It also quietly reintroduces the context explosion the three tiers were designed around.",
    breaks: 'handoff case 4 (Assumptions quotes tier 2)',
    test: HANDOFF,
    find: `  const digests = listTaskTurnDigests(db, taskId);`,
    replace: `  const digests = []; // MUTANT: tier 2 not consulted`,
  },
];

const exitCode = await runMutations(MUTATIONS, { cwd: SUPERVISOR, filter: process.argv[2] });
process.exit(exitCode);
