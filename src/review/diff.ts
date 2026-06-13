/**
 * Budget-aware diff assembly for the review prompt.
 *
 * Rather than fetching one big diff blob and truncating it at an arbitrary
 * byte boundary (which splits files mid-hunk, causes the model to hallucinate
 * line numbers, and triggers 422s from GitHub), this module assembles the
 * diff from individual file patches, always including complete files.
 *
 * Files are ordered by descending change volume (additions + deletions) so the
 * most significant changes are prioritised when the PR is too large to fit
 * entirely within the character budget.
 */

import type { FileChange } from "../platform/types.js";

export interface PromptDiff {
  /** The assembled diff text to embed in the prompt. */
  text: string;
  /** Files whose full patch is included in `text`. */
  includedFiles: FileChange[];
  /**
   * Files omitted because the budget was exhausted, or because the platform
   * did not provide a patch (binary/too-large files).
   */
  excludedFiles: FileChange[];
  /** True if at least one file was excluded due to budget. */
  truncated: boolean;
}

/**
 * Assemble a prompt diff from per-file patches, fitting within `maxChars`.
 *
 * Complete files are always included or excluded as a unit — the diff is
 * never cut mid-file. This ensures every line number the model references
 * actually exists in the visible diff, preventing 422s on inline comments.
 */
export function buildPromptDiff(
  files: FileChange[],
  maxChars: number,
): PromptDiff {
  // Sort descending by total change volume so the most significant files
  // are included first when the budget runs out.
  const sorted = [...files].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  );

  const included: FileChange[] = [];
  const excluded: FileChange[] = [];
  let budget = maxChars;

  // Greedy allocation: try to include each file in descending-volume order.
  // If a large file doesn't fit, smaller files later can still be included.
  // This means the final set isn't necessarily a prefix of sorted[] — it's
  // best-fit by priority. A file can be excluded while smaller files are shown.
  for (const file of sorted) {
    if (!file.patch) {
      // No patch available (binary, too large for platform to inline, etc.)
      excluded.push(file);
      continue;
    }
    if (file.patch.length <= budget) {
      included.push(file);
      budget -= file.patch.length;
    } else {
      excluded.push(file);
    }
  }

  return {
    text: included.map((f) => f.patch!).join("\n"),
    includedFiles: included,
    excludedFiles: excluded,
    truncated: excluded.some((f) => f.patch !== undefined),
  };
}

/**
 * The set of file paths whose diff is present in the assembled prompt.
 * Used to filter inline review comments before posting — any comment on a
 * path not in this set references a line the model never saw and will 422.
 */
export function includedPaths(diff: PromptDiff): Set<string> {
  return new Set(diff.includedFiles.map((f) => f.filename));
}
