// OpenCode spawn adapter — Phase 1 (promoted from spike-0b, with the
// defects found by consolidated-review-claudeopus5-medium--spike-0b.md
// fixed: B4 (normalized turn.end), S4 (two-level run identity), S5 (model
// persists across turns), S6 (drained stdio + spawn error handling), S8
// (observe() replay buffer), S9 (fail-closed SSE session filtering), M14
// (preflight binary check), M7 (clean clearContext/resume surface).
//
// The spike's original file (spike-0b/opencode-adapter/adapter.js) is left
// untouched — this is a copy with real fixes, not a from-scratch rewrite.
// See ../FINDINGS.md for what changed and what was proven, including the
// live-source verification behind the S9 allowlist.
//
// PROVEN ARCHITECTURE: the adapter interface (start/sendInput/observe/interrupt/
// clearContext/resume/stop) requires a RESIDENT, addressable process that can be
// told to abort mid-turn and answer permission questions from code. OpenCode's
// one-shot CLI (`opencode run`) cannot do this (see spike-0b FINDINGS.md #4) —
// SIGINT is swallowed and the turn runs to completion anyway; SIGTERM kills the
// process hard with zero output. Only `opencode serve` (a headless HTTP+SSE
// server) supports true interrupt and true incremental streaming.
//
// So this adapter spawns one `opencode serve` process per unique `cwd` (that's
// how OpenCode gets its "project directory" — serve has no --dir flag; the
// directory is inherited from the OS-level cwd of the spawned process, proven
// in FINDINGS.md #6), talks to it over its local HTTP API, and multiplexes
// sessions (one opencode session = one logical "run") on top of it.
//
// Everything below is backed by an actually-run curl/node call captured in
// spike-0b FINDINGS.md, except where noted as new for this pass.

import { execFile } from 'node:child_process';
import { spawnManaged, killProcessGroup } from '../../runtime/spawn.js';
import { randomUUID } from 'node:crypto';

const DEFAULT_MODEL = { providerID: 'amazon-bedrock', modelID: 'us.anthropic.claude-sonnet-5' };

// Finding S9: events with no sessionID at all used to pass the (fail-open)
// filter and broadcast to every observer on the server. Verified against
// live OpenCode source (anomalyco/opencode,
// packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts,
// checked 2026-09-05) that exactly three event types are unconditionally
// session-less BY DESIGN — they are emitted with `properties: {}` before
// any session-scoped listener even attaches:
//   - "server.connected"          (emitted once when a client subscribes)
//   - "server.heartbeat"          (emitted every 10s to keep the SSE alive)
//   - "server.instance.disposed"  (emitted when the whole server instance tears down)
// Every event type this adapter's mapEvent() actually consumes
// (message.part.delta, message.part.updated, permission.asked,
// session.idle, session.error) is session-scoped and carries `sessionID`
// in its properties — confirmed by the spike's own captured evidence
// (stream_events.log) showing `sessionID` present on all of them. No other
// session-less type was found in the source read for this pass; this
// allowlist is deliberately narrow rather than guessed.
const SESSIONLESS_EVENT_ALLOWLIST = new Set(['server.connected', 'server.heartbeat', 'server.instance.disposed']);

// Bounded ring buffer for a process's stderr, for diagnostics (finding S6).
// Keeps memory bounded without silently discarding all diagnostic value the
// way `stdio: 'ignore'` would.
//
// Bounded by BYTES, not by line count (older should-fix backlog: "the stderr
// ring is bounded by line count not bytes, so one huge line is unbounded").
// `line.length` entries have no upper bound of their own -- a process that
// writes one enormous line with no newline (a giant JSON dump, garbage
// binary output with no '\n' for megabytes) stored the WHOLE thing as a
// single ring entry, so 200 such lines could still exhaust memory even
// though "200" sounds bounded. `STDERR_RING_MAX_LINE_BYTES` also truncates
// any one absurd line before it's ever stored, so a single line can't blow
// the byte budget on its own either.
const STDERR_RING_MAX_BYTES = 64 * 1024; // 64 KiB total, regardless of line count or length
const STDERR_RING_MAX_LINE_BYTES = 4 * 1024; // no single stored line exceeds this

// How long to wait for the /event subscription to prove itself live (via
// OpenCode's own `server.connected` event) before proceeding anyway. See
// _startServerEventDemuxer() for why this is a bounded degrade, not a hard fail.
const SSE_CONNECT_TIMEOUT_MS = 5000;

// Exported so its byte bound can be proven in a direct, isolated unit test — no real `opencode`
// process needs to write megabytes of stderr just to check a pure buffer's arithmetic.
export class StderrRing {
  constructor(maxBytes = STDERR_RING_MAX_BYTES) {
    // review-sol-2026-09-13.md finding 33's other half: a non-positive-integer budget (0, negative,
    // NaN, a string) would make the eviction loop below either never trigger or behave nonsensically —
    // fail loud here rather than silently accepting garbage that only breaks later, at push time.
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error(`StderrRing: maxBytes must be a positive integer, got ${JSON.stringify(maxBytes)}`);
    }
    this.maxBytes = maxBytes;
    this.lines = [];
    this.bytes = 0;
  }
  push(line) {
    // Relative to THIS instance's own budget, not just the module-level constant — a ring
    // constructed with a smaller `maxBytes` than `STDERR_RING_MAX_LINE_BYTES` must still end up
    // with a truncated line it can actually KEEP, or the eviction loop below would immediately
    // shift its only entry back out for still exceeding the budget, leaving the ring empty right
    // after a push that should have kept something.
    const lineBudget = Math.min(STDERR_RING_MAX_LINE_BYTES, this.maxBytes);
    let stored = line;
    if (Buffer.byteLength(stored, 'utf8') > lineBudget) {
      // review-sol-2026-09-13.md finding 33: both the truncation point AND the suffix's own length
      // used to be computed with `.slice()`/`.length` — UTF-16 CODE UNIT operations, not bytes. A
      // multibyte character (an emoji is 4 UTF-8 bytes but only 2 UTF-16 code units) meant `lineBudget`
      // "code units" kept far more than `lineBudget` BYTES (measured: a 1,024-byte ring retained 2,038
      // bytes of emoji input) — the exact byte bound this class exists to enforce, silently violated.
      // Truncate the real UTF-8 BYTES via a Buffer, and count the suffix's real byte length too.
      const suffix = '…(truncated)';
      const suffixBytes = Buffer.byteLength(suffix, 'utf8');
      const keepBytes = Math.max(0, lineBudget - suffixBytes);
      // `Buffer#toString('utf8')` decodes a byte sequence truncated mid-multibyte-character as ONE
      // Unicode replacement character (U+FFFD, itself 3 UTF-8 bytes) rather than throwing — best-effort
      // at the boundary, never invalid UTF-16 in the resulting JS string. But that replacement can be
      // BIGGER than the partial bytes it replaced (up to 3 bytes for as little as 1 partial byte cut
      // off), so the decoded result can end up slightly OVER `keepBytes` — shrink a character at a time
      // until it genuinely fits, rather than trusting the byte slice point alone.
      let kept = Buffer.from(stored, 'utf8').subarray(0, keepBytes).toString('utf8');
      while (Buffer.byteLength(kept, 'utf8') + suffixBytes > lineBudget && kept.length > 0) {
        kept = kept.slice(0, -1);
      }
      stored = `${kept}${suffix}`;
    }
    this.lines.push(stored);
    this.bytes += Buffer.byteLength(stored, 'utf8');
    while (this.bytes > this.maxBytes && this.lines.length > 1) {
      this.bytes -= Buffer.byteLength(this.lines.shift(), 'utf8');
    }
  }
  toString() {
    return this.lines.join('\n');
  }
}

