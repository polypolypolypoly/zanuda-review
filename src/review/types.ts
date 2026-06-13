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
});

const FileSummarySchema = z.object({
  path: z.string().describe("Repo-relative file path."),
  description: z
    .string()
    .describe("One-line description of what changed in this file."),
});

export const ReviewResultSchema = z.object({
  summary: z.string().describe("Overall assessment, 1-4 sentences."),
  action: z
    .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
    .describe(
      "APPROVE if the PR is solid; REQUEST_CHANGES if any blocker exists; COMMENT if there are only warnings or observations.",
    ),
  filesSummary: z
    .array(FileSummarySchema)
    .describe("One entry per changed file."),
  comments: z.array(ReviewCommentSchema),
});

export type FileSummary = z.infer<typeof FileSummarySchema>;

export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
