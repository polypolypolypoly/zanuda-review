/**
 * Property-based tests for ReviewResultSchema.
 *
 * These tests verify invariants that hold for ALL inputs — not just the
 * specific malformed cases we have seen in production. Every production
 * failure we have had (missing `comments`, wrong `action`, missing `summary`
 * + `filesSummary`) would have been caught by the properties here before
 * the first deployment.
 *
 * fast-check generates hundreds of random inputs per property and, on
 * failure, shrinks to the minimal reproducing case.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fc from "fast-check";
import { ReviewResultSchema } from "../src/review/types.ts";

const VALID_ACTIONS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;

// ── Arbitraries ───────────────────────────────────────────────────────────────

/** A valid ReviewComment object. */
const validCommentArb = fc.record({
  path: fc.string({ minLength: 1 }),
  line: fc.integer({ min: 1, max: 100_000 }),
  severity: fc.oneof(
    fc.constant("blocker" as const),
    fc.constant("warning" as const),
  ),
  body: fc.string(),
});

/** A valid FileSummary object. */
const validFileSummaryArb = fc.record({
  path: fc.string({ minLength: 1 }),
  description: fc.string(),
});

// ── Properties ────────────────────────────────────────────────────────────────

describe("ReviewResultSchema: never throws", () => {
  it("parses any JSON-like object without throwing", () => {
    fc.assert(
      fc.property(fc.object(), (obj) => {
        const result = ReviewResultSchema.parse(obj);
        // Structural invariants — always hold regardless of input
        assert.equal(typeof result.prSummary, "string");
        assert.equal(typeof result.summary, "string");
        assert.ok(
          (VALID_ACTIONS as readonly string[]).includes(result.action),
          `action "${result.action}" not in valid set`,
        );
        assert.ok(Array.isArray(result.comments));
        assert.ok(Array.isArray(result.filesSummary));
      }),
    );
  });

  it("parses any JSON-like value as the `action` field without throwing", () => {
    // This property would have caught the 'invalid action' production failure.
    fc.assert(
      fc.property(fc.anything(), (action) => {
        const result = ReviewResultSchema.parse({
          action,
          summary: "ok",
          filesSummary: [],
          comments: [],
        });
        assert.ok((VALID_ACTIONS as readonly string[]).includes(result.action));
      }),
    );
  });

  it("parses any value as the `summary` field — always returns a string", () => {
    // This property would have caught the 'missing summary' production failure.
    fc.assert(
      fc.property(fc.anything(), (summary) => {
        const result = ReviewResultSchema.parse({
          summary,
          action: "APPROVE",
          filesSummary: [],
          comments: [],
        });
        assert.equal(typeof result.summary, "string");
      }),
    );
  });

  it("parses any array as `comments` without throwing", () => {
    // This property would have caught the 'missing comments' production failure.
    fc.assert(
      fc.property(fc.array(fc.anything(), { maxLength: 10 }), (comments) => {
        const result = ReviewResultSchema.parse({
          summary: "ok",
          action: "APPROVE",
          filesSummary: [],
          comments,
        });
        assert.ok(Array.isArray(result.comments));
        // Every surviving item is a structurally valid ReviewComment
        for (const c of result.comments) {
          assert.equal(typeof c.path, "string");
          assert.ok(Number.isInteger(c.line) && c.line >= 1);
          assert.ok(["blocker", "warning"].includes(c.severity));
          assert.equal(typeof c.body, "string");
        }
      }),
    );
  });

  it("parses any array as `filesSummary` without throwing", () => {
    fc.assert(
      fc.property(
        fc.array(fc.anything(), { maxLength: 10 }),
        (filesSummary) => {
          const result = ReviewResultSchema.parse({
            summary: "ok",
            action: "APPROVE",
            filesSummary,
            comments: [],
          });
          assert.ok(Array.isArray(result.filesSummary));
          for (const f of result.filesSummary) {
            assert.equal(typeof f.path, "string");
            assert.equal(typeof f.description, "string");
          }
        },
      ),
    );
  });
});

describe("ReviewResultSchema: valid items are preserved", () => {
  it("all valid comments survive parsing — none are dropped", () => {
    fc.assert(
      fc.property(
        fc.array(validCommentArb, { minLength: 1, maxLength: 8 }),
        (comments) => {
          const result = ReviewResultSchema.parse({
            summary: "ok",
            action: "APPROVE",
            filesSummary: [],
            comments,
          });
          assert.equal(
            result.comments.length,
            comments.length,
            "valid comments were unexpectedly dropped",
          );
        },
      ),
    );
  });

  it("all valid fileSummary entries survive parsing", () => {
    fc.assert(
      fc.property(
        fc.array(validFileSummaryArb, { minLength: 1, maxLength: 8 }),
        (filesSummary) => {
          const result = ReviewResultSchema.parse({
            summary: "ok",
            action: "APPROVE",
            filesSummary,
            comments: [],
          });
          assert.equal(result.filesSummary.length, filesSummary.length);
        },
      ),
    );
  });

  it("valid comments mixed with invalid ones — valid ones always survive", () => {
    fc.assert(
      fc.property(
        fc.array(validCommentArb, { minLength: 1, maxLength: 5 }),
        fc.array(fc.anything(), { minLength: 0, maxLength: 5 }),
        (valid, invalid) => {
          // Interleave valid and invalid items
          const mixed: unknown[] = [];
          const maxLen = Math.max(valid.length, invalid.length);
          for (let i = 0; i < maxLen; i++) {
            if (i < valid.length) mixed.push(valid[i]);
            if (i < invalid.length) mixed.push(invalid[i]);
          }
          const result = ReviewResultSchema.parse({
            summary: "ok",
            action: "APPROVE",
            filesSummary: [],
            comments: mixed,
          });
          // Every valid input item must appear in the output
          for (const v of valid) {
            const found = result.comments.some(
              (c) =>
                c.path === v.path &&
                c.line === v.line &&
                c.severity === v.severity &&
                c.body === v.body,
            );
            assert.ok(
              found,
              `valid comment at ${v.path}:${v.line} was dropped`,
            );
          }
        },
      ),
    );
  });
});

describe("ReviewResultSchema: action fallback is always a valid action", () => {
  it("any string action value falls back to a valid action", () => {
    fc.assert(
      fc.property(fc.string(), (action) => {
        const result = ReviewResultSchema.parse({
          action,
          summary: "ok",
          filesSummary: [],
          comments: [],
        });
        assert.ok((VALID_ACTIONS as readonly string[]).includes(result.action));
      }),
    );
  });

  it("all three valid action values pass through unchanged", () => {
    for (const action of VALID_ACTIONS) {
      const result = ReviewResultSchema.parse({
        action,
        summary: "ok",
        filesSummary: [],
        comments: [],
      });
      assert.equal(result.action, action);
    }
  });
});
