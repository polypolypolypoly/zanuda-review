import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterReviewComments,
  filterReviewVerdict,
  truncateReviewSummary,
  formatFilterSummary,
} from "../src/review/filters.js";
import type { ReviewComment, ReviewResult } from "../src/review/types.js";

function makeComment(
  overrides: Partial<ReviewComment> & { path?: string; line?: number } = {},
): ReviewComment {
  return {
    path: overrides.path ?? "src/foo.ts",
    line: overrides.line ?? 42,
    severity: overrides.severity ?? "warning",
    body:
      overrides.body ??
      "This is a legitimate review comment with enough chars.",
    suggestion: overrides.suggestion,
  };
}

const MAX_CHARS = 400;

// ── Filter 1: minimum body length ────────────────────────────────────────────

describe("minBodyLength filter", () => {
  it("drops single-word body ('Test')", () => {
    const result = filterReviewComments([makeComment({ body: "Test" })], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept.length, 0);
    assert.equal(result.dropped.length, 1);
    assert.match(result.dropped[0].reason, /too short/);
  });

  it("drops empty body", () => {
    const result = filterReviewComments([makeComment({ body: "" })], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept.length, 0);
    assert.equal(result.dropped.length, 1);
  });

  it("drops body that is only markdown formatting", () => {
    const result = filterReviewComments([makeComment({ body: "**`x`**" })], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept.length, 0);
  });

  it("keeps short body when suggestion is present", () => {
    const result = filterReviewComments(
      [
        makeComment({
          body: "Fix",
          suggestion: "return items.filter(Boolean);",
        }),
      ],
      { maxCommentChars: MAX_CHARS },
    );
    assert.equal(result.kept.length, 1);
    assert.equal(result.dropped.length, 0);
  });

  it("keeps body with 15+ meaningful chars", () => {
    const result = filterReviewComments(
      [makeComment({ body: "This is null-unsafe" })],
      { maxCommentChars: MAX_CHARS },
    );
    assert.equal(result.kept.length, 1);
  });

  it("counts markdown-stripped length, not raw", () => {
    const result = filterReviewComments([makeComment({ body: "**bold**" })], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept.length, 0);
  });
});

// ── Filter 2: self-debate / stream-of-consciousness ──────────────────────────

