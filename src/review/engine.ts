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
import {
  appendEntry,
  classifyOutcomes,
  formatReviewHistory,
  loadReviewHistory,
  saveReviewHistory,
  type ReviewHistory,
} from "../context/reviewHistory.js";
import { formatDiscussion, buildReviewCommentBody } from "./format.js";
import type { SCMConnector, RepoRef } from "../platform/types.js";
import { createProvider, type LLMProvider } from "../llm/index.js";
import { logger } from "../logger.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { buildPromptDiff, includedPaths } from "./diff.js";
import {
  ReviewResultSchema,
  type ReviewResult,
  buildReviewResultJsonSchema,
} from "./types.js";
import { completeWithRetry } from "../llm/retry.js";

export interface ReviewDeps {
  connector: SCMConnector;
  baseConfig: Config;
  /** Used in the failure message so the author knows the exact command to retry. */
  reviewerLogin?: string;
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
  opts: { dryRun?: boolean; round?: number; progressCommentId?: number } = {},
): Promise<
  ReviewResult & {
    progressCommentId: number | null;
    stale: boolean;
    headSha: string;
  }
> {
  const { connector } = deps;
  const round = opts.round ?? 1;
  const log = logger.child({
    repo: `${ref.owner}/${ref.repo}`,
    pr: number,
    round,
  });

  // Each round gets its own fresh progress comment so each round's verdict
  // is preserved independently. progressCommentId is only non-null during a
  // retry of the *same* round (stale discard path) - never across rounds.
  let startingCommentId: number | null = opts.progressCommentId ?? null;

  const pr = await connector.fetchPR(ref, number);
  log.info({ files: pr.changedFiles.length, state: pr.state }, "Fetched PR");

  if (pr.state !== "open" && !opts.dryRun) {
    log.info({ state: pr.state }, "PR is not open - skipping review");
    if (startingCommentId !== null) {
      await connector
        .editComment(
          ref,
          startingCommentId,
          `⏭️ **Review skipped** - this PR is already ${pr.state}.`,
        )
        .catch(() => undefined);
    }
    return {
      prSummary: "",
      summary: `PR is ${pr.state}.`,
      action: "COMMENT",
      filesSummary: [],
      comments: [],
      progressCommentId: startingCommentId,
      stale: false,
      headSha: "",
    };
  }
  if (!opts.dryRun) {
    if (startingCommentId !== null) {
      // Same-round retry (stale discard): update the existing placeholder
      // rather than posting another one.
      await connector
        .editComment(ref, startingCommentId, `_Starting review\u2026_`)
        .catch((err) =>
          log.warn({ err }, "Failed to update progress comment on retry"),
        );
    } else {
      // Fresh start for this round.
      const label =
        round >= 2
          ? "_Starting final review\u2026_"
          : "_Starting review\u2026_";
      startingCommentId = await connector
        .postComment(ref, number, label)
        .catch((err) => {
          log.warn({ err }, "Failed to post starting comment");
          return null;
        });
    }
  }

  // If the engine throws after posting the progress comment, update it to
  // show an error state so the author isn't left staring at "Starting review...".
  const failSafe = async (err: unknown) => {
    if (!opts.dryRun && startingCommentId !== null) {
      const retryHint = deps.reviewerLogin
        ? ` Comment \`@${deps.reviewerLogin} retry\` to try again.`
        : "";
      await connector
        .editComment(
          ref,
          startingCommentId,
          `⚠️ **Review failed.**${retryHint}\n\n<sub>${String(err).slice(0, 200)}</sub>`,
        )
        .catch(() => undefined); // best-effort; don't mask the original error
    }
    throw err;
  };

  try {
    // Three-level config merge: global defaults → org config → per-repo config.
    // All files are read from the base branch (not the PR head) - a PR author
    // cannot influence Zanuda's behaviour by editing them in their branch.
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
          repoMemory = await generateRepoMemory(ref, context, config, provider);
          saveRepoMemory(config, ref, repoMemory);
          log.info("Repo memory generated and saved");
        } catch (err) {
          log.warn(
            { err },
            "Failed to generate repo memory - proceeding without it",
          );
        }
      }
    }

    const reviewHistory: ReviewHistory | null = config.memory.enabled
      ? loadReviewHistory(config, ref)
      : null;

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

    // ── Context-window pre-flight ─────────────────────────────────────
    // For models with small context windows (local models, LM Studio),
    // trim the diff budget so the total prompt fits without crashing.
    const maxContextTokens = parseMaxContextTokens();
    const effectiveDiffChars = maxContextTokens
      ? adjustedDiffBudget(
          config,
          context.text,
          pr.files.length,
          maxContextTokens,
        )
      : config.review.maxDiffChars;
    if (effectiveDiffChars < config.review.maxDiffChars) {
      log.warn(
        {
          maxContextTokens,
          originalMaxDiffChars: config.review.maxDiffChars,
          adjustedMaxDiffChars: effectiveDiffChars,
        },
        "Diff budget reduced to fit model context window",
      );
    }

    // Build a budget-aware diff from per-file patches so the model always
    // receives complete file diffs rather than an arbitrary truncated blob.
    const promptDiff = buildPromptDiff(pr.files, effectiveDiffChars);
    if (promptDiff.truncated) {
      log.info(
        {
          included: promptDiff.includedFiles.length,
          excluded: promptDiff.excludedFiles.length,
          total: pr.files.length,
        },
        "Large PR: diff assembled from per-file patches (some files excluded)",
      );
    }

    const completion = await completeWithRetry(provider, {
      system: buildSystemPrompt(config),
      user: buildUserPrompt(pr, context, config, {
        round,
        discussion,
        repoMemory: repoMemory ?? undefined,
        reviewHistory: reviewHistory
          ? formatReviewHistory(reviewHistory)
          : undefined,
        instructions,
        promptDiff,
        // When the provider enforces the schema at the API level
        // (tool_use / json_schema strict mode), output instructions can
        // be omitted from the prompt. When it only guarantees valid JSON
        // (json_object mode), the prompt must carry the format instructions
        // so the model knows the expected shape.
        structuredOutput: provider.supportsStructuredOutput,
      }),
      model: config.models[config.provider],
      temperature: config.generation.temperature,
      maxTokens: adaptiveMaxTokens(
        promptDiff.includedFiles.length,
        config.generation.maxTokens,
      ),
      jsonSchema: buildReviewResultJsonSchema(config.review.maxCommentChars),
    });
    log.info(
      { provider: completion.provider, model: completion.model },
      "Model responded",
    );

    const result = parseReviewResult(completion.text, {
      structured: provider.supportsStructuredOutput,
    });
    const diffTruncated = promptDiff.truncated;

    // ── Stale-commit guard ──────────────────────────────────────────────────
    // The LLM call can take 30-60 s. If the author pushed new commits in that
    // window, pr.headSha is now outdated. Posting a review anchored to the old
    // SHA would immediately mark every inline comment as "outdated" and burn a
    // review round on code that no longer exists.
    //
    // Fix: re-fetch the current head SHA before posting. If it changed, discard
    // the result, update the progress comment, and return stale=true so the
    // poller does NOT increment the round counter. The next poll will start a
    // fresh review on the new HEAD.
    if (!opts.dryRun) {
      let currentHead: string | null = null;
      try {
        const fresh = await connector.fetchPR(ref, number);
        currentHead = fresh.headSha;
      } catch (err) {
        log.warn(
          { err },
          "Stale-check: failed to re-fetch PR head - proceeding anyway",
        );
      }

      if (currentHead !== null && currentHead !== pr.headSha) {
        log.info(
          { oldHead: pr.headSha, newHead: currentHead },
          "PR head changed during review - discarding stale result",
        );
        if (startingCommentId !== null) {
          await connector
            .editComment(
              ref,
              startingCommentId,
              `🔄 **New commits pushed during review** - discarding stale result. Will re-review on the next poll cycle.`,
            )
            .catch(() => undefined);
        }
        return {
          ...result,
          progressCommentId: startingCommentId,
          stale: true,
          headSha: pr.headSha,
        };
      }
    }

    if (!opts.dryRun) {
      // Try to edit the progress comment to show the final verdict.
      let progressCommentUpdated = false;
      if (startingCommentId !== null) {
        try {
          await connector.editComment(
            ref,
            startingCommentId,
            buildReviewCommentBody(result, pr.changedFiles.length, {
              diffTruncated,
            }),
          );
          progressCommentUpdated = true;
        } catch (err) {
          log.warn({ err }, "Failed to update starting comment");
        }
      }

      // Post the review. If the progress comment wasn't updated (either because
      // it never existed or the edit failed), postReview will include the summary
      // in the review body as a fallback.
      // Pass the set of file paths whose diff was visible so the connector can
      // strip comments on unseen files before anchoring, preventing 422s.
      await connector.postReview(pr, result, config, {
        summaryPostedElsewhere: progressCommentUpdated,
        visibleFilePaths: includedPaths(promptDiff),
      });
      log.info(
        {
          comments: result.comments.length,
          summaryPostedElsewhere: progressCommentUpdated,
        },
        "Review posted",
      );
    }

    // ── Repo memory update ────────────────────────────────────────────────────────────────
    // Skip the update check for small PRs: a PR under this threshold almost
    // never reveals new architecture, style patterns, or invariants worth
    // persisting. Saves one full LLM round-trip (~1750 input + 2048 max output
    // tokens) that almost always returns {update: false} anyway.
    const totalChangedLines = pr.files.reduce(
      (sum, f) => sum + f.additions + f.deletions,
      0,
    );
    // Always run the update check when we have a round-2 discussion — even a
    // tiny PR can yield calibration notes if the developer pushed back on a
    // comment. For round-1 reviews with no discussion, keep the line threshold
    // to avoid a pointless LLM call that almost always returns {update: false}.
    const MEMORY_UPDATE_MIN_LINES = 100;
    if (
      config.memory.enabled &&
      repoMemory &&
      (discussion !== undefined || totalChangedLines >= MEMORY_UPDATE_MIN_LINES)
    ) {
      try {
        const updated = await maybeUpdateRepoMemory(
          ref,
          repoMemory,
          pr.title,
          number,
          pr.changedFiles,
          result.summary,
          pr.diff,
          discussion,
          config,
          provider,
        );
        if (updated) saveRepoMemory(config, ref, updated);
      } catch (err) {
        log.warn({ err }, "Failed to update repo memory - ignoring");
      }
    }

    // ── Review history update (round 2 only) ─────────────────────────────────
    // Classify how each round-1 inline comment was resolved, then append a new
    // history entry. Runs after the review is posted so a classification failure
    // never prevents the review from going through.
    if (config.memory.enabled && discussion !== undefined && round >= 2) {
      try {
        const outcomes = await classifyOutcomes(
          number,
          pr.title,
          discussion,
          config,
          provider,
        );
        const entry = {
          prNumber: number,
          prTitle: pr.title,
          date: new Date().toISOString().slice(0, 10),
          finalAction: result.action,
          outcomes,
        };
        const history = reviewHistory ?? { entries: [] };
        const updated = appendEntry(
          history,
          entry,
          config.memory.maxHistoryEntries,
        );
        saveReviewHistory(config, ref, updated);
        log.info({ outcomes: outcomes.length }, "Review history updated");
      } catch (err) {
        log.warn({ err }, "Failed to update review history - ignoring");
      }
    }

    return {
      ...result,
      progressCommentId: startingCommentId,
      stale: false,
      headSha: pr.headSha,
    };
  } catch (err) {
    await failSafe(err);
    throw err; // unreachable - failSafe always rethrows; satisfies TypeScript
  }
}

