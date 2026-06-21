/**
 * Local connector — reviews staged git changes (or any local diff) without
 * needing a GitHub account or any remote platform.
 *
 * Usage via CLI:
 *   npm run review -- --local                  # review staged changes
 *   npm run review -- --local --diff main      # review diff against main
 *   npm run review -- --local --diff HEAD~3    # review last 3 commits
 *   npm run review -- --local --output out.md  # write review to a file
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Config } from "../../config.js";
import type { ReviewResult } from "../../review/types.js";
import type {
  FileChange,
  FileTree,
  PendingReview,
  PullRequest,
  RepoRef,
  SCMComment,
  SCMConnector,
} from "../types.js";

const SEVERITY_EMOJI: Record<string, string> = {
  blocker: "🛑",
  warning: "⚠️",
};

const VERDICT_DISPLAY: Record<string, { icon: string; label: string }> = {
  APPROVE: { icon: "✅", label: "recommend merging" },
  REQUEST_CHANGES: { icon: "🛑", label: "address issues" },
  COMMENT: { icon: "💬", label: "observations" },
};

export class LocalConnector implements SCMConnector {
  readonly name = "local";

  private readonly repoPath: string;
  private readonly diffRef: string;
  private readonly outputFile: string | null;

  constructor(
    opts: {
      /** Absolute path to the git repo. Defaults to process.cwd(). */
      repoPath?: string;
      /**
       * Git ref to diff against.
       * - "staged" (default): review staged changes (git diff --cached)
       * - Any git ref: diff HEAD against that ref (git diff <ref>..HEAD)
       */
      diffRef?: string;
      /** Write the review to this file instead of stdout. */
      outputFile?: string | null;
    } = {},
  ) {
    this.repoPath = opts.repoPath ?? process.cwd();
    this.diffRef = opts.diffRef ?? "staged";
    this.outputFile = opts.outputFile ?? null;
  }

  async getReviewerLogin(): Promise<string> {
    return git(this.repoPath, ["config", "user.name"]).trim() || "zanuda-local";
  }

  // Not used — local reviews are triggered directly from the CLI, not polled.
  async pollPendingReviews(_reviewerLogin: string): Promise<PendingReview[]> {
    return [];
  }

  async fetchPR(_ref: RepoRef, _number: number): Promise<PullRequest> {
    const diff = this.getDiff();
    const changedFiles = this.getChangedFiles();
    const { title, body } = this.getCommitInfo();
    const files = parseUnifiedDiffFiles(diff, changedFiles);

    return {
      ref: { owner: "local", repo: basename(this.repoPath) },
      number: 0,
      title,
      body,
      // For local reviews baseSha/headSha are git refs, not SHAs —
      // readFile() handles them accordingly.
      baseSha: this.diffRef === "staged" ? "HEAD" : this.diffRef,
      headSha: "WORKING_TREE",
      diff,
      changedFiles,
      files,
      state: "open", // local reviews are always treated as open
    };
  }

  async readFile(
    _ref: RepoRef,
    filePath: string,
    gitRef: string,
  ): Promise<string | null> {
    // For config/context files read from the git ref (trusted base state).
    // Fall back to filesystem if the file isn't tracked.
    if (gitRef !== "WORKING_TREE") {
      try {
        return git(this.repoPath, ["show", `${gitRef}:${filePath}`], true);
      } catch {
        // File not in git at this ref — fall through to filesystem.
      }
    }

    const full = resolve(this.repoPath, filePath);
    if (!existsSync(full)) return null;
    return readFileSync(full, "utf8");
  }

  async getFileTree(
    _ref: RepoRef,
    _gitRef: string,
    maxEntries: number,
  ): Promise<FileTree> {
    const all = git(this.repoPath, ["ls-files"]).split("\n").filter(Boolean);
    return {
      paths: all.slice(0, maxEntries),
      truncated: all.length > maxEntries,
      total: all.length,
    };
  }

  // No remote discussion for local reviews.
  async fetchDiscussion(_ref: RepoRef, _number: number): Promise<SCMComment[]> {
    return [];
  }

  async postReview(
    _pr: PullRequest,
    result: ReviewResult,
    _config: Config,
    _opts?: {
      summaryPostedElsewhere?: boolean;
      visibleFilePaths?: Set<string>;
    },
  ): Promise<void> {
    const output = renderReview(result);
    if (this.outputFile) {
      writeFileSync(this.outputFile, output, "utf8");
      process.stderr.write(`Review written to ${this.outputFile}\n`);
    } else {
      process.stdout.write(output);
    }
  }

  async postComment(
    _ref: RepoRef,
    _number: number,
    body: string,
  ): Promise<number> {
    // Progress indicator — goes to stderr so it doesn't pollute piped output.
    process.stderr.write(`${body}\n`);
    return 0; // no real comment ID
  }

  async editComment(
    _ref: RepoRef,
    _commentId: number,
    body: string,
  ): Promise<void> {
    // Overwrite the progress line with the final verdict.
    process.stderr.write(`\r${body}\n`);
  }

  async replyToComment(): Promise<void> {
    // No-op — no discussion in local mode.
  }

  async listCommitShas(_ref: RepoRef, _number: number): Promise<string[]> {
    // In local mode there is no PR — return empty so the dedup gate passes.
    return [];
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /** Cache for stdin read — getDiff and getChangedFiles both call it. */
  private _stdinDiff: string | undefined;

  private getDiff(): string {
    if (this.diffRef === "-") return this._readStdin();
    if (this.diffRef === "staged") {
      const staged = git(this.repoPath, ["diff", "--cached", "--unified=5"]);
      if (staged.trim()) return staged;
      // Nothing staged — fall back to unstaged changes.
      process.stderr.write(
        "Nothing staged. Reviewing unstaged changes instead.\n",
      );
      return git(this.repoPath, ["diff", "HEAD", "--unified=5"]);
    }
    // Branch diff mode: diff <ref>..HEAD (committed) plus any staged changes.
    // These are disjoint — staged changes are by definition not in HEAD yet.
    const committed = git(this.repoPath, [
      "diff",
      `${this.diffRef}..HEAD`,
      "--unified=5",
    ]);
    const staged = this._getStagedDiff();
    if (!staged) return committed || "";
    return LocalConnector.concatDiffs(committed, staged);
  }

  /** Return the staged diff (git diff --cached) or null if nothing is staged. */
  private _getStagedDiff(): string | null {
    try {
      // --quiet (exit code 1 if there are staged changes, 0 if clean).
      git(this.repoPath, ["diff", "--cached", "--quiet"], true);
      return null; // exit 0 = nothing staged
    } catch {
      // exit 1 = there are staged changes — fetch the actual diff.
      return git(this.repoPath, ["diff", "--cached", "--unified=5"]);
    }
  }

  // ── Pure helpers (extracted for testability) ──────────────────────────────────

  /** Concatenate committed and staged diffs with a separator. */
  static concatDiffs(committed: string, staged: string): string {
    if (!committed.trim()) return staged;
    return (
      committed.trimEnd() +
      "\n\n# --- staged (uncommitted) changes below ---\n\n" +
      staged.trimStart()
    );
  }

  /** Deduplicated union of committed and staged file paths. */
  static unionFiles(committed: string[], staged: string[]): string[] {
    return [...new Set([...committed, ...staged])];
  }

  private getChangedFiles(): string[] {
    if (this.diffRef === "-") {
      return parseStdinFilenames(this._readStdin());
    }
    if (this.diffRef === "staged") {
      const out = git(this.repoPath, ["diff", "--cached", "--name-only"]);
      if (out.trim()) return out.split("\n").filter(Boolean);
      return git(this.repoPath, ["diff", "HEAD", "--name-only"])
        .split("\n")
        .filter(Boolean);
    }
    // Branch diff mode: union of committed + staged changed files.
    const committed = git(this.repoPath, [
      "diff",
      `${this.diffRef}..HEAD`,
      "--name-only",
    ])
      .split("\n")
      .filter(Boolean);
    const staged = this._getStagedChangedFiles();
    return LocalConnector.unionFiles(committed, staged);
  }

  /** Return staged changed file paths or empty array if nothing is staged. */
  private _getStagedChangedFiles(): string[] {
    try {
      git(this.repoPath, ["diff", "--cached", "--quiet"], true);
      return [];
    } catch {
      return git(this.repoPath, ["diff", "--cached", "--name-only"])
        .split("\n")
        .filter(Boolean);
    }
  }

  private getCommitInfo(): { title: string; body: string } {
    // Eval harness override: inject PR metadata via env vars.
    if (process.env.EVAL_PR_TITLE) {
      return {
        title: process.env.EVAL_PR_TITLE,
        body: process.env.EVAL_PR_BODY ?? "",
      };
    }

    if (this.diffRef === "-") {
      return { title: "Diff from stdin", body: "" };
    }
    if (this.diffRef === "staged") {
      return {
        title: "Staged changes",
        body: "",
      };
    }
    try {
      const log = git(this.repoPath, [
        "log",
        `${this.diffRef}..HEAD`,
        "--format=%s%n%b",
      ]);
      const [title, ...rest] = log.trim().split("\n");
      const hasStaged = this._getStagedChangedFiles().length > 0;
      return {
        title:
          (title ?? `Changes since ${this.diffRef}`) +
          (hasStaged ? " (+ staged changes)" : ""),
        body: rest.join("\n").trim(),
      };
    } catch {
      return { title: `Changes since ${this.diffRef}`, body: "" };
    }
  }

  /** Read stdin once and cache — getDiff and getChangedFiles both call this. */
  private _readStdin(): string {
    if (this._stdinDiff === undefined) {
      this._stdinDiff = readFileSync("/dev/stdin", "utf8");
    }
    return this._stdinDiff;
  }
}

