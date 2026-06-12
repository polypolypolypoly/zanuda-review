import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "./client.js";

export interface PullRequestData {
  ref: RepoRef;
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  /** Unified diff of the whole PR. */
  diff: string;
  changedFiles: string[];
}

/** Fetch everything the reviewer needs about a PR in one place. */
export async function fetchPullRequest(
  octokit: Octokit,
  ref: RepoRef,
  number: number,
): Promise<PullRequestData> {
  const { data: pr } = await octokit.pulls.get({ ...ref, pull_number: number });

  // The diff media type returns a raw unified diff as the response body.
  const diffRes = await octokit.pulls.get({
    ...ref,
    pull_number: number,
    mediaType: { format: "diff" },
  });

  const files = await octokit.paginate(octokit.pulls.listFiles, {
    ...ref,
    pull_number: number,
    per_page: 100,
  });

  return {
    ref,
    number,
    title: pr.title,
    body: pr.body ?? "",
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    diff: diffRes.data as unknown as string,
    changedFiles: files.map((f) => f.filename),
  };
}
