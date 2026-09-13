/**
 * Review-request gating in the poll loop: the daily spend cap, the per-cycle
 * cap, and the allowlist. The engine is stubbed — what is under test is which
 * PRs the poller decides to spend a review round on.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/config.js";
import type {
  PendingReview,
  RepoRef,
  SCMConnector,
} from "../src/platform/types.js";

const reviewed: number[] = [];

const realEngine = await import("../src/review/engine.ts");
mock.module("../src/review/engine.ts", {
  namedExports: {
    ...Object.fromEntries(
      Object.entries(realEngine).filter(([, v]) => typeof v !== "undefined"),
    ),
    reviewPullRequest: mock.fn(
      async (_deps: unknown, _ref: RepoRef, number: number) => {
        reviewed.push(number);
        return {
          prSummary: "",
          summary: "ok",
          action: "COMMENT",
          filesSummary: [],
          comments: [],
          progressCommentId: null,
          stale: false,
          headSha: "head",
        };
      },
    ),
  },
});

const { pollReviewRequests } = await import("../src/poller.ts");
const { PRStateStore } = await import("../src/state/store.ts");
const { CommitLog } = await import("../src/state/commitLog.ts");
const { DailyBudget } = await import("../src/state/dailyBudget.ts");
const { freshState } = await import("../src/state/transitions.ts");

const REF: RepoRef = { owner: "acme", repo: "widget" };

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    access: { allowlist: ["acme"] },
    limits: {
      maxConcurrentReviews: 10,
      maxNewPrsPerCycle: 10,
      maxReviewRoundsPerDay: 0,
      tokenBudgetPerPR: 0,
      maxBatches: 10,
    },
    persistence: { stateFile: "" },
    ...overrides,
  } as unknown as Config;
}

function pending(count: number): PendingReview[] {
  return Array.from({ length: count }, (_, i) => ({
    ref: REF,
    number: i + 1,
    title: `PR ${i + 1}`,
    platformId: 1000 + i,
  }));
}

interface ConnectorOpts {
  /** What isReviewRequested answers; an Error is thrown instead. */
  reviewRequested?: boolean | Error;
  commitShas?: string[];
}

function makeConnector(
  items: PendingReview[],
  opts: ConnectorOpts = {},
): SCMConnector & { comments: string[] } {
  const comments: string[] = [];
  return {
    comments,
    name: "fake",
    async pollPendingReviews() {
      return items;
    },
    async listCommitShas() {
      return opts.commitShas ?? [];
    },
    async postComment(_ref: RepoRef, _n: number, body: string) {
      comments.push(body);
      return 1;
    },
    async isReviewRequested() {
      if (opts.reviewRequested instanceof Error) throw opts.reviewRequested;
      return opts.reviewRequested ?? false;
    },
  } as unknown as SCMConnector & { comments: string[] };
}

let dir: string;
let store: InstanceType<typeof PRStateStore>;
let commitLog: InstanceType<typeof CommitLog>;
let budget: InstanceType<typeof DailyBudget>;

