/**
 * Regression: on tg-bot#72 the batch review found two findings, verifyFindings
 * retracted both ("unverifiable or not worth raising"), yet the synthesis call
 * re-raised them from the batch notes and posted an "Observations" verdict on a
 * PR with zero surviving findings.
 *
 * The batch note (the model's batch-local summary) is written BEFORE
 * verification, so it can still name findings that verification drops. This
 * test locks in the fix: a batch whose findings were retracted gets a
 * deterministic note instead of its raw summary, so the synthesis only ever
 * sees what survived.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { summarizeBatchNote } from "../src/review/batch.js";
import { SYNTHESIS_SYSTEM } from "../src/review/synthesize.js";
import type { Config } from "../src/config.js";
import type { CompletionRequest, LLMProvider } from "../src/llm/types.js";
import type {
  FileChange,
  PullRequest,
  SCMConnector,
} from "../src/platform/types.js";
import type { ReviewResult } from "../src/review/types.js";

const calls: CompletionRequest[] = [];

const provider: LLMProvider = {
  name: "fake",
  supportsStructuredOutput: false,
  async complete(req) {
    calls.push(req);
    if (req.system === SYNTHESIS_SYSTEM) {
      return {
        text: JSON.stringify({
          prSummary: "Tags api usage.",
          summary: "The reviewed files raised no issues.",
          action: "APPROVE",
        }),
        model: "fake",
        provider: "fake",
      };
    }
    if (
      req.system.startsWith("You verify code review findings against a diff")
    ) {
      // Retract every finding the batch produced.
      return {
        text: JSON.stringify({ verifiedIndices: [], retractedIndices: [0] }),
        model: "fake",
        provider: "fake",
      };
    }
    // Batch review: one finding plus a batch-local summary that names it.
    return {
      text: JSON.stringify({
        prSummary: "",
        summary: "Found a null deref in a.ts.",
        action: "COMMENT",
        filesSummary: [{ path: "src/a.ts", description: "changed a" }],
        comments: [
          {
            path: "src/a.ts",
            line: 5,
            severity: "warning",
            body: "possible null deref",
          },
        ],
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
    verifyFindings: true,
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
  number: 72,
  title: "tag api usage",
  body: "Tags usage.",
  author: "alice",
  baseSha: "base",
  headSha: "head",
  diff: files.map((f) => f.patch).join("\n"),
  changedFiles: files.map((f) => f.filename),
  files,
  state: "open",
};

describe("summarizeBatchNote", () => {
  it("reports when every finding in a batch was dropped", () => {
    assert.equal(
      summarizeBatchNote(0, 3),
      "No findings from this batch survived verification.",
    );
  });

  it("reports a partial retraction with counts", () => {
    assert.equal(
      summarizeBatchNote(2, 5),
      "2 of 5 findings from this batch survived verification; see the findings list for the kept issues.",
    );
  });
});

describe("batch review: retracted findings don't leak into the verdict", () => {
  it("neutralizes the batch note and approves when all findings are retracted", async () => {
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
      { round: 1, forceStrategy: "batch" },
    );

    const synth = calls.filter((c) => c.system === SYNTHESIS_SYSTEM);
    assert.equal(synth.length, 1);
    const user = synth[0]!.user;

    // The retracted finding and its batch summary must not reach synthesis.
    assert.ok(
      !user.includes("possible null deref"),
      "retracted finding leaked",
    );
    assert.ok(
      !user.includes("Found a null deref in a.ts"),
      "raw batch summary leaked",
    );
    assert.ok(
      user.includes("No findings from this batch survived verification."),
      "neutralized note missing",
    );

    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.action, "APPROVE");
  });
});
