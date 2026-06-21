/**
 * Hard (non-LLM) output filters that run on review comments after parsing
 * but before posting to GitHub. The model can drift — these catch it.
 *
 * Filters operate in two phases:
 *   1. DROP filters — remove the comment entirely
 *   2. MUTATE filters — modify the comment but keep it
 *
 * Dropped and mutated comments are logged at warn level so incidents
 * are debuggable.
 */

import type { ReviewComment, ReviewResult } from "./types.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface DroppedComment {
  path: string;
  line: number;
  body: string;
  reason: string;
}

export interface MutatedComment {
  path: string;
  line: number;
  reason: string;
}

export interface FilteredComments {
  kept: ReviewComment[];
  dropped: DroppedComment[];
  mutated: MutatedComment[];
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function filterReviewComments(
  comments: ReviewComment[],
  opts: { maxCommentChars: number },
): FilteredComments {
  const dropped: DroppedComment[] = [];
  const mutated: MutatedComment[] = [];
  const kept: ReviewComment[] = [];

  for (const c of comments) {
    // Phase 1: drop filters — any hit removes the comment.
    const dropReason = applyDropFilters(c);
    if (dropReason !== null) {
      dropped.push({
        path: c.path,
        line: c.line,
        body: c.body,
        reason: dropReason,
      });
      continue;
    }

    // Phase 2: mutate filters — modify in place but always keep.
    const mutateReason = applyMutateFilters(c, opts.maxCommentChars);
    if (mutateReason !== null) {
      mutated.push({ path: c.path, line: c.line, reason: mutateReason });
    }

    kept.push(c);
  }

  return { kept, dropped, mutated };
}

// ── Phase 1: drop filters ─────────────────────────────────────────────────────

function applyDropFilters(comment: ReviewComment): string | null {
  // Order: cheapest first.
  const r = minBodyLength(comment);
  if (r !== null) return r;

  return selfDebate(comment);
}

// ── Phase 2: mutate filters ───────────────────────────────────────────────────

function applyMutateFilters(
  comment: ReviewComment,
  maxChars: number,
): string | null {
  const reasons: string[] = [];

  const r1 = speculativeBlocker(comment);
  if (r1 !== null) reasons.push(r1);

  const r2 = maxBodyLength(comment, maxChars);
  if (r2 !== null) reasons.push(r2);

  return reasons.length > 0 ? reasons.join("; ") : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DROP FILTERS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Filter: minimum body length ───────────────────────────────────────────────
//
// Catches: "Test", empty strings, single-word garbage.
// A comment shorter than MIN_BODY_CHARS (after stripping markdown syntax)
// is almost certainly noise. Exception: comments with a concrete code
// suggestion are kept — the suggestion carries the signal even if the
// verbal framing is terse.

const MIN_BODY_CHARS = 15;

/** Strip common markdown syntax to reveal the underlying text. */
function stripMarkdown(s: string): string {
  return s
    .replace(/[*_~`#]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*>]\s*/gm, "")
    .trim();
}

function minBodyLength(comment: ReviewComment): string | null {
  if (comment.suggestion && comment.suggestion.length > 0) return null;

  const stripped = stripMarkdown(comment.body);
  if (stripped.length < MIN_BODY_CHARS) {
    return `body too short (${stripped.length} < ${MIN_BODY_CHARS} chars after stripping markdown)`;
  }

  return null;
}

// ── Filter: self-debate / stream-of-consciousness ─────────────────────────────
//
// Catches: comments where the model reasons aloud instead of stating a finding.
// Strategy: if the comment contains self-debate markers (the model arguing
// with itself) AND confirmation language (concluding the code is fine), drop
// it. If it only has debate markers without a "verdict of fine", keep it —
// the awkward phrasing might still wrap a real issue.

const SELF_DEBATE_PATTERNS = [
  /\bNo\s*[—–-]\b/, // "No — this is actually fine"
  /\bThat['’]s acceptable\b/i,
  /\bwhich is fine\b/i,
  /\bhandled correctly\b/i,
];

const CONFIRMATION_PATTERNS = [
  /\bno leak\b/i,
  /\b(?:it|that|this)['’]?\s*(?:is|was|seems)\s*fine\b/i,
  /\bso\s+it['’]s\s*fine\b/i,
  /\bwhich is fine\b/i,
  /\bhandled correctly\b/i,
  /\bcorrectly resolved\b/i,
  /\bthis is safe\b/i,
  /\bthat['’]s acceptable\b/i,
  /\bno regression\b/i,
  /\bnot a (?:bug|problem|issue)\b/i,
  /\bno (?:harm|damage|danger)\b/i,
];

function selfDebate(comment: ReviewComment): string | null {
  const hasDebate = SELF_DEBATE_PATTERNS.some((p) => p.test(comment.body));
  if (!hasDebate) return null;

  // If the comment also contains confirmation language ("it's fine"),
  // the net message is "this is fine" — not a finding. Drop it.
  const hasConfirmation = CONFIRMATION_PATTERNS.some((p) =>
    p.test(comment.body),
  );
  if (hasConfirmation) {
    return "self-debate with confirmation (net message: code is fine)";
  }

  // Self-debate markers without confirmation — the comment is awkward
  // but might still flag a real issue. Keep it.
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MUTATE FILTERS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Filter: speculative blocker downgrade ─────────────────────────────────────
//
// Catches: "blocker" severity on issues the model itself admits are
// theoretical, practically impossible, or unlikely in practice.
// Downgrades to "warning" so the finding is still visible but doesn't
// block the PR on a phantom issue.

const SPECULATIVE_PATTERNS = [
  /\bclock skew\b/i,
  /\bpractically impossible\b/i,
  /\bunlikely in practice\b/i,
  /\bextremely rare\b/i,
  /\btheoretical/i,
  /\bin theory\b/i,
  /\bedge case if\b/i,
  /\bwould require\b/i,
  /\bhighly unlikely\b/i,
  /\bnever happen\b/i,
  /\bvanishingly/i,
];

function speculativeBlocker(comment: ReviewComment): string | null {
  if (comment.severity !== "blocker") return null;

  const isSpeculative = SPECULATIVE_PATTERNS.some((p) => p.test(comment.body));
  if (!isSpeculative) return null;

  (comment as { severity: ReviewComment["severity"] }).severity = "warning";
  return "blocker→warning (speculative/hedged language)";
}

// ── Filter: maximum body length (belt-and-suspenders) ─────────────────────────
//
// The JSON schema already enforces maxLength on the body field, but a
// model with structured-output disabled could bypass it. Hard-truncate
// instead of dropping so the signal isn't lost.

function maxBodyLength(
  comment: ReviewComment,
  maxChars: number,
): string | null {
  if (comment.body.length <= maxChars) return null;

  const cut = comment.body.lastIndexOf(" ", maxChars);
  const end = cut > 0 ? cut : maxChars;
  (comment as { body: string }).body = comment.body.slice(0, end) + "…";
  return `body truncated (${comment.body.length} → ${end + 1} chars)`;
}

// ── Descriptive summary for logging ───────────────────────────────────────────

export function formatFilterSummary(filtered: FilteredComments): string {
  const parts: string[] = [];

  if (filtered.dropped.length > 0) {
    parts.push(
      `Hard filters dropped ${filtered.dropped.length} comment(s):`,
      ...filtered.dropped.map(
        (d) =>
          `  - ${d.path}:${d.line} — ${d.reason}\n    body: "${d.body.slice(0, 80)}"`,
      ),
    );
  }

  if (filtered.mutated.length > 0) {
    parts.push(
      `Hard filters mutated ${filtered.mutated.length} comment(s):`,
      ...filtered.mutated.map((m) => `  - ${m.path}:${m.line} — ${m.reason}`),
    );
  }

  return parts.join("\n");
}

// ── Result-level filter: verdict consistency ──────────────────────────────────
//
// REQUEST_CHANGES with zero inline comments is a broken state — the author
// is told to fix things but given no specific things to fix. Downgrade to
// COMMENT so the review is still visible but doesn't falsely block the PR.
//
// More subtly: REQUEST_CHANGES without any blocker-severity inline comments
// is equally unjustified. A warning alone doesn't warrant blocking.
//
// When we downgrade, we also append a note to result.summary so the displayed
// body never contradicts the header verdict. The model often writes "Verdict is
// REQUEST_CHANGES" in the free-text summary — without this, the header shows
// 💬 observations while the body says REQUEST_CHANGES.
//
// Returns a reason string if the action was changed, null otherwise.
// Mutates result.action (and result.summary when changed) in place.

export function filterReviewVerdict(result: ReviewResult): string | null {
  if (result.action !== "REQUEST_CHANGES") return null;

  const hasBlocker = result.comments.some((c) => c.severity === "blocker");

  if (result.comments.length === 0) {
    (result as { action: ReviewResult["action"] }).action = "COMMENT";
    (result as { summary: string }).summary =
      result.summary.trim() +
      "\n\n_(Verdict adjusted: no inline findings — REQUEST\\_CHANGES downgraded to COMMENT.)_";
    return "REQUEST_CHANGES→COMMENT (zero inline comments — no specific issues to address)";
  }

  if (!hasBlocker) {
    (result as { action: ReviewResult["action"] }).action = "COMMENT";
    (result as { summary: string }).summary =
      result.summary.trim() +
      "\n\n_(Verdict adjusted: all findings are warnings, none blockers — REQUEST\\_CHANGES downgraded to COMMENT.)_";
    return "REQUEST_CHANGES→COMMENT (no blocker-severity comments — warnings alone don't justify blocking)";
  }

  return null;
}
