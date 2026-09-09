#!/usr/bin/env node
// claude-session-hook.mjs — the hook that adopts a session a PERSON started (ROADMAP Phase 3).
//
// WHAT IT IS
//
// A Claude Code hook command. It reads the hook payload on stdin, tells the supervisor over the
// control socket that this session exists, and exits. It is a CLIENT — it never touches SQLite
// (PLAN.md section 4: "nothing else talks to SQLite directly"), which is the whole reason the
// original hook design's write-conflict class does not exist here.
//
// THE FIRST RULE OF THIS FILE: IT MUST NEVER BREAK THE USER'S SESSION.
//
// This runs inside somebody's interactive `claude`. If the supervisor is not running, or the socket
// is stale, or the payload is a shape we have not seen, the correct behaviour is to do nothing and
// get out of the way. So **every path exits 0**, nothing is written to stdout (a Claude Code hook's
// stdout can be injected into the session's context), and diagnostics go to stderr only. A hook that
// fails loudly here would make installing the dashboard a reason for someone's terminal to misbehave,
// which is a far worse outcome than a session going un-adopted.
//
// INSTALL (in the settings file for sessions you want adopted — NOT in a dashboard-spawned worker's,
// which is already owned and needs no hook):
//
//   "hooks": {
//     "SessionStart": [{ "matcher": "startup", "hooks": [{ "type": "command",
//        "command": "node /abs/path/to/supervisor/hooks/claude-session-hook.mjs adopt" }] }],
//     "SessionEnd":   [{ "hooks": [{ "type": "command",
//        "command": "node /abs/path/to/supervisor/hooks/claude-session-hook.mjs release" }] }]
//   }
//
// Requires CTD_ADOPT_WORKER_ID — which worker an ad-hoc session belongs to. Deliberately NOT
// defaulted: guessing would attach a person's exploratory session to an arbitrary worker's history,
// and a wrong attribution is worse than no adoption.
//
// MEASURED PAYLOAD (claude 2.1.263). A `SessionStart` hook receives on stdin:
//   { session_id, cwd, source, transcript_path, hook_event_name }
// Notably NO pid — so the pid comes from the environment instead: the CLI sets `CLAUDE_PID`, and
// `$PPID` is the same value (the hook is a direct child of `claude`). Both were verified; CLAUDE_PID
// is preferred because it does not depend on how the shell nests.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { sockPath, stateDir } from "../paths.js";

const ACTION = process.argv[2] === "release" ? "release" : "adopt";
const TIMEOUT_MS = Number(process.env.CTD_HOOK_TIMEOUT_MS ?? 2000);

/** Exit 0, always. See the header. */
function giveUp(why) {
  if (process.env.CTD_HOOK_DEBUG) process.stderr.write(`[ctd-hook] ${why}\n`);
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    // A hook whose stdin never closes must not hang the session either. The CLI closes it, but a
    // budget is cheaper than trusting that.
    const timer = setTimeout(() => resolve(buf), TIMEOUT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(buf); });
  });
}

/**
 * One request over the control socket. Resolves null on any failure — never throws.
 *
 * Hand-rolled rather than reusing `ipc/client.js`, and the reason is not duplication-blindness: that
 * file says of itself "not a production client, just enough to drive the adversarial tests", and it
 * REJECTS on a connect error. A rejection is precisely what must not happen here — no supervisor
 * running is the common case for a person's `claude` session, not an error condition. This client's
 * whole contract is "resolve null and get out of the way", which is a different contract.
 */
function send(command) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let sock;
    try {
      sock = net.createConnection(sockPath());
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} done(null); }, TIMEOUT_MS);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify(command)}\n`));
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(buf.slice(0, nl)); } catch { /* malformed reply is a give-up */ }
      try { sock.end(); } catch {}
      done(parsed);
    });
    // No supervisor running is the COMMON case, not an error: most people's `claude` sessions have
    // nothing to do with the dashboard.
    sock.on("error", () => { clearTimeout(timer); done(null); });
    sock.on("close", () => { clearTimeout(timer); done(null); });
  });
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  giveUp(`stdin was not JSON (${raw.length} bytes)`);
}

const sessionId = payload?.session_id;
if (!sessionId) giveUp(`no session_id in the hook payload (keys: ${Object.keys(payload ?? {}).join(",")})`);

const workerId = process.env.CTD_ADOPT_WORKER_ID;
if (!workerId && ACTION === "adopt") {
  giveUp("CTD_ADOPT_WORKER_ID is not set, so there is no worker to attribute this session to");
}

// `CLAUDE_PID` first, `PPID` as the fallback. Both measured to be the `claude` process itself.
const pidRaw = process.env.CLAUDE_PID ?? process.env.PPID;
const pid = Number.parseInt(pidRaw ?? "", 10);

/**
 * The principal token this hook presents (PLAN.md §16, added in Phase 7).
 *
 * WHY IT NEEDS ONE AT ALL, and why this was found by review rather than by a test: the real daemon serves the
 * AUTHORIZED command map, so `adoptSession` and `releaseSession` require the `session:adopt` capability. This
 * hook sent no credential, and — because it exits 0 on every path by design — adoption failed **silently** in
 * production while the adoption tests passed, since those build a server from the raw command map and never
 * cross the gate. Named by the Phase 7 review (sol).
 *
 * `CTD_PRINCIPAL_TOKEN` first: a session the supervisor spawned already has one. Otherwise the owner's token
 * from the state dir — which is honest for this hook specifically, because a hook fires inside a `claude`
 * session the OWNER started in the owner's own terminal, as the same OS user that owns the 0700 state dir. It
 * is not a privilege escalation; it is the owner acting.
 */
function principalToken() {
  if (process.env.CTD_PRINCIPAL_TOKEN) return process.env.CTD_PRINCIPAL_TOKEN;
  try {
    return fs.readFileSync(path.join(stateDir(), "owner.token"), "utf8").trim() || null;
  } catch {
    // No token, no daemon, or no permission — all the same to this hook: it will be refused, it will say so on
    // stderr, and it will still exit 0. A hook that can break a human's session is worse than an unadopted one.
    return null;
  }
}

const token = principalToken();

const command = ACTION === "adopt"
  ? {
      id: `hook-adopt-${sessionId}`,
      cmd: "adoptSession",
      harnessId: "claude-code",
      ...(token ? { token } : {}),
      sessionId,
      workerId,
      cwd: payload.cwd ?? process.cwd(),
      transcriptPath: payload.transcript_path ?? null,
      ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    }
  : {
      id: `hook-release-${sessionId}`,
      cmd: "releaseSession",
      harnessId: "claude-code",
      ...(token ? { token } : {}),
      sessionId,
      reason: "session-ended",
    };

const reply = await send(command);
if (!reply) giveUp("no reply from the supervisor (it is probably not running, which is fine)");
if (reply.ok === false) giveUp(`supervisor refused: ${reply.error ?? "no reason given"}`);
if (process.env.CTD_HOOK_DEBUG) process.stderr.write(`[ctd-hook] ${ACTION}: ${JSON.stringify(reply)}\n`);
process.exit(0);
