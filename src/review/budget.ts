/**
 * Token and character budget helpers for fitting prompts into model
 * context windows.
 */

import type { Config } from "../config.js";

/**
 * Scale the completion token budget to the actual PR size instead of always
 * reserving the configured maximum.
 *
 * Output budget per file:
 *   ~30 tokens for the filesSummary entry
 *   ~80 tokens for an inline comment (typically 1-2 per file reviewed)
 *   = ~120 tokens/file, doubled for headroom = ~240 tokens/file
 *
 * The configured maxTokens acts as a hard ceiling.
 */
export function adaptiveMaxTokens(
  fileCount: number,
  configuredMax: number,
): number {
  const estimated = fileCount * 240 + 400;
  return Math.min(configuredMax, Math.max(1500, estimated));
}

/**
 * Read and validate LLM_MAX_CONTEXT_TOKENS from the environment.
 * Returns undefined when not set (no limit — cloud models).
 */
export function parseMaxContextTokens(): number | undefined {
  const raw = process.env.LLM_MAX_CONTEXT_TOKENS;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(
      `Invalid LLM_MAX_CONTEXT_TOKENS="${raw}": must be a positive integer`,
    );
  }
  return n;
}

/**
 * Compute an effective diff character budget that keeps the total prompt
 * within the model's context window. Only active when maxContextTokens is set
 * (via the LLM_MAX_CONTEXT_TOKENS env var).
 *
 * Token estimation uses a conservative 3.5 chars/token (code ~4, English ~3).
 * A 10% safety margin prevents near-miss overflows.
 */
export function adjustedDiffBudget(
  config: Config,
  contextText: string,
  fileCount: number,
  maxContextTokens: number,
): number {
  const systemTokens = estimateTokens(config.preprompt);
  const contextTokens = estimateTokens(contextText);
  const outputTokens = adaptiveMaxTokens(
    fileCount,
    config.generation.maxTokens,
  );

  const FIXED_TASK_TOKENS = 700;

  const nonDiffTokens =
    systemTokens + contextTokens + FIXED_TASK_TOKENS + outputTokens;
  const availableDiffTokens = Math.max(0, maxContextTokens - nonDiffTokens);

  const computed = Math.max(2000, Math.floor(availableDiffTokens * 3.5));
  const capped = Math.min(computed, config.review.maxDiffChars);

  const SAFETY_MARGIN = 0.9;
  const withMargin = Math.floor(capped * SAFETY_MARGIN);
  return Math.max(2000, withMargin);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
