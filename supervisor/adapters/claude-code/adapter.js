// adapter.js
//
// Claude Code spawn adapter — Phase 1 (promoted from spike-0b, with the
// defects found by consolidated-review-claudeopus5-medium--spike-0b.md
// fixed: B4 (normalized turn.end), S7 (resume/stop timer race), M14
// (preflight binary check), M7 (clean clearContext/resume surface).
//
// The spike's original file (spike-0b/claude-code-adapter/adapter.js) is
// left untouched — this is a copy with real fixes, not a from-scratch
// rewrite. See ../FINDINGS.md for what changed and what was proven.
//
// Implements the interface:
//   preflight() -> Promise<{ ok: boolean, reason?: string }>
//   start(spec) -> runId
//   sendInput(runId, input) -> void
//   observe(runId) -> AsyncIterable<Event>
//   interrupt(runId) -> void
//   clearContext(runId) -> ack
//   resume(runId) -> runId | 'unsupported'
//   stop(runId) -> void
//
// Backed by real `claude` CLI invocations. See spike-0b/claude-code-adapter/
// FINDINGS.md for the evidence behind every design decision here — this
// file only implements what was actually proven to work against `claude`
// 2.1.260.
//
// KEY DESIGN DECISION (see spike-0b FINDINGS.md #3/#4/#5):
// We run the CLI in RESIDENT mode:
//   claude -p --input-format stream-json --output-format stream-json
//          --include-partial-messages --verbose ...
// This keeps one OS process alive for the life of the run. Multi-turn
// input is sent as additional `{"type":"user",...}` JSON lines on stdin
// (no --resume, no new process needed). Interrupt is sent as a
// `{"type":"control_request","request":{"subtype":"interrupt"}}` line on
// stdin, NOT as SIGINT — SIGINT was proven to kill the whole resident
// process (see FINDINGS.md #4), whereas the control_request interrupts
// only the in-flight turn and leaves the process (and stdin) usable for
// the next turn.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawnManaged, killProcessGroup } from '../../runtime/spawn.js';
import { signalProcessGroup } from '../../runtime/procinfo.js';
import { settingSourcesArgv, describeEnv } from './worker-env.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/** @typedef {{prompt: string, cwd: string, model?: string, effort?: string, permissionMode?: string, approvalMode?: 'host'|'off', envProfile?: 'project'|'none'|'inherit', settingSources?: string[], mcpConfig?: string|string[], ephemeral?: boolean}} StartSpec */

class Run extends EventEmitter {
  constructor(runId, spec) {
    super();
    this.runId = runId;
    this.spec = spec;
    this.claudeSessionId = null; // the CLI's own session_id (changes on /clear)
    this.status = 'starting'; // starting | running | idle | interrupted | errored | stopped | completed
    this.exitCode = null;
    this.exitSignal = null;
    this.terminalReason = null;
    this._buf = '';
    this._pendingControlRequests = new Map(); // request_id -> {resolve, reject} (OUR requests)
    // Approval/question requests the CLI has parked on US, awaiting a control_response:
    // request_id -> { requestId, toolName, toolUseId, input, requiresUserInteraction,
    //                 suggestions, receivedAt, generation }
    // Phase 2, measured: `can_use_tool` parks the worker's turn for as long as we take, so
    // an entry here is a worker that is genuinely stopped until somebody answers.
    this._parkedRequests = new Map();
    this._eventLog = []; // buffered events for observe() replay to late subscribers
    // generation counter (finding S7): bumped every time run.child is
    // rebound (resume()). Lets a stale stop() SIGKILL timer recognize that
    // the child it was scheduled against is no longer the current one.
    this._generation = 0;
  }

  _emitEvent(evt) {
    this._eventLog.push(evt);
    this.emit('event', evt);
  }
}

const runs = new Map();

/**
 * preflight() -> Promise<{ ok: boolean, reason?: string }>
 *
 * Finding M14: neither adapter checked the harness binary existed before
 * spawning it, so a missing binary produced a confusing runtime error
 * (a runId that instantly dies, or worse). This does a fast `claude
 * --version` call (bounded by a short timeout) and reports pass/fail
 * clearly, without spawning a real session.
 */
export function preflight() {
  return new Promise((resolve) => {
    const child = execFile(CLAUDE_BIN, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({
          ok: false,
          reason: err.code === 'ENOENT'
            ? `claude binary not found on PATH (looked for "${CLAUDE_BIN}"); set CLAUDE_BIN or install the CLI`
            : `claude --version failed: ${err.message}`,
        });
        return;
      }
      resolve({ ok: true, version: stdout.trim() });
    });
    child.on('error', (err) => {
      // execFile's callback already handles spawn errors in modern Node, but
      // guard belt-and-suspenders against an unhandled 'error' event (same
      // class of bug as findings B7/B8/S6 elsewhere in this codebase).
      resolve({ ok: false, reason: `claude binary spawn error: ${err.message}` });
    });
  });
}

/**
 * capabilities() -> the declared capability matrix (PLAN.md section 9, conformance/matrix.js).
 *
 * MEASURED, not aspirational. Every value here corresponds to something proven in ../FINDINGS.md or
 * probe/evidence/, and the fields that could diverge from the other harness carry their semantics
 * rather than a boolean — because they DO diverge, and a shared `true` would hide it.
 */
