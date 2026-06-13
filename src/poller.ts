import type { Octokit } from "@octokit/rest";
import type { Config } from "./config.js";
import { fetchPRDiscussion, findUnrepliedMentions, formatDiscussion } from "./github/comments.js";
import { logger } from "./logger.js";
import { reviewPullRequest } from "./review/engine.js";
import { replyToMention } from "./review/replyEngine.js";

const DEFAULT_INTERVAL_MS = 60_000;

/** Maximum number of full review rounds Zanuda will do per PR. */
const MAX_REVIEW_ROUNDS = 2;

/** Maximum number of @mention replies per PR before going silent. */
const MAX_MENTION_REPLIES = 5;

interface PRState {
  ref: { owner: string; repo: string };
  /** GitHub PR number (e.g. 42). */
  number: number;
  /** How many full review rounds have completed (0, 1, or 2). */
  rounds: number;
  /** How many @mention replies have been posted. */
  mentionReplies: number;
  /** Comment IDs already replied to (prevents double-replies). */
  repliedCommentIds: Set<number>;
  /** Set once the "max rounds reached" message has been posted. */
  maxRoundsNotified: boolean;
}

export async function startPoller(opts: {
  config: Config;
  botLogin: string;
  octokit: Octokit;
  intervalMs?: number;
}): Promise<void> {
  const { config, botLogin, octokit, intervalMs = DEFAULT_INTERVAL_MS } = opts;

  /**
   * Items currently being reviewed (fire-and-forget, not yet completed).
   * Prevents duplicate processing within the same session while the async
   * review is in flight. Cleared on completion (success or failure).
   */
  const inProgress = new Set<number>();

  /**
   * Persistent per-PR state for the lifetime of this process.
   * Key: GitHub's internal issue/PR item ID (stable, globally unique).
   */
  const prStates = new Map<number, PRState>();

  logger.info({ botLogin, intervalMs }, "Poller started — watching for review requests and mentions");

  const tick = async () => {
    await pollReviewRequests({ config, botLogin, octokit, inProgress, prStates });
    await pollMentions({ config, botLogin, octokit, prStates });
  };

  await tick();
  setInterval(tick, intervalMs);
}

// ── Review-request polling ────────────────────────────────────────────────────

async function pollReviewRequests(opts: {
  config: Config;
  botLogin: string;
  octokit: Octokit;
  inProgress: Set<number>;
  prStates: Map<number, PRState>;
}): Promise<void> {
  const { config, botLogin, octokit, inProgress, prStates } = opts;

  logger.debug("Polling for review requests…");

  let data;
  try {
    ({ data } = await octokit.rest.search.issuesAndPullRequests({
      q: `is:pr is:open review-requested:${botLogin}`,
      per_page: 50,
    }));
  } catch (err) {
    logger.error({ err }, "Search API error in review-request poll");
    return;
  }

  const pending = data.items.filter((item) => !inProgress.has(item.id));
  if (pending.length === 0) {
    logger.debug({ total: data.total_count }, "No new review requests");
    return;
  }

  for (const item of pending) {
    const state = prStates.get(item.id);
    const completedRounds = state?.rounds ?? 0;

    // ── Hard stop: max rounds reached ────────────────────────────────────────
    if (completedRounds >= MAX_REVIEW_ROUNDS) {
      if (!state?.maxRoundsNotified) {
        const ref = parseRepoRef(item.repository_url);
        if (ref) {
          await octokit.issues
            .createComment({
              ...ref,
              issue_number: item.number,
              body:
                `I've completed ${MAX_REVIEW_ROUNDS} review rounds on this PR — that's my limit. ` +
                `Address the outstanding comments and request a human reviewer if needed.`,
            })
            .catch((err) => logger.warn({ err }, "Failed to post max-rounds notification"));
          prStates.set(item.id, { ...state!, maxRoundsNotified: true });
        }
      }
      continue;
    }

    const ref = parseRepoRef(item.repository_url);
    if (!ref) {
      logger.warn({ url: item.repository_url }, "Could not parse repo URL — skipping");
      continue;
    }

    const nextRound = completedRounds + 1;
    logger.info(
      { repo: `${ref.owner}/${ref.repo}`, pr: item.number, round: nextRound, title: item.title },
      "Review requested",
    );

    inProgress.add(item.id);

    reviewPullRequest({ octokit, baseConfig: config }, ref, item.number, { round: nextRound })
      .then(() => {
        inProgress.delete(item.id);
        prStates.set(item.id, {
          ref,
          number: item.number,
          rounds: nextRound,
          mentionReplies: state?.mentionReplies ?? 0,
          repliedCommentIds: state?.repliedCommentIds ?? new Set(),
          maxRoundsNotified: false,
        });
        logger.info({ repo: `${ref.owner}/${ref.repo}`, pr: item.number, round: nextRound }, "Round complete");
      })
      .catch((err) => {
        logger.error({ err, repo: `${ref.owner}/${ref.repo}`, pr: item.number, round: nextRound }, "Review failed — will retry next poll");
        inProgress.delete(item.id);
        // Do NOT advance rounds on failure so the next poll retries.
      });
  }
}

// ── Mention polling ───────────────────────────────────────────────────────────

async function pollMentions(opts: {
  config: Config;
  botLogin: string;
  octokit: Octokit;
  prStates: Map<number, PRState>;
}): Promise<void> {
  const { config, botLogin, octokit, prStates } = opts;

  for (const [, state] of prStates) {
    // Only scan PRs that have at least one completed review round.
    if (state.rounds === 0) continue;
    if (state.mentionReplies >= MAX_MENTION_REPLIES) continue;

    let comments;
    try {
      comments = await fetchPRDiscussion(octokit, state.ref, state.number);
    } catch (err) {
      logger.warn(
        { err, repo: `${state.ref.owner}/${state.ref.repo}`, pr: state.number },
        "Failed to fetch discussion for mention scan",
      );
      continue;
    }

    const mentions = findUnrepliedMentions(comments, botLogin, state.repliedCommentIds);
    if (mentions.length === 0) continue;

    logger.info(
      { repo: `${state.ref.owner}/${state.ref.repo}`, pr: state.number, count: mentions.length },
      "Unread mentions found",
    );

    let prTitle = `PR #${state.number}`;
    try {
      const { data: pr } = await octokit.pulls.get({ ...state.ref, pull_number: state.number });
      prTitle = pr.title;
    } catch {
      // Non-fatal — generic title is fine.
    }

    const discussion = formatDiscussion(comments, 20);

    for (const mention of mentions) {
      if (state.mentionReplies >= MAX_MENTION_REPLIES) {
        logger.info(
          { repo: `${state.ref.owner}/${state.ref.repo}`, pr: state.number },
          `Mention reply cap (${MAX_MENTION_REPLIES}) reached — going silent on this PR`,
        );
        break;
      }

      try {
        await replyToMention(
          { octokit, config, botLogin },
          state.ref,
          state.number,
          mention,
          prTitle,
          discussion,
        );
        state.repliedCommentIds.add(mention.id);
        state.mentionReplies++;
      } catch (err) {
        logger.error({ err, commentId: mention.id }, "Failed to reply to mention");
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseRepoRef(repositoryUrl: string): { owner: string; repo: string } | null {
  const match = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}