beforeEach(() => {
  reviewed.length = 0;
  dir = mkdtempSync(join(tmpdir(), "zanuda-poll-test-"));
  store = new PRStateStore(join(dir, "state.json"));
  commitLog = new CommitLog(join(dir, "commit-log.json"));
  budget = new DailyBudget(join(dir, "daily-budget.json"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (
  config: Config,
  items: PendingReview[],
  connector: SCMConnector = makeConnector(items),
  inProgress = new Set<number>(),
) =>
  pollReviewRequests({
    config,
    reviewerLogin: "zanuda",
    connector,
    inProgress,
    store,
    commitLog,
    budget,
  });

/** The review dispatch is fire-and-forget; let its microtasks settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("pollReviewRequests: daily budget", () => {
  it("stops starting rounds once the daily cap is reached", async () => {
    await run(makeConfig({ limits: makeConfig().limits }), []);

    const config = makeConfig({
      limits: { ...makeConfig().limits, maxReviewRoundsPerDay: 2 },
    });
    await run(config, pending(5));
    await settle();

    assert.deepEqual(reviewed, [1, 2], "only the budgeted rounds ran");
    assert.equal(budget.used, 2);
  });

  it("picks the deferred PRs up once the counter rolls over", async () => {
    const config = makeConfig({
      limits: { ...makeConfig().limits, maxReviewRoundsPerDay: 1 },
    });

    await run(config, pending(2));
    await settle();
    assert.deepEqual(reviewed, [1]);

    // Next day: the review request is still open, so the PR comes back.
    (budget as unknown as { date: string }).date = "2020-01-01";
    await run(config, pending(2).slice(1));
    await settle();

    assert.deepEqual(reviewed, [1, 2]);
  });

  it("does not consume budget for a PR it skips anyway", async () => {
    const config = makeConfig({
      access: { allowlist: ["someone-else"] },
      limits: { ...makeConfig().limits, maxReviewRoundsPerDay: 5 },
    });

    await run(config, pending(3));
    await settle();

    assert.deepEqual(reviewed, []);
    assert.equal(budget.used, 0, "unlisted repos must not spend the budget");
  });
});

// ─── Round-2 gate ─────────────────────────────────────────────────────────────
//
// Round 2 acts only on a strongly-consistent signal. The search index that
// produced `pending` lags behind the REST mutation that cleared the request, so
// "the PR showed up again" is not evidence the author asked for anything.

describe("pollReviewRequests: round-2 gate", () => {
  const config = makeConfig();
  const afterRound1 = () =>
    store.set(1000, { ...freshState(REF, 1), rounds: 1 });

  it("withholds round 2 when the reviewer is not in requested_reviewers", async () => {
    afterRound1();
    await run(
      config,
      pending(1),
      makeConnector(pending(1), {
        reviewRequested: false,
      }),
    );
    await settle();

    assert.deepEqual(reviewed, [], "search-index lag is not a re-request");
  });

  it("runs round 2 when the PR really carries the request again", async () => {
    afterRound1();
    await run(
      config,
      pending(1),
      makeConnector(pending(1), {
        reviewRequested: true,
      }),
    );
    await settle();

    assert.deepEqual(reviewed, [1]);
  });

  it("runs round 2 on the mention-driven flag without an API check", async () => {
    store.set(1000, {
      ...freshState(REF, 1),
      rounds: 1,
      reReviewRequested: true,
    });
    const connector = makeConnector(pending(1), {
      reviewRequested: new Error("must not be consulted"),
    });

    await run(config, pending(1), connector);
    await settle();

    assert.deepEqual(reviewed, [1]);
  });

  it("withholds round 2 when the authoritative check fails", async () => {
    afterRound1();
    await run(
      config,
      pending(1),
      makeConnector(pending(1), {
        reviewRequested: new Error("503"),
      }),
    );
    await settle();

    assert.deepEqual(reviewed, [], "never fall back to the search heuristic");
    assert.equal(budget.used, 0, "a withheld round costs nothing");
  });

  it("stops after the last round and says so exactly once", async () => {
    store.set(1000, { ...freshState(REF, 1), rounds: 2 });
    const connector = makeConnector(pending(1), { reviewRequested: true });

    await run(config, pending(1), connector);
    await run(config, pending(1), connector);
    await settle();

    assert.deepEqual(reviewed, []);
    assert.equal(connector.comments.length, 1, "notified once, not every tick");
    assert.match(connector.comments[0]!, /review rounds/);
  });

  it("skips a PR that is waiting for a retry command", async () => {
    store.set(1000, { ...freshState(REF, 1), failedAwaitingRetry: true });
    await run(config, pending(1));
    await settle();

    assert.deepEqual(reviewed, []);
  });
});

// ─── Concurrency and per-cycle caps ───────────────────────────────────────────

describe("pollReviewRequests: caps", () => {
  it("starts at most maxNewPrsPerCycle reviews in one tick", async () => {
    const config = makeConfig({
      limits: { ...makeConfig().limits, maxNewPrsPerCycle: 2 },
    });

    await run(config, pending(5));
    await settle();

    assert.deepEqual(reviewed, [1, 2]);
  });

  it("leaves no free slots when reviews are already in flight", async () => {
    const config = makeConfig({
      limits: { ...makeConfig().limits, maxConcurrentReviews: 2 },
    });
    const inProgress = new Set<number>([9001, 9002]);

    await run(config, pending(3), makeConnector(pending(3)), inProgress);
    await settle();

    assert.deepEqual(reviewed, [], "concurrency cap reached");
  });

  it("fills only the remaining slots", async () => {
    const config = makeConfig({
      limits: { ...makeConfig().limits, maxConcurrentReviews: 3 },
    });
    const inProgress = new Set<number>([9001, 9002]);

    await run(config, pending(3), makeConnector(pending(3)), inProgress);
    await settle();

    assert.deepEqual(reviewed, [1]);
  });
});

// ─── Commit dedup ─────────────────────────────────────────────────────────────

describe("pollReviewRequests: commit dedup", () => {
  it("skips a PR whose commits were all reviewed before", async () => {
    commitLog.addAll(REF.owner, REF.repo, ["sha1", "sha2"]);
    const connector = makeConnector(pending(1), {
      commitShas: ["sha1", "sha2"],
    });

    await run(makeConfig(), pending(1), connector);
    await settle();

    assert.deepEqual(reviewed, []);
    assert.match(connector.comments[0]!, /Skipping review/);
    assert.equal(budget.used, 0, "a skipped PR costs nothing");
  });

  it("reviews a PR that carries at least one new commit", async () => {
    commitLog.addAll(REF.owner, REF.repo, ["sha1"]);
    const connector = makeConnector(pending(1), {
      commitShas: ["sha1", "sha-new"],
    });

    await run(makeConfig(), pending(1), connector);
    await settle();

    assert.deepEqual(reviewed, [1]);
  });
});
