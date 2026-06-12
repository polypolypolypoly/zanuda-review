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
  review: z.object({
    maxDiffChars: z.number().int().positive(),
    inlineComments: z.boolean(),
    event: z.enum(["COMMENT", "REQUEST_CHANGES", "APPROVE"]),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

/** A repo-supplied `.review-helper.yml` may override a subset of the config. */
export const RepoConfigSchema = ConfigSchema.partial().extend({
  // Convenience: a repo can append extra instructions without replacing the
  // whole preprompt.
  prepromptAppend: z.string().optional(),
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
  const provider = process.env.LLM_PROVIDER as Config["provider"] | undefined;
  if (provider) config.provider = ConfigSchema.shape.provider.parse(provider);
  if (process.env.LLM_MODEL) {
    config.models[config.provider] = process.env.LLM_MODEL;
  }
  return config;
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