// ── Output renderer ───────────────────────────────────────────────────────────

function renderReview(result: ReviewResult): string {
  const { icon, label } = VERDICT_DISPLAY[result.action] ?? {
    icon: "💬",
    label: "observations",
  };
  const reviewed = result.filesSummary.length;
  const inlineCount = result.comments.length;

  const lines: string[] = [
    `# ${icon} Zanuda Review · ${label}`,
    "",
    result.summary,
  ];

  // Scope line: only show file count when filesSummary has entries.
  // When empty, the model skipped per-file descriptions (common in round 2)
  // but may still have posted inline comments — show those instead of "0 files".
  if (reviewed > 0 || inlineCount > 0) {
    const parts: string[] = [];
    if (reviewed > 0)
      parts.push(`Checked ${reviewed} file${reviewed === 1 ? "" : "s"}`);
    if (inlineCount > 0)
      parts.push(
        `${inlineCount} inline comment${inlineCount === 1 ? "" : "s"}`,
      );
    lines.push("", `> ${parts.join(" · ")}`);
  }

  if (result.filesSummary.length > 0) {
    lines.push("", "## Changed files", "");
    lines.push("| File | Description |", "| --- | --- |");
    for (const f of result.filesSummary) {
      lines.push(`| \`${f.path}\` | ${f.description} |`);
    }
  }

  if (result.comments.length > 0) {
    lines.push("", "## Comments", "");
    for (const c of result.comments) {
      const emoji = SEVERITY_EMOJI[c.severity] ?? "";
      lines.push(`### ${emoji} \`${c.path}:${c.line}\``, "", c.body, "");
      if (c.suggestion) {
        const ext = c.path.match(/\.(\w+)$/)?.[1] ?? "";
        // Sanitise: prepend space to lines starting with ``` to prevent
        // fence-break in the markdown output.
        const safe = c.suggestion
          .split("\n")
          .map((l) => (l.trimStart().startsWith("```") ? " " + l : l))
          .join("\n");
        lines.push("**Suggested fix:**", "", `\`\`\`${ext}`, safe, "```", "");
      }
    }
  }

  return lines.join("\n") + "\n";
}

