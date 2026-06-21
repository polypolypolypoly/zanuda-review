/**
 * Multi-batch review orchestration.
 *
 * When a PR exceeds the attention window (~50K chars), files are partitioned
 * into batches via dependency-aware clustering and reviewed sequentially or
 * in parallel. Each batch is independent — no running summaries to avoid
 * hallucination propagation.
 */

import { buildReviewCommentBody } from "./format.js";
import type { SCMConnector, RepoRef, PullRequest } from "../platform/types.js";
import type { LLMProvider } from "../llm/index.js";
import type { logger } from "../logger.js";
import {
  filterReviewComments,
  filterReviewVerdict,
  formatFilterSummary,
} from "./filters.js";
import { buildSystemPrompt, buildBatchUserPrompt } from "./prompt.js";
import { assembleBatchDiff, batchFilePaths } from "./diff.js";
import { type ReviewResult, buildReviewResultJsonSchema } from "./types.js";
import { completeWithRetry } from "../llm/retry.js";
import { headeredFile, type HeaderedFile } from "./header.js";
import { type Batch } from "./chunk.js";
import { parseReviewResult } from "./parse.js";
import { verifyFindings } from "./verify.js";
import { adaptiveMaxTokens, logPromptSize } from "./budget.js";
import {
  formatReviewHistory,
  type ReviewHistory,
} from "../context/reviewHistory.js";
import type { Config } from "../config.js";

interface BatchedReviewOpts {
  deps: {
    connector: SCMConnector;
    baseConfig: Config;
    reviewerLogin?: string;
  };
  ref: RepoRef;
  number: number;
  round: number;
  dryRun: boolean;
  startingCommentId: number | null;
  // ProjectContext — returned by buildContext(), avoiding circular import
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
  config: Config;
  provider: LLMProvider;
  instructions: string | undefined;
  repoMemory: string | null;
  reviewHistory: ReviewHistory | null;
  discussion: string | undefined;
  log: typeof logger;
}

export async function buildHeaderedFiles(
  connector: SCMConnector,
  ref: RepoRef,
  pr: PullRequest,
): Promise<HeaderedFile[]> {
  const result: HeaderedFile[] = [];

  // Fetch full file contents in parallel for all files with patches.
  // Use the base SHA — reading from headSha would let PR authors inject
  // misleading imports/declarations into the structural header context.
  // The diff itself still reflects the PR changes; the header is structural
  // context and must come from the maintainer-controlled base branch.
  const contents = await Promise.all(
    pr.files
      .filter((f) => f.patch)
      .map(async (f) => {
        try {
          const content = await connector.readFile(ref, f.filename, pr.baseSha);
          return { filename: f.filename, content, patch: f.patch! };
        } catch {
          return { filename: f.filename, content: null, patch: f.patch! };
        }
      }),
  );

  for (const { filename, content, patch } of contents) {
    if (content !== null) {
      const hf = headeredFile(filename, content, patch);
      if (hf) result.push(hf);
    } else {
      // Fallback: no full content available, use empty header.
      // Common causes: the file was added in this PR (doesn't exist at
      // baseSha — fetching from headSha would give us the content but
      // violates the trust boundary), or the file is too large / binary.
      // New files are exactly where structural context helps most; this
      // is a known trade-off in favour of security.
      result.push({ filename, header: "", patch, weight: patch.length });
    }
  }

  return result;
}

/**
 * Sequential multi-batch review of a large PR.
 *
 * Each batch reviews its files in isolation with a running summary from
 * previous batches as context. The final batch produces the overall verdict.
 * All inline comments are accumulated and posted together.
 */
export async function reviewBatched(
  pr: PullRequest,
  batches: Batch[],
  opts: BatchedReviewOpts,
): Promise<
  ReviewResult & {
    progressCommentId: number | null;
    stale: boolean;
    headSha: string;
  }
