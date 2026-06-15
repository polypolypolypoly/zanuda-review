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
import type { SCMConnector, RepoRef, PullRequest } from "../platform/types.js";
import { createProvider, type LLMProvider } from "../llm/index.js";
import { logger } from "../logger.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildBatchUserPrompt,
} from "./prompt.js";
import {
  buildPromptDiff,
  includedPaths,
  assembleBatchDiff,
  batchFilePaths,
} from "./diff.js";
import {
  ReviewResultSchema,
  type ReviewResult,
  buildReviewResultJsonSchema,
} from "./types.js";
import { completeWithRetry } from "../llm/retry.js";
import { headeredFile, type HeaderedFile } from "./header.js";
import { batchChangedFiles, type Batch } from "./chunk.js";

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
     * batch path entirely; "batch" forces multi-batch even for small PRs.
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
      // Build headered files from full file contents (for file headers
      // and import-graph analysis) and try dependency-aware batching.
      const headered = await buildHeaderedFiles(connector, ref, pr);
      const batches = batchChangedFiles(headered, batchChars);

      if (batches.length > 1) {
        // Multi-batch sequential review — each batch reviewed with
        // running summary from previous batches so the model has
        // cross-batch context.
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
  const computed = Math.max(2000, Math.floor(availableDiffTokens * 3.5));
  const capped = Math.min(computed, config.review.maxDiffChars);

  // Safety margin: 3.5 chars/token is a conservative estimate, but real
  // tokenizers vary (OpenAI vs Anthropic, code vs prose). A 10% margin
  // prevents near-miss overflows where the estimate says "fits" but the
  // actual token count is slightly higher.
  // Apply BEFORE the 2000 floor so the floor survives the margin.
  const SAFETY_MARGIN = 0.9;
  const withMargin = Math.floor(capped * SAFETY_MARGIN);
  return Math.max(2000, withMargin);
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

// ── Batch review ────────────────────────────────────────────────────────────

interface BatchedReviewOpts {
  deps: ReviewDeps;
  ref: RepoRef;
  number: number;
  round: number;
  dryRun: boolean;
  startingCommentId: number | null;
  context: Awaited<ReturnType<typeof buildContext>>;
  config: Config;
  provider: LLMProvider;
  instructions: string | undefined;
  repoMemory: string | null;
  reviewHistory: ReviewHistory | null;
  discussion: string | undefined;
  log: typeof logger;
}

/**
 * Fetch full file contents and build HeaderedFile objects for files with
 * patches. Files without patches (binary, too large) are skipped.
 */
async function buildHeaderedFiles(
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
async function reviewBatched(
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
  let runningSummary = "";
  let finalResult: ReviewResult | null = null;

  // ── MAX_BATCHES backstop ──────────────────────────────────────────
  // Prevent unbounded cost on pathological PRs. Beyond this, select the
  // highest-signal batches by weight and note unreviewed files honestly.
  const MAX_BATCHES = 10;
  let unreviewedFiles: string[] = [];
  let effectiveBatches = batches;
  if (batches.length > MAX_BATCHES) {
    const sortedBatches = [...batches].sort((a, b) => b.weight - a.weight);
    effectiveBatches = sortedBatches.slice(0, MAX_BATCHES);
    const skipped = sortedBatches.slice(MAX_BATCHES);
    unreviewedFiles = skipped.flatMap((b) => b.files.map((f) => f.filename));
    log.warn(
      {
        totalBatches: batches.length,
        kept: MAX_BATCHES,
        skipped: batches.length - MAX_BATCHES,
        unreviewedFiles: unreviewedFiles.length,
      },
      "MAX_BATCHES exceeded — selecting highest-signal batches",
    );
  }

  for (let i = 0; i < effectiveBatches.length; i++) {
    const batch = effectiveBatches[i]!;
    const isLast = i === effectiveBatches.length - 1;
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

    const completion = await completeWithRetry(provider, {
      system: buildSystemPrompt(config),
      user: buildBatchUserPrompt(pr, context, config, batchDiff, {
        batchIndex: i + 1,
        totalBatches: effectiveBatches.length,
        isLastBatch: isLast,
        runningSummary: runningSummary || undefined,
        round,
        discussion,
        repoMemory: repoMemory ?? undefined,
        reviewHistory: reviewHistory
          ? formatReviewHistory(reviewHistory)
          : undefined,
        instructions,
        structuredOutput: provider.supportsStructuredOutput,
      }),
      model: config.models[config.provider],
      temperature: config.generation.temperature,
      maxTokens: adaptiveMaxTokens(
        batch.files.length,
        config.generation.maxTokens,
      ),
      jsonSchema: buildReviewResultJsonSchema(config.review.maxCommentChars),
    });

    const parsed = parseReviewResult(completion.text, {
      structured: provider.supportsStructuredOutput,
    });

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

    // Accumulate comments and file summaries
    allComments.push(...parsed.comments);
    allFilesSummary.push(...parsed.filesSummary);

    // Extract batch findings for the running summary — now a first-class
    // schema field, no regex fallback needed.
    const findings = parsed.batchFindings;
    if (findings) {
      runningSummary +=
        `\n## Findings from batch ${i + 1} (${batch.files.map((f) => `\`${f.filename}\``).join(", ")})\n` +
        `> ⚠️ The above is the previous model's best-effort notes. Verify independently.\n` +
        `${findings}\n`;

      // Cap total running summary to prevent unbounded prompt growth across
      // many batches. The batchFindings schema already caps each entry at 600
      // chars; this is a safety net for the running total.
      const MAX_RUNNING_SUMMARY_CHARS = 5000;
      if (runningSummary.length > MAX_RUNNING_SUMMARY_CHARS) {
        runningSummary =
          runningSummary.slice(0, MAX_RUNNING_SUMMARY_CHARS) +
          `\n> _(running summary truncated at ${MAX_RUNNING_SUMMARY_CHARS} chars — earlier findings omitted)_\n`;
      }
    }

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
            diffTruncated: false, // all files reviewed across batches
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
    // Strip severity emoji prefix (🛑 or ⚠️) — use unicode-aware regex.
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
