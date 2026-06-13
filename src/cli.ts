import "dotenv/config";
import { loadConfig } from "./config.js";
import { createConnector, LocalConnector } from "./platform/index.js";
import { reviewPullRequest } from "./review/engine.js";

/**
 * Manual / local review runner.
 *
 * Remote PR review:
 *   zanuda owner/repo#123
 *   zanuda owner/repo#123 --dry-run
 *   zanuda owner/repo#123 --round=2
 *
 * Local review (no GitHub account needed):
 *   zanuda --local                        # review staged changes
 *   zanuda --local --diff main            # review diff against main
 *   zanuda --local --diff HEAD~3          # review last 3 commits
 *   zanuda --local --output review.md     # write to file instead of stdout
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--local")) {
    await runLocalReview(args);
  } else {
    await runRemoteReview(args);
  }
}

async function runLocalReview(args: string[]): Promise<void> {
  const diffFlag: string | undefined =
    args.find((a) => a.startsWith("--diff="))?.split("=")[1] ??
    nextArgValue(args, "--diff");

  const outputFlag: string | undefined =
    args.find((a) => a.startsWith("--output="))?.split("=")[1] ??
    nextArgValue(args, "--output");

  const dryRun = args.includes("--dry-run");

  const connector = new LocalConnector({
    diffRef: diffFlag ?? "staged",
    outputFile: outputFlag ?? null,
  });

  const botLogin = await connector.getBotLogin();
  const ref = {
    owner: "local",
    repo: process.cwd().split("/").pop() ?? "repo",
  };

  const result = await reviewPullRequest(
    { connector, baseConfig: loadConfig() },
    ref,
    0,
    { dryRun },
  );

  if (dryRun) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stderr.write(
      `Review complete — ${result.comments.length} inline comment(s).\n`,
    );
  }

  void botLogin; // used by engine internally
}

async function runRemoteReview(args: string[]): Promise<void> {
  const [target, ...flags] = args;
  const match = target?.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) {
    console.error(
      "Usage:\n" +
        "  zanuda owner/repo#123 [--dry-run] [--round=1|2]   # remote PR review\n" +
        "  zanuda --local [--diff <ref>] [--output <file>]   # local review",
    );
    process.exit(2);
  }
  const [, owner, repo, num] = match;
  const dryRun = flags.includes("--dry-run");
  const roundFlag = flags.find((f) => f.startsWith("--round="));
  const round = roundFlag ? Number(roundFlag.split("=")[1]) : 1;

  const result = await reviewPullRequest(
    { connector: createConnector(), baseConfig: loadConfig() },
    { owner: owner!, repo: repo! },
    Number(num),
    { dryRun, round },
  );

  if (dryRun) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Posted review with ${result.comments.length} comment(s).`);
  }
}

/** Return the value after a flag if it doesn't start with '-', else undefined. */
function nextArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  return next && !next.startsWith("-") ? next : undefined;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
