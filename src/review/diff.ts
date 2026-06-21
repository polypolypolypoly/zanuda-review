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
import type { HeaderedFile } from "./header.js";

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

/**
 * Parse the new-file line numbers that are valid inline-anchor targets from a
 * unified diff patch. Context lines (' ') and additions ('+') both exist in
 * the new file; deletion lines ('-') do not.
 *
 * This is the ground truth for what line numbers GitHub will accept as inline
 * comment anchors for a given file. Pre-validating model-generated line
 * numbers against this set means the code — not the GitHub 422 response —
 * decides which comments are postable.
 */
export function parseValidNewLines(patch: string): Set<number> {
  const valid = new Set<number>();
  let newLine = 0; // 0 = before first hunk header
  for (const raw of patch.split("\n")) {
    // Hunk header: @@ -old[,len] +new[,len] @@
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = parseInt(hunk[1]!, 10);
      continue;
    }
    if (raw.startsWith("---") || raw.startsWith("+++")) continue; // file header
    if (raw.startsWith("-")) continue; // deletion: not in new file, no increment
    if (raw.startsWith("\\")) continue; // "No newline at end of file" marker
    if (newLine === 0) continue; // before first hunk
    // Context line (' ') or addition ('+'): exists in new file.
    valid.add(newLine++);
  }
  return valid;
}

/**
 * Build a map from file path to the set of valid new-file line numbers, from
 * any collection of files that carry patches. Pass the result to
 * filterAnchorableComments in filters.ts before posting.
 */
export function buildValidLineMap(
  files: Array<{ filename: string; patch?: string }>,
): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.patch) {
      map.set(file.filename, parseValidNewLines(file.patch));
    }
  }
  return map;
}

// ── Batch-aware diff assembly ───────────────────────────────────────────────

export interface BatchDiff {
  /** Assembled diff text for this batch, with file headers prepended. */
  text: string;
  /** Files included in this batch (all have patches). */
  files: HeaderedFile[];
}

/**
 * Assemble the diff text for a single batch, prepending each file's
 * structural skeleton (header) before its git diff so the model can
 * see imports, class/contract structure, and function signatures.
 */
export function assembleBatchDiff(files: HeaderedFile[]): BatchDiff {
  const parts: string[] = [];

  for (const file of files) {
    parts.push(`### \`${file.filename}\``);
    if (file.header) {
      parts.push("```" + guessLanguage(file.filename), file.header, "```");
    }
    parts.push("```diff", file.patch, "```", "");
  }

  return { text: parts.join("\n"), files };
}

/**
 * The set of file paths in a batch. Used to filter inline comments
 * before posting.
 */
export function batchFilePaths(batch: BatchDiff): Set<string> {
  return new Set(batch.files.map((f) => f.filename));
}

/** Guess a language tag for syntax-highlighted code fences. */
function guessLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "sol":
      return "solidity";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "yaml":
    case "yml":
      return "yaml";
    case "json":
      return "json";
    case "md":
      return "markdown";
    default:
      return "";
  }
}
