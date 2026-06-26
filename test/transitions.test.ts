import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyEvent,
  freshState,
  type PRStateEvent,
} from "../src/state/transitions.js";
import type { PRState } from "../src/state/store.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const REF = { owner: "acme", repo: "widget" };
const NUM = 42;

function state(overrides: Partial<PRState> = {}): PRState {
  return { ...freshState(REF, NUM), ...overrides };
}

// ── ROUND_COMPLETED ──────────────────────────────────────────────────────────

describe("applyEvent: ROUND_COMPLETED", () => {
  it("advances rounds", () => {
    const s = applyEvent(state({ rounds: 0 }), {
      type: "ROUND_COMPLETED",
      round: 1,
    });
    assert.equal(s.rounds, 1);
  });

  it("clears failedAwaitingRetry and consumes reReviewRequested", () => {
    // The #68 concern: the mention-driven re-review flag must be consumed
    // exactly once by the round it triggers, so a single @re-review can't
    // re-fire round 2 on every subsequent tick.
    const s = applyEvent(
      state({
        rounds: 1,
        failedAwaitingRetry: true,
        reReviewRequested: true,
        consecutiveFailures: 3,
        progressCommentId: 99,
      }),
      { type: "ROUND_COMPLETED", round: 2 },
    );
    assert.equal(s.failedAwaitingRetry, false);
    assert.equal(s.reReviewRequested, false);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.progressCommentId, null);
    assert.equal(s.rounds, 2);
  });

  it("latches maxRoundsNotified when the final round completes", () => {
    const s = applyEvent(state({ rounds: 1, maxRoundsNotified: false }), {
      type: "ROUND_COMPLETED",
      round: 2,
    });
    assert.equal(s.maxRoundsNotified, true);
  });

  it("does not unlatch maxRoundsNotified on an earlier round", () => {
    const s = applyEvent(state({ rounds: 0, maxRoundsNotified: false }), {
      type: "ROUND_COMPLETED",
      round: 1,
    });
    assert.equal(s.maxRoundsNotified, false);
  });

  it("is the only event that advances rounds", () => {
    const before = state({ rounds: 1 });
    const nonAdvancing: PRStateEvent[] = [
      { type: "ROUND_FAILED" },
      { type: "RETRY_REQUESTED", repliedCommentId: 1 },
      { type: "RE_REVIEW_REQUESTED", repliedCommentId: 2 },
      { type: "MENTION_REPLIED", repliedCommentId: 3 },
      { type: "MAX_ROUNDS_REACHED" },
      { type: "ROUND_STALE", progressCommentId: null },
    ];
    for (const e of nonAdvancing) {
      assert.equal(
        applyEvent(before, e).rounds,
        1,
        `${e.type} must not advance rounds`,
      );
    }
  });
});

// ── ROUND_STALE ──────────────────────────────────────────────────────────────

describe("applyEvent: ROUND_STALE", () => {
  it("does NOT advance rounds (next poll re-reviews the new HEAD)", () => {
    const s = applyEvent(state({ rounds: 1 }), {
      type: "ROUND_STALE",
      progressCommentId: null,
    });
    assert.equal(s.rounds, 1);
  });

  it("preserves an in-flight progressCommentId for the retry", () => {
    const s = applyEvent(state({ rounds: 1, progressCommentId: null }), {
      type: "ROUND_STALE",
      progressCommentId: 77,
    });
    assert.equal(s.progressCommentId, 77);
  });

  it("clears failedAwaitingRetry (stale is not a failure)", () => {
    const s = applyEvent(state({ failedAwaitingRetry: true }), {
      type: "ROUND_STALE",
      progressCommentId: null,
    });
    assert.equal(s.failedAwaitingRetry, false);
  });

  it("preserves reReviewRequested so a stale round-2 retry still re-fires", () => {
    // A stale discard is not a completion — the mention-driven re-review
    // request must survive so the next poll still proceeds to round 2.
    const s = applyEvent(state({ rounds: 1, reReviewRequested: true }), {
      type: "ROUND_STALE",
      progressCommentId: null,
    });
    assert.equal(s.reReviewRequested, true);
    assert.equal(s.rounds, 1);
  });
});

// ── ROUND_FAILED ─────────────────────────────────────────────────────────────

