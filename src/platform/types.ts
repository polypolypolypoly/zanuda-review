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
export interface PullRequest {
  ref: RepoRef;
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  /** Unified diff of the whole PR. */
  diff: string;
  changedFiles: string[];
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
   * Return the authenticated bot account's login/username.
   * Called once at startup; the result is cached for the process lifetime.
   */
  getBotLogin(): Promise<string>;

  /**
   * Return all open PRs/MRs where the bot has been requested as a reviewer.
   * This is the poller heartbeat — called every POLL_INTERVAL_SECS.
   * Return [] when there is nothing to review.
   */
  pollPendingReviews(botLogin: string): Promise<PendingReview[]>;

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
   * authors influence the bot by editing files in their branch.
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
   */
  postReview(
    pr: PullRequest,
    result: ReviewResult,
    config: Config,
  ): Promise<void>;

  /**
   * Post a standalone (non-review) comment on a PR.
   * Used for system notifications, e.g. "I've reached my review round limit."
   */
  postComment(ref: RepoRef, number: number, body: string): Promise<void>;

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
}
