import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import type { RepoRef } from "../github/client.js";
import type { LLMProvider } from "../llm/types.js";
import { logger } from "../logger.js";
import { buildContext } from "./builder.js";

// ─── Storage helpers ──────────────────────────────────────────────────────────

function memoryDir(config: Config): string {
  const dir = config.memory.dir || join(homedir(), ".review-helper", "memory");
  return resolve(dir);
}

function memoryPath(config: Config, ref: RepoRef): string {
  return join(memoryDir(config), `${ref.owner}_${ref.repo}.md`);
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

export function saveRepoMemory(config: Config, ref: RepoRef, content: string): void {
  if (!config.memory.enabled) return;
  const dir = memoryDir(config);
  mkdirSync(dir, { recursive: true });
  const path = memoryPath(config, ref);
  writeFileSync(path, content, "utf8");
  logger.info({ path }, "Repo memory saved");
}

// ─── In-process generation lock ─────────────────────────────────────────────
// Prevents two concurrent reviews of the same repo from both seeing no memory
// file and both firing off a generation LLM call. The second one waits until
// the first has written the file, then loads it instead of re-generating.
const _generatingFor = new Set<string>();

// ─── Generation ───────────────────────────────────────────────────────────────

const GENERATE_SYSTEM = `\
You are building a persistent knowledge document for an AI code reviewer bot.
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

Rules:
- 3-8 bullet points or short paragraphs per section.
- Be specific: name actual files, functions, types where relevant.
- No filler sentences. Start with "## Architecture" directly.`;

/**
 * Generate a fresh repo memory document from the repo's context files + file
 * tree. This is a one-time LLM call on first encounter of a repo.
 */
export async function generateRepoMemory(
  octokit: Octokit,
  ref: RepoRef,
  gitRef: string,
  config: Config,
  provider: LLMProvider,
): Promise<string> {
  const repoKey = `${ref.owner}/${ref.repo}`;
  const log = logger.child({ repo: repoKey });

  // If another concurrent review of the same repo is already generating memory,
  // wait for it to finish then return the file it wrote instead of re-generating.
  if (_generatingFor.has(repoKey)) {
    log.info("Repo memory generation already in progress — waiting");
    await waitUntil(() => !_generatingFor.has(repoKey));
    const existing = loadRepoMemory(config, ref);
    if (existing) return existing;
    // If it still doesn't exist (the other call failed), fall through and try ourselves.
  }

  _generatingFor.add(repoKey);
  log.info("Generating repo memory (first encounter)");

  try {
    const context = await buildContext(octokit, ref, gitRef, config);

    const user = [
      `Repository: ${ref.owner}/${ref.repo}`,
      "",
      context.text,
    ].join("\n");

    const completion = await provider.complete({
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
  } finally {
    // Always release the lock so waiting callers can proceed.
    _generatingFor.delete(repoKey);
  }
}

// ─── Update ───────────────────────────────────────────────────────────────────

const UPDATE_SYSTEM = `\
You are maintaining a knowledge document for an AI code reviewer bot.
A PR was just reviewed. Decide whether the memory document needs updating.

Update if — and only if — the PR reveals something genuinely NEW:
  - New modules, layers, or significant architectural change
  - New or removed dependencies that affect how the project works
  - New code style patterns or conventions introduced by this PR
  - New invariants or gotchas uncovered by the review (e.g. a bug was found
    that reveals a wrong assumption baked into the architecture)

Do NOT update for:
  - Routine feature additions that fit existing patterns
  - Bugfixes that don't change how the project is structured
  - Anything already captured in the current memory

Response format (choose exactly one):
  - If an update is needed: respond with the complete updated memory document
    in the same format (keep all sections, update the "Updated:" date line).
  - If no update is needed: respond with exactly the word: NO_UPDATE`;

/**
 * After a review, ask the model whether the PR revealed anything worth
 * remembering. Returns the updated memory string, or null if no update needed.
 */
export async function maybeUpdateRepoMemory(
  ref: RepoRef,
  currentMemory: string,
  prTitle: string,
  changedFiles: string[],
  reviewSummary: string,
  diff: string,
  config: Config,
  provider: LLMProvider,
): Promise<string | null> {
  if (!config.memory.updateAfterReview) return null;

  const log = logger.child({ repo: `${ref.owner}/${ref.repo}` });

  const user = [
    `Repository: ${ref.owner}/${ref.repo}`,
    "",
    "## Current memory document",
    currentMemory,
    "",
    "## PR just reviewed",
    `Title: ${prTitle}`,
    `Changed files: ${changedFiles.join(", ")}`,
    `Review summary: ${reviewSummary}`,
    "",
    "## Diff (first 4 000 chars)",
    diff.slice(0, 4000),
  ].join("\n");

  const completion = await provider.complete({
    system: UPDATE_SYSTEM,
    user,
    model: config.models[config.provider],
    temperature: 0.1,
    maxTokens: 2048,
  });

  const text = completion.text.trim();
  if (text === "NO_UPDATE") {
    log.info("Repo memory: no update needed after review");
    return null;
  }

  log.info("Repo memory: updating after review");
  // Ensure the Updated date reflects today even if the model forgot to change it.
  return text.replace(/^Updated: .+$/m, `Updated: ${today()}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Poll until predicate is true, used to wait for concurrent memory generation. */
function waitUntil(pred: () => boolean, intervalMs = 500): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (pred() ? resolve() : setTimeout(check, intervalMs));
    check();
  });
}
