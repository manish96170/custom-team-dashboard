// event-pump.js — ONE supervisor-owned event consumer per run, independent of whether
// any client is subscribed (TODO.md Group 5).
//
// The bug this replaces: ipc/server.js's `observe` handler was itself the only consumer.
// It called `adapter.observe(runId)` from inside a client's socket handler and persisted
// events from that loop. Three consequences, all real:
//
//   1. Nothing was persisted unless a human happened to be watching. A run started and
//      completed with no client attached wrote zero rows to `event_log`, so status and
//      token telemetry -- which PLAN.md says are *derived*, never asserted -- had nothing
//      to derive from.
//   2. Two clients observing one run meant two independent adapter consumers, each
//      persisting the same event again. (The Claude Code adapter makes this worse: its
//      observe() shares ONE read cursor across calls, so two concurrent consumers split
//      the stream between them rather than each seeing all of it.)
//   3. A disconnecting client tore down the only consumer, so events emitted after the
//      disconnect were lost outright rather than buffered for the next subscriber.
//
// So: the pump attaches to a run's adapter stream at start() time and keeps consuming
// until the stream ends, regardless of subscribers. Every event is persisted once, in
// arrival order, by the pump. Client `observe` connections are *fan-out* -- each gets its
// own cursor over the pump's buffer and can arrive late, leave early, or both, without
// affecting the run or each other.

/** Retained events per run. Bounded: a long run must not grow the supervisor's heap
 * without limit. Eviction is visible to subscribers (see the `gap` frame) rather than
 * silent -- a client that fell behind is told it missed events, and event_log on disk
 * remains the complete record either way. */
export const DEFAULT_BUFFER_LIMIT = 2000;

/** turn.end statuses the supervisor recognizes. Group 4 normalized this field; the
 * supervisor treats anything else as an error rather than as success (fail closed). */
const KNOWN_TURN_STATUSES = new Set(["completed", "error", "aborted"]);