// serverPool: cwd -> { proc, port, baseUrl, ready: Promise<void>, stderrRing,
//                      sessionsKnown: Set<sessionID>, sseAbort: AbortController }
const serverPool = new Map();

// runs: runId -> Run (see below)
const runs = new Map();

class Run {
  constructor({ baseUrl, sessionID, serverPid, cwd, modelSel, effort }) {
    this.baseUrl = baseUrl;
    this.sessionID = sessionID;
    // Finding S4: `opencode serve` is pooled per-cwd and multiplexes many
    // sessions through one OS process, so pid/pgid/lstart alone cannot
    // distinguish runs sharing a server. Runs are now modeled with a
    // two-level identity: `serverPid` (the OS process) + `sessionID` (the
    // server's own conversation identity). Both are independently
    // verifiable — see verifyRunIdentity() below.
    this.serverPid = serverPid;
    this.cwd = cwd;
    this.status = 'starting';
    this.lastError = null;
    // Finding S5: sendInput used to hardcode DEFAULT_MODEL instead of
    // reusing whatever start() was called with. Persisted here and reused
    // on every subsequent sendInput().
    this.modelSel = modelSel;
    this.effort = effort;
    // Finding S8: observe() used to subscribe to /event live with no
    // buffering, so a turn that finished before anyone called observe()
    // (the normal case, since start() returns immediately) meant the
    // terminating event was missed and the caller hung forever. Buffered
    // from start() time via the per-server SSE demuxer, replayed by cursor
    // — same shape as the Claude Code adapter's `_eventLog`.
    this._eventLog = [];
    this._readCursor = 0;
    this._waiters = []; // resolve callbacks for observe()'s wake-on-event
    // Older should-fix backlog: "OpenCode abort can emit two terminal events
    // (session.error then session.idle, both mapped to turn.end)". Measured, not
    // guessed (see interrupt()'s own doc comment): a real abort produces BOTH a
    // `session.error` (MessageAbortedError -> turn.end status:'aborted') AND a
    // `session.idle` (-> turn.end status:'completed') for the SAME logical turn
    // ending. Without this flag, both land in `_eventLog`, and any consumer that
    // just takes "the last turn.end it saw" (event-pump.js's `updateDerived` does
    // exactly this) reports the run as cleanly `completed` when it was actually
    // aborted. Reset at the start of each new turn (start()/sendInput()), set the
    // first time a turn.end is actually emitted for the CURRENT turn.
    this._turnEndedForCurrentTurn = false;
    // Set by observe()'s returned wrapper when its `.return()` is called (the pump's iterator
    // cancellation contract) — see observe()'s own doc comment for why this exists at all.
    this._cancelled = false;
  }

  _emitEvent(evt) {
    this._eventLog.push(evt);
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w();
  }
}

/**
 * preflight() -> Promise<{ ok: boolean, reason?: string }>
 *
 * Finding M14: no preflight existed for either binary. A missing
 * `opencode` binary used to manifest as an unhandled 'error' event that
 * crashed the host process (finding S6) the first time getServer() spawned
 * it. This checks `opencode --version` up front with a bounded timeout.
 */
