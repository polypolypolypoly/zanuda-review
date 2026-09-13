/**
 * Progress-placeholder ownership across a crash.
 *
 * The engine posts exactly one "_Starting review…_" comment per round. Its id
 * is reported to the caller AT CREATION so the poller can persist it before the
 * long LLM call: a crash mid-review then leaves an id the next run edits,
 * instead of an orphaned placeholder plus a fresh one.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { Config } from "../src/config.js";
import type { LLMProvider } from "../src/llm/types.js";
import type { PullRequest, SCMConnector } from "../src/platform/types.js";

const provider: LLMProvider = {
  name: "fake",
  supportsStructuredOutput: false,
  async complete() {
    return {
      text: JSON.stringify({
        prSummary: "Adds a button.",
        summary: "Nothing to flag.",
        action: "APPROVE",
        filesSummary: [],
        comments: [],
      }),
      model: "fake",
      provider: "fake",
    };
  },
};

const realLLM = await import("../src/llm/index.ts");
mock.module("../src/llm/index.ts", {
  namedExports: {
    ...Object.fromEntries(
      Object.entries(realLLM).filter(([, v]) => typeof v !== "undefined"),
    ),
    createProvider: mock.fn(() => provider),
  },
});

const { reviewPullRequest } = await import("../src/review/engine.ts");

const config = {
  provider: "anthropic",
  models: { anthropic: "fake-model" },
  generation: { temperature: 0, maxTokens: 1024 },
  preprompt: "Base preprompt.",
  persistence: { stateFile: "" },
  access: { allowlist: [] },
  limits: { maxConcurrentReviews: 3, maxNewPrsPerCycle: 5, maxBatches: 10 },
  memory: { enabled: false, dir: "", updateAfterReview: false },
  context: { includeFiles: [], maxFileChars: 100, includeFileTree: false },
  review: {
    maxDiffChars: 10_000,
    inlineComments: true,
    suggestions: false,
    maxCommentChars: 400,
    verifyFindings: false,
  },
} as unknown as Config;

const pr: PullRequest = {
  ref: { owner: "acme", repo: "widget" },
  number: 42,
  title: "feat: add button",
  body: "",
  author: "alice",
  baseSha: "base",
  headSha: "head",
  diff: "@@ -1 +1 @@\n+const x = 1;",
  changedFiles: ["src/button.ts"],
  files: [
    {
      filename: "src/button.ts",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1 @@\n+const x = 1;",
    },
  ],
  state: "open",
};

function fakeConnector(opts: { headShas?: string[] } = {}) {
  const posted: string[] = [];
  const edited: { id: number; body: string }[] = [];
  const deleted: number[] = [];
  const reviews: unknown[] = [];
  let nextId = 900;
  let fetchCount = 0;

  const connector = {
    name: "fake",
    async fetchPR() {
      // headShas lets a test move HEAD between the first fetch and the
      // stale-check re-fetch, simulating a push during the LLM call.
      const sha = opts.headShas?.[fetchCount] ?? pr.headSha;
      fetchCount++;
      return { ...pr, headSha: sha };
    },
    async readFile() {
      return null;
    },
    async getFileTree() {
      return { paths: [], truncated: false, total: 0 };
    },
    async fetchDiscussion() {
      return [];
    },
    async postReview(...args: unknown[]) {
      reviews.push(args[1]);
    },
    async postComment(_ref: unknown, _n: number, body: string) {
      posted.push(body);
      return nextId++;
    },
    async editComment(_ref: unknown, id: number, body: string) {
      edited.push({ id, body });
    },
    async deleteComment(_ref: unknown, id: number) {
      deleted.push(id);
    },
    async replyToComment() {},
    async listCommitShas() {
      return [];
    },
    async isReviewRequested() {
      return false;
    },
    async getReviewerLogin() {
      return "zanuda";
    },
    async pollPendingReviews() {
      return [];
    },
  } as unknown as SCMConnector;

  return { connector, posted, edited, deleted, reviews };
}

describe("reviewPullRequest: progress comment", () => {
  it("reports the placeholder id as soon as it is posted", async () => {
    const fake = fakeConnector();
    const seen: number[] = [];

    await reviewPullRequest(
      {
        connector: fake.connector,
        baseConfig: config,
        reviewerLogin: "zanuda",
      },
      pr.ref,
      pr.number,
      { round: 1, onProgressComment: (id) => seen.push(id) },
    );

    assert.equal(fake.posted.length, 1);
    assert.deepEqual(seen, [900], "callback must carry the posted comment id");
  });

  it("edits the existing placeholder on restart instead of posting a second one", async () => {
    const fake = fakeConnector();
    const seen: number[] = [];

    await reviewPullRequest(
      {
        connector: fake.connector,
        baseConfig: config,
        reviewerLogin: "zanuda",
      },
      pr.ref,
      pr.number,
      {
        round: 1,
        progressCommentId: 555,
        onProgressComment: (id) => seen.push(id),
      },
    );

    assert.equal(fake.posted.length, 0, "no second placeholder");
    assert.deepEqual(seen, [], "nothing new was created to report");
    assert.equal(fake.edited[0]!.id, 555);
    assert.deepEqual(fake.deleted, [555], "placeholder removed after posting");
  });

  it("reports nothing when the placeholder post fails", async () => {
    const fake = fakeConnector();
    const seen: number[] = [];
    (fake.connector as { postComment: unknown }).postComment = async () => {
      throw new Error("502");
    };

    await reviewPullRequest(
      {
        connector: fake.connector,
        baseConfig: config,
        reviewerLogin: "zanuda",
      },
      pr.ref,
      pr.number,
      { round: 1, onProgressComment: (id) => seen.push(id) },
    );

    assert.deepEqual(seen, []);
  });
});

// ─── Stale-commit guard ───────────────────────────────────────────────────────
//
// The LLM call takes 30-60 s. If the author pushed in that window, the result
// is anchored to code that no longer exists: posting it would mark every inline
// comment outdated and burn a review round. The engine re-checks HEAD and
// discards instead, telling the poller not to count the round.

describe("reviewPullRequest: stale-commit guard", () => {
  it("discards the result when HEAD moved during the review", async () => {
    const fake = fakeConnector({ headShas: ["head", "head-2"] });

    const result = await reviewPullRequest(
      {
        connector: fake.connector,
        baseConfig: config,
        reviewerLogin: "zanuda",
      },
      pr.ref,
      pr.number,
      { round: 1 },
    );

    assert.equal(result.stale, true);
    assert.equal(fake.reviews.length, 0, "nothing may be posted");
    assert.equal(result.headSha, "head", "reports the SHA it reviewed");
  });

  it("keeps the placeholder, edited to explain the discard", async () => {
    const fake = fakeConnector({ headShas: ["head", "head-2"] });

    const result = await reviewPullRequest(
      {
        connector: fake.connector,
        baseConfig: config,
        reviewerLogin: "zanuda",
      },
      pr.ref,
      pr.number,
      { round: 1 },
    );

    assert.equal(result.progressCommentId, 900);
    assert.deepEqual(fake.deleted, [], "placeholder is kept as the status");
    assert.match(fake.edited.at(-1)!.body, /New commits pushed/);
  });

  it("posts the review when HEAD is unchanged", async () => {
    const fake = fakeConnector();

    const result = await reviewPullRequest(
      {
        connector: fake.connector,
        baseConfig: config,
        reviewerLogin: "zanuda",
      },
      pr.ref,
      pr.number,
      { round: 1 },
    );

    assert.equal(result.stale, false);
    assert.equal(fake.reviews.length, 1);
    assert.deepEqual(fake.deleted, [900], "placeholder removed after posting");
  });

  it("proceeds when the stale check itself fails", async () => {
    const fake = fakeConnector();
    let calls = 0;
    (fake.connector as { fetchPR: unknown }).fetchPR = async () => {
      calls++;
      if (calls > 1) throw new Error("503");
      return pr;
    };

    const result = await reviewPullRequest(
      {
        connector: fake.connector,
        baseConfig: config,
        reviewerLogin: "zanuda",
      },
      pr.ref,
      pr.number,
      { round: 1 },
    );

    assert.equal(result.stale, false, "an unknown HEAD is not a stale HEAD");
    assert.equal(fake.reviews.length, 1);
  });
});
