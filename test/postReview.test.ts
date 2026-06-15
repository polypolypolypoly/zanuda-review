import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { postReview } from "../src/github/postReview.js";
import type { Octokit } from "@octokit/rest";
import type { Config } from "../src/config.js";
import type { PullRequest } from "../src/platform/types.js";
import type { ReviewResult } from "../src/review/types.js";

// ── Mock helpers ──────────────────────────────────────────────────────────────

function mockOctokit(
  createReviewImpl: (params: unknown) => Promise<unknown>,
): Octokit {
  return {
    pulls: {
      createReview: createReviewImpl as Octokit["pulls"]["createReview"],
    },
  } as Octokit;
}

function mockPR(): PullRequest {
  return {
    ref: { owner: "test-owner", repo: "test-repo" },
    number: 42,
    title: "Test PR",
    body: "",
    baseSha: "base123",
    headSha: "head456",
    diff: "",
    changedFiles: ["src/file1.ts", "src/file2.ts"],
    files: [],
    state: "open",
  };
}

function mockConfig(): Config {
  return {
    review: {
      inlineComments: true,
    },
  } as Config;
}

function mockResult(
  comments: Array<{ path: string; line: number }>,
): ReviewResult {
  return {
    summary: "Test summary",
    action: "COMMENT" as const,
    filesSummary: [],
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      severity: "warning" as const,
      body: "Test comment",
    })),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("postReview 422 recovery", () => {
  it("happy path: posts all inline comments without 422", async () => {
    let capturedParams: unknown = null;
    const octokit = mockOctokit(async (params) => {
      capturedParams = params;
      return {};
    });

    const pr = mockPR();
    const result = mockResult([
      { path: "src/file1.ts", line: 10 },
      { path: "src/file2.ts", line: 20 },
    ]);
    const config = mockConfig();

    await postReview(octokit, pr, result, config, {
      summaryPostedElsewhere: true,
    });

    const params = capturedParams as { comments?: unknown[] };
    assert.ok(params);
    assert.equal(params.comments?.length, 2);
  });

  it("422 on first attempt → salvages visible comments, hidden in body", async () => {
    let attempt = 0;
    const capturedParams: unknown[] = [];

    const octokit = mockOctokit(async (params) => {
      capturedParams.push(params);
      attempt++;
      if (attempt === 1) {
        // First attempt with all comments → 422
        const err = new Error("Validation Failed") as { status?: number };
        err.status = 422;
        throw err;
      }
      // Second attempt succeeds
      return {};
    });

    const pr = mockPR();
    const result = mockResult([
      { path: "src/file1.ts", line: 10 }, // visible
      { path: "src/hidden.ts", line: 30 }, // not visible
    ]);
    const config = mockConfig();
    const visibleFilePaths = new Set(["src/file1.ts", "src/file2.ts"]);

    await postReview(octokit, pr, result, config, {
      summaryPostedElsewhere: true,
      visibleFilePaths,
    });

    assert.equal(capturedParams.length, 2);

    // First attempt had all comments
    const first = capturedParams[0] as { comments?: unknown[] };
    assert.equal(first.comments?.length, 2);

    // Second attempt has only visible comments inline, hidden in body
    const second = capturedParams[1] as { comments?: unknown[]; body?: string };
    assert.equal(second.comments?.length, 1);
    assert.ok(second.body?.includes("src/hidden.ts:30"));
  });

  it("double 422 → falls back to full body dump with no inline comments", async () => {
    let attempt = 0;
    const capturedParams: unknown[] = [];

    const octokit = mockOctokit(async (params) => {
      capturedParams.push(params);
      attempt++;
      if (attempt <= 2) {
        // Both attempts → 422
        const err = new Error("Validation Failed") as { status?: number };
        err.status = 422;
        throw err;
      }
      // Third attempt succeeds
      return {};
    });

    const pr = mockPR();
    const result = mockResult([
      { path: "src/file1.ts", line: 10 },
      { path: "src/file2.ts", line: 20 },
    ]);
    const config = mockConfig();
    const visibleFilePaths = new Set(["src/file1.ts", "src/file2.ts"]);

    await postReview(octokit, pr, result, config, {
      summaryPostedElsewhere: true,
      visibleFilePaths,
    });

    assert.equal(capturedParams.length, 3);

    // Final attempt has no inline comments, everything in body
    const final = capturedParams[2] as { comments?: unknown[]; body?: string };
    assert.equal(final.comments, undefined); // no comments array passed
    assert.ok(final.body?.includes("src/file1.ts:10"));
    assert.ok(final.body?.includes("src/file2.ts:20"));
    assert.ok(final.body?.includes("Inline comment anchoring failed"));
  });

  it("non-422 error is re-thrown immediately", async () => {
    const octokit = mockOctokit(async () => {
      const err = new Error("Network error") as { status?: number };
      err.status = 500;
      throw err;
    });

    const pr = mockPR();
    const result = mockResult([{ path: "src/file1.ts", line: 10 }]);
    const config = mockConfig();

    await assert.rejects(
      async () => {
        await postReview(octokit, pr, result, config);
      },
      (err: Error) => {
        return err.message === "Network error";
      },
    );
  });

  it("no visibleFilePaths → skips visible-only retry, goes straight to body dump", async () => {
    let attempt = 0;
    const capturedParams: unknown[] = [];

    const octokit = mockOctokit(async (params) => {
      capturedParams.push(params);
      attempt++;
      if (attempt === 1) {
        const err = new Error("Validation Failed") as { status?: number };
        err.status = 422;
        throw err;
      }
      return {};
    });

    const pr = mockPR();
    const result = mockResult([
      { path: "src/file1.ts", line: 10 },
      { path: "src/file2.ts", line: 20 },
    ]);
    const config = mockConfig();

    // No visibleFilePaths provided → no salvage attempt
    await postReview(octokit, pr, result, config, {
      summaryPostedElsewhere: true,
    });

    // Only 2 attempts: first all-inline (422), then full body dump
    assert.equal(capturedParams.length, 2);
    const final = capturedParams[1] as { comments?: unknown[]; body?: string };
    assert.equal(final.comments, undefined);
    assert.ok(final.body?.includes("src/file1.ts:10"));
  });

  it("inlineComments=false → no inline comments posted, all in body", async () => {
    let capturedParams: unknown = null;
    const octokit = mockOctokit(async (params) => {
      capturedParams = params;
      return {};
    });

    const pr = mockPR();
    const result = mockResult([
      { path: "src/file1.ts", line: 10 },
      { path: "src/file2.ts", line: 20 },
    ]);
    const config = { ...mockConfig(), review: { inlineComments: false } };

    await postReview(octokit, pr, result, config, {
      summaryPostedElsewhere: false,
    });

    const params = capturedParams as { comments?: unknown[] };
    assert.equal(params.comments, undefined);
    // Should have posted just the summary in body (no inline fallback needed)
  });
});

