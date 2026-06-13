import type { Octokit } from "@octokit/rest";
import { mergeRepoConfig, type Config } from "../config.js";
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
  baseConfig: Config;
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

  // Use the BASE branch SHA (not the PR head) for both the repo config and the
  // project context files. The base branch is under the maintainer's control;
  // using the head SHA would let a PR author influence the bot's behaviour by
  // committing a crafted .review-helper.yml or editing README/CONTRIBUTING.
  const repoConfig = await fetchRepoConfig(octokit, ref, pr.baseSha);
  const config = mergeRepoConfig(deps.baseConfig, repoConfig);
  log.info({ provider: config.provider, model: config.models[config.provider] }, "Config resolved");

  const context = await buildContext(octokit, ref, pr.baseSha, config);

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
 * Extract the outermost JSON object from the model's response.
 *
 * Walks character-by-character tracking brace depth and string state so it
 * stops at the *matching* closing brace rather than the last `}` in the text.
 * This is immune to:
 *  - Prose appended after the JSON block.
 *  - Code fences wrapping the JSON.
 *  - Nested `}` characters inside JSON string values (e.g. embedded snippets).
 */
export function extractJson(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error(`No JSON object found in model response: ${text.slice(0, 200)}`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`Unterminated JSON object in model response: ${text.slice(0, 200)}`);
}