> {
  const {
    deps,
    ref,
    number,
    round,
    dryRun,
    startingCommentId,
    context,
    config,
    provider,
    instructions,
    repoMemory,
    reviewHistory,
    discussion,
    log,
  } = opts;

  const allComments: ReviewResult["comments"] = [];
  const allFilesSummary: ReviewResult["filesSummary"] = [];
  let finalResult: ReviewResult | null = null;

  // ── Token budget ─────────────────────────────────────────────────
  const tokenBudget = config.limits.tokenBudgetPerPR;
  let estimatedTokens = 0;
  const addTokens = (inputChars: number, outputChars: number) => {
    estimatedTokens +=
      Math.ceil(inputChars / 3.5) + Math.ceil(outputChars / 3.5);
  };
  const budgetExceeded = () =>
    tokenBudget > 0 && estimatedTokens >= tokenBudget;

  // ── maxBatches backstop ──────────────────────────────────────────
  // Prevent unbounded cost on pathological PRs. Beyond this, select the
  // highest-signal batches by weight and note unreviewed files honestly.
  // When config.limits.maxBatches is 0, there is no limit.
  const maxBatches = config.limits.maxBatches;
  let unreviewedFiles: string[] = [];
  let effectiveBatches = batches;
  if (maxBatches > 0 && batches.length > maxBatches) {
    const sortedBatches = [...batches].sort((a, b) => b.weight - a.weight);
    effectiveBatches = sortedBatches.slice(0, maxBatches);
    const skipped = sortedBatches.slice(maxBatches);
    unreviewedFiles = skipped.flatMap((b) => b.files.map((f) => f.filename));
    log.warn(
      {
        totalBatches: batches.length,
        kept: maxBatches,
        skipped: batches.length - maxBatches,
        unreviewedFiles: unreviewedFiles.length,
      },
      "maxBatches limit reached — selecting highest-signal batches",
    );
  }

  for (let i = 0; i < effectiveBatches.length; i++) {
    const batch = effectiveBatches[i]!;
    const isLast = i === effectiveBatches.length - 1;

    // Check token budget before starting this batch
    if (budgetExceeded()) {
      log.warn(
        {
          estimatedTokens,
          tokenBudget,
          batch: i + 1,
          remainingBatches: effectiveBatches.length - i,
        },
        "Token budget exceeded — stopping batch review",
      );
      if (!finalResult) {
        finalResult = {
          prSummary: "",
          summary: `Token budget of ${tokenBudget} exceeded after ${i} batch(es). ${effectiveBatches.length - i} batch(es) not reviewed.`,
          action: "COMMENT",
          filesSummary: allFilesSummary,
          comments: allComments,
        };
      }
      // Note skipped files
      for (let j = i; j < effectiveBatches.length; j++) {
        unreviewedFiles.push(
          ...effectiveBatches[j]!.files.map((f) => f.filename),
        );
      }
      break;
    }

    const batchDiff = assembleBatchDiff(batch.files);

    log.info(
      {
        batch: i + 1,
        totalBatches: effectiveBatches.length,
        files: batch.files.length,
        chars: batch.weight,
        isLast,
      },
      "Reviewing batch",
    );

    const systemPrompt = buildSystemPrompt(config);
    const userPrompt = buildBatchUserPrompt(pr, context, config, batchDiff, {
      batchIndex: i + 1,
      totalBatches: effectiveBatches.length,
      isLastBatch: isLast,
      round,
      discussion,
      repoMemory: repoMemory ?? undefined,
      reviewHistory: reviewHistory
        ? formatReviewHistory(reviewHistory)
        : undefined,
      instructions,
      structuredOutput: provider.supportsStructuredOutput,
    });

    const batchOutputTokens = adaptiveMaxTokens(
      batch.files.length,
      config.generation.maxTokens,
      provider.maxOutputTokens,
    );

    logPromptSize({
      systemChars: systemPrompt.length,
      userChars: userPrompt.length,
      provider: config.provider,
      model: config.models[config.provider],
      maxOutputTokens: batchOutputTokens,
    });

    const completion = await completeWithRetry(provider, {
      system: systemPrompt,
      user: userPrompt,
      model: config.models[config.provider],
      temperature: config.generation.temperature,
      maxTokens: batchOutputTokens,
      jsonSchema: buildReviewResultJsonSchema(config.review.maxCommentChars, {
        round,
      }),
    });

    const parsed = parseReviewResult(completion.text, {
      structured: provider.supportsStructuredOutput,
    });

    // Token budget tracking
    addTokens(
      config.preprompt.length + context.text.length + batchDiff.text.length,
      completion.text.length,
    );

    // Update progress comment between batches so the author knows progress.
    if (!dryRun && startingCommentId !== null && !isLast) {
      const blockerCount = allComments.filter(
        (c) => c.severity === "blocker",
      ).length;
      const warningCount = allComments.filter(
        (c) => c.severity === "warning",
      ).length;
      const parts: string[] = [
        `_Batch ${i + 1} of ${effectiveBatches.length} complete._`,
      ];
      if (blockerCount > 0)
        parts.push(
          `Found ${blockerCount} blocker(s), ${warningCount} warning(s).`,
        );
      else if (warningCount > 0)
        parts.push(`Found ${warningCount} warning(s).`);
      else parts.push("No issues found so far.");
      await deps.connector
        .editComment(ref, startingCommentId, parts.join(" "))
        .catch(() => undefined);
    }

    // Accumulate comments and file summaries (after verification)
    const batchComments =
      parsed.comments.length > 0 && config.review.verifyFindings
        ? await verifyFindings(
            parsed.comments,
            batchDiff.text,
            config,
            provider,
            log,
          )
        : [];

    allComments.push(...batchComments);
    allFilesSummary.push(...parsed.filesSummary);

    if (isLast) {
      finalResult = parsed;

      // If the final batch's action is COMMENT but we have blockers from
      // earlier batches, upgrade to REQUEST_CHANGES
      if (
        parsed.action === "COMMENT" &&
        allComments.some((c) => c.severity === "blocker")
      ) {
        finalResult = { ...parsed, action: "REQUEST_CHANGES" };
      }
    } else if (allComments.some((c) => c.severity === "blocker")) {
      // Early stop: blocker found, skip remaining batches
      log.info(
        {
          foundInBatch: i + 1,
          remainingBatches: effectiveBatches.length - i - 1,
        },
        "Blocker found — skipping remaining batches",
      );
      finalResult = {
        prSummary:
          parsed.prSummary ||
          `(Partial review — stopped after batch ${i + 1} due to blockers)`,
        summary: `Blockers found in batch ${i + 1}. Remaining ${effectiveBatches.length - i - 1} batch(es) skipped.`,
        action: "REQUEST_CHANGES",
        filesSummary: allFilesSummary,
        comments: allComments,
      };
      break;
    }
  }

  if (!finalResult) {
    // Should not happen — at least one batch always runs
    finalResult = {
      prSummary: "",
      summary: "No batches reviewed.",
      action: "COMMENT",
      filesSummary: [],
      comments: [],
    };
  }

  // Assemble final result with all accumulated data
  const result: ReviewResult = {
    ...finalResult,
    filesSummary: deduplicateFilesSummary(allFilesSummary),
    comments: deduplicateComments(allComments),
    // Append unreviewed files note when MAX_BATCHES exceeded
    summary:
      unreviewedFiles.length > 0
        ? finalResult.summary +
          `\n\n⚠️ **${unreviewedFiles.length} file(s) were NOT reviewed** ` +
          `(batch limit reached). The following were excluded:\n` +
          unreviewedFiles
            .slice(0, 20)
            .map((f) => `- \`${f}\``)
            .join("\n") +
          (unreviewedFiles.length > 20
            ? `\n- ... and ${unreviewedFiles.length - 20} more`
            : "")
        : finalResult.summary,
  };

  // ── Hard output filters (non-LLM) ───────────────────────────────────────
  const filtered = filterReviewComments(result.comments, {
    maxCommentChars: config.review.maxCommentChars,
  });
  if (filtered.dropped.length > 0 || filtered.mutated.length > 0) {
    log.warn(formatFilterSummary(filtered));
  }
  result.comments = filtered.kept;

  // Verdict consistency: REQUEST_CHANGES needs at least one blocker comment.
  const verdictReason = filterReviewVerdict(result);
  if (verdictReason) {
    log.warn(`Verdict adjusted: ${verdictReason}`);
  }

  // ── Stale-commit guard ──────────────────────────────────────────
  if (!dryRun) {
    let currentHead: string | null = null;
    try {
      const fresh = await deps.connector.fetchPR(ref, number);
      currentHead = fresh.headSha;
    } catch (err) {
      log.warn({ err }, "Stale-check: failed to re-fetch PR head");
    }

    if (currentHead !== null && currentHead !== pr.headSha) {
      log.info(
        { oldHead: pr.headSha, newHead: currentHead },
        "PR head changed — discarding batch result",
      );
      if (startingCommentId !== null) {
        await deps.connector
          .editComment(
            ref,
            startingCommentId,
            `🔄 **New commits pushed during review** - discarding stale result.`,
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

  if (!dryRun) {
    // Update progress comment with final verdict
    let progressUpdated = false;
    if (startingCommentId !== null) {
      try {
        await deps.connector.editComment(
          ref,
          startingCommentId,
          buildReviewCommentBody(result, pr.changedFiles.length, {
            diffTruncated: false,
            reviewedFiles: new Set(
              effectiveBatches.flatMap((b) => b.files.map((f) => f.filename)),
            ).size,
            round,
          }),
        );
        progressUpdated = true;
      } catch (err) {
        log.warn({ err }, "Failed to update progress comment");
      }
    }

    // Collect all visible file paths across all batches
    const allVisiblePaths = new Set<string>();
    for (const batch of batches) {
      const batchDiff = assembleBatchDiff(batch.files);
      for (const p of batchFilePaths(batchDiff)) {
        allVisiblePaths.add(p);
      }
    }

    await deps.connector.postReview(pr, result, config, {
      summaryPostedElsewhere: progressUpdated,
      visibleFilePaths: allVisiblePaths,
    });
    log.info(
      { comments: allComments.length, batches: effectiveBatches.length },
      "Batch review posted",
    );
  }

  return {
    ...result,
    progressCommentId: startingCommentId,
    stale: false,
    headSha: pr.headSha,
  };
}

/** Deduplicate filesSummary entries by path, keeping the first occurrence. */
function deduplicateFilesSummary(
  summaries: ReviewResult["filesSummary"],
): ReviewResult["filesSummary"] {
  const seen = new Set<string>();
  return summaries.filter((s) => {
    // s is FileSummary (typed by Zod), path is always a string.
    if (!s.path || seen.has(s.path)) return false;
    seen.add(s.path);
    return true;
  });
}

/**
 * Deduplicate review comments across batches.
 * Two batches can flag the same cross-cutting issue independently
 * (e.g., a fence-break pattern in two files). Dedup by path + line +
 * normalized body (stripped severity emoji, trimmed, first 80 chars).
 */
function deduplicateComments(
  comments: ReviewResult["comments"],
): ReviewResult["comments"] {
  const seen = new Set<string>();
  return comments.filter((c) => {
    // Strip leading severity emoji + space (🛑 or ⚠️). The `u` flag
    // handles multi-code-unit emoji without charset surrogate errors.
    const normalized = c.body
      .replace(/^\p{Extended_Pictographic}\s*/u, "")
      .trim()
      .toLowerCase()
      .slice(0, 80);
    const key = `${c.path}:${c.line}:${normalized}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Parallel batch review + synthesis ──────────────────────────────────────
