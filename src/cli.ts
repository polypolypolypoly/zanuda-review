import "dotenv/config";
import { loadConfig } from "./config.js";
import { createOctokit } from "./github/client.js";
import { reviewPullRequest } from "./review/engine.js";

/**
 * Manual / local review without webhooks. Useful for testing the pipeline and
 * for one-off reviews.
 *
 *   npm run review -- owner/repo#123          # post the review
 *   npm run review -- owner/repo#123 --dry-run # print JSON, post nothing
 */
async function main(): Promise<void> {
  const [target, ...flags] = process.argv.slice(2);
  const match = target?.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) {
    console.error("Usage: review-helper <owner>/<repo>#<pr-number> [--dry-run] [--round=1|2]");
    process.exit(2);
  }
  const [, owner, repo, num] = match;
  const dryRun = flags.includes("--dry-run");
  const roundFlag = flags.find((f) => f.startsWith("--round="));
  const round = roundFlag ? Number(roundFlag.split("=")[1]) : 1;

  const result = await reviewPullRequest(
    { octokit: createOctokit(), baseConfig: loadConfig() },
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