export function capabilities() {
  return {
    // One `claude` process per run, resident for the run's lifetime; multi-turn input goes over its
    // stdin (FINDINGS.md #1/#2). This is what lets a per-run environment declaration mean anything.
    residentProcess: 'per-run',
    // `--resume <session-id>`. Note `spec.ephemeral` (--no-session-persistence) turns this OFF for a
    // given run by design: a preflight has nothing worth resuming.
    resumableTurns: true,
    structuredOutput: 'stream-json',
    // A `control_request` interrupt ends the TURN and leaves the process and its stdin usable.
    // SIGINT was proven to kill the whole resident process instead (FINDINGS.md #4), which is why
    // this is 'turn' and not 'process'.
    interrupt: 'turn',
    // `/clear` issues a new internal session_id: the conversation is GONE. Contrast opencode, whose
    // clearContext summarizes and retains — same method name, opposite semantics, which is the
    // reason this field is a string (conformance/matrix.js).
    clearContext: 'erase',
    // `--permission-prompt-tool stdio`: the CLI asks us, parks the turn indefinitely, and acts on
    // our answer. Measured, including a 65s park honoured (probe/evidence/01-parked-allow.txt).
    approvalProtocol: 'host',
    // The CLI can list models, but this adapter exposes no way to ask it, so the supervisor cannot
    // discover them. Declaring `true` for a capability the supervisor cannot reach would be exactly
    // the unverifiable claim section 9 exists to prevent.
    modelDiscovery: false,
  };
}

/**
 * start(spec) -> runId
 *
 * Launches a resident, non-interactive `claude` process in stream-json/
 * stream-json mode. Proven: spike-0b FINDINGS.md #1, #2, #6, #7.
 */
export function start(spec) {
  const { prompt, cwd, model, effort, permissionMode, permissionPromptTool } = spec;
  if (!cwd) throw new Error('start(spec): spec.cwd is required (proven: cwd isolation via child_process cwd option, not a CLI flag — FINDINGS.md #6)');

  // Built BEFORE the run is registered, because `_buildArgs` can now legitimately throw:
  // it validates the environment declaration (worker-env.js) and refuses an invalid one
  // rather than defaulting. Registering first would leave a `runs` entry with no child and
  // no process for a call that threw -- the adapter-state twin of the `start()` defect
  // review-0003 found, where a spawn preceded its row and left a live child with no row.
  const args = _buildArgs(spec);

  const runId = randomUUID();
  const run = new Run(runId, spec);
  runs.set(runId, run);

  // child_process cwd option is what actually achieves working-directory
  // isolation; there is no --cwd flag on the CLI (FINDINGS.md #6).
  //
  // Group 5: spawned through runtime/spawn.js, not bare spawn(). That gives this
  // child its OWN process group (detached, pgid === pid, read back from the OS and
  // verified) plus DASHBOARD_SPAWN_DEPTH. Before this, the child inherited the
  // supervisor's process group, so the pgid recorded on the run row was the
  // supervisor's -- and "kill this run's group" meant "kill the supervisor".
  run.cwd = cwd;

  // The environment this worker actually got, written down at the moment it got it.
  // Emitted BEFORE the spawn so it is the first thing in the run's transcript even if the
  // spawn fails -- a worker that died on startup is exactly when you want to know what
  // config it was handed. The pane shows unknown event types rather than dropping them,
  // so this needs no rendering change to be visible.
  run._emitEvent({ type: 'worker.env', runId, ...describeEnv(spec) });

  // `spawnManaged` can throw SYNCHRONOUSLY: `childSpawnEnv` refuses to spawn past the
  // spawn-depth ceiling, before `spawn()` is ever called. Without this cleanup that throw
  // leaves a `runs` entry with no child and no process, unreachable and never disposed,
  // for a `start()` whose caller only ever saw an exception and never learned the runId.
  // Same defect class as validating after registration, arriving by a different road.
  //
  // A FAILED SPAWN IS NOT THE SAME THING and is deliberately not caught here: ENOENT on
  // the command and EACCES on the cwd arrive ASYNCHRONOUSLY as an 'error' event, which
  // `_adoptChild` already installs a listener for (finding S6/S7 — a missing listener took
  // the whole daemon down). Those runs are real, registered, and reported through the
  // event stream.
  try {
    // `spec.env` is PASSED THROUGH. It was not, and that made a whole supervisor-side mechanism dead code:
    // Phase 7 delivers a worker's principal token in its environment (PLAN.md §16), and with no `env` here it
    // would have reached the fake harness in tests and nothing in production — the "built, documented, never
    // consulted" failure §37.10 names, on the very first use of the channel. `spawnManaged` merges it over the
    // inherited environment and applies the spawn-depth guard, so this is delivery, not policy.
    _adoptChild(run, spawnManaged({ command: CLAUDE_BIN, args, cwd, ...(spec.env ? { env: spec.env } : {}) }));
  } catch (err) {
    runs.delete(runId);
    throw err;
  }

  // Before the first user message, so we are the host from the session's first turn.
  if ((spec.approvalMode ?? 'host') !== 'off') _sendInitialize(run);
  _sendUserMessage(run, prompt);
  return runId;
}

