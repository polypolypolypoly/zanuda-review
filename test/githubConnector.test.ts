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
