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
import { isTransientError } from "./llm/retry.js";
import {
  applyEvent,
  freshState,
  MAX_REVIEW_ROUNDS,
} from "./state/transitions.js";
import { CommitLog } from "./state/commitLog.js";

const DEFAULT_INTERVAL_MS = 60_000;

/** Maximum number of @mention replies per PR before going silent. */
const MAX_MENTION_REPLIES = 5;

/** Author-only commands recognised in an @mention. */
const RETRY_PATTERN = /\bretry\b/i;
const RE_REVIEW_PATTERN =
  /\b(?:re-?review|review again|round\s*2|re-?check)\b/i;

export async function startPoller(opts: {
  config: Config;
  reviewerLogin: string;
  connector: SCMConnector;
  intervalMs?: number;
}): Promise<void> {
  const {
    config,
    reviewerLogin,
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

  /** Tracks reviewed commit SHAs per repo — prevents re-reviewing merge PRs. */
  const commitLog = new CommitLog(
    config.persistence.commitLogFile || undefined,
  );

  /**
   * Single provider instance shared across both review rounds and mention
   * replies. Creating it once avoids allocating a new HTTP client on every
   * mention reply and ensures consistent provider configuration.
   */
  const provider = createProvider(config.provider);

  logger.info(
    { reviewerLogin, platform: connector.name, intervalMs },
    "Poller started — watching for review requests and mentions",
  );

  const tick = async () => {
    await pollReviewRequests({
      config,
      reviewerLogin,
      connector,
      inProgress,
      store,
      commitLog,
    });
    await pollMentions({ config, reviewerLogin, connector, store, provider });
  };

  runPollLoop(tick, intervalMs);
}

/**
 * Run `tick` forever, waiting `intervalMs` AFTER each run finishes.
 *
 * Not setInterval: a tick that outlives the interval would overlap the next
 * one. pollMentions awaits an LLM reply inline and persists repliedCommentIds
 * only after the reply lands, so an overlapping tick re-fetches the same
 * discussion mid-call and answers the same mention twice. The review path has
 * the same shape of window between the inProgress filter and inProgress.add.
 *
 * Returns a stop function; the poller never calls it, tests do.
 */
export function runPollLoop(
  tick: () => Promise<void>,
  intervalMs: number,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, "Unhandled error in poll tick");
    }
    if (!stopped) timer = setTimeout(run, intervalMs);
  };

  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// ── Review-request polling ────────────────────────────────────────────────────

