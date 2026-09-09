// STATUS (Group 5): superseded in production. The real adapters are registered by
// ipc/daemon.js and routed by supervisor/runtime/supervisor.js. This module survives only
// as server.js's DEFAULT, so ipc/test/ can exercise wire behavior with no harness
// installed; runtime/test/_fake-harness-adapter.js is what the supervisor's own tests use,
// because it spawns a real process and this does not. A test fixture now, not a placeholder.
//
// mock-adapter.js — a small deterministic in-memory stand-in for the real
// per-harness adapter contract from PLAN.md section 4
// (start/sendInput/observe/interrupt/clearContext/resume/stop). This is a
// STUB, not the real claude-code-adapter or opencode-adapter (those live
// under spike-0b/ today and are Group 4's lane, not this one's).
//
// Its only job is to give the ipc/ socket layer something real to dispatch
// against so the adversarial tests in test/ exercise genuine async event
// delivery over the wire (not a hand-wavy fake), while making zero claims
// about matching either real harness's actual behavior — see the mock's own
// events (`turn.start`, `assistant.delta`, `turn.end`) as illustrative only.

import { randomUUID } from "node:crypto";

export function createMockAdapter() {
  const runs = new Map(); // runId -> { events: [], listeners: Set<fn>, done: boolean, timers: Set }

  function emit(runId, evt) {
    const run = runs.get(runId);
    if (!run) return;
    run.events.push(evt);
    for (const push of run.listeners) push(evt);
  }

  function schedule(runId, fn, ms) {
    const run = runs.get(runId);
    if (!run) return;
    const t = setTimeout(() => {
      run.timers.delete(t);
      fn();
    }, ms);
    run.timers.add(t);
  }

  async function start(spec = {}) {
    const runId = `run_${randomUUID().slice(0, 8)}`;
    runs.set(runId, { events: [], listeners: new Set(), done: false, timers: new Set(), spec });
    schedule(runId, () => emit(runId, { type: "turn.start", ts: Date.now() }), 15);
    schedule(runId, () => emit(runId, { type: "assistant.delta", text: "hello", ts: Date.now() }), 45);
    schedule(runId, () => {
      emit(runId, { type: "turn.end", status: "ok", ts: Date.now() });
      const run = runs.get(runId);
      if (run) {
        run.done = true;
        for (const push of run.listeners) push(null); // sentinel: stream ended
      }
    }, 90);
    return runId;
  }

  async function sendInput(runId, input) {
    const run = runs.get(runId);
    if (!run) throw new Error(`unknown runId: ${runId}`);
    schedule(runId, () => emit(runId, { type: "assistant.delta", text: `echo:${input}`, ts: Date.now() }), 15);
  }

  async function interrupt(runId) {
    const run = runs.get(runId);
    if (!run) throw new Error(`unknown runId: ${runId}`);
    emit(runId, { type: "turn.end", status: "interrupted", ts: Date.now() });
    run.done = true;
    for (const push of run.listeners) push(null);
  }

  async function stop(runId) {
    const run = runs.get(runId);
    if (!run) return;
    for (const t of run.timers) clearTimeout(t);
    run.done = true;
    for (const push of run.listeners) push(null);
    runs.delete(runId);
  }

  async function clearContext(runId) {
    if (!runs.has(runId)) throw new Error(`unknown runId: ${runId}`);
    return { ok: true, note: "mock-adapter: no-op clear" };
  }

  /** Never resolves to a real new run — mock declares no resumableTurns support, matching a conservative capability declaration. */
  async function resume() {
    return "unsupported";
  }

  /** Runs forever (never emits turn.end) — for teardown tests that need a genuinely long-lived observe subscription. */
  async function startLongLived() {
    const runId = `run_${randomUUID().slice(0, 8)}`;
    runs.set(runId, { events: [], listeners: new Set(), done: false, timers: new Set(), spec: {} });
    return runId;
  }

  async function* observe(runId) {
    const run = runs.get(runId);
    if (!run) throw new Error(`unknown runId: ${runId}`);
    for (const evt of run.events) yield evt;
    if (run.done) return;

    const queue = [];
    let wake = null;
    const push = (evt) => {
      queue.push(evt);
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };
    run.listeners.add(push);
    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
        while (queue.length) {
          const evt = queue.shift();
          if (evt === null) return;
          yield evt;
        }
      }
    } finally {
      run.listeners.delete(push);
    }
  }

  return { start, startLongLived, sendInput, interrupt, stop, clearContext, resume, observe, _runs: runs };
}
