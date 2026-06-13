import "dotenv/config";
import { parseArgs } from "node:util";
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
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      local: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      diff: { type: "string" },
      output: { type: "string" },
      round: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.local) {
    await runLocalReview(values);
  } else {
    await runRemoteReview(positionals, values);
  }
}

async function runLocalReview(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const dryRun = values["dry-run"] === true;
  const diffFlag = typeof values.diff === "string" ? values.diff : undefined;
  const outputFlag =
    typeof values.output === "string" ? values.output : undefined;

  const connector = new LocalConnector({
    diffRef: diffFlag ?? "staged",
    outputFile: outputFlag ?? null,
  });

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
}

async function runRemoteReview(
  positionals: string[],
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const target = positionals[0];
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
  const dryRun = values["dry-run"] === true;
  const round = typeof values.round === "string" ? Number(values.round) : 1;

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