async function pollReviewRequests(opts: {
  config: Config;
  reviewerLogin: string;
  connector: SCMConnector;
  inProgress: Set<number>;
  store: PRStateStore;
  commitLog: CommitLog;
}): Promise<void> {
  const { config, reviewerLogin, connector, inProgress, store, commitLog } =
    opts;

  logger.debug("Polling for review requests…");

  let pending: PendingReview[];
  try {
    const all = await connector.pollPendingReviews(reviewerLogin);
    pending = all.filter((item) => !inProgress.has(item.platformId));
  } catch (err) {
    logger.error({ err }, "Error polling for review requests");
    return;
  }

  // Also scan the state store for PRs with explicit re-review requests
  // (set by the mention path when the author posts "@reviewer re-review").
  // These may not appear in pollPendingReviews if the original review
  // request was already fulfilled (submitted review / dismiss).
  for (const [platformId, s] of store.entries()) {
    if (
      s.reReviewRequested &&
      !pending.some(
        (p) =>
          p.ref.owner === s.ref.owner &&
          p.ref.repo === s.ref.repo &&
          p.number === s.number,
      ) &&
      !inProgress.has(platformId)
    ) {
      pending.push({
        ref: s.ref,
        number: s.number,
        title: `PR #${s.number}`,
        platformId,
      });
    }
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

    // ── Waiting for manual retry ──────────────────────────────────────────────
    // A previous attempt failed. We don't retry automatically — we wait for
    // an @mention retry command which clears this flag.
    if (state?.failedAwaitingRetry) {
      continue;
    }

    // ── Hard stop: max rounds reached ─────────────────────────────────────────
    if (completedRounds >= MAX_REVIEW_ROUNDS) {
      // state must exist here: completedRounds ≥ 2 means rounds were written
      // to the store by a previous cycle. Guard explicitly.
      if (!state) {
        logger.warn(
          { repo: `${item.ref.owner}/${item.ref.repo}`, pr: item.number },
          "Max rounds reached but no state found — skipping",
        );
        continue;
      }
      if (!state.maxRoundsNotified) {
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
        // state is guaranteed non-null here (guarded above).
        store.set(
          item.platformId,
          applyEvent(state, { type: "MAX_ROUNDS_REACHED" }),
        );
      }
      continue;
    }

    const nextRound = completedRounds + 1;

    // ── Re-review gate: round 2+ requires an EXPLICIT author request ──────
    // Zanuda acts ONLY on a real re-request or @mention. Round 2 does NOT
    // auto-trigger when the author pushes new commits, and it does NOT
    // infer a re-request from the PR appearing in pollPendingReviews —
    // the search/poll API is eventually consistent and can still return a
    // PR whose request was just fulfilled (by a submitted review or a
    // dismiss), which previously caused spurious round-2 reviews.
    //
    // Two authoritative paths to round 2:
    //   1. Author re-requests on GitHub → reviewer is back in
    //      `requested_reviewers` (verified via a strongly-consistent
    //      pulls.get, NOT the lagging search index).
    //   2. Author posts "@reviewer re-review" → mention path sets
    //      reReviewRequested → state-store scan picks it up.
    if (nextRound >= 2) {
      let explicitReRequest = state?.reReviewRequested === true;
      if (!explicitReRequest) {
        try {
          explicitReRequest = await connector.isReviewRequested(
            item.ref,
            item.number,
            reviewerLogin,
          );
        } catch (err) {
          // If the authoritative check fails, do NOT fall back to the
          // search-index heuristic — that caused spurious round-2 reviews.
          // Withhold and retry next tick when the API is healthy.
          logger.warn(
            {
              err,
              repo: `${item.ref.owner}/${item.ref.repo}`,
              pr: item.number,
            },
            "Re-review check failed — withholding round 2 until next cycle",
          );
          continue;
        }
      }
      if (!explicitReRequest) {
        logger.debug(
          { repo: `${item.ref.owner}/${item.ref.repo}`, pr: item.number },
          "Round 2 withheld — author has not re-requested review",
        );
        continue;
      }
      // Consume the mention-driven flag once we've acted on it; the GitHub
      // re-request is self-clearing (the round's dismiss removes the reviewer
      // again, and the next round requires another explicit re-request).
      // The state write below persists reReviewRequested=false.
    }

    // ── Commit dedup gate (round 1 only) ───────────────────────────────────
    // If every commit in this PR was already reviewed in a previous PR,
    // skip — nothing new to check. Catches develop→main sync PRs where
    // all feature-PR commits were already reviewed individually.
    if (nextRound === 1) {
      try {
        const shas = await connector.listCommitShas(item.ref, item.number);
        if (
          shas.length > 0 &&
          commitLog.hasAll(item.ref.owner, item.ref.repo, shas)
        ) {
          logger.info(
            {
              repo: `${item.ref.owner}/${item.ref.repo}`,
              pr: item.number,
              commits: shas.length,
            },
            "All commits already reviewed in prior PRs — skipping",
          );
          await connector
            .postComment(
              item.ref,
              item.number,
              `⏭️ **Skipping review** — all ${shas.length} commit(s) in this PR were already reviewed in earlier PRs. Nothing new to check.`,
            )
            .catch((err: unknown) =>
              logger.warn({ err }, "Failed to post skip-review comment"),
            );
          continue;
        }
      } catch (err) {
        logger.warn(
          {
            err,
            repo: `${item.ref.owner}/${item.ref.repo}`,
            pr: item.number,
          },
          "Commit dedup check failed — proceeding with review anyway",
        );
      }
    }

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

    // Always read the latest persisted state: the onProgressComment callback
    // below writes to the store while the review runs, so the `state` captured
    // before the review is stale by the time the handlers fire.
    const currentState = () =>
      store.get(item.platformId) ?? state ?? freshState(item.ref, item.number);

    reviewPullRequest(
      { connector, baseConfig: config, reviewerLogin },
      item.ref,
      item.number,
      {
        round: nextRound,
        progressCommentId: state?.progressCommentId ?? undefined,
        onProgressComment: (progressCommentId) =>
          store.set(
            item.platformId,
            applyEvent(currentState(), {
              type: "PROGRESS_COMMENT_POSTED",
              progressCommentId,
            }),
          ),
      },
    )
      .then((result) => {
        if (result.stale) {
          // New commits arrived during the LLM call. The round was discarded —
          // do not increment rounds so the next poll starts a fresh review on
          // the updated HEAD. Only persist if the engine created/edited a
          // placeholder mid-flight (otherwise there's nothing state-worthy to
          // write — a stale discard with no placeholder change is a no-op).
          if (result.progressCommentId !== null) {
            store.set(
              item.platformId,
              applyEvent(currentState(), {
                type: "ROUND_STALE",
                progressCommentId: result.progressCommentId,
              }),
            );
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
        store.set(
          item.platformId,
          applyEvent(currentState(), {
            type: "ROUND_COMPLETED",
            round: nextRound,
          }),
        );

        // Record reviewed commits so future merge/sync PRs with the same
        // commits are skipped. Fire-and-forget — a failure here is non-fatal.
        connector
          .listCommitShas(item.ref, item.number)
          .then((shas) => {
            if (shas.length > 0) {
              commitLog.addAll(item.ref.owner, item.ref.repo, shas);
            }
          })
          .catch((err: unknown) =>
            logger.warn({ err }, "Failed to record reviewed commits"),
          );

        // After a round completes, submitting the COMMENT review event on
        // GitHub naturally clears `requested_reviewers` — Zanuda disappears
        // from the sidebar with no timeline event. Round 2 only happens when
        // the author explicitly re-requests (verified via
        // isReviewRequested, NOT the lagging search index) or uses an
        // @mention (reReviewRequested in the state store).
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
      .catch(async (err) => {
        // A transport failure (GitHub 5xx, rate limit, socket error) says
        // nothing about this PR — the next tick should just try again, since
        // the review request is still open. Only a content failure (unparseable
        // model output, non-retryable 4xx) waits for a human. The transient
        // path is bounded by MAX_TRANSIENT_RETRIES inside the reducer.
        const transient = isTransientError(err);
        logger.error(
          {
            err,
            repo: `${item.ref.owner}/${item.ref.repo}`,
            pr: item.number,
            round: nextRound,
            transient,
          },
          transient
            ? "Review failed on a transient error — retrying next tick"
            : "Review failed — waiting for @mention retry command",
        );
        try {
          // The engine's failSafe already updated the progress comment with
          // the error and the retry hint. Record the failure in state.
          store.set(
            item.platformId,
            applyEvent(currentState(), {
              type: transient ? "ROUND_FAILED_TRANSIENT" : "ROUND_FAILED",
            }),
          );
        } finally {
          inProgress.delete(item.platformId);
        }
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

/** Exported for tests — the poller's only entry point is startPoller. */
export async function pollMentions(opts: {
  config: Config;
  reviewerLogin: string;
  connector: SCMConnector;
  store: PRStateStore;
  provider: ReturnType<typeof createProvider>;
}): Promise<void> {
  const { config, reviewerLogin, connector, store, provider } = opts;
  const cutoff = new Date(Date.now() - MENTION_SCAN_WINDOW_MS);

  for (const [id, state] of store.entries()) {
    // Re-check the allowlist on every tick. State entries outlive a repo's
    // allowlist membership, and each reply refreshes the 7-day scan window —
    // without this, a de-listed repo keeps its mention-reply privileges
    // (LLM spend + bot posting) indefinitely.
    if (!isAllowed(state.ref, config.access.allowlist)) {
      logger.debug(
        { repo: `${state.ref.owner}/${state.ref.repo}`, pr: state.number },
        "Skipping mention scan — repo not in access.allowlist",
      );
      continue;
    }
    // Scan PRs that have at least one completed round OR are waiting for a
    // retry command (failedAwaitingRetry=true, rounds may still be 0).
    if (state.rounds === 0 && !state.failedAwaitingRetry) continue;
    if (
      state.mentionReplies >= MAX_MENTION_REPLIES &&
      !state.failedAwaitingRetry
    )
      continue;
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
      reviewerLogin,
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
    // Commands are gated on the author login, so a failed fetch is not
    // recoverable for them — null means "unknown", and commands are withheld.
    let prAuthor: string | null = null;
    try {
      const pr = await connector.fetchPR(state.ref, state.number);
      prTitle = pr.title;
      prAuthor = pr.author || null;
    } catch (err) {
      logger.warn(
        { err, repo: `${state.ref.owner}/${state.ref.repo}`, pr: state.number },
        "Failed to fetch PR for mention scan — commands withheld this tick",
      );
    }

    const discussion = formatDiscussion(comments, 20);

    for (const mention of mentions) {
      // Re-read from the store each iteration so the cap check sees the
      // count that was actually persisted, not a stale local copy.
      const current = store.get(id);
      if (!current) break;

      // ── Command gate ──────────────────────────────────────────────────────
      // retry and re-review spend money: a re-review is a full review round,
      // a retry re-opens one. On a public repo anyone can comment, so both are
      // restricted to the PR author. Everything else stays open to any
      // commenter (capped at MAX_MENTION_REPLIES).
      const isRetryCommand =
        current.failedAwaitingRetry && RETRY_PATTERN.test(mention.body);
      const isReReviewCommand =
        current.rounds >= 1 &&
        current.rounds < MAX_REVIEW_ROUNDS &&
        RE_REVIEW_PATTERN.test(mention.body);

      if (isRetryCommand || isReReviewCommand) {
        if (prAuthor === null) {
          // Author unknown (PR fetch failed above) — leave the mention
          // unreplied so the next tick can classify it properly.
          continue;
        }
        if (mention.author.toLowerCase() !== prAuthor.toLowerCase()) {
          logger.info(
            {
              repo: `${state.ref.owner}/${state.ref.repo}`,
              pr: state.number,
              commenter: mention.author,
            },
            "Ignoring command from non-author",
          );
          try {
            await connector.replyToComment(
              state.ref,
              state.number,
              mention,
              `Only the PR author (@${prAuthor}) can request a re-review or a retry.`,
            );
          } catch (err) {
            logger.warn({ err }, "Failed to post command-refusal reply");
          }
          store.set(
            id,
            applyEvent(current, {
              type: "MENTION_REPLIED",
              repliedCommentId: mention.id,
            }),
          );
          continue;
        }
      }

      // ── Retry command ──────────────────────────────────────────────────────
      // The PR is in the failed-awaiting-retry state and the author asked for
      // a retry. We clear the flag and acknowledge — the next
      // pollReviewRequests tick picks the PR up again because the review
      // request is still open on the platform.
      if (isRetryCommand) {
        logger.info(
          { repo: `${state.ref.owner}/${state.ref.repo}`, pr: state.number },
          "Retry command received — resetting failed state",
        );
        try {
          await connector.replyToComment(
            state.ref,
            state.number,
            mention,
            `Starting a new review.`,
          );
        } catch (err) {
          logger.warn({ err }, "Failed to post retry acknowledgement");
        }
        store.set(
          id,
          applyEvent(current, {
            type: "RETRY_REQUESTED",
            repliedCommentId: mention.id,
          }),
        );
        continue;
      }

      // ── Re-review command ─────────────────────────────────────────────────
      // The author posted @reviewer with one of the re-review trigger words.
      // Sets the reReviewRequested flag so the next pollReviewRequests tick
      // picks the PR up for round 2+.
      if (isReReviewCommand) {
        logger.info(
          {
            repo: `${state.ref.owner}/${state.ref.repo}`,
            pr: state.number,
          },
          "Re-review command received",
        );
        try {
          await connector.replyToComment(
            state.ref,
            state.number,
            mention,
            "Starting re-review.",
          );
        } catch (err) {
          logger.warn({ err }, "Failed to post re-review acknowledgement");
        }
        store.set(
          id,
          applyEvent(current, {
            type: "RE_REVIEW_REQUESTED",
            repliedCommentId: mention.id,
          }),
        );
        continue;
      }

      // ── Regular mention reply ───────────────────────────────────────────────
      if (current.mentionReplies >= MAX_MENTION_REPLIES) {
        logger.info(
          { repo: `${state.ref.owner}/${state.ref.repo}`, pr: state.number },
          `Mention reply cap (${MAX_MENTION_REPLIES}) reached — going silent on this PR`,
        );
        break;
      }

      try {
        await replyToMention(
          { connector, config, reviewerLogin, provider },
          state.ref,
          state.number,
          mention,
          prTitle,
          discussion,
        );
        store.set(
          id,
          applyEvent(current, {
            type: "MENTION_REPLIED",
            repliedCommentId: mention.id,
          }),
        );
      } catch (err) {
        logger.error(
          { err, commentId: mention.id },
          "Failed to reply to mention",
        );
      }
    }
  }
}
