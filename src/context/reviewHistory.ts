import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { Config } from "../config.js";
import type { RepoRef } from "../platform/types.js";
import type { LLMProvider } from "../llm/types.js";
import { logger } from "../logger.js";
import { completeWithRetry } from "../llm/retry.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export const CommentOutcomeSchema = z.object({
  path: z.string(),
  /** Line number from the diff. Optional — the model may not always recover it. */
  line: z.number().int().positive().optional(),
  severity: z.enum(["blocker", "warning"]),
  /** 5-10 word description of what was flagged. */
  summary: z.string(),
  outcome: z.enum(["addressed", "dismissed", "ignored"]),
  /** Developer's explanation — only present for dismissed outcomes. */
  dismissalReason: z.string().optional(),
});

export const ReviewHistoryEntrySchema = z.object({
  prNumber: z.number().int().positive(),
  prTitle: z.string(),
  /** ISO date string YYYY-MM-DD */
  date: z.string(),
  finalAction: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  outcomes: z.array(CommentOutcomeSchema),
});

export const ReviewHistorySchema = z.object({
  entries: z.array(ReviewHistoryEntrySchema),
});

export type CommentOutcome = z.infer<typeof CommentOutcomeSchema>;
export type ReviewHistoryEntry = z.infer<typeof ReviewHistoryEntrySchema>;
export type ReviewHistory = z.infer<typeof ReviewHistorySchema>;

// ─── Storage helpers ──────────────────────────────────────────────────────────

function historyPath(config: Config, ref: RepoRef): string {
  const dir = config.memory.dir || join(homedir(), ".zanuda", "memory");
  const safe = `${basename(ref.owner)}_${basename(ref.repo)}`;
  return join(resolve(dir), `${safe}.history.json`);
}

export function loadReviewHistory(
  config: Config,
  ref: RepoRef,
): ReviewHistory | null {
  if (!config.memory.enabled) return null;
  const path = historyPath(config, ref);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = ReviewHistorySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn(
        { path },
        "Review history file has unexpected shape — ignoring",
      );
      return null;
    }
    return parsed.data;
  } catch (err) {
    logger.warn({ err, path }, "Failed to read review history — ignoring");
    return null;
  }
}

export function saveReviewHistory(
  config: Config,
  ref: RepoRef,
  history: ReviewHistory,
): void {
  if (!config.memory.enabled) return;
  const path = historyPath(config, ref);
  const dir = resolve(
    config.memory.dir || join(homedir(), ".zanuda", "memory"),
  );
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(history, null, 2), "utf8");
  renameSync(tmp, path);
  logger.info({ path }, "Review history saved");
}

// ─── Rolling append ───────────────────────────────────────────────────────────

/**
 * Append a new entry and prune the oldest ones to stay within `maxEntries`.
 * Returns a new ReviewHistory — does not mutate the input.
 */
export function appendEntry(
  history: ReviewHistory,
  entry: ReviewHistoryEntry,
  maxEntries: number,
): ReviewHistory {
  const entries = [...history.entries, entry];
  return { entries: entries.slice(-maxEntries) };
}

// ─── Outcome classification ───────────────────────────────────────────────────

// Marker that appears in formatDiscussion output for inline review comments.
const ZANUDA_INLINE_MARKER = "**ZlayaZanuda**";

/**
 * Returns true if the discussion contains at least one inline comment from
 * ZlayaZanuda (i.e. worth spending an LLM call on classification).
 */
export function hasClassifiableComments(discussion: string): boolean {
  return (
    discussion.includes(ZANUDA_INLINE_MARKER) &&
    // Inline comments have a [path:line] location marker
    discussion.includes("[`")
  );
}

