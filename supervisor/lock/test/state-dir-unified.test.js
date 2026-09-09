// state-dir-unified.test.js — the state directory is ONE directory.
//
// It was two. `db/paths.js` and `ipc/paths.js` read `SUPERVISOR_STATE_DIR` and put the database
// and socket under `~/.custom-team-dashboard/supervisor/`; `lock/lock.js` read `CTD_STATE_DIR`
// and put the lock under `~/.local/state/custom-team-dashboard/`. Both worked. The tell that it
// was a trap and not a preference: `runtime/test/daemon-crash.test.js` had to set BOTH env vars
// to keep a test out of the developer's real home directory — set one and the lock silently
// escapes into `$HOME`, which is also how a deployment ends up with its lock somewhere nobody
// is looking.
//
// Cases:
//   1. one env var puts the database, socket and lock in the same directory
//   2. `CTD_STATE_DIR` still works as a legacy alias — existing setups do not break
//   3. `SUPERVISOR_STATE_DIR` wins when both are set, rather than the two disagreeing again
//   4. a daemon still holding the OLD lock path is honoured: the move must not permit two live
//      supervisors, each holding a lock the other cannot see
//   5. ...and a STALE legacy lock (dead pid) is correctly ignored, so the guard cannot wedge
//      startup forever after a crash
//
// Standing rule: every case asserts. This script cannot exit 0 with a broken claim.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateDir, dbPath, sockPath, lockPath, legacyLockPath } from "../../paths.js";
import { acquireLock } from "../lock.js";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-statedir-"));

// Same contract as every other test in this directory (see ./assert.js): a broken claim throws,
// the catch below exits non-zero. Never print-and-exit-0.
async function main() {
  const dirs = [];
  try {
    // ---- 1. one env var, one directory ------------------------------------------------
    {
      const dir = "/tmp/ctd-state-dir-check";
      const env = { SUPERVISOR_STATE_DIR: dir };
      const resolved = stateDir(env);
      assert.equal(resolved, dir);
      const paths = { db: dbPath(resolved), sock: sockPath(resolved), lock: lockPath(resolved) };
      for (const [what, p] of Object.entries(paths)) {
        assert.equal(path.dirname(p), dir, `${what} must live in the one state directory, got ${p}`);
      }
      assert.equal(new Set(Object.values(paths)).size, 3, "the three files must be distinct within it");
      console.log(`  1. db, socket and lock all resolve under ${dir}`);
    }

    // ---- 2. the legacy alias still works ----------------------------------------------
    {
      const dir = "/tmp/ctd-legacy-alias-check";
      assert.equal(stateDir({ CTD_STATE_DIR: dir }), dir, "CTD_STATE_DIR must keep working — existing setups use it");
      console.log("  2. CTD_STATE_DIR still resolves, as a legacy alias");
    }

    // ---- 3. no ambiguity when both are set --------------------------------------------
    {
      const chosen = stateDir({ SUPERVISOR_STATE_DIR: "/tmp/ctd-wins", CTD_STATE_DIR: "/tmp/ctd-loses" });
      assert.equal(chosen, "/tmp/ctd-wins", "SUPERVISOR_STATE_DIR must win rather than the two disagreeing again");
      console.log("  3. SUPERVISOR_STATE_DIR wins when both are set");
    }

    // ---- 4. a live daemon at the OLD lock path is still honoured -----------------------
    {
      const dir = scratch();
      dirs.push(dir);
      const legacyDir = scratch();
      dirs.push(legacyDir);
      const legacy = path.join(legacyDir, "supervisor.lock");
      // A live holder: this very process. If the guard were missing, acquiring the new-path lock
      // would succeed and there would be two supervisors, each blind to the other's lock.
      fs.writeFileSync(legacy, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: os.hostname() }));

      const result = await acquireLock(path.join(dir, "supervisor.lock"), { legacyPath: legacy });
      assert.equal(result.acquired, false, "a live daemon at the legacy lock path must block the new one");
      assert.equal(result.holderPid, process.pid);
      assert.match(result.reason, /legacy/, `the refusal must say why: ${result.reason}`);
      assert.equal(fs.existsSync(path.join(dir, "supervisor.lock")), false, "and it must not have published its own lock");
      console.log(`  4. a LIVE holder of the old lock path blocked acquisition (pid ${process.pid})`);
    }

    // ---- 5. a stale legacy lock is ignored ---------------------------------------------
    {
      const dir = scratch();
      dirs.push(dir);
      const legacyDir = scratch();
      dirs.push(legacyDir);
      const legacy = path.join(legacyDir, "supervisor.lock");
      // A pid that cannot be alive: pid 0 is never a real process here, and the guard must not
      // treat "there is a file" as "someone is running" — otherwise one crashed pre-move daemon
      // wedges every future start.
      fs.writeFileSync(legacy, JSON.stringify({ pid: 2147483646, startedAt: "2020-01-01T00:00:00.000Z", hostname: "gone" }));

      const result = await acquireLock(path.join(dir, "supervisor.lock"), { legacyPath: legacy });
      assert.equal(result.acquired, true, `a stale legacy lock must not block startup: ${JSON.stringify(result)}`);
      assert.ok(fs.existsSync(path.join(dir, "supervisor.lock")), "the new lock must be published");
      await result.release();
      console.log("  5. a stale (dead-pid) legacy lock was ignored, and the new lock was taken");
    }

    // The real legacy path is still computable, for the transitional guard's own default.
    assert.match(legacyLockPath({}), /\.local[/\\]state[/\\]custom-team-dashboard/, "the legacy default must stay recognisable");
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log("state-dir-unified.test.js: ALL PASS");
  process.exit(0);
} catch (err) {
  console.error("state-dir-unified.test.js: FAIL");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
