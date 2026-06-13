import type { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import type { PullRequest } from "../platform/types.js";
import type { ReviewResult } from "../review/types.js";

// buildReviewCommentBody lives in review/format.ts (platform-agnostic);
// re-exported here so existing imports from github/postReview continue to work.
export { buildReviewCommentBody } from "../review/format.js";
import { buildReviewCommentBody } from "../review/format.js";

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
 * Inline comments are still anchored to the diff as usual.
 * If anchoring fails (HTTP 422), falls back to a plain comment so no
 * feedback is silently lost.
 */
export async function postReview(
  octokit: Octokit,
  pr: PullRequest,
  result: ReviewResult,
  config: Config,
  opts: { summaryPostedElsewhere?: boolean } = {},
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

  const comments = result.comments.map((c) => ({
    path: c.path,
    line: c.line,
    side: "RIGHT" as const,
    body: `${SEVERITY_EMOJI[c.severity] ?? ""} ${c.body}`.trim(),
  }));

  try {
    await octokit.pulls.createReview({
      ...pr.ref,
      pull_number: pr.number,
      commit_id: pr.headSha,
      event,
      body,
      comments,
    });
  } catch (err) {
    if ((err as { status?: number }).status !== 422) throw err;
    // Inline anchoring failed — post comments as a plain list in the body.
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
}
