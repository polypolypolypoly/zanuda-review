/**
 * Multi-batch reviews get their PR-wide summary and verdict from a synthesis
 * call over the final findings — never from the last batch alone.
 *
 * Regression: on tg-bot#70 the last batch, seeing only its own files, returned
 * REQUEST_CHANGES with zero findings and a summary that argued with itself and
 * claimed issues in files it never saw. That summary was posted verbatim.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { Config } from "../src/config.js";
import type { CompletionRequest, LLMProvider } from "../src/llm/types.js";
import type {
  FileChange,
  PullRequest,
  SCMConnector,
} from "../src/platform/types.js";
import { SYNTHESIS_SYSTEM } from "../src/review/synthesize.js";
import type { ReviewResult } from "../src/review/types.js";

const calls: CompletionRequest[] = [];
let synthesisReply: string | Error = JSON.stringify({
  prSummary: "Removes unused features and dead code.",
  summary: "Clean removal; the reviewed files raised no issues.",
  action: "APPROVE",
});

const provider: LLMProvider = {
  name: "fake",
  supportsStructuredOutput: false,
  async complete(req) {
    calls.push(req);
    if (req.system === SYNTHESIS_SYSTEM) {
      if (synthesisReply instanceof Error) throw synthesisReply;
      return { text: synthesisReply, model: "fake", provider: "fake" };
    }
    // Every batch: the tg-bot#70 shape — a blind, self-correcting verdict.
    return {
      text: JSON.stringify({
        prSummary: "Batch-local guess at the whole PR.",
        summary: "x.py still... actually it is removed. y.py wait—removed.",
        action: "REQUEST_CHANGES",
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
    maxCommentsPerReview: 10,
    round2Warnings: false,
  },
} as unknown as Config;

const file = (name: string): FileChange => ({
  filename: name,
  additions: 0,
  deletions: 60,
  patch: "@@ -1,60 +0,0 @@\n" + "-old line\n".repeat(60),
});
const files = [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")];

const pr: PullRequest = {
  ref: { owner: "acme", repo: "widget" },
  number: 70,
  title: "cleanup",
  body: "Removes dead code.",
  author: "alice",
  baseSha: "base",
  headSha: "head",
  diff: files.map((f) => f.patch).join("\n"),
  changedFiles: files.map((f) => f.filename),
  files,
  state: "open",
};

async function runBatchReview(): Promise<ReviewResult> {
  calls.length = 0;
  const posted: ReviewResult[] = [];
  const connector = {
    name: "fake",
    fetchPR: async () => pr,
    readFile: async () => null,
    getFileTree: async () => ({ paths: [], truncated: false, total: 0 }),
    postReview: async (_pr: unknown, result: ReviewResult) => {
      posted.push(result);
    },
    postComment: async () => 1,
    editComment: async () => {},
    deleteComment: async () => {},
  } as unknown as SCMConnector;

  await reviewPullRequest(
    { connector, baseConfig: config },
    pr.ref,
    pr.number,
    {
      round: 1,
      forceStrategy: "batch",
    },
  );
  assert.equal(posted.length, 1);
  return posted[0]!;
}

describe("batch review: PR-wide verdict comes from synthesis", () => {
  it("posts the synthesis summary, not the last batch's", async () => {
    synthesisReply = JSON.stringify({
      prSummary: "Removes unused features and dead code.",
      summary: "Clean removal; the reviewed files raised no issues.",
      action: "APPROVE",
    });
    const result = await runBatchReview();

    assert.equal(
      result.summary,
      "Clean removal; the reviewed files raised no issues.",
    );
    assert.equal(result.prSummary, "Removes unused features and dead code.");
    assert.equal(result.action, "APPROVE");

    // One call per batch, then exactly one synthesis call that saw every
    // batch's notes.
    const synth = calls.filter((c) => c.system === SYNTHESIS_SYSTEM);
    assert.equal(synth.length, 1);
    const batchCount = calls.length - 1;
    assert.ok(batchCount > 1, "fixture must split into several batches");
    for (let b = 1; b <= batchCount; b++) {
      assert.ok(synth[0]!.user.includes(`[batch ${b}:`), `batch ${b} note`);
    }
  });

  it("no batch prompt asks for the PR-wide verdict", async () => {
    await runBatchReview();
    for (const c of calls.filter((c) => c.system !== SYNTHESIS_SYSTEM)) {
      assert.ok(!c.user.includes("summary` that covers the full PR"));
      assert.ok(c.user.includes("written after all batches"));
    }
  });

  it("never posts REQUEST_CHANGES or a self-correcting summary on a failed synthesis", async () => {
    synthesisReply = new Error("400 bad request");
    const result = await runBatchReview();
    assert.equal(result.action, "COMMENT");
    assert.equal(result.summary, "No issues found in the reviewed files.");
    assert.equal(result.prSummary, "");
  });

  it("replaces a self-correcting synthesis summary", async () => {
    synthesisReply = JSON.stringify({
      prSummary: "Removes code.",
      summary: "Imports are stale... actually they were removed.",
      action: "REQUEST_CHANGES",
    });
    const result = await runBatchReview();
    assert.equal(result.summary, "No issues found in the reviewed files.");
    assert.equal(result.action, "COMMENT");
  });
});
