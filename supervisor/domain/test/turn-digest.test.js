// turn-digest.test.js — tier 2 of PLAN.md section 8, Rule 4.
//
// Every case is pure: no database, no supervisor, no harness, no model. That is the point of keeping the
// digester a pure function of a turn's events — "≤150 tokens per turn" and "does not invent" are both
// assertable without spending a token, and the supervisor injects the digester so the wiring can be
// tested separately from the summarising.
//
// THE TWO CASES THAT MATTER MOST are 4 and 9.
//
// Case 4 is the negative: an extractive digest's `assumptions` is EMPTY, always. Nothing in a transcript
// is labelled as an assumption, so anything there would be inferred — and the reader of a tier-2 digest
// is a RESUMED WORKER that will act on it. Case 9 is the same rule at the model boundary: whatever a
// model returns is bounded and validated rather than trusted, because that is the one place a generated
// string becomes a stored fact.
//
// Cases:
//   1. `splitTurns` slices on `turn.end`, and drops the IN-FLIGHT trailing turn
//   2. `turnFacts` extracts what a turn did — tools, errors, approvals, status, prose
//   3. the digest stays inside Rule 4's budget, and says when it cut something
//   4. an extractive digest states NO assumptions — it cannot invent one
//   5. a turn that did nothing still produces a digest, rather than an empty string
//   6. tool names are de-duplicated and overflow is counted, not dropped silently
//   7. `digestPrompt` states the budget and forbids inferring assumptions
//   8. a model reply wrapped in prose or a code fence is still parsed
//   9. a model reply is BOUNDED: over-budget summary clipped, bad assumptions dropped, count capped
//  10. an unusable reply falls back to the extractive digest, and SAYS it fell back
//  11. `turnKey` identifies a turn by CONTENT, so a replayed turn is recognised as the same turn
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import {
  DIGEST_BUDGET_CHARS,
  splitTurns,
  turnFacts,
  extractiveDigest,
  digestPrompt,
  parseDigestReply,
  turnKey,
} from "../turn-digest.js";

let failed = 0;
let n = 0;
/**
 * Numbered output and the WHOLE error on failure, for `_mutate-runner.mjs` rather than for a human:
 * it locates the broken case by scanning for `^  N.` lines and only credits a mutation when the output
 * contains a real `AssertionError`. Printing `err.message` alone made every mutation of an earlier
 * suite read as a crash at case 1 (FINDINGS §22.1).
 */
function testCase(name, fn) {
  n += 1;
  try { fn(); console.log(`  ${n}. ${name}`); } catch (err) {
    failed += 1;
    // `FAIL: <name>` exactly — the form the runner matches for `breaksCase`. Needed because this file
    // keeps going after a failure, so "the last numbered line is the last case that passed" overshoots.
    console.error(`  FAIL: ${name}`);
    console.error(err);
  }
}

/** A turn, in the shape the pump persists and `listEvents` returns. */
const ev = (type, payload = {}) => ({ type, payload });
const turn = ({ tools = [], text = "", status = "completed", isError = false, toolErrors = 0, approvals = 0 } = {}) => [
  ev("turn.start", {}),
  ...tools.map((t) => ev("tool.start", { toolName: t })),
  ...Array.from({ length: toolErrors }, () => ev("tool.result", { isError: true })),
  ...Array.from({ length: approvals }, () => ev("approval.request", { question: "may I?" })),
  ...(text ? [ev("assistant.delta", { text })] : []),
  ev("turn.end", { status, isError }),
];

// ── 1 ────────────────────────────────────────────────────────────────────────────────────
testCase("splitTurns slices on turn.end and drops the in-flight trailing turn", () => {
  const events = [...turn({ text: "one" }), ...turn({ text: "two" }), ev("turn.start"), ev("tool.start", { toolName: "Read" })];
  const turns = splitTurns(events);
  assert.equal(turns.length, 2, "two COMPLETE turns; the third is still running");
  assert.equal(turns[0].at(-1).type, "turn.end", "each slice ends at its turn.end");
  assert.equal(turnFacts(turns[0]).prose, "one", "and the slices are in order");
  assert.equal(turnFacts(turns[1]).prose, "two");
  // The load-bearing half: digesting an unfinished turn would write a summary that is wrong the moment
  // the turn continues, and Rule 4 says the digest is "written at `turn.end`".
  assert.deepEqual(splitTurns([ev("turn.start"), ev("assistant.delta", { text: "mid" })]), [],
    "a turn with no turn.end yet is not a turn to digest");
  assert.deepEqual(splitTurns([]), []);
});

