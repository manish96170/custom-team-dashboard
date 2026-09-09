// wrapper-tier.test.js — PLAN.md section 9's `wrapper` tier: the degraded driver, end to end.
//
// WHY THIS TIER EXISTS AT ALL, and why it is worth testing before any harness needs it: §9 defines
// `wrapper` as the canonical degraded mode for a harness with no structured output, and until now it was
// classification with nothing behind it. A documented tier that nothing exercises hides its architectural
// gaps until integration pressure arrives — and writing it found one immediately (case 4).
//
// THE SCOPE DECISION, stated because the code differs from the design: §9 says `node-pty` + a terminal
// parser. This is PIPES + line splitting with ANSI stripped, and no new dependency. `node-pty` is a native
// build dependency, this project has exactly one dependency on purpose, and there are zero harnesses that
// need a tty today. Two independent models were asked and both chose this, both for the dependency reason.
// `adapters/wrapper/adapter.js`'s header has the full argument, including what a pty would buy.
//
// Cases:
//   1. ANSI is STRIPPED, not interpreted, and a partial line is never emitted as a whole one
//   2. a real command's output becomes transcript events, in order, with the last unterminated line kept
//   3. the process's exit is the ONLY turn boundary, and its status is honest
//   4. a truthful degraded adapter is still tier `wrapper` — the hole writing this tier exposed
//   5. the supervisor drives it like any other harness: real run, real rows, real process group
//   6. every pane for a wrapper-tier run is MARKED, in the header and in the body
//   7. it declares what it cannot do, and the declaration matches the methods it does not have
//   8. nothing is left running
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  openDb, closeDb, upsertHarness, createWorker, createTask, getRun,
} from "../../db/index.js";
import { createSupervisor } from "../supervisor.js";
import * as wrapper from "../../adapters/wrapper/adapter.js";
import { runConformance, verdict } from "../../conformance/suite.js";
import { validateMatrix, requiredMethods, TIERS } from "../../conformance/matrix.js";
import { renderPaneBody } from "../../tui/layout.js";
import { makeScratchDir, rmScratchDir, runTest, waitFor, sleep } from "./_helpers.js";
import { isProcessGroupAlive } from "../procinfo.js";

const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

