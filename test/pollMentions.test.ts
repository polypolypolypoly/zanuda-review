/**
 * Mention-scan gates: who may spend money, and which repos still may at all.
 *
 * `retry` and `re-review` each cost a full LLM review round, and on a public
 * repo anyone can comment. Both are restricted to the PR author. The allowlist
 * is re-checked on every scan because state entries outlive membership.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/config.js";
import type { LLMProvider } from "../src/llm/types.js";
import type {
  PullRequest,
  RepoRef,
  SCMComment,
  SCMConnector,
} from "../src/platform/types.js";
import { pollMentions } from "../src/poller.js";
import { PRStateStore } from "../src/state/store.js";
import { freshState } from "../src/state/transitions.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REF: RepoRef = { owner: "acme", repo: "widget" };
const PLATFORM_ID = 1001;

const config = {
  provider: "anthropic",
  models: { anthropic: "a" },
  generation: { temperature: 0, maxTokens: 1024 },
  preprompt: "Base preprompt.",
  persistence: { stateFile: "" },
  access: { allowlist: ["acme"] },
  limits: { maxConcurrentReviews: 3, maxNewPrsPerCycle: 5 },
  memory: { enabled: false, dir: "", updateAfterReview: false },
  context: { includeFiles: [], maxFileChars: 100, includeFileTree: false },
  review: { maxDiffChars: 1000, inlineComments: true },
} as unknown as Config;

const provider: LLMProvider = {
  name: "fake",
  supportsStructuredOutput: false,
  async complete() {
    return {
      text: "A reply long enough to survive the minimum-length filter.",
      model: "fake",
      provider: "fake",
    };
  },
};

function mention(overrides: Partial<SCMComment> = {}): SCMComment {
  return {
    id: 7,
    type: "general",
    author: "author-login",
    body: "@zanuda re-review please",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Reply {
  body: string;
}

function makeConnector(
  comments: SCMComment[],
  prOverrides: Partial<PullRequest> = {},
): SCMConnector & { replies: Reply[] } {
  const replies: Reply[] = [];
  return {
    replies,
    name: "fake",
    async getReviewerLogin() {
      return "zanuda";
    },
    async pollPendingReviews() {
      return [];
    },
    async fetchPR() {
      return {
        ref: REF,
        number: 42,
        title: "feat: add button",
        body: "",
        author: "author-login",
        baseSha: "base",
        headSha: "head",
        diff: "",
        changedFiles: [],
        files: [],
        state: "open",
        ...prOverrides,
      } as PullRequest;
    },
    async readFile() {
      return null;
    },
    async getFileTree() {
      return { paths: [], truncated: false, total: 0 };
    },
    async fetchDiscussion() {
      return comments;
    },
    async postReview() {},
    async postComment() {
      return 1;
    },
    async editComment() {},
    async deleteComment() {},
    async replyToComment(_ref, _number, _comment, body) {
      replies.push({ body });
    },
    async listCommitShas() {
      return [];
    },
    async isReviewRequested() {
      return false;
    },
  };
}

let dir: string;
let store: PRStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zanuda-mentions-test-"));
  store = new PRStateStore(join(dir, "state.json"));
  store.set(PLATFORM_ID, { ...freshState(REF, 42), rounds: 1 });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (
  connector: SCMConnector,
  cfg: Config = config,
  prov: LLMProvider = provider,
) =>
  pollMentions({
    config: cfg,
    reviewerLogin: "zanuda",
    connector,
    store,
    provider: prov,
  });

// ─── Command gating ───────────────────────────────────────────────────────────

describe("pollMentions: author-only commands", () => {
  it("accepts a re-review command from the PR author", async () => {
    const connector = makeConnector([mention()]);
    await run(connector);

    assert.equal(store.get(PLATFORM_ID)!.reReviewRequested, true);
    assert.deepEqual(
      connector.replies.map((r) => r.body),
      ["Starting re-review."],
    );
  });

  it("refuses a re-review command from anyone else", async () => {
    const connector = makeConnector([mention({ author: "drive-by" })]);
    await run(connector);

    const state = store.get(PLATFORM_ID)!;
    assert.equal(state.reReviewRequested, false);
    assert.ok(connector.replies[0].body.includes("Only the PR author"));
    // The mention is consumed so it is not reprocessed every tick.
    assert.ok(state.repliedCommentIds.has(7));
    assert.equal(state.mentionReplies, 1);
  });

  it("refuses a retry command from anyone else", async () => {
    store.set(PLATFORM_ID, {
      ...freshState(REF, 42),
      rounds: 0,
      failedAwaitingRetry: true,
    });
    const connector = makeConnector([
      mention({ author: "drive-by", body: "@zanuda retry" }),
    ]);
    await run(connector);

    assert.equal(store.get(PLATFORM_ID)!.failedAwaitingRetry, true);
    assert.ok(connector.replies[0].body.includes("Only the PR author"));
  });

  it("withholds commands when the PR fetch fails, leaving the mention unread", async () => {
    const connector = makeConnector([mention()]);
    connector.fetchPR = async () => {
      throw new Error("502");
    };
    await run(connector);

    const state = store.get(PLATFORM_ID)!;
    assert.equal(state.reReviewRequested, false);
    assert.equal(connector.replies.length, 0);
    assert.ok(!state.repliedCommentIds.has(7));
  });

  it("still answers a plain mention from a non-author", async () => {
    const connector = makeConnector([
      mention({ author: "drive-by", body: "@zanuda what does this do?" }),
    ]);
    await run(connector);

    assert.equal(store.get(PLATFORM_ID)!.mentionReplies, 1);
    assert.ok(connector.replies[0].body.includes("A reply long enough"));
  });

  it("consumes a mention even when the generated reply is dropped", async () => {
    const connector = makeConnector([
      mention({ author: "author-login", body: "@zanuda what does this do?" }),
    ]);
    const garbageProvider: LLMProvider = {
      name: "fake",
      supportsStructuredOutput: false,
      async complete() {
        return { text: "ok", model: "fake", provider: "fake" };
      },
    };

    await run(connector, config, garbageProvider);

    // Nothing posted, but the mention is still marked replied so a model that
    // keeps producing sub-min-length replies cannot be retried indefinitely.
    const state = store.get(PLATFORM_ID)!;
    assert.equal(connector.replies.length, 0);
    assert.equal(state.mentionReplies, 1);
    assert.ok(state.repliedCommentIds.has(7));
  });
});

// ─── Allowlist ────────────────────────────────────────────────────────────────

describe("pollMentions: allowlist", () => {
  it("skips a repo that is no longer allowlisted", async () => {
    const connector = makeConnector([mention()]);
    const delisted = {
      ...config,
      access: { allowlist: ["someone-else"] },
    } as Config;

    await run(connector, delisted);

    assert.equal(store.get(PLATFORM_ID)!.reReviewRequested, false);
    assert.equal(connector.replies.length, 0);
  });
});