export function preflight() {
  return new Promise((resolve) => {
    const child = execFile('opencode', ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({
          ok: false,
          reason: err.code === 'ENOENT'
            ? 'opencode binary not found on PATH; install it or fix PATH before starting a run'
            : `opencode --version failed: ${err.message}`,
        });
        return;
      }
      resolve({ ok: true, version: stdout.trim() });
    });
    child.on('error', (err) => {
      resolve({ ok: false, reason: `opencode binary spawn error: ${err.message}` });
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/global/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error(`opencode serve did not become healthy within ${timeoutMs}ms`);
}

/**
 * Read back what a pooled server actually loaded.
 *
 * BEST-EFFORT by design: this is an observability record, and a record about a worker must never
 * be able to prevent the worker (the same rule the Claude Code settings-chain reader follows).
 * A failure is recorded AS a failure rather than thrown or, worse, rendered as an empty
 * environment -- "we could not ask" and "it loaded nothing" are opposite facts and an empty list
 * for the first would be the most misleading thing this function could return.
 *
 * Counts rather than contents for agents/plugins, names for MCP servers: there should normally be
 * none, so the list is short and is the interesting part when it is not. Same reasoning as the
 * Claude Code `session.init` record, and the same context-economy concern (PLAN.md section 8) --
 * 13 agent names in every run's transcript is the problem one layer down.
 */
async function describeServerEnv(server, { timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(`${server.baseUrl}/config`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { envUnavailable: `GET /config -> ${res.status}` };
    const cfg = await res.json();
    const mcp = cfg?.mcp && typeof cfg.mcp === 'object' ? Object.keys(cfg.mcp) : [];
    return {
      mcpServers: mcp.sort(),
      agentCount: cfg?.agent && typeof cfg.agent === 'object' ? Object.keys(cfg.agent).length : 0,
      pluginCount: Array.isArray(cfg?.plugin) ? cfg.plugin.length : 0,
      instructionCount: Array.isArray(cfg?.instructions) ? cfg.instructions.length : 0,
      // The model the SERVER reports, not the one this adapter defaults to. Those agreeing is
      // a coincidence worth being able to notice rather than assume.
      reportedModel: typeof cfg?.model === 'string' ? cfg.model : null,
    };
  } catch (err) {
    return { envUnavailable: String(err?.message ?? err) };
  }
}

async function getServer(cwd) {
  if (serverPool.has(cwd)) {
    const entry = serverPool.get(cwd);
    await entry.ready;
    return entry;
  }

  const port = 40000 + Math.floor(Math.random() * 10000);
  const stderrRing = new StderrRing();
  // Group 5: managed spawn -- `serve` leads its own process group (detached,
  // pgid === pid, verified against the OS) and carries DASHBOARD_SPAWN_DEPTH. This is
  // the process that PLAN.md's `orphaned-unmanaged` example is about: `opencode serve`
  // is an HTTP server, not a stdin-attached child, so it happily outlives the
  // supervisor. Owning its group is what makes killing it possible at all.
  const { child: proc, identity: serverIdentity, spawnDepth } = spawnManaged({
    command: 'opencode',
    args: ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    cwd,
    // Finding S6: stdout/stderr were piped but never read anywhere, which
    // can fill the OS pipe buffer and block the process on write. stdout is
    // not needed for anything this adapter does, so it's ignored outright
    // (simplest way to guarantee it never backpressures); stderr IS worth
    // keeping for diagnostics, so it gets a real reader below feeding a
    // bounded ring buffer rather than growing unbounded.
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  // Finding S6 (second half): no proc.on('error') existed, so a missing
  // `opencode` binary produced an unhandled 'error' event that killed the
  // supervisor. preflight() above catches the common case ahead of time;
  // this is the belt-and-suspenders runtime guard for the same failure
  // showing up mid-run (binary removed between preflight and spawn, etc).
  //
  // spawnErrorPromise races against waitForHealth() below rather than
  // relying on a plain boolean flag checked before/after the health-poll
  // loop: 'error' fires asynchronously, often before waitForHealth's first
  // fetch attempt even lands, but a plain flag checked only at the two
  // await-boundaries of this function can still lose the race and burn
  // the full 15s health timeout before ever looking at it again. Racing
  // means a missing binary fails in milliseconds, not 15 seconds.
  let spawnError = null;
  let rejectOnSpawnError;
  const spawnErrorPromise = new Promise((_, reject) => { rejectOnSpawnError = reject; });
  spawnErrorPromise.catch(() => {}); // prevent an unhandled rejection if 'error' fires after the race below is already settled
  proc.on('error', (err) => {
    spawnError = err;
    rejectOnSpawnError(new Error(`opencode serve failed to spawn: ${err.message}`));
  });

  proc.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.length) stderrRing.push(line);
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  // Finding S2 (adjacent, from the same consolidated review): the pool
  // entry used to be published before `ready` resolved, so a second
  // concurrent start() on the same cwd could get the entry back and issue
  // HTTP against a server not listening yet, and the comment describing a
  // `ready` promise was never backed by real code. `ready` is now a real
  // promise, stored on the entry BEFORE the health check runs, and every
  // caller (including this function on a pool hit above) awaits it.
  const entry = {
    proc,
    port,
    baseUrl,
    stderrRing,
    sessionsKnown: new Set(),
    sseAbort: new AbortController(),
    // Group 5: the OS-verified identity of this server process, resolved a beat after
    // the spawn (it is a real `ps` read, not an assumption). `verifiedPgid` is left
    // null until then, and every consumer treats "not verified" as a real state rather
    // than guessing a pgid -- signalling a guessed group is the bug being fixed.
    identity: serverIdentity,
    spawnDepth: Number(spawnDepth),
    verifiedPgid: null,
    verifiedLstart: null,
  };
  serverIdentity
    .then((info) => {
      if (info.verified) {
        entry.verifiedPgid = info.pgid;
        entry.verifiedLstart = info.lstart;
      }
    })
    .catch(() => {
      /* spawnManaged already killed a child it could not own; `entry.ready` below
         surfaces the failure through waitForHealth/spawnErrorPromise. Swallowed here
         only so it can't become an unhandled rejection. */
    });
  entry.ready = (async () => {
    await Promise.race([waitForHealth(baseUrl), spawnErrorPromise]);
    // Group 4 blocking finding (review-two/group4-adapters-luna.md): the demuxer
    // used to be started fire-and-forget here, so `ready` resolved — and start()
    // went on to POST prompt_async — while the SSE subscription was still being
    // established. A fast turn could then emit session.idle before anything was
    // listening, and observe() would hang forever. Awaited now: no run is ever
    // started against a server whose event stream isn't already live.
    await _startServerEventDemuxer(entry);
  })();
  serverPool.set(cwd, entry);

  try {
    await entry.ready;
  } catch (err) {
    serverPool.delete(cwd);
    throw err;
  }
  return entry;
}

// Finding S8: a single SSE reader per SERVER (not per run), started as soon
// as the server is healthy — well before any particular run's observe() is
// ever called. Demultiplexes events by sessionID into each matching run's
// `_eventLog`, which is what makes replay-by-cursor possible. This is the
// same "one internal consumer, fan out to observers" shape the Claude Code
// adapter gets for free from its resident stdout reader.
//
// Returns a promise that resolves only once the subscription is genuinely LIVE,
// which callers MUST await before starting any run on this server. "Live" means
// OpenCode's own `server.connected` event has arrived — the event it emits
// exactly once per subscriber, which is the only positive proof from the server
// side that this reader is attached and will receive subsequent events. Merely
// having `fetch` resolve is weaker (response headers can land before the
// server-side listener is wired), and awaiting nothing at all was the original
// blocking bug. If headers arrive but `server.connected` doesn't (an older
// OpenCode that never emits it), the wait degrades to resolved-with-breadcrumb
// after SSE_CONNECT_TIMEOUT_MS rather than deadlocking server startup forever.
function _startServerEventDemuxer(entry) {
  let settled = false;
  let resolveConnected;
  let rejectConnected;
  const connected = new Promise((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    entry.stderrRing.push(
      `[adapter] /event subscription did not deliver server.connected within ${SSE_CONNECT_TIMEOUT_MS}ms; ` +
        'proceeding on headers-received alone (event delivery may be lossy for the first turn)',
    );
    resolveConnected();
  }, SSE_CONNECT_TIMEOUT_MS);
  timer.unref?.();
  const markConnected = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    entry.sseConnected = true;
    resolveConnected();
  };
  const markFailed = (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectConnected(err);
  };

  entry.sseConnected = false;
  (async () => {
    let res;
    try {
      res = await fetch(`${entry.baseUrl}/event`, { signal: entry.sseAbort.signal });
    } catch (err) {
      // Server torn down (or aborted) before the demuxer could attach. This is
      // fatal for the pool entry: without an event stream, every observe() on
      // this server would hang, so it's surfaced rather than swallowed.
      markFailed(new Error(`opencode /event subscription failed: ${err.message}`));
      return;
    }
    if (!res.ok || !res.body) {
      markFailed(new Error(`opencode /event subscription returned ${res.status}`));
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // Stream closed before it ever went live — same fatal case as above.
          markFailed(new Error('opencode /event stream ended before server.connected arrived'));
          return;
        }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          let evt;
          try {
            evt = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          // Positive liveness proof, per the note above. Checked before demuxing
          // so the very first event to arrive can also be the one that unblocks
          // startup.
          if (evt.type === 'server.connected') markConnected();
          _demuxOneEvent(entry, evt);
        }
      }
    } catch (err) {
      /* server gone / aborted mid-stream — nothing more to demux */
      markFailed(new Error(`opencode /event stream failed: ${err.message}`));
    } finally {
      reader.cancel().catch(() => {});
    }
  })();

  return connected;
}

function _demuxOneEvent(entry, evt) {
  const props = evt.properties ?? {};
  const eventType = evt.type;

  // Finding S9: this used to be
  //   if (props.sessionID && props.sessionID !== run.sessionID) continue;
  // — the `props.sessionID &&` short-circuit meant ANY event with no
  // sessionID passed the filter for EVERY concurrently-observed run on
  // that server (fail-open). Inverted to fail-closed: an event is only
  // delivered to a run if it explicitly carries that run's sessionID, OR
  // its type is on the verified session-less allowlist above, in which
  // case it is broadcast to every run on this server (that's what
  // server.connected/server.heartbeat/server.instance.disposed actually
  // are — server-wide, by design, not a session omission).
  if (SESSIONLESS_EVENT_ALLOWLIST.has(eventType)) {
    for (const run of runs.values()) {
      if (run.baseUrl !== entry.baseUrl) continue;
      // `mapEvent()` returns `null` for `server.instance.disposed` — by design, it's a liveness
      // broadcast, not itself a turn-relevant event. But for a run still mid-turn on THIS server,
      // nothing else will EVER tell it the turn is over: the server that would have emitted its
      // `session.idle`/`session.error` just tore itself down. Without this, `observe()` (whose
      // only exit condition is seeing a real `turn.end`) waits forever (older should-fix backlog:
      // "server.instance.disposed maps to null, so a disposed server produces no terminal event
      // and can hang observe()"). `server.connected`/`server.heartbeat` need no such handling —
      // they say nothing about whether any run is still in progress.
      if (eventType === 'server.instance.disposed' && !run._turnEndedForCurrentTurn) {
        run._turnEndedForCurrentTurn = true;
        run.status = 'errored';
        run._emitEvent({
          type: 'turn.end', status: 'error', isError: true,
          error: 'opencode server instance disposed mid-run — the server this run depended on tore itself down',
        });
        continue;
      }
      const mapped = mapEvent(evt, props);
      if (mapped) run._emitEvent(mapped);
    }
    return;
  }

  const sessionID = props.sessionID;
  if (!sessionID) {
    // Fail closed: an event that is neither on the allowlist nor carrying
    // a sessionID is dropped rather than guessed-broadcast. Recorded to the
    // server's stderr ring as a diagnostic breadcrumb so an unexpected new
    // session-less event type doesn't vanish silently forever.
    entry.stderrRing.push(`[adapter] dropped session-less, non-allowlisted event: ${eventType}`);
    return;
  }

  for (const run of runs.values()) {
    if (run.baseUrl !== entry.baseUrl) continue;
    if (run.sessionID !== sessionID) continue;
    const mapped = mapEvent(evt, props);
    if (mapped) {
      if (mapped.type === 'turn.end') {
        // An abort produces BOTH session.error and session.idle for the SAME logical
        // ending (see Run's own `_turnEndedForCurrentTurn` doc comment) — only the
        // FIRST turn.end for this turn is real; a second one would silently overwrite
        // an honest 'aborted'/'error' status with 'completed' in any last-wins consumer.
        if (run._turnEndedForCurrentTurn) {
          entry.stderrRing.push(
            `[adapter] dropped redundant turn.end (status: ${mapped.status}) for an already-ended turn on session ${sessionID}`,
          );
          continue;
        }
        run._turnEndedForCurrentTurn = true;
        run.status = mapped.status === 'completed' ? 'completed' : 'errored';
      }
      run._emitEvent(mapped);
    }
  }
}

/**
 * capabilities() -> the declared capability matrix (PLAN.md section 9, conformance/matrix.js).
 *
 * MEASURED. Two of these differ from the Claude Code adapter in ways that a boolean matrix would
 * have hidden, and both matter to code above the adapter boundary.
 */
export function capabilities() {
  return {
    // POOLED: one `opencode serve` per cwd, with every run in that directory multiplexed onto it as
    // a session. This is not a detail — it is why this adapter REFUSES a per-run environment
    // declaration (an environment belongs to the process, and the process is shared), and why
    // reaping never group-kills a pgid shared with another open run.
    residentProcess: 'pooled',
    resumableTurns: true,
    structuredOutput: 'sse',
    // `POST /session/{id}/abort` ends the turn; the server and the session survive for the next one.
    interrupt: 'turn',
    // COMPACT, NOT ERASE. `clearContext` POSTs `/session/{id}/summarize`: the history is summarized
    // and RETAINED in reduced form. The method's own return value says `semantics:
    // 'compacted-not-erased'`. Claude Code's identically-named method ERASES. PLAN.md section 8's
    // Rule 5 prices routine clearing at "one page of reload", which is true of an erase and false
    // here — a compact reduces context, it does not reset it.
    clearContext: 'compact',
    // OBSERVE-ONLY, and this is the honest name for a real gap rather than a euphemism. The adapter
    // maps `permission.asked` to an `approval.request` event, so a worker CAN park and an `asks` row
    // IS created — but there is no `answerApproval` here, so nothing can ever deliver the answer.
    // The supervisor already refuses to pretend (it abandons the answer with a reason rather than
    // stamping `delivered_at`), but until this field existed nothing DECLARED it, so an operator
    // could reasonably expect the approval UI to work on this harness. It does not.
    approvalProtocol: 'observe-only',
    // The server exposes its config and model list over HTTP, but this adapter does not surface it.
    modelDiscovery: false,
  };
}

/**
 * start(spec) -> runId
 * spec: { prompt, cwd, model?, effort? }
 *
 * PROVEN: session.create (POST /session) + session.prompt_async
 * (POST /session/{id}/prompt_async) both verified via curl (spike-0b
 * FINDINGS.md #1, #7).
 *
 * Finding B9 (from the same consolidated review, fixed here alongside the
 * others because it shares this function): the fire-and-forget
 * prompt_async call used to only .catch() transport failures — a 4xx
 * response resolves the fetch promise, so a bad model/body silently never
 * started a turn and the run hung `running` forever. Checked here too.
 */
export async function start(spec) {
  const { prompt, cwd, model, effort } = spec;

  // ── the worker's environment, and why this harness REFUSES to pretend ──────────────
  //
  // The Claude Code adapter honours `spec.envProfile` / `spec.settingSources` by pinning
  // `--setting-sources` and `--strict-mcp-config` per process. OpenCode cannot do that, for two
  // measured reasons (adapters/FINDINGS.md, "the OpenCode side of the environment decision"):
  //
  //  1. `opencode serve` has NO config flag at all -- no --setting-sources, no
  //     --strict-mcp-config, no --config. Measured on opencode 1.18.29.
  //  2. More fundamentally, this adapter POOLS one `serve` per `cwd` and multiplexes many runs
  //     onto it (`getServer`). An environment is therefore a property of the SERVER, not of a
  //     run: two runs in one cwd share one process that was configured once. A per-run
  //     declaration could only ever apply to whichever run happened to start the server.
  //
  // So it throws instead of ignoring. Silently accepting a declaration it cannot honour is the
  // worse option by a distance: the caller believes the worker is pinned, and a `worker.env`
  // record would assert an environment the process never had. That is exactly the defect the
  // cross-model review found in the Claude Code guard, where the record named a settings file
  // the CLI provably never read (review-phase2-item2/verdicts.md, finding 2).
  if (spec.envProfile !== undefined || spec.settingSources !== undefined || spec.mcpConfig !== undefined) {
    throw new Error(
      'the opencode adapter cannot honour a per-run environment declaration (envProfile/settingSources/mcpConfig): '
      + '`opencode serve` has no config flag, and one server is pooled across every run in a cwd, so an environment '
      + 'belongs to the server rather than the run. Omit the declaration; the environment the server actually loaded '
      + 'is recorded as a `worker.env` event.',
    );
  }

  const server = await getServer(cwd);

  const modelSel = model
    ? { providerID: model.providerID ?? DEFAULT_MODEL.providerID, modelID: model.modelID ?? model }
    : DEFAULT_MODEL;

  const sessionRes = await fetch(`${server.baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // permission ruleset: ask for bash/edit/write so approval.request events are
    // real and interceptable (proven in FINDINGS.md #9). Callers that want
    // auto-approve everything should pass `action: "allow"` here instead.
    body: JSON.stringify({
      title: `run-${randomUUID().slice(0, 8)}`,
      permission: [
        { permission: 'bash', pattern: '*', action: 'ask' },
        { permission: 'edit', pattern: '*', action: 'ask' },
      ],
    }),
  });
  if (!sessionRes.ok) throw new Error(`session.create failed: ${sessionRes.status} ${await sessionRes.text()}`);
  const session = await sessionRes.json();

  const runId = `${server.baseUrl}::${session.id}`;
  const run = new Run({
    baseUrl: server.baseUrl,
    sessionID: session.id,
    serverPid: server.proc.pid,
    cwd,
    modelSel,
    effort,
  });
  runs.set(runId, run);
  server.sessionsKnown.add(session.id);
  run.status = 'running';

  // What this server ACTUALLY loaded, recorded per run because a run is what anyone
  // investigates later. Deliberately the OUTCOME rather than a declaration -- it is read back
  // from the server's own `/config`, which makes it the OpenCode counterpart of Claude Code's
  // `session.init` (the CLI's own account of what it loaded) rather than of `worker.env`'s
  // intent half. There is no intent half here: see the refusal in this function.
  //
  // Measured, and this is why the record matters: in an EMPTY directory a pooled server loads
  // the developer's global `~/.config/opencode/opencode.json` -- 8 MCP servers, 13 custom
  // agents, 2 plugins -- and no flag or OPENCODE_* variable suppresses it. So an OpenCode
  // worker today is in exactly the un-declared, non-reproducible state the Claude Code fix
  // removed, and the honest first step is to make it visible rather than to claim it is pinned.
  run._emitEvent({ type: 'worker.env', runId, scope: 'server', ...(await describeServerEnv(server)) });

  const promptBody = {
    parts: [{ type: 'text', text: prompt }],
    model: modelSel,
  };
  // effort maps to OpenCode's --variant / API `variant` field.
  // PROVEN the flag/field is accepted without error (FINDINGS.md #7); NOT proven
  // that it changes actual model behavior (no observable signal from the model
  // confirming which variant it ran with) — BEST-EFFORT pass-through.
  if (effort) promptBody.variant = effort;

  fetch(`${server.baseUrl}/session/${session.id}/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(promptBody),
  }).then((res) => {
    if (!res.ok) {
      return res.text().then((body) => {
        run.status = 'errored';
        run.lastError = new Error(`prompt_async rejected: ${res.status} ${body}`);
        run._turnEndedForCurrentTurn = true;
        // Synthesize the terminating event ourselves — the server will
        // never emit session.idle/session.error for a turn it rejected
        // before starting, so without this, observe() would hang forever
        // (this is finding B9's exact failure mode).
        run._emitEvent({ type: 'turn.end', status: 'error', isError: true, error: String(run.lastError) });
      });
    }
  }).catch((err) => {
    run.status = 'errored';
    run.lastError = err;
    run._turnEndedForCurrentTurn = true;
    run._emitEvent({ type: 'turn.end', status: 'error', isError: true, error: String(err) });
  });

  return runId;
}

