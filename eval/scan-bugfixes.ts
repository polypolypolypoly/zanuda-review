#!/usr/bin/env -S npx tsx
/**
 * Scan a repo's git history for PRs that were followed by bug-fix commits.
 *
 * A "bug-fix follow-up" is a commit whose message starts with fix:/hotfix:
 * and whose diff touches code that was modified in the immediately prior
 * merge commit. The fix reveals something the review should have caught.
 *
 * Output: suggested eval challenge list with auto-generated known issues.
 *
 * Usage:
 *   npx tsx eval/scan-bugfixes.ts /path/to/repo
 *   npx tsx eval/scan-bugfixes.ts /path/to/repo --since 2024-01-01
 *
 * Output format (stdout):
 *   PR #42 (2024-03-15): "Add login endpoint"
 *     → fix commit abc1234 (2024-03-16): fix: validate username input
 *     → known issue: src/auth/login.ts line 42 — validate username input
 *     → challenge: npx tsx eval/extract-pr.ts owner/repo 42
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

interface Commit {
  hash: string;
  date: string;
  message: string;
  files: string[];
}

function git(repoPath: string, args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd: repoPath,
    stdio: "pipe",
    encoding: "utf8",
  }).trim();
}

function getMergeCommits(
  repoPath: string,
  since?: string,
): { hash: string; date: string; message: string }[] {
  const range = since ? `--since="${since}"` : "--max-count=50";
  const log = git(
    repoPath,
    ["log", range, "--merges", "--format=%H %ad %s", "--date=short"].filter(
      Boolean,
    ),
  );

  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, date, ...msgParts] = line.split(" ");
      return { hash: hash!, date: date!, message: msgParts.join(" ") };
    });
}

function getFixCommitsAfter(
  repoPath: string,
  mergeHash: string,
  mergeDate: string,
): Commit[] {
  // Commits after the merge, before the next merge
  const log = git(
    repoPath,
    [
      "log",
      `${mergeHash}..HEAD`,
      `--since="${mergeDate}"`,
      "--format=%H %ad %s",
      "--date=short",
      "--no-merges",
    ].filter(Boolean),
  );

  const commits: Commit[] = [];
  for (const line of log.split("\n").filter(Boolean)) {
    const parts = line.split(" ");
    const hash = parts[0]!;
    const date = parts[1]!;
    const message = parts.slice(2).join(" ");

    // Only fix/hotfix commits
    if (!/^(fix|hotfix)[(:]/.test(message)) continue;

    // Get files changed in this commit
    const files = git(repoPath, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      hash,
    ])
      .split("\n")
      .filter(Boolean);

    commits.push({ hash, date, message, files });
  }

  return commits;
}

function getMergeFiles(repoPath: string, mergeHash: string): string[] {
  const diff = git(repoPath, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    mergeHash,
  ]);
  return diff.split("\n").filter(Boolean);
}

function intersects(a: string[], b: string[]): boolean {
  const setB = new Set(b);
  return a.some((f) => setB.has(f));
}

function extractLineHint(
  repoPath: string,
  fixCommit: string,
  mergeFiles: string[],
): { file: string; line: number }[] {
  const hints: { file: string; line: number }[] = [];

  for (const file of mergeFiles) {
    try {
      const diff = git(repoPath, ["diff", `${fixCommit}^!`, "--", file]);
      // Extract first changed line from the diff
      const match = diff.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (match) {
        hints.push({ file, line: Number(match[1]) });
      }
    } catch {
      // File not in diff, skip
    }
  }

  return hints;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoPath = resolve(args[0] ?? process.cwd());
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;

  console.error(`Scanning ${repoPath}...\n`);

  const merges = getMergeCommits(repoPath, since);
  console.error(`Found ${merges.length} merge commits\n`);

  let foundCount = 0;

  for (const merge of merges) {
    const fixCommits = getFixCommitsAfter(repoPath, merge.hash, merge.date);
    if (fixCommits.length === 0) continue;

    const mergeFiles = getMergeFiles(repoPath, merge.hash);

    for (const fix of fixCommits) {
      if (!intersects(fix.files, mergeFiles)) continue;

      foundCount++;
      const prNum = merge.message.match(/#(\d+)/)?.[1] ?? "?";

      console.log(
        `PR #${prNum} (${merge.date}): "${merge.message.slice(0, 80)}"`,
      );
      console.log(
        `  → fix ${fix.hash.slice(0, 8)} (${fix.date}): ${fix.message.slice(0, 80)}`,
      );

      // Extract line hints from the fix diff
      const hints = extractLineHint(repoPath, fix.hash, fix.files);
      if (hints.length > 0) {
        console.log("  → suggested known.yaml:");
        console.log("     issues:");
        for (const h of hints.slice(0, 5)) {
          console.log(`       - file: ${h.file}`);
          console.log(`         line: ${h.line}`);
          console.log(
            `         severity: warning  # or blocker — review manually`,
          );
          console.log(
            `         description: "${fix.message.replace(/^(fix|hotfix)[(:]\s*/, "").slice(0, 100)}"`,
          );
        }
        if (hints.length > 5) {
          console.log(`       # ... and ${hints.length - 5} more`);
        }
      }

      console.log(
        `  → extract: npx tsx eval/extract-pr.ts <owner/repo> ${prNum}`,
      );
      console.log("");
    }
  }

  console.error(`\n${foundCount} bug-fix follow-ups found.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