// ── Unified diff parser ──────────────────────────────────────────────────────

/**
 * Split a unified diff into per-file sections so the review engine can
 * assemble a budget-aware diff rather than truncating mid-file.
 *
 * Counts additions/deletions from the diff hunk headers rather than running
 * additional git calls.
 */
function parseUnifiedDiffFiles(
  unifiedDiff: string,
  filenames: string[],
): FileChange[] {
  // Split on "diff --git" headers, keeping each header with its content.
  const sections = unifiedDiff.split(/(?=^diff --git )/m).filter(Boolean);

  const byFile = new Map<string, string>();
  for (const section of sections) {
    // Extract the b/ path (new file name) from the header.
    const match = section.match(/^diff --git a\/.*? b\/(.+)$/m);
    if (match) byFile.set(match[1]!, section);
  }

  return filenames.map((filename) => {
    const patch = byFile.get(filename);
    if (!patch) return { filename, additions: 0, deletions: 0 };
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return { filename, additions, deletions, patch };
  });
}

// ── Stdin helpers ──────────────────────────────────────────────────────────────

/**
 * Extract filenames from a unified diff read from stdin.
 * Matches "diff --git a/path b/path" headers.
 */
function parseStdinFilenames(diff: string): string[] {
  const matches = [...diff.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)];
  if (matches.length > 0) return matches.map((m) => m[1]!);
  // No recognized file headers — return a synthetic entry so the review
  // doesn't break.
  return ["stdin"];
}

// ── Git helper ────────────────────────────────────────────────────────────────

// 256 MB — enough for any realistic diff or file tree without being unbounded.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
// 60 s hard timeout per git call; hangs (e.g. credential prompts) must not
// block the review indefinitely.
const GIT_TIMEOUT_MS = 60_000;

function git(cwd: string, args: string[], silent = false): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    stdio: silent ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
  });
}
