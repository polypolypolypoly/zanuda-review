import type { Config } from "../config.js";
import type { ProjectContext } from "../context/builder.js";
import type { PullRequestData } from "../github/pullRequest.js";

/** The JSON contract we instruct the model to follow. */
const OUTPUT_INSTRUCTIONS = `
Respond with a single JSON object and nothing else (no markdown fences). Shape:
{
  "summary": "string — overall assessment, 1-4 sentences",
  "comments": [
    {
      "path": "repo-relative file path",
      "line": 123,                        // line in the NEW file (the '+' side of the diff)
      "severity": "blocker|warning|nitpick|praise",
      "body": "markdown comment about this specific line"
    }
  ]
}
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
    "## Pull request",
    `Title: ${pr.title}`,
    pr.body ? `Description:\n${pr.body}` : "Description: (none)",
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

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}
