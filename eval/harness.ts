/**
 * Eval harness: run two review strategies against the same PR and compare.
 *
 * Usage:
 *   npx tsx eval/harness.ts eval/challenges/001-small
 *   npx tsx eval/harness.ts --all
 *
 * Each challenge directory contains:
 *   before/          Git repo state before the PR
 *   after/           State after (staged as changes)
 *   pr.json          { "title": "...", "body": "..." }
 *   known.yaml       (optional) { "issues": [{ "file": "...", "line": N, "severity": "...", "description": "..." }] }
 *
 * The harness:
 *   1. Creates a temp git repo from before/
 *   2. Copies after/ over it, stages everything
 *   3. Runs --force-batch review → result-batch.json
 *   4. Loads both results, diffs findings, reports
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  cpSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_DIR = join(__dirname, "eval");

interface KnownIssue {
  file: string;
  line: number;
  severity: "blocker" | "warning";
  description: string;
}

interface ChallengeConfig {
  title: string;
  body: string;
  known?: { issues: KnownIssue[] };
}

interface Finding {
  path: string;
  line: number;
  severity: string;
  body: string;
}

interface ReviewOutput {
  summary: string;
  action: string;
  comments: Finding[];
}

interface ComparisonResult {
  challenge: string;
  single: ReviewOutput;
  batch: ReviewOutput;
  parallel: ReviewOutput;
  batchOnly: Finding[];
  parallelOnly: Finding[];
  singleOnly: Finding[];
  both: Finding[];
  knownIssues: KnownIssue[];
  singleRecall: number;
  batchRecall: number;
  parallelRecall: number;
}

function dirname(p: string): string {
  return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
}

function setupTempRepo(challengeDir: string): string {
  const tmpDir = join(EVAL_DIR, ".tmp", basename(challengeDir));
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  // Copy "before" state, init git
  const beforeDir = join(challengeDir, "before");
  if (existsSync(beforeDir)) {
    cpSync(beforeDir, tmpDir, { recursive: true });
  } else {
    // No before/ — empty repo
    writeFileSync(join(tmpDir, ".gitkeep"), "");
  }

  execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  execSync("git config user.email 'eval@test'", { cwd: tmpDir, stdio: "pipe" });
  execSync("git config user.name 'Eval'", { cwd: tmpDir, stdio: "pipe" });
  execSync("git add -A && git commit -m 'before'", {
    cwd: tmpDir,
    stdio: "pipe",
  });

  // Apply "after" state
  const afterDir = join(challengeDir, "after");
  if (existsSync(afterDir)) {
    // Remove existing files that might be in the way, then copy
    const afterFiles = readdirSync(afterDir, { recursive: true });
    for (const f of afterFiles) {
      const src = join(afterDir, f as string);
      const dst = join(tmpDir, f as string);
      if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
      cpSync(src, dst, { recursive: true });
    }
  }

  execSync("git add -A", { cwd: tmpDir, stdio: "pipe" });
  return tmpDir;
}

function loadConfig(challengeDir: string): ChallengeConfig {
  const prPath = join(challengeDir, "pr.json");
  const knownPath = join(challengeDir, "known.yaml");

  const pr = existsSync(prPath)
    ? JSON.parse(readFileSync(prPath, "utf8"))
    : { title: basename(challengeDir), body: "" };

  let known: { issues: KnownIssue[] } | undefined;
  if (existsSync(knownPath)) {
    known = parseYaml(readFileSync(knownPath, "utf8")) as {
      issues: KnownIssue[];
    };
  }

  return { title: pr.title, body: pr.body, known };
}

function runReview(
  tmpDir: string,
  strategy: "single" | "batch" | "parallel",
  pr: { title: string; body: string },
): ReviewOutput {
  const flag =
    strategy === "single"
      ? "--force-single"
      : strategy === "parallel"
        ? "--force-parallel"
        : "--force-batch";
  const env = {
    ...process.env,
    // Override PR title/body via env — the local connector doesn't use
    // a real PR, so we inject them through a side channel.
    EVAL_PR_TITLE: pr.title,
    EVAL_PR_BODY: pr.body,
    // Force casual mode for eval to keep output concise and cheap
    EVAL_CASUAL: "1",
  };

  const cmd = `cd ${tmpDir} && ${join(__dirname, "node_modules/.bin/tsx")} ${join(__dirname, "src/cli.ts")} --local --dry-run ${flag} --no-memory --casual 2>/dev/null`;

  try {
    const stdout = execSync(cmd, {
      env,
      stdio: "pipe",
      timeout: 300_000, // 5 min timeout
    }).toString();

    const parsed = JSON.parse(stdout) as ReviewOutput;
    return parsed;
  } catch (err) {
    console.error(`  ${strategy}: FAILED — ${String(err).slice(0, 200)}`);
    return { summary: "(error)", action: "COMMENT", comments: [] };
  }
}

function matchFindings(finding: Finding, issue: KnownIssue): boolean {
  // Match by file (suffix) + line (±2 tolerance)
  const fileMatch =
    finding.path === issue.file || finding.path.endsWith("/" + issue.file);
  const lineMatch = Math.abs(finding.line - issue.line) <= 2;
  return fileMatch && lineMatch;
}

function compareResults(
  challenge: string,
  single: ReviewOutput,
  batch: ReviewOutput,
  parallel: ReviewOutput,
  knownIssues: KnownIssue[],
): ComparisonResult {
  // Normalize findings: keep unique by path + line
  const dedup = (findings: Finding[]): Finding[] => {
    const seen = new Set<string>();
    return findings.filter((f) => {
      const key = `${f.path}:${f.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const sFindings = dedup(single.comments);
  const bFindings = dedup(batch.comments);
  const pFindings = dedup(parallel.comments);

  const sKeys = new Set(sFindings.map((f) => `${f.path}:${f.line}`));
  const bKeys = new Set(bFindings.map((f) => `${f.path}:${f.line}`));
  const pKeys = new Set(pFindings.map((f) => `${f.path}:${f.line}`));

  const batchOnly = bFindings.filter((f) => !sKeys.has(`${f.path}:${f.line}`));
  const parallelOnly = pFindings.filter(
    (f) =>
      !sKeys.has(`${f.path}:${f.line}`) && !bKeys.has(`${f.path}:${f.line}`),
  );
  const singleOnly = sFindings.filter(
    (f) =>
      !bKeys.has(`${f.path}:${f.line}`) && !pKeys.has(`${f.path}:${f.line}`),
  );
  const both = bFindings.filter((f) => sKeys.has(`${f.path}:${f.line}`));

  // Recall against known issues
  let singleHits = 0;
  let batchHits = 0;
  let parallelHits = 0;
  for (const issue of knownIssues) {
    if (sFindings.some((f) => matchFindings(f, issue))) singleHits++;
    if (bFindings.some((f) => matchFindings(f, issue))) batchHits++;
    if (pFindings.some((f) => matchFindings(f, issue))) parallelHits++;
  }

  return {
    challenge,
    single,
    batch,
    parallel,
    batchOnly,
    parallelOnly,
    singleOnly,
    both,
    knownIssues,
    singleRecall: knownIssues.length > 0 ? singleHits / knownIssues.length : -1,
    batchRecall: knownIssues.length > 0 ? batchHits / knownIssues.length : -1,
    parallelRecall:
      knownIssues.length > 0 ? parallelHits / knownIssues.length : -1,
  };
}

function printReport(results: ComparisonResult[]): void {
  console.log("# Eval Report\n");

  for (const r of results) {
    console.log(`## ${r.challenge}`);
    console.log(
      `  Single-call: ${r.single.comments.length} findings, action=${r.single.action}`,
    );
    console.log(
      `  Batched:     ${r.batch.comments.length} findings, action=${r.batch.action}`,
    );
    console.log(`  Both found:  ${r.both.length}`);
    console.log(`  Batch only:  ${r.batchOnly.length}`);
    console.log(`  Single only: ${r.singleOnly.length}`);

    if (r.knownIssues.length > 0) {
      console.log(
        `  Recall:      single=${(r.singleRecall * 100).toFixed(0)}% batch=${(r.batchRecall * 100).toFixed(0)}% (${r.knownIssues.length} known issues)`,
      );
    }

    if (r.batchOnly.length > 0) {
      console.log("\n  Batch-only findings:");
      for (const f of r.batchOnly.slice(0, 5)) {
        console.log(
          `    - ${f.path}:${f.line} [${f.severity}] ${f.body.slice(0, 100)}`,
        );
      }
      if (r.batchOnly.length > 5)
        console.log(`    ... and ${r.batchOnly.length - 5} more`);
    }

    if (r.singleOnly.length > 0) {
      console.log("\n  Single-only findings:");
      for (const f of r.singleOnly.slice(0, 5)) {
        console.log(
          `    - ${f.path}:${f.line} [${f.severity}] ${f.body.slice(0, 100)}`,
        );
      }
      if (r.singleOnly.length > 5)
        console.log(`    ... and ${r.singleOnly.length - 5} more`);
    }

    console.log("");
  }

  // Aggregate
  const totalBatchOnly = results.reduce((s, r) => s + r.batchOnly.length, 0);
  const totalSingleOnly = results.reduce((s, r) => s + r.singleOnly.length, 0);
  const totalBoth = results.reduce((s, r) => s + r.both.length, 0);
  const validRecall = results.filter((r) => r.knownIssues.length > 0);
  const avgSingleRecall =
    validRecall.length > 0
      ? validRecall.reduce((s, r) => s + r.singleRecall, 0) / validRecall.length
      : -1;
  const avgBatchRecall =
    validRecall.length > 0
      ? validRecall.reduce((s, r) => s + r.batchRecall, 0) / validRecall.length
      : -1;

  console.log("## Aggregate\n");
  console.log(
    `  Total findings — single: ${results.reduce((s, r) => s + r.single.comments.length, 0)}, batch: ${results.reduce((s, r) => s + r.batch.comments.length, 0)}`,
  );
  console.log(`  Both found:  ${totalBoth}`);
  console.log(`  Batch only:  ${totalBatchOnly}`);
  console.log(`  Single only: ${totalSingleOnly}`);

  if (validRecall.length > 0) {
    console.log(
      `  Avg recall:  single=${(avgSingleRecall * 100).toFixed(0)}% batch=${(avgBatchRecall * 100).toFixed(0)}% (${validRecall.length} challenges with known issues)`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--setup-only")) {
    const challengeParent = join(EVAL_DIR, "challenges");
    const dirs = args.includes("--all")
      ? readdirSync(challengeParent, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => join(challengeParent, d.name))
      : args.filter((a) => !a.startsWith("--")).map((a) => resolve(a));
    for (const dir of dirs) {
      const tmp = setupTempRepo(dir);
      console.log(`Setup ${basename(dir)} → ${tmp}`);
      console.log(`  Files: ${readdirSync(tmp, { recursive: true }).length}`);
    }
    return;
  }

  if (args.includes("--all")) {
    const challengeParent = join(EVAL_DIR, "challenges");
    const dirs = readdirSync(challengeParent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(challengeParent, d.name));
    await runAll(dirs);
  } else if (args.length > 0) {
    await runAll(args.map((a) => resolve(a)));
  } else {
    console.error(
      "Usage: npx tsx eval/harness.ts <challenge-dir> [challenge-dir...]",
    );
    console.error("       npx tsx eval/harness.ts --all");
    process.exit(2);
  }
}

async function runAll(dirs: string[]): Promise<void> {
  const results: ComparisonResult[] = [];

  for (const dir of dirs) {
    const name = basename(dir);
    console.error(`\n=== ${name} ===`);

    const config = loadConfig(dir);
    console.error(`  Title: ${config.title}`);
    console.error(`  Known issues: ${config.known?.issues.length ?? 0}`);

    const tmpDir = setupTempRepo(dir);
    console.error(`  Temp repo: ${tmpDir}`);

    console.error("  Running single-call...");
    const single = runReview(tmpDir, "single", config);

    console.error(
      `  → ${single.comments.length} findings, action=${single.action}`,
    );

    // Reset repo state for the second run (re-apply changes)
    execSync("git checkout HEAD -- . && git clean -fd", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    const afterDir = join(dir, "after");
    if (existsSync(afterDir)) {
      cpSync(afterDir, tmpDir, { recursive: true });
    }
    execSync("git add -A", { cwd: tmpDir, stdio: "pipe" });

    console.error("  Running batched...");
    const batch = runReview(tmpDir, "batch", config);
    console.error(
      `  → ${batch.comments.length} findings, action=${batch.action}`,
    );

    // Reset and run parallel
    execSync("git checkout HEAD -- . && git clean -fd", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    if (existsSync(afterDir)) {
      cpSync(afterDir, tmpDir, { recursive: true });
    }
    execSync("git add -A", { cwd: tmpDir, stdio: "pipe" });

    console.error("  Running parallel...");
    const parallel = runReview(tmpDir, "parallel", config);
    console.error(
      `  → ${parallel.comments.length} findings, action=${parallel.action}`,
    );

    const comparison = compareResults(
      name,
      single,
      batch,
      parallel,
      config.known?.issues ?? [],
    );
    results.push(comparison);

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  }

  rmSync(join(EVAL_DIR, ".tmp"), { recursive: true, force: true });
  printReport(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
