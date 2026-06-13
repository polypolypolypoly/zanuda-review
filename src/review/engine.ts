import { mergeRepoConfig, type Config } from "../config.js";
import { buildContext } from "../context/builder.js";
import {
  fetchInstructions,
  fetchOrgConfig,
  fetchOrgInstructions,
  fetchRepoConfig,
} from "../context/repoConfig.js";
import {
  generateRepoMemory,
  loadRepoMemory,
  maybeUpdateRepoMemory,
  saveRepoMemory,
} from "../context/repoMemory.js";
import { formatDiscussion } from "../github/comments.js";
import type { SCMConnector, RepoRef } from "../platform/types.js";
import { createProvider, type LLMProvider } from "../llm/index.js";
import { logger } from "../logger.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { ReviewResultSchema, type ReviewResult } from "./types.js";

export interface ReviewDeps {
  connector: SCMConnector;
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
  opts: { dryRun?: boolean; round?: number } = {},
): Promise<ReviewResult> {
  const { connector } = deps;
  const round = opts.round ?? 1;
  const log = logger.child({
    repo: `${ref.owner}/${ref.repo}`,
    pr: number,
    round,
  });

  const pr = await connector.fetchPR(ref, number);
  log.info({ files: pr.changedFiles.length }, "Fetched PR");

  // Three-level config merge: global defaults → org config → per-repo config.
  // All files are read from the base branch (not the PR head) — a PR author
  // cannot influence the bot's behaviour by editing them in their branch.
  const [orgConfig, repoConfig, orgInstructions, repoInstructions] =
    await Promise.all([
      fetchOrgConfig(connector, ref.owner),
      fetchRepoConfig(connector, ref, pr.baseSha),
      fetchOrgInstructions(connector, ref.owner),
      fetchInstructions(connector, ref, pr.baseSha),
    ]);
  const config = mergeRepoConfig(
    mergeRepoConfig(deps.baseConfig, orgConfig),
    repoConfig,
  );
  const instructions =
    [orgInstructions, repoInstructions].filter(Boolean).join("\n\n") ||
    undefined;
  log.info(
    {
      provider: config.provider,
      model: config.models[config.provider],
      hasOrgConfig: orgConfig !== null,
      hasRepoConfig: repoConfig !== null,
      hasOrgInstructions: orgInstructions !== null,
      hasRepoInstructions: repoInstructions !== null,
    },
    "Config resolved",
  );

  const context = await buildContext(connector, ref, pr.baseSha, config);

  // ── Provider + repo memory ──────────────────────────────────────────────────
  const provider: LLMProvider = createProvider(config.provider);

  let repoMemory: string | null = null;
  if (config.memory.enabled) {
    repoMemory = loadRepoMemory(config, ref);
    if (!repoMemory) {
      try {
        repoMemory = await generateRepoMemory(
          connector,
          ref,
          pr.baseSha,
          config,
          provider,
        );
        saveRepoMemory(config, ref, repoMemory);
        log.info("Repo memory generated and saved");
      } catch (err) {
        log.warn(
          { err },
          "Failed to generate repo memory — proceeding without it",
        );
      }
    }
  }

  // On round 2, include the full PR discussion so the model can judge whether
  // issues from round 1 were addressed.
  let discussion: string | undefined;
  if (round >= 2) {
    const comments = await connector.fetchDiscussion(ref, number);
    discussion = formatDiscussion(comments);
    log.info(
      { commentCount: comments.length },
      "Fetched PR discussion for round 2",
    );
  }

  const completion = await provider.complete({
    system: buildSystemPrompt(config),
    user: buildUserPrompt(pr, context, config, {
      round,
      discussion,
      repoMemory: repoMemory ?? undefined,
      instructions,
    }),
    model: config.models[config.provider],
    temperature: config.generation.temperature,
    maxTokens: config.generation.maxTokens,
  });
  log.info(
    { provider: completion.provider, model: completion.model },
    "Model responded",
  );

  const result = parseReviewResult(completion.text);
  result.comments = result.comments.filter((c) => c.severity !== "nitpick");

  // Round 2 is the final review — REQUEST_CHANGES must never be used here.
  if (round >= 2 && result.action === "REQUEST_CHANGES") {
    result.action = "COMMENT";
    log.info("Round 2: coerced REQUEST_CHANGES → COMMENT to avoid blocking PR");
  }

  if (!opts.dryRun) {
    await connector.postReview(pr, result, config);
    log.info({ comments: result.comments.length }, "Review posted");
  }

  // ── Repo memory update ────────────────────────────────────────────────────
  if (config.memory.enabled && repoMemory) {
    try {
      const updated = await maybeUpdateRepoMemory(
        ref,
        repoMemory,
        pr.title,
        pr.changedFiles,
        result.summary,
        pr.diff,
        config,
        provider,
      );
      if (updated) saveRepoMemory(config, ref, updated);
    } catch (err) {
      log.warn({ err }, "Failed to update repo memory — ignoring");
    }
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
 */
export function extractJson(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error(
      `No JSON object found in model response: ${text.slice(0, 200)}`,
    );
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(
    `Unterminated JSON object in model response: ${text.slice(0, 200)}`,
  );
}
