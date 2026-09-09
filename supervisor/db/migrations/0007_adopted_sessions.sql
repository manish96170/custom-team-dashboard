-- 0007_adopted_sessions.sql — adopting a session a HUMAN started (ROADMAP Phase 3).
--
-- WHAT ADOPTION IS
--
-- The supervisor normally spawns and owns every process it knows about. Adoption covers the other
-- case: a person ran `claude` in a terminal themselves, and a hook in that session tells the
-- supervisor it exists so the dashboard can SEE it. ROADMAP is explicit that this is the only case a
-- hook is needed for — "if the supervisor spawns and owns a process, it already knows that process's
-- status".
--
-- THE DANGER THIS MIGRATION EXISTS TO PREVENT
--
-- An adopted session is, structurally, identical to the thing migration 0003 called
-- `orphaned-unmanaged`: a live process the supervisor did not spawn and holds no handle for. If it
-- were recorded that way, every mechanism built for orphans would apply to it —
--
--   * reconciliation would journal it as an orphan sighting on every boot,
--   * `supervisor.orphans()` would list it as something to clean up,
--   * and a `reap` would GROUP-KILL a person's live session mid-sentence.
--
-- That last one is not a theoretical risk; it is the natural consequence of reusing the state. So
-- adoption gets its OWN lifecycle value, and the orphan machinery is taught to leave it alone.
--
--   runs.lifecycle  'managed' (default) | 'orphaned-unmanaged' (0003) | 'adopted' (here)
--
-- The distinction is intent, and intent is exactly what the OS cannot tell you: an unowned live
-- process is a problem when we lost it and is somebody's deliberate work when they started it. Only
-- a record of how it arrived can distinguish those, which is why this is a column and not an
-- inference.
--
-- WHAT AN ADOPTED RUN CANNOT DO, and why that is honest rather than a limitation to fix
--
-- The supervisor holds no stdio for it. So there is no `observe()`, no `sendInput`, no `interrupt`,
-- and no approval round trip -- a session started by hand answers its own permission prompts in its
-- own terminal, where the person is already sitting. Adoption buys VISIBILITY, not control, and
-- pretending otherwise would be the same overclaim as `approvalProtocol: 'host'` on a harness that
-- cannot answer (conformance/matrix.js).

-- Where the harness keeps that session's own transcript. Measured: a Claude Code `SessionStart` hook
-- receives `{ session_id, cwd, source, transcript_path, hook_event_name }`, and `transcript_path`
-- points at the real JSONL on disk. Recorded because it is the ONLY route to an adopted session's
-- events -- the supervisor cannot read its stream, but it can read that file. Nullable: another
-- harness's hook may not offer one.
ALTER TABLE runs ADD COLUMN transcript_path TEXT;

-- When it was adopted, kept separate from `started_at`. `started_at` is when the SESSION began;
-- this is when the dashboard learned about it, and they can be far apart -- a hook may only fire on
-- a session that has been running for an hour. Conflating them would make "how long has this been
-- going" unanswerable.
ALTER TABLE runs ADD COLUMN adopted_at TEXT;

-- The adopted set, for the same reason 0003 indexed the orphan set: it is read on every boot to
-- decide what NOT to touch.
CREATE INDEX idx_runs_adopted ON runs(lifecycle) WHERE lifecycle = 'adopted';

-- A session is adopted at most once. The harness's own session id is the natural key -- a hook can
-- fire more than once for one session (`SessionStart` has `source` values beyond `startup`, such as
-- a resume), and a second adoption of the same session must be a no-op rather than a duplicate row
-- claiming to be a different run.
--
-- Scoped to adopted rows only: a spawned run's `harness_session_id` is not unique in the same way
-- (a `resume()` reuses it across generations), so a global unique index would break the managed path.
CREATE UNIQUE INDEX idx_runs_adopted_session
  ON runs(harness_id, harness_session_id)
  WHERE lifecycle = 'adopted' AND harness_session_id IS NOT NULL;
