// pane-e2e.test.js — the Phase 2 slice through a pane, over a real Unix socket:
// spawn -> live pane -> send input -> approval round trip -> cancel -> detach/re-attach.
//
// The pane is a plain socket client with no database handle, so what has to be real here is the
// socket, the wire protocol, the supervisor and the child processes — all of which are. Only the
// daemon's *entry point* (lock acquisition, signal handling) is skipped, because
// `runtime/test/daemon-crash.test.js` already covers exactly that against the real `ipc/daemon.js`,
// and the daemon registers only the real harness adapters, which would make this test hostage to
// `claude` being installed and logged in.
//
// The case that matters most is 5: **detaching must not disturb the run, and re-attaching must
// resume by cursor rather than replay from the beginning.** That is what section 5 means by
// "replayed by cursor when a pane is switched to", and it is the property that makes a pane
// switchable at all.

import assert from "node:assert/strict";
import path from "node:path";
import { openDb, closeDb, upsertHarness, createWorker, createTask } from "../../db/index.js";
import { createSupervisor } from "../../runtime/supervisor.js";
import { createIpcServer } from "../../ipc/server.js";
import { killProcessGroup } from "../../runtime/spawn.js";
import { createFakeHarness } from "../../runtime/test/_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, waitFor, sleep } from "../../runtime/test/_helpers.js";
import { attachPane, parsePaneCommand } from "../pane.js";

const quiet = { log() {}, warn() {}, error() {} };

