import "dotenv/config";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const secret = requireEnv("GITHUB_WEBHOOK_SECRET");
  const botLogin = requireEnv("GITHUB_BOT_LOGIN");
  requireEnv("GITHUB_TOKEN");

  await startServer({
    config,
    secret,
    botLogin,
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "0.0.0.0",
  });
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
