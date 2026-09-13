import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fencedBlock, formatDiscussion } from "../src/review/format.js";
import type { SCMComment } from "../src/platform/types.js";

function comment(overrides: Partial<SCMComment> = {}): SCMComment {
  return {
    id: 1,
    type: "general",
    author: "alice",
    body: "hello",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("fencedBlock", () => {
  it("uses a three-backtick fence for ordinary content", () => {
    assert.equal(fencedBlock("const x = 1;", "ts"), "```ts\nconst x = 1;\n```");
  });

  it("grows the fence past any backtick run inside the content", () => {
    const out = fencedBlock("a\n```\nb");
    assert.ok(out.startsWith("````\n"));
    assert.ok(out.endsWith("\n````"));
  });

  it("counts indented fences — GFM closes with up to three spaces", () => {
    const out = fencedBlock("a\n   `````\nb");
    assert.ok(out.startsWith("``````\n"));
  });

  it("ignores backticks that are not at the start of a line", () => {
    assert.equal(fencedBlock("x = `````;"), "```\nx = `````;\n```");
  });

  it("never modifies the content", () => {
    const content = "  ```\n\tmore ```\n";
    const out = fencedBlock(content, "suggestion");
    assert.ok(out.includes(`\n${content}\n`));
  });
});

describe("formatDiscussion", () => {
  it("truncates an oversized comment body", () => {
    const out = formatDiscussion([comment({ body: "x".repeat(70_000) })]);
    assert.ok(out.length < 3000, `discussion was ${out.length} chars`);
    assert.ok(out.includes("_(comment truncated)_"));
  });

  it("leaves a normal comment intact", () => {
    const out = formatDiscussion([comment({ body: "looks good to me" })]);
    assert.ok(out.includes("looks good to me"));
    assert.ok(!out.includes("truncated"));
  });

  it("bounds total size across the comment-count cap", () => {
    const flood = Array.from({ length: 50 }, (_, i) =>
      comment({ id: i, body: "y".repeat(65_536) }),
    );
    const out = formatDiscussion(flood, 20);
    assert.ok(out.length < 60_000, `discussion was ${out.length} chars`);
  });
});
