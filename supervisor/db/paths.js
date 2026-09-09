// paths.js — where the supervisor's SQLite file and its containing directory live.
//
// Delegates to `supervisor/paths.js`, which is the single state-directory resolver for the
// whole project (see its header for why there used to be two, and what that cost). This module
// stays because `db/` callers import it, not because it decides anything.

export { stateDir as defaultStateDir, dbPath as defaultDbPath } from "../paths.js";
