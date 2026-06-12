import type { Octokit } from "@octokit/rest";
import type { Config } from "./config.js";
import { logger } from "./logger.js";
import { reviewPullRequest } from "./review/engine.js";

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Long-running poller. Every `intervalMs` milliseconds it searches GitHub for
 * open PRs where the bot account has been explicitly requested as a reviewer,
 * then runs the review engine on any new ones.
 *
 * Deduplication:
 *  - In-memory Set prevents double-reviews within a single session.
 *  - After a successful review GitHub removes the review-requested status so
 *    the search naturally stops returning that PR, keeping the Set lean.
 *  - On failure the PR is removed from the Set so it will be retried next poll.
 */
export async function startPoller(opts: {
  config: Config;
  botLogin: string;
  octokit: Octokit;
  intervalMs?: number;
}): Promise<void> {
  const { config, botLogin, octokit, intervalMs = DEFAULT_INTERVAL_MS } = opts;
  const reviewed = new Set<number>(); // GitHub PR item IDs handled this session

  logger.info(
    { botLogin, intervalMs },
    "Poller started — watching for review requests",
  );

  const tick = async () => {
    try {
      await poll({ config, botLogin, octokit, reviewed });
    } catch (err) {
      logger.error({ err }, "Poll cycle error");
    }
  };

  await tick(); // run immediately on startup
  setInterval(tick, intervalMs);
}

async function poll(opts: {
  config: Config;
  botLogin: string;
  octokit: Octokit;
  reviewed: Set<number>;
}): Promise<void> {
  const { config, botLogin, octokit, reviewed } = opts;

  logger.debug("Polling for review requests…");

  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `is:pr is:open review-requested:${botLogin}`,
    per_page: 50,
  });

  const pending = data.items.filter((item) => !reviewed.has(item.id));

  if (pending.length === 0) {
    logger.debug({ total: data.total_count }, "No new review requests");
    return;
  }

  logger.info({ count: pending.length }, "New review request(s) found");

  for (const item of pending) {
    // Mark immediately to prevent concurrent duplicate reviews within a session
    reviewed.add(item.id);

    const match = item.repository_url.match(/\/repos\/([^/]+)\/([^/]+)$/);
    if (!match) {
      logger.warn({ url: item.repository_url }, "Could not parse repo from URL — skipping");
      continue;
    }
    const owner = match[1]!;
    const repo = match[2]!;
    const ref = { owner, repo };
    const number = item.number;

    logger.info({ repo: `${owner}/${repo}`, pr: number, title: item.title }, "Reviewing PR");

    // Fire-and-forget so remaining items in this batch aren't blocked
    reviewPullRequest({ octokit, baseConfig: config }, ref, number).catch((err) => {
      logger.error({ err, repo: `${owner}/${repo}`, pr: number }, "Review failed — will retry next poll");
      reviewed.delete(item.id);
    });
  }
}
