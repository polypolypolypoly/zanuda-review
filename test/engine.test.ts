import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRepoConfig, type Config } from "../src/config.ts";
import { parseReviewResult, extractJson } from "../src/review/engine.ts";

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

test("parseReviewResult: code block inside comment body does not confuse extractor", () => {
  // The model embedded a ```python fence inside a JSON string value (escaped
  // as \n in the JSON, as Claude actually outputs it). The old regex matched
  // the *inner* fence and returned raw code; the brace heuristic is immune.
  const json = '{"summary":"ok","filesSummary":[],"comments":[{"path":"a.py","line":1,"severity":"nitpick","body":"Consider:\\n```python\\nif x:\\n    pass\\n```"}]}';
  const r = parseReviewResult(json);
  assert.equal(r.comments[0]?.path, "a.py");
});

test("parseReviewResult: JSON wrapped in code fence with nested snippet", () => {
  const body = "Use `sorted()` instead.";
  const json = `{"summary":"fine","filesSummary":[{"path":"f.py","description":"d"}],"comments":[{"path":"f.py","line":5,"severity":"warning","body":"${body}"}]}`;
  const text = `Here is my review:\n\`\`\`json\n${json}\n\`\`\``;
  const r = parseReviewResult(text);
  assert.equal(r.comments[0]?.severity, "warning");
});

test("extractJson: returns first { to last } regardless of surrounding text", () => {
  assert.equal(extractJson("prefix {\"a\":1} suffix"), '{"a":1}');
});

test("extractJson: throws when no braces present", () => {
  assert.throws(() => extractJson("no braces here"));
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