/**
 * sendInput(runId, input) -> void
 *
 * PROVEN for the "send a second message after the first turn completed" case
 * (FINDINGS.md #3 — multi-turn + secret-recall test passed). NOT proven while a
 * turn is still in flight — OpenCode's message endpoint has no documented
 * "inject into the running turn" semantics; calling this while status is
 * "running" is BEST-EFFORT (it will likely queue behind the current turn or be
 * rejected by the server, not truly interleave).
 *
 * Finding S5 fix: this used to hardcode DEFAULT_MODEL on every call instead
 * of reusing whatever model start() was called with, so turn 1 ran on the
 * requested model and every follow-up turn silently ran on Bedrock Sonnet.
 * Now reuses `run.modelSel`/`run.effort`, persisted at start() time.
 */
export async function sendInput(runId, input) {
  const run = runs.get(runId);
  if (!run) throw new Error(`unknown runId: ${runId}`);
  run.status = 'running';
  // A NEW turn starts here — the previous turn's terminal-event guard must not carry over, or
  // this turn's own real termination would be wrongly suppressed as "redundant."
  run._turnEndedForCurrentTurn = false;
  const body = { parts: [{ type: 'text', text: input }], model: run.modelSel };
  if (run.effort) body.variant = run.effort;
  const res = await fetch(`${run.baseUrl}/session/${run.sessionID}/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sendInput failed: ${res.status} ${await res.text()}`);
}

