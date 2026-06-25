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

  it("excludes draft PRs from search query", async () => {
    let capturedQuery: string | undefined;
    const octokit = {
      rest: {
        search: {
          issuesAndPullRequests: async (params: { q: string }) => {
            capturedQuery = params.q;
            return { data: { items: [] } };
          },
        },
      },
    } as unknown as Octokit;

    await new GitHubConnector(octokit).pollPendingReviews("zanuda-bot");

    assert.ok(
      capturedQuery?.includes("-is:draft"),
      "query must exclude draft PRs to prevent wasted review cycles",
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

describe("GitHubConnector.isReviewRequested", () => {
  const makeOctokit = (reviewers: { login: string }[] | null) =>
    ({
      pulls: {
        get: async () => ({
          data: { requested_reviewers: reviewers },
        }),
      },
    }) as unknown as Octokit;

  it("returns true when the reviewer is in requested_reviewers (case-insensitive)", async () => {
    const connector = new GitHubConnector(
      makeOctokit([{ login: "ZlayaZanuda" }]),
    );
    assert.equal(
      await connector.isReviewRequested(
        { owner: "acme", repo: "r" },
        7,
        "zlayazanuda",
      ),
      true,
    );
  });

  it("returns false when the reviewer is NOT requested", async () => {
    const connector = new GitHubConnector(
      makeOctokit([{ login: "someone-else" }]),
    );
    assert.equal(
      await connector.isReviewRequested(
        { owner: "acme", repo: "r" },
        7,
        "ZlayaZanuda",
      ),
      false,
    );
  });

  it("returns false when requested_reviewers is null/undefined", async () => {
    const connector = new GitHubConnector(makeOctokit(null));
    assert.equal(
      await connector.isReviewRequested(
        { owner: "acme", repo: "r" },
        7,
        "ZlayaZanuda",
      ),
      false,
    );
  });

  it("skips entries with a missing/undefined login without throwing", async () => {
    const connector = new GitHubConnector(
      makeOctokit([
        { login: undefined } as unknown as { login: string },
        { login: "ZlayaZanuda" },
      ]),
    );
    assert.equal(
      await connector.isReviewRequested(
        { owner: "acme", repo: "r" },
        7,
        "zlayazanuda",
      ),
      true,
    );

    const allBroken = new GitHubConnector(
      makeOctokit([{ login: undefined } as unknown as { login: string }]),
    );
    assert.equal(
      await allBroken.isReviewRequested(
        { owner: "acme", repo: "r" },
        7,
        "ZlayaZanuda",
      ),
      false,
    );
  });
});
