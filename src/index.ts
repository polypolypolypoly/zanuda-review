import "dotenv/config";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createConnector } from "./platform/index.js";
import { startPoller } from "./poller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const connector = createConnector();
  const botLogin = await connector.getBotLogin();
  logger.info(
    { botLogin, platform: connector.name },
    "Authenticated as bot account",
  );

  const intervalMs = process.env.POLL_INTERVAL_SECS
    ? Number(process.env.POLL_INTERVAL_SECS) * 1000
    : undefined;

  await startPoller({ config, botLogin, connector, intervalMs });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Kept for env validation — GITHUB_TOKEN checked inside createOctokit().
void requireEnv;

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
