import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { Config } from "../config.js";
import type { RepoRef } from "../platform/types.js";
import type { LLMProvider } from "../llm/types.js";
import { logger } from "../logger.js";
import type { ProjectContext } from "./builder.js";
import { completeWithRetry } from "../llm/retry.js";

// ─── Storage helpers ──────────────────────────────────────────────────────────

function memoryDir(config: Config): string {
  const dir = config.memory.dir || join(homedir(), ".zanuda", "memory");
  return resolve(dir);
}

function memoryPath(config: Config, ref: RepoRef): string {
  // basename() strips any path separators from owner/repo, preventing a
  // connector that returns untrusted values from escaping the memory directory.
  const safe = `${basename(ref.owner)}_${basename(ref.repo)}.md`;
  return join(memoryDir(config), safe);
}

export function loadRepoMemory(config: Config, ref: RepoRef): string | null {
  if (!config.memory.enabled) return null;
  const path = memoryPath(config, ref);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    logger.warn({ err, path }, "Failed to read repo memory");
    return null;
  }
}

export function saveRepoMemory(
  config: Config,
  ref: RepoRef,
  content: string,
): void {
  if (!config.memory.enabled) return;
  const dir = memoryDir(config);
  mkdirSync(dir, { recursive: true });
  const path = memoryPath(config, ref);
  // Atomic write: write to a sibling .tmp file then rename into place.
  // renameSync is atomic on POSIX — a crash mid-write cannot corrupt the
  // existing memory file (same pattern as PRStateStore).
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
  logger.info({ path }, "Repo memory saved");
}

// ─── In-process generation lock ─────────────────────────────────────────────
// Prevents two concurrent reviews of the same repo from both seeing no memory
// file and both firing off a generation LLM call. Stores the in-flight Promise
// so the second caller can await it directly rather than polling.
const _generatingFor = new Map<string, Promise<string>>();

// ─── Generation ───────────────────────────────────────────────────────────────

const GENERATE_SYSTEM = `\
You are building a persistent knowledge document for an AI code reviewer.
This document will be prepended to every future review of this repository so the
reviewer always has deep project context without re-reading the whole codebase.

Produce a concise, structured document with exactly these sections:

## Architecture
How the codebase is structured: main modules, layers, how they connect.

## Tech stack
Languages, frameworks, key libraries. Note versions if visible.

## Code style & conventions
Naming conventions, patterns, idioms specific to this codebase.

## Key invariants & gotchas
Important assumptions, security boundaries, known quirks — things a reviewer
must keep in mind to avoid false positives or missing real bugs.

## Entry points & flow
Main entry files, how the app starts, key data/execution flows.

## Reviewer calibration
Code patterns, decisions, or conventions that may look like bugs or
anti-patterns to a reviewer but are intentional — things NOT to flag.
Each entry: one sentence describing the pattern + why it exists.
Leave this section empty on initial generation; entries are added over time
as review discussions confirm intentional patterns.

Rules:
- 3-8 bullet points or short paragraphs per section (calibration may be empty).
- Be specific: name actual files, functions, types where relevant.
- No filler sentences. Start with "## Architecture" directly.`;

/**
 * Generate a fresh repo memory document from the repo's context files + file
 * tree. This is a one-time LLM call on first encounter of a repo.
 */
/**
 * Generate a fresh repo memory document from the already-built project context.
 * Accepts the context directly so the caller (engine.ts) does not need to
 * fetch it a second time — buildContext is called once per review, not twice.
 */
export async function generateRepoMemory(
  ref: RepoRef,
  context: ProjectContext,
  config: Config,
  provider: LLMProvider,
): Promise<string> {
  const repoKey = `${ref.owner}/${ref.repo}`;
  const log = logger.child({ repo: repoKey });

  // If another concurrent review of the same repo is already generating memory,
  // await the in-flight Promise directly instead of polling a flag.
  const inflight = _generatingFor.get(repoKey);
  if (inflight) {
    log.info("Repo memory generation already in progress — waiting");
    try {
      return await inflight;
    } catch {
      // The first caller failed; fall through and try ourselves.
    }
  }

  log.info("Generating repo memory (first encounter)");

  const generation = (async () => {
    const user = [
      `Repository: ${ref.owner}/${ref.repo}`,
      "",
      context.text,
    ].join("\n");

    const completion = await completeWithRetry(provider, {
      system: GENERATE_SYSTEM,
      user,
      model: config.models[config.provider],
      temperature: 0.1,
      maxTokens: 2048,
    });

    const now = today();
    return [
      `# Repo Memory: ${ref.owner}/${ref.repo}`,
      `Generated: ${now}`,
      `Updated: ${now}`,
      "",
      completion.text.trim(),
    ].join("\n");
  })();

  // Register before awaiting so any concurrent caller picks it up immediately.
  _generatingFor.set(repoKey, generation);
  try {
    return await generation;
  } finally {
    // Remove only if it's still our promise — a retry might have replaced it.
    if (_generatingFor.get(repoKey) === generation) {
      _generatingFor.delete(repoKey);
    }
  }
}

