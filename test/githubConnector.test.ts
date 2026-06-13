import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Octokit } from "@octokit/rest";
import {
  GitHubConnector,
  parseRepoRef,
} from "../src/platform/github/connector.ts";

describe("parseRepoRef", () => {
  it("parses a valid repository_url", () => {
    assert.deepEqual(
      parseRepoRef(
        "https://api.github.com/repos/polypolypolypoly/zanuda-review",
      ),
      { owner: "polypolypolypoly", repo: "zanuda-review" },
    );
  });

  it("returns null for malformed repository_url", () => {
    assert.equal(parseRepoRef("https://api.github.com/repositories/123"), null);
    assert.equal(parseRepoRef("not-a-url"), null);
  });
});

describe("GitHubConnector.pollPendingReviews", () => {
  it("skips malformed repository URLs and maps item id to platformId", async () => {
    const octokit = {
      rest: {
        search: {
          issuesAndPullRequests: async () => ({
            data: {
              items: [
                {
                  id: 12345,
                  number: 4,
                  title: "refactor connector",
                  repository_url:
                    "https://api.github.com/repos/polypolypolypoly/zanuda-review",
                },
                {
                  id: 67890,
                  number: 5,
                  title: "bad repo url",
                  repository_url: "https://api.github.com/repositories/67890",
                },
              ],
            },
          }),
        },
      },
    } as unknown as Octokit;

    const reviews = await new GitHubConnector(octokit).pollPendingReviews(
      "zanuda-bot",
    );

    assert.deepEqual(reviews, [
      {
        ref: { owner: "polypolypolypoly", repo: "zanuda-review" },
        number: 4,
        title: "refactor connector",
        platformId: 12345,
      },
    ]);
  });
});

describe("GitHubConnector.resolveReviewThreads", () => {
  it("resolves only unresolved Zanuda-authored threads", async () => {
    const mutationCalls: string[] = [];
    const octokit = {
      graphql: async (query: string, vars: Record<string, unknown>) => {
        if (query.includes("mutation")) {
          mutationCalls.push(vars.id as string);
          return { thread: { isResolved: true } };
        }
        // Query response
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "thread-1",
                    isResolved: false,
                    comments: { nodes: [{ author: { login: "zanuda-bot" } }] },
                  },
                  {
                    id: "thread-2",
                    isResolved: true, // already resolved
                    comments: { nodes: [{ author: { login: "zanuda-bot" } }] },
                  },
                  {
                    id: "thread-3",
                    isResolved: false,
                    comments: { nodes: [{ author: { login: "human" } }] }, // not Zanuda
                  },
                  {
                    id: "thread-4",
                    isResolved: false,
                    comments: { nodes: [{ author: { login: "Zanuda-Bot" } }] }, // case varies
                  },
                ],
              },
            },
          },
        };
      },
    } as unknown as Octokit;

    await new GitHubConnector(octokit).resolveReviewThreads(
      { owner: "polypolypolypoly", repo: "zanuda-review" },
      13,
      "zanuda-bot",
    );

    // Should resolve thread-1 and thread-4 (case-insensitive match)
    assert.deepEqual(mutationCalls.sort(), ["thread-1", "thread-4"]);
  });

  it("does not throw if mutation fails", async () => {
    const octokit = {
      graphql: async (query: string) => {
        if (query.includes("mutation")) {
          throw new Error("GraphQL mutation failed");
        }
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "thread-1",
                    isResolved: false,
                    comments: { nodes: [{ author: { login: "zanuda-bot" } }] },
                  },
                ],
              },
            },
          },
        };
      },
    } as unknown as Octokit;

    // Should not throw
    await assert.doesNotReject(
      new GitHubConnector(octokit).resolveReviewThreads(
        { owner: "polypolypolypoly", repo: "zanuda-review" },
        13,
        "zanuda-bot",
      ),
    );
  });
});

describe("replyToComment: thread root ID resolution", () => {
  it("uses inReplyToId (root) when replying to a thread reply", async () => {
    let capturedCommentId: number | undefined;
    const octokit = {
      pulls: {
        createReplyForReviewComment: async (params: {
          comment_id: number;
          body: string;
        }) => {
          capturedCommentId = params.comment_id;
        },
      },
    } as unknown as Octokit;

    const connector = new GitHubConnector(octokit);
    // Simulate a reply comment: id=456, inReplyToId=123 (root)
    await connector.replyToComment(
      { owner: "acme", repo: "repo" },
      42,
      {
        id: 456,
        type: "inline",
        author: "alice",
        body: "@ZlayaZanuda can you clarify?",
        inReplyToId: 123,
        createdAt: "2024-01-01T00:00:00Z",
      },
      "Sure, here is the clarification.",
    );

    assert.equal(
      capturedCommentId,
      123,
      "must use the root comment ID (inReplyToId), not the reply's own ID",
    );
  });

  it("uses own id when the comment is a thread root (no inReplyToId)", async () => {
    let capturedCommentId: number | undefined;
    const octokit = {
      pulls: {
        createReplyForReviewComment: async (params: {
          comment_id: number;
          body: string;
        }) => {
          capturedCommentId = params.comment_id;
        },
      },
    } as unknown as Octokit;

    const connector = new GitHubConnector(octokit);
    await connector.replyToComment(
      { owner: "acme", repo: "repo" },
      42,
      {
        id: 123,
        type: "inline",
        author: "alice",
        body: "@ZlayaZanuda what about X?",
        createdAt: "2024-01-01T00:00:00Z",
        // no inReplyToId — this is a root comment
      },
      "X is handled by Y.",
    );

    assert.equal(capturedCommentId, 123, "root comment: must use own id");
  });
});
