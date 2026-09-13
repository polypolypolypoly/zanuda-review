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

function makeConnector(items: PendingReview[]): SCMConnector {
  return {
    name: "fake",
    async pollPendingReviews() {
      return items;
    },
    async listCommitShas() {
      return [];
    },
    async postComment() {
      return 1;
    },
    async isReviewRequested() {
      return false;
    },
  } as unknown as SCMConnector;
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

const run = (config: Config, items: PendingReview[]) =>
  pollReviewRequests({
    config,
    reviewerLogin: "zanuda",
    connector: makeConnector(items),
    inProgress: new Set<number>(),
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
