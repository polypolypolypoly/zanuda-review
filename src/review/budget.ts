/**
 * Token and character budget helpers for fitting prompts into model
 * context windows.
 */

import type { Config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Scale the completion token budget to the actual PR size instead of always
 * reserving the configured maximum.
 *
 * Output budget per file:
 *   ~30 tokens for the filesSummary entry
 *   ~80 tokens for an inline comment (typically 1-2 per file reviewed)
 *   = ~120 tokens/file, doubled for headroom = ~240 tokens/file
 *
 * The configured maxTokens acts as a hard ceiling. If `providerMaxOutput`
 * is provided (from LLMProvider.maxOutputTokens), it acts as an additional
 * ceiling — prevents 400s from providers with small output windows (Ollama).
 */
export function adaptiveMaxTokens(
  fileCount: number,
  configuredMax: number,
  providerMaxOutput?: number,
): number {
  const estimated = fileCount * 240 + 400;
  const ceiling = providerMaxOutput
    ? Math.min(configuredMax, providerMaxOutput)
    : configuredMax;
  return Math.min(ceiling, Math.max(1500, estimated));
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
 *
 * IMPORTANT: this function only controls the DIFF budget. Context, memory,
 * preprompt, and other non-diff components are NOT trimmed here. If those
 * alone exceed the context window, a warning is logged and the diff budget
 * is clamped to a safe minimum — but the caller should also trim non-diff
 * content before building the prompt.
 */
export function adjustedDiffBudget(
  config: Config,
  contextText: string,
  fileCount: number,
  maxContextTokens: number,
  providerMaxOutput?: number,
): number {
  const systemTokens = estimateTokens(config.preprompt);
  const contextTokens = estimateTokens(contextText);
  const outputTokens = adaptiveMaxTokens(
    fileCount,
    config.generation.maxTokens,
    providerMaxOutput,
  );

  const FIXED_TASK_TOKENS = 700;

  const nonDiffTokens =
    systemTokens + contextTokens + FIXED_TASK_TOKENS + outputTokens;
  const availableDiffTokens = Math.max(0, maxContextTokens - nonDiffTokens);

  if (availableDiffTokens <= 0) {
    logger.warn(
      {
        maxContextTokens,
        systemTokens,
        contextTokens,
        outputTokens,
        nonDiffTokens,
        contextChars: contextText.length,
      },
      "Context window exceeded by non-diff content alone (preprompt + context + output). " +
        "The diff budget is at minimum, but the prompt will likely still overflow. " +
        "Reduce context.maxFileChars, trim .zanuda/instructions.md, or use a model with a larger context window.",
    );
  }

  const computed = Math.max(2000, Math.floor(availableDiffTokens * 3.5));
  const capped = Math.min(computed, config.review.maxDiffChars);

  const SAFETY_MARGIN = 0.9;
  const withMargin = Math.floor(capped * SAFETY_MARGIN);
  return Math.max(2000, withMargin);
}

/**
 * Log the total prompt size before an LLM call so operators can see what
 * is actually being sent and spot budget issues without provider errors.
 */
export function logPromptSize(opts: {
  systemChars: number;
  userChars: number;
  provider: string;
  model: string;
  maxOutputTokens: number;
}): void {
  const inputChars = opts.systemChars + opts.userChars;
  const inputTokens = Math.ceil(inputChars / 3.5);
  logger.info(
    {
      provider: opts.provider,
      model: opts.model,
      inputChars,
      inputTokens: Math.round(inputTokens),
      systemChars: opts.systemChars,
      userChars: opts.userChars,
      maxOutputTokens: opts.maxOutputTokens,
      totalEstimatedTokens: Math.round(inputTokens) + opts.maxOutputTokens,
    },
    "Prompt assembled",
  );
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
