import { Octokit } from "@octokit/rest";

/** A single shared Octokit authenticated as the bot account (PAT). */
export function createOctokit(token = process.env.GITHUB_TOKEN): Octokit {
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return new Octokit({ auth: token, userAgent: "zanuda-review" });
}

export interface RepoRef {
  owner: string;
  repo: string;
}
