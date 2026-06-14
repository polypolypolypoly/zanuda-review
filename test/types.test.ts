/**
 * Schema validation tests for ReviewResultSchema.
 *
 * These tests pin the structured-output parsing behaviour, especially
 * the handling of missing/invalid fields that LLM providers may occasionally
 * produce despite schema constraints.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReviewResultSchema } from "../src/review/types.ts";

describe("ReviewResultSchema validation", () => {
  it("parses a complete valid result", () => {
    const input = {
      summary: "Looks good",
      action: "APPROVE",
      filesSummary: [{ path: "src/main.ts", description: "Added feature" }],
      comments: [
        {
          path: "src/main.ts",
          line: 42,
          severity: "warning",
          body: "Consider renaming this.",
        },
      ],
    };
    const result = ReviewResultSchema.parse(input);
    assert.equal(result.action, "APPROVE");
    assert.equal(result.comments.length, 1);
    assert.equal(result.filesSummary.length, 1);
  });

  it("defaults missing comments field to empty array", () => {
    // LLM occasionally omits the comments field when it has nothing to say inline.
    // This is semantically "no comments", so we default to [].
    const input = {
      summary: "Clean PR",
      action: "APPROVE",
      filesSummary: [],
      // comments field omitted
    };
    const result = ReviewResultSchema.parse(input);
    assert.equal(result.comments.length, 0);
    assert.deepEqual(result.comments, []);
  });

  it("rejects invalid action enum value", () => {
    // Invalid action values must fail parsing so we don't silently ship wrong verdicts.
    const input = {
      summary: "Some summary",
      action: "NITPICK", // not one of APPROVE | REQUEST_CHANGES | COMMENT
      filesSummary: [],
      comments: [],
    };
    assert.throws(
      () => ReviewResultSchema.parse(input),
      (err: unknown) => {
        const zodErr = err as { issues?: Array<{ path: string[] }> };
        return (
          zodErr.issues?.[0]?.path?.[0] === "action" ||
          (err as Error).message.includes("action")
        );
      },
      "Expected ZodError with action path",
    );
  });

  it("accepts all valid action enum values", () => {
    const actions = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
    for (const action of actions) {
      const input = {
        summary: "test",
        action,
        filesSummary: [],
        comments: [],
      };
      const result = ReviewResultSchema.parse(input);
      assert.equal(result.action, action);
    }
  });

  it("rejects invalid severity in comments", () => {
    // We only allow blocker|warning, not e.g. "nitpick"
    const input = {
      summary: "test",
      action: "COMMENT",
      filesSummary: [],
      comments: [
        {
          path: "x.ts",
          line: 1,
          severity: "nitpick", // disallowed
          body: "minor note",
        },
      ],
    };
    assert.throws(
      () => ReviewResultSchema.parse(input),
      (err: unknown) => {
        const zodErr = err as { issues?: Array<{ path: (string | number)[] }> };
        return (
          JSON.stringify(zodErr.issues?.[0]?.path).includes("severity") ||
          (err as Error).message.includes("severity")
        );
      },
      "Expected ZodError with severity path",
    );
  });

  it("requires all mandatory fields in comments", () => {
    const input = {
      summary: "test",
      action: "COMMENT",
      filesSummary: [],
      comments: [
        {
          path: "a.ts",
          line: 5,
          // severity omitted
          body: "note",
        },
      ],
    };
    assert.throws(() => ReviewResultSchema.parse(input));
  });

  it("rejects non-positive line numbers", () => {
    const input = {
      summary: "test",
      action: "COMMENT",
      filesSummary: [],
      comments: [
        {
          path: "b.ts",
          line: 0, // must be positive
          severity: "warning",
          body: "invalid line",
        },
      ],
    };
    assert.throws(() => ReviewResultSchema.parse(input));
  });

  it("accepts empty filesSummary and comments arrays", () => {
    const input = {
      summary: "Nothing to report",
      action: "COMMENT",
      filesSummary: [],
      comments: [],
    };
    const result = ReviewResultSchema.parse(input);
    assert.equal(result.filesSummary.length, 0);
    assert.equal(result.comments.length, 0);
  });
});
