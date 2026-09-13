// stderr-ring.test.mjs — StderrRing is bounded by BYTES, not by line count (older should-fix
// backlog: "the stderr ring is bounded by line count not bytes, so one huge line is unbounded").
//
// Pure unit test, no real `opencode` process — `StderrRing` has no I/O of its own.
//
// Cases:
//   1. many short lines are bounded by the byte budget, oldest evicted first (the ordinary case)
//   2. ONE line far larger than the entire byte budget is truncated, not stored whole
//   3. many lines each individually under the per-line truncation limit, but far exceeding the
//      total budget together, still bring total memory back under the byte cap

import assert from 'node:assert/strict';
import { StderrRing } from '../adapter.js';

let failed = false;
function testCase(name, fn) {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed = true;
    console.error(`  FAIL — ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

function totalBytes(ring) {
  return ring.lines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8'), 0);
}

testCase('many short lines are bounded by the byte budget, oldest evicted first', () => {
  const ring = new StderrRing(1000); // 1000-byte budget
  for (let i = 0; i < 500; i++) ring.push(`line ${i}`); // ~8 bytes each, 4000 bytes total if unbounded
  assert.ok(totalBytes(ring) <= 1000, `ring must never exceed its byte budget; got ${totalBytes(ring)}`);
  assert.ok(ring.lines.includes('line 499'), 'the newest line must survive eviction');
  assert.ok(!ring.lines.includes('line 0'), 'the oldest line must have been evicted to make room');
});

testCase('ONE line far larger than the entire byte budget is truncated, not stored whole', () => {
  const ring = new StderrRing(1024); // 1 KiB budget
  const huge = 'x'.repeat(10 * 1024 * 1024); // 10 MiB single line, no newline — the exact repro
  ring.push(huge);
  assert.equal(ring.lines.length, 1, 'exactly one entry, since nothing else was pushed');
  assert.ok(
    Buffer.byteLength(ring.lines[0], 'utf8') < huge.length,
    'the stored line must be shorter than the original 10 MiB input — it was truncated, not stored whole',
  );
  assert.ok(ring.lines[0].includes('truncated'), 'the truncation must be visible in the diagnostic text, not silent');
});

testCase('many individually-small-enough lines that together exceed the budget still bound total memory', () => {
  const ring = new StderrRing(4096); // 4 KiB budget
  const lineSize = 500; // under STDERR_RING_MAX_LINE_BYTES, so no per-line truncation kicks in
  for (let i = 0; i < 200; i++) ring.push('y'.repeat(lineSize)); // 100 KiB total if the ring didn't evict
  assert.ok(totalBytes(ring) <= 4096, `total ring bytes (${totalBytes(ring)}) must stay under the 4096-byte budget`);
});

// review-sol-2026-09-13.md finding 33: the exact repro from the review. Truncation used to slice by
// UTF-16 CODE UNITS while measuring the budget in BYTES — a multibyte character (an emoji is 4 UTF-8
// bytes, 2 UTF-16 code units) meant "keep 1024 code units" retained roughly double the byte budget.
testCase('a single-line budget genuinely bounds BYTES, not UTF-16 code units, even for multibyte input', () => {
  const ring = new StderrRing(1024); // 1 KiB budget
  const emoji = '😀'.repeat(2000); // 4 bytes / 2 UTF-16 code units each — 8000 bytes if unbounded
  ring.push(emoji);
  assert.equal(ring.lines.length, 1);
  const storedBytes = Buffer.byteLength(ring.lines[0], 'utf8');
  assert.ok(storedBytes <= 1024, `the stored line must not exceed the 1024-byte budget; got ${storedBytes} bytes (pre-fix repro measured 2038)`);
  assert.ok(ring.lines[0].includes('truncated'), 'truncation must still be visible in the diagnostic text');
});

testCase('maxBytes must be a positive integer, not silently accepted as-is', () => {
  assert.throws(() => new StderrRing(0), /positive integer/);
  assert.throws(() => new StderrRing(-1), /positive integer/);
  assert.throws(() => new StderrRing(NaN), /positive integer/);
  assert.throws(() => new StderrRing('1024'), /positive integer/);
});

if (failed) {
  console.error('\nFAIL: StderrRing byte bound');
  process.exit(1);
}
