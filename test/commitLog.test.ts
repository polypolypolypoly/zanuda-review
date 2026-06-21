import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CommitLog } from "../src/state/commitLog.js";

let tmpDir: string;
let logPath: string;

before(() => {
  tmpDir = join(tmpdir(), `zanuda-commitlog-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  logPath = join(tmpDir, "commit-log.json");
});

after(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

function freshLog(): CommitLog {
  // Reset the file between tests
  try {
    rmSync(logPath, { force: true });
  } catch {
    /* ok */
  }
  return new CommitLog(logPath);
}

// ── hasAll ────────────────────────────────────────────────────────────────────

describe("CommitLog.hasAll", () => {
  it("returns false for empty commit list", () => {
    const log = freshLog();
    assert.equal(log.hasAll("owner", "repo", []), false);
  });

  it("returns false when log is empty", () => {
    const log = freshLog();
    assert.equal(log.hasAll("owner", "repo", ["abc123"]), false);
  });

  it("returns false for unknown repo", () => {
    const log = freshLog();
    log.addAll("owner", "repo", ["sha1"]);
    assert.equal(log.hasAll("other", "repo", ["sha1"]), false);
  });

  it("returns false when some commits are missing", () => {
    const log = freshLog();
    log.addAll("owner", "repo", ["sha1", "sha2"]);
    assert.equal(log.hasAll("owner", "repo", ["sha1", "sha3"]), false);
  });

  it("returns true when all commits are present", () => {
    const log = freshLog();
    log.addAll("owner", "repo", ["sha1", "sha2", "sha3"]);
    assert.equal(log.hasAll("owner", "repo", ["sha1", "sha2"]), true);
    assert.equal(log.hasAll("owner", "repo", ["sha3"]), true);
    assert.equal(log.hasAll("owner", "repo", ["sha1", "sha2", "sha3"]), true);
  });

  it("distinguishes repos by owner/repo key", () => {
    const log = freshLog();
    log.addAll("a", "r", ["sha1"]);
    log.addAll("b", "r", ["sha2"]);
    assert.equal(log.hasAll("a", "r", ["sha1"]), true);
    assert.equal(log.hasAll("a", "r", ["sha2"]), false);
    assert.equal(log.hasAll("b", "r", ["sha1"]), false);
  });
});

// ── addAll (idempotency) ─────────────────────────────────────────────────────

describe("CommitLog.addAll", () => {
  it("idempotently adds the same SHAs multiple times", () => {
    const log = freshLog();
    log.addAll("owner", "repo", ["sha1"]);
    log.addAll("owner", "repo", ["sha1"]);
    log.addAll("owner", "repo", ["sha1", "sha2"]);
    assert.equal(log.hasAll("owner", "repo", ["sha1", "sha2"]), true);
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe("CommitLog persistence", () => {
  it("survives re-instantiation", () => {
    const log1 = freshLog();
    log1.addAll("owner", "repo", ["sha1", "sha2"]);

    const log2 = new CommitLog(logPath);
    assert.equal(log2.hasAll("owner", "repo", ["sha1", "sha2"]), true);
  });

  it("survives multiple repos", () => {
    const log1 = freshLog();
    log1.addAll("a", "r", ["a1"]);
    log1.addAll("b", "r", ["b1"]);

    const log2 = new CommitLog(logPath);
    assert.equal(log2.hasAll("a", "r", ["a1"]), true);
    assert.equal(log2.hasAll("b", "r", ["b1"]), true);
    assert.equal(log2.hasAll("c", "r", ["c1"]), false);
  });
});

// ── Prune ─────────────────────────────────────────────────────────────────────

describe("CommitLog prune", () => {
  it("does NOT re-stamp other repos on addAll", async () => {
    // Add repo A, then wait 10ms, then add repo B.
    // Repo A's updatedAt must not be refreshed by the second addAll.
    const log = freshLog();
    log.addAll("old", "repo", ["sha1"]);

    // Small delay so the two timestamps are distinguishable.
    await new Promise((r) => setTimeout(r, 10));

    // Read the raw file to get old's timestamp
    const raw1 = JSON.parse(readFileSync(logPath, "utf8"));
    const oldTs = raw1.repos["old/repo"].updatedAt;

    // Add a different repo
    log.addAll("new", "repo", ["sha2"]);

    const raw2 = JSON.parse(readFileSync(logPath, "utf8"));
    assert.equal(
      raw2.repos["old/repo"].updatedAt,
      oldTs,
      "old repo's updatedAt should NOT be refreshed when adding a different repo",
    );
    assert.notEqual(
      raw2.repos["new/repo"].updatedAt,
      oldTs,
      "new repo's updatedAt should be different",
    );
  });

  it("stamps updatedAt on the repo being mutated", () => {
    const log = freshLog();
    log.addAll("owner", "repo", ["sha1"]);

    const raw = JSON.parse(readFileSync(logPath, "utf8"));
    const ts = raw.repos["owner/repo"].updatedAt;
    const parsed = new Date(ts).getTime();
    assert.ok(!isNaN(parsed), "updatedAt should be a valid ISO date");
    // Should be within the last 5 seconds
    assert.ok(Date.now() - parsed < 5000);
  });
});

// ── Schema validation on load ─────────────────────────────────────────────────

describe("CommitLog load validation", () => {
  it("returns empty map for missing file", () => {
    // freshLog() already removes the file
    const log = freshLog();
    assert.equal(log.hasAll("a", "r", ["sha1"]), false);
  });

  it("returns empty map for unparseable JSON", () => {
    writeFileSync(logPath, "not json", "utf8");
    const log = new CommitLog(logPath);
    assert.equal(log.hasAll("a", "r", ["sha1"]), false);
  });

  it("returns empty map for wrong version", () => {
    writeFileSync(logPath, JSON.stringify({ version: 99, repos: {} }), "utf8");
    const log = new CommitLog(logPath);
    assert.equal(log.hasAll("a", "r", ["sha1"]), false);
  });

  it("drops repos with non-array shas", () => {
    writeFileSync(
      logPath,
      JSON.stringify({
        version: 1,
        repos: {
          "good/repo": { shas: ["sha1"], updatedAt: new Date().toISOString() },
          "bad/repo": {
            shas: "not-an-array",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const log = new CommitLog(logPath);
    assert.equal(log.hasAll("good", "repo", ["sha1"]), true);
    assert.equal(log.hasAll("bad", "repo", ["sha1"]), false);
  });

  it("drops repos with non-datetime updatedAt (e.g. 'banana')", () => {
    writeFileSync(
      logPath,
      JSON.stringify({
        version: 1,
        repos: {
          "good/repo": { shas: ["sha1"], updatedAt: new Date().toISOString() },
          "bad/repo": { shas: ["sha1"], updatedAt: "banana" },
        },
      }),
      "utf8",
    );
    const log = new CommitLog(logPath);
    assert.equal(log.hasAll("good", "repo", ["sha1"]), true);
    assert.equal(log.hasAll("bad", "repo", ["sha1"]), false);
  });

  it("drops repos with missing updatedAt", () => {
    writeFileSync(
      logPath,
      JSON.stringify({
        version: 1,
        repos: {
          "good/repo": { shas: ["sha1"], updatedAt: new Date().toISOString() },
          "bad/repo": { shas: ["sha1"] },
        },
      }),
      "utf8",
    );
    const log = new CommitLog(logPath);
    // Zod rejects bad/repo entirely, but good/repo still loads
    assert.equal(log.hasAll("good", "repo", ["sha1"]), true);
  });
});
