import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRepoConfig, type Config } from "../src/config.ts";
import { parseReviewResult } from "../src/review/engine.ts";

const baseConfig: Config = {
  provider: "anthropic",
  models: { anthropic: "a", openai: "b", openrouter: "c", ollama: "d" },
  generation: { temperature: 0.2, maxTokens: 4096 },
  preprompt: "Base preprompt.",
  context: { includeFiles: ["README.md"], maxFileChars: 1000, includeFileTree: true, maxTreeEntries: 100 },
  review: { maxDiffChars: 1000, inlineComments: true, event: "COMMENT" },
};

test("parseReviewResult: plain JSON", () => {
  const r = parseReviewResult('{"summary":"ok","filesSummary":[],"comments":[]}');
  assert.equal(r.summary, "ok");
  assert.equal(r.comments.length, 0);
  assert.equal(r.filesSummary.length, 0);
});

test("parseReviewResult: fenced JSON with prose", () => {
  const text = 'Here you go:\n```json\n{"summary":"s","filesSummary":[{"path":"a.ts","description":"updated logic"}],"comments":[{"path":"a.ts","line":3,"severity":"warning","body":"x"}]}\n```';
  const r = parseReviewResult(text);
  assert.equal(r.comments[0]?.path, "a.ts");
  assert.equal(r.comments[0]?.severity, "warning");
  assert.equal(r.filesSummary[0]?.description, "updated logic");
});

test("parseReviewResult: throws on garbage", () => {
  assert.throws(() => parseReviewResult("no json here"));
});

test("mergeRepoConfig: null repo config is a no-op", () => {
  assert.deepEqual(mergeRepoConfig(baseConfig, null), baseConfig);
});

test("mergeRepoConfig: prepromptAppend concatenates", () => {
  const merged = mergeRepoConfig(baseConfig, { prepromptAppend: "Extra rule." });
  assert.equal(merged.preprompt, "Base preprompt.\n\nExtra rule.");
});

test("mergeRepoConfig: per-section override merges shallowly", () => {
  const merged = mergeRepoConfig(baseConfig, {
    provider: "ollama",
    review: { inlineComments: false },
  });
  assert.equal(merged.provider, "ollama");
  assert.equal(merged.review.inlineComments, false);
  assert.equal(merged.review.event, "COMMENT"); // untouched
});
