/**
 * Pure state-machine transitions for a PR's review lifecycle.
 *
 * The poller mutates `PRState` across several call sites (round completed,
 * round stale, round failed, retry requested, re-review requested, mention
 * replied, max-rounds reached). Historically each site hand-spread a fresh
 * state object, and several production bugs (#33, #43, #62, #68) were wrong
 * flag combinations after a transition.
 *
 * This module is the single source of truth for that math. Every mutation is
 * a pure function `applyEvent(state, event) -> state`. The poller's job is to
 * decide WHICH event happened (a side effect: did the LLM call succeed? did
 * the author post a mention?); this module decides what that means for state.
 *
 * Invariants enforced here (and tested in transitions.test.ts):
 *   - ROUND_COMPLETED consumes reReviewRequested and clears failedAwaitingRetry.
 *   - ROUND_FAILED sets failedAwaitingRetry; rounds is NEVER mutated by failure.
 *   - RETRY_REQUESTED clears failedAwaitingRetry and consecutiveFailures, leaves rounds.
 *   - RE_REVIEW_REQUESTED is idempotent and never touches rounds.
 *   - MAX_ROUNDS_REACHED is idempotent (posting it twice does nothing the 2nd time).
 *   - progressCommentId is null after a round completes (placeholder resolved).
 */

import type { PRState } from "./store.js";

/** The maximum number of full review rounds per PR. Single source of truth —
 * imported by the poller so the latch math and the gate can never drift. */
export const MAX_REVIEW_ROUNDS = 2;

// ── Events ───────────────────────────────────────────────────────────────────

export type PRStateEvent =
  | {
      type: "ROUND_COMPLETED";
      round: number;
      headSha: string;
    }
  | {
      type: "ROUND_STALE";
      /** Progress comment created/edited during the discarded round, if any. */
      progressCommentId: number | null;
      /** Head SHA observed when staleness was detected (the old, reviewed HEAD). */
      headSha: string | null;
    }
  | {
      type: "ROUND_FAILED";
    }
  | {
      type: "RETRY_REQUESTED";
      repliedCommentId: number;
    }
  | {
      type: "RE_REVIEW_REQUESTED";
      repliedCommentId: number;
    }
  | {
      type: "MENTION_REPLIED";
      repliedCommentId: number;
    }
  | {
      type: "MAX_ROUNDS_REACHED";
    };

// ── Defaults ─────────────────────────────────────────────────────────────────

/**
 * A fresh PRState for a PR that has never been reviewed. Used when an event
 * arrives for a platformId with no prior state (the poller's spread fallback).
 */
export function freshState(
  ref: { owner: string; repo: string },
  number: number,
): PRState {
  return {
    ref,
    number,
    rounds: 0,
    mentionReplies: 0,
    repliedCommentIds: new Set<number>(),
    maxRoundsNotified: false,
    progressCommentId: null,
    consecutiveFailures: 0,
    lastReviewedHeadSha: null,
    failedAwaitingRetry: false,
    reReviewRequested: false,
    // lastUpdatedAt is set by the store on write; give it a sentinel here so
    // the field is never undefined before persistence.
    lastUpdatedAt: new Date(0).toISOString(),
  };
}

// ── Reducer ──────────────────────────────────────────────────────────────────

/**
 * Apply a lifecycle event to a PR's state. Pure: no I/O, no logging, no side
 * effects. Returns a new state object; the input is not mutated.
 *
 * Callers persist the result via `store.set(id, result)` (without
 * `lastUpdatedAt`, which the store stamps on write).
 */
export function applyEvent(prev: PRState, event: PRStateEvent): PRState {
  switch (event.type) {
    case "ROUND_COMPLETED": {
      // A completed round is the authoritative "we are done with this round"
      // signal: it consumes the mention-driven re-review request, clears any
      // failure state, and nulls the progress placeholder (resolved into the
      // review). rounds advances; maxRoundsNotified latches if this was the
      // final allowed round.
      return {
        ...prev,
        rounds: event.round,
        progressCommentId: null,
        consecutiveFailures: 0,
        failedAwaitingRetry: false,
        reReviewRequested: false,
        lastReviewedHeadSha: event.headSha,
        maxRoundsNotified:
          prev.maxRoundsNotified || event.round >= MAX_REVIEW_ROUNDS,
      };
    }

    case "ROUND_STALE": {
      // New commits arrived during the LLM call. The round was discarded;
      // rounds is NOT incremented so the next poll re-reviews the new HEAD.
      // Preserve progressCommentId if the engine created one mid-flight.
      return {
        ...prev,
        progressCommentId: event.progressCommentId,
        consecutiveFailures: 0,
        failedAwaitingRetry: false,
        lastReviewedHeadSha: event.headSha ?? prev.lastReviewedHeadSha,
      };
    }

    case "ROUND_FAILED": {
      // One attempt per trigger (PR #32). Do NOT auto-retry; wait for an
      // explicit @mention retry. rounds is untouched on purpose — a failure
      // is not a completed round.
      return {
        ...prev,
        progressCommentId: null,
        consecutiveFailures: prev.consecutiveFailures + 1,
        failedAwaitingRetry: true,
      };
    }

    case "RETRY_REQUESTED": {
      // Author posted "@reviewer retry". Clear the failure gate so the next
      // poll tick picks the PR up again. consecutiveFailures resets so a
      // later failure doesn't look like a long failure streak.
      return {
        ...prev,
        failedAwaitingRetry: false,
        consecutiveFailures: 0,
        repliedCommentIds: addToSet(
          prev.repliedCommentIds,
          event.repliedCommentId,
        ),
      };
    }

    case "RE_REVIEW_REQUESTED": {
      // Author posted "@reviewer re-review". Set the flag so the next
      // pollReviewRequests tick proceeds to round 2+. Idempotent: setting it
      // twice (e.g. two mentions) is the same as once. Never touches rounds —
      // the flag is consumed by the next ROUND_COMPLETED.
      return {
        ...prev,
        reReviewRequested: true,
        repliedCommentIds: addToSet(
          prev.repliedCommentIds,
          event.repliedCommentId,
        ),
      };
    }

    case "MENTION_REPLIED": {
      // A regular (non-command) mention was answered. Bump the cap counter and
      // record the replied comment so we don't reply again.
      return {
        ...prev,
        mentionReplies: prev.mentionReplies + 1,
        repliedCommentIds: addToSet(
          prev.repliedCommentIds,
          event.repliedCommentId,
        ),
      };
    }

    case "MAX_ROUNDS_REACHED": {
      // Idempotent: if already notified, return the same reference so the
      // poller's unconditional call doesn't trigger a needless disk write.
      // Guards against the #43 regression where the notification re-fired
      // every tick.
      if (prev.maxRoundsNotified) return prev;
      return {
        ...prev,
        maxRoundsNotified: true,
        failedAwaitingRetry: false,
        reReviewRequested: false,
      };
    }

    default: {
      // Exhaustiveness guard — a new event type must be handled here.
      const _: never = event;
      return _;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function addToSet(set: Set<number>, id: number): Set<number> {
  const next = new Set(set);
  next.add(id);
  return next;
}