/**
 * observe(runId) -> AsyncIterable<Event>
 *
 * Event shapes:
 *   message.part.delta      -> assistant.delta   (real per-token deltas, not
 *                                                  just a final blob — FINDINGS.md #2)
 *   message.part.updated (tool part, state=running) -> tool.start
 *   message.part.updated (tool part, state=completed/error) -> tool.result
 *   permission.asked       -> approval.request   (FINDINGS.md #9)
 *   session.idle / step-finish -> turn.end (status: 'completed')
 *   session.error           -> turn.end (status: 'error' | 'aborted')
 *
 * Finding S8 fix: this used to open its OWN `GET /event` connection at
 * observe()-call time and stream live with no buffering. Since start()
 * returns immediately (prompt_async is fire-and-forget), a fast turn could
 * finish — and its terminating session.idle/session.error already pass —
 * before anyone ever called observe(), and the caller would then hang
 * forever waiting for an event that already happened. Events are now
 * buffered into a per-run `_eventLog` starting at start() time (via the
 * per-server demuxer above), and observe() just replays from a cursor over
 * that log — the same shape the Claude Code adapter already used.
 */
export function observe(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error(`unknown runId: ${runId}`);

  async function* realObserve() {
    const isTerminal = (evt) => evt.type === 'turn.end';
    let sawTerminal = false;

    while (true) {
      while (run._readCursor < run._eventLog.length) {
        const evt = run._eventLog[run._readCursor++];
        if (isTerminal(evt)) sawTerminal = true;
        yield evt;
      }
      if (sawTerminal || run._cancelled) return;
      await new Promise((res) => {
        run._waiters.push(res);
        setTimeout(res, 200); // safety-net poll, same rationale as the Claude Code adapter
      });
    }
  }

  // Older should-fix backlog: "full adapter-iterator cancellation needs an AbortSignal ...
  // iterator.return() is invoked now, but return() on an async generator suspended inside an
  // await is queued until it resumes, so a generator blocked on a socket read cannot be
  // cancelled at all." MEASURED, not assumed: a bare `while (true) { await X }` generator with
  // no `yield` between successive awaits genuinely never delivers a queued `.return()` at all —
  // it just keeps re-entering the next await forever, so `runtime/event-pump.js`'s
  // `cancelIterator()` (which only ever calls `.return()`) could hang indefinitely on exactly the
  // "nothing new is happening" idle-poll state this loop sits in most of the time. Wrapped so
  // `.return()` (the pump's ONLY cancellation call) is intercepted: mark cancelled AND wake the
  // wait immediately (same mechanism `_emitEvent` already uses), so the generator's OWN code runs
  // a genuine, synchronous `return;` on its very next tick — completing normally, which needs no
  // generator-protocol delivery of a queued external completion at all.
  const inner = realObserve();
  return {
    next: (...args) => inner.next(...args),
    return(value) {
      run._cancelled = true;
      const waiters = run._waiters;
      run._waiters = [];
      for (const w of waiters) w();
      return inner.return(value);
    },
    throw: (err) => inner.throw(err),
    [Symbol.asyncIterator]() { return this; },
  };
}