await runTest("pane end-to-end over a real socket", async () => {
  const stateDir = makeScratchDir("pane-e2e");
  const sockPath = path.join(stateDir, "supervisor.sock");
  const liveGroups = new Set();
  let db;
  let supervisor;
  let harness;
  let ipc;
  const panes = [];

  const park = async (runId, request) => {
    harness._runs.get(runId).child.stdin.write(`${JSON.stringify({ type: "ask", ...request })}\n`);
    return waitFor(() => supervisor.asks({ runId }).find((a) => a.harnessRequestId === request.requestId), {
      timeoutMs: 5000,
      what: `an ask for ${request.requestId}`,
    });
  };

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createTask(db, { id: "t1", title: "pane slice", type: "feature" });
    createWorker(db, { workerId: "w1", nickname: "Purus", role: "coder", taskId: "t1" });

    harness = createFakeHarness({ label: "pane" });
    supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askSweepIntervalMs: 0 });
    await supervisor.boot();

    ipc = createIpcServer({ commands: supervisor.commandHandlers(), logger: quiet });
    await ipc.listen(sockPath);

    const { runId } = await supervisor.start({ harnessId: "fake", workerId: "w1", spec: { cwd: stateDir, prompt: "hello pane" } });
    liveGroups.add(db.prepare("SELECT process_group FROM runs WHERE run_id = ?").get(runId).process_group);

    // ── 1. attaching replays what already happened ─────────────────────────────────
    // The run produced its first turn before any pane existed. A pane that only showed events
    // arriving after it attached would show an empty screen for a run that has been working for
    // ten minutes, which is the single most useful case for a dashboard.
    const lines = [];
    const pane = await attachPane({ runId, sockPath, color: false, out: (l) => lines.push(l), askPollMs: 150 });
    panes.push(pane);

    await waitFor(() => pane.transcript().includes("turn completed"), {
      timeoutMs: 5000,
      what: "the pane to replay the first turn",
    });
    assert.match(pane.transcript(), /echo:hello pane/, "the assistant output from before we attached is replayed");
    assert.ok(pane.cursor > 0, `the cursor advanced past the replayed events (${pane.cursor})`);
    console.log(`  1. attaching replayed ${pane.cursor} event(s) that happened before the pane existed`);

    // ── 2. typed text reaches the worker ───────────────────────────────────────────
    {
      const cmd = parsePaneCommand("what is 2 + 2?");
      assert.deepEqual(cmd, { kind: "input", text: "what is 2 + 2?" }, "plain text is a message, not a command");
      await pane.sendInput(cmd.text);
      await waitFor(() => pane.transcript().includes("echo:what is 2 + 2?"), {
        timeoutMs: 5000,
        what: "the worker's reply to the typed input",
      });
      console.log("  2. a typed line reached the worker and its reply arrived in the pane");
    }

    // ── 3. the approval round trip, entirely through the pane ──────────────────────
    {
      await park(runId, {
        requestId: "req-pane-1",
        toolName: "Bash",
        description: "rm -rf node_modules",
        input: { command: "rm -rf node_modules" },
      });
      await waitFor(() => pane.transcript().includes("APPROVAL NEEDED"), {
        timeoutMs: 5000,
        what: "the approval to appear in the pane",
      });
      const transcript = pane.transcript();
      assert.match(transcript, /rm -rf node_modules/, "the exact command is in the pane — you cannot approve what you cannot read");
      assert.match(transcript, /the worker is waiting/);

      await waitFor(() => pane.pending.length === 1, { timeoutMs: 3000, what: "the pane to see the pending ask" });
      assert.equal(pane.pending[0].answerable, true);

      // Deny it with a reason, the way an operator would type it.
      const cmd = parsePaneCommand("/deny not on this machine");
      assert.deepEqual(cmd, { kind: "answer", allow: false, text: "not on this machine" });
      const result = await pane.answer(cmd);
      assert.equal(result.ok, true, `the answer should have gone through: ${result.error ?? ""}`);
      assert.equal(result.delivered, true, "and reached the parked worker");

      await waitFor(() => pane.transcript().includes("tool failed"), {
        timeoutMs: 5000,
        what: "the worker to resume and report the refusal",
      });
      assert.match(pane.transcript(), /not on this machine/, "the operator's reason is visible in the pane too");
      assert.equal(pane.pending.length, 0, "nothing is blocked any more");
      console.log("  3. an approval appeared in the pane, was denied with a reason, and the worker resumed");
    }

    // ── 4. a question is answered by one typed line ────────────────────────────────
    // The harness requires answers keyed by the exact question text; the pane maps a single typed
    // line onto the single question rather than making an operator type JSON.
    {
      const question = "Which branch?";
      await park(runId, {
        requestId: "req-pane-q",
        toolName: "AskUserQuestion",
        requiresUserInteraction: true,
        input: { questions: [{ question, header: "Branch", options: [{ label: "main" }, { label: "develop" }] }] },
      });
      await waitFor(() => pane.transcript().includes("QUESTION"), { timeoutMs: 5000, what: "the question in the pane" });
      assert.match(pane.transcript(), /Which branch\?/);
      assert.match(pane.transcript(), /· develop/, "the options are listed");

      await waitFor(() => pane.pending.length === 1, { timeoutMs: 3000, what: "the pane to see the question" });
      const result = await pane.answer(parsePaneCommand("/answer develop"));
      assert.equal(result.ok, true, result.error ?? "");
      assert.equal(result.decision, "answered");

      const answered = db.prepare("SELECT answer_json FROM asks WHERE harness_request_id = 'req-pane-q'").get();
      assert.deepEqual(
        JSON.parse(answered.answer_json),
        { [question]: "develop" },
        "one typed line became an answer keyed by the exact question text",
      );
      console.log("  4. a question was answered with one typed line, keyed to the exact question text");
    }

    // ── 5. detaching leaves the run alone; re-attaching resumes by cursor ──────────
    {
      const cursorAtDetach = pane.cursor;
      const seenBefore = pane.transcript();
      pane.detach();
      panes.pop();

      // The run must keep working with nobody watching — that is the difference between a pane and
      // a terminal, and it is why the supervisor owns the event consumer rather than the client.
      await supervisor.sendInput(runId, "still there?");
      await waitFor(
        () => db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE run_id = ? AND seq > ?").get(runId, cursorAtDetach).n > 0,
        { timeoutMs: 5000, what: "the run to keep producing events with no pane attached" },
      );
      assert.equal(db.prepare("SELECT ended_at FROM runs WHERE run_id = ?").get(runId).ended_at, null, "detaching did not end the run");

      const freshLines = [];
      const second = await attachPane({
        runId,
        sockPath,
        color: false,
        fromSeq: cursorAtDetach,
        out: (l) => freshLines.push(l),
        askPollMs: 150,
      });
      panes.push(second);
      await waitFor(() => second.transcript().includes("echo:still there?"), {
        timeoutMs: 5000,
        what: "the re-attached pane to receive what it missed",
      });
      assert.ok(!second.transcript().includes("echo:hello pane"), "resuming from a cursor does NOT replay the whole history again");
      assert.ok(seenBefore.includes("echo:hello pane"), "...which the first pane had already shown");
      console.log(`  5. detached at seq ${cursorAtDetach}, the run kept going, and re-attaching replayed only what was missed`);
    }

    // ── 6. two panes on one run each get their own cursor ──────────────────────────
    // `observe` is a fan-out from the supervisor's single consumer, so a second watcher must not
    // steal the first one's stream — the defect the event pump was built to fix.
    {
      const aLines = [];
      const bLines = [];
      const a = await attachPane({ runId, sockPath, color: false, out: (l) => aLines.push(l), askPollMs: 150 });
      const b = await attachPane({ runId, sockPath, color: false, out: (l) => bLines.push(l), askPollMs: 150 });
      panes.push(a, b);

      await supervisor.sendInput(runId, "two watchers");
      for (const [name, p] of [["a", a], ["b", b]]) {
        await waitFor(() => p.transcript().includes("echo:two watchers"), {
          timeoutMs: 5000,
          what: `pane ${name} to receive the event`,
        });
      }
      console.log("  6. two panes attached to one run both received the same event, each on its own cursor");
    }

    // ── 7. cancel: the turn is interrupted, the process survives ───────────────────
    // PLAN.md section 7's clean-vs-kill distinction, at the pane level: cancelling a turn is not
    // killing the worker, and a pane must not conflate them.
    {
      const pane2 = panes[panes.length - 1];
      assert.deepEqual(parsePaneCommand("/interrupt"), { kind: "interrupt" });
      const pidBefore = db.prepare("SELECT pid FROM runs WHERE run_id = ?").get(runId).pid;
      await pane2.interrupt();
      await waitFor(() => pane2.transcript().includes("turn aborted"), {
        timeoutMs: 5000,
        what: "the interrupted turn to report as aborted",
      });
      const row = db.prepare("SELECT pid, ended_at FROM runs WHERE run_id = ?").get(runId);
      assert.equal(row.ended_at, null, "an interrupt cancels the TURN, not the run");
      assert.equal(row.pid, pidBefore, "and the same process is still serving it");
      console.log("  7. /interrupt aborted the turn and left the same process alive");
    }

    // ── 8. a streaming line is signalled as an UPDATE, not repeated ───────────────
    // The renderer hands back the whole coalesced line each time a delta arrives, because that is
    // what a pane needs in order to redraw. An append-only consumer that ignores the signal prints
    // the line once per token — which is exactly what the first real captured transcript did:
    // "assistant The", "assistant The page", "assistant The page title"...
    {
      const events = [];
      const streamPane = await attachPane({
        runId,
        sockPath,
        color: false,
        fromSeq: 0,
        out: (line, meta) => events.push({ line, replaces: meta?.replacesPrevious === true }),
        askPollMs: 150,
      });
      panes.push(streamPane);
      await waitFor(() => events.some((e) => e.line.includes("echo:hello pane")), {
        timeoutMs: 5000,
        what: "the replayed assistant line",
      });

      const prose = events.filter((e) => e.line.includes("assistant"));
      assert.ok(prose.length > 0, "an assistant line was rendered");
      const updates = prose.filter((e) => e.replaces);
      assert.ok(updates.length > 0, "a streamed line produced update frames, not just one final frame");

      // The property that matters is not a count — the run has had several turns, so several prose
      // lines legitimately start. It is that every frame flagged as an update EXTENDS the frame
      // before it rather than repeating it, and that a line only ever starts when it is not flagged.
      for (let i = 1; i < prose.length; i += 1) {
        if (!prose[i].replaces) continue;
        assert.ok(
          prose[i].line.startsWith(prose[i - 1].line) && prose[i].line.length > prose[i - 1].line.length,
          `an update must extend the previous line, not repeat it:\n  prev: ${prose[i - 1].line}\n  next: ${prose[i].line}`,
        );
      }

      // ...and a discrete event after the prose is NOT an update to it.
      const afterProse = events.slice(events.indexOf(prose[prose.length - 1]) + 1).find((e) => e.line.includes("turn"));
      if (afterProse) assert.equal(afterProse.replaces, false, "a turn.end is its own line, not an update to the prose");
      console.log(`  8. ${updates.length} streamed update(s) each extended the line before it; no prose line was repeated`);
    }

    // ── 9. the command grammar refuses what it cannot do ──────────────────────────
    // A pane that guessed here would produce exactly the failure the supervisor refuses: an
    // approval nobody explicitly gave, or a question "answered" with nothing in it.
    {
      assert.deepEqual(parsePaneCommand("/answer"), { kind: "error", error: "/answer needs some text" });
      assert.match(parsePaneCommand("/frobnicate").error, /unknown command/);
      assert.deepEqual(parsePaneCommand("   "), { kind: "noop" });
      assert.deepEqual(parsePaneCommand("/deny"), { kind: "answer", allow: false, text: undefined });

      // Answering when nothing is pending must be refused rather than sent somewhere.
      const pane2 = panes[panes.length - 1];
      const nothing = await pane2.answer({ allow: true });
      assert.equal(nothing.ok, false);
      assert.match(nothing.error, /nothing is waiting/);
      console.log("  9. malformed commands and answering-nothing were refused with reasons");
    }
  } finally {
    for (const p of panes) {
      try {
        p.detach();
      } catch { /* already gone */ }
    }
    if (ipc) await ipc.shutdown({ timeoutMs: 2000 }).catch(() => {});
    if (supervisor) await supervisor.shutdown({ timeoutMs: 4000 }).catch(() => {});
    if (harness) await harness.disposeAll({ graceMs: 200 }).catch(() => {});
    for (const pgid of liveGroups) {
      if (Number.isInteger(pgid) && pgid > 1) await killProcessGroup(pgid, { graceMs: 100 }).catch(() => {});
    }
    if (db) closeDb(db);
    rmScratchDir(stateDir);
  }
});
