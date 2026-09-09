# Phase 0b spike: OpenCode spawn/write adapter

Environment: OpenCode CLI 1.18.14 (Homebrew `opencode`), already installed on
this machine — no install needed. Auth: OpenCode Zen provider requires a
payment method (401 CreditsError, proven in run1.json below), so all real
model calls in this spike use `amazon-bedrock` (already authenticated via
`AWS_REGION`/`AWS_PROFILE` env vars), model `us.anthropic.claude-sonnet-5`.

All commands below were actually run in
`spike-0b/opencode-adapter/`; raw JSON/log artifacts (`run1.json`..`run6.json`,
`killtest*.json`, `prove_run.log`) are left in this directory as evidence.

## 1. Non-interactive start

`opencode --help` and `opencode run --help` (verified, not guessed) show two
non-interactive shapes:

- One-shot CLI: `opencode run "<prompt>" --format json -m <provider>/<model> --dir <cwd>`
- Headless server: `opencode serve --port <p> --hostname 127.0.0.1` + HTTP API
  (`GET /doc` returns a full OpenAPI 3.1 spec — very rich, ~150 operations).

Both proven working end-to-end:

```
$ opencode run "Say the word BANANA exactly once and nothing else." \
    --format json -m amazon-bedrock/us.anthropic.claude-sonnet-5 --dir ./testcwd
# exit 0, run2.json:
{"type":"step_start",...}
{"type":"text",...,"part":{"text":"BANANA",...}}
{"type":"step_finish",...,"tokens":{...},"cost":0.2395565}
```

The OpenCode Zen provider (`opencode/claude-sonnet-5`) failed with a real,
useful error (`run1.json`): `401 CreditsError: No payment method`. That's a
legitimate harness-difference to note: OpenCode's own hosted models need
billing set up; Bedrock/other providers configured via env/credentials work
immediately.

## 2. Streamed output — CLI vs server: genuinely different capability

**CLI (`run --format json`, redirected to a file): NOT token-streamed.**
Every run produced exactly 3 JSON lines regardless of output length —
`step_start`, one `text` part containing the ENTIRE final message (851 chars
in run6.json, single event, `time.start`/`time.end` ~5.6s apart but delivered
as one flush), `step_finish`. There is no intermediate delta visible on
stdout in this mode. This is the opposite of what you'd assume by analogy to
"streaming JSON output" — it's structured, but batched, not incremental.

**HTTP server (`opencode serve` + `GET /event` SSE): genuinely streamed.**
Subscribing to `/event` while driving a turn through
`POST /session/{id}/message` or `prompt_async` produces real per-token
`message.part.delta` events:

```
data: {"type":"message.part.delta","properties":{"sessionID":"...","messageID":"...","partID":"...","field":"text","delta":"The"}}
data: {"type":"message.part.delta","properties":{...,"delta":" lighthouse had"}}
data: {"type":"message.part.delta","properties":{...,"delta":" st"}}
... (dozens more) ...
data: {"type":"message.part.updated","properties":{"part":{"type":"text","text":<full 851 chars>}}}
```

**Conclusion for the capability matrix: OpenCode supports true streaming, but
only via the resident HTTP server, not via the one-shot CLI's JSON mode.** A
design that assumed "just parse stdout from `opencode run --format json`"
would silently get batch output, not deltas — exactly the kind of
harness-difference the capability matrix needs to capture explicitly rather
than assume.

## 3. Follow-up input / multi-turn / session resumption

Two mechanisms proven:

- **CLI, across separate process invocations**: `opencode run ... --session <id>`
  reuses server-side session state. Proof: told session a secret
  (`PELICAN-42`) in one `opencode run`, invoked a second, separate `opencode
  run --session <id>` process and asked "what was the code" — it answered
  `PELICAN-42` correctly (resume1.json/resume2.json).
- **HTTP server, same resident session, no restart**: `POST
  /session/{id}/message` a second time after the first completes; the model
  correctly answered a `2+2` follow-up in the same session and had the full
  prior essay's context.

`--continue`/`-c` (continue last session) and `--fork` (fork instead of
mutate) flags also exist per `--help` but weren't separately exercised.