function _buildArgs(spec) {
  const { model, effort, permissionMode } = spec;
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  // permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
  // --permission-mode is a blanket policy set at process start, not a per-call decision
  // (FINDINGS.md #9). Per-call decisions come from the host channel below.
  args.push('--permission-mode', permissionMode || 'default');

  // ── the approval channel (Phase 2) ────────────────────────────────────────────────
  // CORRECTION to this file's own older note, and to PLAN.md sections 4/7: per-call
  // approval does NOT require a PreToolUse hook. `--permission-prompt-tool stdio` makes the
  // CLI send us a `can_use_tool` control_request and PARK the turn until we answer on stdin
  // (measured; probe/ and ../FINDINGS.md). `approvalMode: 'off'` opts out.
  //
  // The flag is load-bearing and its absence is SILENT: without it the CLI auto-denies and
  // tells the model "you haven't granted it yet", so a run looks like it is being refused by
  // a human who is not there. Do not drop it to "simplify" the argv.
  if ((spec.approvalMode ?? 'host') !== 'off') args.push('--permission-prompt-tool', 'stdio');

  // ── the worker's environment (Phase 2, item 2) ────────────────────────────────────
  // A worker DECLARES what it loads and inherits nothing by accident. Without this the
  // CLI reads the developer's own global config: measured at 6 MCP servers, 110 tools,
  // 97 slash commands and 2 SessionStart hooks in an EMPTY directory. See worker-env.js
  // for the decision and probe/worker-env-probe.mjs for the measurement. This throws on
  // an invalid declaration rather than defaulting, so it must stay ahead of the spawn.
  args.push(...settingSourcesArgv(spec));

  // ── an ephemeral session leaves no harness-side history (PLAN.md 12.1) ──────────────
  // `--no-session-persistence` means the CLI never writes the session to disk at all, so a
  // preflight has nothing to clean up on the harness side. NOT WRITING IT IS STRICTLY BETTER
  // THAN DELETING IT: a delete can fail, and a SIGKILL between the check and its cleanup
  // pre-empts the delete entirely — which is precisely the case a preflight has to survive,
  // since it is designed to be run liberally.
  //
  // The flag requires `--print`, which this argv always passes (`-p` above). Measured on
  // claude 2.1.263; observed in the argv of the CLI's own disposable sub-sessions.
  //
  // The cost is real and is the reason this is opt-in rather than the default: the session
  // cannot be RESUMED, so `resume()` on an ephemeral run has nothing to resume from. That is
  // correct for a preflight (there is nothing worth resuming) and wrong for a worker.
  if (spec.ephemeral) args.push('--no-session-persistence');
  return args;
}

/**
 * Write one control_request/control_response line to the child's stdin, and RESOLVE ONLY ONCE
 * THE WRITE HAS BEEN ACCEPTED without error.
 *
 * Found by both reviewers: `Writable.write()` is asynchronous, so the original version reported
 * success as soon as bytes were queued. A stdin that broke immediately afterwards surfaced later
 * as an `EPIPE` on the generic error listener, by which time the supervisor had already stamped
 * `delivered_at` — a parked worker that never received its answer, recorded as answered and
 * delivered. The liveness check above the write cannot close that window; only the callback can.
 */
function _writeControl(run, obj) {
  return new Promise((resolve, reject) => {
    if (!run.child?.stdin || run.child.stdin.destroyed || run.exitCode !== null) {
      reject(new Error(`run ${run.runId} has no live stdin to write a control message to (exitCode=${run.exitCode})`));
      return;
    }
    run.child.stdin.write(JSON.stringify(obj) + '\n', (err) => {
      if (err) reject(new Error(`stdin write failed for run ${run.runId}: ${err.message}`));
      else resolve();
    });
  });
}

/**
 * Announce ourselves as the SDK host for this process.
 *
 * Optional per the protocol ("initialize is optional and normally the first line; the first
 * user message initializes with defaults") and we send it for one concrete reason: its
 * response carries `pending_permission_requests`, so a host re-attaching to an
 * already-initialized process can re-arm requests parked before it arrived. That covers a
 * reader reconnecting — it does NOT survive a supervisor restart, because a restarted
 * supervisor no longer holds this child's stdio at all (../FINDINGS.md).
 *
 * Deliberately NOT declaring `supportedDialogKinds`: the only dialog kind that exists is
 * `refusal_fallback_prompt`, the CLI fails closed on an undeclared kind by degrading to its
 * classic no-dialog behavior, and that is the behavior we already have. AskUserQuestion does
 * not use that channel — it arrives as `can_use_tool` with `requires_user_interaction`.
 */
function _sendInitialize(run) {
  const requestId = `init-${randomUUID()}`;
  // Fire and forget, but never unhandled: a child that died before we could greet it is not a
  // reason to take the supervisor down (findings B7/B8), and the 'exit' listener reports the
  // death through the normal path.
  _writeControl(run, { type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } }).catch((err) => {
    run._emitEvent({ type: 'stdin.error', runId: run.runId, error: String(err) });
  });
}

/**
 * Take ownership of a freshly spawned managed child: bind its listeners and record the
 * OS-verified identity on the run.
 *
 * `identity` is a promise because verification is a real `ps` call, not an assumption --
 * `run.verifiedPgid` is therefore populated a beat after start() returns, and every
 * consumer of it (stop()'s escalation, the supervisor's recordRunProcess) must treat
 * "not verified yet / never verified" as a real state rather than assuming a pgid.
 */
function _adoptChild(run, { child, identity, spawnDepth }) {
  run.identity = identity;
  run.spawnDepth = Number(spawnDepth);
  run.verifiedPgid = null;
  run.verifiedLstart = null;
  identity
    .then((info) => {
      if (info.verified) {
        run.verifiedPgid = info.pgid;
        run.verifiedLstart = info.lstart;
      }
    })
    .catch(() => {
      // spawnManaged already killed a child it could not own; nothing to record and
      // nothing to escalate to. The rejection is surfaced to the supervisor through
      // `run.identity`, which it awaits -- swallowing it here only prevents an
      // unhandled rejection from taking the process down (findings B7/B8).
    });
  _bindChild(run, child);
}

