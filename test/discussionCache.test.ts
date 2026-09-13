/**
 * The mention scan re-fetches every tracked PR's discussion on every tick.
 * Conditional requests make the unchanged case free: GitHub answers 304 and
 * does not charge it against the core quota.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import type { Octokit } from "@octokit/rest";
import {
  clearDiscussionCache,
  fetchPRDiscussion,
} from "../src/github/comments.js";
import type { RepoRef } from "../src/platform/types.js";

const REF: RepoRef = { owner: "acme", repo: "widget" };

const issueComment = {
  id: 1,
  user: { login: "alice" },
  body: "looks good",
  created_at: "2026-01-01T00:00:00Z",
};

interface Call {
  endpoint: string;
  headers: Record<string, string>;
}

/**
 * Fake Octokit: serves one page per endpoint, answers 304 (thrown, as octokit
 * does) when the request carries a matching if-none-match.
 */
function fakeOctokit(opts: { etag?: string; link?: string } = {}) {
  const calls: Call[] = [];
  let paginateCalls = 0;

  const page = (endpoint: string, data: unknown[]) => {
    return async (params: { headers?: Record<string, string> }) => {
      const headers = params.headers ?? {};
      calls.push({ endpoint, headers });
      if (opts.etag && headers["if-none-match"] === opts.etag) {
        throw Object.assign(new Error("Not modified"), { status: 304 });
      }
      return {
        data,
        headers: { etag: opts.etag, link: opts.link },
      };
    };
  };

  const octokit = {
    pulls: { listReviewComments: page("review", []) },
    issues: { listComments: page("issue", [issueComment]) },
    async paginate() {
      paginateCalls++;
      return [issueComment];
    },
  } as unknown as Octokit;

  return {
    octokit,
    calls,
    get paginateCalls() {
      return paginateCalls;
    },
  };
}

beforeEach(() => clearDiscussionCache());

describe("fetchPRDiscussion: conditional requests", () => {
  it("sends no validator on the first fetch", async () => {
    const fake = fakeOctokit({ etag: 'W/"abc"' });
    const comments = await fetchPRDiscussion(fake.octokit, REF, 42);

    assert.equal(comments.length, 1);
    assert.ok(
      fake.calls.every((c) => c.headers["if-none-match"] === undefined),
      "nothing to validate against yet",
    );
  });

  it("sends the stored ETag on the next fetch and serves the 304 from cache", async () => {
    const fake = fakeOctokit({ etag: 'W/"abc"' });
    const first = await fetchPRDiscussion(fake.octokit, REF, 42);
    const second = await fetchPRDiscussion(fake.octokit, REF, 42);

    assert.deepEqual(second, first, "304 must return the same comments");
    assert.ok(
      fake.calls
        .slice(2)
        .every((c) => c.headers["if-none-match"] === 'W/"abc"'),
      "second round of calls must be conditional",
    );
    assert.equal(fake.paginateCalls, 0, "single page — no pagination needed");
  });

  it("caches per PR, not globally", async () => {
    const fake = fakeOctokit({ etag: 'W/"abc"' });
    await fetchPRDiscussion(fake.octokit, REF, 42);
    fake.calls.length = 0;

    await fetchPRDiscussion(fake.octokit, REF, 99);
    assert.ok(
      fake.calls.every((c) => c.headers["if-none-match"] === undefined),
      "a different PR has its own cache entry",
    );
  });

  it("falls back to pagination when the result spans pages", async () => {
    const fake = fakeOctokit({
      etag: 'W/"abc"',
      link: '<https://api.github.com/x?page=2>; rel="next"',
    });

    await fetchPRDiscussion(fake.octokit, REF, 42);
    assert.equal(fake.paginateCalls, 2, "both endpoints paginate");

    // A multi-page result is not cached: the ETag only covers page 1.
    fake.calls.length = 0;
    await fetchPRDiscussion(fake.octokit, REF, 42);
    assert.ok(
      fake.calls.every((c) => c.headers["if-none-match"] === undefined),
      "no stale single-page ETag may be reused",
    );
  });

  it("propagates real errors instead of serving stale data", async () => {
    const fake = fakeOctokit({ etag: 'W/"abc"' });
    await fetchPRDiscussion(fake.octokit, REF, 42);

    (fake.octokit.issues as { listComments: unknown }).listComments =
      async () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      };

    await assert.rejects(
      () => fetchPRDiscussion(fake.octokit, REF, 42),
      /boom/,
    );
  });
});
