import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { logger } from "../logger.js";

// RepoRef is defined in platform/types — re-exported here for convenience.
export type { RepoRef } from "../platform/types.js";

/**
 * Per-request timeout. Octokit v22 is fetch-based and has no `request.timeout`
 * option, so the deadline is applied through the fetch wrapper below. Without
 * it a hung connection stalls a poll tick indefinitely.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** Give up after this many automatic retries of one request. */
const MAX_RETRIES = 3;

const ZanudaOctokit = Octokit.plugin(throttling, retry);

/**
 * A single shared Octokit authenticated as the reviewer account (PAT).
 *
 * The throttling plugin honours GitHub's `retry-after` for both the primary and
 * the secondary (abuse) rate limit; the retry plugin covers transient 5xx and
 * network failures. Without them a single 502 during postReview failed a whole
 * review round — asymmetric with the LLM path, which has had classified retry
 * with jittered backoff since the start (see llm/retry.ts).
 */
export function createOctokit(token = process.env.GITHUB_TOKEN): Octokit {
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return new ZanudaOctokit({
    auth: token,
    userAgent: "zanuda-review",
    request: {
      fetch: timeoutFetch,
      retries: MAX_RETRIES,
    },
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        logger.warn(
          { method: options.method, url: options.url, retryAfter, retryCount },
          "GitHub rate limit hit — waiting",
        );
        return retryCount < MAX_RETRIES;
      },
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
        logger.warn(
          { method: options.method, url: options.url, retryAfter, retryCount },
          "GitHub secondary rate limit hit — waiting",
        );
        return retryCount < MAX_RETRIES;
      },
    },
  });
}

/**
 * Combine an optional caller-supplied abort signal with the request deadline.
 * `AbortSignal.any` follows both: the caller's cancellation and our timeout.
 *
 * The retry and throttling plugins pass their own signal (to cancel an
 * in-flight request when they reschedule), so "use the caller's signal if
 * present" would silently drop the deadline on exactly the requests those
 * plugins touch — the hung-connection failure this wrapper exists to fix.
 */
export function combineWithDeadline(
  signal: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** fetch with a deadline that always applies, even when the caller supplied
 *  its own abort signal. Exported for tests. */
export function timeoutFetch(
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: combineWithDeadline(init?.signal, REQUEST_TIMEOUT_MS),
  });
}