function mapEvent(evt, props) {
  switch (evt.type) {
    case 'server.connected':
    case 'server.heartbeat':
    case 'server.instance.disposed':
      return null; // broadcast-worthy for liveness only; not a turn-relevant event
    case 'message.part.delta':
      if (props.field === 'text') {
        return { type: 'assistant.delta', text: props.delta, partID: props.partID, messageID: props.messageID };
      }
      return null;
    case 'message.part.updated': {
      const part = props.part ?? {};
      // ADDED for supervisor-integration spike (item 4, token telemetry):
      // the one-shot CLI (`opencode run --format json`) was already proven
      // (OPENCODE_ADAPTER_SPIKE.md) to emit a `step_finish` part carrying
      // `tokens: {input, output, cache: {read, write}}` + `cost`. That part
      // type is also present over serve's SSE stream (same underlying
      // message-part model) — checked live for this spike, see FINDINGS.md
      // in supervisor-integration/. Mapped to a `usage` event, new event
      // type, does not change any existing mapping.
      if ((part.type === 'step-finish' || part.type === 'step_finish') && part.tokens) {
        return {
          type: 'usage',
          tokensIn: part.tokens.input ?? null,
          tokensOut: part.tokens.output ?? null,
          cachedTokens: part.tokens.cache?.read ?? null,
          cacheWriteTokens: part.tokens.cache?.write ?? null,
          costUsd: part.cost ?? null,
        };
      }
      if (part.type === 'tool') {
        const status = part.state?.status;
        if (status === 'running' || status === 'pending') {
          return { type: 'tool.start', tool: part.tool, callID: part.callID, input: part.state?.input };
        }
        if (status === 'completed' || status === 'error') {
          return {
            type: 'tool.result',
            tool: part.tool,
            callID: part.callID,
            output: part.state?.output,
            error: status === 'error' ? part.state?.error : undefined,
          };
        }
      }
      return null;
    }
    case 'permission.asked':
      return {
        type: 'approval.request',
        approvalID: props.id,
        permission: props.permission, // e.g. "bash"
        patterns: props.patterns,
        metadata: props.metadata,
        tool: props.tool,
      };
    case 'session.idle': {
      // Finding B4: normalize turn.end to carry `status` as the required,
      // source-of-truth field (matching the Claude Code adapter), plus a
      // derived `isError` boolean for backward compatibility with any
      // consumer still reading that field directly.
      return { type: 'turn.end', status: 'completed', isError: false };
    }
    case 'session.error': {
      const status = props.error?.name === 'MessageAbortedError' ? 'aborted' : 'error';
      return { type: 'turn.end', status, isError: status === 'error', error: props.error };
    }
    default:
      return null;
  }
}

