import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendEntry,
  formatReviewHistory,
  hasClassifiableComments,
  type ReviewHistory,
  type ReviewHistoryEntry,
} from "../src/context/reviewHistory.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

const emptyHistory: ReviewHistory = { entries: [] };

// ─── appendEntry ──────────────────────────────────────────────────────────────

describe("appendEntry", () => {
  it("appends to an empty history", () => {
    const entry = makeEntry(1);
    const result = appendEntry(emptyHistory, entry, 20);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.prNumber, 1);
  });

  it("appends to existing history", () => {
    const history: ReviewHistory = { entries: [makeEntry(1), makeEntry(2)] };
    const result = appendEntry(history, makeEntry(3), 20);
    assert.equal(result.entries.length, 3);
    assert.equal(result.entries[2]?.prNumber, 3);
  });

  it("prunes oldest entries when over the limit", () => {
    const history: ReviewHistory = {
      entries: [makeEntry(1), makeEntry(2), makeEntry(3)],
    };
    const result = appendEntry(history, makeEntry(4), 3);
    assert.equal(result.entries.length, 3);
    // Oldest (1) should be gone; newest (4) should be present
    assert.ok(!result.entries.some((e) => e.prNumber === 1));
    assert.equal(result.entries[2]?.prNumber, 4);
  });

  it("does not mutate the original history", () => {
    const history: ReviewHistory = { entries: [makeEntry(1)] };
    appendEntry(history, makeEntry(2), 20);
    assert.equal(history.entries.length, 1);
  });

  it("keeps exactly maxEntries after pruning", () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1));
    let history: ReviewHistory = { entries };
    history = appendEntry(history, makeEntry(11), 5);
    assert.equal(history.entries.length, 5);
    assert.equal(history.entries[0]?.prNumber, 7); // oldest kept
    assert.equal(history.entries[4]?.prNumber, 11); // newest
  });
});

// ─── hasClassifiableComments ──────────────────────────────────────────────────

describe("hasClassifiableComments", () => {
  it("returns true when discussion contains ZlayaZanuda inline comment", () => {
    const discussion =
      "**ZlayaZanuda** [`src/foo.ts:42`]:\nMissing null check.";
    assert.ok(hasClassifiableComments(discussion));
  });

  it("returns false when ZlayaZanuda has only general (non-inline) comments", () => {
    // General comments don't have [`path:line`] markers
    const discussion = "**ZlayaZanuda**:\nStarting review...";
    assert.ok(!hasClassifiableComments(discussion));
  });

  it("returns false when discussion has no ZlayaZanuda comments", () => {
    const discussion = "**alice** [`src/foo.ts:10`]:\nLooks good!";
    assert.ok(!hasClassifiableComments(discussion));
  });

  it("returns false for empty discussion", () => {
    assert.ok(!hasClassifiableComments("(No discussion found.)"));
  });
});

// ─── formatReviewHistory ──────────────────────────────────────────────────────

describe("formatReviewHistory", () => {
  it("returns empty string for empty history", () => {
    assert.equal(formatReviewHistory(emptyHistory), "");
  });

  it("includes PR number and title", () => {
    const history: ReviewHistory = {
      entries: [makeEntry(42, { prTitle: "feat: add button" })],
    };
    const text = formatReviewHistory(history);
    assert.ok(text.includes("PR #42"));
    assert.ok(text.includes("feat: add button"));
  });

  it("includes the final action with icon", () => {
    const history: ReviewHistory = {
      entries: [makeEntry(1, { finalAction: "APPROVE" })],
    };
    assert.ok(formatReviewHistory(history).includes("✅"));

    const history2: ReviewHistory = {
      entries: [makeEntry(1, { finalAction: "REQUEST_CHANGES" })],
    };
    assert.ok(formatReviewHistory(history2).includes("🛑"));
  });

  it("shows '(no inline comments)' for entries with empty outcomes", () => {
    const history: ReviewHistory = { entries: [makeEntry(1)] };
    assert.ok(formatReviewHistory(history).includes("no inline comments"));
  });

  it("renders outcomes with path, severity, summary, and status", () => {
    const history: ReviewHistory = {
      entries: [
        makeEntry(5, {
          outcomes: [
            {
              path: "src/auth.ts",
              line: 15,
              severity: "blocker",
              summary: "SQL injection via unsanitised input",
              outcome: "addressed",
            },
          ],
        }),
      ],
    };
    const text = formatReviewHistory(history);
    assert.ok(text.includes("src/auth.ts:15"));
    assert.ok(text.includes("blocker"));
    assert.ok(text.includes("SQL injection"));
    assert.ok(text.includes("fixed"));
  });

  it("renders dismissal reason for dismissed outcomes", () => {
    const history: ReviewHistory = {
      entries: [
        makeEntry(7, {
          outcomes: [
            {
              path: "bot/worker.py",
              line: 50,
              severity: "warning",
              summary: "bare except clause",
              outcome: "dismissed",
              dismissalReason: "intentional to prevent supervisor crash",
            },
          ],
        }),
      ],
    };
    const text = formatReviewHistory(history);
    assert.ok(text.includes("dismissed"));
    assert.ok(text.includes("intentional to prevent supervisor crash"));
  });

  it("shows most recent entries first (reversed order)", () => {
    const history: ReviewHistory = {
      entries: [makeEntry(1), makeEntry(2), makeEntry(3)],
    };
    const text = formatReviewHistory(history);
    const idx1 = text.indexOf("PR #1");
    const idx3 = text.indexOf("PR #3");
    assert.ok(idx3 < idx1, "most recent (PR #3) should appear before PR #1");
  });

  it("respects maxEntries limit", () => {
    const history: ReviewHistory = {
      entries: Array.from({ length: 15 }, (_, i) => makeEntry(i + 1)),
    };
    const text = formatReviewHistory(history, 3);
    // Should show last 3: PR #13, #14, #15
    assert.ok(text.includes("PR #15"));
    assert.ok(text.includes("PR #14"));
    assert.ok(text.includes("PR #13"));
    assert.ok(!text.includes("PR #12"));
    assert.ok(text.includes("last 3 reviews"));
  });

  it("renders 'last 1 review' (singular) correctly", () => {
    const history: ReviewHistory = { entries: [makeEntry(1)] };
    assert.ok(formatReviewHistory(history).includes("last 1 review"));
    assert.ok(!formatReviewHistory(history).includes("last 1 reviews"));
  });

  it("renders outcome without line number when line is absent", () => {
    const history: ReviewHistory = {
      entries: [
        makeEntry(3, {
          outcomes: [
            {
              path: "src/foo.ts",
              severity: "warning",
              summary: "missing type annotation",
              outcome: "ignored",
              // no line
            },
          ],
        }),
      ],
    };
    const text = formatReviewHistory(history);
    // Path should appear without a colon-number suffix
    assert.ok(text.includes("`src/foo.ts`"));
    assert.ok(!text.includes("src/foo.ts:"));
  });
});

