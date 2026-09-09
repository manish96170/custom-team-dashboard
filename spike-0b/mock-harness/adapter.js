'use strict';

/**
 * mock-harness/adapter.js
 *
 * A canned event-stream replay adapter implementing the same interface every
 * real harness adapter (Claude Code, OpenCode) must implement, per PLAN.md
 * section 4:
 *
 *   start(spec) -> runId
 *   sendInput(runId, input) -> void
 *   observe(runId) -> AsyncIterable<Event>
 *   interrupt(runId) -> void
 *   clearContext(runId) -> ack
 *   resume(runId) -> runId | unsupported
 *   stop(runId) -> void
 *
 * plus the approval-response method the interface implies but doesn't name:
 *
 *   answerApproval(runId, approvalId, decision) -> void
 *
 * This never shells out to a real CLI. It exists so the Phase 4 TUI can be
 * built and iterated on deterministically and for free. See README.md for
 * the "this is deliberately more capable than a real harness" caveat.
 */

const { randomUUID } = require('crypto');

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) seeded from the prompt text, so the same
// prompt always produces the same canned event sequence. A caller can also
// pass an explicit numeric spec.seed to override.
// ---------------------------------------------------------------------------
function seedFromString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Canned content library — sliced up deterministically per-run so different
// runs don't all say byte-for-byte the same thing, but every run is a
// coherent short message + a tool call + optionally an approval + turn.end.
// ---------------------------------------------------------------------------
const MESSAGE_TEMPLATES = [
  "Looking at the request, I'll start by reading the relevant file to " +
    'understand the current implementation before making any changes.',
  "This looks like a small, well-scoped change. Let me check the existing " +
    'code first so the edit fits the surrounding style.',
  "I'll trace through the call sites first, then make the edit in a way " +
    "that doesn't disturb the existing tests.",
  'Before touching anything, let me confirm the current behavior by ' +
    'reading the file end to end.',
];

const TOOL_CALLS = [
  { tool: 'Read', argsTemplate: (cwd) => ({ file_path: `${cwd}/src/index.js` }) },
  { tool: 'Edit', argsTemplate: (cwd) => ({ file_path: `${cwd}/src/index.js`, old_string: 'foo', new_string: 'bar' }) },
  { tool: 'Bash', argsTemplate: () => ({ command: 'npm test' }) },
];

const APPROVAL_QUESTIONS = [
  { question: 'Allow running `rm -rf dist/` to clean the build output?', kind: 'bash-command' },
  { question: 'Allow writing to file outside the project root?', kind: 'file-write' },
  { question: 'Allow this edit to a file matching a protected glob (**/*.env)?', kind: 'file-write' },
];

