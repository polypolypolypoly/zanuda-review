/**
 * Schema validation tests for ReviewResultSchema.
 *
 * These tests pin the resilience contract: what happens when the LLM returns
 * a structurally valid JSON object but with wrong, missing, or partially
 * invalid content. Every failure mode that has occurred in production or that
 * is plausible given observed LLM behaviour should be covered here.
 *
 * Design rule: if a new production failure surfaces, add a test FIRST that
 * reproduces it, then fix the schema, then verify the test passes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReviewResultSchema } from "../src/review/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const validResult = () => ({
  summary: "Looks good",
  action: "APPROVE" as const,
  filesSummary: [{ path: "src/main.ts", description: "Added feature" }],
  comments: [
    {
      path: "src/main.ts",
      line: 42,
      severity: "warning",
      body: "Consider renaming.",
    },
  ],
});

const validComment = () => ({
  path: "src/foo.ts",
  line: 10,
  severity: "warning" as const,
  body: "note",
});

const validFileSummary = () => ({
  path: "src/foo.ts",
  description: "updated logic",
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("ReviewResultSchema validation", () => {
  it("parses a complete valid result", () => {
    const result = ReviewResultSchema.parse(validResult());
    assert.equal(result.action, "APPROVE");
    assert.equal(result.comments.length, 1);
    assert.equal(result.filesSummary.length, 1);
    assert.equal(result.summary, "Looks good");
  });

  it("accepts all valid action enum values", () => {
    for (const action of ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const) {
      const r = ReviewResultSchema.parse({ ...validResult(), action });
      assert.equal(r.action, action);
    }
  });

  it("accepts empty filesSummary and comments arrays", () => {
    const r = ReviewResultSchema.parse({
      ...validResult(),
      filesSummary: [],
      comments: [],
    });
    assert.equal(r.filesSummary.length, 0);
    assert.equal(r.comments.length, 0);
  });

  // ─── Missing top-level fields (LLM omits a field entirely) ──────────────────

  it("defaults missing comments to empty array", () => {
    const { comments: _, ...input } = validResult();
    const r = ReviewResultSchema.parse(input);
    assert.deepEqual(r.comments, []);
  });

  it("defaults missing filesSummary to empty array", () => {
    const { filesSummary: _, ...input } = validResult();
    const r = ReviewResultSchema.parse(input);
    assert.deepEqual(r.filesSummary, []);
  });

  it("falls back to empty string on missing summary", () => {
    const { summary: _, ...input } = validResult();
    const r = ReviewResultSchema.parse(input);
    assert.equal(r.summary, "");
  });

  it("falls back to COMMENT on missing action", () => {
    const { action: _, ...input } = validResult();
    const r = ReviewResultSchema.parse(input);
    assert.equal(r.action, "COMMENT");
  });

  it("handles completely empty object — all fallbacks fire", () => {
    // Reproduces the failure mode where toolBlock.input is {} because
    // no tool_use block was found (Anthropic provider falls back to "{}").
    const r = ReviewResultSchema.parse({});
    assert.equal(r.summary, "");
    assert.equal(r.action, "COMMENT");
    assert.deepEqual(r.filesSummary, []);
    assert.deepEqual(r.comments, []);
  });

  // ─── Invalid top-level field values ─────────────────────────────────────────

  it("falls back to COMMENT on invalid action enum value", () => {
    const r = ReviewResultSchema.parse({ ...validResult(), action: "NITPICK" });
    assert.equal(r.action, "COMMENT");
  });

  it("falls back to COMMENT on null action", () => {
    const r = ReviewResultSchema.parse({ ...validResult(), action: null });
    assert.equal(r.action, "COMMENT");
  });

  it("falls back to empty string on null summary", () => {
    const r = ReviewResultSchema.parse({ ...validResult(), summary: null });
    assert.equal(r.summary, "");
  });

  it("falls back to empty string on numeric summary", () => {
    const r = ReviewResultSchema.parse({ ...validResult(), summary: 42 });
    assert.equal(r.summary, "");
  });

  // ─── Invalid items inside comments array ─────────────────────────────────────
  //
  // Each of these was a plausible production failure mode. A single bad item
  // must NOT cause the entire review to fail — it is silently dropped.

  it("drops comment item with invalid severity, keeps valid items", () => {
    const r = ReviewResultSchema.parse({
      ...validResult(),
      comments: [
        validComment(),
        { ...validComment(), line: 20, severity: "nitpick" }, // invalid
        { ...validComment(), line: 30 }, // valid
      ],
    });
    // The valid items (lines 10 and 30) are kept; line 20 is dropped.
    assert.equal(r.comments.length, 2);
    assert.ok(r.comments.every((c) => c.severity === "warning"));
  });

  it("drops comment item with missing required field (no path)", () => {
    const { path: _, ...noPath } = validComment();
    const r = ReviewResultSchema.parse({
      ...validResult(),
      comments: [validComment(), noPath],
    });
    assert.equal(r.comments.length, 1);
  });

  it("drops comment item with non-positive line number", () => {
    const r = ReviewResultSchema.parse({
      ...validResult(),
      comments: [
        { ...validComment(), line: 0 }, // invalid
        { ...validComment(), line: -5 }, // invalid
        validComment(), // valid
      ],
    });
    assert.equal(r.comments.length, 1);
  });

  it("drops comment item with missing body", () => {
    const { body: _, ...noBody } = validComment();
    const r = ReviewResultSchema.parse({
      ...validResult(),
      comments: [noBody, validComment()],
    });
    assert.equal(r.comments.length, 1);
  });

  it("returns empty array when ALL comment items are invalid", () => {
    const r = ReviewResultSchema.parse({
      ...validResult(),
      comments: [
        { ...validComment(), severity: "nitpick" },
        { ...validComment(), line: 0 },
      ],
    });
    assert.deepEqual(r.comments, []);
  });

  it("handles comments field being null (not array)", () => {
    const r = ReviewResultSchema.parse({ ...validResult(), comments: null });
    assert.deepEqual(r.comments, []);
  });

  it("handles comments field being a non-array value", () => {
    const r = ReviewResultSchema.parse({ ...validResult(), comments: "oops" });
    assert.deepEqual(r.comments, []);
  });

  // ─── Invalid items inside filesSummary array ──────────────────────────────

  it("drops filesSummary item with missing path, keeps valid items", () => {
    const { path: _, ...noPath } = validFileSummary();
    const r = ReviewResultSchema.parse({
      ...validResult(),
      filesSummary: [validFileSummary(), noPath],
    });
    assert.equal(r.filesSummary.length, 1);
    assert.equal(r.filesSummary[0]?.path, "src/foo.ts");
  });

  it("drops filesSummary item with missing description", () => {
    const { description: _, ...noDesc } = validFileSummary();
    const r = ReviewResultSchema.parse({
      ...validResult(),
      filesSummary: [noDesc, validFileSummary()],
    });
    assert.equal(r.filesSummary.length, 1);
  });

  it("returns empty array when ALL filesSummary items are invalid", () => {
    const r = ReviewResultSchema.parse({
      ...validResult(),
      filesSummary: [{ bad: true }, { also_bad: 1 }],
    });
    assert.deepEqual(r.filesSummary, []);
  });

  it("handles filesSummary being null", () => {
    const r = ReviewResultSchema.parse({
      ...validResult(),
      filesSummary: null,
    });
    assert.deepEqual(r.filesSummary, []);
  });

  // ─── Mixed valid / invalid ────────────────────────────────────────────────

  it("valid items are preserved when mixed with invalid ones", () => {
    const r = ReviewResultSchema.parse({
      ...validResult(),
      comments: [
        validComment(),
        { ...validComment(), line: 20, body: "second valid" },
        { path: "x.ts", line: -1, severity: "warning", body: "bad line" },
        { path: "x.ts", line: 5, severity: "praise", body: "bad severity" },
      ],
    });
    assert.equal(r.comments.length, 2);
    assert.ok(r.comments.some((c) => c.body === "second valid"));
  });
});
