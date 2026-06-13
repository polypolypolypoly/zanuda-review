import type { Config } from "./config.js";
import { findUnrepliedMentions } from "./github/comments.js";
import { formatDiscussion } from "./review/format.js";
import { isAllowed } from "./github/allowlist.js";
import { logger } from "./logger.js";
import { createProvider } from "./llm/index.js";
import type { SCMConnector, PendingReview } from "./platform/types.js";
import { reviewPullRequest } from "./review/engine.js";
import { replyToMention } from "./review/replyEngine.js";
import { PRStateStore } from "./state/store.js";

const DEFAULT_INTERVAL_MS = 60_000;

/** Maximum number of full review rounds per PR. */
const MAX_REVIEW_ROUNDS = 2;

/** Maximum number of @mention replies per PR before going silent. */
const MAX_MENTION_REPLIES = 5;

export async function startPoller(opts: {
  config: Config;
  botLogin: string;
  connector: SCMConnector;
  intervalMs?: number;
}): Promise<void> {
  const {
    config,
    botLogin,
    connector,
    intervalMs = DEFAULT_INTERVAL_MS,
  } = opts;

  /**
   * Items currently being reviewed (fire-and-forget, not yet completed).
   * Intentionally not persisted: on restart it is correct to retry in-flight work.
   */
  const inProgress = new Set<number>();

  /** Persistent per-PR state — survives restarts. */
  const store = new PRStateStore(config.persistence.stateFile || undefined);

  /**
   * Single provider instance shared across both review rounds and mention
   * replies. Creating it once avoids allocating a new HTTP client on every
   * mention reply and ensures consistent provider configuration.
   */
  const provider = createProvider(config.provider);

  logger.info(
    { botLogin, platform: connector.name, intervalMs },
    "Poller started — watching for review requests and mentions",
  );

  const tick = async () => {
    await pollReviewRequests({
      config,
      botLogin,
      connector,
      inProgress,
      store,
    });
    await pollMentions({ config, botLogin, connector, store, provider });
  };

  await tick();
  setInterval(
    () =>
      tick().catch((err) =>
        logger.error({ err }, "Unhandled error in poll tick"),
      ),
    intervalMs,
  );
}

// ── Review-request polling ────────────────────────────────────────────────────

async function pollReviewRequests(opts: {
  config: Config;
  botLogin: string;
  connector: SCMConnector;
  inProgress: Set<number>;
  store: PRStateStore;
}): Promise<void> {
  const { config, botLogin, connector, inProgress, store } = opts;

  logger.debug("Polling for review requests…");

  let pending: PendingReview[];
  try {
    const all = await connector.pollPendingReviews(botLogin);
    pending = all.filter((item) => !inProgress.has(item.platformId));
  } catch (err) {
    logger.error({ err }, "Error polling for review requests");
    return;
  }

  if (pending.length === 0) {
    logger.debug("No new review requests");
    return;
  }

  // Apply concurrency cap.
  const slots = config.limits.maxConcurrentReviews - inProgress.size;
  if (slots <= 0) {
    logger.warn(
      { inProgress: inProgress.size, cap: config.limits.maxConcurrentReviews },
      "Concurrency cap reached — deferring new reviews to next cycle",
    );
    return;
  }

  const newThisCycle = pending.slice(
    0,
    Math.min(slots, config.limits.maxNewPrsPerCycle),
  );
  if (newThisCycle.length < pending.length) {
    logger.info(
      {
        processing: newThisCycle.length,
        deferred: pending.length - newThisCycle.length,
      },
      "Per-cycle cap applied — deferred PRs will be picked up in later cycles",
    );
  }

  for (const item of newThisCycle) {
    const state = store.get(item.platformId);
    const completedRounds = state?.rounds ?? 0;

    // ── Allowlist check ───────────────────────────────────────────────────────
    if (!isAllowed(item.ref, config.access.allowlist)) {
      logger.warn(
        { repo: `${item.ref.owner}/${item.ref.repo}` },
        "Review request from unlisted repo — ignoring (not in access.allowlist)",
      );
      continue;
    }

    // ── Hard stop: max rounds reached ─────────────────────────────────────────
    if (completedRounds >= MAX_REVIEW_ROUNDS) {
      if (!state?.maxRoundsNotified) {
        await connector
          .postComment(
            item.ref,
            item.number,
            `I've completed ${MAX_REVIEW_ROUNDS} review rounds on this PR — that's my limit. ` +
              `Address the outstanding comments and request a human reviewer if needed.`,
          )
          .catch((err: unknown) =>
            logger.warn({ err }, "Failed to post max-rounds notification"),
          );
        store.set(item.platformId, { ...state!, maxRoundsNotified: true });
      }
      continue;
    }

    const nextRound = completedRounds + 1;
    logger.info(
      {
        repo: `${item.ref.owner}/${item.ref.repo}`,
        pr: item.number,
        round: nextRound,
        title: item.title,
      },
      "Review requested",
    );

    inProgress.add(item.platformId);

    reviewPullRequest(
      { connector, baseConfig: config },
      item.ref,
      item.number,
      {
        round: nextRound,
        progressCommentId: state?.progressCommentId ?? undefined,
      },
    )
      .then((result) => {
        if (result.stale) {
          // New commits arrived during the LLM call. The round was discarded —
          // do not increment rounds so the next poll starts a fresh review on
          // the updated HEAD. Only update the progressCommentId if we have one.
          if (result.progressCommentId !== null) {
            store.set(item.platformId, {
              ...(state ?? {
                ref: item.ref,
                number: item.number,
                rounds: 0,
                mentionReplies: 0,
                repliedCommentIds: new Set(),
                maxRoundsNotified: false,
              }),
              progressCommentId: result.progressCommentId,
            });
          }
          logger.info(
            { repo: `${item.ref.owner}/${item.ref.repo}`, pr: item.number },
            "Stale review discarded — round counter not incremented",
          );
          inProgress.delete(item.platformId);
          return;
        }

        // Persist the completed round BEFORE removing from inProgress.
        // A concurrent poll tick arriving between delete() and set() would
        // see rounds=0 and start a duplicate review. Writing first means any
        // concurrent poll sees the updated round count and skips the PR.
        store.set(item.platformId, {
          ref: item.ref,
          number: item.number,
          rounds: nextRound,
          mentionReplies: state?.mentionReplies ?? 0,
          repliedCommentIds: state?.repliedCommentIds ?? new Set(),
          maxRoundsNotified: false,
          progressCommentId:
            result.progressCommentId ?? state?.progressCommentId ?? null,
        });
        logger.info(
          {
            repo: `${item.ref.owner}/${item.ref.repo}`,
            pr: item.number,
            round: nextRound,
          },
          "Round complete",
        );
        inProgress.delete(item.platformId);
      })
      .catch((err) => {
        logger.error(
          {
            err,
            repo: `${item.ref.owner}/${item.ref.repo}`,
            pr: item.number,
            round: nextRound,
          },
          "Review failed — will retry next poll",
        );
        inProgress.delete(item.platformId);
      });
  }
}

