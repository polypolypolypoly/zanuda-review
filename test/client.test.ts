/**
 * The Octokit fetch wrapper must keep its 30s deadline even when the retry or
 * throttling plugins pass their own abort signal — otherwise those requests
 * (the exact ones the timeout exists for) hang indefinitely.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { combineWithDeadline, timeoutFetch } from "../src/github/client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("combineWithDeadline", () => {
  it("returns a bare timeout signal when the caller has none", () => {
    const signal = combineWithDeadline(undefined, 30_000);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
  });

  it("aborts on the deadline even when the caller never aborts", async () => {
    const caller = new AbortController();
    const combined = combineWithDeadline(caller.signal, 20);

    assert.equal(combined.aborted, false);
    await sleep(30);
    assert.equal(combined.aborted, true, "deadline must still fire");
  });

  it("propagates the caller's abort through the combined signal", () => {
    const caller = new AbortController();
    const combined = combineWithDeadline(caller.signal, 30_000);

    assert.equal(combined.aborted, false);
    caller.abort();
    assert.equal(combined.aborted, true, "caller cancellation must propagate");
  });
});

describe("timeoutFetch", () => {
  it("forwards a combined signal, not the caller's raw signal", async (t) => {
    const captured: RequestInit[] = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      captured.push(init ?? {});
      return new Response("ok");
    });

    const caller = new AbortController();
    await timeoutFetch("https://example.com", { signal: caller.signal });

    assert.equal(captured.length, 1);
    const signal = captured[0]!.signal as AbortSignal;
    assert.ok(signal, "a signal must be forwarded");
    assert.notEqual(
      signal,
      caller.signal,
      "caller signal must not pass through unchanged (deadline would be dropped)",
    );
    assert.equal(signal.aborted, false);
  });
});
