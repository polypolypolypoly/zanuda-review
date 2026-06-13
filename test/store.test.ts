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

function makeState(overrides: Partial<Parameters<PRStateStore["set"]>[1]> = {}) {
  return {
    ref: { owner: "acme", repo: "widget" },
    number: 42,
    rounds: 1,
    mentionReplies: 0,
    repliedCommentIds: new Set<number>(),
    maxRoundsNotified: false,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PRStateStore: basic read/write", () => {
  let dir: string;
  before(() => { dir = makeTmpDir(); });
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
  before(() => { dir = makeTmpDir(); });
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
  before(() => { dir = makeTmpDir(); });
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
          ref: { owner: "a", repo: "b" }, number: 1, rounds: 1,
          mentionReplies: 0, repliedCommentIds: [], maxRoundsNotified: false,
          lastUpdatedAt: old.toISOString(),
        },
        "2": {
          ref: { owner: "a", repo: "b" }, number: 2, rounds: 1,
          mentionReplies: 0, repliedCommentIds: [], maxRoundsNotified: false,
          lastUpdatedAt: recent.toISOString(),
        },
      },
    };
    writeFileSync(filePath, JSON.stringify(file));

    const store = new PRStateStore(filePath);
    assert.equal(store.has(1), false, "old entry should be pruned");
    assert.equal(store.has(2), true,  "recent entry should be kept");
  });
});

describe("PRStateStore: corrupt/unknown file handling", () => {
  let dir: string;
  before(() => { dir = makeTmpDir(); });
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
