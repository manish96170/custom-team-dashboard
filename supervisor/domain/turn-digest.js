// turn-digest.js — tier 2 of PLAN.md section 8, Rule 4. Pure.
//
// Rule 4's table: "≤150 tokens per turn, written at `turn.end` by the cheapest available model", read by
// "a resumed worker, for current state only". Tier 1 is raw events for humans in panes; tier 3 is the
// rolling task handoff. Tier 2 is the missing middle, and the thing tier 3's `Assumptions` section has
// been waiting on since it was built (FINDINGS §24).
//
// A DOCUMENTED DEVIATION FROM RULE 4, and the reason for it
//
// Rule 4 says a model writes this. The DEFAULT here is **extractive and model-free**, with the
// model-backed digester available as an injected option. Three reasons, and the third is the one that
// decided it:
//
//   1. Cost. A digest per turn is a model call per turn, on the single most frequent event in the
//      system. Rule 5's whole premise is that clearing is cheap because tier 3 exists; making tier 2
//      expensive would move the cost rather than remove it.
//   2. Testability. A digest whose text comes from a model can be checked for shape but never for
//      content, and this project's method is to assert mechanisms.
//   3. It cannot invent. An extractive digest quotes what happened; a generated one can state a
//      decision nobody made. Its reader is a RESUMED WORKER that will act on it, which is the same
//      argument that keeps tier 3 deterministic (§24.2).
//
// So the default records what is verifiable (what the turn did, which tools, what it said last) and
// leaves `assumptions` EMPTY. A model-backed digester fills it, because extracting "what did this worker
// assume" genuinely needs one — and that is the honest boundary between the two.
//
// The budget is enforced here rather than trusted: ~150 tokens is ~600 characters, and a digest that
// silently exceeded it would defeat the tier's only purpose.

import { createHash } from "node:crypto";

/** Rule 4's "≤150 tokens", in characters. ~4 chars/token is the usual rough ratio. */
export const DIGEST_BUDGET_CHARS = 600;

/** How many tool names a digest lists before summarising the rest as a count. */
const MAX_TOOLS = 6;

/**
 * Slice a run's tier-1 events into turns.
 *
 * A turn is everything up to and including a `turn.end`. Trailing events after the last `turn.end`
 * are an IN-FLIGHT turn and are deliberately not returned: a digest of an unfinished turn would be
 * written at the wrong time and then be wrong, and Rule 4 says "written at `turn.end`".
 */
export function splitTurns(events) {
  const turns = [];
  let current = [];
  for (const e of events) {
    current.push(e);
    if (e.type === "turn.end") {
      turns.push(current);
      current = [];
    }
  }
  return turns;
}

/**
 * A CONTENT key for a turn: the same turn, digested twice, produces the same key.
 *
 * Needed because `turnIndex` alone is not a stable identity. After a `resume()` the pump replays the
 * adapter's whole buffered log and every replayed event is persisted AGAIN (event-pump.js: seq is only
 * meaningful within a generation), so one real turn can occupy two slices of `event_log`. Keying on the
 * index would then digest that turn a second time, and the duplicate would reach tier 3 as a second
 * worker stating the same assumption — duplication that INFLATES EVIDENCE, which is worse than
 * duplication that merely wastes a row.
 *
 * COMPUTED FROM THE TURN PROPER — the events at and after the last `turn.start` — not from the whole
 * slice. That is not tidiness; it is the difference between working and not. A slice can pick up stray
 * leading events (a session ending, the seam where a replay begins), so the replayed copy of one turn
 * carries a prefix the original did not, and a key over the whole slice differs. MEASURED: the first
 * version hashed the slice, and the wiring suite showed `echo:first` digested twice under two different
 * keys — while its own "all keys are distinct" assertion passed, because the keys genuinely were.
 *
 * The known false negative, stated rather than hidden: two genuinely distinct turns with byte-identical
 * events (the same input sent twice) share a key, so the second is not digested. Its digest would have
 * been identical to the first, so a reader loses a count and nothing else — the opposite trade from
 * letting one turn masquerade as two.
 */
export function turnKey(turnEvents) {
  const all = turnEvents ?? [];
  let from = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].type === "turn.start") { from = i; break; }
  }
  const canonical = JSON.stringify(all.slice(from).map((e) => [e.type, e.payload ?? {}]));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * The facts a digest is made of. Separated from rendering so they can be asserted directly, and so a
 * model-backed digester has something structured to be given rather than a wall of transcript.
 */
