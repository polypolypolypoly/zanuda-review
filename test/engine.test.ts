import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRepoConfig, type Config } from "../src/config.ts";
import { parseReviewResult, extractJson } from "../src/review/engine.ts";
import { truncate } from "../src/review/prompt.ts";

const baseConfig: Config = {
  provider: "anthropic",
  models: { anthropic: "a", openai: "b", openrouter: "c", ollama: "d" },
  generation: { temperature: 0.2, maxTokens: 4096 },
  preprompt: "Base preprompt.",
  context: { includeFiles: ["README.md"], maxFileChars: 1000, includeFileTree: true, maxTreeEntries: 100 },
  review: { maxDiffChars: 1000, inlineComments: true, event: "COMMENT" },
};

// ── parseReviewResult ────────────────────────────────────────────────────────

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

test("parseReviewResult: throws on garbage", () => {
  assert.throws(() => parseReviewResult("no json here"));
});

// ── extractJson ──────────────────────────────────────────────────────────────

test("extractJson: returns first { to matching } regardless of surrounding text", () => {
  assert.equal(extractJson('prefix {"a":1} suffix'), '{"a":1}');
});

test("extractJson: stops at matching brace, ignores later } in prose", () => {
  // Old lastIndexOf approach would grab up to the last } in the sentence.
  // New brace-depth scanner stops at the correct closing brace.
  assert.equal(extractJson('{"a":1} and then some } stray brace'), '{"a":1}');
});

test("extractJson: handles nested objects correctly", () => {
  assert.equal(extractJson('{"a":{"b":2}}'), '{"a":{"b":2}}');
});

test("extractJson: } inside a string value is not counted as closing brace", () => {
  const json = '{"key":"value with } brace"}';
  assert.equal(extractJson(json), json);
});

test("extractJson: throws when no opening brace present", () => {
  assert.throws(() => extractJson("no braces here"));
});

test("extractJson: throws on unterminated object", () => {
  assert.throws(() => extractJson('{"a": 1'));
});

// ── truncate ─────────────────────────────────────────────────────────────────

test("truncate: returns full string when under limit", () => {
  const r = truncate("hello\nworld", 100);
  assert.equal(r.text, "hello\nworld");
  assert.equal(r.truncated, false);
});

test("truncate: cuts at last newline before limit", () => {
  // "line1\n" = 6 chars, "line2\n" = 6 chars → at max=15 the last \n before
  // index 15 is at index 11 (end of "line2"), so result is "line1\nline2".
  const s = "line1\nline2\nline3\nline4";
  const r = truncate(s, 15);
  assert.equal(r.truncated, true);
  assert.ok(!r.text.includes("line3"), "should not contain text past the cut");
  assert.ok(r.text.endsWith("line2"), "should end on a complete line");
  assert.ok(r.text.length <= 15);
});

test("truncate: falls back to hard char cut when no newline before limit", () => {
  const s = "averylonglinewithoutnewlines";
  const r = truncate(s, 10);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 10);
});

test("truncate: exact limit is not truncated", () => {
  const s = "exactly10!";
  assert.equal(s.length, 10);
  const r = truncate(s, 10);
  assert.equal(r.truncated, false);
  assert.equal(r.text, s);
});

// ── mergeRepoConfig ──────────────────────────────────────────────────────────

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

test("mergeRepoConfig: does not mutate the base config", () => {
  const original = structuredClone(baseConfig);
  mergeRepoConfig(baseConfig, { provider: "openai", prepromptAppend: "extra" });
  assert.deepEqual(baseConfig, original);
});

test("mergeRepoConfig: explicit preprompt fully replaces base preprompt", () => {
  const merged = mergeRepoConfig(baseConfig, { preprompt: "Brand new." });
  assert.equal(merged.preprompt, "Brand new.");
});
