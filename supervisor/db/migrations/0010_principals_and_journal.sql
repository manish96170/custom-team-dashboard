-- 0010_principals_and_journal.sql — capability-based authorization (PLAN.md sections 16 and 14.5). Phase 7.
--
-- WHAT SECTION 16 REPLACED, AND WHY THIS IS THE GATE FOR EVERYTHING ELSE IN PHASE 7
--
-- The original design routed every side effect through a fixed chain: worker -> lead -> CTO -> utility agent,
-- unconditionally. Section 16 replaced it with capability-based authorization, and gave two reasons: a hop
-- count adds model calls to routine low-risk actions for no security benefit, and "a hop with no return path
-- is a deadlock waiting to happen". The replacement is "every caller carries an immutable principal (the same
-- `callerIdentity` from section 14.5) and a set of capabilities".
--
-- So this migration is Phase 7's first item because every utility agent is gated by it. Handing out the roster
-- before the gate exists is the same sequencing bug this project already hit once, when the
-- assignment-confirmation UI was designed before `start()` existed for it to call.
--
-- WHAT A `callerIdentity` CAN HONESTLY BE HERE — MEASURED, NOT ASSUMED
--
-- Section 14.5 says the principal is "an authenticated principal minted at ingress — the foreground TUI user,
-- or a socket peer credential". **There is no socket peer credential available from pure Node.** Measured
-- before designing this (`adapters/claude-code/probe/peercred-probe.mjs`, evidence 17): on a Unix-domain
-- socket `remoteAddress` is `undefined` and the libuv handle exposes only `bind, listen, connect, open,
-- fchmod`. Nothing about uid, gid or pid. Adding a native dependency to get `LOCAL_PEERCRED` was rejected for
-- the same reason `node-pty` was (section 9): this project has exactly one dependency on purpose.
--
-- What IS available, and what each part actually proves:
--
--   1. **Filesystem permissions.** The state dir is `0700` and the socket lives in it, so only the local user
--      can connect at all. That authenticates the USER and nothing finer — which is precisely the boundary
--      section 15's local-only architecture already relies on.
--   2. **A token the supervisor mints.** The supervisor spawns every worker, so it can hand each one a
--      per-principal secret at spawn time — the same channel `CTD_ADOPT_WORKER_ID` already uses — and the TUI
--      reads the owner's from a `0600` file only the owner can read.
--
-- Together those give "which principal is this" on top of "which user is this". Stated plainly because the
-- limitation is real and inherited by everything above it: **a token in an environment variable is visible to
-- that process's descendants**, so a worker principal identifies a RUN AND EVERYTHING IT SPAWNS, not a single
-- process. That is an honest boundary for a local single-user tool and it would not be one for a shared host.
--
-- ONLY THE HASH IS STORED. `token_sha256`, never the token. A principal's secret is returned once, at mint
-- time, and cannot be recovered from the database — so a leaked database is not a set of working credentials.
-- This is also why `revoked_at` exists rather than a DELETE: revocation has to be auditable, and a deleted row
-- cannot answer "when did this stop being allowed".

CREATE TABLE principals (
  id             TEXT PRIMARY KEY,
  -- 'human'   : the foreground TUI user — the owner. Minted at boot, token in the state dir at 0600.
  -- 'worker'   : a coder/reviewer/lead run. Minted at spawn, token passed in the child's environment.
  -- 'utility'  : a narrow single-purpose agent (section 16's roster: jira, git, slack).
  -- 'cto'      : section 2's resident agent. Distinguished because it is the only holder of
  --              `approve:sensitive` besides the human, and Phase 8 is where it starts existing.
  kind           TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  -- Set for 'worker' principals only: which durable worker identity this principal speaks for. NOT `run_id` —
  -- section 3's identity split means a worker survives clear/respawn, and so must its authority.
  worker_id      TEXT REFERENCES workers(worker_id),
  token_sha256   TEXT NOT NULL UNIQUE,
  -- A JSON array of capability strings. Explicit, never a wildcard: section 16 keeps "fixed toolsets (a
  -- jira-automation agent never picks up git access 'just this once')", and a wildcard is exactly how that
  -- intent erodes. The owner has a long list; a utility agent has one or two.
  capabilities_json TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  revoked_at     TEXT
);

