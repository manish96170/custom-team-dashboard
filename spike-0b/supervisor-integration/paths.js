// paths.js — shared fixed paths for the real supervisor integration spike.
//
// Deliberately a SEPARATE state dir from packaging-probe's
// (~/.local/state/custom-team-dashboard) so this spike's crash-recovery
// testing (which involves kill -9'ing a supervisor process repeatedly) can
// never collide with, or clobber, the packaging-probe's own proven lock/
// socket evidence.

import path from "node:path";
import os from "node:os";

export const STATE_DIR =
  process.env.CTD_STATE_DIR ||
  path.join(os.homedir(), ".local", "state", "custom-team-dashboard-supervisor-integration");

export const SOCK_PATH = path.join(STATE_DIR, "supervisor.sock");
export const RUNS_STATE_PATH = path.join(STATE_DIR, "runs-state.json");
export const LOG_PATH = path.join(STATE_DIR, "supervisor.log");
