/**
 * Retry wrapper for LLM API calls.
 *
 * Handles two classes of failure:
 *   - Rate limits (429): back off and retry — hammering immediately makes it worse.
 *   - Transient server errors (500/502/503/504): retry with backoff.
 *   - Network failures (ECONNRESET, ETIMEDOUT, etc.): retry with backoff.
 *   - Everything else (400 bad request, auth errors, …): throw immediately.
 *
 * Uses full jitter: actual delay = random value in [0, baseDelay * 2^attempt].
 * This prevents a thundering herd when multiple concurrent reviews all hit a
 * rate limit at the same time.
 */

import { logger } from "../logger.js";
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./types.js";

/** HTTP status codes worth retrying. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Maximum number of attempts (1 original + 3 retries). */
const MAX_ATTEMPTS = 4;

/** Base delay in ms; actual delay = jitter(baseDelay * 2^attempt). */
const BASE_DELAY_MS = 2_000;

/** Hard ceiling on any single delay to avoid waiting forever on a 429 storm. */
const MAX_DELAY_MS = 60_000;

/** Network error codes that should trigger retry. */
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);

function isRetryable(err: unknown): boolean {
  if (err && typeof err === "object") {
    // HTTP status-based retry (rate limits, server errors)
    const status = (err as { status?: number }).status;
    if (typeof status === "number") return RETRYABLE_STATUSES.has(status);

    // Network error retry (socket failures, DNS issues)
    const code = (err as { code?: string }).code;
    if (typeof code === "string") return RETRYABLE_ERROR_CODES.has(code);

    // AbortError from fetch timeouts
    const name = (err as { name?: string }).name;
    if (name === "AbortError") return true;
  }
  return false;
}

/**
 * Detect context-overflow errors from LLM providers.
 *
 * Every provider formats these differently, but the key phrases are
 * consistent enough to catch the common cases:
 *   - Anthropic: "prompt is too long"
 *   - OpenAI: "maximum context length", "reduce the length"
 *   - Ollama: "context length exceeded", "exceeds the context window"
 *   - Generic: "context_length_exceeded"
 *
 * Returns the provider's raw message excerpt if detected, null otherwise.
 */
function detectContextOverflow(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;

  const message =
    (err as { message?: string }).message ??
    (err as { error?: { message?: string } }).error?.message ??
    "";

  const lower = message.toLowerCase();
  const keywords = [
    "context length",
    "context_length",
    "prompt is too long",
    "reduce the length",
    "maximum context",
    "exceeds the context window",
    "too many tokens",
    "token limit",
    "max context length",
  ];

  for (const kw of keywords) {
    if (lower.includes(kw)) return message.slice(0, 300);
  }
  return null;
}

function jitteredDelay(attempt: number): number {
  const cap = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.random() * cap;
}

/**
 * Call `provider.complete(req)` with exponential backoff + full jitter.
 * Transparent drop-in: callers keep using the same interface.
 */
export async function completeWithRetry(
  provider: LLMProvider,
  req: CompletionRequest,
): Promise<CompletionResult> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delayMs = jitteredDelay(attempt - 1);
      logger.warn(
        {
          provider: provider.name,
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          delayMs: Math.round(delayMs),
          status: (lastErr as { status?: number })?.status,
        },
        "LLM call failed — retrying after backoff",
      );
      await sleep(delayMs);
    }

    try {
      return await provider.complete(req);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) {
        // Context-overflow errors are non-retryable 400s. Surface a
        // clear message so the operator knows to trim config or use a
        // larger model — rather than staring at a cryptic provider error.
        const overflowMsg = detectContextOverflow(err);
        if (overflowMsg) {
          logger.error(
            {
              provider: provider.name,
              model: req.model,
              systemChars: req.system.length,
              userChars: req.user.length,
              estimatedInputTokens: Math.ceil(
                (req.system.length + req.user.length) / 3.5,
              ),
              providerMessage: overflowMsg,
            },
            "Context window exceeded — prompt too large for the configured model. " +
              "Reduce context.maxFileChars, trim .zanuda/instructions.md, set LLM_MAX_CONTEXT_TOKENS, " +
              "or switch to a model with a larger context window.",
          );
          throw new Error(
            `Context window exceeded (${provider.name}/${req.model}): ${overflowMsg}. ` +
              `Prompt was ${req.system.length + req.user.length} chars ` +
              `(~${Math.ceil((req.system.length + req.user.length) / 3.5)} tokens). ` +
              `Reduce context.maxFileChars, trim .zanuda/instructions.md, or use a larger model.`,
            { cause: err },
          );
        }
        throw err;
      }
    }
  }

  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
