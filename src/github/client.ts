import { Octokit } from "@octokit/rest";

/** A single shared Octokit authenticated as the bot account (PAT). */
export function createOctokit(token = process.env.GITHUB_TOKEN): Octokit {
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return new Octokit({ auth: token, userAgent: "zanuda-review" });
}

/** Resolve the login of the authenticated user from the token itself. */
export async function getBotLogin(octokit: Octokit): Promise<string> {
  const { data } = await octokit.users.getAuthenticated();
  return data.login;
}

export interface RepoRef {
  owner: string;
  repo: string;
}
