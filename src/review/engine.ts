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
import {
  filterReviewComments,
  filterReviewVerdict,
  formatFilterSummary,
} from "./filters.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { buildPromptDiff, includedPaths } from "./diff.js";
import { type ReviewResult, buildReviewResultJsonSchema } from "./types.js";
import { completeWithRetry } from "../llm/retry.js";
import { batchChangedFiles } from "./chunk.js";
import { parseReviewResult } from "./parse.js";
import { verifyFindings } from "./verify.js";
import {
  adaptiveMaxTokens,
  parseMaxContextTokens,
  adjustedDiffBudget,
  logPromptSize,
} from "./budget.js";
import { buildHeaderedFiles, reviewBatched } from "./batch.js";
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
  opts: {
    dryRun?: boolean;
    round?: number;
    progressCommentId?: number;
    /** Force a specific review strategy for evaluation. "single" skips the
     * batch path entirely; "batch" forces multi-batch even for small PRs;
     * Undefined = auto-detect based on PR size. */
    forceStrategy?: "single" | "batch";
  } = {},
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
          provider.maxOutputTokens,
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

    // ── Large PR detection ──────────────────────────────────────────
    // ~14K tokens per batch keeps each batch within the model's strong
    // attention window. Batches are capped at this size regardless of
    // the overall diff budget.
    const forceStrategy = opts.forceStrategy;
    const MAX_BATCH_CHARS = 50_000;
    // forceStrategy="batch" uses a tiny batch size to force splitting.
    const batchChars =
      forceStrategy === "batch"
        ? 500
        : Math.min(effectiveDiffChars, MAX_BATCH_CHARS);

    // Estimate total diff size from per-file patches to decide whether
    // we need the batch path. This is a cheap check that avoids N extra
    // GitHub API calls (readFile) on small PRs — upholding the
    // "zero overhead" claim for the common single-batch case.
    const totalPatchChars = pr.files.reduce(
      (sum, f) => sum + (f.patch?.length ?? 0),
      0,
    );

    const useBatchPath =
      forceStrategy === "single"
        ? false
        : forceStrategy === "batch"
          ? true
          : totalPatchChars > batchChars;

    if (useBatchPath) {
      const headered = await buildHeaderedFiles(connector, ref, pr);
      const batches = batchChangedFiles(headered, batchChars);

      if (batches.length > 1) {
        log.info(
          { batches: batches.length, totalFiles: pr.files.length },
          "Large PR: using dependency-aware batch review",
        );
        return reviewBatched(pr, batches, {
          deps,
          ref,
          number,
          round,
          dryRun: opts.dryRun ?? false,
          startingCommentId,
          context,
          config,
          provider,
          instructions,
          repoMemory,
          reviewHistory,
          discussion,
          log,
        });
      }
    }

    // Single batch — existing single-call path below.
    // Build a budget-aware diff from per-file patches so the model always
    // receives complete file diffs rather than an arbitrary truncated blob.
    // Use batchChars (already capped at MAX_BATCH_CHARS) not effectiveDiffChars
    // so single-batch PRs also benefit from the attention cap.
    const promptDiff = buildPromptDiff(pr.files, batchChars);
    if (promptDiff.truncated) {
      log.info(
        {
          included: promptDiff.includedFiles.length,
          excluded: promptDiff.excludedFiles.length,
          total: pr.files.length,
          budgetChars: batchChars,
        },
        "Large PR: diff assembled from per-file patches (some files excluded)",
      );
    }

    const systemPrompt = buildSystemPrompt(config);
    const userPrompt = buildUserPrompt(pr, context, config, {
      round,
      discussion,
      repoMemory: repoMemory ?? undefined,
      reviewHistory: reviewHistory
        ? formatReviewHistory(reviewHistory)
        : undefined,
      instructions,
      promptDiff,
      structuredOutput: provider.supportsStructuredOutput,
    });

    const outputTokens = adaptiveMaxTokens(
      promptDiff.includedFiles.length,
      config.generation.maxTokens,
      provider.maxOutputTokens,
    );

    logPromptSize({
      systemChars: systemPrompt.length,
      userChars: userPrompt.length,
      provider: config.provider,
      model: config.models[config.provider],
      maxOutputTokens: outputTokens,
    });

    const completion = await completeWithRetry(provider, {
      system: systemPrompt,
      user: userPrompt,
      model: config.models[config.provider],
      temperature: config.generation.temperature,
      maxTokens: outputTokens,
      jsonSchema: buildReviewResultJsonSchema(config.review.maxCommentChars, {
        round,
      }),
    });
    log.info(
      { provider: completion.provider, model: completion.model },
      "Model responded",
    );

    const parsed = parseReviewResult(completion.text, {
      structured: provider.supportsStructuredOutput,
    });

    // Self-verification: filter findings through a second pass
    const verifiedComments =
      parsed.comments.length > 0 && config.review.verifyFindings
        ? await verifyFindings(
            parsed.comments,
            promptDiff.text,
            config,
            provider,
            log,
          )
        : [];

    const result: ReviewResult = {
      ...parsed,
      comments: verifiedComments,
    };

    // ── Hard output filters (non-LLM) ───────────────────────────────────────
    const filtered = filterReviewComments(result.comments, {
      maxCommentChars: config.review.maxCommentChars,
    });
    if (filtered.dropped.length > 0 || filtered.mutated.length > 0) {
      log.warn(formatFilterSummary(filtered));
    }
    result.comments = filtered.kept;

    // Verdict consistency: REQUEST_CHANGES needs at least one blocker.
    // Mutates result.action in place — the same object reference flows to
    // buildReviewCommentBody and postReview below.
    const verdictReason = filterReviewVerdict(result);
    if (verdictReason) {
      log.warn(`Verdict adjusted: ${verdictReason}`);
    }

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
      if (startingCommentId !== null) {
        try {
          await connector.editComment(
            ref,
            startingCommentId,
            buildReviewCommentBody(result, pr.changedFiles.length, {
              diffTruncated,
              reviewedFiles: promptDiff.includedFiles.length,
              round,
            }),
          );
        } catch (err) {
          log.warn({ err }, "Failed to update starting comment");
        }
      }

      // Post the review. The summary is always included in the review body
      // so the review is self-contained (not split across an issue comment).
      // The progress comment edit above is a convenience — it gives a quick
      // status — but the review body is the source of truth.
      await connector.postReview(pr, result, config, {
        summaryPostedElsewhere: false,
        visibleFilePaths: includedPaths(promptDiff),
      });
      log.info(
        {
          comments: result.comments.length,
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
