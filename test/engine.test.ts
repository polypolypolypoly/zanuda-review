import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRepoConfig, type Config } from "../src/config.ts";
import { parseReviewResult, extractJson } from "../src/review/engine.ts";
import { truncate } from "../src/review/prompt.ts";
import { findUnrepliedMentions, formatDiscussion, type PRComment } from "../src/github/comments.ts";

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
  const r = parseReviewResult('{"summary":"ok","action":"COMMENT","filesSummary":[],"comments":[]}');
  assert.equal(r.summary, "ok");
  assert.equal(r.action, "COMMENT");
  assert.equal(r.comments.length, 0);
  assert.equal(r.filesSummary.length, 0);
});

test("parseReviewResult: fenced JSON with prose", () => {
  const text = 'Here you go:\n```json\n{"summary":"s","action":"REQUEST_CHANGES","filesSummary":[{"path":"a.ts","description":"updated logic"}],"comments":[{"path":"a.ts","line":3,"severity":"warning","body":"x"}]}\n```';
  const r = parseReviewResult(text);
  assert.equal(r.action, "REQUEST_CHANGES");
  assert.equal(r.comments[0]?.path, "a.ts");
  assert.equal(r.comments[0]?.severity, "warning");
  assert.equal(r.filesSummary[0]?.description, "updated logic");
});

test("parseReviewResult: code block inside comment body does not confuse extractor", () => {
  // The model embedded a ```python fence inside a JSON string value (escaped
  // as \n in the JSON, as Claude actually outputs it). The old regex matched
  // the *inner* fence and returned raw code; the brace heuristic is immune.
  const json = '{"summary":"ok","action":"COMMENT","filesSummary":[],"comments":[{"path":"a.py","line":1,"severity":"warning","body":"Consider:\\n```python\\nif x:\\n    pass\\n```"}]}';
  const r = parseReviewResult(json);
  assert.equal(r.comments[0]?.path, "a.py");
});

test("parseReviewResult: JSON wrapped in code fence with nested snippet", () => {
  const body = "Use `sorted()` instead.";
  const json = `{"summary":"fine","action":"COMMENT","filesSummary":[{"path":"f.py","description":"d"}],"comments":[{"path":"f.py","line":5,"severity":"warning","body":"${body}"}]}`;
  const text = `Here is my review:\n\`\`\`json\n${json}\n\`\`\``;
  const r = parseReviewResult(text);
  assert.equal(r.comments[0]?.severity, "warning");
});

test("parseReviewResult: throws on garbage", () => {
  assert.throws(() => parseReviewResult("no json here"));
});

test("parseReviewResult: action field — APPROVE", () => {
  const r = parseReviewResult('{"summary":"lgtm","action":"APPROVE","filesSummary":[],"comments":[]}');
  assert.equal(r.action, "APPROVE");
});

test("parseReviewResult: action field — REQUEST_CHANGES", () => {
  const r = parseReviewResult('{"summary":"bad","action":"REQUEST_CHANGES","filesSummary":[],"comments":[{"path":"x.ts","line":1,"severity":"blocker","body":"vuln"}]}');
  assert.equal(r.action, "REQUEST_CHANGES");
});

