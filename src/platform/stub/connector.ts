/**
 * Stub connector — starting point for implementing a new platform.
 *
 * Copy this file, rename the class, and implement each method.
 * The review engine, LLM layer, and state store require zero changes.
 *
 * Steps:
 *   1. cp src/platform/stub/connector.ts src/platform/<name>/connector.ts
 *   2. Implement every method below.
 *   3. Export a factory function (see bottom of file).
 *   4. Register it in src/platform/index.ts.
 *   5. Add PLATFORM=<name> to .env.example.
 *
 * The GitHub implementation (src/platform/github/connector.ts) is the
 * reference — read it alongside this file.
 */

import type { Config } from "../../config.js";
import type { ReviewResult } from "../../review/types.js";
import type {
  FileTree,
  PendingReview,
  PullRequest,
  RepoRef,
  SCMComment,
  SCMConnector,
} from "../types.js";

export class StubConnector implements SCMConnector {
  readonly name = "stub";

  /**
   * Return the reviewer account's login/username.
   *
   * Implementation hint: make an authenticated API call to the platform
   * and return the "current user" login. The result is cached by the
   * caller — you only need to fetch it once.
   *
   * GitHub reference: octokit.users.getAuthenticated() → data.login
   * GitLab equivalent: GET /api/v4/user → .username
   */
  async getReviewerLogin(): Promise<string> {
    throw new Error("StubConnector.getReviewerLogin: not implemented");
  }

  /**
   * Return all open PRs/MRs where the reviewer has been requested.
   *
   * This is called on every poll tick. Return [] when there is nothing to do.
   * The `platformId` field must be a stable, globally-unique integer for the
   * lifetime of the PR — it is used as the key for round and mention tracking.
   *
   * Implementation hints:
   * - GitHub: search API with `is:pr is:open review-requested:<reviewerLogin>`
   * - GitLab: GET /api/v4/merge_requests?reviewer_username=<reviewerLogin>&state=opened
   * - Bitbucket: GET /2.0/pullrequests/<workspace>?q=reviewers.nickname="<reviewerLogin>"
   *
   * Only return PRs from repos that pass your allowlist check.
   */
  async pollPendingReviews(_reviewerLogin: string): Promise<PendingReview[]> {
    throw new Error("StubConnector.pollPendingReviews: not implemented");
  }

  /**
   * Fetch full PR data for a single PR number.
   *
   * Must return:
   * - `baseSha`: the target branch HEAD commit SHA (used to read config files)
   * - `headSha`: the PR branch HEAD commit SHA (used to anchor inline comments)
   * - `diff`: unified diff of the whole PR (the "+ / -" format)
   * - `changedFiles`: flat list of affected file paths
   *
   * GitHub reference: octokit.pulls.get() + octokit.pulls.get({ mediaType: { format: "diff" } })
   * GitLab equivalent: GET /api/v4/projects/:id/merge_requests/:iid + /diffs
   */
  async fetchPR(_ref: RepoRef, _number: number): Promise<PullRequest> {
    throw new Error("StubConnector.fetchPR: not implemented");
  }

  /**
   * Read a single file from the repo at the given git ref.
   * Return null if the file does not exist (404). Throw on other errors.
   *
   * IMPORTANT: callers always pass `pr.baseSha` for config and context files,
   * never `pr.headSha`. This prevents PR authors from influencing Zanuda's
   * behaviour by editing config files in their branch.
   *
   * GitHub reference: octokit.repos.getContent({ ref: gitRef }) → base64 decode
   * GitLab equivalent: GET /api/v4/projects/:id/repository/files/:path?ref=<sha>
   */
  async readFile(
    _ref: RepoRef,
    _path: string,
    _gitRef: string,
  ): Promise<string | null> {
    throw new Error("StubConnector.readFile: not implemented");
  }

  /**
   * Return the flat list of file paths in the repo at the given ref.
   * Cap the result at `maxEntries` and set `truncated: true` if there are more.
   *
   * GitHub reference: octokit.git.getTree({ recursive: "true" })
   * GitLab equivalent: GET /api/v4/projects/:id/repository/tree?recursive=true&ref=<sha>
   */
  async getFileTree(
    _ref: RepoRef,
    _gitRef: string,
    _maxEntries: number,
  ): Promise<FileTree> {
    throw new Error("StubConnector.getFileTree: not implemented");
  }

