import Fastify from "fastify";
import type { Config } from "./config.js";
import { createOctokit } from "./github/client.js";
import { createWebhooks } from "./github/webhook.js";
import { logger } from "./logger.js";

export interface ServerOptions {
  config: Config;
  secret: string;
  botLogin: string;
  port: number;
  host: string;
}

/** HTTP server exposing the GitHub webhook endpoint and a health check. */
export async function startServer(opts: ServerOptions): Promise<void> {
  const app = Fastify({ logger: false });
  const webhooks = createWebhooks({
    secret: opts.secret,
    botLogin: opts.botLogin,
    baseConfig: opts.config,
    octokit: createOctokit(),
  });

  app.get("/health", async () => ({ status: "ok" }));

  // Need the raw body to verify the HMAC signature.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  app.post("/webhook", async (req, reply) => {
    const id = req.headers["x-github-delivery"] as string;
    const name = req.headers["x-github-event"] as string;
    const signature = req.headers["x-hub-signature-256"] as string;
    try {
      await webhooks.verifyAndReceive({
        id,
        name: name as never,
        signature,
        payload: req.body as string,
      });
      reply.code(202).send({ ok: true });
    } catch (err) {
      logger.warn({ err }, "Rejected webhook delivery");
      reply.code(400).send({ ok: false });
    }
  });

  await app.listen({ port: opts.port, host: opts.host });
  logger.info({ port: opts.port, host: opts.host }, "review-helper listening on /webhook");
}
