/**
 * Structured outputs is grammar-constrained: length and range keywords are not
 * in the supported JSON Schema subset and return a 400 rather than being
 * ignored. The canonical schema keeps them (the OpenAI-compatible path sends it
 * verbatim) and the hard output filters enforce them in code, so the Anthropic
 * path strips them on the way out.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeSchemaForAnthropic } from "../src/llm/anthropic.js";
import { buildReviewResultJsonSchema } from "../src/review/types.js";

/** Every key present anywhere in a schema tree. */
function allKeys(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) allKeys(item, found);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      allKeys(value, found);
    }
  }
  return found;
}

describe("sanitizeSchemaForAnthropic", () => {
  it("removes every unsupported keyword from the real review schema", () => {
    const sanitized = sanitizeSchemaForAnthropic(
      buildReviewResultJsonSchema(800, { round: 1 }),
    );
    const keys = allKeys(sanitized);

    for (const unsupported of [
      "maxLength",
      "minLength",
      "minimum",
      "maximum",
      "multipleOf",
    ]) {
      assert.ok(!keys.has(unsupported), `${unsupported} survived`);
    }
  });

  it("keeps the structure the review pipeline depends on", () => {
    const sanitized = sanitizeSchemaForAnthropic(
      buildReviewResultJsonSchema(800, { round: 1 }),
    ) as Record<string, unknown>;

    assert.equal(sanitized.additionalProperties, false);
    assert.deepEqual(sanitized.required, [
      "summary",
      "action",
      "filesSummary",
      "comments",
    ]);
    const props = sanitized.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(props.prSummary!.type, "string");
    assert.deepEqual((props.action!.enum as string[]).sort(), [
      "APPROVE",
      "COMMENT",
      "REQUEST_CHANGES",
    ]);
    const comment = (props.comments!.items as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    assert.equal(comment.line!.type, "integer");
    assert.deepEqual(comment.severity!.enum, ["blocker", "warning"]);
  });

  it("records the dropped constraint in the description", () => {
    const sanitized = sanitizeSchemaForAnthropic({
      type: "string",
      description: "The comment text.",
      maxLength: 400,
    }) as Record<string, string>;

    assert.equal(sanitized.description, "The comment text. (maxLength: 400)");
    assert.equal(sanitized.maxLength, undefined);
  });

  it("adds a description when the field had none", () => {
    const sanitized = sanitizeSchemaForAnthropic({
      type: "integer",
      minimum: 1,
    }) as Record<string, string>;

    assert.equal(sanitized.description, "(minimum: 1)");
  });

  it("leaves a schema with no unsupported keywords untouched", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string", enum: ["x", "y"] } },
      required: ["a"],
      additionalProperties: false,
    };
    assert.deepEqual(sanitizeSchemaForAnthropic(schema), schema);
  });
});