describe("selfDebate filter", () => {
  it("drops comment that self-corrects and concludes it's fine", () => {
    const comment = makeComment({
      body: "This looks broken. No — the guard is actually on line 42, so it's fine. Handled correctly.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept.length, 0);
    assert.equal(result.dropped.length, 1);
    assert.match(result.dropped[0].reason, /self-debate/);
  });

  it("drops comment where model confirms code is correct (no leak)", () => {
    const comment = makeComment({
      body: "The timer is cleared and the error handler guards on `resolved`. No leak. Minor: the status code is whatever was captured, which is fine.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept.length, 0);
    assert.equal(result.dropped.length, 1);
    assert.match(result.dropped[0].reason, /self-debate/);
  });

  it("drops comment saying 'which is fine' with debate marker", () => {
    const comment = makeComment({
      body: "The timeout fires, but No — it resolves fine, which is fine.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept.length, 0);
  });

  it("drops comment saying 'that's acceptable'", () => {
    const comment = makeComment({
      body: "This approach has some overhead. That's acceptable for now.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept.length, 0);
  });

  it("keeps normal review comment without self-debate markers", () => {
    const comment = makeComment({
      body: "The API key is not validated before use. Add a check for empty string.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept.length, 1);
    assert.equal(result.dropped.length, 0);
  });

  it("keeps comment with self-debate phrasing but NO confirmation (still a finding)", () => {
    // Has "No —" but doesn't conclude it's fine — the "No" transitions to a
    // different problem, not to a dismissal.
    const comment = makeComment({
      body: "The retry loop looks correct for 2xx. No — it also handles 4xx incorrectly by treating them as retryable.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept.length, 1);
    assert.equal(result.dropped.length, 0);
  });
});

// ── Filter 3: speculative blocker downgrade (MUTATE — always keeps) ──────────

describe("speculativeBlocker filter", () => {
  it("downgrades blocker using 'practically impossible'", () => {
    const comment = makeComment({
      severity: "blocker",
      body: "Combined with clock skew, this is practically impossible to trigger but technically a bug.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept.length, 1);
    assert.equal(result.dropped.length, 0);
    assert.equal(result.mutated.length, 1);
    assert.equal(result.kept[0].severity, "warning");
    assert.match(result.mutated[0].reason, /blocker→warning/);
  });

  it("downgrades blocker using 'in theory'", () => {
    const comment = makeComment({
      severity: "blocker",
      body: "In theory this could cause a race condition if two requests overlap.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept[0].severity, "warning");
  });

  it("does NOT downgrade concrete blocker without speculative language", () => {
    const comment = makeComment({
      severity: "blocker",
      body: "This will crash when the API returns null. Add a null check.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept[0].severity, "blocker");
    assert.equal(result.mutated.length, 0);
  });

  it("does NOT touch warnings (only downgrades blockers)", () => {
    const comment = makeComment({
      severity: "warning",
      body: "In theory this could be an issue but it's extremely rare.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: MAX_CHARS,
    });
    assert.equal(result.kept[0].severity, "warning");
    assert.equal(result.mutated.length, 0);
  });
});

// ── Filter 4: max body length (MUTATE — always keeps) ────────────────────────

describe("maxBodyLength filter", () => {
  it("truncates body exceeding maxCommentChars", () => {
    const longBody = "x".repeat(500);
    const comment = makeComment({ body: longBody });
    const result = filterReviewComments([comment], {
      maxCommentChars: 200,
    });
    assert.equal(result.kept.length, 1);
    assert.equal(result.mutated.length, 1);
    assert.ok(result.kept[0].body.length <= 201);
    assert.ok(result.kept[0].body.endsWith("…"));
    assert.match(result.mutated[0].reason, /truncated/);
  });

  it("does NOT truncate body within limit", () => {
    const comment = makeComment({
      body: "This body is within the character limit.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: 400,
    });
    assert.equal(
      result.kept[0].body,
      "This body is within the character limit.",
    );
    assert.equal(result.mutated.length, 0);
  });

  it("handles body with no word boundary before limit", () => {
    const longBody = "a".repeat(500);
    const comment = makeComment({ body: longBody });
    const result = filterReviewComments([comment], {
      maxCommentChars: 10,
    });
    assert.equal(result.kept.length, 1);
    assert.ok(result.kept[0].body.endsWith("…"));
  });
});

// ── Multiple filters combined ─────────────────────────────────────────────────

describe("combined filters", () => {
  it("applies both drop and mutate filters to a batch", () => {
    const comments: ReviewComment[] = [
      makeComment({ body: "ok" }), // too short → drop
      makeComment({
        body: "This seems wrong. No — it's handled correctly and so it's fine.",
      }), // self-debate + confirmation → drop
      makeComment({
        severity: "blocker",
        body: "In theory this could leak memory under extreme load.",
      }), // speculative → downgrade to warning (mutate)
      makeComment({
        body: "The null check on line 42 is missing — add a guard.",
      }), // fine
    ];

    const result = filterReviewComments(comments, {
      maxCommentChars: 400,
    });

    assert.equal(result.kept.length, 2); // speculative (downgraded) + fine
    assert.equal(result.dropped.length, 2); // too short + self-debate
    assert.equal(result.mutated.length, 1); // speculative downgrade

    // Verify the downgrade
    const downgraded = result.kept.find((c) => c.severity === "warning");
    assert.ok(
      downgraded,
      "speculative comment should be downgraded to warning",
    );
  });

  it("handles empty comment array", () => {
    const result = filterReviewComments([], { maxCommentChars: 400 });
    assert.equal(result.kept.length, 0);
    assert.equal(result.dropped.length, 0);
    assert.equal(result.mutated.length, 0);
  });
});

// ── formatFilterSummary ───────────────────────────────────────────────────────

describe("formatFilterSummary", () => {
  it("returns empty string when no drops or mutations", () => {
    const result = filterReviewComments(
      [
        makeComment({
          body: "Valid comment with enough text to pass all filters.",
        }),
      ],
      { maxCommentChars: 400 },
    );
    assert.equal(formatFilterSummary(result), "");
  });

  it("formats dropped comments with path, line, and reason", () => {
    const result = filterReviewComments(
      [makeComment({ path: "src/bar.ts", line: 10, body: "x" })],
      { maxCommentChars: 400 },
    );
    const summary = formatFilterSummary(result);
    assert.match(summary, /src\/bar\.ts:10/);
    assert.match(summary, /too short/);
  });

  it("formats mutated comments separately from dropped", () => {
    const comment = makeComment({
      severity: "blocker",
      body: "In theory this could deadlock under very specific timing.",
    });
    const result = filterReviewComments([comment], {
      maxCommentChars: 400,
    });
    const summary = formatFilterSummary(result);
    assert.match(summary, /mutated/);
    assert.match(summary, /blocker→warning/);
    assert.ok(!summary.includes("dropped"), "should not mention dropped");
  });

  it("formats both dropped and mutated in same summary", () => {
    const comments: ReviewComment[] = [
      makeComment({ body: "x" }), // too short
      makeComment({
        severity: "blocker",
        body: "In theory this could cause issues.",
      }),
    ];
    const result = filterReviewComments(comments, {
      maxCommentChars: 400,
    });
    const summary = formatFilterSummary(result);
    assert.match(summary, /dropped/);
    assert.match(summary, /mutated/);
  });
});

// ── filterReviewVerdict ──────────────────────────────────────────────────────

describe("filterReviewVerdict", () => {
  function makeResult(
    action: ReviewResult["action"],
    comments: ReviewComment[],
  ): ReviewResult {
    return {
      prSummary: "",
      summary: "Test summary.",
      action,
      filesSummary: [],
      comments,
    };
  }

  function blocker(path: string, line: number): ReviewComment {
    return {
      path,
      line,
      severity: "blocker",
      body: "This will crash on null input. Add a null check.",
    };
  }

  function warn(path: string, line: number): ReviewComment {
    return {
      path,
      line,
      severity: "warning",
      body: "Consider adding a timeout here for resilience.",
    };
  }

  it("returns null for APPROVE (no change needed)", () => {
    const r = makeResult("APPROVE", []);
    assert.equal(filterReviewVerdict(r), null);
    assert.equal(r.action, "APPROVE");
  });

  it("returns null for COMMENT (no change needed)", () => {
    const r = makeResult("COMMENT", []);
    assert.equal(filterReviewVerdict(r), null);
    assert.equal(r.action, "COMMENT");
  });

  it("downgrades REQUEST_CHANGES with zero inline comments to COMMENT", () => {
    const r = makeResult("REQUEST_CHANGES", []);
    const reason = filterReviewVerdict(r);
    assert.ok(reason);
    assert.match(reason!, /zero inline/);
    assert.equal(r.action, "COMMENT");
  });

  it("downgrades REQUEST_CHANGES with only warnings to COMMENT", () => {
    const r = makeResult("REQUEST_CHANGES", [warn("a.ts", 1), warn("b.ts", 2)]);
    const reason = filterReviewVerdict(r);
    assert.ok(reason);
    assert.match(reason!, /no blocker/);
    assert.equal(r.action, "COMMENT");
  });

  it("keeps REQUEST_CHANGES when at least one blocker exists", () => {
    const r = makeResult("REQUEST_CHANGES", [
      warn("a.ts", 1),
      blocker("b.ts", 2),
    ]);
    assert.equal(filterReviewVerdict(r), null);
    assert.equal(r.action, "REQUEST_CHANGES");
  });

  it("keeps REQUEST_CHANGES with a single blocker", () => {
    const r = makeResult("REQUEST_CHANGES", [blocker("a.ts", 1)]);
    assert.equal(filterReviewVerdict(r), null);
    assert.equal(r.action, "REQUEST_CHANGES");
  });
});

// ── truncateReviewSummary ────────────────────────────────────────────────────

describe("truncateReviewSummary", () => {
  function makeResult(prSummary: string, summary: string): ReviewResult {
    return {
      prSummary,
      summary,
      action: "COMMENT",
      filesSummary: [],
      comments: [],
    };
  }

  it("returns null when both fields are within limits", () => {
    const r = makeResult("Short.", "Also short.");
    assert.equal(truncateReviewSummary(r), null);
  });

  it("truncates prSummary > 200 chars", () => {
    const long = "A".repeat(250);
    const r = makeResult(long, "ok");
    const reason = truncateReviewSummary(r);
    assert.ok(reason);
    assert.match(reason!, /prSummary truncated/);
    assert.ok(r.prSummary.length <= 201); // 200 + "…"
    assert.ok(r.prSummary.endsWith("…"));
    assert.equal(r.summary, "ok"); // unchanged
  });

  it("truncates summary > 400 chars", () => {
    const long = "B".repeat(500);
    const r = makeResult("short", long);
    const reason = truncateReviewSummary(r);
    assert.ok(reason);
    assert.match(reason!, /summary truncated/);
    assert.ok(r.summary.length <= 401);
    assert.ok(r.summary.endsWith("…"));
    assert.equal(r.prSummary, "short"); // unchanged
  });

  it("truncates both when both exceed limits", () => {
    const r = makeResult("A".repeat(300), "B".repeat(500));
    const reason = truncateReviewSummary(r);
    assert.ok(reason);
    assert.match(reason!, /prSummary truncated/);
    assert.match(reason!, /summary truncated/);
  });
});
