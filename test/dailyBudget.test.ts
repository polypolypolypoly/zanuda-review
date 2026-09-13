import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DailyBudget } from "../src/state/dailyBudget.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zanuda-budget-test-"));
  path = join(dir, "daily-budget.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const today = () => new Date().toISOString().slice(0, 10);

describe("DailyBudget", () => {
  it("allows rounds up to the cap, then refuses", () => {
    const budget = new DailyBudget(path);
    assert.equal(budget.tryConsume(2), true);
    assert.equal(budget.tryConsume(2), true);
    assert.equal(budget.tryConsume(2), false);
    assert.equal(budget.used, 2, "a refused round is not counted");
  });

  it("treats a cap of 0 as unlimited", () => {
    const budget = new DailyBudget(path);
    for (let i = 0; i < 50; i++) assert.equal(budget.tryConsume(0), true);
  });

  it("survives a restart — a restart cannot reset the day's count", () => {
    const first = new DailyBudget(path);
    first.tryConsume(2);
    first.tryConsume(2);

    const afterRestart = new DailyBudget(path);
    assert.equal(afterRestart.used, 2);
    assert.equal(afterRestart.tryConsume(2), false);
  });

  it("starts fresh when the persisted count is from an earlier day", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, date: "2020-01-01", rounds: 999 }),
      "utf8",
    );

    const budget = new DailyBudget(path);
    assert.equal(budget.used, 0, "yesterday's count does not carry over");
    assert.equal(budget.tryConsume(1), true);
  });

  it("rolls over when the day changes while running", () => {
    const budget = new DailyBudget(path);
    assert.equal(budget.tryConsume(1), true);
    assert.equal(budget.tryConsume(1), false);

    // Simulate the process crossing midnight.
    (budget as unknown as { date: string }).date = "2020-01-01";

    assert.equal(budget.tryConsume(1), true, "new day, new budget");
    assert.equal(budget.used, 1);
  });

  it("persists the counter as today's date", () => {
    const budget = new DailyBudget(path);
    budget.tryConsume(5);
    const file = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(file, { version: 1, date: today(), rounds: 1 });
  });

  it("starts at zero when the file is corrupt", () => {
    writeFileSync(path, "{not json", "utf8");
    assert.equal(new DailyBudget(path).used, 0);
  });
});
