import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Global configuration schema. Loaded from config/default.yaml (or the path
 * in ZANUDA_CONFIG) and overridable per-repo via `.zanuda.yml`.
 */
const ConfigSchema = z.object({
  provider: z.enum([
    "anthropic",
    "openai",
    "openrouter",
    "ollama",
    "deepseek",
    "gemini",
  ]),
  models: z.object({
    anthropic: z.string(),
    openai: z.string(),
    openrouter: z.string(),
    ollama: z.string(),
    deepseek: z.string(),
    gemini: z.string(),
  }),
  generation: z.object({
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().positive(),
  }),
  preprompt: z.string(),
  context: z.object({
    includeFiles: z.array(z.string()),
    maxFileChars: z.number().int().positive(),
    includeFileTree: z.boolean(),
    maxTreeEntries: z.number().int().positive(),
  }),
  persistence: z.object({
    /**
     * Path to the PR state file (rounds completed, mention counts, etc.).
     * Empty string = ~/.zanuda/state.json
     */
    stateFile: z.string(),
    /**
     * Path to the commit log file (reviewed commit SHAs per repo).
     * Empty string or absent = ~/.zanuda/commit-log.json
     */
    commitLogFile: z.string().optional(),
  }),
  access: z.object({
    /**
     * Allowlist of owners or owner/repo slugs that may request reviews.
     * Empty = accept everyone. Entries may be:
     *   "octocat"          — allow any repo owned by octocat
     *   "octocat/hello"    — allow only that specific repo
     */
    allowlist: z.array(z.string()),
  }),
  limits: z.object({
    /** Max LLM reviews running in parallel at any time. */
    maxConcurrentReviews: z.number().int().positive(),
    /** Max new PRs picked up per poll cycle (caps burst from a flooded queue). */
    maxNewPrsPerCycle: z.number().int().positive(),
    /** Per-PR token budget (input + output). 0 = no limit. */
    tokenBudgetPerPR: z.number().int().nonnegative().default(0),
    /**
     * Hard cap on review batches per PR. Prevents unbounded LLM cost on
     * pathological PRs with hundreds of changed files. Beyond this limit,
     * the highest-signal batches are selected and unreviewed files are
     * noted honestly in the verdict comment. 0 = no limit.
     */
    maxBatches: z.number().int().nonnegative().default(10),
  }),
  memory: z.object({
    /** Toggle the whole feature on/off. */
    enabled: z.boolean(),
    /** Directory to store per-repo memory files. Empty string = ~/.zanuda/memory. */
    dir: z.string(),
    /** After every review, ask the model if the memory should be updated. */
    updateAfterReview: z.boolean(),
    /** Maximum number of past review entries to keep in the per-repo history log. */
    maxHistoryEntries: z.number().int().positive(),
  }),
  review: z.object({
    maxDiffChars: z.number().int().positive(),
    inlineComments: z.boolean(),
    suggestions: z.boolean(),
    maxCommentChars: z.number().int().min(400).default(400),
    /** Self-verification: after review, a second LLM call checks each finding
     * against the diff. Disable for budget-constrained self-hosters. */
    verifyFindings: z.boolean().default(true),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

/** A repo-supplied `.zanuda.yml` may override a subset of the config. */
export const RepoConfigSchema = ConfigSchema.partial().extend({
  // Convenience: a repo can append extra instructions without replacing the
  // whole preprompt.
  prepromptAppend: z.string().optional(),
  memory: ConfigSchema.shape.memory.partial().optional(),
  context: ConfigSchema.shape.context.partial().optional(),
  review: ConfigSchema.shape.review.partial().optional(),
  generation: ConfigSchema.shape.generation.partial().optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export function loadConfig(path?: string): Config {
  // Always load config/default.yaml (or explicit path) as the full base config.
  // When no path is given, resolve relative to the Zanuda package root,
  // not the CWD — otherwise running from another project fails.
  const basePath = path
    ? resolve(path)
    : resolve(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "config/default.yaml",
      );
  const baseRaw = parseYaml(readFileSync(basePath, "utf8"));
  const baseParsed = ConfigSchema.safeParse(baseRaw);
  if (!baseParsed.success) {
    throw new Error(
      `Invalid config at ${basePath}:\n${z.prettifyError(baseParsed.error)}`,
    );
  }
  let config = baseParsed.data;

  // If ZANUDA_CONFIG is set, load it as a partial overlay and merge it.
  // This file only needs to contain the keys you want to override.
  const overlayPath = process.env.ZANUDA_CONFIG;
  if (overlayPath) {
    const overlayRaw = parseYaml(readFileSync(resolve(overlayPath), "utf8"));
    const overlayParsed = RepoConfigSchema.safeParse(overlayRaw);
    if (!overlayParsed.success) {
      throw new Error(
        `Invalid overlay config at ${overlayPath}:\n${z.prettifyError(overlayParsed.error)}`,
      );
    }
    config = mergeRepoConfig(config, overlayParsed.data);
  }

  return applyEnvOverrides(config);
}

/** Env vars take precedence over the YAML file for a few hot settings. */
function applyEnvOverrides(config: Config): Config {
  // Return a fresh copy — never mutate the parsed config in place.
  const result = { ...config, models: { ...config.models } };
  const rawProvider = process.env.LLM_PROVIDER;
  if (rawProvider) {
    const parsed = ConfigSchema.shape.provider.safeParse(rawProvider);
    if (!parsed.success) {
      throw new Error(
        `Invalid LLM_PROVIDER="${rawProvider}". Valid values: anthropic, openai, openrouter, ollama`,
      );
    }
    result.provider = parsed.data;
  }
  if (process.env.LLM_MODEL) {
    result.models[result.provider] = process.env.LLM_MODEL;
  }
  return result;
}

/**
 * Merge a repo's `.zanuda.yml` over the global config.
 * Shallow per-section; `prepromptAppend` is concatenated onto the preprompt.
 */
export function mergeRepoConfig(base: Config, repo: RepoConfig | null): Config {
  if (!repo) return base;
  const merged: Config = {
    ...base,
    ...stripUndefined(repo),
    models: { ...base.models, ...repo.models },
    generation: { ...base.generation, ...repo.generation },
    memory: { ...base.memory, ...repo.memory },
    context: { ...base.context, ...repo.context },
    review: { ...base.review, ...repo.review },
  };
  if (repo.preprompt) merged.preprompt = repo.preprompt;
  if (repo.prepromptAppend) {
    merged.preprompt = `${merged.preprompt}\n\n${repo.prepromptAppend}`;
  }
  return merged;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