// ─── buildUserPrompt: reviewHistory injection ─────────────────────────────────

import { buildUserPrompt } from "../src/review/prompt.ts";
import type { Config } from "../src/config.ts";
import type { PullRequestData } from "../src/github/pullRequest.ts";
import type { ProjectContext } from "../src/context/builder.ts";

const baseConfig: Config = {
  provider: "anthropic",
  models: { anthropic: "a", openai: "b", openrouter: "c", ollama: "d" },
  generation: { temperature: 0.2, maxTokens: 4096 },
  preprompt: "Base preprompt.",
  persistence: { stateFile: "" },
  access: { allowlist: [] },
  limits: { maxConcurrentReviews: 3, maxNewPrsPerCycle: 5 },
  memory: {
    enabled: true,
    dir: "",
    updateAfterReview: true,
    maxHistoryEntries: 20,
  },
  context: {
    includeFiles: ["README.md"],
    maxFileChars: 1000,
    includeFileTree: true,
    maxTreeEntries: 100,
  },
  review: { maxDiffChars: 10000, inlineComments: true },
};

const makePR = (): PullRequestData => ({
  ref: { owner: "acme", repo: "widget" },
  number: 1,
  title: "feat: add button",
  body: "adds a button",
  baseSha: "abc",
  headSha: "def",
  diff: "@@ -1 +1 @@\n-old\n+new",
  changedFiles: ["src/button.ts"],
  files: [],
  state: "open",
});

const makeContext = (): ProjectContext => ({ text: "(no context)" });

describe("buildUserPrompt: reviewHistory injection", () => {
  it("injects review history when provided", () => {
    const prompt = buildUserPrompt(makePR(), makeContext(), baseConfig, {
      reviewHistory: "## Review history\n\n**PR #1** — APPROVE",
    });
    assert.ok(prompt.includes("## Review history"));
    assert.ok(prompt.includes("PR #1"));
  });

  it("omitted when reviewHistory is not provided", () => {
    const prompt = buildUserPrompt(makePR(), makeContext(), baseConfig, {});
    assert.ok(!prompt.includes("## Review history"));
  });

  it("appears after repo memory and before instructions", () => {
    const prompt = buildUserPrompt(makePR(), makeContext(), baseConfig, {
      repoMemory: "## Architecture\nsome memory",
      reviewHistory: "## Review history\npast data",
      instructions: "Follow these rules.",
    });
    const memIdx = prompt.indexOf("<repo_memory>");
    const histIdx = prompt.indexOf("## Review history");
    const instrIdx = prompt.indexOf("Follow these rules.");
    assert.ok(memIdx < histIdx, "history should come after repo memory");
    assert.ok(histIdx < instrIdx, "history should come before instructions");
  });

  it("is not XML-sandboxed", () => {
    const historyText = "## Review history\nsome trusted data";
    const prompt = buildUserPrompt(makePR(), makeContext(), baseConfig, {
      reviewHistory: historyText,
    });
    // Should not be wrapped in any XML tags
    const idx = prompt.indexOf("## Review history");
    const before = prompt.slice(Math.max(0, idx - 5), idx);
    assert.ok(!before.includes("<"), "history should not be XML-sandboxed");
  });
});