const CLASSIFY_SYSTEM = `\
You are classifying outcomes of inline code review comments.

In the discussion, ZlayaZanuda's inline review comments appear as:
  **ZlayaZanuda** [\`path:line\`]:
  <comment body>

For each such comment, classify what happened:
  "addressed"  — the developer fixed the issue (look for "Done", "Fixed",
                  confirmation of a code change, or round-2 discussion showing
                  the issue resolved)
  "dismissed"  — the developer replied explaining the pattern is intentional
                  or the comment is not applicable (explanation given, no code fix)
  "ignored"    — no meaningful reply in the discussion

Also produce:
  "summary"         — 5-10 word description of what was flagged
  "dismissalReason" — (dismissed only) developer's explanation, ≤1 sentence

Return a JSON array — nothing else, no markdown fences.
One object per inline comment from ZlayaZanuda, in order of appearance.
If there are no inline comments from ZlayaZanuda, return an empty array [].

Shape:
[
  {
    "path": "repo-relative file path",
    "line": 42,
    "severity": "blocker" | "warning",
    "summary": "brief description of what was flagged",
    "outcome": "addressed" | "dismissed" | "ignored",
    "dismissalReason": "optional — only for dismissed"
  }
]`;

/**
 * Ask the model to classify the outcome of each inline review comment from
 * ZlayaZanuda based on the round-2 discussion.
 *
 * Returns an empty array on failure so callers can always proceed.
 */
export async function classifyOutcomes(
  prNumber: number,
  prTitle: string,
  discussion: string,
  config: Config,
  provider: LLMProvider,
): Promise<CommentOutcome[]> {
  const log = logger.child({ pr: prNumber });

  if (!hasClassifiableComments(discussion)) {
    log.info("No inline comments to classify — skipping");
    return [];
  }

  const user = [
    `PR #${prNumber} — "${prTitle}"`,
    "",
    "## Discussion",
    discussion,
  ].join("\n");

  let raw: string;
  try {
    const completion = await completeWithRetry(provider, {
      system: CLASSIFY_SYSTEM,
      user,
      model: config.models[config.provider],
      temperature: 0,
      maxTokens: 1024,
    });
    raw = completion.text.trim();
  } catch (err) {
    log.warn({ err }, "Outcome classification LLM call failed — skipping");
    return [];
  }

  try {
    // Strip optional code fence
    const json = raw
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();
    const parsed = z.array(CommentOutcomeSchema).safeParse(JSON.parse(json));
    if (!parsed.success) {
      log.warn(
        { raw: raw.slice(0, 200) },
        "Outcome classification returned unexpected shape — skipping",
      );
      return [];
    }
    log.info({ total: parsed.data.length }, "Outcomes classified");
    return parsed.data;
  } catch {
    log.warn(
      { raw: raw.slice(0, 200) },
      "Outcome classification returned invalid JSON — skipping",
    );
    return [];
  }
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

const ACTION_ICON: Record<string, string> = {
  APPROVE: "✅",
  REQUEST_CHANGES: "🛑",
  COMMENT: "💬",
};

const OUTCOME_LABEL: Record<string, string> = {
  addressed: "fixed",
  dismissed: "dismissed",
  ignored: "ignored",
};

/**
 * Render the review history as a compact markdown section for injection into
 * the review prompt. Most recent entries first so the model sees recent context
 * at the top without needing to scan down.
 */
export function formatReviewHistory(
  history: ReviewHistory,
  maxEntries = 10,
): string {
  if (history.entries.length === 0) return "";

  const entries = [...history.entries].reverse().slice(0, maxEntries);
  const lines: string[] = [
    `## Review history (last ${entries.length} review${entries.length === 1 ? "" : "s"})`,
    "",
  ];

  for (const entry of entries) {
    const icon = ACTION_ICON[entry.finalAction] ?? "💬";
    lines.push(
      `**PR #${entry.prNumber}** — "${entry.prTitle}" — ${icon} ${entry.finalAction} (${entry.date})`,
    );

    if (entry.outcomes.length === 0) {
      lines.push("- _(no inline comments)_");
    } else {
      for (const o of entry.outcomes) {
        const loc =
          o.line !== null && o.line !== undefined
            ? `${o.path}:${o.line}`
            : o.path;
        const label = OUTCOME_LABEL[o.outcome] ?? o.outcome;
        const dismissal =
          o.outcome === "dismissed" && o.dismissalReason
            ? ` _(${o.dismissalReason})_`
            : "";
        lines.push(
          `- \`${loc}\` (${o.severity}): ${o.summary} — **${label}**${dismissal}`,
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
