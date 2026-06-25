import type { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import type { PullRequest } from "../platform/types.js";
import type { ReviewResult, ReviewComment } from "../review/types.js";

// buildReviewCommentBody lives in review/format.ts (platform-agnostic);
// re-exported here so existing imports from github/postReview continue to work.
import { buildReviewCommentBody } from "../review/format.js";
export { buildReviewCommentBody };

const SEVERITY_EMOJI: Record<string, string> = {
  blocker: "🛑",
  warning: "⚠️",
};

/** Render a review comment for GitHub, appending a suggestion block if present. */
function renderCommentBody(c: ReviewComment): string {
  const base = `${SEVERITY_EMOJI[c.severity] ?? ""} ${c.body}`.trim();
  if (!c.suggestion) return base;
  return `${base}\n\n\`\`\`suggestion\n${sanitizeSuggestion(c.suggestion)}\n\`\`\``;
}

/**
 * Prevent fence-break injection: if the suggestion contains a line starting
 * with \`\`\`, prepend a single space. A space-prefixed fence does not close
 * the \`\`\`suggestion block in GitHub-flavoured markdown.
 */
function sanitizeSuggestion(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trimStart().startsWith("```") ? " " + line : line))
    .join("\n");
}

// Exported for tests.
export { renderCommentBody, renderCommentSummary };

/** Render a one-line summary of a comment for fallback body dumps. */
function renderCommentSummary(c: ReviewComment): string {
  const base = `${SEVERITY_EMOJI[c.severity] ?? ""} \`${c.path}:${c.line}\` — ${c.body}`;
  if (!c.suggestion) return base;
  // Suggestion shown inline but collapsed for the fallback dump.
  const preview =
    c.suggestion.length > 80
      ? c.suggestion.slice(0, 80).replace(/\n/g, "\\n") + "…"
      : c.suggestion.replace(/\n/g, "\\n");
  return `${base}\n  > Suggestion: \`${preview}\``;
}

/**
 * Post the review back to GitHub.
 *
 * The review body is ALWAYS non-empty: it carries the summary (verdict +
 * file table). The progress comment is also edited with the summary for
 * timeline visibility, so the summary appears in two places by design — the
 * small duplication is the cost of guaranteeing a `createReview` event is
 * always submitted. Submitting the COMMENT review is what clears
 * `requested_reviewers` on GitHub; skipping it (e.g. an empty body when the
 * summary lived only in the progress comment) leaves the request open, the PR
 * keeps matching pollPendingReviews, and the round-2 gate misreads the
 * search-index lag as a re-request. GitHub 422s an empty-body no-comment
 * review anyway.
 *
 * `visibleFilePaths` — when the diff was assembled from a subset of files (large
 * PR), this is the set of paths the model actually saw. On a 422 we first retry
 * with only comments anchored to visible files; comments on excluded files go
 * into the fallback body. Without this, a single hallucinated line number on an
 * unseen file would 422 the entire batch and lose all valid inline comments.
 */
export async function postReview(
  octokit: Octokit,
  pr: PullRequest,
  result: ReviewResult,
  config: Config,
  opts: { visibleFilePaths?: Set<string> } = {},
): Promise<void> {
  // Zanuda never blocks or approves via GitHub — the review event is always
  // COMMENT so the PR pipeline is never affected. The verdict (APPROVE /
  // REQUEST_CHANGES / COMMENT) is expressed verbally in the summary comment.
  //
  // The review body is ALWAYS non-empty. Submitting a COMMENT review is the
  // natural GitHub mechanism that clears `requested_reviewers` (Zanuda
  // disappears from the sidebar). If we ever skip createReview — e.g. by
  // sending an empty body when the summary lives in the progress comment —
  // the request stays open, the PR keeps matching pollPendingReviews, and the
  // round-2 gate misreads the lag as a re-request. GitHub 422s a COMMENT
  // review with an empty body and no comments anyway, so we always carry the
  // summary here. The progress comment still gets the summary too (for
  // visibility in the timeline); the small duplication is intentional and
  // cheaper than the alternative of a second code path that can forget to
  // submit a review.
  const event = "COMMENT" as const;
  const body = buildReviewCommentBody(result, pr.changedFiles.length);

  if (!config.review.inlineComments || result.comments.length === 0) {
    await octokit.pulls.createReview({
      ...pr.ref,
      pull_number: pr.number,
      event,
      body,
    });
    return;
  }

  const toGitHubComment = (c: ReviewComment) => ({
    path: c.path,
    line: c.line,
    side: "RIGHT" as const,
    body: renderCommentBody(c),
  });

  const allComments = result.comments.map(toGitHubComment);

  // Happy path: post everything inline.
  try {
    await octokit.pulls.createReview({
      ...pr.ref,
      pull_number: pr.number,
      commit_id: pr.headSha,
      event,
      body,
      comments: allComments,
    });
    return;
  } catch (err) {
    if ((err as { status?: number }).status !== 422) throw err;
  }

  // 422: at least one comment references a line not in the diff.
  // If we know which files were visible, retry with only those comments —
  // this salvages valid inline anchors instead of dumping everything as text.
  if (opts.visibleFilePaths && opts.visibleFilePaths.size > 0) {
    const visibleComments = result.comments.filter((c) =>
      opts.visibleFilePaths!.has(c.path),
    );
    const hiddenComments = result.comments.filter(
      (c) => !opts.visibleFilePaths!.has(c.path),
    );

    if (visibleComments.length > 0) {
      try {
        // Build the fallback body for comments on files the model didn't see.
        const hiddenFallback =
          hiddenComments.length > 0
            ? "\n\n---\n\n**Comments on files not shown in the diff:**\n" +
              hiddenComments.map((c) => renderCommentSummary(c)).join("\n")
            : "";

        const partialBody = `${body}${hiddenFallback}`;

        await octokit.pulls.createReview({
          ...pr.ref,
          pull_number: pr.number,
          commit_id: pr.headSha,
          event,
          body: partialBody,
          comments: visibleComments.map(toGitHubComment),
        });
        return;
      } catch (retryErr) {
        if ((retryErr as { status?: number }).status !== 422) throw retryErr;
        // Even the visible-only set 422'd — fall through to full body dump.
      }
    }
  }

  // Final fallback: dump all comments as plain text in the review body.
  // commit_id is omitted here — inline anchors require a commit SHA, but when
  // we have no inline comments (everything is in the body), pinning to a SHA
  // is unnecessary and GitHub's convention is to omit it.
  const inlineFallback = result.comments
    .map((c) => renderCommentSummary(c))
    .join("\n");
  // The summary is always in `body` now, so the fallback always has context.
  const fallbackBody = `${body}\n\n---\n\n${inlineFallback}\n\n<sub>Inline comment anchoring failed; comments shown above.</sub>`;
  await octokit.pulls.createReview({
    ...pr.ref,
    pull_number: pr.number,
    event,
    body: fallbackBody,
  });
}
