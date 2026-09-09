// paths.js — where the supervisor's control socket lives.
//
// Delegates to `supervisor/paths.js`, the single state-directory resolver (see its header:
// this module and `lock/lock.js` used to disagree about where "state" lives, and a test had to
// set two env vars to stay out of the developer's real home directory).
//
// PLAN.md section 4: "The database is persistence. The socket is messaging." Two files, one
// directory.

export { stateDir as defaultStateDir, sockPath as defaultSockPath, lockPath as defaultLockPath } from "../paths.js";