export function createEventPump({ persistence, logger = console, bufferLimit = DEFAULT_BUFFER_LIMIT } = {}) {
  // Validated once, loudly, at construction. `append()`'s eviction arithmetic assumes a
  // non-negative integer: with `bufferLimit: -1` it computes `dropped = 1 - (-1) = 2`,
  // splices 1 element, and then advances `firstSeq` by 2 — every subscriber cursor after
  // that points at the wrong event. A fractional limit produces a fractional `firstSeq`.
  if (!Number.isInteger(bufferLimit) || bufferLimit < 1) {
    throw new TypeError(`createEventPump: bufferLimit must be a positive integer, got ${bufferLimit}`);
  }
  /** runId -> state */
  const runs = new Map();

  function stateOf(runId) {
    let state = runs.get(runId);
    if (!state) {
      state = {
        runId,
        buffer: [], // [{ seq, event }] — retained tail only
        firstSeq: 1, // seq of buffer[0]; > 1 once eviction has happened
        nextSeq: 1,
        evicted: 0,
        done: false,
        error: null,
        closed: false, // teardown: subscribers must stop, but `done` stays false (not a natural end)
        waiters: new Set(),
        subscriberCount: 0,
        // Derived, never asserted (PLAN.md section 4): recomputed from the event stream.
        derived: {
          lastEventType: null,
          turnCount: 0,
          terminalStatus: null,
          tokensIn: 0,
          tokensOut: 0,
          cachedTokens: 0,
          exitCode: undefined,
          exitSignal: undefined,
        },
      };
      runs.set(runId, state);
    }
    return state;
  }

  function wake(state) {
    for (const resolve of state.waiters) resolve();
    state.waiters.clear();
  }

  function append(state, event) {
    const seq = state.nextSeq++;
    state.buffer.push({ seq, event });
    if (state.buffer.length > bufferLimit) {
      const dropped = state.buffer.length - bufferLimit;
      state.buffer.splice(0, dropped);
      state.evicted += dropped;
      state.firstSeq += dropped;
    }
    return seq;
  }

  function updateDerived(state, event) {
    const d = state.derived;
    d.lastEventType = event?.type ?? null;
    if (event?.type === "turn.end") {
      d.turnCount += 1;
      // Fail closed: an unrecognized status is an error, not an optimistic success.
      d.terminalStatus = KNOWN_TURN_STATUSES.has(event.status) ? event.status : "error";
      d.tokensIn += Number(event.tokensIn) || 0;
      d.tokensOut += Number(event.tokensOut) || 0;
      d.cachedTokens += Number(event.cachedTokens) || 0;
    } else if (event?.type === "process.exit") {
      d.exitCode = event.code;
      d.exitSignal = event.signal;
    }
  }

  /**
   * Start the supervisor's own consumer for `runId`. Returns immediately; the consumer
   * runs as a detached async task for the life of the stream.
   *
   * `onEvent` / `onEnd` are supervisor-side hooks (status derivation, endRun bookkeeping)
   * -- deliberately not a client-facing mechanism. A throwing hook is logged and skipped:
   * the pump must not stop consuming a live run because a bookkeeping callback failed.
   */
  function attach(runId, source, { onEvent, onEnd } = {}) {
    const state = stateOf(runId);
    if (state.consumer) return state.consumer;

    // Keep the iterator, not just the iterable: `closeRun()` needs something to *cancel*.
    // Setting `state.closed` alone is only observed on the loop's next iteration, which
    // never comes if the adapter stream is blocked on a socket read or a hung child — the
    // consumer and everything the adapter holds open underneath it then leak.
    const iterator = typeof source?.[Symbol.asyncIterator] === "function" ? source[Symbol.asyncIterator]() : source;
    state.iterator = iterator;

    state.consumer = (async () => {
      try {
        for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
          if (state.closed) break;
          const seq = append(state, event);
          updateDerived(state, event);
          // Persist once, here, by the pump -- not once per subscriber.
          try {
            await persistence.recordEvent({ runId, tier: 1, type: event?.type ?? "unknown", payload: event });
          } catch (err) {
            // A failed write must not stop the consumer: losing the rest of a live run's
            // events is strictly worse than losing one row, and the client fan-out below
            // is unaffected either way.
            logger.warn?.(`[pump] recordEvent failed for run ${runId} (non-fatal): ${err.message}`);
          }
          try {
            await onEvent?.(event, seq);
          } catch (err) {
            logger.warn?.(`[pump] onEvent hook threw for run ${runId} (non-fatal): ${err.message}`);
          }
          wake(state);
        }
      } catch (err) {
        state.error = String(err?.message ?? err);
        logger.warn?.(`[pump] adapter stream for run ${runId} failed: ${state.error}`);
      } finally {
        state.done = true;
        state.iterator = null;
        wake(state);
        try {
          await onEnd?.({ runId, error: state.error, derived: { ...state.derived } });
        } catch (err) {
          logger.warn?.(`[pump] onEnd hook threw for run ${runId} (non-fatal): ${err.message}`);
        }
      }
    })();
    return state.consumer;
  }

  /**
   * Fan-out subscription with its OWN cursor. Yields frames:
   *   { seq, event }                      — an event
   *   { gap: n, fromSeq }                 — n events were evicted before this subscriber
   *                                         reached them; event_log on disk still has them
   * Returns (ends) when the run's stream has ended and the cursor has drained, when the
   * pump is closed, or when the caller breaks out of the loop / calls .return().
   *
   * `signal` cancels just this subscriber (used for client disconnect) without touching
   * the run or any other subscriber.
   */
  async function* subscribe(runId, { signal, fromSeq } = {}) {
    const state = stateOf(runId);
    state.subscriberCount += 1;
    let cursor = fromSeq ?? state.firstSeq;
    try {
      for (;;) {
        if (signal?.aborted) return;
        if (state.closed) return;

        if (cursor < state.firstSeq) {
          // This subscriber's cursor points at events already evicted. Say so instead of
          // silently skipping them.
          const gap = state.firstSeq - cursor;
          cursor = state.firstSeq;
          yield { gap, fromSeq: state.firstSeq };
        }

        while (cursor < state.nextSeq) {
          // Re-check eviction on every iteration, not just at the top of the outer loop.
          // `yield` below is a real suspension point: while a slow subscriber is parked
          // there, `append()` can evict past its cursor. Without this check the index
          // `cursor - state.firstSeq` goes negative, the lookup is `undefined`, and the
          // old `if (!frame) continue` silently walked the cursor forward to the retained
          // region — a hole the subscriber was never told about, which is precisely the
          // guarantee the header comment makes ("Eviction is visible to subscribers").
          // The outer loop's gap check cannot catch this: by the time the inner loop exits,
          // the cursor has already caught up to `firstSeq`.
          if (cursor < state.firstSeq) {
            const gap = state.firstSeq - cursor;
            cursor = state.firstSeq;
            yield { gap, fromSeq: state.firstSeq };
            if (signal?.aborted || state.closed) return;
            continue;
          }
          const frame = state.buffer[cursor - state.firstSeq];
          cursor += 1;
          if (!frame) continue; // nothing retained at this slot; the check above owns the gap
          yield frame;
          if (signal?.aborted || state.closed) return;
        }

        if (state.done) return;

        // Both wake paths must be unregistered afterwards: registering an abort listener
        // per loop iteration without removing it leaks one listener per event on a
        // long-lived subscription.
        let wakeThis;
        try {
          await new Promise((resolve) => {
            wakeThis = resolve;
            state.waiters.add(resolve);
            signal?.addEventListener("abort", resolve, { once: true });
          });
        } finally {
          state.waiters.delete(wakeThis);
          signal?.removeEventListener("abort", wakeThis);
        }
      }
    } finally {
      state.subscriberCount -= 1;
    }
  }

  /** Everything the supervisor derives from this run's stream. Never an asserted status. */
  function derived(runId) {
    const state = runs.get(runId);
    if (!state) return null;
    return {
      ...state.derived,
      done: state.done,
      error: state.error,
      eventsSeen: state.nextSeq - 1,
      eventsRetained: state.buffer.length,
      eventsEvicted: state.evicted,
      subscriberCount: state.subscriberCount,
    };
  }

  /** Stop fanning out for one run and release its buffer. Consumer task ends on its own
   * next iteration (it checks `closed`). Used by stop()/reap() and teardown. */
  function closeRun(runId) {
    const state = runs.get(runId);
    if (!state) return false;
    state.closed = true;
    wake(state);
    state.buffer = [];
    cancelIterator(state);
    return true;
  }

  /** Actively cancel the adapter stream. `iterator.return()` is the async-iterator
   * cancellation contract: it runs the generator's own `finally` blocks (closing sockets,
   * aborting fetches) and makes the parked `next()` settle, which is what lets a blocked
   * consumer finish instead of waiting on a stream nobody will read again. Errors are
   * swallowed: a source that refuses to be cancelled must not break teardown. */
  function cancelIterator(state) {
    const iterator = state.iterator;
    if (!iterator || typeof iterator.return !== "function") return;
    state.iterator = null;
    try {
      Promise.resolve(iterator.return()).catch(() => {});
    } catch {
      /* a synchronous throw from return() is not our problem during teardown */
    }
  }

  /**
   * Drop all pump state for a run so it can be attached again — the resume path.
   *
   * A resumed run is a NEW OS process feeding the SAME runId. `attach()` is a no-op once
   * `state.consumer` is set, so without this the new process's events are never consumed:
   * `event_log` stops growing, `derived()` keeps reporting the previous process's terminal
   * status, and `observe` shows a live run as finished. Sequence numbering restarts at 1
   * for the new generation, which is why the caller should bump `runs.generation`: seq is
   * only meaningful within a generation.
   */
  function resetRun(runId) {
    const state = runs.get(runId);
    if (!state) return false;
    state.closed = true;
    wake(state);
    cancelIterator(state);
    runs.delete(runId);
    return true;
  }

  async function closeAll({ timeoutMs = 2000 } = {}) {
    const consumers = [];
    for (const state of runs.values()) {
      state.closed = true;
      wake(state);
      cancelIterator(state);
      if (state.consumer) consumers.push(state.consumer);
    }
    // Bounded: a consumer blocked inside an adapter iterator that never yields again must
    // not be able to hold teardown open (review finding S11's whole point). The timer is
    // cleared when the race settles — an abandoned `setTimeout` keeps the event loop alive
    // for its full duration, so a `closeAll({ timeoutMs: 400 })` with nothing to wait for
    // still took ~430 ms to let the process exit. Measured, not theorized.
    let timer;
    try {
      await Promise.race([
        Promise.allSettled(consumers),
        new Promise((r) => {
          timer = setTimeout(r, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const runIds = [...runs.keys()];
    runs.clear();
    return { closed: runIds };
  }

  function has(runId) {
    return runs.has(runId);
  }

  return { attach, subscribe, derived, closeRun, resetRun, closeAll, has, _runs: runs };
}