CREATE UNIQUE INDEX idx_principals_token ON principals(token_sha256);
CREATE INDEX idx_principals_worker ON principals(worker_id);

-- Section 16: "Each global agent keeps an append-only log of what it did and for whom/which task — a
-- jira-automation agent checks 'did I already file this ticket' against its own log, not a large context
-- window. Context stays small because the log is a file/table, not conversation memory."
--
-- One table rather than one per agent: the query that matters ("did I already do this") is per
-- (principal, action, args_sha256), and a shared table answers it with an index instead of a file format.
--
-- IT ALSO HOLDS REFUSALS, which is not an afterthought: section 14.5 requires that "refusals are logged, never
-- silently dropped". An authorization system whose denials leave no trace cannot be audited, and cannot tell
-- "nobody tried" from "somebody tried and was stopped".
CREATE TABLE agent_journal (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id   TEXT NOT NULL REFERENCES principals(id),
  -- The capability-shaped action name ('git:push', 'jira:create', 'run:start', ...), so the journal and the
  -- capability set speak the same vocabulary.
  action         TEXT NOT NULL,
  -- Hash of the canonicalised arguments. The POINT of hashing rather than storing them: it makes
  -- "did I already do exactly this" an index lookup, and it is what binds a sensitive-action approval to the
  -- thing that was approved (see `approvals`) instead of to the action's name.
  args_sha256    TEXT NOT NULL,
  -- A short human-readable summary. Redaction rules apply (db/redact.js): a journal is read by people.
  args_preview   TEXT,
  task_id        TEXT REFERENCES tasks(id),
  -- 'allowed' | 'refused' | 'done' | 'failed'. Two axes deliberately collapsed into one column, because the
  -- interesting queries are "what was refused" and "what actually happened", not the cross product.
  outcome        TEXT NOT NULL,
  detail         TEXT,
  at             TEXT NOT NULL
);

CREATE INDEX idx_agent_journal_dedup ON agent_journal(principal_id, action, args_sha256);
CREATE INDEX idx_agent_journal_task ON agent_journal(task_id, at);

-- The explicitly enumerated sensitive class (section 16: "CTO approval is required only for an explicitly
-- enumerated sensitive class — push to a protected branch, as-user posting (backlog), a merge").
--
-- WHY AN APPROVAL IS BOUND TO AN ARGS HASH, which is the whole security property: an approval for "push to
-- main" must not authorise a push of different content, and an approval to merge task A must not merge task B.
-- Without the binding, a sensitive-action gate is a one-time coupon rather than a decision about a specific
-- act — and that is the difference between a control and a formality.
--
-- Approvals EXPIRE. A decision made an hour ago about a diff that has since changed is not a current
-- decision, which is the same reasoning that makes review verdicts revision-bound (section 13).
CREATE TABLE sensitive_approvals (
  id             TEXT PRIMARY KEY,
  action         TEXT NOT NULL,
  args_sha256    TEXT NOT NULL,
  -- Who is being authorised, and who authorised it. Distinct on purpose: self-approval is refused, and that
  -- is only checkable if both are recorded.
  for_principal  TEXT NOT NULL REFERENCES principals(id),
  granted_by     TEXT NOT NULL REFERENCES principals(id),
  granted_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  -- Set when the approval is spent. Single-use: an approval that could be replayed is a standing permission
  -- wearing a decision's clothes.
  consumed_at    TEXT
);

CREATE INDEX idx_sensitive_approvals_lookup ON sensitive_approvals(action, args_sha256, for_principal);
