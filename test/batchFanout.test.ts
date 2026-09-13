/**
 * The batch path reads every changed file to build structural headers. That
 * fan-out is bounded: one getContent per file, all at once, is what trips
 * GitHub's secondary rate limit on a large PR.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHeaderedFiles, mapWithConcurrency } from "../src/review/batch.js";
import type {
  FileChange,
  PullRequest,
  SCMConnector,
} from "../src/platform/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makePR(fileCount: number): PullRequest {
  const files: FileChange[] = Array.from({ length: fileCount }, (_, i) => ({
    filename: `src/file${i}.ts`,
    additions: 1,
    deletions: 0,
    patch: `@@ -1 +1 @@\n+const x${i} = 1;`,
  }));
  return {
    ref: { owner: "acme", repo: "widget" },
    number: 1,
    title: "big one",
    body: "",
    author: "alice",
    baseSha: "base",
    headSha: "head",
    diff: "",
    changedFiles: files.map((f) => f.filename),
    files,
    state: "open",
  };
}

/** Connector that records how many readFile calls are in flight at once. */
function countingConnector() {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const connector = {
    async readFile(_ref, path: string) {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
      return `export const ${path};`;
    },
  } as unknown as SCMConnector;
  return {
    connector,
    get maxInFlight() {
      return maxInFlight;
    },
    get calls() {
      return calls;
    },
  };
}

describe("buildHeaderedFiles", () => {
  it("keeps concurrent file reads bounded on a large PR", async () => {
    const counter = countingConnector();
    const pr = makePR(40);

    await buildHeaderedFiles(counter.connector, pr.ref, pr);

    assert.equal(counter.calls, 40, "every file is still read");
    assert.ok(
      counter.maxInFlight <= 5,
      `fan-out reached ${counter.maxInFlight} concurrent reads`,
    );
  });

  it("returns one entry per file with a patch", async () => {
    const counter = countingConnector();
    const pr = makePR(3);
    pr.files[1]!.patch = undefined; // binary / too large

    const result = await buildHeaderedFiles(counter.connector, pr.ref, pr);

    assert.deepEqual(
      result.map((f) => f.filename),
      ["src/file0.ts", "src/file2.ts"],
    );
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([30, 5, 20, 1], 2, async (ms) => {
      await sleep(ms);
      return ms;
    });
    assert.deepEqual(out, [30, 5, 20, 1]);
  });

  it("handles an empty list without hanging", async () => {
    assert.deepEqual(await mapWithConcurrency([], 5, async () => 1), []);
  });
});
