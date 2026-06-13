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
 * Post the review back to GitHub. Inline comments are anchored to the head
 * commit; any that GitHub rejects (e.g. a line outside the diff) are collected
 * and appended to the summary so feedback is never silently dropped.
 */
export async function postReview(
  octokit: Octokit,
  pr: PullRequest,
  result: ReviewResult,
  config: Config,
): Promise<void> {
  const header = buildHeader(result, pr.changedFiles.length);
  // config.review.event acts as a hard per-repo override (e.g. always COMMENT).
  // When null the model's own reasoning drives the action.
  const event = config.review.event ?? result.action;

  if (!config.review.inlineComments || result.comments.length === 0) {
    await octokit.pulls.createReview({
      ...pr.ref,
      pull_number: pr.number,
      event,
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
      event,
      body: header,
      comments,
    });
  } catch (err) {
    // Only fall back for line-anchoring errors (HTTP 422). Every other failure
    // (network, auth, rate-limit, …) should propagate so the caller can log
    // and retry rather than silently swallowing it.
    if ((err as { status?: number }).status !== 422) throw err;
    await octokit.pulls.createReview({
      ...pr.ref,
      pull_number: pr.number,
      event,
      body: `${renderSummaryBody(header, result)}\n\n<sub>Inline comment anchoring failed; comments shown above.</sub>`,
    });
  }
}

function buildHeader(result: ReviewResult, totalFiles: number): string {
  const reviewed = result.filesSummary.length;
  const scope =
    reviewed === totalFiles
      ? `Checked ${totalFiles} file${totalFiles === 1 ? "" : "s"}`
      : `Checked ${reviewed} of ${totalFiles} files`;

  const parts: string[] = [
    `## Pull request overview`,
    ``,
    result.summary,
    ``,
    `<sub>${scope}</sub>`,
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

function renderSummaryBody(header: string, result: ReviewResult): string {
  if (result.comments.length === 0) return header;
  const lines = result.comments.map(
    (c) =>
      `- ${SEVERITY_EMOJI[c.severity] ?? ""} \`${c.path}:${c.line}\` — ${c.body}`,
  );
  return `${header}\n\n### Comments\n\n${lines.join("\n")}`;
}
