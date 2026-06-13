import type { Octokit } from "@octokit/rest";
import type { FileChange, PullRequest, RepoRef } from "../platform/types.js";

// PullRequestData is an alias kept for internal use within the github/ layer.
export type PullRequestData = PullRequest;

/** Fetch everything the reviewer needs about a PR in one place. */
export async function fetchPullRequest(
  octokit: Octokit,
  ref: RepoRef,
  number: number,
): Promise<PullRequest> {
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

  const fileChanges: FileChange[] = files.map((f) => ({
    filename: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    // `patch` is absent for binary files and files GitHub considers too large
    // to inline (typically > 1 MB or > 20k lines). We treat absence as
    // "not available" rather than an error.
    patch: f.patch,
  }));

  return {
    ref,
    number,
    title: pr.title,
    body: pr.body ?? "",
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    diff: diffRes.data as unknown as string,
    changedFiles: files.map((f) => f.filename),
    files: fileChanges,
    state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open",
  };
}
