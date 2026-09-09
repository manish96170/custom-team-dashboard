// daemon.js — the runnable supervisor. Group 5 turned this from a composition *demo*
// into the real thing: it now opens the real database, registers the real harness
// adapters, boots the real supervisor (routing rehydrated from persisted rows, then
// startup reconciliation), and serves the supervisor's own command surface.
//
// What composes here, in order, and why the order matters:
//   1. the safety net, installed first, before anything else can throw
//   2. the real single-instance lock, IMPORTED from supervisor/lock/lock.js (never
//      reimplemented here) — the single-writer invariant the whole design rests on
//   3. the real database + adapters + supervisor, then `boot()`: no lifecycle status is
//      trusted anywhere until reconciliation has run (PLAN.md section 4)
//   4. createIpcServer({ commands: sup.commandHandlers() }) — the constructor-argument
//      swap that ipc/persistence-stub.js and ipc/mock-adapter.js were placeholders for
//   5. bounded teardown on either signal: sockets destroyed, adapters disposed
//      (including pooled `opencode serve` processes), lock released, then exit
//
// Run directly: `node supervisor/ipc/daemon.js`
// Stop with Ctrl-C (SIGINT) or `kill <pid>` (SIGTERM) — both go through the same bounded
// shutdown rather than the default net.Server behavior that hangs on any open `observe`
// connection (review finding S11).

import { fileURLToPath } from "node:url";
import { installProcessSafetyNet } from "./safety.js";
import { createIpcServer } from "./server.js";
import { defaultSockPath, defaultStateDir } from "./paths.js";
import { acquireLock } from "../lock/lock.js";
import { openDb, closeDb } from "../db/index.js";
import { createSupervisor } from "../runtime/supervisor.js";
import * as claudeCodeAdapter from "../adapters/claude-code/adapter.js";
import * as opencodeAdapter from "../adapters/opencode/adapter.js";

function log(...args) {
  process.stdout.write(`[supervisor pid=${process.pid}] ${new Date().toISOString()} ${args.join(" ")}\n`);
}

async function main() {
  installProcessSafetyNet({ logger: console });

  const stateDir = defaultStateDir();
  const sockPath = defaultSockPath(stateDir);

  // supervisor/lock/lock.js owns lock semantics entirely; this file only calls it.
  const lockResult = await acquireLock(undefined /* use lock.js's own default LOCK_PATH */);
  if (!lockResult.acquired) {
    log(`lock held by pid=${lockResult.holderPid} (${lockResult.reason}) — refusing to start a second daemon`);
    process.exit(1);
  }
  log(`acquired lock at ${lockResult.path}`);

  const { promises: fs } = await import("node:fs");
  await fs.mkdir(stateDir, { recursive: true });

  const db = openDb({ stateDir });
  const supervisor = createSupervisor({
    db,
    adapters: {
      // Keys are `harnesses.id` values, which is what `runs.harness_id` records and what
      // `harnessOf` returns — so routing survives a restart with no in-memory state.
      "claude-code": claudeCodeAdapter,
      opencode: opencodeAdapter,
    },
    logger: console,
  });

  const booted = await supervisor.boot();
  const { rehydrated, reconciliation, asksAutoClosed } = booted;
  log(`rehydrated routing for ${rehydrated.length} open run(s)`);
  if (reconciliation) {
    // `stillOrphaned` counts as orphaned in this summary on purpose. Since migration 0003 an
    // orphan's row stays OPEN, so a daemon that inherits one from a previous crash sees a
    // *repeat* sighting rather than a new one — reporting only `orphaned` here would print
    // "0 orphaned-unmanaged" while a live unmanaged process was sitting right there, which is
    // the same invisibility bug 0003 exists to fix, one layer up.
    const orphaned = [...reconciliation.orphaned, ...(reconciliation.stillOrphaned ?? [])];
    log(
      `reconciliation examined ${reconciliation.examined}: ` +
        `${reconciliation.lost.length} lost, ${orphaned.length} orphaned-unmanaged ` +
        `(${reconciliation.orphaned.length} new, ${(reconciliation.stillOrphaned ?? []).length} still), ` +
        `${reconciliation.alive.length} still managed`,
    );
    // An orphan is actionable (`reap`), so name them rather than burying them in a count.
    for (const runId of reconciliation.orphaned) log(`  orphaned-unmanaged: ${runId} — reap it or adopt it`);
    for (const runId of reconciliation.stillOrphaned ?? []) {
      log(`  orphaned-unmanaged: ${runId} — still alive and unmanaged since an earlier boot; reap it or adopt it`);
    }
  }
  if (asksAutoClosed) log(`auto-closed ${asksAutoClosed} ask(s) whose grace period had expired`);

  // THE AUTHORIZED MAP, not the raw one. `commandHandlers()` is the in-process surface — anything holding the
  // supervisor object is already inside this process and has full authority by construction. The socket is the
  // trust boundary (PLAN.md §16), so the daemon is the caller that must enforce, and `boot()` has just made
  // sure an owner principal exists for a client to authenticate as.
  const server = createIpcServer({ commands: supervisor.authorizedCommandHandlers(), logger: console });
  await fs.rm(sockPath, { force: true });
  await server.listen(sockPath);
  log(`listening on ${sockPath} — every command requires a principal token (PLAN.md section 16)`);
  if (booted?.owner?.tokenFile) {
    log(`owner principal ${booted.owner.id}${booted.owner.minted ? " (minted now)" : ""}; token: ${booted.owner.tokenFile}`);
  }

  let shuttingDown = false;
  async function onSignal(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, tearing down (bounded at every step)`);
    // Sockets first: stop accepting commands before disposing what they act on.
    const socketTeardown = await server.shutdown({ timeoutMs: 3000, reason: signal });
    const supTeardown = await supervisor.shutdown({ timeoutMs: 5000 });
    closeDb(db);
    log(
      `teardown complete (sockets timedOut=${socketTeardown.timedOut}, ` +
        `supervisor timedOut=${supTeardown.timedOut}, adapters=${JSON.stringify(supTeardown.adapters)})`,
    );
    await lockResult.release();
    process.exit(0);
  }
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error("supervisor fatal error during startup:", err);
    process.exit(1);
  });
}
