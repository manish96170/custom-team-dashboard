// _fixture-slack-post-cli.js — Phase 9 (Slack outbound), 2026-09-14. A stand-in for `team-slack-bridge`'s
// `post.js`, matching only the exact CLI contract `runtime/slack-outbox.js` actually invokes
// (`--json --channel <c> --text <t> --idempotency-key <k>`) — never the real Slack API.
//
// WHY A LOCAL FIXTURE AND NOT THE REAL BINARY, EVEN WITH `--dry-run`: this file exists specifically to
// prove the drain's RETRY/dedup/failure-handling logic — a case where a first attempt fails (network,
// rate limit) and a second attempt with the SAME idempotency key must be recognized as a repeat, not a
// new post. `team-slack-bridge`'s own `--dry-run` short-circuits BEFORE its idempotency ledger is even
// consulted (confirmed by reading `core/post.js` directly: the `if (dryRun) return ...` is the very first
// branch, before the token check and before the ledger claim) — so `--dry-run` cannot exercise that path
// at all, real or fake. This fixture implements its OWN tiny on-disk ledger (a plain JSON file, not
// `node:sqlite`, since the only thing under test is "did the SAME key get treated as a repeat", not the
// sibling repo's storage choice) so the retry/dedup behavior is actually testable without touching the
// real bridge or the real Slack API in any way, at any point, ever.
//
// Controlled by env vars a test sets, never by argv (keeps the argv surface IDENTICAL to what
// `slack-outbox.js` really builds, so a test asserting "these exact args were passed" stays honest):
//   FIXTURE_SLACK_MODE=fail        -> always exits with { ok: false, error: "fixture-forced-failure" }
//   FIXTURE_SLACK_LEDGER=<path>    -> where the tiny dedup ledger lives (required for dedup to work)
// Default (no env vars): succeeds, recording {channel, text} in the ledger keyed by --idempotency-key.

import fs from "node:fs";

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      flags[key] = next && !next.startsWith("--") ? next : true;
      if (next && !next.startsWith("--")) i += 1;
    }
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));

function readLedger(path) {
  if (!path || !fs.existsSync(path)) return {};
  return JSON.parse(fs.readFileSync(path, "utf8"));
}
function writeLedger(path, ledger) {
  fs.writeFileSync(path, JSON.stringify(ledger));
}

if (!flags.channel) {
  console.error("--channel is required");
  process.exit(1);
}
if (!flags.text) {
  console.error("--text is required");
  process.exit(1);
}

const ledgerPath = process.env.FIXTURE_SLACK_LEDGER;
const key = flags["idempotency-key"];
let result;

if (key && ledgerPath) {
  const ledger = readLedger(ledgerPath);
  if (ledger[key]) {
    result = { ok: true, deduped: true, ...ledger[key] };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  }
}

if (process.env.FIXTURE_SLACK_MODE === "fail") {
  result = { ok: false, error: "fixture-forced-failure" };
} else {
  result = { ok: true, channel: flags.channel, ts: "1700000000.000001" };
  if (key && ledgerPath) {
    const ledger = readLedger(ledgerPath);
    ledger[key] = { channel: result.channel, ts: result.ts };
    writeLedger(ledgerPath, ledger);
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
