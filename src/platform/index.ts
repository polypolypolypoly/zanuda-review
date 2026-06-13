/**
 * Platform factory.
 *
 * Reads the PLATFORM env var (default: "github") and returns the matching
 * SCMConnector. Add a case here when implementing a new platform.
 */

import { createOctokit } from "../github/client.js";
import { GitHubConnector } from "./github/connector.js";
import { LocalConnector } from "./local/connector.js";
import type { SCMConnector } from "./types.js";

export { LocalConnector } from "./local/connector.js";
export type { SCMConnector } from "./types.js";
export type {
  FileTree,
  PendingReview,
  PullRequest,
  RepoRef,
  SCMComment,
} from "./types.js";

export function createConnector(): SCMConnector {
  const platform = process.env.PLATFORM ?? "github";

  switch (platform) {
    case "github":
      return new GitHubConnector(createOctokit());

    case "local":
      return new LocalConnector();

    // Add new platforms here:
    // case "gitlab":
    //   return new GitLabConnector({ token: requireEnv("GITLAB_TOKEN") });
    // case "bitbucket":
    //   return new BitbucketConnector({ ... });

    default:
      throw new Error(
        `Unknown PLATFORM="${platform}". Supported: github. ` +
          `See src/platform/stub/connector.ts to implement a new one.`,
      );
  }
}
