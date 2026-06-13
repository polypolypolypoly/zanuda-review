import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * Test the unified diff parser used by the local connector.
 * This parser counts additions/deletions and splits the diff into per-file patches.
 */

// Inline copy of parseUnifiedDiffFiles for testing (not exported from connector)
function parseUnifiedDiffFilesTest(
  unifiedDiff: string,
  filenames: string[],
): Array<{
  filename: string;
  additions: number;
  deletions: number;
  patch?: string;
}> {
  const sections = unifiedDiff.split(/(?=^diff --git )/m).filter(Boolean);

  const byFile = new Map<string, string>();
  for (const section of sections) {
    const match = section.match(/^diff --git a\/.*? b\/(.+)$/m);
    if (match) byFile.set(match[1]!, section);
  }

  return filenames.map((filename) => {
    const patch = byFile.get(filename);
    if (!patch) return { filename, additions: 0, deletions: 0 };
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return { filename, additions, deletions, patch };
  });
}

describe("parseUnifiedDiffFiles", () => {
  it("correctly counts additions and deletions", () => {
    const diff = `diff --git a/file.ts b/file.ts
index abc123..def456 100644
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 export function foo() {
-  return 1;
+  return 2;
+  // new comment
 }`;

    const result = parseUnifiedDiffFilesTest(diff, ["file.ts"]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.filename, "file.ts");
    assert.strictEqual(result[0]!.additions, 2);
    assert.strictEqual(result[0]!.deletions, 1);
  });

  it("excludes +++ and --- header lines from counts", () => {
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line one
+line two`;

    const result = parseUnifiedDiffFilesTest(diff, ["new.txt"]);
    assert.strictEqual(result[0]!.additions, 2);
    assert.strictEqual(result[0]!.deletions, 0);
  });

  it("handles files with no newline marker correctly", () => {
    // The "\ No newline at end of file" marker starts with backslash, not +/-
    // so it should NOT increment additions or deletions.
    const diff = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old line
\\ No newline at end of file
+new line
\\ No newline at end of file`;

    const result = parseUnifiedDiffFilesTest(diff, ["file.txt"]);
    assert.strictEqual(result[0]!.additions, 1);
    assert.strictEqual(result[0]!.deletions, 1);
  });

  it("handles multiple files in unified diff", () => {
    const diff = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1,2 @@
 const a = 1;
+const b = 2;
diff --git a/b.ts b/b.ts
index 333..444 100644
--- a/b.ts
+++ b/b.ts
@@ -1,2 +1 @@
-const x = 1;
-const y = 2;
+const z = 3;`;

    const result = parseUnifiedDiffFilesTest(diff, ["a.ts", "b.ts"]);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]!.filename, "a.ts");
    assert.strictEqual(result[0]!.additions, 1);
    assert.strictEqual(result[0]!.deletions, 0);
    assert.strictEqual(result[1]!.filename, "b.ts");
    assert.strictEqual(result[1]!.additions, 1);
    assert.strictEqual(result[1]!.deletions, 2);
  });

  it("returns zero counts for files not in diff", () => {
    const diff = `diff --git a/exists.ts b/exists.ts
index abc..def 100644
--- a/exists.ts
+++ b/exists.ts
@@ -1 +1 @@
-old
+new`;

    const result = parseUnifiedDiffFilesTest(diff, ["exists.ts", "missing.ts"]);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]!.filename, "exists.ts");
    assert.strictEqual(result[0]!.additions, 1);
    assert.strictEqual(result[0]!.deletions, 1);
    assert.strictEqual(result[1]!.filename, "missing.ts");
    assert.strictEqual(result[1]!.additions, 0);
    assert.strictEqual(result[1]!.deletions, 0);
  });

  it("correctly handles hunk headers (do not count as additions)", () => {
    // Hunk headers start with @@ and should not be counted even though they
    // contain +/- characters in the line-number ranges.
    const diff = `diff --git a/test.txt b/test.txt
index aaa..bbb 100644
--- a/test.txt
+++ b/test.txt
@@ -10,5 +10,6 @@ context line
 unchanged
+added line
 unchanged`;

    const result = parseUnifiedDiffFilesTest(diff, ["test.txt"]);
    // Should count only the "+added line", not the @@ header
    assert.strictEqual(result[0]!.additions, 1);
    assert.strictEqual(result[0]!.deletions, 0);
  });
});
