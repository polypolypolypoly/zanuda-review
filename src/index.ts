import "dotenv/config";
import { loadConfig } from "./config.js";
import { createOctokit, getBotLogin } from "./github/client.js";
import { logger } from "./logger.js";
import { startPoller } from "./poller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  requireEnv("GITHUB_TOKEN");

  const octokit = createOctokit();
  const botLogin = await getBotLogin(octokit);
  logger.info({ botLogin }, "Authenticated as bot account");

  const intervalMs = process.env.POLL_INTERVAL_SECS
    ? Number(process.env.POLL_INTERVAL_SECS) * 1000
    : undefined;

  await startPoller({ config, botLogin, octokit, intervalMs });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
