/**
 * Progress-placeholder lifecycle.
 *
 * Every review round posts exactly one "_Starting review…_" placeholder
 * comment, and that placeholder must be resolved exactly once — on whatever
 * exit path the review takes (skip / stale / success / error / handoff). This
 * is deterministic bookkeeping that belongs in code, never in the LLM: the
 * model decides WHAT to say, never HOW MANY comments to post.
 *
 * Owning the placeholder in one small object makes "resolve exactly once, never
 * orphan it" a structural guarantee rather than something every new return path
 * has to remember. See ProgressComment.ensureResolved() for the safety net.
 */

import type { RepoRef, SCMConnector } from "../platform/types.js";

/** Minimal logger surface — compatible with a pino child logger. */
interface WarnLogger {
  warn(obj: unknown, msg?: string): void;
}

export class ProgressComment {
  private resolved = false;

  constructor(
    private readonly connector: Pick<SCMConnector, "editComment">,
    private readonly ref: RepoRef,
    /** null when no placeholder was posted (dry-run, or the post failed). */
    private readonly commentId: number | null,
    private readonly dryRun: boolean,
    private readonly log: WarnLogger,
  ) {}

  /** True once any path has taken ownership of the placeholder. */
  get isResolved(): boolean {
    return this.resolved;
  }

  /**
   * Resolve the placeholder by editing it to `body`. Best-effort: a failed edit
   * still counts as resolved (we tried — the safety net is for forgotten paths,
   * not transient API errors). No-op when there is no placeholder to edit.
   *
   * Returns true only when an edit actually landed on a real comment — callers
   * use this to decide whether the summary now lives in the placeholder
   * (summaryPostedElsewhere) or must fall back into the review-event body.
   */
  async resolve(body: string): Promise<boolean> {
    this.resolved = true;
    if (this.dryRun || this.commentId === null) return false;
    try {
      await this.connector.editComment(this.ref, this.commentId, body);
      return true;
    } catch (err) {
      this.log.warn({ err }, "Failed to resolve progress comment");
      return false;
    }
  }

  /**
   * Hand the placeholder's lifecycle off to another path (e.g. the batch
   * reviewer) that will resolve it itself. Marks it resolved here without
   * editing, so the safety net doesn't clobber the delegate's final verdict.
   */
  delegate(): void {
    this.resolved = true;
  }

  /**
   * Safety net: if no path resolved the placeholder, edit it to a neutral
   * `fallback` instead of leaving a stale "_Starting review…_" forever, and
   * warn so the offending path can be fixed. No-op once resolved.
   */
  async ensureResolved(fallback: string): Promise<void> {
    if (this.resolved || this.dryRun || this.commentId === null) return;
    this.resolved = true;
    this.log.warn(
      "Progress comment left unresolved by review path — applying fallback",
    );
    try {
      await this.connector.editComment(this.ref, this.commentId, fallback);
    } catch {
      // best-effort
    }
  }
}