/**
 * Scale the completion token budget to the actual PR size instead of always
 * reserving the configured maximum.
 *
 * Output budget per file:
 *   ~30 tokens for the filesSummary entry
 *   ~80 tokens for an inline comment (typically 1–2 per file reviewed)
 *   = ~120 tokens/file, doubled for headroom = ~240 tokens/file
 *
 * The configured maxTokens acts as a hard ceiling.
 */
export function adaptiveMaxTokens(
  fileCount: number,
  configuredMax: number,
): number {
  const estimated = fileCount * 240 + 400; // 400 fixed: summary + action + JSON structure
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
 * (via the LLM_MAX_CONTEXT_TOKENS env var — a hardware constraint, not a
 * semantic config choice, so it lives in env, not YAML).
 *
 * Overhead estimation:
 *   - System prompt (config.preprompt)
 *   - Project context (contextText from buildContext)
 *   - Fixed task instructions (~2500 chars / ~700 tokens)
 *   - Output budget (adaptiveMaxTokens)
 *
 * Token estimation uses a conservative 3.5 chars/token (code ~4, English ~3).
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

  // Task instructions + JSON schema description + round boilerplate.
  // Measured from prompt.ts outputInstructions ~= 2500 chars.
  // Verified by test: "prompt.ts outputInstructions token budget".
  const FIXED_TASK_TOKENS = 700;

  const nonDiffTokens =
    systemTokens + contextTokens + FIXED_TASK_TOKENS + outputTokens;
  const availableDiffTokens = Math.max(0, maxContextTokens - nonDiffTokens);

  // Floor: always leave room for at least 2000 chars of diff so the model
  // has something to review — an empty diff is useless.
  const effectiveDiffChars = Math.max(
    2000,
    Math.floor(availableDiffTokens * 3.5),
  );

  return Math.min(effectiveDiffChars, config.review.maxDiffChars);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Parse the model's response into a ReviewResult.
 *
 * When the provider used structured output (jsonSchema), `text` is already
 * clean JSON and we skip extractJson. When it's a plain text response we run
 * the full extraction pipeline as a fallback.
 */
export function parseReviewResult(
  text: string,
  opts: { structured?: boolean } = {},
): ReviewResult {
  let parsed: ReviewResult;
  if (opts.structured) {
    // Response is guaranteed JSON from the provider — parse directly.
    parsed = ReviewResultSchema.parse(JSON.parse(text));
  } else {
    const json = extractJson(text);
    parsed = ReviewResultSchema.parse(JSON.parse(json));
  }

  // Warn when any field fell back to its catch/default value so the
  // occurrence is visible in logs without crashing the review.
  const fallbacks: string[] = [];
  if (parsed.summary === "") fallbacks.push("summary");
  if (parsed.action === "COMMENT" && !text.includes("COMMENT"))
    fallbacks.push("action");
  if (
    parsed.filesSummary.length === 0 &&
    text.includes("filesSummary") === false
  )
    fallbacks.push("filesSummary");
  if (fallbacks.length > 0) {
    logger.warn(
      { fallbacks, rawResponse: text.slice(0, 300) },
      "Model returned malformed structured output — fallback values applied",
    );
  }

  return parsed;
}

/**
 * Extract a JSON object from the model's response.
 *
 * Strategy:
 * 1. Use brace-depth scanning from the first `{` to the matching `}` - this
 *    correctly handles trailing prose that might contain stray `}` characters.
 * 2. If no opening brace is found, try stripping a wrapping code fence and retry.
 *
 * Delegates actual JSON validation to `JSON.parse` rather than re-implementing
 * escape-sequence handling.
 */
export function extractJson(text: string): string {
  const json = tryExtractBalanced(text);
  if (json) return json;

  // Fallback: strip a wrapping code fence (model sometimes wraps in ```json).
  const fenced = text.match(/^```(?:json)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/);
  if (fenced) {
    const inner = fenced[1]!.trim();
    const json = tryExtractBalanced(inner);
    if (json) return json;
  }

  throw new Error(
    `No JSON object found in model response: ${text.slice(0, 200)}`,
  );
}

function tryExtractBalanced(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

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
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          JSON.parse(slice); // validate
          return slice;
        } catch {
          return null; // malformed JSON
        }
      }
    }
  }

  return null; // unclosed brace
}