// ── Suggestion rendering ─────────────────────────────────────────────────────

import {
  renderCommentBody,
  renderCommentSummary,
} from "../src/github/postReview.js";
import type { ReviewComment } from "../src/review/types.js";

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: "src/foo.ts",
    line: 42,
    severity: "warning",
    body: "Use const here.",
    ...overrides,
  };
}

describe("renderCommentBody", () => {
  it("renders body with severity emoji when no suggestion", () => {
    const result = renderCommentBody(makeComment());
    assert.ok(result.includes("⚠️"));
    assert.ok(result.includes("Use const here."));
    assert.ok(!result.includes("```suggestion"));
  });

  it("appends suggestion block when suggestion is present", () => {
    const result = renderCommentBody(
      makeComment({ suggestion: "const x = 1;" }),
    );
    assert.ok(result.includes("```suggestion"));
    assert.ok(result.includes("const x = 1;"));
  });

  it("sanitises fence-break lines starting with ```", () => {
    const result = renderCommentBody(
      makeComment({ suggestion: "line1\n```\nline3" }),
    );
    assert.ok(result.includes(" ```\nline3"));
  });

  it("sanitises indented fence-break lines too", () => {
    const result = renderCommentBody(
      makeComment({ suggestion: "line1\n  ```\nline3" }),
    );
    // Indented ``` should also get sanitised (GFM closes fence with up to 3 spaces).
    assert.ok(result.includes("   ```\nline3"));
  });

  it("preserves normal lines in multi-line suggestions", () => {
    const result = renderCommentBody(
      makeComment({
        suggestion: "function foo() {\n  return true;\n}",
      }),
    );
    assert.ok(result.includes("function foo() {"));
    assert.ok(result.includes("  return true;"));
    // Normal code lines should not be modified.
    assert.ok(!result.includes(" function foo"));
  });
});

describe("renderCommentSummary", () => {
  it("renders one-line summary without suggestion", () => {
    const result = renderCommentSummary(makeComment());
    assert.ok(result.includes("⚠️"));
    assert.ok(result.includes("src/foo.ts:42"));
    assert.ok(result.includes("Use const here."));
    assert.ok(!result.includes("Suggestion:"));
  });

  it("includes suggestion preview for short suggestions", () => {
    const result = renderCommentSummary(
      makeComment({ suggestion: "return null;" }),
    );
    assert.ok(result.includes("Suggestion:"));
    assert.ok(result.includes("return null;"));
  });

  it("truncates suggestion preview at 80 chars", () => {
    const long = "x".repeat(100);
    const result = renderCommentSummary(makeComment({ suggestion: long }));
    assert.ok(result.includes("…"));
    // Preview should be <= 80 chars + ellipsis in the rendered output.
    const previewPart = result.split("Suggestion: `")[1]!;
    assert.ok(previewPart.length <= 85);
  });
});
