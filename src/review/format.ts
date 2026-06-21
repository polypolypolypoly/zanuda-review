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
  opts: {
    diffTruncated?: boolean;
    /** Actual number of files whose diffs were visible to the model.
     * When provided, used instead of the model-generated filesSummary.length
     * for the scope line — the engine always knows exactly what was sent. */
    reviewedFiles?: number;
    /** Review round (1 or 2). When >= 2, the PR overview (prSummary) is
     * suppressed — round 2 should assess whether round-1 issues were
     * addressed, not re-describe the PR. */
    round?: number;
  } = {},
): string {
  // Verdicts are recommendations to humans — not GitHub review actions.
  // Language reflects that Zanuda is advising, not deciding.
  const VERDICT_DISPLAY: Record<string, { icon: string; label: string }> = {
    APPROVE: { icon: "✅", label: "recommend merging" },
    REQUEST_CHANGES: { icon: "🛑", label: "address issues" },
    COMMENT: { icon: "💬", label: "observations" },
  };

  // Use the engine-provided count when available — it's always accurate.
  // Fall back to filesSummary.length for backward compatibility (CLI dry-run).
  const reviewed = opts.reviewedFiles ?? result.filesSummary.length;
  const inlineCount = result.comments.length;

  // Scope line: shows how many files were described. When filesSummary is
  // empty but the model posted inline comments we avoid "Checked 0 of N" —
  // the model clearly examined specific files even if it skipped per-file
  // descriptions (common in round 2, where the model focuses on re-assessing
  // round-1 issues rather than mechanically listing every changed file).
  let scopeLine = "";
  if (reviewed > 0) {
    scopeLine =
      reviewed === totalFiles
        ? `Checked ${totalFiles} file${totalFiles === 1 ? "" : "s"}`
        : `Checked ${reviewed} of ${totalFiles} files`;
  }
  const { icon, label } = VERDICT_DISPLAY[result.action] ?? {
    icon: "💬",
    label: "observations",
  };

  const truncationNote = opts.diffTruncated
    ? " · ⚠️ diff truncated (PR too large — review may be incomplete)"
    : "";

  const parts: string[] = [];

  // Scope + inline count sub-line
  const subParts: string[] = [];
  if (scopeLine) subParts.push(scopeLine);
  if (inlineCount > 0)
    subParts.push(
      `${inlineCount} inline comment${inlineCount === 1 ? "" : "s"}`,
    );
  if (truncationNote) subParts.push(truncationNote);
  if (subParts.length > 0) parts.push(`<sub>${subParts.join(" · ")}</sub>`, "");

  const round = opts.round ?? 1;
  parts.push(
    `${icon} **Review complete**${round >= 2 ? ` (round ${round} of 2)` : ""} · ${label}`,
  );

  if (round < 2 && result.prSummary) {
    parts.push("", `**What this PR does**`, "", result.prSummary);
  }

  parts.push("", `**Observations**`, "", result.summary);

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
