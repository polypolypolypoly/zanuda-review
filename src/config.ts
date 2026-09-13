import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { logger } from "./logger.js";

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
    /**
     * Path to the daily-budget counter file.
     * Empty string or absent = ~/.zanuda/daily-budget.json
     */
    budgetFile: z.string().optional(),
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
    /**
     * Per-PR token budget (input + output). 0 = no limit. Default matches
     * config/default.yaml (a full 10-batch review with verification); keep the
     * schema default in sync so an omitted key cannot silently lift the cap.
     */
    tokenBudgetPerPR: z.number().int().nonnegative().default(400_000),
    /**
     * Hard cap on review batches per PR. Prevents unbounded LLM cost on
     * pathological PRs with hundreds of changed files. Beyond this limit,
     * the highest-signal batches are selected and unreviewed files are
     * noted honestly in the verdict comment. 0 = no limit.
     */
    maxBatches: z.number().int().nonnegative().default(10),
    /**
     * Global cap on review rounds started per UTC day, across every repo.
     * The outermost spend backstop; 0 = no limit. Deferred PRs are still
     * requested on the platform, so they are picked up the next day.
     * Default matches config/default.yaml — keep in sync.
     */
    maxReviewRoundsPerDay: z.number().int().nonnegative().default(50),
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
    maxCommentChars: z.number().int().min(400).default(800),
    /** Self-verification: after review, a second LLM call checks each finding
     * against the diff. Disable for budget-constrained self-hosters. */
    verifyFindings: z.boolean().default(true),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

/** A repo-supplied `.zanuda/config.yml` may override a subset of the config. */
export const RepoConfigSchema = ConfigSchema.partial().extend({
  // Convenience: a repo can append extra instructions without replacing the
  // whole preprompt.
  prepromptAppend: z.string().optional(),
  // Make nested objects partial so overlay/repo configs can specify only the
  // fields they need, without restating every field from defaults.
  // The schema stays permissive — it is shared with the operator's
  // ZANUDA_CONFIG overlay, which may set everything. Operator-only keys are
  // dropped from untrusted repo/org configs at merge time (see
  // stripOperatorOnly).
  persistence: ConfigSchema.shape.persistence.partial().optional(),
  memory: ConfigSchema.shape.memory.partial().optional(),
  context: ConfigSchema.shape.context.partial().optional(),
  review: ConfigSchema.shape.review.partial().optional(),
  generation: ConfigSchema.shape.generation.partial().optional(),
  limits: ConfigSchema.shape.limits.partial().optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/**
 * Keys an untrusted `.zanuda/config.yml` (org or repo) may not set.
 *
 * Two reasons, both about the operator rather than the repo:
 *   - filesystem and process control — `persistence` (the whole section:
 *     `stateFile` and `commitLogFile` are both paths the service account
 *     writes) and `memory.dir` decide where the service account creates
 *     directories and writes LLM output;
 *   - operator cost — `provider` picks which API key gets burned, and
 *     `limits` / `generation.maxTokens` are the spend backstops.
 *
 * `access` and `models` are dropped for the same reason. Everything else
 * (memory.enabled, context, review flags, prepromptAppend) stays
 * repo-overridable: those tune the review, not the operator's machine.
 *
 * This is the single authoritative list of operator-only keys: every key a
 * repo/org config must not be able to set is stripped here, and every strip is
 * logged so the operator gets an audit trail for attempted config escalation.
 */
function stripOperatorOnly(repo: RepoConfig): RepoConfig {
  const {
    persistence: _persistence,
    limits: _limits,
    provider: _provider,
    models: _models,
    access: _access,
    ...rest
  } = repo;

  // The repo author gets no signal that their override was ignored, so the
  // operator's log is the only record — and the audit trail for a config
  // attempting to steer the operator's filesystem or API spend.
  const stripped: string[] = [];
  if (repo.persistence !== undefined) stripped.push("persistence");
  if (repo.limits !== undefined) stripped.push("limits");
  if (repo.provider !== undefined) stripped.push("provider");
  if (repo.models !== undefined) stripped.push("models");
  if (repo.access !== undefined) stripped.push("access");
  if (repo.memory?.dir !== undefined) stripped.push("memory.dir");
  if (repo.generation?.maxTokens !== undefined) {
    stripped.push("generation.maxTokens");
  }
  if (stripped.length > 0) {
    logger.warn(
      { strippedKeys: stripped },
      "Dropped operator-only keys from org/repo .zanuda/config.yml",
    );
  }

  const memory = repo.memory ? { ...repo.memory } : undefined;
  if (memory) delete memory.dir;

  const generation = repo.generation ? { ...repo.generation } : undefined;
  if (generation) delete generation.maxTokens;

  return { ...rest, memory, generation };
}

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
    config = mergeOperatorConfig(config, overlayParsed.data);
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
 * Merge an untrusted org or repo `.zanuda/config.yml` over the current config.
 *
 * Shallow per-section; `prepromptAppend` is concatenated onto the preprompt.
 * Nested objects are merged field-by-field and undefined repo fields are
 * ignored — the base config value is preserved.
 *
 * Operator-only keys are dropped by stripOperatorOnly before merging. A repo
 * config is written by whoever can commit to the repo's base branch, which is
 * not the operator running Zanuda.
 */
export function mergeRepoConfig(base: Config, repo: RepoConfig | null): Config {
  if (!repo) return base;
  return mergeConfig(base, stripOperatorOnly(repo));
}

/**
 * Merge the operator's own ZANUDA_CONFIG overlay over the packaged defaults.
 * The overlay is a local file under the operator's control, so every key
 * applies — including `access.allowlist`, `models` and the spend limits.
 */
export function mergeOperatorConfig(
  base: Config,
  overlay: RepoConfig | null,
): Config {
  return overlay ? mergeConfig(base, overlay) : base;
}

function mergeConfig(base: Config, repo: RepoConfig): Config {
  const mergeSection = <T extends object>(
    baseVal: T,
    repoVal?: Partial<T>,
  ): T => (repoVal ? { ...baseVal, ...stripUndefined(repoVal) } : baseVal);

  const merged: Config = {
    ...base,
    ...stripUndefined(repo),
    models: mergeSection(base.models, repo.models),
    access: mergeSection(base.access, repo.access),
    generation: mergeSection(base.generation, repo.generation),
    persistence: mergeSection(base.persistence, repo.persistence),
    memory: mergeSection(base.memory, repo.memory),
    context: mergeSection(base.context, repo.context),
    review: mergeSection(base.review, repo.review),
    limits: mergeSection(base.limits, repo.limits),
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
