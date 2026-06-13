import { Octokit } from "@octokit/rest";

// RepoRef is defined in platform/types — re-exported here for convenience.
export type { RepoRef } from "../platform/types.js";

/** A single shared Octokit authenticated as the bot account (PAT). */
export function createOctokit(token = process.env.GITHUB_TOKEN): Octokit {
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return new Octokit({ auth: token, userAgent: "zanuda-review" });
}
