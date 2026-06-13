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

// ─── Public types ─────────────────────────────────────────────────────────────

export interface PRState {
  ref: { owner: string; repo: string };
  /** GitHub PR number (e.g. 42). */
  number: number;
  /** How many full review rounds have completed (0, 1, or 2). */
  rounds: number;
  /** How many @mention replies have been posted. */
  mentionReplies: number;
  /** Comment IDs already replied to (prevents double-replies). */
  repliedCommentIds: Set<number>;
  /** Set once the "max rounds reached" message has been posted. */
  maxRoundsNotified: boolean;
  /** Comment ID of the progress comment (\"Starting review\u2026\") posted in round 1.
   * Passed to round 2 so it can update in place instead of creating a second comment. */
  progressCommentId: number | null;
  /**
   * Consecutive review failures. Reset to 0 on success. Used to detect
   * permanently failing PRs (e.g. always produces truncated JSON output).
   */
  consecutiveFailures: number;
  /** Wall-clock time of last write; used to prune stale entries on load. */
  lastUpdatedAt: string;
}

// ─── On-disk schema ───────────────────────────────────────────────────────────

/** Serialisable form: Sets become arrays; everything else is a plain value. */
interface SerializedPRState extends Omit<
  PRState,
  "repliedCommentIds" | "lastUpdatedAt"
> {
  repliedCommentIds: number[];
  lastUpdatedAt: string;
}

interface StateFile {
  /** Bumped if the schema ever changes; lets us migrate or discard cleanly. */
  version: 1;
  prs: Record<string, SerializedPRState>;
}

const CURRENT_VERSION = 1 as const;

/** Entries not updated within this window are pruned on load. */
const PRUNE_AFTER_DAYS = 30;

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Persistent per-PR state store.
 *
 * Wraps a `Map<number, PRState>` with atomic disk persistence so that round
 * counts and reply caps survive process restarts.
 *
 * Writes are synchronous and atomic: data is written to a `.tmp` sibling file
 * first, then renamed into place. `rename(2)` is atomic on POSIX filesystems
 * so a crash mid-write cannot produce a corrupt state file.
 */
export class PRStateStore {
  private readonly path: string;
  private readonly data: Map<number, PRState>;

  constructor(statePath?: string) {
    this.path = resolve(statePath || join(homedir(), ".zanuda", "state.json"));
    this.data = this.loadFromDisk();
  }

  // ── Read API ───────────────────────────────────────────────────────────────

  get(id: number): PRState | undefined {
    return this.data.get(id);
  }

  has(id: number): boolean {
    return this.data.has(id);
  }

  /** Iterate all persisted states. Used by the mention-polling loop. */
  entries(): IterableIterator<[number, PRState]> {
    return this.data.entries();
  }

  // ── Write API ──────────────────────────────────────────────────────────────

  /**
   * Upsert a PR state entry and immediately persist to disk.
   * Always pass the full intended state — there is no partial-patch API to
   * keep mutation paths explicit and easy to audit.
   */
  set(id: number, state: Omit<PRState, "lastUpdatedAt">): void {
    const entry: PRState = {
      ...state,
      lastUpdatedAt: new Date().toISOString(),
    };
    this.data.set(id, entry);
    this.saveToDisk();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private loadFromDisk(): Map<number, PRState> {
    if (!existsSync(this.path)) {
      logger.info(
        { path: this.path },
        "No state file found — starting with empty state",
      );
      return new Map();
    }

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      logger.error(
        { err, path: this.path },
        "Cannot read state file — starting with empty state",
      );
      return new Map();
    }

    let file: StateFile;
    try {
      file = JSON.parse(raw) as StateFile;
    } catch (err) {
      logger.error(
        { err, path: this.path },
        "State file is not valid JSON — starting with empty state",
      );
      return new Map();
    }

    if (file.version !== CURRENT_VERSION) {
      logger.warn(
        {
          path: this.path,
          fileVersion: file.version,
          currentVersion: CURRENT_VERSION,
        },
        "Unrecognised state file version — starting with empty state",
      );
      return new Map();
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - PRUNE_AFTER_DAYS);

    const map = new Map<number, PRState>();
    let pruned = 0;

    for (const [key, s] of Object.entries(file.prs)) {
      if (new Date(s.lastUpdatedAt) < cutoff) {
        pruned++;
        continue;
      }
      map.set(Number(key), {
        ...s,
        repliedCommentIds: new Set(s.repliedCommentIds),
        // Default for existing state files that predate this field.
        progressCommentId: s.progressCommentId ?? null,
        // Default to 0 for existing state files that predate this field.
        consecutiveFailures: s.consecutiveFailures ?? 0,
      });
    }

    logger.info(
      { path: this.path, loaded: map.size, pruned },
      "PR state loaded from disk",
    );
    return map;
  }

  private saveToDisk(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });

      const file: StateFile = {
        version: CURRENT_VERSION,
        prs: {},
      };
      for (const [id, state] of this.data) {
        file.prs[String(id)] = {
          ...state,
          repliedCommentIds: [...state.repliedCommentIds],
        };
      }

      const json = JSON.stringify(file, null, 2);
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, json, "utf8");
      // Atomic on POSIX — the state file is always either the old or new
      // version, never a partial write.
      renameSync(tmp, this.path);
    } catch (err) {
      // Non-fatal: the in-memory state is still correct for this session;
      // the next successful write will catch up.
      logger.error(
        { err, path: this.path },
        "Failed to persist PR state to disk",
      );
    }
  }
}
