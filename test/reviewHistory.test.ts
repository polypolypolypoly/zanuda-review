import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendEntry,
  formatReviewHistory,
  hasClassifiableComments,
  type ReviewHistory,
  type ReviewHistoryEntry,
} from "../src/context/reviewHistory.js";

const makeEntry = (
  prNumber: number,
  overrides: Partial<ReviewHistoryEntry> = {},
): ReviewHistoryEntry => ({
  prNumber,
  prTitle: `PR title ${prNumber}`,
  date: `2026-06-${String(prNumber).padStart(2, "0")}`,
  finalAction: "APPROVE",
  outcomes: [],
  ...overrides,
});

// ─── appendEntry ──────────────────────────────────────────────────────────────

describe("appendEntry", () => {
  it("appends, prunes oldest over limit, does not mutate original", () => {
    const history: ReviewHistory = { entries: [makeEntry(1), makeEntry(2)] };
    const result = appendEntry(history, makeEntry(3), 2);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0]!.prNumber, 2); // oldest pruned
    assert.equal(result.entries[1]!.prNumber, 3); // newest kept
    assert.equal(history.entries.length, 2); // original untouched
  });

  it("keeps exactly maxEntries", () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1));
    const result = appendEntry({ entries }, makeEntry(11), 5);
    assert.equal(result.entries.length, 5);
    assert.equal(result.entries[0]!.prNumber, 7);
    assert.equal(result.entries[4]!.prNumber, 11);
  });
});

// ─── hasClassifiableComments ──────────────────────────────────────────────────

describe("hasClassifiableComments", () => {
  it("detects ZlayaZanuda inline comments vs general/empty", () => {
    assert.ok(
      hasClassifiableComments(
        "**ZlayaZanuda** [`src/foo.ts:42`]:\nMissing null check.",
      ),
    );
    assert.ok(!hasClassifiableComments("**ZlayaZanuda**:\nStarting review..."));
    assert.ok(
      !hasClassifiableComments("**alice** [`src/foo.ts:10`]:\nLooks good!"),
    );
  });
});

// ─── formatReviewHistory ──────────────────────────────────────────────────────

describe("formatReviewHistory", () => {
  it("renders PR entries with outcomes, respects maxEntries and order", () => {
    const history: ReviewHistory = {
      entries: [
        makeEntry(1, {
          outcomes: [
            {
              path: "src/auth.ts",
              line: 15,
              severity: "blocker",
              summary: "SQL injection",
              outcome: "addressed",
            },
          ],
        }),
        makeEntry(2, {
          finalAction: "REQUEST_CHANGES",
          outcomes: [
            {
              path: "src/api.ts",
              line: 30,
              severity: "warning",
              summary: "missing rate limit",
              outcome: "dismissed",
              dismissalReason: "rate limit handled by gateway",
            },
          ],
        }),
      ],
    };

    const text = formatReviewHistory(history);
    assert.ok(text.includes("PR #1"));
    assert.ok(text.includes("SQL injection"));
    assert.ok(text.includes("fixed"));
    assert.ok(text.includes("PR #2"));
    assert.ok(text.includes("dismissed"));
    assert.ok(text.includes("gateway"));
    // Most recent first
    assert.ok(text.indexOf("PR #2") < text.indexOf("PR #1"));
  });

  it("returns empty string for empty history", () => {
    assert.equal(formatReviewHistory({ entries: [] }), "");
  });
});
