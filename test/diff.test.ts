import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPromptDiff,
  includedPaths,
  assembleBatchDiff,
  batchFilePaths,
  parseValidNewLines,
  buildValidLineMap,
} from "../src/review/diff.js";
import type { FileChange } from "../src/platform/types.js";
import type { HeaderedFile } from "../src/review/header.js";

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
      makeFile("a.ts", 10, 5, "patch-a"),
      makeFile("b.ts", 3, 1, "patch-bb"),
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
    assert.equal(result.includedFiles.length, 1);
    assert.equal(result.includedFiles[0]!.filename, "small.ts");
    assert.equal(result.excludedFiles.length, 1);
    assert.equal(result.excludedFiles[0]!.filename, "large.ts");
  });

  it("prioritises files by descending change volume", () => {
    const files = [
      makeFile("few-changes.ts", 2, 1, "x".repeat(20)),
      makeFile("many-changes.ts", 50, 30, "x".repeat(20)),
    ];
    const result = buildPromptDiff(files, 100);
    assert.equal(result.includedFiles[0]!.filename, "many-changes.ts");
    assert.equal(result.includedFiles[1]!.filename, "few-changes.ts");
  });

  it("excludes files with no patch (binary / too large for platform)", () => {
    const files = [
      makeFile("binary.png", 0, 0, undefined),
      makeFile("code.ts", 10, 5, "some diff"),
    ];
    const result = buildPromptDiff(files, 10000);
    assert.equal(result.excludedFiles.length, 1);
    assert.equal(result.excludedFiles[0]!.filename, "binary.png");
    assert.equal(result.includedFiles.length, 1);
    assert.equal(result.includedFiles[0]!.filename, "code.ts");
    assert.equal(result.truncated, false);
  });

  it("truncated is true only when a file with a patch was excluded due to budget", () => {
    const files = [
      makeFile("big.ts", 100, 100, "x".repeat(200)),
      makeFile("binary.png", 0, 0, undefined),
    ];
    const result = buildPromptDiff(files, 10);
    assert.equal(result.truncated, true);
  });

  it("never cuts a file in the middle — always complete or excluded", () => {
    const patch = "line1\nline2\nline3\nline4\nline5";
    const files = [makeFile("f.ts", 5, 0, patch)];
    const result = buildPromptDiff(files, patch.length - 1);
    assert.equal(result.includedFiles.length, 0);
    assert.equal(result.excludedFiles.length, 1);
    assert.equal(result.text, "");
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
      makeFile("README.md", 0, 0, undefined),
    ];
    const diff = buildPromptDiff(files, 1000);
    const paths = includedPaths(diff);
    assert.ok(paths.has("src/a.ts"));
    assert.ok(paths.has("src/b.ts"));
    assert.equal(paths.has("README.md"), false);
  });
});

// ─── assembleBatchDiff ─────────────────────────────────────────────────────

describe("assembleBatchDiff", () => {
  it("includes file headers and diffs", () => {
    const files: HeaderedFile[] = [
      {
        filename: "src/foo.ts",
        header: "import { bar } from './bar';\n",
        patch: "@@ -1,3 +1,4 @@\n+new line\n",
        weight: 100,
      },
    ];

    const result = assembleBatchDiff(files);
    assert.ok(result.text.includes("### `src/foo.ts`"));
    assert.ok(result.text.includes("```typescript"));
    assert.ok(result.text.includes("import { bar }"));
    assert.ok(result.text.includes("```diff"));
    assert.ok(result.text.includes("+new line"));
    assert.equal(result.files.length, 1);
  });

  it("includes multiple files", () => {
    const files: HeaderedFile[] = [
      { filename: "a.ts", header: "// a\n", patch: "diff-a", weight: 20 },
      { filename: "b.ts", header: "// b\n", patch: "diff-b", weight: 20 },
    ];

    const result = assembleBatchDiff(files);
    assert.ok(result.text.includes("### `a.ts`"));
    assert.ok(result.text.includes("### `b.ts`"));
    assert.equal(result.files.length, 2);
  });

  it("handles empty header", () => {
    const files: HeaderedFile[] = [
      { filename: "empty.ts", header: "", patch: "diff", weight: 4 },
    ];

    const result = assembleBatchDiff(files);
    assert.ok(result.text.includes("### `empty.ts`"));
    assert.ok(!result.text.includes("```typescript"));
    assert.ok(result.text.includes("```diff"));
  });

  it("guesses language from extension", () => {
    const files: HeaderedFile[] = [
      {
        filename: "contract.sol",
        header: "pragma solidity",
        patch: "diff",
        weight: 30,
      },
      { filename: "script.py", header: "import os", patch: "diff", weight: 25 },
      { filename: "main.rs", header: "use std", patch: "diff", weight: 22 },
      {
        filename: "server.go",
        header: "package main",
        patch: "diff",
        weight: 28,
      },
      {
        filename: "config.yaml",
        header: "key: value",
        patch: "diff",
        weight: 26,
      },
      { filename: "data.json", header: "{", patch: "diff", weight: 15 },
      { filename: "README.md", header: "# Title", patch: "diff", weight: 20 },
      { filename: "unknown.xyz", header: "stuff", patch: "diff", weight: 22 },
    ];

    const result = assembleBatchDiff(files);
    assert.ok(result.text.includes("```solidity"));
    assert.ok(result.text.includes("```python"));
    assert.ok(result.text.includes("```rust"));
    assert.ok(result.text.includes("```go"));
    assert.ok(result.text.includes("```yaml"));
    assert.ok(result.text.includes("```json"));
    assert.ok(result.text.includes("```markdown"));
  });
});

