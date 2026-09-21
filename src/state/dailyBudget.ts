/**
 * Global daily cap on review rounds.
 *
 * `limits.tokenBudgetPerPR` bounds one PR; nothing bounded the day. A flood of
 * PRs (or one repo in a loop) could spend the operator's whole month in an
 * afternoon. This is the outermost backstop: a counter of started review rounds
 * per UTC day, persisted so a restart cannot reset it.
 *
 * Counted per ROUND, not per LLM call — a round is the unit the poller starts
 * and the unit an operator reasons about. Mention replies are already capped
 * per PR and are not counted here.
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

interface BudgetFile {
  version: 1;
  /** UTC date the counter belongs to, YYYY-MM-DD. */
  date: string;
  /** Review rounds started on that date. */
  rounds: number;
}

export class DailyBudget {
  private readonly path: string;
  private date: string;
  private rounds: number;

  constructor(budgetPath?: string) {
    this.path = resolve(
      budgetPath || join(homedir(), ".zanuda", "daily-budget.json"),
    );
    const loaded = this.load();
    this.date = loaded.date;
    this.rounds = loaded.rounds;
  }

  /** Rounds started so far today. */
  get used(): number {
    this.rollover();
    return this.rounds;
  }

  /**
   * Reserve one round against today's budget.
   * Returns false when the cap is already reached — the caller defers the PR;
   * it is still requested on the platform, so the next day picks it up.
   * `max` of 0 means unlimited.
   */
  tryConsume(max: number): boolean {
    this.rollover();
    if (max > 0 && this.rounds >= max) return false;
    // Increment the in-memory counter before the best-effort save: within a
    // run the cap is enforced even if persistence fails. The trade-off is that
    // a crash before the write lands (or a failed save) leaves the persisted
    // count lower than reality, so a restart can undercount — the cap may then
    // grant a few extra rounds, but never blocks a legitimate one. A soft cost
    // backstop accepts that direction.
    this.rounds++;
    this.save();
    return true;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Reset the counter when the UTC day has changed since the last write. */
  private rollover(): void {
    const today = utcDate();
    if (this.date !== today) {
      this.date = today;
      this.rounds = 0;
    }
  }

  private load(): { date: string; rounds: number } {
    const empty = { date: utcDate(), rounds: 0 };
    if (!existsSync(this.path)) return empty;
    try {
      const file = JSON.parse(readFileSync(this.path, "utf8")) as BudgetFile;
      if (file.version !== 1 || typeof file.rounds !== "number") return empty;
      // A counter from an earlier day starts over.
      if (file.date !== empty.date) return empty;
      return { date: file.date, rounds: file.rounds };
    } catch (err) {
      logger.warn(
        { err, path: this.path },
        "Cannot read daily budget — starting today's count at zero",
      );
      return empty;
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const file: BudgetFile = {
        version: 1,
        date: this.date,
        rounds: this.rounds,
      };
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(file), "utf8");
      renameSync(tmp, this.path);
    } catch (err) {
      // Non-fatal, but it means a restart could forget part of today's count.
      logger.error({ err, path: this.path }, "Failed to persist daily budget");
    }
  }
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
