import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProgressComment } from "../src/review/progress.js";
import type { RepoRef } from "../src/platform/types.js";

/**
 * ProgressComment owns the "_Starting review…_" placeholder lifecycle. The
 * guarantee under test: the placeholder is resolved EXACTLY ONCE on every
 * exit path and is never left orphaned — deterministic code, no LLM involved.
 */

const ref: RepoRef = { owner: "acme", repo: "widget" };
const noopLog = { warn: () => undefined };

function fakeConnector() {
  const edits: { commentId: number; body: string }[] = [];
  const deletes: { commentId: number }[] = [];
  return {
    edits,
    deletes,
    editComment: async (_ref: RepoRef, commentId: number, body: string) => {
      edits.push({ commentId, body });
    },
    deleteComment: async (_ref: RepoRef, commentId: number) => {
      deletes.push({ commentId });
    },
  };
}

describe("ProgressComment", () => {
  it("resolve() edits the placeholder once and reports success", async () => {
    const conn = fakeConnector();
    const p = new ProgressComment(conn, ref, 42, false, noopLog);
    const ok = await p.resolve("done");
    assert.equal(ok, true, "edit landed → true");
    assert.equal(p.isResolved, true);
    assert.deepEqual(conn.edits, [{ commentId: 42, body: "done" }]);
  });

  it("ensureResolved() is a no-op after a successful resolve (no clobber)", async () => {
    const conn = fakeConnector();
    const p = new ProgressComment(conn, ref, 42, false, noopLog);
    await p.resolve("the real verdict");
    await p.ensureResolved("FALLBACK");
    assert.equal(conn.edits.length, 1, "fallback must not overwrite verdict");
    assert.equal(conn.edits[0]!.body, "the real verdict");
  });

  it("ensureResolved() applies the fallback when no path resolved it", async () => {
    const conn = fakeConnector();
    const p = new ProgressComment(conn, ref, 42, false, noopLog);
    await p.ensureResolved("FALLBACK");
    assert.deepEqual(conn.edits, [{ commentId: 42, body: "FALLBACK" }]);
    assert.equal(p.isResolved, true);
    // Idempotent: calling again does nothing.
    await p.ensureResolved("AGAIN");
    assert.equal(conn.edits.length, 1);
  });

  it("delegate() marks resolved without editing (batch handoff)", async () => {
    const conn = fakeConnector();
    const p = new ProgressComment(conn, ref, 42, false, noopLog);
    p.delegate();
    assert.equal(p.isResolved, true);
    await p.ensureResolved("FALLBACK");
    assert.equal(conn.edits.length, 0, "delegate must not edit or fall back");
  });

  it("dry-run never edits but still counts as resolved", async () => {
    const conn = fakeConnector();
    const p = new ProgressComment(conn, ref, 42, true, noopLog);
    const ok = await p.resolve("done");
    assert.equal(ok, false, "no edit in dry-run → reported as not-landed");
    assert.equal(p.isResolved, true);
    await p.ensureResolved("FALLBACK");
    assert.equal(conn.edits.length, 0);
  });

  it("null placeholder (post failed) never edits and resolve() returns false", async () => {
    const conn = fakeConnector();
    const p = new ProgressComment(conn, ref, null, false, noopLog);
    const ok = await p.resolve("done");
    assert.equal(ok, false);
    await p.ensureResolved("FALLBACK");
    assert.equal(conn.edits.length, 0, "nothing to edit → no orphan possible");
  });

  it("resolve() reports false when the edit throws, and stays resolved", async () => {
    const edits: unknown[] = [];
    const conn = {
      edits,
      deleteComment: async () => {},
      editComment: async () => {
        throw new Error("API 500");
      },
    };
    const p = new ProgressComment(conn, ref, 42, false, noopLog);
    const ok = await p.resolve("done");
    assert.equal(
      ok,
      false,
      "failed edit → false so summary falls back to body",
    );
    assert.equal(
      p.isResolved,
      true,
      "still resolved — safety net won't refire",
    );
  });

  it("delete() removes the placeholder and counts as resolved", async () => {
    const conn = fakeConnector();
    const p = new ProgressComment(conn, ref, 42, false, noopLog);
    await p.delete();
    assert.equal(p.isResolved, true);
    assert.deepEqual(conn.deletes, [{ commentId: 42 }]);
    assert.equal(conn.edits.length, 0, "delete path never edits");
  });

  it("delete() is a no-op with no placeholder and stays resolved", async () => {
    const conn = fakeConnector();
    const p = new ProgressComment(conn, ref, null, false, noopLog);
    await p.delete();
    assert.equal(p.isResolved, true);
    assert.equal(conn.deletes.length, 0);
  });

  it("delete() swallows errors and stays resolved (stray placeholder is cosmetic)", async () => {
    const conn = {
      edits: [] as unknown[],
      deletes: [] as unknown[],
      deleteComment: async () => {
        throw new Error("API 500");
      },
      editComment: async () => {},
    };
    const p = new ProgressComment(conn, ref, 42, false, noopLog);
    await p.delete();
    assert.equal(p.isResolved, true);
  });

  it("ensureResolved() does not clobber after delete() (delete is a resolution)", async () => {
    const conn = fakeConnector();
    const p = new ProgressComment(conn, ref, 42, false, noopLog);
    await p.delete();
    await p.ensureResolved("FALLBACK");
    assert.equal(conn.deletes.length, 1);
    assert.equal(
      conn.edits.length,
      0,
      "fallback must not resurrect a deleted placeholder",
    );
  });
});
