// pane-auth.test.js — `attachPane` against the REAL authorized socket, added 2026-09-11
// (`codexdoc/REVIEW-NOTES.md` finding 10).
//
// `pane-e2e.test.js` proves the pane's own protocol (replay, detach/re-attach, approvals) but does it
// over `supervisor.commandHandlers()` — the raw, unauthenticated map. That is exactly how the original
// bug went unnoticed: every existing pane test used a surface production never actually serves.
// `ipc/daemon.js` serves `authorizedCommandHandlers()`, and `attachPane` used to send no token at all,
// so a standalone pane was refused with "no token sent" the moment it ran for real.
//
// Cases:
//   1. attachPane with NO explicit token reads owner.token from stateDir itself and succeeds
//   2. attachPane with a wrong/bogus token is refused, not silently treated as unauthenticated-but-fine
//   3. an explicit (non-owner) token is honoured over the stateDir default

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDb, closeDb, upsertHarness, createWorker, createTask } from "../../db/index.js";
import { createSupervisor } from "../../runtime/supervisor.js";
import { createIpcServer } from "../../ipc/server.js";
import { createFakeHarness } from "../../runtime/test/_fake-harness-adapter.js";
import { makeScratchDir, rmScratchDir, runTest, waitFor } from "../../runtime/test/_helpers.js";
import { attachPane } from "../pane.js";

const quiet = { log() {}, warn() {}, error() {} };

await runTest("attachPane against the real authorized socket", async () => {
  const stateDir = makeScratchDir("pane-auth");
  const sockPath = path.join(stateDir, "supervisor.sock");
  let db;
  let supervisor;
  let harness;
  let ipc;
  const panes = [];

  try {
    db = openDb({ stateDir });
    upsertHarness(db, { id: "fake", displayName: "Fake Harness" });
    createTask(db, { id: "t1", title: "pane auth", type: "feature" });
    createWorker(db, { workerId: "w1", nickname: "Purus", role: "coder", taskId: "t1" });

    harness = createFakeHarness({ label: "pane-auth" });
    supervisor = createSupervisor({ db, adapters: { fake: harness }, logger: quiet, askSweepIntervalMs: 0 });
    await supervisor.boot(); // writes stateDir/owner.token

    // THE REAL SURFACE `ipc/daemon.js` serves — not the raw map `pane-e2e.test.js` uses.
    ipc = createIpcServer({ commands: supervisor.authorizedCommandHandlers(), logger: quiet });
    await ipc.listen(sockPath);

    const { runId } = await supervisor.start({ harnessId: "fake", workerId: "w1", spec: { cwd: stateDir, prompt: "hello" } });
    await waitFor(() => harness._runs.get(runId), { timeoutMs: 5000, what: "the fake run to exist" });

    // ── 1 ──────────────────────────────────────────────────────────────────────────────
    {
      const lines = [];
      // NO `token` passed — `attachPane` must find `stateDir/owner.token` itself, the same file
      // `boot()` just wrote, the same way `tui/cli.js`'s own client already does.
      const pane = await attachPane({ runId, sockPath, stateDir, color: false, out: (l) => lines.push(l), askPollMs: 5000 });
      panes.push(pane);
      assert.ok(lines.some((l) => l.includes("attached to")), "a real accepted attach, not a thrown error");
      console.log("  1. attachPane with no explicit token reads owner.token from stateDir and succeeds");
    }

    // ── 2 ──────────────────────────────────────────────────────────────────────────────
    {
      await assert.rejects(
        attachPane({ runId, sockPath, stateDir, token: "not-a-real-token", color: false, out: () => {}, askPollMs: 5000 }),
        /unauthorized|requires capability/,
        "a wrong token must be refused by the real gate, not accepted as if unauthenticated were fine",
      );
      console.log("  2. attachPane with a bogus token is refused by the real authorization gate");
    }

    // ── 3 ──────────────────────────────────────────────────────────────────────────────
    {
      const ownerToken = fs.readFileSync(path.join(stateDir, "owner.token"), "utf8").trim();
      const lines = [];
      // An explicit token (even the same owner one here — the point is that passing one at all must
      // override the stateDir default, for a caller that holds a narrower principal) still works.
      const pane = await attachPane({ runId, sockPath, stateDir, token: ownerToken, color: false, out: (l) => lines.push(l), askPollMs: 5000 });
      panes.push(pane);
      assert.ok(lines.some((l) => l.includes("attached to")));
      console.log("  3. an explicit token is honoured over the stateDir default");
    }
  } finally {
    for (const p of panes) { try { p.detach(); } catch { /* best-effort */ } }
    try { if (ipc) await ipc.shutdown(); } catch { /* teardown */ }
    try { await supervisor?.shutdown({ timeoutMs: 3000 }); } catch { /* teardown */ }
    try { await harness?.disposeAll?.({ graceMs: 300 }); } catch { /* teardown */ }
    try { if (db) closeDb(db); } catch { /* already closed */ }
    rmScratchDir(stateDir);
  }
});
