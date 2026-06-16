/**
 * Parse the model's response into a ReviewResult.
 *
 * Handles both structured output (clean JSON from the provider's
 * jsonSchema / tool_use API) and plain-text responses that need
 * extraction from surrounding prose or code fences.
 */

import { ReviewResultSchema, type ReviewResult } from "./types.js";
import { logger } from "../logger.js";

/**
 * Parse the model's response into a ReviewResult.
 *
 * When the provider used structured output (jsonSchema), `text` is already
 * clean JSON and we skip extractJson. When it's a plain text response we run
 * the full extraction pipeline as a fallback.
 */
export function parseReviewResult(
  text: string,
  opts: { structured?: boolean } = {},
): ReviewResult {
  let parsed: ReviewResult;
  if (opts.structured) {
    parsed = ReviewResultSchema.parse(JSON.parse(text));
  } else {
    const json = extractJson(text);
    parsed = ReviewResultSchema.parse(JSON.parse(json));
  }

  // Warn when any field fell back to its catch/default value.
  const fallbacks: string[] = [];
  if (parsed.summary === "") fallbacks.push("summary");
  if (parsed.action === "COMMENT" && !text.includes("COMMENT"))
    fallbacks.push("action");
  if (
    parsed.filesSummary.length === 0 &&
    text.includes("filesSummary") === false
  )
    fallbacks.push("filesSummary");
  if (fallbacks.length > 0) {
    logger.warn(
      { fallbacks, rawResponse: text.slice(0, 300) },
      "Model returned malformed structured output — fallback values applied",
    );
  }

  return parsed;
}

/**
 * Extract a JSON object from the model's response.
 *
 * Strategy:
 * 1. Use brace-depth scanning from the first `{` to the matching `}`.
 * 2. If no opening brace, try stripping a wrapping code fence.
 */
export function extractJson(text: string): string {
  const json = tryExtractBalanced(text);
  if (json) return json;

  const fenced = text.match(/^```(?:json)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/);
  if (fenced) {
    const inner = fenced[1]!.trim();
    const json = tryExtractBalanced(inner);
    if (json) return json;
  }

  throw new Error(
    `No JSON object found in model response: ${text.slice(0, 200)}`,
  );
}

function tryExtractBalanced(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          JSON.parse(slice);
          return slice;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}
