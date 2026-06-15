#!/usr/bin/env -S npx tsx
/**
 * Extract a merged GitHub PR into an eval challenge directory.
 *
 * Usage:
 *   npx tsx eval/extract-pr.ts <owner>/<repo> <pr-number>
 *   npx tsx eval/extract-pr.ts polypolypolypoly/zanuda-review 37
 *
 * Output: eval/challenges/<pr-NNN>/
 *   before/   — repo state at the PR's base commit
 *   after/    — repo state at the PR's merge commit
 *   pr.json   — { title, body }
 *   known.yaml — issues extracted from Zanuda's inline review comments
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";

const __dirname = new URL(".", import.meta.url).pathname;
const PROJECT_DIR = resolve(__dirname, "..");
const EVAL_DIR = join(PROJECT_DIR, "eval");
const CHALLENGES_DIR = join(EVAL_DIR, "challenges");
const CACHE_DIR = join(EVAL_DIR, ".cache");

interface GhComment {
  user?: { login: string };
  body: string;
  path?: string;
  line?: number;
}

interface GhPr {
  number: number;
  title: string;
  body: string;
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
  mergeCommit?: { oid: string };
  comments: GhComment[];
  files: { path: string }[];
}

function gh(args: string): string {
  return execSync(`gh ${args}`, { stdio: "pipe", encoding: "utf8" });
}

function extractPr(owner: string, repo: string, num: number): void {
  console.error(`Extracting ${owner}/${repo}#${num}...`);

  // Fetch PR metadata with inline comments
  const raw = gh(
    `pr view ${num} --repo ${owner}/${repo} --json number,title,body,baseRefName,baseRefOid,headRefOid,mergeCommit,comments,files`,
  );
  const pr: GhPr = JSON.parse(raw);

  const challengeDir = join(
    CHALLENGES_DIR,
    `pr-${String(num).padStart(3, "0")}`,
  );
  if (existsSync(challengeDir)) {
    console.error(`  Already exists at ${challengeDir}`);
    return;
  }
  mkdirSync(challengeDir, { recursive: true });
  mkdirSync(join(challengeDir, "before"));
  mkdirSync(join(challengeDir, "after"));

  // Clone repo if not cached
  const cacheKey = `${owner}-${repo}`;
  const cacheDir = join(CACHE_DIR, cacheKey);
  if (!existsSync(cacheDir)) {
    console.error(`  Cloning ${owner}/${repo} to cache...`);
    mkdirSync(CACHE_DIR, { recursive: true });
    execSync(
      `git clone --bare https://github.com/${owner}/${repo}.git ${cacheDir}`,
      { stdio: "pipe" },
    );
  } else {
    console.error("  Fetching latest from cache...");
    execSync(`git fetch --all`, { cwd: cacheDir, stdio: "pipe" });
  }

  // Export before/after states
  const baseSha = pr.baseRefOid;
  const mergeSha = pr.mergeCommit?.oid ?? pr.headRefOid;

  console.error(`  Before: ${baseSha.slice(0, 8)}`);
  const beforeDir = join(challengeDir, "before");
  execSync(`git archive ${baseSha} | tar -x -C ${beforeDir}`, {
    cwd: cacheDir,
    stdio: "pipe",
  });

  console.error(`  After:  ${mergeSha.slice(0, 8)}`);
  const afterDir = join(challengeDir, "after");
  execSync(`git archive ${mergeSha} | tar -x -C ${afterDir}`, {
    cwd: cacheDir,
    stdio: "pipe",
  });

  // Write PR metadata
  writeFileSync(
    join(challengeDir, "pr.json"),
    JSON.stringify({ title: pr.title, body: pr.body }, null, 2) + "\n",
  );

  // Extract known issues from Zanuda's inline review comments.
  // gh pr view --json comments only returns issue comments, not inline
  // review comments — we need the pulls/{pr}/comments endpoint.
  const reviewCommentsRaw = gh(
    `api repos/${owner}/${repo}/pulls/${num}/comments --jq '[.[] | select(.user.login == "ZlayaZanuda")]'`,
  );
  const zanudaComments: GhComment[] = JSON.parse(reviewCommentsRaw || "[]");

  if (zanudaComments.length > 0) {
    const issues = zanudaComments.map((c) => ({
      file: c.path!,
      line: c.line!,
      severity: c.body?.includes("🛑") ? "blocker" : "warning",
      description:
        c.body
          ?.replace(/^[🔴🟡]\s*/, "")
          .replace(/\n/g, " ")
          .slice(0, 120) ?? "",
    }));

    writeFileSync(join(challengeDir, "known.yaml"), stringifyYaml({ issues }));
    console.error(`  Known issues: ${issues.length}`);
  } else {
    console.error("  No inline review comments from Zanuda — no known.yaml");
  }

  // Count files for size estimate
  const afterFiles = pr.files?.length ?? "?";
  console.error(`  Files: ${afterFiles}`);
  console.error(`  Done → ${challengeDir}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      "Usage: npx tsx eval/extract-pr.ts <owner/repo> <pr-number> [pr-number...]",
    );
    process.exit(2);
  }

  const [repoSlug, ...prNums] = args;
  const match = repoSlug!.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    console.error("Expected owner/repo format");
    process.exit(2);
  }
  const owner = match[1]!;
  const repo = match[2]!;

  for (const numStr of prNums) {
    const num = Number(numStr);
    if (!Number.isInteger(num) || num < 1) {
      console.error(`Invalid PR number: ${numStr}`);
      continue;
    }
    try {
      extractPr(owner, repo, num);
    } catch (err) {
      console.error(`  FAILED: ${String(err).slice(0, 200)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