// Binds all child-process listeners for a (re)spawned child onto `run`.
// Shared by start() and resume() so the two paths cannot silently diverge
// (finding S7's second half: resume() was missing the child.on('error')
// handler that start() had).
function _bindChild(run, child) {
  const runId = run.runId;
  run.child = child;
  run.status = 'running';
  // Reset terminal-state fields from any previous generation (resume()
  // rebinds onto a fresh process; without this, a stale exitCode/exitSignal
  // from the process being replaced would linger and misreport the new
  // process's state until its own 'exit' fires).
  run.exitCode = null;
  run.exitSignal = null;
  // Requests parked by the process being replaced are unanswerable through the new one's
  // stdin — the ids mean nothing to it. Dropping them here is what makes answerApproval's
  // generation check reachable rather than theoretical, and it stops a resumed run from
  // appearing to still owe answers to a process that no longer exists.
  if (run._parkedRequests.size > 0) {
    for (const parked of run._parkedRequests.values()) {
      run._emitEvent({
        type: 'approval.withdrawn',
        runId,
        requestId: parked.requestId,
        toolName: parked.toolName,
        toolUseId: parked.toolUseId,
        reason: 'process-replaced',
      });
    }
    run._parkedRequests.clear();
  }
  run._generation += 1;
  const generation = run._generation;

  child.stdout.on('data', (d) => _onStdout(run, d));
  child.stderr.on('data', (d) => {
    run._emitEvent({ type: 'stderr', runId, data: d.toString() });
  });
  child.on('exit', (code, signal) => {
    // Ignore exit events from a child that is no longer the current one —
    // can happen if a stale process from a superseded generation finally
    // exits after resume() has already rebound run.child (finding S7).
    if (run._generation !== generation) return;
    run.exitCode = code;
    run.exitSignal = signal;
    run.status = run.status === 'interrupted' ? 'interrupted' : (code === 0 ? 'completed' : 'errored');
    run._emitEvent({ type: 'process.exit', runId, code, signal });
  });
  child.on('error', (err) => {
    if (run._generation !== generation) return;
    run.status = 'errored';
    run._emitEvent({ type: 'process.error', runId, error: String(err) });
  });
  // Finding B8 (from the consolidated review, adjacent to this batch of
  // fixes): stdin writes with no error listener crash the host process on
  // EPIPE. Attach one here so _sendUserMessage/interrupt/clearContext never
  // take down the supervisor.
  child.stdin.on('error', (err) => {
    if (run._generation !== generation) return;
    run._emitEvent({ type: 'stdin.error', runId, error: String(err) });
  });
}

/**
 * sendInput(runId, input) -> void
 *
 * Sends a follow-up user turn into the SAME resident process/session.
 * Proven: FINDINGS.md #3 — no --resume needed, no new process needed,
 * because the process is kept alive with --input-format stream-json.
 */
export function sendInput(runId, input) {
  const run = _get(runId);
  _sendUserMessage(run, input);
}

function _sendUserMessage(run, text) {
  const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
  if (!run.child?.stdin || run.child.stdin.destroyed || run.exitCode !== null) {
    throw new Error(`sendInput: run ${run.runId} has no live stdin (exitCode=${run.exitCode})`);
  }
  run.child.stdin.write(JSON.stringify(msg) + '\n');
  run.status = 'running';
}

/**
 * observe(runId) -> AsyncIterable<Event>
 *
 * Event shapes emitted: assistant.delta, tool.start, tool.result,
 * approval.request (best-effort, see note below), turn.end.
 * Mapping proven against real stream-json output — FINDINGS.md #2.
 *
 * NOTE on approval.request: no control_request for permission decisions
 * was ever observed from the CLI in --print mode (FINDINGS.md #9) — the
 * CLI decides allow/deny itself using --permission-mode + hooks, and only
 * reports the outcome (`permission_denied` system event / `permission_
 * denials` in the result). So `approval.request` here is emitted
 * best-effort, AFTER THE FACT, as an observability signal — it is NOT a
 * live callback you can answer to change the outcome. If you need to
 * actually control the decision, you must configure a PreToolUse hook in
 * `.claude/settings.json` in the target cwd BEFORE calling start() — see
 * approvalHookExample.js. That hook is the only proven programmatic
 * approval mechanism.
 */
export async function* observe(runId) {
  const run = _get(runId);
  // NOTE: this adapter targets a single logical consumer per run (the
  // pattern the interface's own spec/usage implies: one orchestrator
  // driving one run). We keep ONE shared read cursor on the Run object
  // rather than a fresh per-call cursor, so that repeated calls to
  // observe() (e.g. "drain until this turn ends", called once per turn)
  // continue where the previous call left off instead of re-replaying the
  // whole history. A multi-consumer fan-out design is future work (see
  // consolidated review B3/S3 — out of scope for this pass).
  if (run._readCursor === undefined) run._readCursor = 0;
  let wake = () => {};
  const onEvent = () => wake();
  run.on('event', onEvent);

  try {
    while (true) {
      while (run._readCursor < run._eventLog.length) {
        yield run._eventLog[run._readCursor++];
      }
      if (run.status === 'completed' || run.status === 'errored' || run.status === 'stopped') {
        if (run._readCursor >= run._eventLog.length) return;
      }
      let timer;
      await new Promise((res) => {
        wake = res;
        timer = setTimeout(res, 200); // safety-net poll in case an event slips past the listener
      });
      clearTimeout(timer);
    }
  } finally {
    run.off('event', onEvent);
  }
}

function _onStdout(run, chunk) {
  run._buf += chunk.toString();
  const lines = run._buf.split('\n');
  run._buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    _handleLine(run, obj);
  }
}