// ── Mention polling ───────────────────────────────────────────────────────────

/**
 * Only scan PRs updated within this window. A PR that has been silent for
 * longer than this is unlikely to receive new @mentions worth responding to,
 * and scanning all stored entries unconditionally creates O(n) GitHub API
 * calls per tick.
 */
const MENTION_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function pollMentions(opts: {
  config: Config;
  botLogin: string;
  connector: SCMConnector;
  store: PRStateStore;
  provider: ReturnType<typeof createProvider>;
}): Promise<void> {
  const { config, botLogin, connector, store, provider } = opts;
  const cutoff = new Date(Date.now() - MENTION_SCAN_WINDOW_MS);

  for (const [id, state] of store.entries()) {
    if (state.rounds === 0) continue;
    if (state.mentionReplies >= MAX_MENTION_REPLIES) continue;
    // Skip PRs that haven't been touched recently — avoids a GitHub API call
    // for every stored PR on every tick.
    if (new Date(state.lastUpdatedAt) < cutoff) continue;

    let comments;
    try {
      comments = await connector.fetchDiscussion(state.ref, state.number);
    } catch (err) {
      logger.warn(
        { err, repo: `${state.ref.owner}/${state.ref.repo}`, pr: state.number },
        "Failed to fetch discussion for mention scan",
      );
      continue;
    }

    const mentions = findUnrepliedMentions(
      comments,
      botLogin,
      state.repliedCommentIds,
    );
    if (mentions.length === 0) continue;

    logger.info(
      {
        repo: `${state.ref.owner}/${state.ref.repo}`,
        pr: state.number,
        count: mentions.length,
      },
      "Unread mentions found",
    );

    let prTitle = `PR #${state.number}`;
    try {
      const pr = await connector.fetchPR(state.ref, state.number);
      prTitle = pr.title;
    } catch {
      // Non-fatal — generic title is fine.
    }

    const discussion = formatDiscussion(comments, 20);

    for (const mention of mentions) {
      // Re-read from the store each iteration so the cap check sees the
      // count that was actually persisted, not a stale local copy.
      const current = store.get(id);
      if (!current || current.mentionReplies >= MAX_MENTION_REPLIES) {
        logger.info(
          { repo: `${state.ref.owner}/${state.ref.repo}`, pr: state.number },
          `Mention reply cap (${MAX_MENTION_REPLIES}) reached — going silent on this PR`,
        );
        break;
      }

      try {
        await replyToMention(
          { connector, config, botLogin, provider },
          state.ref,
          state.number,
          mention,
          prTitle,
          discussion,
        );
        // All state mutations go through store.set() — no direct field mutation.
        store.set(id, {
          ...current,
          repliedCommentIds: new Set([
            ...current.repliedCommentIds,
            mention.id,
          ]),
          mentionReplies: current.mentionReplies + 1,
        });
      } catch (err) {
        logger.error(
          { err, commentId: mention.id },
          "Failed to reply to mention",
        );
      }
    }
  }
}
