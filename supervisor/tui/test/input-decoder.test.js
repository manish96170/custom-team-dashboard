// input-decoder.test.js — ChatGPT review, 2026-09-14: `decodeKey`/`decodeMouse` each assume one stdin
// `data` chunk is exactly one complete token. Confirmed real before writing any fix (see app.js's own
// `createInputDecoder` header comment for the exact repro): a chunk `"abc"` decoded to `null` and was
// silently DROPPED entirely (not three keys); a bare `ESC` in one chunk immediately decoded to
// `"escape"` even when the very next chunk was `"[A"` (an arrow key split across two `data` events), and
// that trailing `"[A"` was ALSO dropped. `createInputDecoder` buffers across `feed()` calls and only
// emits once it has a complete token — these cases prove that against the real function, not a
// reimplementation.
//
// No terminal, no socket — `createInputDecoder` is pure I/O-adjacent buffering logic with an injectable
// callback, testable exactly like `decodeKey`/`decodeMouse` themselves.
//
// Cases:
//   1. a single chunk "abc" -> three separate key events, not dropped
//   2. a fragmented escape sequence (ESC in one chunk, "[A" in the next) -> one "up" event
//   3. a coalesced escape sequence "\x1b[A" in one chunk -> one "up" event
//   4. "jjjj" in one chunk -> four separate key events
//   5. a complete SGR mouse report split across two chunks -> decodes correctly
//   6. a multi-byte UTF-8 character (emoji) split across two chunks -> one correct character, not two
//      mangled ones
//   7. a whole emoji in ONE chunk decodes to one key event (decodeKey's own pre-existing UTF-16
//      surrogate-pair bug, fixed alongside this)
//   8. a genuinely standalone Escape keypress (nothing follows) still decodes to "escape", after the
//      disambiguation window elapses
//   9. dispose() cancels a pending escape-disambiguation timer so it never fires late

import assert from "node:assert/strict";
import { createInputDecoder, decodeKey } from "../app.js";

let failed = 0;
let n = 0;
const cases = [];
function testCase(name, fn) {
  cases.push({ name, fn });
}

function collector() {
  const events = [];
  const decoder = createInputDecoder({ onEvent: (e) => events.push(e), escapeTimeoutMs: 20 });
  return { decoder, events };
}

testCase('a single chunk "abc" decodes to three separate key events, not dropped', () => {
  const { decoder, events } = collector();
  decoder.feed(Buffer.from("abc"));
  assert.deepEqual(events.map((e) => e.key), ["a", "b", "c"]);
});

testCase('a fragmented escape sequence (ESC then "[A" in separate chunks) decodes to one "up" event', async () => {
  const { decoder, events } = collector();
  decoder.feed(Buffer.from("\x1b"));
  assert.equal(events.length, 0, "must NOT decide anything yet — the ESC might be starting a sequence");
  decoder.feed(Buffer.from("[A"));
  assert.deepEqual(events, [{ type: "key", key: "up" }], "the two fragments together must decode to exactly one up-arrow event");
  decoder.dispose();
});

testCase('a coalesced escape sequence "\\x1b[A" in one chunk decodes to one "up" event', () => {
  const { decoder, events } = collector();
  decoder.feed(Buffer.from("\x1b[A"));
  assert.deepEqual(events, [{ type: "key", key: "up" }]);
  decoder.dispose();
});

testCase('"jjjj" in one chunk decodes to four separate key events', () => {
  const { decoder, events } = collector();
  decoder.feed(Buffer.from("jjjj"));
  assert.deepEqual(events.map((e) => e.key), ["j", "j", "j", "j"]);
});

testCase("a complete SGR mouse report split across two chunks decodes correctly", () => {
  const { decoder, events } = collector();
  const full = "\x1b[<0;10;5M";
  decoder.feed(Buffer.from(full.slice(0, 5)));
  assert.equal(events.length, 0, "must wait for the rest of the report, not misfire on a partial one");
  decoder.feed(Buffer.from(full.slice(5)));
  assert.deepEqual(events, [{ type: "mouse", click: { col: 9, row: 4 } }]);
});

testCase("a multi-byte UTF-8 character split across two chunks decodes to one correct character", () => {
  const { decoder, events } = collector();
  const emoji = Buffer.from("😀", "utf8"); // 4-byte UTF-8
  assert.equal(emoji.length, 4, "sanity: this fixture really is a 4-byte UTF-8 character");
  decoder.feed(emoji.slice(0, 2));
  assert.equal(events.length, 0, "must wait for the remaining bytes of the character, not emit a mangled partial");
  decoder.feed(emoji.slice(2));
  assert.deepEqual(events, [{ type: "key", key: "😀" }], "the two halves together must decode to the ONE correct character, not two");
});

testCase("a whole emoji in one chunk decodes to one key event (decodeKey's own surrogate-pair fix)", () => {
  assert.equal(decodeKey(Buffer.from("😀")), "😀", "a complete 4-byte UTF-8 character must decode even with no fragmentation involved");
  const { decoder, events } = collector();
  decoder.feed(Buffer.from("😀"));
  assert.deepEqual(events, [{ type: "key", key: "😀" }]);
});

testCase("a genuinely standalone Escape keypress still decodes to \"escape\" once the disambiguation window elapses", async () => {
  const { decoder, events } = collector();
  decoder.feed(Buffer.from("\x1b"));
  assert.equal(events.length, 0, "must not fire immediately — indistinguishable from the start of a sequence at this point");
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(events, [{ type: "key", key: "escape" }], "once nothing else arrives, the buffered ESC must resolve to a real Escape keypress");
});

testCase("dispose() cancels a pending escape-disambiguation timer so it never fires late", async () => {
  const { decoder, events } = collector();
  decoder.feed(Buffer.from("\x1b"));
  decoder.dispose();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(events.length, 0, "a disposed decoder must never emit an event from a timer it was told to cancel");
});

for (const { name, fn } of cases) {
  n += 1;
  try {
    await fn();
    console.log(`  ${n}. ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL: ${name}`);
    console.error(err);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${n} case(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: input-decoder (${n} cases)`);
}
