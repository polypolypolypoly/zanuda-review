import type { Octokit } from "@octokit/rest";
import type { RepoRef, SCMComment } from "../platform/types.js";
import { logger } from "../logger.js";

// PRComment is an alias kept for internal use within the github/ layer.
export type PRComment = SCMComment;

// formatDiscussion lives in review/format.ts (platform-agnostic); re-exported
// here so existing imports inside github/ continue to resolve without changes.
export { formatDiscussion } from "../review/format.js";

// ── Conditional-request cache ─────────────────────────────────────────────────
//
// The mention scan re-fetches every tracked PR's discussion every tick: two
// requests per PR per minute, almost always returning bytes we already have.
// A conditional request answers 304 when nothing changed, and GitHub does not
// charge 304s against the core quota.
//
// In-memory only: a restart just pays one full fetch per PR.

interface CachedList {
  etag: string;
  items: unknown[];
}

/** Bounds memory when many PRs are tracked; eviction costs one full fetch. */
const MAX_CACHE_ENTRIES = 200;

const listCache = new Map<string, CachedList>();

/** Exported for tests — a fresh process starts with an empty cache. */
export function clearDiscussionCache(): void {
  listCache.clear();
}

/**
 * Fetch a comment list, using the stored ETag when we have one.
 *
 * Only single-page results are cached: an ETag covers one page, so once a PR
 * exceeds 100 comments of a kind we fall back to full pagination. That is the
 * rare case; the common one is a handful of comments that never change.
 */
async function listWithEtag<T>(
  key: string,
  fetchFirstPage: (headers: Record<string, string>) => Promise<{
    headers: { etag?: string; link?: string };
    data: T[];
  }>,
  fetchAllPages: () => Promise<T[]>,
): Promise<T[]> {
  const cached = listCache.get(key);
  try {
    const res = await fetchFirstPage(
      cached ? { "if-none-match": cached.etag } : {},
    );
    const hasMorePages = (res.headers.link ?? "").includes('rel="next"');
    if (hasMorePages) {
      listCache.delete(key);
      return fetchAllPages();
    }
    if (res.headers.etag) {
      if (listCache.size >= MAX_CACHE_ENTRIES && !listCache.has(key)) {
        // Oldest insertion first — plain FIFO is enough for a hint cache.
        const oldest = listCache.keys().next().value;
        if (oldest !== undefined) listCache.delete(oldest);
      }
      listCache.set(key, { etag: res.headers.etag, items: res.data });
    }
    return res.data;
  } catch (err) {
    if ((err as { status?: number }).status === 304 && cached) {
      return cached.items as T[];
    }
    throw err;
  }
}

/**
 * Fetch all comments on a PR: inline review comments + general discussion,
 * sorted chronologically.
 */
export async function fetchPRDiscussion(
  octokit: Octokit,
  ref: RepoRef,
  prNumber: number,
): Promise<SCMComment[]> {
  const prKey = `${ref.owner}/${ref.repo}#${prNumber}`;

  // Two concurrent fetches is fine; this is not the N-file fan-out that hits
  // secondary rate limits.
  const [reviewComments, issueComments] = await Promise.all([
    listWithEtag(
      `${prKey}/review`,
      (headers) =>
        octokit.pulls.listReviewComments({
          ...ref,
          pull_number: prNumber,
          per_page: 100,
          headers,
        }),
      () =>
        octokit.paginate(octokit.pulls.listReviewComments, {
          ...ref,
          pull_number: prNumber,
          per_page: 100,
        }),
    ),
    listWithEtag(
      `${prKey}/issue`,
      (headers) =>
        octokit.issues.listComments({
          ...ref,
          issue_number: prNumber,
          per_page: 100,
          headers,
        }),
      () =>
        octokit.paginate(octokit.issues.listComments, {
          ...ref,
          issue_number: prNumber,
          per_page: 100,
        }),
    ),
  ]);

  logger.debug(
    { pr: prKey, review: reviewComments.length, issue: issueComments.length },
    "Fetched PR discussion",
  );

  const comments: SCMComment[] = [
    ...reviewComments.map((c) => ({
      id: c.id,
      type: "inline" as const,
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      path: c.path,
      line: c.line ?? c.original_line ?? undefined,
      // in_reply_to_id is set on reply comments (not root comments).
      // We need it to pass the correct ID to createReplyForReviewComment,
      // which requires the root comment's ID, not the reply's own ID.
      inReplyToId: c.in_reply_to_id ?? undefined,
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
    // GitHub's createReplyForReviewComment requires the root comment's ID.
    // Reply comments have inReplyToId pointing to the root; root comments
    // don't have it, so we fall back to their own ID.
    const rootId = comment.inReplyToId ?? comment.id;
    await octokit.pulls.createReplyForReviewComment({
      ...ref,
      pull_number: prNumber,
      comment_id: rootId,
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
