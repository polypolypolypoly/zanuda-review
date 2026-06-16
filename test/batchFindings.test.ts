import { describe, it } from "node:test";
import assert from "node:assert";
import { ReviewResultSchema } from "../src/review/types.js";

describe("ReviewResultSchema: batchFindings field", () => {
  it("parses batchFindings when present", () => {
    const result = ReviewResultSchema.parse({
      summary: "All good",
      action: "COMMENT",
      filesSummary: [],
      comments: [],
      batchFindings:
        "Found 2 warnings in auth module: SQL injection risk in login.ts, missing CSRF in session.ts",
    });
    assert.equal(
      result.batchFindings,
      "Found 2 warnings in auth module: SQL injection risk in login.ts, missing CSRF in session.ts",
    );
  });

  it("defaults batchFindings to undefined when absent", () => {
    const result = ReviewResultSchema.parse({
      summary: "Clean",
      action: "APPROVE",
      filesSummary: [],
      comments: [],
    });
    assert.equal(result.batchFindings, undefined);
  });

  it("handles null batchFindings gracefully", () => {
    const result = ReviewResultSchema.parse({
      summary: "ok",
      action: "COMMENT",
      filesSummary: [],
      comments: [],
      batchFindings: null,
    });
    assert.equal(result.batchFindings, undefined);
  });

  it("handles non-string batchFindings gracefully", () => {
    const result = ReviewResultSchema.parse({
      summary: "ok",
      action: "COMMENT",
      filesSummary: [],
      comments: [],
      batchFindings: 123,
    });
    assert.equal(result.batchFindings, undefined);
  });

  it("batchFindings survives alongside valid comments", () => {
    const result = ReviewResultSchema.parse({
      summary: "Issues found",
      action: "REQUEST_CHANGES",
      filesSummary: [{ path: "src/app.ts", description: "Changed auth flow" }],
      comments: [
        {
          path: "src/app.ts",
          line: 42,
          severity: "blocker",
          body: "SQL injection risk",
        },
      ],
      batchFindings: "Blocker: SQL injection in src/app.ts:42",
    });
    assert.equal(result.action, "REQUEST_CHANGES");
    assert.equal(result.comments.length, 1);
    assert.equal(
      result.batchFindings,
      "Blocker: SQL injection in src/app.ts:42",
    );
  });
});
