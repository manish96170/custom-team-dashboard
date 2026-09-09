// redaction.test.js — proves prompts are hashed + truncated by default, full text is
// never written unless explicitly opted in, and the opt-in actually works when used.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { closeDb, createRun } from "../index.js";
import { redactPrompt, DEFAULT_PREVIEW_LENGTH, FULL_PROMPT_OPT_IN_ENV_VAR } from "../redact.js";
import { openSeededDb, makeScratchDir, rmScratchDir, runTest } from "./_helpers.js";

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

await runTest("redaction", async () => {
  const longPrompt =
    "SECRET_TOKEN=sk-abc123-do-not-persist-this ".repeat(20) +
    "please implement the checkout flow";
  assert.ok(longPrompt.length > DEFAULT_PREVIEW_LENGTH, "fixture prompt must exceed the preview length to be a real test");

  // --- 1. Unit-level: redactPrompt() itself, default (no opt-in) ---
  const r1 = redactPrompt(longPrompt, { persistFull: false });
  assert.equal(r1.sha256, sha256(longPrompt));
  assert.equal(r1.preview, longPrompt.slice(0, DEFAULT_PREVIEW_LENGTH));
  assert.equal(r1.full, null, "full prompt text must be null by default");
  assert.ok(!r1.preview.includes("checkout"), "sanity: preview must actually be truncated, not the full string");

  // --- 2. Unit-level: opt-in via explicit flag ---
  const r2 = redactPrompt(longPrompt, { persistFull: true });
  assert.equal(r2.full, longPrompt, "opt-in must persist the exact original text");

  // --- 3. Unit-level: opt-in via env var, and that unset/false/garbage all fail closed ---
  const originalEnv = process.env[FULL_PROMPT_OPT_IN_ENV_VAR];
  try {
    delete process.env[FULL_PROMPT_OPT_IN_ENV_VAR];
    assert.equal(redactPrompt(longPrompt).full, null, "unset env var must default to redacted");
    process.env[FULL_PROMPT_OPT_IN_ENV_VAR] = "false";
    assert.equal(redactPrompt(longPrompt).full, null, `env var "false" must not opt in`);
    process.env[FULL_PROMPT_OPT_IN_ENV_VAR] = "yes-please"; // typo/garbage
    assert.equal(redactPrompt(longPrompt).full, null, "garbage env var value must fail closed, not opt in");
    process.env[FULL_PROMPT_OPT_IN_ENV_VAR] = "1";
    assert.equal(redactPrompt(longPrompt).full, longPrompt, `env var "1" must opt in`);
  } finally {
    if (originalEnv === undefined) delete process.env[FULL_PROMPT_OPT_IN_ENV_VAR];
    else process.env[FULL_PROMPT_OPT_IN_ENV_VAR] = originalEnv;
  }

  // --- 4. End-to-end through the real write path: createRun() against a real db,
  //         then read the row back and confirm what actually landed on disk. ---
  const stateDir = makeScratchDir("supervisor-redaction-test");
  // Two distinct secrets, each placed *after* DEFAULT_PREVIEW_LENGTH characters of
  // padding, so the raw-file-bytes check below tests full-text redaction specifically
  // -- not preview redaction. Known, documented limitation (see FINDINGS.md): the
  // ~200-char preview is a preview, not a secret-scrubber -- a secret sitting inside
  // the first 200 chars of a prompt legitimately appears in prompt_preview by design.
  // Only full prompt text (prompt_full) is redaction's actual guarantee.
  const padding = "x".repeat(DEFAULT_PREVIEW_LENGTH + 20);
  const defaultRunPrompt = padding + " SECRET_TOKEN=sk-default-do-not-persist " + longPrompt;
  const optInRunPrompt = padding + " SECRET_TOKEN=sk-optin-should-persist " + longPrompt;
  try {
    const db = openSeededDb(stateDir);
    createRun(db, {
      runId: "run-default",
      workerId: "worker-1",
      harnessId: "claude-code",
      prompt: defaultRunPrompt,
      // persistFullPrompt omitted -> must default to redacted
    });
    createRun(db, {
      runId: "run-optin",
      workerId: "worker-1",
      harnessId: "claude-code",
      prompt: optInRunPrompt,
      persistFullPrompt: true,
    });

    const rowDefault = db.prepare("SELECT prompt_sha256, prompt_preview, prompt_full FROM runs WHERE run_id = ?").get("run-default");
    console.log("run-default row:", rowDefault);
    assert.equal(rowDefault.prompt_sha256, sha256(defaultRunPrompt));
    assert.equal(rowDefault.prompt_preview, defaultRunPrompt.slice(0, DEFAULT_PREVIEW_LENGTH));
    assert.equal(rowDefault.prompt_full, null, "default write path must not persist full prompt text on disk");

    const rowOptIn = db.prepare("SELECT prompt_sha256, prompt_preview, prompt_full FROM runs WHERE run_id = ?").get("run-optin");
    console.log("run-optin row prompt_full length:", rowOptIn.prompt_full?.length);
    assert.equal(rowOptIn.prompt_full, optInRunPrompt, "opt-in write path must persist the exact original text");

    // Confirm the raw db file bytes never contain the *default* run's secret, even
    // though the file does (legitimately) contain the opt-in run's secret elsewhere.
    closeDb(db);
    const fs = await import("node:fs");
    const { defaultDbPath } = await import("../paths.js");
    const raw = fs.readFileSync(defaultDbPath(stateDir));
    const rawStr = raw.toString("latin1");
    assert.ok(!rawStr.includes("sk-default-do-not-persist"), "the default run's secret must not appear anywhere in the db file bytes");
    assert.ok(rawStr.includes("sk-optin-should-persist"), "sanity check: the opt-in run's secret SHOULD appear on disk, proving the two runs are being compared meaningfully rather than the scan being broken");
  } finally {
    rmScratchDir(stateDir);
  }
});