await runTest("wrapper tier (degraded driver)", async () => {
  const stateDir = makeScratchDir("supervisor-wrapper-test");
  let db;
  let supervisor;
  const groups = new Set();

  try {
    // ── 1 ────────────────────────────────────────────────────────────────────────────
    {
      const coloured = `${ESC}[31mERROR${ESC}[0m: build failed`;
      assert.equal(wrapper.stripAnsi(coloured), "ERROR: build failed", "colour is removed, the words are kept");
      assert.equal(wrapper.stripAnsi(`${ESC}]0;window title${BEL}done`), "done", "an OSC title sequence goes too");
      assert.equal(wrapper.stripAnsi(`a${ESC}[2Kb`), "ab", "and so does a line-erase — DISCARDED, not interpreted");
      assert.equal(wrapper.stripAnsi("plain text"), "plain text");
      assert.equal(wrapper.stripAnsi(undefined), "", "and it is total: no input is empty output, not a throw");

      // A chunk boundary lands mid-line constantly, and emitting the half is the "one fragment per line"
      // defect (FINDINGS §28) at the adapter level.
      const first = wrapper.splitLines("complete line\npartial");
      assert.deepEqual(first.lines, ["complete line"]);
      assert.equal(first.rest, "partial", "the partial line is HELD, not emitted");
      const second = wrapper.splitLines(`${first.rest} finished\n`);
      assert.deepEqual(second.lines, ["partial finished"], "and completed by the next chunk");
      assert.equal(second.rest, "");
      // A CLI writing progress with bare carriage returns must not accumulate one enormous line.
      assert.deepEqual(wrapper.splitLines("a\r\nb\rc\n").lines, ["a", "b", "c"]);
      console.log("  1. ANSI is stripped, and a partial line is held until it is complete");
    }

    // ── 2 and 3 ──────────────────────────────────────────────────────────────────────
    {
      // "Done." and "Build complete" are in here ON PURPOSE. A driver that guessed turn boundaries from
      // output would fire on exactly these words, and without them the guess is never exercised — mutation
      // W4 invents a boundary from `/done|complete|finished/` and the first version of this case passed it,
      // because the fixture's output contained no word a naive parser would take for a boundary. The
      // fixture has to contain the bait for the assertion to mean anything.
      const script = [
        `printf '${ESC}[32mline one${ESC}[0m\\n'`,
        "printf 'Done. Build complete.\\n'",
        "printf 'line two\\n'",
        "printf 'no trailing newline'",
        "exit 3",
      ].join("; ");
      const runId = wrapper.start({ cwd: stateDir, command: "/bin/sh", args: ["-c", script] });
      assert.equal(typeof runId, "string",
        "the adapter contract is a runId STRING, like the other two — `supervisor.start()` binds it straight into SQLite");

      const events = [];
      for await (const e of wrapper.observe(runId)) events.push(e);

      const prose = events.filter((e) => e.type === "assistant.delta").map((e) => e.text.trim());
      assert.deepEqual(prose, ["line one", "Done. Build complete.", "line two", "no trailing newline"],
        `output becomes transcript events in order, colour stripped; got ${JSON.stringify(prose)}`);
      // The LAST line has no newline, and it is the one most likely to say why something failed.
      assert.ok(prose.includes("no trailing newline"),
        "an unterminated final line must be flushed at exit rather than lost");
      assert.ok(events.every((e) => e.type === "session.init" || e.degraded === true),
        "every event carries `degraded: true`, so nothing downstream can mistake it for a parsed stream");

      const turnEnds = events.filter((e) => e.type === "turn.end");
      assert.equal(turnEnds.length, 1,
        "the process exit is the ONLY turn boundary — nothing in raw output marks one, and inventing one would be a guess a tier-2 digest would then summarise as fact");
      assert.equal(turnEnds[0].status, "error", "a non-zero exit is an error turn, not a completed one");
      assert.equal(turnEnds[0].exitCode, 3, "with the real exit code");
      console.log("  2. a real command's output became ordered transcript events, last line included");
      console.log("  3. the process exit was the only turn boundary, with an honest status");
    }

    // ── 4 ────────────────────────────────────────────────────────────────────────────
    // THE HOLE WRITING THIS TIER EXPOSED. `verdict()` derived the tier from "did the checks pass", which
    // reads correctly for §9's two named cases (no matrix; a matrix whose claims do not hold) and gets the
    // third one exactly backwards: a degraded driver that tells the truth passes every check. The
    // mechanism that exists to stop a degraded harness being treated as equivalent would have marked the
    // one adapter that is degraded BY DEFINITION as `active`.
    {
      const declared = wrapper.capabilities();
      assert.deepEqual(validateMatrix(declared).problems, [], "the wrapper's declaration is well-formed");

      const clean = verdict([{ name: "matrix:declared", status: "pass" }], declared);
      assert.equal(clean.tier, TIERS.WRAPPER,
        "a terminal-driven harness is wrapper tier however well it behaves — that is what the tier MEANS");
      assert.equal(clean.passed, true,
        "while `passed` stays true: 'does what it says' and 'is degraded' are different facts, and collapsing them would make a conforming wrapper indistinguishable from a broken adapter");
      assert.match(clean.reason, /by definition, not a failure/, "and the reason says which of the three situations it is");

      // The other two paths still read the way §9 describes them.
      assert.equal(verdict([{ name: "matrix:declared", status: "fail" }], null).tier, TIERS.WRAPPER);
      assert.match(verdict([{ name: "matrix:declared", status: "fail" }], null).reason, /no usable capability matrix/);
      const structured = { ...declared, structuredOutput: "stream-json" };
      assert.equal(verdict([{ name: "matrix:declared", status: "pass" }], structured).tier, TIERS.ACTIVE,
        "and a structured adapter that passes is still active — the new rule must not degrade everything");

      // Against the real adapter, through the real suite.
      const report = await runConformance(wrapper, {
        harnessId: "wrapper",
        spec: { cwd: stateDir, command: "/bin/sh", args: ["-c", "printf 'ok\\n'"] },
        timeoutMs: 8000,
      });
      assert.equal(report.verdict.tier, TIERS.WRAPPER, `the real suite must agree; got ${JSON.stringify(report.verdict)}`);
      console.log("  4. a truthful degraded adapter is still tier `wrapper` — the hole this tier exposed");
    }

    // ── 5 ────────────────────────────────────────────────────────────────────────────
    {
      db = openDb({ stateDir });
      upsertHarness(db, { id: "wrapper", displayName: "Wrapper (degraded)", status: "wrapper" });
      createTask(db, { id: "t1", title: "drive a dumb CLI", type: "chore" });
      createWorker(db, { workerId: "w1", nickname: "dumb", role: "coder", taskId: "t1" });

      supervisor = createSupervisor({ db, stateDir, adapters: { wrapper }, askSweepIntervalMs: 0, logger: quiet });
      await supervisor.boot();

      const { runId } = await supervisor.start({
        harnessId: "wrapper", workerId: "w1",
        spec: { cwd: stateDir, command: "/bin/sh", args: ["-c", "printf 'hello from a dumb CLI\\n'; sleep 30"] },
      });
      await waitFor(
        () => db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE run_id = ? AND tier = 1").get(runId).n > 1,
        { timeoutMs: 8000, pollMs: 50, what: "the wrapper run to persist events" },
      );

      const row = getRun(db, runId);
      assert.equal(row.harness_id, "wrapper");
      // The one thing this tier does exactly as well as a real adapter, and the thing that makes it
      // reapable rather than orphan-prone: its own process group.
      assert.ok(Number.isInteger(row.pid) && row.pid > 0, "a real pid was verified and persisted");
      assert.equal(row.process_group, row.pid, "and the run leads its own process group");
      groups.add(row.process_group);
      assert.ok(isProcessGroupAlive(row.process_group), "which is genuinely alive");

      const types = db.prepare("SELECT type FROM event_log WHERE run_id = ? AND tier = 1 ORDER BY seq").all(runId).map((r) => r.type);
      assert.ok(types.includes("assistant.delta"), `the CLI's output was persisted as transcript; got ${types.join(", ")}`);

      // Tier 2 must NOT have digested anything yet: there is no turn boundary until the process exits.
      assert.deepEqual(supervisor.turnDigests(runId), [],
        "no turn has ended, so no digest — a tier with no turn boundaries must not fabricate one");

      // And a reap takes the whole group down, because the identity is real.
      const reaped = await supervisor.reap(runId);
      assert.equal(reaped.reaped, true, `a wrapper-tier run is reapable; got ${JSON.stringify(reaped)}`);
      await waitFor(() => !isProcessGroupAlive(row.process_group), { timeoutMs: 5000, pollMs: 50, what: "the group to die" });
      console.log("  5. the supervisor drove it like any other harness, and reaped it by verified identity");
    }

    // ── 6 ────────────────────────────────────────────────────────────────────────────
    // §9: a wrapper-tier harness "is always explicitly marked as such in the UI — never silently treated as
    // equivalent to a real, conformance-passing adapter". Twice, because a narrow split pane truncates the
    // header and the mark is the difference between "the worker said this" and "this is raw terminal output
    // nobody parsed".
    {
      const snap = supervisor.commandHandlers();
      const reply = await snap.tuiSnapshot({ id: "s1", cmd: "tuiSnapshot" });
      const run = reply.runs.find((r) => r.harnessId === "wrapper");
      assert.ok(run, "the snapshot carries the run");
      assert.equal(run.harnessTier, "wrapper", "with its harness's tier, read from the conformance verdict");
      assert.equal(run.degraded, true, "and a flag the UI does not have to derive");

      const body = renderPaneBody(
        { role: "dev", title: "dumb (coder) — abc12345", status: "running", degraded: true, lines: ["hello"] },
        80, 12,
      ).join("\n");
      assert.match(body, /\[wrapper tier\]/, "the pane header says so");
      assert.match(body, /degraded driver: raw terminal output/, "and the body says what that costs");
      assert.match(body, /no approvals/, "including the capability it does NOT have, which is the dangerous one");

      const normal = renderPaneBody({ role: "dev", title: "purus (coder)", status: "running", lines: ["hi"] }, 80, 12).join("\n");
      assert.equal(normal.includes("wrapper tier"), false, "and a real adapter's pane is not marked");
      console.log("  6. every wrapper-tier pane is marked, in the header and in the body");
    }

    // ── 7 ────────────────────────────────────────────────────────────────────────────
    // The declaration is the contract, so the methods it does NOT require must genuinely be absent — an
    // adapter that declares `clearContext: false` and exports one anyway invites a caller to use a path
    // nothing verifies.
    {
      const declared = wrapper.capabilities();
      for (const method of requiredMethods(declared)) {
        assert.equal(typeof wrapper[method], "function", `the declaration requires ${method}()`);
      }
      assert.equal(declared.approvalProtocol, false, "no permission protocol — a raw CLI has none to speak");
      assert.equal(typeof wrapper.answerApproval, "undefined",
        "so there is no answerApproval to call, which is what stops an `ask` being created that nobody can answer");
      assert.equal(declared.clearContext, false);
      assert.equal(typeof wrapper.clearContext, "undefined");
      assert.equal(declared.resumableTurns, false);
      assert.equal(typeof wrapper.resume, "undefined");
      assert.equal(declared.interrupt, "process", "interrupt is a KILL here, which is §7's clean-vs-kill landing on kill");
      assert.equal(typeof wrapper.interrupt, "function");

      // And `start` refuses to guess: a wrapper-tier harness IS "a command nobody wrote an adapter for".
      assert.throws(() => wrapper.start({ cwd: stateDir }), /spec.command is required/,
        "guessing a command would make a misconfiguration look like a harness that produces no output");
      assert.throws(() => wrapper.start({ command: "/bin/sh" }), /spec.cwd is required/);
      console.log("  7. it declares what it cannot do, and genuinely does not export those paths");
    }

    // ── 8 ────────────────────────────────────────────────────────────────────────────
    {
      await wrapper.disposeAll({ graceMs: 300 });
      await sleep(300);
      // `ps` is a test — the Phase 2 lesson after 29 leaked children went unnoticed.
      const survivors = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
        .split("\n").filter((l) => l.includes(stateDir)).map((l) => l.trim());
      assert.deepEqual(survivors, [], `processes survived:\n  ${survivors.join("\n  ")}`);
      for (const g of groups) assert.equal(isProcessGroupAlive(g), false, `process group ${g} is gone`);
      console.log("  8. nothing was left running");
    }
  } finally {
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* teardown */ }
    try { await wrapper.disposeAll({ graceMs: 300 }); } catch { /* teardown */ }
    try { if (db) closeDb(db); } catch { /* teardown */ }
    await sleep(150);
    rmScratchDir(stateDir);
  }
});