  /**
   * Fetch all comments on the PR, sorted chronologically.
   * Include both inline diff comments (type: "inline") and general discussion
   * comments (type: "general").
   *
   * GitHub reference: octokit.pulls.listReviewComments() + octokit.issues.listComments()
   * GitLab equivalent: GET /api/v4/projects/:id/merge_requests/:iid/notes
   *   (filter by position != null for inline, null for general)
   */
  async fetchDiscussion(_ref: RepoRef, _number: number): Promise<SCMComment[]> {
    throw new Error("StubConnector.fetchDiscussion: not implemented");
  }

  /**
   * Post the review result back to the platform.
   *
   * The `result.action` field maps to platform verdicts:
   *   "APPROVE"          → GitHub: APPROVE event   / GitLab: approved state
   *   "REQUEST_CHANGES"  → GitHub: REQUEST_CHANGES / GitLab: unapproved + thread
   *   "COMMENT"          → GitHub: COMMENT event   / GitLab: plain note
   *
   * `result.comments` are inline comments anchored to specific lines.
   * If the platform rejects an inline anchor (line not in diff), fall back
   * to posting the comments as a plain summary so no feedback is lost.
   *
   * GitHub reference: octokit.pulls.createReview({ event, comments })
   * GitLab equivalent: POST /api/v4/projects/:id/merge_requests/:iid/notes
   *   + POST .../discussions (for inline notes with position)
   */
  async postReview(
    _pr: PullRequest,
    _result: ReviewResult,
    _config: Config,
    _opts?: {
      summaryPostedElsewhere?: boolean;
      visibleFilePaths?: Set<string>;
    },
  ): Promise<void> {
    throw new Error("StubConnector.postReview: not implemented");
  }

  /**
   * Post a standalone comment (not part of a review) on the PR.
   * Used for system notifications, e.g. "I've reached my review round limit."
   *
   * GitHub reference: octokit.issues.createComment({ issue_number, body })
   * GitLab equivalent: POST /api/v4/projects/:id/merge_requests/:iid/notes
   */
  async postComment(
    _ref: RepoRef,
    _number: number,
    _body: string,
  ): Promise<number> {
    throw new Error("StubConnector.postComment: not implemented");
  }

  /**
   * Edit an existing comment by ID.
   *
   * GitHub reference: octokit.issues.updateComment({ comment_id, body })
   * GitLab equivalent: PUT /api/v4/projects/:id/merge_requests/:iid/notes/:note_id
   */
  async editComment(
    _ref: RepoRef,
    _commentId: number,
    _body: string,
  ): Promise<void> {
    throw new Error("StubConnector.editComment: not implemented");
  }

  /**
   * Reply to a specific comment.
   * - Inline comments: reply should appear in the same diff thread.
   * - General comments: post a new top-level comment.
   *
   * GitHub reference:
   *   inline  → octokit.pulls.createReplyForReviewComment({ comment_id })
   *   general → octokit.issues.createComment()
   * GitLab equivalent: POST /api/v4/projects/:id/merge_requests/:iid/discussions/:did/notes
   */
  async replyToComment(
    _ref: RepoRef,
    _number: number,
    _comment: SCMComment,
    _body: string,
  ): Promise<void> {
    throw new Error("StubConnector.replyToComment: not implemented");
  }

  /**
   * Resolve all open review threads started by Zanuda.
   * Called after APPROVE so outstanding threads don't block the merge.
   *
   * GitHub reference: GraphQL resolveReviewThread mutation
   * GitLab equivalent: resolve discussion via PUT .../notes/:id (set resolved=true)
   */
  async resolveReviewThreads(
    _ref: RepoRef,
    _number: number,
    _reviewerLogin: string,
  ): Promise<void> {
    throw new Error("StubConnector.resolveReviewThreads: not implemented");
  }
}
