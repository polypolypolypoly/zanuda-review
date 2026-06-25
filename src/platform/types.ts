/**
 * Platform-agnostic source control interface.
 *
 * Everything in src/review/, src/llm/, src/context/, src/state/, and
 * src/config/ works against this interface — none of it knows or cares
 * whether the underlying platform is GitHub, GitLab, Bitbucket, or anything
 * else.
 *
 * To add a new platform:
 *   1. Copy src/platform/stub/connector.ts → src/platform/<name>/connector.ts
 *   2. Implement every method (the stub has detailed JSDoc for each).
 *   3. Add the platform name to the factory in src/platform/index.ts.
 *   4. Add the matching PLATFORM env var value to .env.example.
 *
 * @see src/platform/github/connector.ts — reference implementation
 * @see src/platform/stub/connector.ts  — annotated skeleton
 */

import type { Config } from "../config.js";
import type { ReviewResult } from "../review/types.js";

// ─── Shared data types ────────────────────────────────────────────────────────

/** Identifies a repository. Kept deliberately minimal — owner/repo covers
 *  every major git hosting platform. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * A pull / merge request.
 *
 * `baseSha` and `headSha` are git commit SHAs (or equivalent stable refs):
 *   - `baseSha` — the target branch tip at review time. Used to read config
 *     and context files from the *trusted* base branch, not the PR head.
 *   - `headSha` — the PR head commit. Used to anchor inline review comments.
 */
/**
 * Per-file change data. `patch` is the file's unified diff section as returned
 * by the platform's list-files API. It is `undefined` when the platform omits
 * it (file too large, binary file, etc.).
 */
export interface FileChange {
  filename: string;
  additions: number;
  deletions: number;
  /** Unified diff for this file only. Undefined when platform truncated it. */
  patch?: string;
}

export interface PullRequest {
  ref: RepoRef;
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  /** Unified diff of the whole PR (raw blob from the platform). */
  diff: string;
  /** Ordered list of all changed file paths (convenience alias of files[].filename). */
  changedFiles: string[];
  /** Per-file metadata including individual patches where available. */
  files: FileChange[];
  /** Current state of the PR: open, closed, or merged. */
  state: "open" | "closed" | "merged";
}

/**
 * A comment on a PR — either anchored to a diff line or posted at the
 * top level of the discussion.
 */
export interface SCMComment {
  id: number;
  /** "inline" = anchored to a specific diff line; "general" = PR discussion. */
  type: "inline" | "general";
  author: string;
  body: string;
  /** Only set for inline comments. */
  path?: string;
  line?: number;
  /**
   * For inline comments that are replies within a thread, this is the ID of
   * the root (top-level) comment of the thread. Absent on root comments.
   *
   * GitHub's createReplyForReviewComment API requires the root comment's ID,
   * not the reply's own ID. Without this field we'd pass the wrong ID and
   * GitHub would either 422 or create an unthreaded comment.
   */
  inReplyToId?: number;
  createdAt: string;
}

/** A PR returned by the poller that is pending a review. */
export interface PendingReview {
  ref: RepoRef;
  number: number;
  title: string;
  /**
   * Stable, globally-unique ID used for state tracking (round counts, mention
   * caps). Must not change for the lifetime of the PR. GitHub uses the
   * issue/item `id` field; other platforms should use an equivalent.
   */
  platformId: number;
}

/** Result of a file-tree fetch. */
export interface FileTree {
  paths: string[];
  truncated: boolean;
  total: number;
}

// ─── Connector interface ──────────────────────────────────────────────────────

export interface SCMConnector {
  /** Short lowercase name used in logs ("github", "gitlab", …). */
  readonly name: string;

  /**
   * Return the authenticated reviewer account's login/username.
   * Called once at startup; the result is cached for the process lifetime.
   */
  getReviewerLogin(): Promise<string>;

  /**
   * Return all open PRs/MRs where the reviewer has been requested.
   * This is the poller heartbeat — called every POLL_INTERVAL_SECS.
   * Return [] when there is nothing to review.
   */
  pollPendingReviews(reviewerLogin: string): Promise<PendingReview[]>;

