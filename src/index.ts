import "dotenv/config";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createConnector } from "./platform/index.js";
import { startPoller } from "./poller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const connector = createConnector();
  const reviewerLogin = await connector.getReviewerLogin();
  logger.info(
    { reviewerLogin, platform: connector.name },
    "Authenticated as reviewer account",
  );

  let intervalMs: number | undefined;
  if (process.env.POLL_INTERVAL_SECS) {
    const secs = Number(process.env.POLL_INTERVAL_SECS);
    if (!Number.isFinite(secs) || secs <= 0) {
      throw new Error(
        `Invalid POLL_INTERVAL_SECS="${process.env.POLL_INTERVAL_SECS}": must be a positive number`,
      );
    }
    intervalMs = secs * 1000;
  }

  await startPoller({ config, reviewerLogin, connector, intervalMs });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
