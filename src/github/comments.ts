import type { Octokit } from "@octokit/rest";
import type { RepoRef, SCMComment } from "../platform/types.js";

// PRComment is an alias kept for internal use within the github/ layer.
export type PRComment = SCMComment;

// formatDiscussion lives in review/format.ts (platform-agnostic); re-exported
// here so existing imports inside github/ continue to resolve without changes.
export { formatDiscussion } from "../review/format.js";

/**
 * Fetch all comments on a PR: inline review comments + general discussion,
 * sorted chronologically.
 */
export async function fetchPRDiscussion(
  octokit: Octokit,
  ref: RepoRef,
  prNumber: number,
): Promise<SCMComment[]> {
  // Two concurrent fetches is fine; this is not the N-file fan-out that hits
  // secondary rate limits.
  const [reviewComments, issueComments] = await Promise.all([
    octokit.paginate(octokit.pulls.listReviewComments, {
      ...ref,
      pull_number: prNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.issues.listComments, {
      ...ref,
      issue_number: prNumber,
      per_page: 100,
    }),
  ]);

  const comments: SCMComment[] = [
    ...reviewComments.map((c) => ({
      id: c.id,
      type: "inline" as const,
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      path: c.path,
      line: c.line ?? c.original_line ?? undefined,
      createdAt: c.created_at,
    })),
    ...issueComments.map((c) => ({
      id: c.id,
      type: "general" as const,
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.created_at,
    })),
  ];

  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Return comments that mention Zanuda and haven't been replied to yet,
 * excluding Zanuda's own comments.
 */
export function findUnrepliedMentions(
  comments: SCMComment[],
  reviewerLogin: string,
  repliedIds: Set<number>,
): SCMComment[] {
  const mention = new RegExp(`@${reviewerLogin}`, "i");
  return comments.filter(
    (c) =>
      mention.test(c.body) &&
      c.author.toLowerCase() !== reviewerLogin.toLowerCase() &&
      !repliedIds.has(c.id),
  );
}

/**
 * Post a reply to a comment.
 * - Inline comments: replies into the same thread.
 * - General comments: posts a new top-level PR comment.
 */
export async function replyToComment(
  octokit: Octokit,
  ref: RepoRef,
  prNumber: number,
  comment: SCMComment,
  body: string,
): Promise<void> {
  if (comment.type === "inline") {
    await octokit.pulls.createReplyForReviewComment({
      ...ref,
      pull_number: prNumber,
      comment_id: comment.id,
      body,
    });
  } else {
    await octokit.issues.createComment({
      ...ref,
      issue_number: prNumber,
      body,
    });
  }
}
