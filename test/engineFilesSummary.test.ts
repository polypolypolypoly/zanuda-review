/**
 * The file table and "Checked N of M" scope come from what the code sent to the
 * model, not from how many filesSummary rows the model bothered to write.
 *
 * Regression: tg-bot#70 sent all 29 files across 3 batches, the model described
 * 20, and the review header read "Checked 20 of 29 files".
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { Config } from "../src/config.js";
import type { LLMProvider } from "../src/llm/types.js";
import type {
  FileChange,
  PullRequest,
  SCMConnector,
} from "../src/platform/types.js";
import type { ReviewResult } from "../src/review/types.js";

// The model describes only src/a.ts, whatever it was shown.
const provider: LLMProvider = {
  name: "fake",
  supportsStructuredOutput: false,
  async complete() {
    return {
      text: JSON.stringify({
        prSummary: "Removes dead code.",
        summary: "Nothing to flag.",
        action: "COMMENT",
        filesSummary: [{ path: "src/a.ts", description: "drops helper" }],
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

const file = (name: string, del: number): FileChange => ({
  filename: name,
  additions: 0,
  deletions: del,
  patch: `@@ -1,${del} +0,0 @@\n` + "-old line\n".repeat(del),
});

const files = [
  file("src/a.ts", 60),
  file("src/b.ts", 60),
  file("src/c.ts", 60),
];

const pr: PullRequest = {
  ref: { owner: "acme", repo: "widget" },
  number: 7,
  title: "cleanup",
  body: "",
  author: "alice",
  baseSha: "base",
  headSha: "head",
  diff: files.map((f) => f.patch).join("\n"),
  changedFiles: files.map((f) => f.filename),
  files,
  state: "open",
};

function fakeConnector() {
  const reviews: { result: ReviewResult; visible?: Set<string> }[] = [];
  const connector = {
    name: "fake",
    async fetchPR() {
      return pr;
    },
    async readFile() {
      return null;
    },
    async getFileTree() {
      return { paths: [], truncated: false, total: 0 };
    },
    async postReview(
      _pr: unknown,
      result: ReviewResult,
      _config: unknown,
      opts?: { visibleFilePaths?: Set<string> },
    ) {
      reviews.push({ result, visible: opts?.visibleFilePaths });
    },
    async postComment() {
      return 1;
    },
    async editComment() {},
    async deleteComment() {},
  } as unknown as SCMConnector;
  return { connector, reviews };
}

for (const strategy of ["single", "batch"] as const) {
  describe(`reviewPullRequest (${strategy}): file table completeness`, () => {
    it("lists every reviewed file, filling rows the model skipped", async () => {
      const fake = fakeConnector();
      await reviewPullRequest(
        { connector: fake.connector, baseConfig: config },
        pr.ref,
        pr.number,
        { round: 1, forceStrategy: strategy },
      );

      assert.equal(fake.reviews.length, 1);
      const { result, visible } = fake.reviews[0]!;
      assert.deepEqual(
        result.filesSummary.map((f) => f.path),
        ["src/a.ts", "src/b.ts", "src/c.ts"],
      );
      assert.equal(result.filesSummary[0]!.description, "drops helper");
      assert.equal(result.filesSummary[1]!.description, "+0 −60 lines");
      assert.deepEqual([...(visible ?? [])].sort(), [
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
      ]);
    });
  });
}
