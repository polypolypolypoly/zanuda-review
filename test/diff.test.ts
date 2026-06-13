import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPromptDiff, includedPaths } from "../src/review/diff.ts";
import type { FileChange } from "../src/platform/types.ts";

function makeFile(
  filename: string,
  additions: number,
  deletions: number,
  patch?: string,
): FileChange {
  return { filename, additions, deletions, patch };
}

// ─── buildPromptDiff ─────────────────────────────────────────────────────────

describe("buildPromptDiff", () => {
  it("includes all files when total patch size is within budget", () => {
    const files = [
      makeFile("a.ts", 10, 5, "patch-a"), // 7 chars
      makeFile("b.ts", 3, 1, "patch-bb"), // 8 chars
    ];
    const result = buildPromptDiff(files, 100);
    assert.equal(result.truncated, false);
    assert.equal(result.includedFiles.length, 2);
    assert.equal(result.excludedFiles.length, 0);
    assert.ok(result.text.includes("patch-a"));
    assert.ok(result.text.includes("patch-bb"));
  });

  it("excludes files when budget is exhausted", () => {
    const files = [
      makeFile("small.ts", 1, 0, "x".repeat(10)),
      makeFile("large.ts", 100, 50, "x".repeat(200)),
    ];
    const result = buildPromptDiff(files, 50);
    assert.equal(result.truncated, true);
    // large.ts has more changes so it is processed first but excluded (too big)
    assert.equal(result.includedFiles.length, 1);
    assert.equal(result.includedFiles[0]!.filename, "small.ts");
    assert.equal(result.excludedFiles.length, 1);
    assert.equal(result.excludedFiles[0]!.filename, "large.ts");
  });

  it("prioritises files by descending change volume", () => {
    const files = [
      makeFile("few-changes.ts", 2, 1, "x".repeat(20)), // 3 total changes
      makeFile("many-changes.ts", 50, 30, "x".repeat(20)), // 80 total changes
    ];
    // Both fit, but many-changes should appear first in includedFiles
    const result = buildPromptDiff(files, 100);
    assert.equal(result.includedFiles[0]!.filename, "many-changes.ts");
    assert.equal(result.includedFiles[1]!.filename, "few-changes.ts");
  });

  it("excludes files with no patch (binary / too large for platform)", () => {
    const files = [
      makeFile("binary.png", 0, 0, undefined), // no patch
      makeFile("code.ts", 10, 5, "some diff"),
    ];
    const result = buildPromptDiff(files, 10000);
    assert.equal(result.excludedFiles.length, 1);
    assert.equal(result.excludedFiles[0]!.filename, "binary.png");
    assert.equal(result.includedFiles.length, 1);
    assert.equal(result.includedFiles[0]!.filename, "code.ts");
    // No patch on excluded file → truncated is false (it's a different reason)
    assert.equal(result.truncated, false);
  });

  it("truncated is true only when a file with a patch was excluded due to budget", () => {
    const files = [
      makeFile("big.ts", 100, 100, "x".repeat(200)),
      makeFile("binary.png", 0, 0, undefined),
    ];
    // binary.png has no patch — excluded for a different reason
    // big.ts has a patch but doesn't fit — this causes truncated=true
    const result = buildPromptDiff(files, 10);
    assert.equal(result.truncated, true);
  });

  it("never cuts a file in the middle — always complete or excluded", () => {
    const patch = "line1\nline2\nline3\nline4\nline5";
    const files = [makeFile("f.ts", 5, 0, patch)];
    // Budget smaller than the patch — file must be fully excluded, not truncated
    const result = buildPromptDiff(files, patch.length - 1);
    assert.equal(result.includedFiles.length, 0);
    assert.equal(result.excludedFiles.length, 1);
    assert.equal(result.text, ""); // no partial content
  });

  it("joins included patches with newlines", () => {
    const files = [
      makeFile("a.ts", 1, 0, "patch-a"),
      makeFile("b.ts", 1, 0, "patch-b"),
    ];
    const result = buildPromptDiff(files, 1000);
    assert.equal(result.text, "patch-a\npatch-b");
  });
});

// ─── includedPaths ────────────────────────────────────────────────────────────

describe("includedPaths", () => {
  it("returns the set of filenames from includedFiles", () => {
    const files = [
      makeFile("src/a.ts", 1, 0, "patch"),
      makeFile("src/b.ts", 2, 0, "patch2"),
      makeFile("README.md", 0, 0, undefined), // excluded
    ];
    const diff = buildPromptDiff(files, 1000);
    const paths = includedPaths(diff);
    assert.ok(paths.has("src/a.ts"));
    assert.ok(paths.has("src/b.ts"));
    assert.equal(paths.has("README.md"), false);
  });
});
