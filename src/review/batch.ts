/**
 * Multi-batch review orchestration.
 *
 * When a PR exceeds the attention window (~50K chars), files are partitioned
 * into batches via dependency-aware clustering and reviewed sequentially or
 * in parallel. Each batch is independent — no running summaries to avoid
 * hallucination propagation.
 */

import type { SCMConnector, RepoRef, PullRequest } from "../platform/types.js";
import type { LLMProvider } from "../llm/index.js";
import type { logger } from "../logger.js";
import {
  completeFilesSummary,
  filterAnchorableComments,
  filterCommentBudget,
  filterFilesSummary,
  filterResultSummaries,
  filterReviewComments,
  filterReviewVerdict,
  filterSummarySelfCorrection,
  formatFilterSummary,
} from "./filters.js";
import { synthesizeBatchVerdict, type BatchNote } from "./synthesize.js";
import { buildSystemPrompt, buildBatchUserPrompt } from "./prompt.js";
import { assembleBatchDiff, buildValidLineMap } from "./diff.js";
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

/**
 * Concurrent file reads per batch build. A 300-file PR firing 300 parallel
 * getContent calls is the classic secondary-rate-limit trigger; a small window
 * keeps the wall-clock win without it.
 */
const MAX_CONCURRENT_READS = 5;

/** Map over `items` with at most `limit` calls to `fn` in flight, order kept. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

export async function buildHeaderedFiles(
  connector: SCMConnector,
  ref: RepoRef,
  pr: PullRequest,
): Promise<HeaderedFile[]> {
  const result: HeaderedFile[] = [];

  // Fetch full file contents with a bounded number of requests in flight.
  // Use the base SHA — reading from headSha would let PR authors inject
  // misleading imports/declarations into the structural header context.
  // The diff itself still reflects the PR changes; the header is structural
  // context and must come from the maintainer-controlled base branch.
  const contents = await mapWithConcurrency(
    pr.files.filter((f) => f.patch),
    MAX_CONCURRENT_READS,
    async (f) => {
      try {
        const content = await connector.readFile(ref, f.filename, pr.baseSha);
        return { filename: f.filename, content, patch: f.patch! };
      } catch {
        return { filename: f.filename, content: null, patch: f.patch! };
      }
    },
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
 * Batch notes are the model's own batch-local summaries, written before
 * verification runs. When verification drops findings, that summary can still
 * name the dropped findings — and the synthesis call re-raises them from the
 * notes, turning "no findings" into an observations/COMMENT verdict (tg-bot#72).
 *
 * Called only when findings were actually dropped (kept < original): replace
 * the raw summary with a deterministic note so synthesis sees only what
 * survived.
 */
export function summarizeBatchNote(
  keptCount: number,
  originalCount: number,
): string {
  if (keptCount === 0) {
    return "No findings from this batch survived verification.";
  }
  return (
    `${keptCount} of ${originalCount} findings from this batch ` +
    "survived verification; see the findings list for the kept issues."
  );
}

