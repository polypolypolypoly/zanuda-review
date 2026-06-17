/**
 * Regression tests for parseMemoryUpdateResponse.
 *
 * Verbatim from a production failure: the model prefixed the JSON with
 * explanatory prose and the old code (direct JSON.parse after fence-stripping)
 * silently discarded the update. extractJson handles this correctly.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMemoryUpdateResponse } from "../src/context/repoMemory.js";

const updatedContent = [
  "# Repo Memory: test/test",
  "Generated: 2026-01-01",
  "Updated: 2026-06-17",
  "",
  "## Architecture",
  "New architecture description.",
].join("\n");

describe("parseMemoryUpdateResponse", () => {
  it("parses prose-wrapped JSON (the production failure mode)", () => {
    const input =
      "Two new architectural facts: the self-verification pass and " +
      "dependency-aware batching. These are significant enough to capture.\n\n" +
      JSON.stringify({ update: true, content: updatedContent });

    const result = parseMemoryUpdateResponse(input);
    assert.equal(result.update, true);
    assert.ok(result.content!.includes("New architecture description"));
  });

  it("parses clean JSON without prose", () => {
    const result = parseMemoryUpdateResponse(JSON.stringify({ update: false }));
    assert.equal(result.update, false);
  });

  it("parses code-fenced JSON", () => {
    const result = parseMemoryUpdateResponse(
      "```json\n" +
        JSON.stringify({ update: true, content: updatedContent }) +
        "\n```",
    );
    assert.equal(result.update, true);
    assert.ok(result.content!.includes("New architecture description"));
  });

  it("throws on unparseable input with no JSON at all", () => {
    assert.throws(() =>
      parseMemoryUpdateResponse("I don't think this needs an update."),
    );
  });
});