export function turnFacts(turnEvents) {
  const tools = [];
  let prose = "";
  let status = null;
  let isError = false;
  let toolErrors = 0;
  let approvals = 0;

  for (const e of turnEvents) {
    const p = e.payload ?? {};
    switch (e.type) {
      case "tool.start":
        if (p.toolName) tools.push(p.toolName);
        break;
      case "tool.result":
        if (p.isError) toolErrors += 1;
        break;
      case "assistant.delta":
        prose += p.text ?? "";
        break;
      case "approval.request":
        approvals += 1;
        break;
      case "turn.end":
        status = p.status ?? null;
        isError = p.isError === true;
        break;
      default:
        break;
    }
  }
  return {
    status,
    isError,
    tools,
    toolErrors,
    approvals,
    // Normalised, because a digest is one line of prose and raw deltas carry the newlines of a
    // transcript.
    prose: prose.replace(/\s+/g, " ").trim(),
  };
}

/**
 * The extractive digest — the default.
 *
 * Quotes rather than summarises. The last sentence of a worker's own prose is the single most useful
 * thing a resumed worker can be told, and it is verifiable: it is what the worker actually said.
 */
export function extractiveDigest(turnEvents, { budgetChars = DIGEST_BUDGET_CHARS } = {}) {
  const f = turnFacts(turnEvents);
  const parts = [];

  if (f.status && f.status !== "completed") parts.push(`turn ${f.status}`);
  if (f.isError) parts.push("errored");
  if (f.tools.length) {
    const shown = [...new Set(f.tools)].slice(0, MAX_TOOLS);
    const more = f.tools.length - shown.length;
    parts.push(`used ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  if (f.toolErrors) parts.push(`${f.toolErrors} tool error(s)`);
  if (f.approvals) parts.push(`${f.approvals} approval request(s)`);

  const head = parts.length ? `${parts.join("; ")}.` : "";
  // The prose gets whatever budget is left, so the structured facts are never the thing that gets cut.
  const room = Math.max(0, budgetChars - head.length - 1);
  const said = f.prose ? clip(f.prose, room) : "";
  const summary = [head, said].filter(Boolean).join(" ").trim() || "(nothing recorded for this turn)";

  return {
    summary: clip(summary, budgetChars),
    // EMPTY, and that is the honest answer for an extractive digest: nothing in a transcript is
    // labelled as an assumption, so anything here would be inferred. A model-backed digester fills it.
    assumptions: [],
    source: "extractive",
    facts: f,
  };
}

/** Truncate at a word boundary where possible, and SAY it was truncated. */
function clip(text, max) {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * The prompt a model-backed digester is given.
 *
 * Exported and pure so the prompt itself is reviewable and testable — it is the part most likely to
 * drift, and a prompt nobody can see is a prompt nobody can correct. It asks for JSON so the reply can
 * be validated rather than parsed hopefully, and it says the budget out loud because a model that does
 * not know the limit will exceed it.
 */
export function digestPrompt(turnEvents, { budgetChars = DIGEST_BUDGET_CHARS } = {}) {
  const f = turnFacts(turnEvents);
  return [
    "Summarise ONE turn of an AI coding worker for a colleague who will resume this task later.",
    "",
    `Facts: status=${f.status ?? "unknown"}; tools=${[...new Set(f.tools)].join(", ") || "none"};`,
    `tool errors=${f.toolErrors}; approval requests=${f.approvals}.`,
    "",
    "What the worker said this turn:",
    clip(f.prose, 4000) || "(nothing)",
    "",
    `Reply with ONLY JSON: {"summary": string, "assumptions": string[]}`,
    `- summary: at most ${budgetChars} characters, what changed and where things stand. No preamble.`,
    "- assumptions: things the worker TREATED AS TRUE without verifying. Quote or closely paraphrase.",
    "  Use [] if it stated none. Do NOT infer assumptions it did not express — a colleague will act on",
    "  these, so an invented assumption is worse than an empty list.",
  ].join("\n");
}

/**
 * Validate and bound whatever a model returned.
 *
 * NEVER trusts the reply. A model can return prose around the JSON, exceed the budget, or emit
 * `assumptions` as a string — and this is the boundary where a generated artifact becomes a stored one,
 * so it is the right place to be strict. An unparseable reply falls back to the extractive digest rather
 * than storing nothing: a worse digest is more useful than a missing one, and the `source` field says
 * which happened.
 */
export function parseDigestReply(reply, turnEvents, { budgetChars = DIGEST_BUDGET_CHARS } = {}) {
  const fallback = () => ({ ...extractiveDigest(turnEvents, { budgetChars }), source: "extractive-fallback" });
  if (typeof reply !== "string" || !reply.trim()) return fallback();

  // Models wrap JSON in prose and fences often enough that finding the object is the normal path, not
  // an error path.
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return fallback();

  let parsed;
  try { parsed = JSON.parse(reply.slice(start, end + 1)); } catch { return fallback(); }
  if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim()) return fallback();

  const assumptions = Array.isArray(parsed.assumptions)
    ? parsed.assumptions.filter((a) => typeof a === "string" && a.trim()).map((a) => clip(a.trim(), 200)).slice(0, 5)
    : [];

  return {
    summary: clip(parsed.summary.replace(/\s+/g, " ").trim(), budgetChars),
    assumptions,
    source: "model",
    facts: turnFacts(turnEvents),
  };
}