// ─── batchFilePaths ─────────────────────────────────────────────────────────

describe("batchFilePaths", () => {
  it("returns set of filenames in the batch", () => {
    const files: HeaderedFile[] = [
      { filename: "a.ts", header: "", patch: "diff", weight: 4 },
      { filename: "b.ts", header: "", patch: "diff", weight: 4 },
      { filename: "c.ts", header: "", patch: "diff", weight: 4 },
    ];
    const batch = assembleBatchDiff(files);
    const paths = batchFilePaths(batch);
    assert.deepStrictEqual(paths, new Set(["a.ts", "b.ts", "c.ts"]));
  });

  it("returns empty set for empty batch", () => {
    const batch = assembleBatchDiff([]);
    assert.equal(batchFilePaths(batch).size, 0);
  });
});

// ── parseValidNewLines ────────────────────────────────────────────────────────

describe("parseValidNewLines", () => {
  it("extracts context and addition lines, skips deletions", () => {
    const patch = [
      "@@ -1,4 +1,5 @@",
      " context", // line 1 — valid
      "+added", // line 2 — valid
      " context2", // line 3 — valid
      "-deleted", // not in new file
      " context3", // line 4 — valid
    ].join("\n");
    const valid = parseValidNewLines(patch);
    assert.deepEqual(
      [...valid].sort((a, b) => a - b),
      [1, 2, 3, 4],
    );
  });

  it("handles multiple hunks with correct line offsets", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      " line1", // new line 1
      "+line2", // new line 2
      "@@ -10,2 +10,3 @@",
      " line10", // new line 10
      "+line11", // new line 11
      " line12", // new line 12
    ].join("\n");
    const valid = parseValidNewLines(patch);
    assert.deepEqual(
      [...valid].sort((a, b) => a - b),
      [1, 2, 10, 11, 12],
    );
  });

  it("handles new-file patch (@@ -0,0 +1,3 @@)", () => {
    const patch = ["@@ -0,0 +1,3 @@", "+line1", "+line2", "+line3"].join("\n");
    const valid = parseValidNewLines(patch);
    assert.deepEqual(
      [...valid].sort((a, b) => a - b),
      [1, 2, 3],
    );
  });

  it("skips file header lines (--- / +++)", () => {
    const patch = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    const valid = parseValidNewLines(patch);
    assert.deepEqual(
      [...valid].sort((a, b) => a - b),
      [1],
    );
  });

  it("returns empty set for patch with only deletions", () => {
    const patch = ["@@ -1,2 +0,0 @@", "-line1", "-line2"].join("\n");
    assert.equal(parseValidNewLines(patch).size, 0);
  });

  it("returns empty set for empty patch", () => {
    assert.equal(parseValidNewLines("").size, 0);
  });
});

// ── buildValidLineMap ─────────────────────────────────────────────────────────

describe("buildValidLineMap", () => {
  it("builds a map from filename to valid lines", () => {
    const files = [
      { filename: "a.ts", patch: "@@ -1,1 +1,2 @@\n context\n+added" },
      { filename: "b.ts", patch: "@@ -1,1 +1,1 @@\n context" },
    ];
    const map = buildValidLineMap(files);
    assert.ok(map.get("a.ts")?.has(1));
    assert.ok(map.get("a.ts")?.has(2));
    assert.ok(map.get("b.ts")?.has(1));
    assert.equal(map.get("b.ts")?.has(2), false);
  });

  it("skips files with no patch", () => {
    const files = [
      { filename: "a.ts" },
      { filename: "b.ts", patch: "@@ -1,1 +1,1 @@\n line" },
    ];
    const map = buildValidLineMap(files);
    assert.equal(map.has("a.ts"), false);
    assert.ok(map.has("b.ts"));
  });
});
