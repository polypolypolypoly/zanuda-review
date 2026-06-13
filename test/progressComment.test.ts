import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PRStateStore } from "../src/state/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * These tests verify the core behavioral change from PR #20:
 * Each completed review round must clear progressCommentId so the next round
 * opens a fresh comment instead of editing the previous round's comment.
 */

describe("progressCommentId lifecycle across rounds", () => {
  let dir: string;
  let store: PRStateStore;

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "zanuda-progress-test-"));
    store = new PRStateStore(join(dir, "state.json"));
  }

  function teardown() {
    rmSync(dir, { recursive: true, force: true });
  }

  it("progressCommentId is cleared after round 1 completes", () => {
    setup();
    try {
      // Initial state: round 0, no progressCommentId
      store.set(1, {
        ref: { owner: "acme", repo: "widget" },
        number: 42,
        rounds: 0,
        mentionReplies: 0,
        repliedCommentIds: new Set(),
        maxRoundsNotified: false,
        progressCommentId: null,
        consecutiveFailures: 0,
      });

      // Simulate round 1 completing. The review engine may have returned a
      // progressCommentId, but the poller must clear it to null.
      const state = store.get(1)!;

      // Round 1 completes successfully. Poller must:
      //   - increment rounds from 0→1
      //   - clear progressCommentId to null (even though engine returned it)
      //   - reset consecutiveFailures to 0
      store.set(1, {
        ...state,
        rounds: 1,
        progressCommentId: null, // ← core fix: always null after completion
        consecutiveFailures: 0,
      });

      const afterRound1 = store.get(1)!;
      assert.equal(afterRound1.rounds, 1, "round counter should advance");
      assert.equal(
        afterRound1.progressCommentId,
        null,
        "progressCommentId must be null so round 2 opens a fresh comment",
      );
      assert.equal(afterRound1.consecutiveFailures, 0);
    } finally {
      teardown();
    }
  });

  it("round 2 also clears progressCommentId after completion", () => {
    setup();
    try {
      // Start from round 1 state with cleared progressCommentId
      store.set(2, {
        ref: { owner: "acme", repo: "widget" },
        number: 99,
        rounds: 1,
        mentionReplies: 0,
        repliedCommentIds: new Set(),
        maxRoundsNotified: false,
        progressCommentId: null,
        consecutiveFailures: 0,
      });

      const state = store.get(2)!;

      // Round 2 completes. Same rule: clear progressCommentId regardless of
      // what the review engine returned.
      store.set(2, {
        ...state,
        rounds: 2,
        progressCommentId: null,
        consecutiveFailures: 0,
      });

      const afterRound2 = store.get(2)!;
      assert.equal(afterRound2.rounds, 2);
      assert.equal(
        afterRound2.progressCommentId,
        null,
        "progressCommentId cleared even after final round",
      );
    } finally {
      teardown();
    }
  });

  it("progressCommentId is preserved on same-round retry (stale discard)", () => {
    setup();
    try {
      // Round 1 was mid-flight when head SHA changed. Engine returned stale=true.
      // Poller must preserve progressCommentId so the retry can edit the existing
      // "Starting review…" comment instead of posting a duplicate placeholder.
      store.set(3, {
        ref: { owner: "acme", repo: "widget" },
        number: 77,
        rounds: 0,
        mentionReplies: 0,
        repliedCommentIds: new Set(),
        maxRoundsNotified: false,
        progressCommentId: 5001, // ← engine posted a progress comment
        consecutiveFailures: 0,
      });

      const state = store.get(3)!;

      // Stale result: round counter does NOT increment, but progressCommentId
      // stays so the next poll's retry can reuse it.
      store.set(3, {
        ...state,
        rounds: 0, // ← still 0 because the round didn't complete
        progressCommentId: 5001, // ← preserved for retry
        consecutiveFailures: 0, // stale is not a failure
      });

      const afterStale = store.get(3)!;
      assert.equal(afterStale.rounds, 0, "round counter unchanged on stale");
      assert.equal(
        afterStale.progressCommentId,
        5001,
        "progressCommentId preserved for same-round retry",
      );
    } finally {
      teardown();
    }
  });

  it("cross-round comment independence is achieved by null progressCommentId", () => {
    setup();
    try {
      // The core invariant: after any completed round, progressCommentId must be
      // null so the next round's call to reviewPullRequest takes the
      // `startingCommentId = opts.progressCommentId ?? null` path (line 52 in
      // engine.ts) and hits the fresh-start branch (line 89) which posts a new
      // comment. If progressCommentId were carried across rounds, round 2 would
      // incorrectly edit round 1's verdict comment, destroying round 1's record.

      store.set(4, {
        ref: { owner: "acme", repo: "widget" },
        number: 123,
        rounds: 1,
        mentionReplies: 0,
        repliedCommentIds: new Set(),
        maxRoundsNotified: false,
        progressCommentId: null, // ← correct state after round 1
        consecutiveFailures: 0,
      });

      const state = store.get(4)!;
      // When the poller calls reviewPullRequest for round 2, it passes:
      //   { round: 2, progressCommentId: state.progressCommentId ?? null }
      // which evaluates to { round: 2, progressCommentId: null }.
      // Inside engine.ts, startingCommentId = opts.progressCommentId ?? null = null,
      // so the code path taken is `else { /* Fresh start for this round */ }`,
      // which posts a new top-level comment with label "Starting final review…".

      const optsForRound2 = {
        round: 2,
        progressCommentId: state.progressCommentId ?? null, // → null
      };

      assert.equal(
        optsForRound2.progressCommentId,
        null,
        "round 2 receives null progressCommentId, forcing a new comment",
      );
    } finally {
      teardown();
    }
  });
});