function _handleLine(run, obj) {
  const runId = run.runId;

  if (obj.type === 'control_response') {
    const pending = run._pendingControlRequests.get(obj.response?.request_id);
    if (pending) {
      run._pendingControlRequests.delete(obj.response.request_id);
      if (obj.response.subtype === 'success') pending.resolve(obj.response.response);
      else pending.reject(new Error(obj.response.error || 'control_request failed'));
    }
    return;
  }

  // ── the CLI asking US something (Phase 2) ─────────────────────────────────────────
  if (obj.type === 'control_request') {
    _handleInboundControlRequest(run, obj);
    return;
  }

  // The CLI withdrawing a request it parked on us — "a pending can_use_tool prompt after
  // the turn was interrupted, or one that another client already answered". There is no
  // reply to a cancel. Without handling this, an `ask` row would outlive the request it
  // points at, and answering it later would deliver to an id the harness has forgotten.
  if (obj.type === 'control_cancel_request') {
    const requestId = obj.request_id;
    const parked = run._parkedRequests.get(requestId);
    run._parkedRequests.delete(requestId);
    run._emitEvent({
      type: 'approval.withdrawn',
      runId,
      requestId,
      toolName: parked?.toolName ?? null,
      toolUseId: parked?.toolUseId ?? null,
      reason: 'harness-withdrew',
    });
    return;
  }

  if (obj.type === 'system' && obj.subtype === 'init') {
    run.claudeSessionId = obj.session_id;
    // What the CLI reports it ACTUALLY loaded, alongside the `worker.env` event recording
    // what we asked for. Those are two different facts and the pair is the point: the
    // declaration is our intent, this is the outcome, and only the outcome can show a flag
    // that silently stopped working. Item 2's whole origin was an inheritance nobody had
    // declared and nobody could see.
    //
    // COUNTS, not lists, for the tool/command/agent sets: 24 tool names and 41 command
    // names in every run's transcript is the context-economy problem (PLAN.md section 8)
    // one layer down. MCP servers are named because there should normally be NONE, so the
    // list is both short and the interesting part when it is not empty.
    run._emitEvent({
      type: 'session.init',
      runId,
      claudeSessionId: obj.session_id,
      mcpServers: (obj.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`),
      toolCount: obj.tools?.length ?? null,
      slashCommandCount: obj.slash_commands?.length ?? null,
      agentCount: obj.agents?.length ?? null,
      reportedModel: obj.model ?? null,
    });
    return;
  }

  // A hook the CLI ran for this session. Recorded because the environment pin has TWO
  // independent axes and only one of them was observable: `session.init` reports MCP servers,
  // so a regression that restored the developer's global hooks while leaving MCP empty would
  // have kept every environment assertion green. `--setting-sources` governs hooks;
  // `--strict-mcp-config` governs MCP; a test that only watches MCP is watching one of them.
  //
  // A separate event type rather than a count folded into `session.init`, because hooks fire
  // BEFORE init (measured: two `hook_started` pairs precede it) and can fire again later in a
  // session — a count captured at init would be wrong in both directions.
  if (obj.type === 'system' && (obj.subtype === 'hook_started' || obj.subtype === 'hook_response')) {
    run._emitEvent({
      type: 'harness.hook',
      runId,
      phase: obj.subtype === 'hook_started' ? 'started' : 'response',
      hookName: obj.hook_name ?? obj.hook_event_name ?? obj.hook ?? null,
    });
    return;
  }

  if (obj.type === 'system' && obj.subtype === 'permission_denied') {
    // After-the-fact notification that the CLI refused something ITSELF, without asking:
    // a working-directory rule, a sandbox refusal, or `--permission-prompt-tool stdio` not
    // being set. Not answerable, and deliberately a DIFFERENT event type from the live
    // `approval.request` below — a UI that showed both as "approval needed" would offer a
    // button for a decision that has already been made and cannot be changed.
    run._emitEvent({
      type: 'approval.auto-denied',
      runId,
      toolName: obj.tool_name,
      toolUseId: obj.tool_use_id ?? null,
      decisionReasonType: obj.decision_reason_type ?? null,
      reason: obj.message,
    });
    return;
  }

  if (obj.type === 'stream_event') {
    const ev = obj.event;
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      run._emitEvent({ type: 'tool.start', runId, toolName: ev.content_block.name, toolUseId: ev.content_block.id });
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      run._emitEvent({ type: 'assistant.delta', runId, text: ev.delta.text });
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
      run._emitEvent({ type: 'assistant.delta', runId, text: ev.delta.thinking, channel: 'thinking' });
    }
    return;
  }

  if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (block.type === 'tool_result') {
        run._emitEvent({
          type: 'tool.result',
          runId,
          toolUseId: block.tool_use_id,
          isError: !!block.is_error,
          content: block.content,
        });
      } else if (block.type === 'text' && block.text === '[Request interrupted by user]') {
        run.status = 'interrupted';
      }
    }
    return;
  }

  if (obj.type === 'result') {
    run.terminalReason = obj.terminal_reason;
    // Exit classification (proven: FINDINGS.md #8) — exit code alone is
    // NOT sufficient (interrupt also exits 0). Must inspect this record.
    let normalizedStatus;
    if (obj.terminal_reason === 'aborted_streaming') {
      run.status = 'interrupted';
      normalizedStatus = 'aborted';
    } else if (obj.is_error) {
      run.status = 'errored';
      normalizedStatus = 'error';
    } else {
      run.status = 'idle'; // turn completed; resident process still alive for more input
      normalizedStatus = 'completed';
    }
    run._emitEvent({
      type: 'turn.end',
      runId,
      // Finding B4: the two adapters had silently diverged on the turn.end
      // contract — Claude Code emitted `isError` with no `status`, OpenCode
      // emitted `status` with no `isError`, and the supervisor read
      // `evt.isError` against both. `status` is now the required,
      // normalized field on every turn.end from either adapter:
      // 'completed' | 'error' | 'aborted'. `isError` is kept as a derived
      // boolean for backward compatibility with any existing consumer that
      // reads it directly — but it is documented here as derived, not
      // source-of-truth.
      status: normalizedStatus,
      isError: normalizedStatus === 'error',
      result: obj.result,
      terminalReason: obj.terminal_reason,
      subtype: obj.subtype,
      apiErrorStatus: obj.api_error_status ?? null,
      costUsd: obj.total_cost_usd,
      claudeSessionId: obj.session_id,
      // ADDED for supervisor-integration spike (item 4, token telemetry —
      // PLAN.md section 8, Rule 8). The final `result` record already
      // carries a real `usage` object (proven: evidence/05-clean-default-
      // permission.txt) — this was previously read and discarded. tokensIn
      // includes only the non-cached input tokens per Anthropic's usage
      // shape; cachedTokens is cache_read (tokens served from cache, i.e.
      // NOT re-billed as fresh input) plus cache_creation is reported
      // separately since it IS billed, just at a different rate.
      tokensIn: obj.usage?.input_tokens ?? null,
      tokensOut: obj.usage?.output_tokens ?? null,
      cachedTokens: obj.usage?.cache_read_input_tokens ?? null,
      cacheCreationTokens: obj.usage?.cache_creation_input_tokens ?? null,
    });
    return;
  }
}

/**
 * A control_request the CLI has sent US. Only `can_use_tool` is answered here.
 *
 * Unknown subtypes are recorded and IGNORED rather than error-replied. Two reasons: the
 * protocol has a payload-free liveness heartbeat that "either side may send at any time (the
 * CLI emits it periodically, for example while a long-running control request is in
 * progress)" and that "receivers must ignore" — which is exactly the parked-approval case, so
 * a host that error-replies to everything unfamiliar would start answering heartbeats the
 * moment an ask parks for a while. And an error reply is not an answer anyway: the CLI's own
 * docs note that a client which error-replies to a subtype it does not know leaves the worker
 * still waiting. Silence and a diagnostic event is the honest outcome.
 */
function _handleInboundControlRequest(run, obj) {
  const runId = run.runId;
  const subtype = obj.request?.subtype;
  const requestId = obj.request_id;

  if (subtype !== 'can_use_tool') {
    run._emitEvent({ type: 'harness.control-request.unhandled', runId, subtype: subtype ?? null, requestId });
    return;
  }

  const req = obj.request;
  const parked = {
    requestId,
    toolName: req.tool_name,
    displayName: req.display_name ?? req.tool_name,
    toolUseId: req.tool_use_id ?? null,
    input: req.input ?? {},
    // MEASURED: this is how a QUESTION (AskUserQuestion) is told apart from a request to run
    // a tool. Both arrive on this same channel; only this flag distinguishes them, and
    // answering a question with a bare `allow` runs it with no answers and tells the model
    // "The user did not answer the questions." See ../FINDINGS.md.
    requiresUserInteraction: !!req.requires_user_interaction,
    description: req.description ?? null,
    // The harness's own "always allow this rule" offer, in its `addRules` shape. Passed
    // through untouched: it is the harness's vocabulary, not ours, and a UI that wants to
    // offer "always allow" needs it verbatim.
    suggestions: req.permission_suggestions ?? null,
    receivedAt: new Date().toISOString(),
    generation: run._generation,
  };
  run._parkedRequests.set(requestId, parked);
  run._emitEvent({ type: 'approval.request', runId, ...parked });
}

/**
 * answerApproval(runId, requestId, decision) -> { delivered: true }
 *
 * Hand a decision back to a parked request. `decision` is either
 *   { behavior: 'allow', updatedInput? }   or   { behavior: 'deny', message }
 * which is the harness's own vocabulary, verbatim — this function does not invent a
 * dashboard-side enum for it, because a translation layer here would be one more place for
 * "allow" to quietly become "deny".
 *
 * Throws rather than resolving falsely in every case where the answer cannot be honoured:
 * an unknown request id, a request from a superseded generation, or dead stdin. The caller
 * (supervisor) records the failure against the ask and leaves it in the redelivery queue —
 * an undelivered answer must never be recorded as delivered, or a worker stays parked while
 * the dashboard shows the question resolved.
 */
export async function answerApproval(runId, requestId, decision, { expectGeneration } = {}) {
  const run = _get(runId);
  const parked = run._parkedRequests.get(requestId);
  if (!parked) {
    const err = new Error(
      `answerApproval: run ${runId} has no parked request ${requestId} (already answered, withdrawn by the harness, or lost with a replaced process)`,
    );
    // Retrying cannot conjure a request back, so the caller must stop queueing this answer
    // rather than attempting it on every boot forever.
    err.permanent = true;
    throw err;
  }
  // resume() rebinds run.child to a NEW OS process and bumps the generation (finding S7 /
  // the 0003 review). A request parked by the old process cannot be answered through the new
  // one's stdin: the id means nothing there, and writing it would be a silent no-op.
  if (parked.generation !== run._generation) {
    run._parkedRequests.delete(requestId);
    const err = new Error(
      `answerApproval: request ${requestId} was parked by generation ${parked.generation} but the run is now on generation ${run._generation} — the process that asked is gone`,
    );
    err.permanent = true;
    throw err;
  }
  // The CALLER's expectation of which generation asked, checked against what is actually parked.
  // Found by review: the adapter's own check above only proves "this parked entry belongs to my
  // current process" — it cannot know which generation produced the answer the supervisor is
  // holding. So a request id reused by a replacement process would accept generation N's stored
  // decision. The authorization question is "did the process that asked get the answer that was
  // given to it", and only the caller's expectation can settle it.
  if (expectGeneration != null && Number(expectGeneration) !== Number(parked.generation)) {
    const err = new Error(
      `answerApproval: refusing to answer request ${requestId} — the answer was recorded for generation ${expectGeneration} but the parked request belongs to generation ${parked.generation}`,
    );
    err.permanent = true;
    throw err;
  }
  if (!decision || (decision.behavior !== 'allow' && decision.behavior !== 'deny')) {
    const err = new Error(`answerApproval: decision.behavior must be 'allow' or 'deny', got ${JSON.stringify(decision)}`);
    err.permanent = true;
    throw err;
  }

  const response = decision.behavior === 'allow'
    ? { behavior: 'allow', ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}) }
    // A deny message reaches the model verbatim as the tool_result error text (measured), so
    // a human's stated reason is what the worker actually reads. Never send an empty one.
    : { behavior: 'deny', message: decision.message || 'Denied by the dashboard operator.' };

  // Awaited, so "delivered" means the bytes were accepted by the pipe rather than merely queued.
  // The parked entry is dropped only AFTER that: a failed write leaves the request parked and
  // therefore still answerable, instead of losing it to a delivery that did not happen.
  await _writeControl(run, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  run._parkedRequests.delete(requestId);
  run._emitEvent({
    type: 'approval.answered',
    runId,
    requestId,
    toolName: parked.toolName,
    toolUseId: parked.toolUseId,
    behavior: response.behavior,
  });
  return { delivered: true, behavior: response.behavior };
}

/** Every request this run currently has parked on us, oldest first. */
export function pendingApprovals(runId) {
  return [...(_get(runId)._parkedRequests.values())];
}

/**
 * interrupt(runId) -> void
 *
 * Sends a control_request interrupt over stdin. Proven (FINDINGS.md #4)
 * to cancel only the in-flight turn while leaving the resident process
 * and stdin usable for the next sendInput() call. This is a BEST-EFFORT,
 * fire-and-forget call here (matching the required sync void signature);
 * internally it's async (writes to stdin, control_response arrives later
 * as a control_response line, which we swallow if no one awaited it).
 *
 * IMPORTANT CAVEAT: SIGINT (process.kill('SIGINT')) was tried first and
 * proven to kill the entire resident process instead of just the turn —
 * do NOT use SIGINT for interrupt on a resident process. (SIGINT is fine,
 * and is the ONLY option, for the non-resident/one-shot invocation style,
 * where killing the process is the intended effect of interrupt().)
 */
export function interrupt(runId) {
  const run = _get(runId);
  const requestId = randomUUID();
  const req = { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
  if (!run.child?.stdin || run.child.stdin.destroyed || run.exitCode !== null) return;
  run.child.stdin.write(JSON.stringify(req) + '\n');
}

/**
 * clearContext(runId) -> ack
 *
 * PROVEN (FINDINGS.md #5): there is no in-place "clear this session's
 * history but keep the same session id" operation. Sending a `/clear`
 * user turn on the SAME resident stdin pipe keeps the OS process alive
 * (same runId from this adapter's point of view) but the CLI mints a
 * brand-new internal session_id and the model provably has no memory of
 * prior turns. So: process-level identity (runId) survives; session-level
 * identity (claudeSessionId, and hence anything tied to --resume) does
 * NOT. Document this precisely to callers — "clear" == "new session,
 * same OS process."
 *
 * Finding M7 (prep only): this is the adapter-side surface the supervisor
 * will route `clearContext` requests to in Group 5. Signature is stable:
 * takes the same `runId` every other adapter call takes, synchronous
 * return of an ack object, no adapter-specific options leaking through.
 */
export function clearContext(runId) {
  const run = _get(runId);
  const previousSessionId = run.claudeSessionId;
  _sendUserMessage(run, '/clear');
  return {
    ack: true,
    runId,
    previousClaudeSessionId: previousSessionId,
    note: 'A new internal Claude session_id will be issued on the next init event; runId/process identity is preserved but conversation history is not.',
  };
}

/**
 * resume(runId) -> runId | 'unsupported'
 *
 * Two distinct resume mechanisms were proven:
 *  1. Cross-process resume: `claude --resume <session_id>` from a brand
 *     new invocation reconstitutes history (FINDINGS.md #3). Useful if
 *     the resident process from start() has already exited/been stopped.
 *  2. Same-process "resume": simply keep sending sendInput() on a still-
 *     running resident process — no resume verb needed at all, because
 *     the process never went away.
 *
 * This function implements (1): if the run's process has exited, spawn a
 * fresh resident process with --resume <lastKnownSessionId> and return
 * the SAME runId (rebinding it to a new child process). If the run is
 * still alive, resume is a no-op — just keep using sendInput/runId as-is.
 *
 * Finding S7 fix: rebinding run.child here used to leave a stale stop()
 * SIGKILL timer able to kill the WRONG (new) process if resume() landed
 * inside that timer's 3s window. _bindChild() now bumps run._generation on
 * every rebind, and stop()'s timer captures both the specific child
 * object and the generation it was scheduled against, so a stale timer
 * recognizes it's stale and does nothing. resume() also now goes through
 * the same _bindChild() helper as start(), so it can no longer omit the
 * child.on('error') handler start() has (the second half of S7).
 */
export function resume(runId) {
  const run = _get(runId);
  if (run.status !== 'stopped' && run.status !== 'errored' && run.child && !run.child.killed && run.exitCode === null) {
    // Process still alive — nothing to do, same runId already usable.
    return runId;
  }
  if (!run.claudeSessionId) {
    return 'unsupported'; // never got far enough to have a session id to resume
  }

  const args = _buildArgs(run.spec);
  args.push('--resume', run.claudeSessionId);

  run._buf = '';
  // A resumed generation gets its environment declared again, and recorded again: the
  // project settings on disk may have changed between generations (a `git pull`, an edited
  // hook), so one `worker.env` per run would be a record of the environment generation 1
  // had, presented as the environment the live process has.
  run._emitEvent({ type: 'worker.env', runId, resumed: true, ...describeEnv(run.spec) });

  // Same managed-spawn path as start(): a resumed run must own its process group
  // just as much as a fresh one, and its recorded identity must be the NEW child's.
  // The resumed generation is a NEW process and needs the same environment the first one had — otherwise a
  // resumed worker silently loses its principal and every callback it makes is refused.
  _adoptChild(run, spawnManaged({
    command: CLAUDE_BIN, args, cwd: run.spec.cwd, ...(run.spec.env ? { env: run.spec.env } : {}),
  }));
  // The new process needs the greeting too, or the resumed generation's approvals are
  // auto-denied while the first generation's were routed to us — the kind of divergence
  // finding S7 existed to prevent.
  if ((run.spec.approvalMode ?? 'host') !== 'off') _sendInitialize(run);
  return runId;
}

/**
 * stop(runId) -> void
 *
 * Hard stop. Attempts SIGINT first (to give the CLI a chance to flush its
 * final result/session state to disk so a later resume() can still work),
 * falling back to SIGKILL after 3s if it doesn't die.
 *
 * CORRECTION (2026-09-05, code review, finding M2): this used to claim SIGINT
 * was "proven to terminate the resident process cleanly — exit code 0, no
 * zombie." That's false — concurrency-evidence.log:75 records the actual
 * captured result as `signal: "SIGKILL"`: the 3s fallback fired, meaning an
 * idle resident `claude` process did NOT die from SIGINT alone in the case
 * that was actually tested. Treat SIGINT here as best-effort only; SIGKILL
 * fallback firing is the observed common case, not a rare backstop.
 *
 * Finding S7 fix: the SIGKILL fallback timer used to close over `run` and
 * call `run.child.kill('SIGKILL')` — by the time it fires, `run.child` may
 * have been reassigned by a resume() that landed inside the 3s window,
 * so the stale timer would SIGKILL the WRONG (replacement) process. Fixed
 * by capturing the specific child object and generation at schedule time
 * and checking both are still current before killing anything.
 */
export function stop(runId) {
  const run = _get(runId);
  run.status = 'stopped';
  // The process is going away, so every parked request goes with it. The supervisor closes
  // this run's open asks on the same path (0003); clearing here stops a later answer from
  // being written to a dead pipe and reported as delivered.
  run._parkedRequests.clear();
  if (run.child && run.exitCode === null) {
    const childAtStopTime = run.child;
    const generationAtStopTime = run._generation;
    run.child.kill('SIGINT');
    setTimeout(() => {
      const isStillCurrentChild = run.child === childAtStopTime && run._generation === generationAtStopTime;
      if (isStillCurrentChild && run.exitCode === null) {
        // Group 5: escalate to the whole PROCESS GROUP, not just the leader. The
        // child leads its own group now (spawnManaged), so anything it spawned --
        // MCP servers, tool subprocesses -- dies with it instead of being left
        // behind as an unparented orphan. Falls back to the bare pid when the
        // group is unknown (identity unverified, e.g. the child died instantly).
        const pgid = run.verifiedPgid;
        if (Number.isInteger(pgid) && pgid > 1) signalProcessGroup(pgid, 'SIGKILL');
        else childAtStopTime.kill('SIGKILL');
      }
      // else: a resume() rebound run.child inside this window (finding
      // S7) — this timer is stale and must not touch the new process.
    }, 3000);
  }
  if (run.child?.stdin && !run.child.stdin.destroyed) {
    try { run.child.stdin.end(); } catch { /* ignore */ }
  }
}

function _get(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error(`Unknown runId: ${runId}`);
  return run;
}

/**
 * processIdentity(runId) -> Promise<identity>
 *
 * The uniform surface the supervisor persists from (Group 5). Both adapters implement
 * it; the `ownership` field is where they honestly differ:
 *
 *   'run-owned'    — this process group belongs to this run alone, so killing the group
 *                    kills exactly this run. True here: one resident `claude` per run.
 *   'shared-server' — see the OpenCode adapter. Killing the group would kill unrelated
 *                    runs, so `reap` must refuse.
 */
export async function processIdentity(runId) {
  const run = _get(runId);
  if (!run.identity) return { verified: false, reason: 'run has no spawned child', ownership: 'run-owned' };
  const info = await run.identity;
  return { ...info, cwd: run.cwd ?? run.spec?.cwd ?? null, spawnDepth: run.spawnDepth ?? null, ownership: 'run-owned' };
}

/** Every runId this adapter still holds a handle for. Reconciliation's "is it still ours" input. */
export function listRuns() {
  return [...runs.keys()];
}

/**
 * disposeAll() -> Promise<{ stopped: string[] }>
 *
 * Deterministic teardown (Group 5): stop every run this adapter owns and take its whole
 * process group down with a short SIGTERM grace, not the 3-second one stop() gives an
 * individual run -- the supervisor is on its way out, and a child that outlives it is
 * precisely the `orphaned-unmanaged` state this group of work exists to prevent.
 */
export async function disposeAll({ graceMs = 300 } = {}) {
  const stopped = [];
  const kills = [];
  for (const [runId, run] of [...runs.entries()]) {
    run.status = 'stopped';
    run._parkedRequests.clear();
    const pgid = run.verifiedPgid;
    if (Number.isInteger(pgid) && pgid > 1) {
      kills.push(killProcessGroup(pgid, { graceMs }));
    } else if (run.child && run.exitCode === null) {
      // No verified group to signal -- the bare pid is all we can honestly reach.
      try { run.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    stopped.push(runId);
    runs.delete(runId);
  }
  await Promise.all(kills);
  return { stopped };
}

export function _getRunForTest(runId) {
  return runs.get(runId);
}
