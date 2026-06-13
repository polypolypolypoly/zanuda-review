import type { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import type { PullRequest } from "../platform/types.js";
import type { ReviewResult } from "../review/types.js";

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

/**
 * Build the full review content for the progress comment.
 * This replaces "Starting review…" with the complete verdict, summary,
 * and file overview — everything the author needs in one place.
 */
export function buildReviewCommentBody(
  result: ReviewResult,
  totalFiles: number,
): string {
  const ACTION_ICON: Record<string, string> = {
    APPROVE: "✅",
    REQUEST_CHANGES: "🛑",
    COMMENT: "💬",
  };

  const reviewed = result.filesSummary.length;
  const scope =
    reviewed === totalFiles
      ? `Checked ${totalFiles} file${totalFiles === 1 ? "" : "s"}`
      : `Checked ${reviewed} of ${totalFiles} files`;
  const inlineCount = result.comments.length;
  const icon = ACTION_ICON[result.action] ?? "💬";
  const label = result.action.replace("_", " ").toLowerCase();

  const parts: string[] = [
    `${icon} **Review complete** · ${label}`,
    ``,
    result.summary,
    ``,
    `<sub>${scope}${inlineCount > 0 ? ` · ${inlineCount} inline comment${inlineCount === 1 ? "" : "s"}` : ""}</sub>`,
  ];

  if (result.filesSummary.length > 0) {
    parts.push(
      ``,
      `<details>`,
      `<summary>Changed files (${reviewed})</summary>`,
      ``,
      `| File | Description |`,
      `| --- | --- |`,
      ...result.filesSummary.map((f) => `| ${f.path} | ${f.description} |`),
      ``,
      `</details>`,
    );
  }

  return parts.join("\n");
}
