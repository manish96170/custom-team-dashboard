// redact.js — redaction at the write boundary (spike-0b review finding S13).
//
// The spike wrote `prompt: spec.prompt` verbatim into a plain JSON file at default
// umask. Prompts routinely carry pasted tokens, connection strings, and customer data,
// so the default here is: never persist the raw text. Persist a SHA-256 hash (so an
// operator can later confirm "was it this exact prompt" without re-reading it) plus a
// truncated preview (~200 chars, for human orientation in a debug view), and only
// persist the full text when the caller explicitly opts in.

import crypto from "node:crypto";

export const DEFAULT_PREVIEW_LENGTH = 200;
export const FULL_PROMPT_OPT_IN_ENV_VAR = "SUPERVISOR_PERSIST_FULL_PROMPTS";

/**
 * Whether the environment has explicitly opted into persisting full prompt text.
 * Anything other than "1" or "true" (case-sensitive, matching common env-flag
 * convention) leaves the default (redacted) behavior in place -- unset, "0", "false",
 * empty string, typos, all fail closed.
 */
export function fullPromptPersistenceEnabled(env = process.env) {
  const v = env[FULL_PROMPT_OPT_IN_ENV_VAR];
  return v === "1" || v === "true";
}

/**
 * Redact a piece of prompt text for storage.
 *
 * @param {string | null | undefined} text
 * @param {{ persistFull?: boolean, previewLength?: number }} [opts]
 *   persistFull defaults to fullPromptPersistenceEnabled() (the opt-in env var);
 *   pass it explicitly to override per-call regardless of environment.
 * @returns {{ sha256: string|null, preview: string|null, full: string|null }}
 */
export function redactPrompt(text, opts = {}) {
  const previewLength = opts.previewLength ?? DEFAULT_PREVIEW_LENGTH;
  const persistFull = opts.persistFull ?? fullPromptPersistenceEnabled();

  if (text == null) {
    return { sha256: null, preview: null, full: null };
  }

  const str = String(text);
  const sha256 = crypto.createHash("sha256").update(str, "utf8").digest("hex");
  const preview = str.slice(0, previewLength);

  return {
    sha256,
    preview,
    full: persistFull ? str : null,
  };
}
