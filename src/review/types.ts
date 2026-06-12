import { z } from "zod";

/**
 * The structured output we ask the model to return. Keeping it a strict schema
 * lets us post precise inline comments and fail loudly on malformed responses.
 */
export const ReviewCommentSchema = z.object({
  path: z.string().describe("Repo-relative file path the comment applies to."),
  line: z
    .number()
    .int()
    .positive()
    .describe("Line number in the NEW version of the file (the '+' side)."),
  severity: z.enum(["blocker", "warning", "nitpick", "praise"]),
  body: z.string().describe("The comment text, in markdown."),
});

export const FileSummarySchema = z.object({
  path: z.string().describe("Repo-relative file path."),
  description: z.string().describe("One-line description of what changed in this file."),
});

export const ReviewResultSchema = z.object({
  summary: z.string().describe("Overall assessment, 1-4 sentences."),
  filesSummary: z.array(FileSummarySchema).describe("One entry per changed file."),
  comments: z.array(ReviewCommentSchema),
});

export type FileSummary = z.infer<typeof FileSummarySchema>;

export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
