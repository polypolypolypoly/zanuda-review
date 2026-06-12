import { Webhooks } from "@octokit/webhooks";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { reviewPullRequest } from "../review/engine.js";
import { createOctokit } from "./client.js";

export interface WebhookDeps {
  secret: string;
  botLogin: string;
  baseConfig: Config;
}

/**
 * Wire up the `pull_request.review_requested` event. We only act when *this*
 * bot account is the requested reviewer — that is the user's "request a review
 * from the bot" gesture on github.com.
 */
export function createWebhooks(deps: WebhookDeps): Webhooks {
  const webhooks = new Webhooks({ secret: deps.secret });

  webhooks.on("pull_request.review_requested", async ({ payload }) => {
    const reviewer =
      "requested_reviewer" in payload ? payload.requested_reviewer : undefined;
    if (!reviewer || reviewer.login.toLowerCase() !== deps.botLogin.toLowerCase()) {
      return; // a different reviewer was requested
    }

    const ref = { owner: payload.repository.owner.login, repo: payload.repository.name };
    const number = payload.pull_request.number;
    logger.info({ repo: `${ref.owner}/${ref.repo}`, pr: number }, "Review requested");

    // Run the review in the background so the webhook returns 200 promptly;
    // GitHub times out delivery after ~10s.
    void reviewPullRequest({ octokit: createOctokit(), baseConfig: deps.baseConfig }, ref, number).catch(
      (err) => logger.error({ err, repo: ref, pr: number }, "Review failed"),
    );
  });

  webhooks.onError((err) => logger.error({ err }, "Webhook processing error"));
  return webhooks;
}
