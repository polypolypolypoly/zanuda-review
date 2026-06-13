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
import { formatDiscussion, buildReviewCommentBody } from "./format.js";
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
  opts: { dryRun?: boolean; round?: number; progressCommentId?: number } = {},
): Promise<
  ReviewResult & { progressCommentId: number | null; stale: boolean }
> {
  const { connector } = deps;
  const round = opts.round ?? 1;
  const log = logger.child({
    repo: `${ref.owner}/${ref.repo}`,
    pr: number,
    round,
  });

  // Round 1: post a "starting" placeholder. Round 2+: reuse the existing
  // comment ID so we update in place and avoid a second stale comment.
  let startingCommentId: number | null = opts.progressCommentId ?? null;

  const pr = await connector.fetchPR(ref, number);
  log.info({ files: pr.changedFiles.length, state: pr.state }, "Fetched PR");

  if (pr.state !== "open" && !opts.dryRun) {
    log.info({ state: pr.state }, "PR is not open — skipping review");
    if (startingCommentId !== null) {
      await connector
        .editComment(
          ref,
          startingCommentId,
          `⏭️ **Review skipped** — this PR is already ${pr.state}.`,
        )
        .catch(() => undefined);
    }
    return {
      summary: `PR is ${pr.state}.`,
      action: "COMMENT",
      filesSummary: [],
      comments: [],
      progressCommentId: startingCommentId,
      stale: false,
    };
  }
  if (!opts.dryRun) {
    if (startingCommentId !== null) {
      // Try to update the round-1 comment. If it was deleted, fall back to posting
      // a new one so the verdict isn't lost.
      const edited = await connector
        .editComment(ref, startingCommentId, "_Starting round 2 review\u2026_")
        .then(() => true)
        .catch((err) => {
          log.warn({ err }, "Failed to update progress comment, will post new");
          return false;
        });
      if (!edited) {
        startingCommentId = await connector
          .postComment(ref, number, "_Starting round 2 review\u2026_")
          .catch((err) => {
            log.warn({ err }, "Failed to post fallback progress comment");
            return null;
          });
      }
    } else {
      startingCommentId = await connector
        .postComment(ref, number, "_Starting review\u2026_")
        .catch((err) => {
          log.warn({ err }, "Failed to post starting comment");
          return null;
        });
    }
  }

  // If the engine throws after posting the progress comment, update it to
  // show an error state so the author isn't left staring at "Starting review…".
  const failSafe = async (err: unknown) => {
    if (!opts.dryRun && startingCommentId !== null) {
      await connector
        .editComment(
          ref,
          startingCommentId,
          `⚠️ **Review failed** — will retry on the next poll cycle.\n\n<sub>${String(err).slice(0, 200)}</sub>`,
        )
        .catch(() => undefined); // best-effort; don't mask the original error
    }
    throw err;
  };

  try {
    // Three-level config merge: global defaults → org config → per-repo config.
    // All files are read from the base branch (not the PR head) — a PR author
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
    const diffTruncated = pr.diff.length > config.review.maxDiffChars;

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
          "Stale-check: failed to re-fetch PR head — proceeding anyway",
        );
      }

      if (currentHead !== null && currentHead !== pr.headSha) {
        log.info(
          { oldHead: pr.headSha, newHead: currentHead },
          "PR head changed during review — discarding stale result",
        );
        if (startingCommentId !== null) {
          await connector
            .editComment(
              ref,
              startingCommentId,
              `🔄 **New commits pushed during review** — discarding stale result. Will re-review on the next poll cycle.`,
            )
            .catch(() => undefined);
        }
        return { ...result, progressCommentId: startingCommentId, stale: true };
      }
    }

    // APPROVE means the code is clean — inline comments on an APPROVE create
    // unresolved threads that block the merge even though the reviewer approved.
    if (result.action === "APPROVE") {
      result.comments = [];
    }

    // Round 2 is the final review — REQUEST_CHANGES must never be used here.
    if (round >= 2 && result.action === "REQUEST_CHANGES") {
      result.action = "COMMENT";
      log.info(
        "Round 2: coerced REQUEST_CHANGES → COMMENT to avoid blocking PR",
      );
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
      await connector.postReview(pr, result, config, {
        summaryPostedElsewhere: progressCommentUpdated,
      });
      log.info(
        {
          comments: result.comments.length,
          summaryPostedElsewhere: progressCommentUpdated,
        },
        "Review posted",
      );

      // On APPROVE: resolve all outstanding review threads Zanuda opened in
      // previous rounds so they don’t block the merge.
      if (result.action === "APPROVE") {
        const reviewerLogin = await connector
          .getReviewerLogin()
          .catch(() => "");
        if (reviewerLogin) {
          await connector
            .resolveReviewThreads(ref, number, reviewerLogin)
            .catch((err) =>
              log.warn({ err }, "Failed to resolve threads after APPROVE"),
            );
        }
      }
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

    return { ...result, progressCommentId: startingCommentId, stale: false };
  } catch (err) {
    await failSafe(err);
    throw err; // unreachable — failSafe always rethrows; satisfies TypeScript
  }
}

/** Parse the model's JSON, tolerating accidental code fences / prose wrapping. */
export function parseReviewResult(text: string): ReviewResult {
  const json = extractJson(text);
  return ReviewResultSchema.parse(JSON.parse(json));
}

/**
 * Extract a JSON object from the model's response.
 *
 * Strategy:
 * 1. Use brace-depth scanning from the first `{` to the matching `}` — this
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
