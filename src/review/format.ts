/**
 * Platform-agnostic formatting utilities used by the review engine and poller.
 *
 * Kept separate from github/ so nothing in review/, poller, or context/ needs
 * to import GitHub-specific modules.
 */

import type { SCMComment } from "../platform/types.js";
import type { ReviewResult } from "./types.js";

// ── Discussion formatter ──────────────────────────────────────────────────────

/**
 * Format comments as a readable block for the model.
 * Takes the most recent `maxComments` entries so we stay within token budget.
 */
export function formatDiscussion(
  comments: SCMComment[],
  maxComments = 30,
): string {
  if (comments.length === 0) return "(No discussion found.)";

  const omitted = Math.max(0, comments.length - maxComments);
  const slice = comments.slice(-maxComments);
  const lines: string[] = [];

  if (omitted > 0) {
    lines.push(`_(${omitted} earlier comment(s) omitted)_\n`);
  }

  for (const c of slice) {
    const location = c.path
      ? ` [\`${c.path}${c.line !== null && c.line !== undefined ? `:${c.line}` : ""}\`]`
      : "";
    lines.push(`**${c.author}**${location}:\n${c.body.trim()}`);
  }

  return lines.join("\n\n---\n\n");
}

// ── Review comment body builder ───────────────────────────────────────────────

/**
 * Build the full review content for the progress comment.
 * This replaces "Starting review…" with the complete verdict, summary,
 * and file overview — everything the author needs in one place.
 */
export function buildReviewCommentBody(
  result: ReviewResult,
  totalFiles: number,
  opts: { diffTruncated?: boolean } = {},
): string {
  // Verdicts are recommendations to humans — not GitHub review actions.
  // Language reflects that Zanuda is advising, not deciding.
  const VERDICT_DISPLAY: Record<string, { icon: string; label: string }> = {
    APPROVE: { icon: "✅", label: "recommend merging" },
    REQUEST_CHANGES: { icon: "🛑", label: "address issues" },
    COMMENT: { icon: "💬", label: "observations" },
  };

  const reviewed = result.filesSummary.length;
  const scope =
    reviewed === totalFiles
      ? `Checked ${totalFiles} file${totalFiles === 1 ? "" : "s"}`
      : `Checked ${reviewed} of ${totalFiles} files`;
  const inlineCount = result.comments.length;
  const { icon, label } = VERDICT_DISPLAY[result.action] ?? {
    icon: "💬",
    label: "observations",
  };

  const truncationNote = opts.diffTruncated
    ? " · ⚠️ diff truncated (PR too large — review may be incomplete)"
    : "";

  const parts: string[] = [];

  if (result.prSummary) {
    parts.push(`**What this PR does**`, ``, result.prSummary, ``, `---`, ``);
  }

  parts.push(
    `${icon} **Review complete** · ${label}`,
    ``,
    result.summary,
    ``,
    `<sub>${scope}${inlineCount > 0 ? ` · ${inlineCount} inline comment${inlineCount === 1 ? "" : "s"}` : ""}${truncationNote}</sub>`,
  );

  if (result.filesSummary.length > 0) {
    parts.push(
      ``,
      `<details>`,
      `<summary>Changed files (${reviewed})</summary>`,
      ``,
      `| File | Description |`,
      `| --- | --- |`,
      ...result.filesSummary.map((f) => `| ${f.path} | ${f.description} |`),
      ``,
      `</details>`,
    );
  }

  return parts.join("\n");
}
