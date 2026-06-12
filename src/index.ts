import "dotenv/config";
import { loadConfig } from "./config.js";
import { createOctokit } from "./github/client.js";
import { logger } from "./logger.js";
import { startPoller } from "./poller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const botLogin = requireEnv("GITHUB_BOT_LOGIN");
  requireEnv("GITHUB_TOKEN");

  const intervalMs = process.env.POLL_INTERVAL_SECS
    ? Number(process.env.POLL_INTERVAL_SECS) * 1000
    : undefined; // falls back to 60s default in poller

  await startPoller({ config, botLogin, octokit: createOctokit(), intervalMs });
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
