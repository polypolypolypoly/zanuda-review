import type { Octokit } from "@octokit/rest";
import type { Config } from "../../config.js";
import { replyToComment, fetchPRDiscussion } from "../../github/comments.js";
import { postReview as ghPostReview } from "../../github/postReview.js";
import { fetchPullRequest } from "../../github/pullRequest.js";
import { logger } from "../../logger.js";
import type { ReviewResult } from "../../review/types.js";
import type {
  FileTree,
  PendingReview,
  PullRequest,
  RepoRef,
  SCMComment,
  SCMConnector,
} from "../types.js";

export class GitHubConnector implements SCMConnector {
  readonly name = "github";

  constructor(private readonly octokit: Octokit) {}

  async getBotLogin(): Promise<string> {
    const { data } = await this.octokit.users.getAuthenticated();
    return data.login;
  }

  async pollPendingReviews(botLogin: string): Promise<PendingReview[]> {
    const { data } = await this.octokit.rest.search.issuesAndPullRequests({
      q: `is:pr is:open review-requested:${botLogin}`,
      per_page: 50,
    });
    return data.items.flatMap((item) => {
      const ref = parseRepoRef(item.repository_url);
      if (!ref) {
        logger.warn(
          { url: item.repository_url },
          "Could not parse repo URL — skipping",
        );
        return [];
      }
      return [
        {
          ref,
          number: item.number,
          title: item.title,
          platformId: item.id,
        },
      ];
    });
  }

  async fetchPR(ref: RepoRef, number: number): Promise<PullRequest> {
    return fetchPullRequest(this.octokit, ref, number);
  }

  async readFile(
    ref: RepoRef,
    path: string,
    gitRef: string,
  ): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        ...ref,
        path,
        ref: gitRef,
      });
      if (!Array.isArray(data) && data.type === "file") {
        return Buffer.from(data.content, "base64").toString("utf8");
      }
      return null;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async getFileTree(
    ref: RepoRef,
    gitRef: string,
    maxEntries: number,
  ): Promise<FileTree> {
    try {
      const { data } = await this.octokit.git.getTree({
        ...ref,
        tree_sha: gitRef,
        recursive: "true",
      });
      const all = data.tree
        .filter((t) => t.type === "blob" && t.path)
        .map((t) => t.path as string);
      return {
        paths: all.slice(0, maxEntries),
        truncated: data.truncated || all.length > maxEntries,
        total: all.length,
      };
    } catch (err) {
      logger.warn({ err }, "Could not build file tree");
      return { paths: [], truncated: false, total: 0 };
    }
  }

  async fetchDiscussion(ref: RepoRef, number: number): Promise<SCMComment[]> {
    return fetchPRDiscussion(this.octokit, ref, number);
  }

  async postReview(
    pr: PullRequest,
    result: ReviewResult,
    config: Config,
  ): Promise<void> {
    return ghPostReview(this.octokit, pr, result, config);
  }

  async postComment(
    ref: RepoRef,
    number: number,
    body: string,
  ): Promise<number> {
    const { data } = await this.octokit.issues.createComment({
      ...ref,
      issue_number: number,
      body,
    });
    return data.id;
  }

  async editComment(
    ref: RepoRef,
    commentId: number,
    body: string,
  ): Promise<void> {
    await this.octokit.issues.updateComment({
      ...ref,
      comment_id: commentId,
      body,
    });
  }

  async replyToComment(
    ref: RepoRef,
    number: number,
    comment: SCMComment,
    body: string,
  ): Promise<void> {
    return replyToComment(this.octokit, ref, number, comment, body);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function parseRepoRef(repositoryUrl: string): RepoRef | null {
  const match = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}
