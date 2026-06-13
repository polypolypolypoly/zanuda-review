import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Global configuration schema. Loaded from config/default.yaml (or the path
 * in REVIEW_HELPER_CONFIG) and overridable per-repo via `.review-helper.yml`.
 */
export const ConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "openrouter", "ollama"]),
  models: z.object({
    anthropic: z.string(),
    openai: z.string(),
    openrouter: z.string(),
    ollama: z.string(),
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
     * Empty string = ~/.review-helper/state.json
     */
    stateFile: z.string(),
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
  }),
  memory: z.object({
    /** Toggle the whole feature on/off. */
    enabled: z.boolean(),
    /** Directory to store per-repo memory files. Empty string = ~/.review-helper/memory. */
    dir: z.string(),
    /** After every review, ask the model if the memory should be updated. */
    updateAfterReview: z.boolean(),
  }),
  review: z.object({
    maxDiffChars: z.number().int().positive(),
    inlineComments: z.boolean(),
    // null = model decides; set to a value to hard-override per repo.
    event: z.enum(["COMMENT", "REQUEST_CHANGES", "APPROVE"]).nullable(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

/** A repo-supplied `.review-helper.yml` may override a subset of the config. */
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
  const configPath = resolve(
    path ?? process.env.REVIEW_HELPER_CONFIG ?? "config/default.yaml",
  );
  const raw = parseYaml(readFileSync(configPath, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid config at ${configPath}:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return applyEnvOverrides(parsed.data);
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
 * Merge a repo's `.review-helper.yml` over the global config.
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
