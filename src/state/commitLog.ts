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
import { logger } from "../logger.js";

const PRUNE_AFTER_DAYS = 60;

interface CommitLogFile {
  /** Bumped on schema changes. */
  version: 1;
  repos: Record<string, { shas: string[]; updatedAt: string }>;
}

export class CommitLog {
  private readonly path: string;
  private readonly data: Map<string, Set<string>>;

  constructor(logPath?: string) {
    this.path = resolve(
      logPath || join(homedir(), ".zanuda", "commit-log.json"),
    );
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

    let file: CommitLogFile;
    try {
      file = JSON.parse(raw) as CommitLogFile;
    } catch {
      return new Map();
    }

    if (file.version !== 1) return new Map();

    const cutoff = Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    const map = new Map<string, Set<string>>();
    let pruned = 0;

    for (const [key, entry] of Object.entries(file.repos)) {
      // Verify data types — the Set constructor wants an iterable.
      if (!Array.isArray(entry.shas)) {
        pruned++;
        continue;
      }
      if (new Date(entry.updatedAt).getTime() < cutoff) {
        pruned++;
        continue;
      }
      map.set(key, new Set(entry.shas));
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
          updatedAt: new Date().toISOString(),
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