// ── 2 ────────────────────────────────────────────────────────────────────────────────────
testCase("turnFacts extracts what the turn actually did", () => {
  const f = turnFacts(turn({ tools: ["Read", "Edit", "Bash"], text: "done  the\nthing", toolErrors: 2, approvals: 1, status: "max_turns" }));
  assert.deepEqual(f.tools, ["Read", "Edit", "Bash"], "in call order");
  assert.equal(f.toolErrors, 2);
  assert.equal(f.approvals, 1);
  assert.equal(f.status, "max_turns", "the terminating status, which is how a stopped turn is told from a finished one");
  assert.equal(f.isError, false);
  assert.equal(f.prose, "done the thing", "prose is whitespace-normalised — a digest is one line, not a transcript");
  assert.equal(turnFacts(turn({ isError: true })).isError, true);
  // Deltas concatenate: a harness emits prose in fragments, and a digest that read only the last one
  // would quote half a sentence.
  const f2 = turnFacts([ev("assistant.delta", { text: "half " }), ev("assistant.delta", { text: "a sentence" }), ev("turn.end", {})]);
  assert.equal(f2.prose, "half a sentence");
});

// ── 3 ────────────────────────────────────────────────────────────────────────────────────
// Rule 4's "≤150 tokens per turn" is the tier's ONLY purpose: a digest that quietly grew would
// reintroduce the context cost tier 3 exists to avoid, and nothing would report it.
testCase("the digest stays inside the budget, and says when it cut something", () => {
  const long = "x".repeat(5000);
  const d = extractiveDigest(turn({ tools: ["Read"], text: long }));
  assert.ok(d.summary.length <= DIGEST_BUDGET_CHARS,
    `a digest must fit Rule 4's budget; got ${d.summary.length} > ${DIGEST_BUDGET_CHARS}`);
  assert.ok(d.summary.includes("…"), "and must SAY it was truncated, rather than ending mid-word as if complete");
  // The structured facts are never what gets cut: they are the part a resumed worker can act on.
  assert.ok(d.summary.startsWith("used Read"), `the facts survive the truncation; got: ${d.summary.slice(0, 60)}`);

  const tiny = extractiveDigest(turn({ tools: ["Read"], text: long }), { budgetChars: 40 });
  assert.ok(tiny.summary.length <= 40, `an explicit budget is honoured too; got ${tiny.summary.length}`);
});

// ── 4 ────────────────────────────────────────────────────────────────────────────────────
// The most important negative in the file, and the same rule tier 3 obeys: nothing in a transcript is
// LABELLED as an assumption, so an extractive digest that produced one would have inferred it — and its
// reader is a resumed worker that will act on it.
testCase("an extractive digest states NO assumptions — it cannot invent one", () => {
  for (const t of [
    turn({ text: "I'm assuming the socket is already listening, so I skipped the check." }),
    turn({ text: "This probably works. It should be fine." }),
    turn({ tools: ["Bash"], text: "", isError: true, status: "error" }),
  ]) {
    const d = extractiveDigest(t);
    assert.deepEqual(d.assumptions, [],
      `an extractive digest must state no assumptions, however assumption-like the prose; got ${JSON.stringify(d.assumptions)}`);
    assert.equal(d.source, "extractive", "and must label itself, so a reader knows what produced it");
  }
});

// ── 5 ────────────────────────────────────────────────────────────────────────────────────
// An empty digest would be indistinguishable from a missing one, and "this turn did nothing" is itself
// worth knowing to a reader deciding whether the worker is stuck.
testCase("a turn that did nothing still produces a digest", () => {
  const d = extractiveDigest([ev("turn.end", {})]);
  assert.ok(d.summary.length > 0, "never an empty string — that reads as a missing digest, not an empty turn");
  assert.match(d.summary, /nothing recorded/);
  assert.deepEqual(d.assumptions, []);
});

// ── 6 ────────────────────────────────────────────────────────────────────────────────────
testCase("tool names are de-duplicated and overflow is counted, not dropped", () => {
  const d = extractiveDigest(turn({ tools: ["Read", "Read", "Read", "Edit"] }));
  assert.equal((d.summary.match(/Read/g) ?? []).length, 1, "a tool called three times is named once");
  assert.ok(d.summary.includes("Edit"));
  assert.equal(d.facts.tools.length, 4, "while the FACTS keep every call — the summary is what is bounded");

  const many = extractiveDigest(turn({ tools: ["a", "b", "c", "d", "e", "f", "g", "h"] }));
  assert.match(many.summary, /\(\+2 more\)/, "overflow is COUNTED; silently dropping it would understate the turn");
});

// ── 7 ────────────────────────────────────────────────────────────────────────────────────
// The prompt is exported so it is reviewable. A prompt nobody can see is a prompt nobody can correct,
// and this one carries the rule that keeps the model from doing what case 4 forbids the extractor from.
testCase("digestPrompt states the budget and forbids inferring assumptions", () => {
  const p = digestPrompt(turn({ tools: ["Read"], text: "hello" }), { budgetChars: 321 });
  assert.ok(p.includes("321"), "a model that is not told the limit will exceed it");
  assert.match(p, /Do NOT infer assumptions/, "the instruction that makes the model's `assumptions` trustworthy");
  assert.match(p, /ONLY JSON/, "and it must ask for something validatable");
  assert.ok(p.includes("Read"), "with the facts included, so the model is not re-deriving them from prose");
  assert.ok(p.includes("hello"), "and the worker's own words, which are the thing being summarised");
  // The transcript handed to a model is bounded too: an unbounded prompt is the cost tier 2 is meant
  // to remove, arriving from the other direction.
  const huge = digestPrompt(turn({ text: "y".repeat(20_000) }));
  assert.ok(huge.length < 6000, `the prompt itself must stay bounded; got ${huge.length} chars`);
});

