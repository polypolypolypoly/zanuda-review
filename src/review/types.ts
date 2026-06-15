import { z } from "zod";

/**
 * The structured output we ask the model to return. Keeping it a strict schema
 * lets us post precise inline comments and fail loudly on malformed responses.
 */
const ReviewCommentSchema = z.object({
  path: z.string().describe("Repo-relative file path the comment applies to."),
  line: z
    .number()
    .int()
    .positive()
    .describe("Line number in the NEW version of the file (the '+' side)."),
  severity: z.enum(["blocker", "warning"]),
  body: z.string().describe("The comment text, in markdown."),
  suggestion: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "Code replacement (new lines only, no fences). Omit if no concrete fix.",
    ),
});

const FileSummarySchema = z.object({
  path: z.string().describe("Repo-relative file path."),
  description: z
    .string()
    .describe("One-line description of what changed in this file."),
});

// ─── Resilient array helpers ─────────────────────────────────────────────────
//
// claude-opus-4-8 occasionally returns tool_use responses where individual
// array items are malformed (wrong severity, missing field, bad line number).
// Rather than failing the entire review because of one bad item, we filter
// out invalid entries and keep the rest.
//
// This is intentionally more lenient than the JSON Schema we pass to the API
// (which still declares the strict contract): the schema tells the model what
// to produce; this tells us what to do when it doesn't fully comply.

function filterValidItems<T>(schema: z.ZodType<T>, items: unknown[]): T[] {
  return items.flatMap((item) => {
    const r = schema.safeParse(item);
    return r.success ? [r.data] : [];
  });
}

// ─── ReviewResultSchema ───────────────────────────────────────────────────────
//
// Fallback strategy for each field — applied when the model returns a
// structurally valid JSON object but with wrong or missing values:
//
//   summary       — .catch("")        — blank renders gracefully; inline
//                                       comments and verdict are still useful.
//   action        — .catch("COMMENT") — safest / least-impactful action.
//   filesSummary  — item-level filter — bad entries silently dropped;
//                   field itself defaults to [] if absent.
//   comments      — item-level filter — same treatment.
//
// When any top-level fallback fires, parseReviewResult logs a warning with
// the first 300 chars of the raw response so the occurrence is debuggable.
export const ReviewResultSchema = z.object({
  prSummary: z
    .string()
    .default("")
    .describe(
      "Short neutral description of what this PR does — 1-3 sentences from the author's perspective (what changed and why). Not a review assessment. Round 1 only; omit in round 2.",
    ),
  summary: z.string().catch("").describe("Overall assessment, 1-4 sentences."),
  action: z
    .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
    .catch("COMMENT")
    .describe(
      "APPROVE if the PR is solid; REQUEST_CHANGES if any blocker exists; COMMENT if there are only warnings.",
    ),
  filesSummary: z
    .array(z.unknown())
    .default([])
    .transform((items) => filterValidItems(FileSummarySchema, items))
    .catch([])
    .describe("One entry per changed file."),
  comments: z
    .array(z.unknown())
    .default([])
    .transform((items) => filterValidItems(ReviewCommentSchema, items))
    .catch([]),
});

export type FileSummary = z.infer<typeof FileSummarySchema>;

export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/**
 * Build the JSON Schema for the review result, using the configured
 * maxCommentChars as the maxLength constraint on comment bodies.
 */
export function buildReviewResultJsonSchema(
  maxCommentChars: number,
): Record<string, unknown> {
  return {
    type: "object",
    // prSummary is intentionally NOT in required — round 2 should omit it.
    required: ["summary", "action", "filesSummary", "comments"],
    additionalProperties: false,
    properties: {
      prSummary: { type: "string" },
      summary: { type: "string" },
      action: {
        type: "string",
        enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"],
      },
      filesSummary: {
        type: "array",
        items: {
          type: "object",
          required: ["path", "description"],
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            description: { type: "string" },
          },
        },
      },
      comments: {
        type: "array",
        items: {
          type: "object",
          required: ["path", "line", "severity", "body"],
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            line: { type: "integer", minimum: 1 },
            severity: { type: "string", enum: ["blocker", "warning"] },
            body: { type: "string", maxLength: maxCommentChars },
            suggestion: { type: "string", maxLength: 2000 },
          },
        },
      },
    },
  };
}
