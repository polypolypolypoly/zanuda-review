import type { Config } from "../config.js";
import type { ProjectContext } from "../context/builder.js";
import type { PullRequestData } from "../github/pullRequest.js";

/** The JSON contract we instruct the model to follow. */
const OUTPUT_INSTRUCTIONS = `
Respond with a single JSON object and nothing else (no markdown fences). Shape:
{
  "summary": "string — overall assessment, 1-4 sentences",
  "action": "APPROVE|REQUEST_CHANGES|COMMENT",
  "filesSummary": [
    {
      "path": "repo-relative file path",
      "description": "one-line description of what changed in this file"
    }
  ],
  "comments": [
    {
      "path": "repo-relative file path",
      "line": 123,                        // line in the NEW file (the '+' side of the diff)
      "severity": "blocker|warning|praise",
      "body": "markdown comment about this specific line"
    }
  ]
}

action rules:
  APPROVE          — no blockers, no warnings; the code is solid and safe to merge.
  REQUEST_CHANGES  — one or more blocker-severity issues; must not merge as-is.
  COMMENT          — warnings or observations only; author can decide whether to act.

Include one entry in filesSummary for every changed file.
Only comment on lines that appear in the diff. If there is nothing to flag,
return an empty "comments" array and say so in the summary.`;

export function buildSystemPrompt(config: Config): string {
  return config.preprompt.trim();
}

export function buildUserPrompt(
  pr: PullRequestData,
  context: ProjectContext,
  config: Config,
): string {
  const diff = truncate(pr.diff, config.review.maxDiffChars);
  return [
    "## Project context",
    context.text,
    "",
    // PR title/body are user-controlled — wrapped in XML tags so the model
    // can clearly distinguish them from trusted instructions.
    "## Pull request",
    `<pr_title>${pr.title}</pr_title>`,
    pr.body
      ? `<pr_description>\n${pr.body}\n</pr_description>`
      : "<pr_description>(none)</pr_description>",
    `Changed files (${pr.changedFiles.length}):`,
    pr.changedFiles.map((f) => `- ${f}`).join("\n"),
    "",
    "## Diff",
    "```diff",
    diff.text,
    "```",
    diff.truncated ? "\n(Diff truncated due to size.)" : "",
    "",
    "## Your task",
    "Review the diff above using the project context and your instructions.",
    OUTPUT_INSTRUCTIONS,
  ].join("\n");
}

/**
 * Truncate `s` to at most `max` characters, cutting at the last newline
 * before the limit so the model never receives a half-line of diff.
 */
export function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const cut = s.lastIndexOf("\n", max - 1);
  // Fall back to a hard character cut if there's no newline before the limit
  // (e.g. a single huge line).
  const end = cut > 0 ? cut : max;
  return { text: s.slice(0, end), truncated: true };
}