// ── 8 ────────────────────────────────────────────────────────────────────────────────────
// Models wrap JSON in prose and fences often enough that this is the normal path, not an error path.
testCase("a model reply wrapped in prose or a fence is still parsed", () => {
  const t = turn({ tools: ["Read"], text: "did the thing" });
  const body = `{"summary": "rewired the pump", "assumptions": ["the socket is listening"]}`;
  for (const reply of [body, `Sure!\n\`\`\`json\n${body}\n\`\`\`\n`, `Here you go: ${body} — hope that helps`]) {
    const d = parseDigestReply(reply, t);
    assert.equal(d.source, "model", `this reply is usable and must not fall back; reply was: ${reply.slice(0, 40)}`);
    assert.equal(d.summary, "rewired the pump");
    assert.deepEqual(d.assumptions, ["the socket is listening"]);
    assert.equal(d.facts.tools[0], "Read", "and the facts come from the events, not from the model");
  }
});

// ── 9 ────────────────────────────────────────────────────────────────────────────────────
// The boundary where a generated string becomes a stored fact, so it is the right place to be strict.
testCase("a model reply is bounded and validated, never trusted", () => {
  const t = turn({ text: "hi" });

  const over = parseDigestReply(JSON.stringify({ summary: "z".repeat(5000), assumptions: [] }), t);
  assert.ok(over.summary.length <= DIGEST_BUDGET_CHARS,
    `a model must not be able to blow the budget; got ${over.summary.length}`);

  // A model that returns `assumptions` as a string, or with junk in it, must not put junk in a document
  // that agents act on.
  assert.deepEqual(parseDigestReply(JSON.stringify({ summary: "s", assumptions: "not an array" }), t).assumptions, []);
  assert.deepEqual(
    parseDigestReply(JSON.stringify({ summary: "s", assumptions: ["  ", "", null, 7, "real one"] }), t).assumptions,
    ["real one"],
    "empty and non-string entries are dropped rather than stored as blanks",
  );

  const flood = parseDigestReply(JSON.stringify({ summary: "s", assumptions: Array.from({ length: 50 }, (_, i) => `a${i}`) }), t);
  assert.equal(flood.assumptions.length, 5, "the count is capped — 50 'assumptions' is a transcript, not a digest");
  const wordy = parseDigestReply(JSON.stringify({ summary: "s", assumptions: ["w".repeat(1000)] }), t);
  assert.ok(wordy.assumptions[0].length <= 201, `each assumption is clipped too; got ${wordy.assumptions[0].length}`);
});

// ── 10 ───────────────────────────────────────────────────────────────────────────────────
// A worse digest is more useful than a missing one — but only if the reader can tell which they have,
// which is what `source` is for.
testCase("an unusable reply falls back to the extractive digest, and says so", () => {
  const t = turn({ tools: ["Edit"], text: "did the thing" });
  for (const reply of [
    undefined, null, "", "   ", 42, {},
    "I'm sorry, I can't help with that.",          // no JSON at all
    "{not json at all}",                            // looks like JSON, is not
    JSON.stringify({ assumptions: [] }),            // no summary
    JSON.stringify({ summary: "   " }),             // blank summary
    JSON.stringify({ summary: 5 }),                 // wrong type
  ]) {
    const d = parseDigestReply(reply, t);
    assert.equal(d.source, "extractive-fallback",
      `an unusable reply must fall back AND be labelled; reply was ${JSON.stringify(reply)}`);
    assert.ok(d.summary.includes("Edit"), "the fallback is a real digest of the real turn, not a placeholder");
    assert.deepEqual(d.assumptions, [], "and it states no assumptions, because the extractor cannot");
  }
});

// ── 11 ───────────────────────────────────────────────────────────────────────────────────
// The key that makes a digest survive a REPLAY without duplicating. `turnIndex` moves when the pump
// re-persists a buffered log after `resume()`, so an index-only identity digests one real turn twice and
// tier 3 then lists the same assumption as if two turns had stated it.
testCase("turnKey identifies a turn by content, so a replayed turn is the same turn", () => {
  const t = turn({ tools: ["Read"], text: "same turn" });
  assert.equal(turnKey(t), turnKey([...t]), "the same events give the same key, whatever their index");
  assert.notEqual(turnKey(t), turnKey(turn({ tools: ["Read"], text: "different turn" })),
    "different prose is a different turn");
  assert.notEqual(turnKey(t), turnKey(turn({ tools: ["Edit"], text: "same turn" })),
    "and so is a different tool — a key that ignored the tools would merge two real turns");
  assert.equal(turnKey([]), turnKey([]), "and it is total: an empty turn has a key rather than throwing");
  assert.match(turnKey(t), /^[0-9a-f]{16}$/, "short and hex, because it is stored in every digest payload");
});

if (failed > 0) {
  console.error(`\n${failed} turn-digest case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: tier-2 turn digests");