/**
 * interrupt(runId) -> void
 *
 * PROVEN clean: POST /session/{id}/abort while a turn is streaming produces a
 * `session.error` SSE event with name "MessageAbortedError", followed by
 * session.idle — the server process itself keeps running (FINDINGS.md #4).
 * This is the ONLY reliable interrupt path found; sending SIGINT to a CLI
 * `opencode run` process does NOT cancel the turn (it's swallowed and the
 * turn completes anyway) and SIGTERM kills it with zero output.
 */
export async function interrupt(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error(`unknown runId: ${runId}`);
  const res = await fetch(`${run.baseUrl}/session/${run.sessionID}/abort`, { method: 'POST' });
  if (!res.ok) throw new Error(`interrupt failed: ${res.status} ${await res.text()}`);
  run.status = 'aborted';
}

/**
 * clearContext(runId) -> ack
 *
 * PARTIAL / documented, not "clear" in the Claude Code sense: OpenCode has no
 * operation that wipes conversation history while keeping the same session
 * id. The closest real operation is POST /session/{id}/summarize, which
 * COMPACTS history into a summary message that is then used as context going
 * forward — it does not delete the underlying messages (they're still listed
 * via GET /session/{id}/message) and does not reset cost/token counters.
 * PROVEN: called successfully against a real session that had an aborted turn
 * plus a follow-up turn in it; server returned `true` and added a compaction
 * message (FINDINGS.md #5).
 *
 * Finding M7 (prep only): same signature shape as the Claude Code adapter's
 * clearContext — takes `runId`, returns an ack object synchronously-shaped
 * (albeit via a Promise, since this adapter's calls are all async) — ready
 * for the supervisor to route to uniformly across both adapters.
 */
export async function clearContext(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error(`unknown runId: ${runId}`);
  const res = await fetch(`${run.baseUrl}/session/${run.sessionID}/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerID: run.modelSel.providerID, modelID: run.modelSel.modelID }),
  });
  if (!res.ok) throw new Error(`clearContext failed: ${res.status} ${await res.text()}`);
  return { ack: true, semantics: 'compacted-not-erased' };
}

/**
 * resume(runId) -> runId | 'unsupported'
 *
 * PROVEN via the CLI (`opencode run --session <id>` recalled a fact from an
 * earlier, separate `opencode run` invocation — FINDINGS.md #3). In this
 * server-resident adapter, the session already persists on the server for as
 * long as the server process is alive, so "resume" is a no-op: the same runId
 * is still valid. If the server process for that cwd has been stopped, a new
 * server can be started and the same sessionID re-attached (OpenCode persists
 * sessions to ~/.local/share/opencode, independent of which serve process
 * opened them) — NOT exercised end-to-end here, so treat that path as
 * BEST-EFFORT.
 *
 * Finding M7 (prep only): same `runId -> runId | 'unsupported'` signature as
 * the Claude Code adapter's resume, ready for uniform supervisor routing.
 */
export async function resume(runId) {
  if (runs.has(runId)) return runId;
  return 'unsupported';
}

/**
 * stop(runId) -> void
 *
 * Aborts any in-flight turn and removes the run from the local map. Does NOT
 * kill the underlying `opencode serve` process (other runs may share it) —
 * call disposeServer(cwd) separately for full teardown, e.g. at process exit.
 */
export async function stop(runId) {
  const run = runs.get(runId);
  if (!run) return;
  try {
    await fetch(`${run.baseUrl}/session/${run.sessionID}/abort`, { method: 'POST' });
  } catch {
    /* best effort */
  }
  runs.delete(runId);
}

/**
 * discardSession(runId) -> delete this run's session from the HARNESS's own store.
 *
 * PLAN.md 12.1's "ask the harness to drop its own session record". OpenCode has no equivalent of
 * Claude Code's `--no-session-persistence`, so the session is always written and the only option
 * is to delete it afterwards. `DELETE /session/{sessionID}` is the real route (verified against
 * the server's own OpenAPI document, not assumed).
 *
 * IT DELETES BY THE ID IT CREATED, AND NOTHING ELSE. This is the load-bearing constraint, and it
 * comes from a measurement rather than from caution: **OpenCode's session store is GLOBAL, not
 * per-directory** — `GET /session` on a server started in a fresh empty directory returns sessions
 * belonging to entirely different projects. So any cleanup that enumerated sessions to decide what
 * to remove would be reading, and could delete, another project's history. There is deliberately
 * no "delete the preflight sessions" bulk form of this function.
 *
 * Resolves with an outcome rather than throwing: this is cleanup, and a preflight's VERDICT must
 * not be lost because tidying up after it failed. A failure that is recorded can be retried; a
 * throw here would propagate into the check's result and turn "the model is reachable" into an
 * error.
 */
export async function discardSession(runId, { timeoutMs = 5000 } = {}) {
  const run = runs.get(runId);
  // A stopped run is already out of `runs`, so fall back to parsing the runId — which encodes
  // `${baseUrl}::${sessionID}` — rather than refusing. Cleanup is frequently the step AFTER stop.
  const baseUrl = run?.baseUrl ?? runId.split('::')[0];
  const sessionID = run?.sessionID ?? runId.split('::')[1];
  if (!baseUrl || !sessionID) return { discarded: false, reason: `cannot derive session from runId ${runId}` };
  // `entry.sessionsKnown` is `verifyRunIdentity()`'s FALLBACK signal for exactly the moment the
  // real server can't be reached — looked up by cwd normally, but a stopped run is already out of
  // `runs`, so fall back to matching by baseUrl (the one thing still recoverable from the runId).
  const entry = run ? serverPool.get(run.cwd) : [...serverPool.values()].find((e) => e.baseUrl === baseUrl);
  try {
    const res = await fetch(`${baseUrl}/session/${sessionID}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // A 404 means it is already gone, which is the desired end state rather than a failure.
    if (res.ok || res.status === 404) {
      // Older should-fix backlog: "verifyRunIdentity()'s HTTP-unavailable fallback can
      // false-positive sessionKnown:true." `sessionsKnown` used to be add-only — nothing here ever
      // removed an entry once discarded, so a LATER identity check landing during a transient HTTP
      // outage would fall back to this stale local cache and report a genuinely-deleted session as
      // still known. Removed the instant the real server confirms it's gone (or was already gone).
      entry?.sessionsKnown.delete(sessionID);
      return { discarded: true, sessionID, status: res.status };
    }
    return { discarded: false, sessionID, reason: `DELETE /session/${sessionID} -> ${res.status}` };
  } catch (err) {
    return { discarded: false, sessionID, reason: String(err?.message ?? err) };
  }
}