## 4. Interrupt — real difference between CLI and server modes

**Server mode: clean, proven.** `POST /session/{id}/abort` while a turn is
mid-stream produces, over SSE:

```
{"type":"session.error","properties":{"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}}}}
... then ...
{"type":"session.idle", ...}
```

The server process itself stays alive; only that turn dies. This is the
adapter's `interrupt()`.

**CLI one-shot mode: no working interrupt at all.**
- `SIGINT` to a running `opencode run` process was **swallowed** — the run
  completed anyway with full output (`killtest.json`, 10,435-char essay,
  despite SIGINT sent 3s into a run that should take much longer).
- `SIGTERM` killed the process hard: exit code 143, **zero bytes of output**
  (`killtest2.json` — empty).

So: if a harness adapter only had access to the CLI, there is no clean
interrupt primitive — you either get "ignored" or "destroyed with no
salvageable partial state." This is an important asymmetry vs. whatever
Claude Code's interrupt story turns out to be; don't assume CLI-level
SIGINT/SIGTERM behaves the same across harnesses.

## 5. clearContext — real operation, different semantics than "clear"

There is no "wipe history, keep session id" operation in OpenCode. The
closest real thing is `POST /session/{id}/summarize` (also exposed as
`POST /api/session/{id}/compact` in the newer `/api` surface), which:
- Was called successfully against a live session (`{"providerID":...,
  "modelID":...}` body; missing top-level `providerID` gives a clear
  `BadRequest`, so the schema had to be introspected via `/doc`, not guessed).
- Returned `true` and added a new assistant message that is a **summary of
  the conversation so far**, used as compacted context going forward.
- Does **not** delete the original messages — they remain fully visible via
  `GET /session/{id}/message` — and does not reset cost/token counters.

Document this precisely in the capability matrix: `clearContext` for OpenCode
means "compact", not "erase." A caller expecting Claude-Code-style context
clearing needs to know the old turns are still retrievable/billable context
until the session itself is deleted (`DELETE /session/{id}`, not exercised
here but present in the OpenAPI spec).

## 6. cwd/env isolation

- CLI: `opencode run --dir <path>` — proven; `--print-logs --log-level DEBUG`
  output repeatedly showed `directory=.../opencode-adapter/testcwd` and the
  model's session `path` field reflected that directory.
- Server: `opencode serve` has **no `--dir` flag**. Its project directory is
  determined by the OS-level working directory the process itself was
  spawned in. Proven: spawned `opencode serve` with Node's `child_process`
  `cwd` option pointed at `./testcwd`; the resulting session's `directory`
  field in the API response was exactly that path.
- Practical consequence for the adapter: cwd isolation on the server side
  means **one `opencode serve` process per distinct working directory** you
  want isolated, not one shared server handling arbitrary directories per
  request. `adapter.js` implements this as a small server pool keyed by cwd.

## 7. Model + effort selection

- `opencode models` lists every resolvable `provider/model` id across all
  configured providers (OpenCode Zen, Amazon Bedrock, OpenAI, Google, Groq,
  etc. — real output captured, 30+ Bedrock ids alone).
- `opencode providers list` / `opencode auth list` show configured
  credentials — confirmed Bedrock is available via the `AWS_REGION`
  environment variable (no explicit opencode-side login needed since AWS SSO
  creds were already present).
- CLI flag: `-m/--model provider/model`. HTTP API: `model: {providerID,
  modelID}` on session create or per-message.