  /**
   * Fetch full PR data: diff, changed files, title, body, base/head refs.
   */
  fetchPR(ref: RepoRef, number: number): Promise<PullRequest>;

  /**
   * Read a single file at the given git ref. Returns null on 404;
   * throws on any other error.
   *
   * Always pass `pr.baseSha` for config/context files — never `pr.headSha`.
   * The base branch is maintainer-controlled; using the head ref lets PR
   * authors influence Zanuda by editing files in their branch.
   */
  readFile(ref: RepoRef, path: string, gitRef: string): Promise<string | null>;

  /**
   * Return the flat list of all file paths in the repo at the given ref,
   * capped at maxEntries. Used to build the file-tree prompt section.
   */
  getFileTree(
    ref: RepoRef,
    gitRef: string,
    maxEntries: number,
  ): Promise<FileTree>;

  /**
   * Fetch all comments on a PR (inline + general), sorted chronologically.
   */
  fetchDiscussion(ref: RepoRef, number: number): Promise<SCMComment[]>;

  /**
   * Post the review result back to the platform.
   * Map the model's verdict and inline comments to the platform's review API.
   * If inline anchoring fails, fall back to a summary comment so no feedback
   * is silently lost.
   *
   * The review body is ALWAYS non-empty (it carries the summary). Submitting
   * the COMMENT review is what clears `requested_reviewers` on GitHub — never
   * skip it, or the PR keeps matching pollPendingReviews and the round-2 gate
   * misreads the lag as a re-request.
   *
   * @param opts.visibleFilePaths - The set of file paths whose diff was actually
   *   sent to the model. Comments on paths outside this set are anchored to lines
   *   the model never saw and will 422; the connector should handle them specially.
   */
  postReview(
    pr: PullRequest,
    result: ReviewResult,
    config: Config,
    opts?: { visibleFilePaths?: Set<string> },
  ): Promise<void>;

  /**
   * Post a standalone (non-review) comment on a PR.
   * Returns the platform-specific comment ID so the comment can be edited later.
   * Used for progress indicators ("Starting review\u2026") and system notifications.
   */
  postComment(ref: RepoRef, number: number, body: string): Promise<number>;

  /**
   * Edit an existing comment by ID.
   * Used to update the "Starting review\u2026" placeholder with an error / stale
   * status when a round fails or is discarded.
   */
  editComment(ref: RepoRef, commentId: number, body: string): Promise<void>;

  /**
   * Delete a comment by ID.
   * Used to delete the transient "Starting review\u2026" placeholder once the
   * review has been posted as a review event (the canonical home of the
   * summary). The placeholder is a pure progress indicator; on success it is
   * removed so the summary is not duplicated in the timeline.
   */
  deleteComment(ref: RepoRef, commentId: number): Promise<void>;

  /**
   * Reply to a specific comment.
   * Inline replies should appear in the same thread; general replies post
   * a new top-level comment.
   */
  replyToComment(
    ref: RepoRef,
    number: number,
    comment: SCMComment,
    body: string,
  ): Promise<void>;

  /**
   * List commit SHAs in a PR (ordered, oldest first).
   * Used by the deduplication gate to skip PRs whose commits were all
   * already reviewed in a previous PR.
   */
  listCommitShas(ref: RepoRef, number: number): Promise<string[]>;

  /**
   * Is the reviewer currently in the PR's `requested_reviewers`?
   *
   * This is the AUTHORITATIVE signal for "the author re-requested review."
   * The search/poll API is eventually consistent and can still return a PR
   * whose request was just fulfilled (by a submitted COMMENT review clearing
   * `requested_reviewers`); this method MUST be strongly consistent (a direct
   * PR fetch, not a search index) so the round-2 gate does not mistake lag
   * for a re-request.
   *
   * GitHub reference: octokit.pulls.get() → data.requested_reviewers
   */
  isReviewRequested(
    ref: RepoRef,
    number: number,
    reviewerLogin: string,
  ): Promise<boolean>;
}
