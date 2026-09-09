#!/usr/bin/env node
// run.mjs — run the conformance suite against the REAL adapters (PLAN.md section 9).
//
// DELIBERATELY BY HAND. Every check here starts a real harness process; against `claude-code` that
// means real tokens, and against `opencode` it means starting a real `opencode serve`. The
// deterministic version of all of this runs for free in `npm test`
// (`runtime/test/conformance.test.js`) against the fake harness, which is what keeps the suite from
// rotting. This is the step that says the DECLARATIONS match the REAL harnesses.
//
// Run:  node conformance/run.mjs                 # both
//       node conformance/run.mjs claude-code     # one
//
// The declaration-only half needs no processes at all and is already covered for free by case 7 of
// the test suite; what this adds is the behavioural half — start, stream, exit-detection, interrupt
// and clear, actually exercised against the real thing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runConformance, formatReport } from "./suite.js";
import * as claudeCode from "../adapters/claude-code/adapter.js";
import * as openCode from "../adapters/opencode/adapter.js";

const ADAPTERS = { "claude-code": claudeCode, opencode: openCode };
const only = process.argv[2];

// Not under /tmp: on macOS /tmp resolves through a symlink and the tool sandbox compares resolved
// paths (adapters/FINDINGS.md).
const home = process.env.HOME || os.tmpdir();

let bad = 0;
for (const [id, adapter] of Object.entries(ADAPTERS)) {
  if (only && id !== only) continue;
  const cwd = fs.mkdtempSync(path.join(home, `ctd-conf-${id}-`));
  try {
    console.log(`\n=== ${id} ===`);
    const report = await runConformance(adapter, {
      harnessId: id,
      spec: { cwd, prompt: "Reply with the single word: ok" },
      // Real harnesses are slower than the fake by a wide margin: a cold `opencode serve` plus its
      // SSE subscription, or a `claude` cold start, both take seconds before the first event.
      timeoutMs: 90_000,
      interruptPrompt: "Count slowly from 1 to 40, one number per line, with a short pause between each.",
    });
    console.log(formatReport(report));
    if (!report.verdict.passed) bad += 1;
  } catch (err) {
    console.error(`${id}: the suite threw outside a check: ${err.message}`);
    bad += 1;
  } finally {
    try { await adapter.disposeAll?.({ graceMs: 800 }); } catch { /* teardown */ }
    // OpenCode pools a server per cwd, so disposing runs is not enough to stop the server —
    // the declared `residentProcess: 'pooled'` is exactly this difference, showing up in teardown.
    try { await adapter.disposeServer?.(cwd, { graceMs: 2000 }); } catch { /* not all adapters have one */ }
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("");
if (bad) {
  console.error(`${bad} harness(es) did NOT reach the active tier.`);
  process.exit(1);
}
console.log("every harness checked reached the active tier.");