/**
 * disposeServer(cwd) -> Promise<{ disposed: boolean, killed?: boolean, escalated?: boolean }>
 *
 * Group 5: this now kills the server's whole PROCESS GROUP with a SIGTERM -> SIGKILL
 * escalation, not `proc.kill()` on the leader alone. Two reasons the old form was not
 * enough for deterministic teardown:
 *   - `proc.kill()` sends SIGTERM once and returns immediately; nothing ever confirmed
 *     the process actually died, so teardown "succeeded" whether or not the server was
 *     still listening. That is exactly how an `orphaned-unmanaged` server survives a
 *     supervisor restart.
 *   - `serve` may have spawned children of its own (tool subprocesses, MCP servers).
 *     Killing only the leader leaves those reparented to init, unmanaged forever.
 */
export async function disposeServer(cwd, { graceMs = 2000 } = {}) {
  const entry = serverPool.get(cwd);
  if (!entry) return { disposed: false, reason: 'no pooled server for that cwd' };
  // Remove from the pool FIRST: a concurrent start() must not be handed a server that
  // is already being killed.
  serverPool.delete(cwd);
  entry.sseAbort.abort();

  const pgid = entry.verifiedPgid;
  if (Number.isInteger(pgid) && pgid > 1) {
    const result = await killProcessGroup(pgid, { graceMs });
    return { disposed: true, ...result };
  }
  // Identity never verified (server died before `ps` could see it, or the spawn
  // failed) -- the bare pid is all we can honestly reach.
  try { entry.proc.kill('SIGKILL'); } catch { /* already gone */ }
  return { disposed: true, killed: true, escalated: false, note: 'no verified pgid; killed leader pid only' };
}

export async function disposeAll(opts = {}) {
  const results = {};
  for (const cwd of [...serverPool.keys()]) {
    results[cwd] = await disposeServer(cwd, opts);
  }
  return results;
}

/**
 * processIdentity(runId) -> Promise<identity>
 *
 * The uniform Group 5 surface both adapters implement. `ownership: 'shared-server'` is
 * the load-bearing part: finding S4 means the pid/pgid/lstart returned here belong to a
 * pooled `opencode serve` shared by every run in the same cwd. A `reap` that killed this
 * group to end one run would kill every sibling run with it -- so reap must refuse the
 * group kill while other runs share the server, and abort the session instead.
 */
export async function processIdentity(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error(`Unknown runId: ${runId}`);
  const entry = serverPool.get(run.cwd);
  if (!entry) return { verified: false, reason: 'no pooled server for this run', ownership: 'shared-server' };
  const info = await entry.identity;
  return {
    ...info,
    cwd: run.cwd,
    spawnDepth: entry.spawnDepth ?? null,
    ownership: 'shared-server',
    harnessSessionId: run.sessionID,
    // How many runs this adapter currently believes share the group.
    sharedRunCount: [...runs.values()].filter((r) => r.cwd === run.cwd).length,
  };
}

/** Every runId this adapter still holds a handle for. Reconciliation's "is it still ours" input. */
export function listRuns() {
  return [...runs.keys()];
}

/**
 * getRunProcessInfo(runId) -> { pid, cwd, baseUrl, sessionID } | null
 *
 * Kept from the spike for backward compatibility; now also exposes
 * `sessionID` explicitly since `pid` alone (finding S4) is shared by every
 * run on the same server and can no longer be treated as a run identifier
 * on its own. Prefer verifyRunIdentity() for anything that needs to know
 * whether a specific run is still alive.
 */
export function getRunProcessInfo(runId) {
  const run = runs.get(runId);
  if (!run) return null;
  const entry = serverPool.get(run.cwd);
  if (!entry) return null;
  return { pid: entry.proc.pid, cwd: run.cwd, baseUrl: entry.baseUrl, sessionID: run.sessionID };
}

/**
 * verifyRunIdentity(runId) -> Promise<{ serverAlive: boolean, sessionKnown: boolean }>
 *
 * Finding S4: `opencode serve` is pooled per-cwd and multiplexes many
 * sessions through a single OS process, so every run sharing that server
 * persists the same pid/pgid/lstart and reconciliation cannot tell them
 * apart using process identity alone. This exposes the two-level check the
 * supervisor's future reconciliation code needs to call independently:
 *
 *   - serverAlive: the OS process behind this run's server is still alive
 *     (liveness at the process level — same kind of check the Claude Code
 *     adapter and the supervisor's pid/pgid/lstart verification already do).
 *   - sessionKnown: the server ITSELF still recognizes this specific
 *     session, via `GET /session/{id}` (falls back to the pool's own
 *     `sessionsKnown` set if the server is unreachable, but that is a
 *     weaker, adapter-local signal — the HTTP check is source of truth
 *     whenever the server responds at all).
 *
 * A run is only genuinely alive-and-ours when BOTH are true. serverAlive
 * true + sessionKnown false is exactly the "server survived, but doesn't
 * know about this run anymore" case PLAN.md's `orphaned-unmanaged` state
 * needs to be able to express for OpenCode.
 */
export async function verifyRunIdentity(runId) {
  const run = runs.get(runId);
  if (!run) return { serverAlive: false, sessionKnown: false };
  const entry = serverPool.get(run.cwd);
  const serverAlive = !!entry && entry.proc.exitCode === null && !entry.proc.killed;
  if (!serverAlive) return { serverAlive: false, sessionKnown: false };

  try {
    const res = await fetch(`${run.baseUrl}/session/${run.sessionID}`);
    if (res.status === 404) return { serverAlive: true, sessionKnown: false };
    if (!res.ok) return { serverAlive: true, sessionKnown: entry.sessionsKnown.has(run.sessionID) };
    return { serverAlive: true, sessionKnown: true };
  } catch {
    // Server process is alive but not answering HTTP right now — fall back
    // to the adapter-local record rather than claiming certainty we don't have.
    return { serverAlive: true, sessionKnown: entry.sessionsKnown.has(run.sessionID) };
  }
}

/** Diagnostics helper (finding S6): read back a server's bounded stderr ring. */
export function getServerStderr(cwd) {
  const entry = serverPool.get(cwd);
  return entry ? entry.stderrRing.toString() : null;
}

export function _getRunForTest(runId) {
  return runs.get(runId);
}