function chunkWords(text, chunkSize, rand) {
  const words = text.split(' ');
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    // vary chunk size a little so deltas don't look robotically uniform
    const size = Math.max(1, chunkSize + Math.floor((rand() - 0.5) * 2));
    chunks.push(words.slice(i, i + size).join(' ') + (i + size < words.length ? ' ' : ''));
    i += size;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Internal per-run state
// ---------------------------------------------------------------------------
class RunState {
  constructor(runId, spec, rand) {
    this.runId = runId;
    this.spec = spec;
    this.rand = rand;
    this.status = 'pending'; // pending | running | interrupted | stopped | done
    this.history = []; // "conversation so far" — cleared by clearContext
    this.subscribers = new Set(); // { push(event), close() }
    this.timers = new Set();
    this.pendingApprovals = new Map(); // approvalId -> resolver
    this.turn = 0;
    this.seq = 0;
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

class MockHarnessAdapter {
  /**
   * @param {object} opts
   * @param {number} [opts.deltaDelayMs=[50,150]] range for assistant.delta pacing
   * @param {number} [opts.approvalChance=0.3] probability [0,1] a run includes an approval.request
   */
  constructor(opts = {}) {
    this.deltaDelayRange = opts.deltaDelayRange || [50, 150];
    this.approvalChance = opts.approvalChance ?? 0.3;
    this.runs = new Map(); // runId -> RunState
  }

  // -- adapter interface -----------------------------------------------

  start(spec) {
    if (!spec || typeof spec.prompt !== 'string') {
      throw new TypeError('start(spec): spec.prompt (string) is required');
    }
    const runId = `mock-run-${randomUUID()}`;
    const seed = typeof spec.seed === 'number' ? spec.seed : seedFromString(spec.prompt);
    const rand = mulberry32(seed);
    const state = new RunState(runId, spec, rand);
    state.status = 'running';
    this.runs.set(runId, state);
    state.history.push({ role: 'user', content: spec.prompt });

    this._scheduleTurn(state);
    return runId;
  }

  sendInput(runId, input) {
    const state = this._require(runId);
    if (state.status !== 'running') {
      throw new Error(`sendInput: run ${runId} is not running (status=${state.status})`);
    }
    state.history.push({ role: 'user', content: input });
    // A fresh turn starting from new input — same deterministic scheduling,
    // but seeded off the input text plus turn count so distinct inputs
    // produce distinct (but still deterministic) canned turns.
    const seed = seedFromString(String(input) + ':' + state.turn);
    state.rand = mulberry32(seed);
    this._scheduleTurn(state);
  }

  observe(runId) {
    const state = this._require(runId);
    const queue = [];
    let resolveNext = null;
    let closed = false;

    const subscriber = {
      push(event) {
        if (closed) return;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: event, done: false });
        } else {
          queue.push(event);
        }
      },
      close() {
        closed = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: undefined, done: true });
        }
      },
    };
    state.subscribers.add(subscriber);

    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift(), done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => {
              resolveNext = resolve;
            });
          },
          return() {
            state.subscribers.delete(subscriber);
            closed = true;
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  interrupt(runId) {
    const state = this._require(runId);
    if (state.status !== 'running') return; // no-op on non-running runs
    state.clearTimers();
    state.status = 'interrupted';
    this._emit(state, {
      type: 'run.interrupted',
      runId,
      seq: state.seq++,
      ts: Date.now(),
      reason: 'interrupt() called',
    });
  }

  clearContext(runId) {
    const state = this._require(runId);
    state.history = [];
    state.turn = 0;
    return { ok: true, runId, clearedAt: Date.now() };
  }

  /**
   * NOTE (intentional divergence from real harnesses): the mock always
   * supports resume, returning a *new* runId that carries forward the
   * cleared/uncleared history of the original run. Real Claude Code and
   * OpenCode adapters may not both support this — Phase 0b's job is to
   * prove what each one actually does. This mock is deliberately built to
   * the ideal case (full resumability) precisely so the TUI can be
   * developed against that ideal and degrade gracefully once the real
   * capability matrix (harnesses.capabilities_json, PLAN.md section 3/9)
   * comes back from the real spikes. Do not treat this as a claim about
   * real harness behavior.
   */
  resume(runId) {
    const state = this._require(runId);
    const newRunId = `mock-run-${randomUUID()}`;
    const newState = new RunState(newRunId, state.spec, mulberry32(seedFromString(runId + ':resume')));
    newState.status = 'running';
    newState.history = state.history.slice();
    this.runs.set(newRunId, newState);
    this._scheduleTurn(newState);
    return newRunId;
  }

  stop(runId) {
    const state = this._require(runId);
    state.clearTimers();
    state.status = 'stopped';
    this._emit(state, {
      type: 'run.stopped',
      runId,
      seq: state.seq++,
      ts: Date.now(),
    });
    for (const sub of state.subscribers) sub.close();
    state.subscribers.clear();
  }

  answerApproval(runId, approvalId, decision) {
    const state = this._require(runId);
    const resolver = state.pendingApprovals.get(approvalId);
    if (!resolver) {
      throw new Error(`answerApproval: no pending approval ${approvalId} on run ${runId}`);
    }
    state.pendingApprovals.delete(approvalId);
    resolver(decision);
  }

  // -- internals ---------------------------------------------------------

  _require(runId) {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`unknown runId: ${runId}`);
    return state;
  }

  _emit(state, event) {
    for (const sub of state.subscribers) sub.push(event);
  }

  _delay(state, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        state.timers.delete(t);
        resolve();
      }, ms);
      state.timers.add(t);
    });
  }

  _randDelay(state) {
    const [lo, hi] = this.deltaDelayRange;
    return Math.floor(lo + state.rand() * (hi - lo));
  }

  async _scheduleTurn(state) {
    const runId = state.runId;
    state.turn += 1;
    try {
      // --- assistant.delta stream ---
      const template = MESSAGE_TEMPLATES[Math.floor(state.rand() * MESSAGE_TEMPLATES.length)];
      const chunks = chunkWords(template, 4, state.rand);
      let acc = '';
      for (const chunk of chunks) {
        if (state.status !== 'running') return;
        await this._delay(state, this._randDelay(state));
        if (state.status !== 'running') return;
        acc += chunk;
        this._emit(state, {
          type: 'assistant.delta',
          runId,
          seq: state.seq++,
          ts: Date.now(),
          text: chunk,
          accumulated: acc,
        });
      }
      state.history.push({ role: 'assistant', content: acc });

      // --- tool.start / tool.result ---
      if (state.status !== 'running') return;
      await this._delay(state, this._randDelay(state));
      if (state.status !== 'running') return;

      const toolDef = TOOL_CALLS[Math.floor(state.rand() * TOOL_CALLS.length)];
      const toolCallId = `tool-${randomUUID()}`;
      const cwd = state.spec.cwd || process.cwd();
      const args = toolDef.argsTemplate(cwd);
      this._emit(state, {
        type: 'tool.start',
        runId,
        seq: state.seq++,
        ts: Date.now(),
        toolCallId,
        tool: toolDef.tool,
        args,
      });

      await this._delay(state, this._randDelay(state));
      if (state.status !== 'running') return;

      this._emit(state, {
        type: 'tool.result',
        runId,
        seq: state.seq++,
        ts: Date.now(),
        toolCallId,
        tool: toolDef.tool,
        result: { ok: true, summary: `${toolDef.tool} completed on ${args.file_path || args.command}` },
      });

      // --- occasional approval.request ---
      if (state.status !== 'running') return;
      const wantsApproval =
        state.spec.forceApproval === true ||
        (state.spec.forceApproval !== false && state.rand() < this.approvalChance);

      if (wantsApproval) {
        await this._delay(state, this._randDelay(state));
        if (state.status !== 'running') return;

        const approvalDef = APPROVAL_QUESTIONS[Math.floor(state.rand() * APPROVAL_QUESTIONS.length)];
        const approvalId = `approval-${randomUUID()}`;

        const decisionPromise = new Promise((resolve) => {
          state.pendingApprovals.set(approvalId, resolve);
        });

        this._emit(state, {
          type: 'approval.request',
          runId,
          seq: state.seq++,
          ts: Date.now(),
          approvalId,
          kind: approvalDef.kind,
          question: approvalDef.question,
        });

        // Block this run's turn until answerApproval() is called. Real
        // harnesses would do the same — the caller must respond before
        // the run can proceed to turn.end.
        const decision = await decisionPromise;
        if (state.status !== 'running') return;

        this._emit(state, {
          type: 'approval.resolved',
          runId,
          seq: state.seq++,
          ts: Date.now(),
          approvalId,
          decision,
        });
      }

      // --- turn.end ---
      if (state.status !== 'running') return;
      this._emit(state, {
        type: 'turn.end',
        runId,
        seq: state.seq++,
        ts: Date.now(),
        turn: state.turn,
      });
    } catch (err) {
      this._emit(state, {
        type: 'run.error',
        runId,
        seq: state.seq++,
        ts: Date.now(),
        message: err && err.message ? err.message : String(err),
      });
    }
  }
}

module.exports = { MockHarnessAdapter };
