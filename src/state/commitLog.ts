/**
 * Lightweight per-repo commit-SHA log for PR deduplication.
 *
 * Prevents Zanuda from re-reviewing PRs whose commits were all already
 * reviewed in a previous PR (e.g., develop→main sync PRs after feature
 * PRs were already reviewed).
 *
 * Persisted as a simple JSON file. Entries are pruned after 60 days
 * to prevent unbounded growth.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { logger } from "../logger.js";

const PRUNE_AFTER_DAYS = 60;

// ── On-disk schema ────────────────────────────────────────────────────────────

const CommitLogEntrySchema = z.object({
  shas: z.array(z.string()),
  updatedAt: z.string().datetime(),
});

const CommitLogFileSchema = z.object({
  version: z.literal(1),
  repos: z.record(z.string(), z.unknown()),
});

type CommitLogFile = z.infer<typeof CommitLogFileSchema>;

// ── Store ─────────────────────────────────────────────────────────────────────

export class CommitLog {
  private readonly path: string;
  /** Reviewed SHAs per `owner/repo` key. */
  private readonly data: Map<string, Set<string>>;
  /**
   * Per-repo last-mutation timestamps. Only the repo being written gets
   * a fresh stamp — other repos' timestamps are preserved across saves
   * so the 60-day prune actually works.
   */
  private readonly updatedAt: Map<string, string>;

  constructor(logPath?: string) {
    this.path = resolve(
      logPath || join(homedir(), ".zanuda", "commit-log.json"),
    );
    this.updatedAt = new Map();
    this.data = this.load();
  }

  /**
   * Returns true if ALL of the given SHAs are already in the log for this
   * repo — meaning every commit in the PR was previously reviewed.
   */
  hasAll(owner: string, repo: string, shas: string[]): boolean {
    if (shas.length === 0) return false; // empty PR? review it.
    const key = `${owner}/${repo}`;
    const seen = this.data.get(key);
    if (!seen) return false;
    return shas.every((sha) => seen.has(sha));
  }

  /**
   * Record reviewed commit SHAs for a repo. Idempotent.
   */
  addAll(owner: string, repo: string, shas: string[]): void {
    const key = `${owner}/${repo}`;
    const seen = this.data.get(key) ?? new Set<string>();
    for (const sha of shas) seen.add(sha);
    this.data.set(key, seen);
    this.updatedAt.set(key, new Date().toISOString());
    this.save();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private load(): Map<string, Set<string>> {
    if (!existsSync(this.path)) return new Map();

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return new Map();
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return new Map();
    }

    const parsed = CommitLogFileSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn(
        { path: this.path, issues: parsed.error.issues },
        "Commit log file failed schema validation — starting fresh",
      );
      return new Map();
    }

    const file = parsed.data;
    const cutoff = Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    const map = new Map<string, Set<string>>();
    let pruned = 0;

    for (const [key, entry] of Object.entries(file.repos)) {
      // Per-entry validation: a single malformed entry doesn't discard
      // the entire file.
      const validated = CommitLogEntrySchema.safeParse(entry);
      if (!validated.success) {
        pruned++;
        continue;
      }
      const e = validated.data;
      const ts = new Date(e.updatedAt).getTime();
      if (isNaN(ts) || ts < cutoff) {
        pruned++;
        continue;
      }
      map.set(key, new Set(e.shas));
      this.updatedAt.set(key, e.updatedAt);
    }

    if (pruned > 0) {
      logger.info(
        { path: this.path, pruned },
        "Pruned stale entries from commit log",
      );
    }

    return map;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });

      const repos: CommitLogFile["repos"] = {};
      for (const [key, shas] of this.data) {
        repos[key] = {
          shas: [...shas],
          updatedAt: this.updatedAt.get(key) ?? new Date().toISOString(),
        };
      }

      const file: CommitLogFile = { version: 1, repos };
      const json = JSON.stringify(file, null, 2);
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, json, "utf8");
      renameSync(tmp, this.path);
    } catch (err) {
      logger.error({ err, path: this.path }, "Failed to persist commit log");
    }
  }
}