describe("applyEvent: ROUND_FAILED", () => {
  it("sets failedAwaitingRetry and bumps consecutiveFailures", () => {
    const s = applyEvent(state({ rounds: 1, consecutiveFailures: 0 }), {
      type: "ROUND_FAILED",
    });
    assert.equal(s.failedAwaitingRetry, true);
    assert.equal(s.consecutiveFailures, 1);
  });

  it("never mutates rounds (a failure is not a completed round)", () => {
    const s = applyEvent(state({ rounds: 1, reReviewRequested: true }), {
      type: "ROUND_FAILED",
    });
    assert.equal(s.rounds, 1);
    // A failure must NOT consume the re-review request — the retry should
    // still proceed to round 2 when retried.
    assert.equal(s.reReviewRequested, true);
  });

  it("nulls progressCommentId so the placeholder can be edited to the error", () => {
    const s = applyEvent(state({ progressCommentId: 5 }), {
      type: "ROUND_FAILED",
    });
    assert.equal(s.progressCommentId, null);
  });
});

// ── RETRY_REQUESTED ─────────────────────────────────────────────────────────

describe("applyEvent: RETRY_REQUESTED", () => {
  it("clears the failure gate and resets the failure streak", () => {
    const s = applyEvent(
      state({ failedAwaitingRetry: true, consecutiveFailures: 4, rounds: 1 }),
      { type: "RETRY_REQUESTED", repliedCommentId: 10 },
    );
    assert.equal(s.failedAwaitingRetry, false);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.rounds, 1, "rounds untouched — retry resumes, not restarts");
  });

  it("records the replied comment id", () => {
    const s = applyEvent(state(), {
      type: "RETRY_REQUESTED",
      repliedCommentId: 11,
    });
    assert.ok(s.repliedCommentIds.has(11));
  });
});

// ── RE_REVIEW_REQUESTED ─────────────────────────────────────────────────────

describe("applyEvent: RE_REVIEW_REQUESTED", () => {
  it("sets the flag without touching rounds", () => {
    const s = applyEvent(state({ rounds: 1, reReviewRequested: false }), {
      type: "RE_REVIEW_REQUESTED",
      repliedCommentId: 20,
    });
    assert.equal(s.reReviewRequested, true);
    assert.equal(s.rounds, 1);
  });

  it("is idempotent (two mentions ≡ one)", () => {
    let s = state({ rounds: 1 });
    s = applyEvent(s, { type: "RE_REVIEW_REQUESTED", repliedCommentId: 20 });
    s = applyEvent(s, { type: "RE_REVIEW_REQUESTED", repliedCommentId: 21 });
    assert.equal(s.reReviewRequested, true);
    assert.deepEqual([...s.repliedCommentIds].sort(), [20, 21]);
  });
});

// ── MENTION_REPLIED ──────────────────────────────────────────────────────────

describe("applyEvent: MENTION_REPLIED", () => {
  it("bumps mentionReplies and records the replied id", () => {
    const s = applyEvent(state({ mentionReplies: 2 }), {
      type: "MENTION_REPLIED",
      repliedCommentId: 30,
    });
    assert.equal(s.mentionReplies, 3);
    assert.ok(s.repliedCommentIds.has(30));
  });
});

// ── MAX_ROUNDS_REACHED ───────────────────────────────────────────────────────

describe("applyEvent: MAX_ROUNDS_REACHED", () => {
  it("latches the notified flag", () => {
    const s = applyEvent(state({ maxRoundsNotified: false }), {
      type: "MAX_ROUNDS_REACHED",
    });
    assert.equal(s.maxRoundsNotified, true);
  });

  it("is idempotent — the #43 regression: re-firing every tick is a no-op", () => {
    const already = state({ maxRoundsNotified: true, rounds: 2 });
    const s = applyEvent(already, { type: "MAX_ROUNDS_REACHED" });
    assert.equal(s.maxRoundsNotified, true);
    // No fields change when already notified — the poller can call this
    // unconditionally without spamming disk writes or re-posting the notice.
    assert.equal(s.rounds, 2);
    assert.equal(s.failedAwaitingRetry, false);
    assert.equal(s.reReviewRequested, false);
  });
});

// ── freshState ───────────────────────────────────────────────────────────────

describe("freshState", () => {
  it("starts at rounds 0 with all gates closed", () => {
    const s = freshState(REF, NUM);
    assert.equal(s.rounds, 0);
    assert.equal(s.failedAwaitingRetry, false);
    assert.equal(s.reReviewRequested, false);
    assert.equal(s.maxRoundsNotified, false);
    assert.equal(s.progressCommentId, null);
    assert.equal(s.mentionReplies, 0);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.repliedCommentIds.size, 0);
  });
});
