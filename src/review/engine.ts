import type { Octokit } from "@octokit/rest";
import { loadConfig, mergeRepoConfig, type Config } from "../config.js";
import { buildContext } from "../context/builder.js";
import { fetchRepoConfig } from "../context/repoConfig.js";
import type { RepoRef } from "../github/client.js";
import { postReview } from "../github/postReview.js";
import { fetchPullRequest } from "../github/pullRequest.js";
import { createProvider, type LLMProvider } from "../llm/index.js";
import { logger } from "../logger.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { ReviewResultSchema, type ReviewResult } from "./types.js";

export interface ReviewDeps {
  octokit: Octokit;
  baseConfig?: Config;
}

/**
 * End-to-end review of a single PR:
 *   fetch PR + repo config → merge config → build context → prompt the model
 *   → parse → post comments.
 * `dryRun` returns the parsed result without posting (used by the CLI).
 */
export async function reviewPullRequest(
  deps: ReviewDeps,
  ref: RepoRef,
  number: number,
  opts: { dryRun?: boolean } = {},
): Promise<ReviewResult> {
  const { octokit } = deps;
  const log = logger.child({ repo: `${ref.owner}/${ref.repo}`, pr: number });

  const pr = await fetchPullRequest(octokit, ref, number);
  log.info({ files: pr.changedFiles.length }, "Fetched PR");

  const base = deps.baseConfig ?? loadConfig();
  const repoConfig = await fetchRepoConfig(octokit, ref, pr.headSha);
  const config = mergeRepoConfig(base, repoConfig);
  log.info({ provider: config.provider, model: config.models[config.provider] }, "Config resolved");

  const context = await buildContext(octokit, ref, pr.headSha, config);

  const provider: LLMProvider = createProvider(config.provider);
  const completion = await provider.complete({
    system: buildSystemPrompt(config),
    user: buildUserPrompt(pr, context, config),
    model: config.models[config.provider],
    temperature: config.generation.temperature,
    maxTokens: config.generation.maxTokens,
  });
  log.info({ provider: completion.provider, model: completion.model }, "Model responded");

  const result = parseReviewResult(completion.text);

  if (!opts.dryRun) {
    await postReview(octokit, pr, result, config);
    log.info({ comments: result.comments.length }, "Review posted");
  }
  return result;
}

/** Parse the model's JSON, tolerating accidental code fences / prose wrapping. */
export function parseReviewResult(text: string): ReviewResult {
  const json = extractJson(text);
  return ReviewResultSchema.parse(JSON.parse(json));
}

/**
 * Extract the JSON object from the model's response.
 *
 * We use a first-brace / last-brace heuristic rather than a code-fence regex
 * because the regex approach is fragile: a non-greedy ``` match fires on the
 * *first* closing fence, which may be inside a JSON string value when the
 * model embeds a code snippet in a comment body (e.g. ```python\n...\n```).
 * The brace heuristic is immune to that and handles both bare JSON and
 * JSON wrapped in a ``` block.
 */
export function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  throw new Error(`No JSON object found in model response: ${text.slice(0, 200)}`);
}
