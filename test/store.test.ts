import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PRStateStore } from "../src/state/store.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "zanuda-store-test-"));
}

function makeState(
  overrides: Partial<Parameters<PRStateStore["set"]>[1]> = {},
) {
  return {
    ref: { owner: "acme", repo: "widget" },
    number: 42,
    rounds: 1,
    mentionReplies: 0,
    repliedCommentIds: new Set<number>(),
    maxRoundsNotified: false,
    progressCommentId: null,
    consecutiveFailures: 0,
    failedAwaitingRetry: false,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PRStateStore: basic read/write", () => {
  let dir: string;
  before(() => {
    dir = makeTmpDir();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("starts empty when no file exists", () => {
    const store = new PRStateStore(join(dir, "state.json"));
    assert.equal(store.has(1), false);
    assert.equal(store.get(1), undefined);
    assert.deepEqual([...store.entries()], []);
  });

  it("set() stores and get() retrieves the state", () => {
    const store = new PRStateStore(join(dir, "state.json"));
    const state = makeState({ rounds: 1 });
    store.set(100, state);
    const result = store.get(100);
    assert.ok(result);
    assert.equal(result.rounds, 1);
    assert.equal(result.ref.owner, "acme");
  });

  it("Set<number> is preserved through set/get", () => {
    const store = new PRStateStore(join(dir, "state.json"));
    const ids = new Set([10, 20, 30]);
    store.set(200, makeState({ repliedCommentIds: ids }));
    const result = store.get(200);
    assert.ok(result);
    assert.ok(result.repliedCommentIds instanceof Set);
    assert.deepEqual([...result.repliedCommentIds].sort(), [10, 20, 30]);
  });
});

describe("PRStateStore: persistence across restarts", () => {
  let dir: string;
  const filePath = () => join(dir, "state.json");
  before(() => {
    dir = makeTmpDir();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("second instance loads what first instance saved", () => {
    const store1 = new PRStateStore(filePath());
    store1.set(42, makeState({ rounds: 2, mentionReplies: 3 }));

    const store2 = new PRStateStore(filePath());
    const state = store2.get(42);
    assert.ok(state, "state should be loaded from disk");
    assert.equal(state.rounds, 2);
    assert.equal(state.mentionReplies, 3);
  });

  it("writes valid JSON with correct schema version", () => {
    const store = new PRStateStore(filePath());
    store.set(99, makeState());
    const raw = JSON.parse(readFileSync(filePath(), "utf8"));
    assert.equal(raw.version, 1);
    assert.ok(raw.prs["99"]);
    assert.ok(Array.isArray(raw.prs["99"].repliedCommentIds));
  });

  it("multiple set() calls all survive reload", () => {
    const store1 = new PRStateStore(filePath());
    store1.set(1, makeState({ rounds: 1 }));
    store1.set(2, makeState({ rounds: 2 }));
    store1.set(3, makeState({ rounds: 0 }));

    const store2 = new PRStateStore(filePath());
    assert.equal(store2.get(1)?.rounds, 1);
    assert.equal(store2.get(2)?.rounds, 2);
    assert.equal(store2.get(3)?.rounds, 0);
  });
});

describe("PRStateStore: stale-entry pruning", () => {
  let dir: string;
  before(() => {
    dir = makeTmpDir();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("prunes entries older than 30 days on load", () => {
    const filePath = join(dir, "prune-test.json");

    // Manually write a state file with one old and one recent entry.
    const old = new Date();
    old.setDate(old.getDate() - 31);
    const recent = new Date();

    const file = {
      version: 1,
      prs: {
        "1": {
          ref: { owner: "a", repo: "b" },
          number: 1,
          rounds: 1,
          mentionReplies: 0,
          repliedCommentIds: [],
          maxRoundsNotified: false,
          lastUpdatedAt: old.toISOString(),
        },
        "2": {
          ref: { owner: "a", repo: "b" },
          number: 2,
          rounds: 1,
          mentionReplies: 0,
          repliedCommentIds: [],
          maxRoundsNotified: false,
          lastUpdatedAt: recent.toISOString(),
        },
      },
    };
    writeFileSync(filePath, JSON.stringify(file));

    const store = new PRStateStore(filePath);
    assert.equal(store.has(1), false, "old entry should be pruned");
    assert.equal(store.has(2), true, "recent entry should be kept");
  });
});

describe("PRStateStore: corrupt/unknown file handling", () => {
  let dir: string;
  before(() => {
    dir = makeTmpDir();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("starts fresh when file contains invalid JSON", () => {
    const filePath = join(dir, "bad.json");
    writeFileSync(filePath, "not json {{{}}}");
    const store = new PRStateStore(filePath);
    assert.deepEqual([...store.entries()], []);
  });

  it("starts fresh when file has unknown version", () => {
    const filePath = join(dir, "future.json");
    writeFileSync(filePath, JSON.stringify({ version: 99, prs: {} }));
    const store = new PRStateStore(filePath);
    assert.deepEqual([...store.entries()], []);
  });
});

// ── new PRState fields: failedAwaitingRetry ──────────────────────────────────

describe("PRStateStore: new PRState fields", () => {
  let dir: string;
  before(() => {
    dir = makeTmpDir();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("persists and reloads failedAwaitingRetry", () => {
    const filePath = join(dir, "sha.json");
    const store1 = new PRStateStore(filePath);
    store1.set(1, makeState({ failedAwaitingRetry: true }));
    const store2 = new PRStateStore(filePath);
    assert.equal(store2.get(1)?.failedAwaitingRetry, true);
  });

  it("defaults missing failedAwaitingRetry to false for old state files", () => {
    const filePath = join(dir, "old-sha.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        prs: {
          "5": {
            ref: { owner: "a", repo: "b" },
            number: 5,
            rounds: 1,
            mentionReplies: 0,
            repliedCommentIds: [],
            maxRoundsNotified: false,
            progressCommentId: null,
            consecutiveFailures: 0,
            lastUpdatedAt: new Date().toISOString(),
            // failedAwaitingRetry intentionally absent
          },
        },
      }),
    );
    const store = new PRStateStore(filePath);
    assert.equal(store.get(5)?.failedAwaitingRetry, false);
  });

  it("defaults failedAwaitingRetry to false on fresh state", () => {
    const store = new PRStateStore(join(dir, "state.json"));
    store.set(
      1,
      makeState({
        rounds: 0,
        consecutiveFailures: 0,
        failedAwaitingRetry: false,
      }),
    );
    assert.equal(store.get(1)?.failedAwaitingRetry, false);
  });

  it("persists failedAwaitingRetry: true across reload", () => {
    const filePath = join(dir, "retry.json");
    const store1 = new PRStateStore(filePath);
    store1.set(
      99,
      makeState({
        failedAwaitingRetry: true,
        consecutiveFailures: 1,
        rounds: 0,
      }),
    );
    const store2 = new PRStateStore(filePath);
    assert.equal(store2.get(99)?.failedAwaitingRetry, true);
  });

  it("defaults missing failedAwaitingRetry to false for old state files", () => {
    const filePath = join(dir, "old.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        prs: {
          "7": {
            ref: { owner: "a", repo: "b" },
            number: 7,
            rounds: 1,
            mentionReplies: 0,
            repliedCommentIds: [],
            maxRoundsNotified: false,
            progressCommentId: null,
            consecutiveFailures: 2,
            lastUpdatedAt: new Date().toISOString(),
            // failedAwaitingRetry intentionally absent
          },
        },
      }),
    );
    const store = new PRStateStore(filePath);
    assert.equal(store.get(7)?.failedAwaitingRetry, false);
  });

  it("persists maxRoundsNotified: true across reload (final round threshold)", () => {
    // Regression guard: maxRoundsNotified must survive a store roundtrip as
    // true. Before the fix this would silently reset to false after the final
    // round completed, causing the notification to fire on every poll tick.
    const filePath = join(dir, "maxrounds.json");
    const store1 = new PRStateStore(filePath);
    store1.set(
      42,
      makeState({
        rounds: 2,
        maxRoundsNotified: true,
      }),
    );
    const store2 = new PRStateStore(filePath);
    const state = store2.get(42);
    assert.ok(state, "state should be loaded from disk");
    assert.equal(state.rounds, 2);
    assert.equal(state.maxRoundsNotified, true);
  });

  it("persists maxRoundsNotified: false after intermediate round", () => {
    // Companion to the test above: after round 1 (intermediate), the flag
    // should still be false since we haven't hit MAX_REVIEW_ROUNDS yet.
    const filePath = join(dir, "maxrounds-false.json");
    const store1 = new PRStateStore(filePath);
    store1.set(
      42,
      makeState({
        rounds: 1,
        maxRoundsNotified: false,
      }),
    );
    const store2 = new PRStateStore(filePath);
    const state = store2.get(42);
    assert.ok(state);
    assert.equal(state.rounds, 1);
    assert.equal(state.maxRoundsNotified, false);
  });
});