- Effort: CLI flag `--variant <high|max|minimal|...>` ("model variant
  (provider-specific reasoning effort)" per `--help`); HTTP API: `variant`
  field on the message body. Proven the flag/field is **accepted without
  error** (`runvariant.json`, exit 0). **Not proven** that it changes actual
  model behavior — the model has no reliable way to self-report which
  variant it ran under, so this is mechanically verified but behaviorally
  unverified. Flag this as a real gap, not swept under the rug.

## 8. Exit classification

- CLI: process exit code is meaningful — `0` for success, non-zero for
  errors (e.g. the OpenCode Zen credits error produced an `{"type":"error",
  ...}` JSON line; a bad model schema payload against the HTTP API returned
  400 with a structured `BadRequest`). SIGTERM-killed runs exit 143 with no
  output. SIGINT does **not** produce a distinguishable "interrupted" exit —
  it's indistinguishable from "completed normally" (see #4), which is a real
  problem for classification if you rely on the CLI alone.
- Server/SSE: classification is unambiguous and event-driven —
  `step_finish`/`session.idle` = completed; `session.error` with
  `error.name === "MessageAbortedError"` = aborted (via our own `abort` call);
  `session.error` with any other `error.name` = genuine failure. This is
  strictly better than the CLI's exit-code-only signal and is what
  `adapter.js`'s `observe()` uses to build `turn.end.status`.

## 9. Approval round-trip — proven end-to-end, real mechanism exists

This is a real, working, programmatically-answerable protocol — not a hang,
not an auto-deny, not an auto-approve-by-default.

Mechanism: create a session with an explicit permission ruleset
(`permission: [{permission:"bash", pattern:"*", action:"ask"}]`), send a
prompt that requires running a shell command, and watch `/event`:

```
data: {"type":"permission.asked","properties":{
  "id":"per_06d985dd1001JGMW9vpKvIZNNl",
  "sessionID":"...",
  "permission":"bash",
  "patterns":["echo APPROVAL_TEST_OK"],
  "metadata":{"command":"echo APPROVAL_TEST_OK"},
  "tool":{"messageID":"...","callID":"tooluse_XBGOula0ShH5Fy6ytFGtt2"}
}}
```

The turn genuinely pauses at this point (no tool.result event follows until
answered). Answered it from a plain `curl`/`fetch` call, i.e. from code, not
from a TUI:

```
POST /session/{id}/permissions/{permissionID}   body: {"response":"once"}
-> 200 true
```

...after which the tool actually executed (`bash` tool result: `output:
"APPROVAL_TEST_OK\n"`) and the assistant continued and reported the output.
Also verified via `adapter.js`/`prove-adapter.mjs` end-to-end (see
`prove_run.log`): `observe()` yields `approval.request`, the test harness
replies over the real HTTP endpoint, and `tool.result` + `turn.end` follow.

`response` can be `"once" | "always" | "reject"` — `"reject"` was not
exercised but is documented in the OpenAPI schema; worth a follow-up test
before relying on deny-and-continue behavior.

This mechanism is **HTTP-API-only** — it is not exposed by the one-shot CLI
(`opencode run` has no way to answer a permission prompt fed via stdin in
this spike; with no TTY and no `--auto`, the honest expectation based on the
server-side evidence is that a CLI-only integration would need `--auto` and
accept "everything not explicitly denied gets auto-approved", which is
explicitly documented in `--help` as "(dangerous!)"). Prior research this
session also flagged the plugin system's `tool.execute.before` hook as a
possible interception point — this spike proves the HTTP permission API
works and reaches the same practical outcome without needing a plugin at all.

## Capability matrix (real values)

```
{
  residentProcess: true,        // only via `opencode serve`; the CLI is one-shot
  resumableTurns: true,         // --session/-s (CLI) and same-session POST /session/{id}/message (server) both proven
  structuredOutput: "partial",  // NDJSON events yes; per-token deltas only via server SSE, not CLI --format json
  interrupt: "server-only",     // POST /session/{id}/abort is clean; CLI SIGINT is swallowed, SIGTERM is destructive
  clearContext: "compact-only", // /session/{id}/summarize compacts, does not erase; messages remain listable
  approvalProtocol: "http-permission-api", // permission.asked SSE event + POST /session/{id}/permissions/{id} reply; real, programmatic, proven end-to-end
  modelDiscovery: "opencode models / GET /config/providers; multi-provider (Bedrock proven live, OpenCode Zen blocked on billing)"
}
```

## Biggest risk this spike surfaces

Any design that treats `opencode run --format json` as "the" non-interactive
interface will silently lose: true streaming, interrupt, and the approval
round-trip — all three of the hardest requirements only work through the
resident `opencode serve` HTTP+SSE surface. The CLI and the server are not
two equivalent front-ends to the same capability; they are different
capability tiers. `adapter.js` in this spike is deliberately built on
`serve`, not `run`, for exactly this reason.
