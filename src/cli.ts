import { config as loadDotenv } from "dotenv";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
});
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { buildContext } from "./context/builder.js";
import { generateRepoMemory, saveRepoMemory } from "./context/repoMemory.js";
import { createProvider } from "./llm/index.js";
import { logger } from "./logger.js";
import { createConnector, LocalConnector } from "./platform/index.js";
import { reviewPullRequest } from "./review/engine.js";

function forceStrategy(
  values: Record<string, string | boolean | undefined>,
): "single" | "batch" | undefined {
  if (values["force-single"] === true) return "single";
  if (values["force-batch"] === true) return "batch";
  return undefined;
}

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
 *
 * Repo memory scan (initial snapshot):
 *   zanuda --spawn                        # scan repo, generate memory, print + save
 *   zanuda --spawn --model qwen2.5:14b    # use a specific model for the scan
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
      "no-memory": { type: "boolean", default: false },
      model: { type: "string" },
      casual: { type: "boolean", default: false },
      spawn: { type: "boolean", default: false },
      "force-single": { type: "boolean", default: false },
      "force-batch": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.spawn) {
    await runSpawn(values);
  } else if (values.local) {
    await runLocalReview(values);
  } else {
    await runRemoteReview(positionals, values);
  }
}

async function runLocalReview(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const dryRun = values["dry-run"] === true;
  const noMemory = values["no-memory"] === true;
  const casual = values["casual"] === true || process.env.EVAL_CASUAL === "1";
  const diffFlag = typeof values.diff === "string" ? values.diff : undefined;
  const outputFlag =
    typeof values.output === "string" ? values.output : undefined;
  const modelOverride =
    typeof values.model === "string" ? values.model : undefined;

  const config = loadConfig();
  if (noMemory) config.memory.enabled = false;
  if (modelOverride) config.models[config.provider] = modelOverride;
  if (casual) {
    config.preprompt =
      config.preprompt +
      `\n\n## Casual mode\nThis is a quick sanity check, not a formal review. Be concise — focus on:\n- Obvious bugs, logic errors, or typos\n- Things that would definitely break\n- One sentence per issue is enough\nSkip stylistic opinions, minor best-practice nits, and suggestions for tests\nunless something is actually broken.`;
  }

  const connector = new LocalConnector({
    diffRef: diffFlag ?? "staged",
    outputFile: outputFlag ?? null,
  });

  const ref = {
    owner: "local",
    repo: basename(process.cwd()) || "repo",
  };

  const result = await reviewPullRequest(
    { connector, baseConfig: config },
    ref,
    0,
    {
      dryRun,
      forceStrategy: forceStrategy(values),
    },
  );

  if (dryRun) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stderr.write(
      `Review complete — ${result.comments.length} inline comment(s).\n`,
    );
  }
}

export async function runSpawn(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const modelOverride =
    typeof values.model === "string" ? values.model : undefined;

  const config = loadConfig();
  config.memory.enabled = true;
  if (modelOverride) config.models[config.provider] = modelOverride;

  const repoName = basename(process.cwd()) || "repo";
  const ref = { owner: "local", repo: repoName };

  const connector = new LocalConnector();
  const provider = createProvider(config.provider);

  process.stderr.write(`Scanning ${repoName}...\n`);
  const context = await buildContext(connector, ref, "HEAD", config);

  const fileCount = context.text.match(/<file path=/g)?.length ?? 0;
  process.stderr.write(
    `Generating memory from ${fileCount} context file(s)...\n`,
  );

  const memory = await generateRepoMemory(ref, context, config, provider);
  const savedPath = saveRepoMemory(config, ref, memory);

  const log = logger.child({ repo: repoName });
  log.info("Repo memory generated via --spawn");

  process.stderr.write(`Saved to ${savedPath}\n\n`);
  process.stdout.write(memory + "\n");
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
        "  zanuda --local [--diff <ref>] [--output <file>] [--model <id>] [--no-memory] [--casual]",
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
    { dryRun, round, forceStrategy: forceStrategy(values) },
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
