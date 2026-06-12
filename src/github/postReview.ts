import type { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import type { ReviewResult } from "../review/types.js";
import type { PullRequestData } from "./pullRequest.js";

const SEVERITY_EMOJI: Record<string, string> = {
  blocker: "🛑",
  warning: "⚠️",
  nitpick: "💭",
  praise: "✅",
};

/**
 * Post the review back to GitHub. Inline comments are anchored to the head
 * commit; any that GitHub rejects (e.g. a line outside the diff) are collected
 * and appended to the summary so feedback is never silently dropped.
 */
export async function postReview(
  octokit: Octokit,
  pr: PullRequestData,
  result: ReviewResult,
  config: Config,
): Promise<void> {
  const header = `### 🤖 review-helper\n\n${result.summary}`;

  if (!config.review.inlineComments || result.comments.length === 0) {
    await octokit.pulls.createReview({
      ...pr.ref,
      pull_number: pr.number,
      event: config.review.event,
      body: renderSummaryBody(header, result),
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
      event: config.review.event,
      body: header,
      comments,
    });
  } catch (err) {
    // Most failures here are line-anchoring errors. Fall back to a single
    // summary review that embeds the comments as text so nothing is lost.
    await octokit.pulls.createReview({
      ...pr.ref,
      pull_number: pr.number,
      event: config.review.event,
      body: `${renderSummaryBody(header, result)}\n\n<sub>Inline anchoring failed (${
        (err as Error).message
      }); comments shown above.</sub>`,
    });
  }
}

function renderSummaryBody(header: string, result: ReviewResult): string {
  if (result.comments.length === 0) return header;
  const lines = result.comments.map(
    (c) =>
      `- ${SEVERITY_EMOJI[c.severity] ?? ""} \`${c.path}:${c.line}\` — ${c.body}`,
  );
  return `${header}\n\n${lines.join("\n")}`;
}
