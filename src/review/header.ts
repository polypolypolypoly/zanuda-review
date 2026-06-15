/**
 * File header extraction for structural context in review prompts.
 *
 * When reviewing a diff, seeing only the diff lines makes the model blind to
 * imports, class/contract structure, and function signatures that are essential
 * for understanding the change. This module extracts the first ~150 lines
 * (~2000 chars) of each changed file — the structural skeleton that contains
 * imports, constants, type declarations, and function signatures — and prepends
 * it to the diff so the model can reason about the code.
 *
 * Approach is language-agnostic: imports and declarations are at the top of
 * every well-formed source file by convention.
 */

/** Maximum lines to include from the file header. */
const MAX_HEADER_LINES = 150;

/** Maximum characters to include from the file header. */
const MAX_HEADER_CHARS = 2000;

/**
 * Extract the structural skeleton from the top of a source file.
 * Skips leading comment blocks and blank lines (license headers, file-level
 * docstrings) so the budget isn't wasted on boilerplate. Once the first line
 * of actual code is found, extraction proceeds normally — inline comments
 * after code (e.g. SPDX identifiers) are included.
 * Stops at the first min(MAX_HEADER_LINES, MAX_HEADER_CHARS) boundary.
 */
export function extractFileHeader(content: string): string {
  const lines = content.split("\n");
  let header = "";
  let inLeadingCommentBlock = true;

  for (let i = 0; i < Math.min(lines.length, MAX_HEADER_LINES); i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (inLeadingCommentBlock) {
      // Skip shebang lines (#!), comment lines (//, #, /*, *, --),
      // and blank lines until we hit actual code.
      if (
        trimmed === "" ||
        trimmed.startsWith("#!") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("--") ||
        trimmed.startsWith("<!--")
      ) {
        continue;
      }
      inLeadingCommentBlock = false;
    }

    if (header.length + line.length + 1 > MAX_HEADER_CHARS) break;
    header += line + "\n";
  }

  return header.trimEnd();
}

/** Per-file data assembled for the prompt. */
export interface HeaderedFile {
  filename: string;
  /** The file's structural skeleton (imports, declarations, signatures). */
  header: string;
  /** The unified diff (patch) for this file. */
  patch: string;
  /** Total characters of the combined header + patch. */
  weight: number;
}

/**
 * Build a HeaderedFile from full file content and the git diff patch.
 * Returns null when no patch is available (binary/too-large files).
 */
export function headeredFile(
  filename: string,
  fullContent: string,
  patch: string | undefined,
): HeaderedFile | null {
  if (!patch) return null;
  const header = extractFileHeader(fullContent);
  return { filename, header, patch, weight: header.length + patch.length };
}