// ─── Update ───────────────────────────────────────────────────────────────────

/** Zod schema for the LLM's memory-update response. Module-level so it is
 *  only constructed once rather than on every call to maybeUpdateRepoMemory. */
const MemoryUpdateResponseSchema = z.object({
  update: z.boolean(),
  content: z.string().optional(),
});

const UPDATE_SYSTEM = `\
You are maintaining a knowledge document for an AI code reviewer.
A PR was just reviewed. Decide whether the memory document needs updating.

The document has two categories of content that may need updating:

## CATEGORY 1 — Codebase knowledge (driven by the diff)
Update if the PR reveals something genuinely new:
  - New modules, layers, or significant architectural change
  - New or removed dependencies that affect how the project works
  - New code style patterns or conventions introduced by this PR
  - New invariants or gotchas uncovered by the review

Do NOT update for:
  - Routine feature additions that fit existing patterns
  - Bugfixes that don't change how the project is structured
  - Anything already captured in the current memory

## CATEGORY 2 — Reviewer calibration (driven by the discussion)
Update the "Reviewer calibration" section when the discussion shows the reviewer
flagged something that was intentional — i.e. the developer replied with an
explanation rather than a code fix.

For each such dismissed comment add one bullet:
  - What the pattern is, why it is intentional, and a PR reference.
  - Example: "Do not flag bare \`except\` in worker.py — intentional to keep the
    supervisor loop alive on unexpected errors (PR #47)."

Only add entries for DISMISSED comments (developer explained, no code change).
Do NOT add entries for comments that were addressed with a code fix.
If no discussion is provided, skip Category 2 entirely.

Respond with a JSON object — nothing else, no markdown fences:
  { "update": false }
    — if no update is needed in either category.
  { "update": true, "content": "<complete updated memory document>" }
    — if an update is needed. Keep ALL existing sections intact;
      update the "Updated:" date line.`;

/**
 * After a review, ask the model whether the PR revealed anything worth
 * remembering. Returns the updated memory string, or null if no update needed.
 */
export async function maybeUpdateRepoMemory(
  ref: RepoRef,
  currentMemory: string,
  prTitle: string,
  prNumber: number,
  changedFiles: string[],
  reviewSummary: string,
  diff: string,
  discussion: string | undefined,
  config: Config,
  provider: LLMProvider,
): Promise<string | null> {
  if (!config.memory.updateAfterReview) return null;

  const log = logger.child({ repo: `${ref.owner}/${ref.repo}` });

  const parts = [
    `Repository: ${ref.owner}/${ref.repo}`,
    "",
    "## Current memory document",
    currentMemory,
    "",
    "## PR just reviewed",
    `Title: ${prTitle}`,
    `Number: #${prNumber}`,
    `Changed files: ${changedFiles.join(", ")}`,
    `Review summary: ${reviewSummary}`,
    "",
    "## Diff (first 4 000 chars)",
    diff.slice(0, 4000),
  ];

  if (discussion) {
    // ZlayaZanuda = the reviewer; other authors = the developer.
    // Dismissed comments appear as: reviewer flags something, developer
    // replies with an explanation, no subsequent code fix.
    parts.push(
      "",
      "## Review discussion (ZlayaZanuda = reviewer; other authors = developer)",
      discussion,
    );
  }

  const user = parts.join("\n");

  const completion = await completeWithRetry(provider, {
    system: UPDATE_SYSTEM,
    user,
    model: config.models[config.provider],
    temperature: 0.1,
    maxTokens: 2048,
  });

  let parsed: z.infer<typeof MemoryUpdateResponseSchema>;
  try {
    // Strip optional code fence before parsing.
    const raw = completion.text
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();
    parsed = MemoryUpdateResponseSchema.parse(JSON.parse(raw));
  } catch {
    log.warn(
      { text: completion.text.slice(0, 200) },
      "Repo memory update response was not valid JSON — skipping update",
    );
    return null;
  }

  if (!parsed.update || !parsed.content) {
    log.info("Repo memory: no update needed after review");
    return null;
  }

  log.info("Repo memory: updating after review");
  // Ensure the Updated date reflects today even if the model forgot to change it.
  return parsed.content.replace(/^Updated: .+$/m, `Updated: ${today()}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
