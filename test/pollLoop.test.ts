/**
 * The poll loop reschedules AFTER each tick finishes. setInterval fired on a
 * fixed period regardless, so a tick that ran longer than the interval — easy,
 * since pollMentions awaits an LLM reply inline — overlapped the next one and
 * answered the same mention twice.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPollLoop } from "../src/poller.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runPollLoop", () => {
  it("never overlaps a tick that outlives the interval", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let runs = 0;

    const stop = runPollLoop(async () => {
      runs++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(40); // four times the interval
      inFlight--;
    }, 10);

    await sleep(200);
    stop();

    assert.equal(maxInFlight, 1, "ticks overlapped");
    assert.ok(runs >= 2, `expected repeated ticks, got ${runs}`);
  });

  it("keeps running after a tick throws", async () => {
    let runs = 0;
    const stop = runPollLoop(async () => {
      runs++;
      throw new Error("GitHub is down");
    }, 10);

    await sleep(60);
    stop();

    assert.ok(runs >= 3, `loop stopped after a throw (${runs} runs)`);
  });

  it("stop() prevents any further ticks", async () => {
    let runs = 0;
    const stop = runPollLoop(async () => {
      runs++;
    }, 10);

    await sleep(35);
    stop();
    const runsAtStop = runs;
    await sleep(50);

    assert.equal(runs, runsAtStop);
  });
});
