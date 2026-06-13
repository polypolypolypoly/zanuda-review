import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeWithRetry } from "../src/llm/retry.js";
import type { LLMProvider, CompletionRequest } from "../src/llm/types.js";

/** Mock provider that fails N times then succeeds. */
function mockProvider(failures: unknown[]): LLMProvider {
  let attempt = 0;
  return {
    name: "mock",
    async complete(_req: CompletionRequest) {
      if (attempt < failures.length) {
        throw failures[attempt++];
      }
      return { text: "success", usage: { input: 0, output: 0 } };
    },
  };
}

/** Mock provider that always fails. */
function alwaysFails(error: unknown): LLMProvider {
  return {
    name: "mock",
    async complete(_req: CompletionRequest) {
      throw error;
    },
  };
}

const dummyReq: CompletionRequest = {
  system: "test",
  user: "test",
  model: "test",
  temperature: 0.5,
  maxTokens: 100,
};

describe("completeWithRetry", () => {
  it("succeeds on first attempt if no error", async () => {
    const provider = mockProvider([]);
    const result = await completeWithRetry(provider, dummyReq);
    assert.equal(result.text, "success");
  });

  it("retries retryable HTTP status (429) and succeeds", async () => {
    const provider = mockProvider([
      { status: 429, message: "rate limit" },
      { status: 429, message: "rate limit" },
    ]);
    const result = await completeWithRetry(provider, dummyReq);
    assert.equal(result.text, "success");
  });

  it("retries transient server errors (5xx) and succeeds", async () => {
    const provider = mockProvider([
      { status: 500, message: "internal error" },
      { status: 502, message: "bad gateway" },
      { status: 503, message: "service unavailable" },
    ]);
    const result = await completeWithRetry(provider, dummyReq);
    assert.equal(result.text, "success");
  });

  it("retries network errors (ECONNRESET) and succeeds", async () => {
    const provider = mockProvider([
      { code: "ECONNRESET", message: "socket hang up" },
      { code: "ETIMEDOUT", message: "timeout" },
    ]);
    const result = await completeWithRetry(provider, dummyReq);
    assert.equal(result.text, "success");
  });

  it("retries AbortError (fetch timeout) and succeeds", async () => {
    const provider = mockProvider([{ name: "AbortError", message: "aborted" }]);
    const result = await completeWithRetry(provider, dummyReq);
    assert.equal(result.text, "success");
  });

  it("throws immediately on non-retryable status (400)", async () => {
    const provider = alwaysFails({ status: 400, message: "bad request" });
    await assert.rejects(
      () => completeWithRetry(provider, dummyReq),
      (err: unknown) => {
        assert.equal((err as { status?: number }).status, 400);
        return true;
      },
    );
  });

  it("throws immediately on non-retryable status (401)", async () => {
    const provider = alwaysFails({ status: 401, message: "unauthorized" });
    await assert.rejects(
      () => completeWithRetry(provider, dummyReq),
      (err: unknown) => {
        assert.equal((err as { status?: number }).status, 401);
        return true;
      },
    );
  });

  it("throws last error after exhausting MAX_ATTEMPTS", async () => {
    // 4 failures (max attempts = 4) means no success path
    const lastError = { status: 503, message: "still down" };
    const provider = alwaysFails(lastError);

    await assert.rejects(
      () => completeWithRetry(provider, dummyReq),
      (err: unknown) => {
        assert.equal(err, lastError);
        return true;
      },
    );
  });

  it("succeeds on last attempt (3 failures + 1 success)", async () => {
    const provider = mockProvider([
      { status: 429 },
      { status: 503 },
      { code: "ETIMEDOUT" },
    ]);
    const result = await completeWithRetry(provider, dummyReq);
    assert.equal(result.text, "success");
  });
});
