/**
 * Platform-agnostic formatting utilities used by the review engine and poller.
 *
 * Kept separate from github/ so nothing in review/, poller, or context/ needs
 * to import GitHub-specific modules.
 */

import type { SCMComment } from "../platform/types.js";
import type { ReviewResult } from "./types.js";

// ── Fenced code blocks ────────────────────────────────────────────────────────

/**
 * Wrap `content` in a fenced code block that no line inside it can close.
 * GFM closes a fence with a line of at least as many backticks as the opener,
 * indented up to three spaces — so the fence is one backtick longer than the
 * longest backtick run that starts a line. Content is never modified: a
 * suggestion must apply byte-for-byte.
 */
export function fencedBlock(content: string, info = ""): string {
  const runs = content.match(/^ {0,3}`+/gm) ?? [];
  const longest = runs.reduce(
    (max, run) => Math.max(max, run.trim().length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${content}\n${fence}`;
}

// ── Discussion formatter ──────────────────────────────────────────────────────

/**
 * Per-comment character cap. The count cap alone is not a size bound: a single
 * GitHub comment holds up to 65 536 chars, so 20 of them can carry ~1 MB of
 * attacker-controlled text into the prompt.
 */
const MAX_COMMENT_CHARS = 2000;

/**
 * Format comments as a readable block for the model.
 * Takes the most recent `maxComments` entries so we stay within token budget,
 * and truncates each one to MAX_COMMENT_CHARS.
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
    const body = c.body.trim();
    const truncated =
      body.length > MAX_COMMENT_CHARS
        ? `${body.slice(0, MAX_COMMENT_CHARS)}\n_(comment truncated)_`
        : body;
    lines.push(`**${c.author}**${location}:\n${truncated}`);
  }

  return lines.join("\n\n---\n\n");
}

// ── Verdict display mapping ───────────────────────────────────────────────────

// Verdicts are recommendations to humans — not GitHub review actions.
// Language reflects that Zanuda is advising, not deciding.
const VERDICT_DISPLAY: Record<string, { icon: string; label: string }> = {
  APPROVE: { icon: "✅", label: "Recommend merging" },
  REQUEST_CHANGES: { icon: "🛑", label: "Address issues" },
  COMMENT: { icon: "💬", label: "Observations" },
};

// ── Review comment body builder ───────────────────────────────────────────────

/**
 * Build the review body. Layout, top to bottom:
 *
 *   1. Status  — one small line: review complete, scope, inline count.
 *   2. Verdict — icon + recommendation, then the model's assessment.
 *   3. Context — collapsed: what this PR does + the changed-files table.
 *
 * The verdict is what the author needs; the context is reference material,
 * so it stays folded.
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
  const reviewed = opts.reviewedFiles ?? result.filesSummary.length;
  const inlineCount = result.comments.length;
  const round = opts.round ?? 1;

  // ── 1. Status ──────────────────────────────────────────────────────────────
  const status: string[] = [
    round >= 2 ? `Review complete (round ${round} of 2)` : "Review complete",
  ];
  // No scope when nothing is known — "Checked 0 of N" reads as a failure.
  if (reviewed > 0) {
    status.push(
      reviewed >= totalFiles
        ? `checked ${totalFiles} file${totalFiles === 1 ? "" : "s"}`
        : `checked ${reviewed} of ${totalFiles} files`,
    );
  }
  status.push(
    inlineCount > 0
      ? `${inlineCount} inline comment${inlineCount === 1 ? "" : "s"}`
      : "no inline comments",
  );
  if (opts.diffTruncated) {
    status.push("⚠️ diff truncated (PR too large — review may be incomplete)");
  }

  // ── 2. Verdict ─────────────────────────────────────────────────────────────
  const { icon, label } = VERDICT_DISPLAY[result.action] ?? {
    icon: "💬",
    label: "Observations",
  };
  const parts: string[] = [
    `<sub>${status.join(" · ")}</sub>`,
    "",
    `${icon} **${label}**`,
  ];
  if (result.summary.trim()) parts.push("", result.summary.trim());

  // ── 3. Context (collapsed) ─────────────────────────────────────────────────
  const context: string[] = [];
  if (round < 2 && result.prSummary?.trim()) {
    context.push("**What this PR does**", "", result.prSummary.trim());
  }
  if (result.filesSummary.length > 0) {
    if (context.length > 0) context.push("");
    context.push(
      `**Changed files (${result.filesSummary.length})**`,
      "",
      "| File | Description |",
      "| --- | --- |",
      ...result.filesSummary.map(
        (f) => `| ${tableCell(f.path)} | ${tableCell(f.description)} |`,
      ),
    );
  }
  if (context.length > 0) {
    parts.push(
      "",
      "<details>",
      "<summary>Context</summary>",
      "",
      ...context,
      "",
      "</details>",
    );
  }

  return parts.join("\n");
}

/** Keep a model-written string inside its table cell: no pipes, no newlines. */
function tableCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}