test("parseReviewResult: throws on invalid action value", () => {
  assert.throws(() => parseReviewResult('{"summary":"x","action":"NITPICK","filesSummary":[],"comments":[]}'));
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

// ── findUnrepliedMentions ─────────────────────────────────────────────────────────────────────────

const makeComment = (overrides: Partial<PRComment>): PRComment => ({
  id: 1,
  type: "issue",
  author: "alice",
  body: "hello",
  createdAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

test("findUnrepliedMentions: returns comments mentioning the bot", () => {
  const comments = [
    makeComment({ id: 1, body: "hey @ZlayaZanuda is this ok?" }),
    makeComment({ id: 2, body: "no mention here" }),
  ];
  const result = findUnrepliedMentions(comments, "ZlayaZanuda", new Set());
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, 1);
});

test("findUnrepliedMentions: skips already-replied comment IDs", () => {
  const comments = [makeComment({ id: 1, body: "@ZlayaZanuda hello" })];
  const result = findUnrepliedMentions(comments, "ZlayaZanuda", new Set([1]));
  assert.equal(result.length, 0);
});

test("findUnrepliedMentions: skips the bot's own comments", () => {
  const comments = [
    makeComment({ id: 1, author: "ZlayaZanuda", body: "@ZlayaZanuda self-mention" }),
  ];
  const result = findUnrepliedMentions(comments, "ZlayaZanuda", new Set());
  assert.equal(result.length, 0);
});

test("findUnrepliedMentions: mention matching is case-insensitive", () => {
  const comments = [makeComment({ id: 1, body: "@zlayazanuda pls look" })];
  const result = findUnrepliedMentions(comments, "ZlayaZanuda", new Set());
  assert.equal(result.length, 1);
});

// ── formatDiscussion ────────────────────────────────────────────────────────────────────────────

test("formatDiscussion: empty list returns placeholder", () => {
  assert.equal(formatDiscussion([]), "(No discussion found.)");
});

test("formatDiscussion: includes author and body", () => {
  const comments = [makeComment({ id: 1, author: "alice", body: "looks good" })];
  const text = formatDiscussion(comments);
  assert.ok(text.includes("alice"));
  assert.ok(text.includes("looks good"));
});

test("formatDiscussion: includes file location for review comments", () => {
  const comments = [
    makeComment({ id: 1, type: "review", path: "src/foo.ts", line: 10, body: "bad" }),
  ];
  const text = formatDiscussion(comments);
  assert.ok(text.includes("src/foo.ts:10"));
});

test("formatDiscussion: truncates to maxComments and notes omitted count", () => {
  const comments = Array.from({ length: 10 }, (_, i) =>
    makeComment({ id: i, body: `comment ${i}`, createdAt: `2024-01-0${(i % 9) + 1}T00:00:00Z` }),
  );
  const text = formatDiscussion(comments, 3);
  assert.ok(text.includes("7 earlier comment(s) omitted"));
});

// ── Three-level config merge (global → org → repo) ───────────────────────────

test("mergeRepoConfig: org config overrides global, repo config overrides org", () => {
  const withPersistence: Config = {
    ...baseConfig,
    persistence: { stateFile: "" },
    access: { allowlist: [] },
    limits: { maxConcurrentReviews: 3, maxNewPrsPerCycle: 5 },
    memory: { enabled: true, dir: "", updateAfterReview: true },
  };

  const orgConfig = { provider: "openai" as const, prepromptAppend: " Org rule." };
  const repoConfig = { provider: "ollama" as const };

  const afterOrg  = mergeRepoConfig(withPersistence, orgConfig);
  const afterRepo = mergeRepoConfig(afterOrg, repoConfig);

  // Org overrides global
  assert.equal(afterOrg.provider, "openai");
  assert.ok(afterOrg.preprompt.includes("Org rule."));

  // Repo overrides org
  assert.equal(afterRepo.provider, "ollama");

  // Org prepromptAppend still present after repo merge
  assert.ok(afterRepo.preprompt.includes("Org rule."));
});

test("mergeRepoConfig: null org config is a no-op, repo config still applies", () => {
  const withPersistence: Config = {
    ...baseConfig,
    persistence: { stateFile: "" },
    access: { allowlist: [] },
    limits: { maxConcurrentReviews: 3, maxNewPrsPerCycle: 5 },
    memory: { enabled: true, dir: "", updateAfterReview: true },
  };

  const afterOrg  = mergeRepoConfig(withPersistence, null);
  const afterRepo = mergeRepoConfig(afterOrg, { provider: "openrouter" as const });

  assert.equal(afterOrg.provider, "anthropic");   // unchanged
  assert.equal(afterRepo.provider, "openrouter"); // repo wins
});