/**
 * Sequential multi-batch review of a large PR.
 *
 * Each batch reviews its files in isolation. All inline comments are
 * accumulated, filtered, and posted together; the PR-wide summary and verdict
 * come from one synthesis call over the final findings (synthesize.ts).
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
  // Each batch's own (batch-local) summary, handed to the synthesis call.
  const batchNotes: BatchNote[] = [];
  // Files whose diff the model actually reviewed. Batches skipped by the
  // maxBatches cap, the token budget, or the blocker early-stop never get here.
  const reviewedPaths = new Set<string>();
  // Files left unreviewed, with the reason, for the honest note in the summary.
  const unreviewed: { files: string[]; reason: string }[] = [];

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
  let effectiveBatches = batches;
  if (maxBatches > 0 && batches.length > maxBatches) {
    const sortedBatches = [...batches].sort((a, b) => b.weight - a.weight);
    effectiveBatches = sortedBatches.slice(0, maxBatches);
    const skipped = sortedBatches.slice(maxBatches);
    const skippedFiles = skipped.flatMap((b) => b.files.map((f) => f.filename));
    unreviewed.push({ files: skippedFiles, reason: "batch limit reached" });
    log.warn(
      {
        totalBatches: batches.length,
        kept: maxBatches,
        skipped: batches.length - maxBatches,
        unreviewedFiles: skippedFiles.length,
      },
      "maxBatches limit reached — selecting highest-signal batches",
    );
  }

  const filesOf = (from: number) =>
    effectiveBatches.slice(from).flatMap((b) => b.files.map((f) => f.filename));

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
      unreviewed.push({ files: filesOf(i), reason: "token budget exhausted" });
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
    for (const f of batch.files) reviewedPaths.add(f.filename);

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
    const verificationRan =
      parsed.comments.length > 0 && config.review.verifyFindings;
    const batchComments = verificationRan
      ? await verifyFindings(
          parsed.comments,
          batchDiff.text,
          config,
          provider,
          log,
        )
      : [];

    // Anchor validation: drop comments whose (path, line) pair isn't in this
    // batch's diff. The model generates line numbers from the diff text it was
    // shown — the code has that same diff and can decide, not the 422 response.
    const anchored = filterAnchorableComments(
      batchComments,
      buildValidLineMap(batch.files),
    );
    if (anchored.dropped.length > 0) {
      log.warn(
        {
          dropped: anchored.dropped.map(
            (d) => `${d.path}:${d.line} — ${d.reason}`,
          ),
        },
        "Batch: dropped anchor-invalid inline comments (line not in diff)",
      );
    }

    // Batch note: the model's batch-local summary predates verification and
    // may name findings that verification just dropped. If it did, the
    // synthesis call re-raises them from the notes — turning "no findings"
    // into an observations verdict (tg-bot#72). Neutralize the note so the
    // synthesis only ever sees the surviving, verified findings.
    const batchNoteSummary =
      verificationRan && anchored.kept.length < parsed.comments.length
        ? summarizeBatchNote(anchored.kept.length, parsed.comments.length)
        : parsed.summary;
    batchNotes.push({
      batch: i + 1,
      files: batch.files.map((f) => f.filename),
      summary: batchNoteSummary,
    });

    allComments.push(...anchored.kept);
    allFilesSummary.push(...parsed.filesSummary);

    if (!isLast && allComments.some((c) => c.severity === "blocker")) {
      // Early stop: blocker found, skip remaining batches
      log.info(
        {
          foundInBatch: i + 1,
          remainingBatches: effectiveBatches.length - i - 1,
        },
        "Blocker found — skipping remaining batches",
      );
      unreviewed.push({
        files: filesOf(i + 1),
        reason: "stopped early after a blocker",
      });
      break;
    }
  }

  // Assemble the result from what the batches produced. Summary, prSummary and
  // verdict come from the synthesis call below, once the findings are final.
  const result: ReviewResult = {
    prSummary: "",
    summary: "",
    action: "COMMENT",
    filesSummary: deduplicateFilesSummary(allFilesSummary),
    comments: deduplicateComments(allComments),
  };

  // ── Hard output filters (non-LLM) ───────────────────────────────────────
  const filtered = filterReviewComments(result.comments, {
    maxCommentChars: config.review.maxCommentChars,
  });
  if (filtered.dropped.length > 0 || filtered.mutated.length > 0) {
    log.warn(formatFilterSummary(filtered));
  }
  result.comments = filtered.kept;

  const fabricatedPaths = filterFilesSummary(result, pr.changedFiles);
  if (fabricatedPaths.length > 0) {
    log.warn(
      { paths: fabricatedPaths },
      "Batch: dropped filesSummary rows for paths not in the PR",
    );
  }
  const undescribed = completeFilesSummary(result, pr.files, reviewedPaths);
  if (undescribed.length > 0) {
    log.info(
      { paths: undescribed },
      "Batch: filesSummary missing rows for reviewed files - filled from diff stats",
    );
  }

  // Comment budget + round discipline (non-LLM).
  const budgeted = filterCommentBudget(result.comments, {
    round,
    maxComments: config.review.maxCommentsPerReview,
    round2Warnings: config.review.round2Warnings,
  });
  if (budgeted.dropped.length > 0) {
    log.warn(
      {
        dropped: budgeted.dropped.map(
          (d) => `${d.path}:${d.line} — ${d.reason}`,
        ),
      },
      "Batch: dropped comments over budget/round discipline",
    );
  }
  result.comments = budgeted.kept;

  // ── Synthesis: one PR-wide verdict from the final findings ──────────────
  // Runs regardless of the token budget: it carries no diff, and a review
  // without a summary is worse than a few K tokens over budget.
  const unreviewedFiles = unreviewed.flatMap((u) => u.files);
  const synthesis = await synthesizeBatchVerdict(
    {
      title: pr.title,
      body: pr.body,
      round,
      discussion,
      totalFiles: pr.changedFiles.length,
      filesSummary: result.filesSummary,
      unreviewedFiles,
      findings: result.comments,
      batchNotes,
    },
    config,
    provider,
    log,
  );
  Object.assign(result, synthesis);

  // Cap and sanity-check the model-written summaries before the
  // unreviewed-files note is appended below — that note is ours.
  const trimmed = filterResultSummaries(result);
  if (trimmed.length > 0) log.warn(`Hard filters: ${trimmed.join("; ")}`);
  const replaced = filterSummarySelfCorrection(result);
  if (replaced.length > 0) log.warn(`Hard filters: ${replaced.join("; ")}`);

  if (unreviewedFiles.length > 0) {
    result.summary +=
      `\n\n⚠️ **${unreviewedFiles.length} file(s) were NOT reviewed** ` +
      `(${unreviewed.map((u) => u.reason).join("; ")}):\n` +
      unreviewedFiles
        .slice(0, 20)
        .map((f) => `- \`${f}\``)
        .join("\n") +
      (unreviewedFiles.length > 20
        ? `\n- ... and ${unreviewedFiles.length - 20} more`
        : "");
  }

  // Verdict consistency — synthesis already clamps, this is the shared gate.

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
    // Post the review event FIRST (summary lives in its body), then delete the
    // transient placeholder. Same ordering as the single-batch engine path:
    // if postReview fails the placeholder survives for the failSafe to edit
    // into an error; on success there is one canonical summary, no duplicate.
    await deps.connector.postReview(pr, result, config, {
      visibleFilePaths: reviewedPaths,
    });
    if (startingCommentId !== null) {
      try {
        await deps.connector.deleteComment(ref, startingCommentId);
      } catch (err) {
        log.warn({ err }, "Failed to delete progress comment");
      }
    }
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
