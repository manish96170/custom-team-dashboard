// paths.js — shared fixed paths, importable by both client and supervisor without triggering
// supervisor.js's module-level startup logic (that was a real bug caught in testing — see
// FINDINGS.md point 2).

import path from "node:path";
import os from "node:os";

export const STATE_DIR =
  process.env.CTD_STATE_DIR ||
  path.join(os.homedir(), ".local", "state", "custom-team-dashboard");
export const SOCK_PATH = path.join(STATE_DIR, "supervisor.sock");
