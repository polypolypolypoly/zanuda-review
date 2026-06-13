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

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Config } from "../../config.js";
import type { ReviewResult } from "../../review/types.js";
import type {
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
  praise: "✅",
};

const ACTION_ICON: Record<string, string> = {
  APPROVE: "✅",
  REQUEST_CHANGES: "🛑",
  COMMENT: "💬",
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

  async getBotLogin(): Promise<string> {
    return git(this.repoPath, "config user.name").trim() || "zanuda-local";
  }

  // Not used — local reviews are triggered directly from the CLI, not polled.
  async pollPendingReviews(_botLogin: string): Promise<PendingReview[]> {
    return [];
  }

  async fetchPR(_ref: RepoRef, _number: number): Promise<PullRequest> {
    const diff = this.getDiff();
    const changedFiles = this.getChangedFiles();
    const { title, body } = this.getCommitInfo();

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
        return git(this.repoPath, `show ${gitRef}:${filePath}`, true);
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
    const all = git(this.repoPath, "ls-files").split("\n").filter(Boolean);
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

  // ── Private helpers ──────────────────────────────────────────────────────────

  private getDiff(): string {
    if (this.diffRef === "staged") {
      const staged = git(this.repoPath, "diff --cached --unified=5");
      if (staged.trim()) return staged;
      // Nothing staged — fall back to unstaged changes.
      process.stderr.write(
        "Nothing staged. Reviewing unstaged changes instead.\n",
      );
      return git(this.repoPath, "diff HEAD --unified=5");
    }
    return git(this.repoPath, `diff ${this.diffRef}..HEAD --unified=5`);
  }

  private getChangedFiles(): string[] {
    if (this.diffRef === "staged") {
      const out = git(this.repoPath, "diff --cached --name-only");
      if (out.trim()) return out.split("\n").filter(Boolean);
      return git(this.repoPath, "diff HEAD --name-only")
        .split("\n")
        .filter(Boolean);
    }
    return git(this.repoPath, `diff ${this.diffRef}..HEAD --name-only`)
      .split("\n")
      .filter(Boolean);
  }

  private getCommitInfo(): { title: string; body: string } {
    if (this.diffRef === "staged") {
      return {
        title: "Staged changes",
        body: "",
      };
    }
    try {
      const log = git(
        this.repoPath,
        `log ${this.diffRef}..HEAD --format=%s%n%b`,
      );
      const [title, ...rest] = log.trim().split("\n");
      return {
        title: title ?? `Changes since ${this.diffRef}`,
        body: rest.join("\n").trim(),
      };
    } catch {
      return { title: `Changes since ${this.diffRef}`, body: "" };
    }
  }
}

// ── Output renderer ───────────────────────────────────────────────────────────

function renderReview(result: ReviewResult): string {
  const icon = ACTION_ICON[result.action] ?? "💬";
  const label = result.action.replace("_", " ").toLowerCase();
  const reviewed = result.filesSummary.length;
  const inlineCount = result.comments.length;

  const lines: string[] = [
    `# ${icon} Zanuda Review · ${label}`,
    "",
    result.summary,
    "",
    `> Checked ${reviewed} file${reviewed === 1 ? "" : "s"}${inlineCount > 0 ? ` · ${inlineCount} inline comment${inlineCount === 1 ? "" : "s"}` : ""}`,
  ];

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
    }
  }

  return lines.join("\n") + "\n";
}

// ── Git helper ────────────────────────────────────────────────────────────────

function git(cwd: string, args: string, silent = false): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf8",
    stdio: silent ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
  });
}
