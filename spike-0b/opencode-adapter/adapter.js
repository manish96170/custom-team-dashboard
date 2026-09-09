// OpenCode spawn adapter — Phase 0b spike
//
// PROVEN ARCHITECTURE: the adapter interface (start/sendInput/observe/interrupt/
// clearContext/resume/stop) requires a RESIDENT, addressable process that can be
// told to abort mid-turn and answer permission questions from code. OpenCode's
// one-shot CLI (`opencode run`) cannot do this (see FINDINGS.md #4) — SIGINT is
// swallowed and the turn runs to completion anyway; SIGTERM kills the process
// hard with zero output. Only `opencode serve` (a headless HTTP+SSE server)
// supports true interrupt and true incremental streaming.
//
// So this adapter spawns one `opencode serve` process per unique `cwd` (that's
// how OpenCode gets its "project directory" — serve has no --dir flag; the
// directory is inherited from the OS-level cwd of the spawned process, proven
// in FINDINGS.md #6), talks to it over its local HTTP API, and multiplexes
// sessions (one opencode session = one logical "run") on top of it.
//
// Everything below is backed by an actually-run curl/node call captured in
// FINDINGS.md. Anything not exercised end-to-end is marked BEST-EFFORT.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const DEFAULT_MODEL = { providerID: 'amazon-bedrock', modelID: 'us.anthropic.claude-sonnet-5' };

// serverPool: cwd -> { proc, port, baseUrl, ready: Promise }
const serverPool = new Map();

// runs: runId -> { baseUrl, sessionID, cwd, status, lastError }
const runs = new Map();

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

async function getServer(cwd) {
  if (serverPool.has(cwd)) return serverPool.get(cwd);
  const port = 40000 + Math.floor(Math.random() * 10000);
  const proc = spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const entry = { proc, port, baseUrl };
  serverPool.set(cwd, entry);
  await waitForHealth(baseUrl);
  return entry;
}

/**
 * start(spec) -> runId
 * spec: { prompt, cwd, model?, effort? }
 *
 * PROVEN: session.create (POST /session) + session.prompt_async
 * (POST /session/{id}/prompt_async) both verified via curl (FINDINGS.md #1, #7).
 * The turn runs async on the server; observe() streams its progress.
 */
export async function start(spec) {
  const { prompt, cwd, model, effort } = spec;
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
      title: `spike-${randomUUID().slice(0, 8)}`,
      permission: [
        { permission: 'bash', pattern: '*', action: 'ask' },
        { permission: 'edit', pattern: '*', action: 'ask' },
      ],
    }),
  });
  if (!sessionRes.ok) throw new Error(`session.create failed: ${sessionRes.status} ${await sessionRes.text()}`);
  const session = await sessionRes.json();

  const runId = `${server.baseUrl}::${session.id}`;
  runs.set(runId, { baseUrl: server.baseUrl, sessionID: session.id, cwd, status: 'starting' });

  const promptBody = {
    parts: [{ type: 'text', text: prompt }],
    model: modelSel,
  };
  // effort maps to OpenCode's --variant / API `variant` field.
  // PROVEN the flag/field is accepted without error (FINDINGS.md #7); NOT proven
  // that it changes actual model behavior (no observable signal from the model
  // confirming which variant it ran with) — BEST-EFFORT pass-through.
  if (effort) promptBody.variant = effort;

  const run = runs.get(runId);
  run.status = 'running';
  // fire-and-forget; prompt_async returns immediately, turn progress via SSE.
  fetch(`${server.baseUrl}/session/${session.id}/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(promptBody),
  }).catch((err) => {
    run.status = 'errored';
    run.lastError = err;
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
 */
export async function sendInput(runId, input) {
  const run = runs.get(runId);
  if (!run) throw new Error(`unknown runId: ${runId}`);
  run.status = 'running';
  const res = await fetch(`${run.baseUrl}/session/${run.sessionID}/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: input }], model: DEFAULT_MODEL }),
  });
  if (!res.ok) throw new Error(`sendInput failed: ${res.status} ${await res.text()}`);
}

/**
 * observe(runId) -> AsyncIterable<Event>
 *
 * PROVEN: connects to the server's SSE endpoint (GET /event) and has actually
 * been observed emitting, for a real Bedrock-backed turn:
 *   message.part.delta      -> assistant.delta   (real per-token deltas, not
 *                                                  just a final blob — FINDINGS.md #2)
 *   message.part.updated (tool part, state=running) -> tool.start
 *   message.part.updated (tool part, state=completed/error) -> tool.result
 *   permission.asked       -> approval.request   (FINDINGS.md #9)
 *   session.idle / step-finish -> turn.end
 *   session.error           -> turn.end (status: 'error' | 'aborted')
 *
 * The SSE stream is server-wide (all sessions on this serve instance), so this
 * filters by sessionID.
 */
export async function* observe(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error(`unknown runId: ${runId}`);

  const res = await fetch(`${run.baseUrl}/event`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
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
        const props = evt.properties ?? {};
        if (props.sessionID && props.sessionID !== run.sessionID) continue;

        const mapped = mapEvent(evt, props);
        if (mapped) {
          if (mapped.type === 'turn.end') run.status = mapped.status === 'error' ? 'errored' : 'completed';
          yield mapped;
          if (mapped.type === 'turn.end') return;
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function mapEvent(evt, props) {
  switch (evt.type) {
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
    case 'session.idle':
      return { type: 'turn.end', status: 'completed' };
    case 'session.error':
      return {
        type: 'turn.end',
        status: props.error?.name === 'MessageAbortedError' ? 'aborted' : 'error',
        error: props.error,
      };
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
 */
export async function clearContext(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error(`unknown runId: ${runId}`);
  const res = await fetch(`${run.baseUrl}/session/${run.sessionID}/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerID: DEFAULT_MODEL.providerID, modelID: DEFAULT_MODEL.modelID }),
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

/** Test/teardown helper — not part of the adapter interface. */
export async function disposeServer(cwd) {
  const entry = serverPool.get(cwd);
  if (!entry) return;
  entry.proc.kill();
  serverPool.delete(cwd);
}

export async function disposeAll() {
  for (const cwd of [...serverPool.keys()]) {
    await disposeServer(cwd);
  }
}

/**
 * getRunProcessInfo(runId) -> { pid, cwd, baseUrl } | null
 *
 * ADDED for supervisor-integration spike (item 3, restart reconciliation):
 * the adapter never exposed the underlying `opencode serve` process's PID,
 * because nothing needed it before now — every prior spike drove the
 * adapter and the process from the same long-lived script, so process
 * identity was implicit. A supervisor that must persist run state to disk
 * and re-verify it after a restart needs an explicit PID, the same way the
 * Claude Code adapter already exposes `run.child` via `_getRunForTest`.
 * This is a pure addition (new export, no existing export's behavior
 * changed) so it does not affect anyone using this adapter standalone.
 */
export function getRunProcessInfo(runId) {
  const run = runs.get(runId);
  if (!run) return null;
  const entry = serverPool.get(run.cwd);
  if (!entry) return null;
  return { pid: entry.proc.pid, cwd: run.cwd, baseUrl: entry.baseUrl };
}
