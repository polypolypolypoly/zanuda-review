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
  praise: "✅",
};

/**
 * Post the review back to GitHub.
 *
 * If `summaryPostedElsewhere` is true, the review body is intentionally empty —
 * the full summary lives in the progress comment that was edited with the final
 * verdict. This avoids posting duplicate content and keeps the PR timeline clean.
 *
 * If false (progress comment was never posted or failed to update), includes
 * the summary in the review body so the author always sees the verdict.
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
  opts: {
    summaryPostedElsewhere?: boolean;
    visibleFilePaths?: Set<string>;
  } = {},
): Promise<void> {
  const event = config.review.event ?? result.action;
  const body = opts.summaryPostedElsewhere
    ? ""
    : buildReviewCommentBody(result, pr.changedFiles.length);

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
    body: `${SEVERITY_EMOJI[c.severity] ?? ""} ${c.body}`.trim(),
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
              hiddenComments
                .map(
                  (c) =>
                    `- ${SEVERITY_EMOJI[c.severity] ?? ""} \`${c.path}:${c.line}\` — ${c.body}`,
                )
                .join("\n")
            : "";

        const partialBody = opts.summaryPostedElsewhere
          ? hiddenFallback.trimStart()
          : `${body}${hiddenFallback}`;

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
    .map(
      (c) =>
        `- ${SEVERITY_EMOJI[c.severity] ?? ""} \`${c.path}:${c.line}\` — ${c.body}`,
    )
    .join("\n");
  const fallbackBody = opts.summaryPostedElsewhere
    ? `${inlineFallback}\n\n<sub>Inline comment anchoring failed; comments shown above.</sub>`
    : `${body}\n\n---\n\n${inlineFallback}\n\n<sub>Inline comment anchoring failed; comments shown above.</sub>`;
  await octokit.pulls.createReview({
    ...pr.ref,
    pull_number: pr.number,
    event,
    body: fallbackBody,
  });
}
