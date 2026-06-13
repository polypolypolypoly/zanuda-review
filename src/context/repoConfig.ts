import type { Octokit } from "@octokit/rest";
import { parse as parseYaml } from "yaml";
import { RepoConfigSchema, type RepoConfig } from "../config.js";
import type { RepoRef } from "../github/client.js";
import { logger } from "../logger.js";

const REPO_CONFIG_PATHS = [".zanuda.yml", ".zanuda.yaml", ".github/zanuda.yml"];
const ORG_CONFIG_PATHS  = [".zanuda.yml", ".zanuda.yaml"];

/**
 * Look for a per-repo `.zanuda.yml` on the PR's base ref.
 * Returns null if not found or malformed (logged and ignored).
 */
export async function fetchRepoConfig(
  octokit: Octokit,
  ref: RepoRef,
  gitRef: string,
): Promise<RepoConfig | null> {
  return fetchConfig(octokit, ref, gitRef, REPO_CONFIG_PATHS, "repo");
}

/**
 * Look for an org-wide `.zanuda.yml` in the `{owner}/.github` repo
 * (GitHub's conventional location for org-level defaults).
 * Returns null if the .github repo doesn't exist, the file isn't there,
 * or the file is malformed.
 *
 * Merge order: global defaults → org config → per-repo config.
 */
export async function fetchOrgConfig(
  octokit: Octokit,
  owner: string,
): Promise<RepoConfig | null> {
  const ref: RepoRef = { owner, repo: ".github" };
  // The .github repo has no meaningful gitRef for our purposes — use HEAD.
  return fetchConfig(octokit, ref, "HEAD", ORG_CONFIG_PATHS, "org");
}

/** Shared implementation used by both fetch functions. */
async function fetchConfig(
  octokit: Octokit,
  ref: RepoRef,
  gitRef: string,
  paths: string[],
  label: string,
): Promise<RepoConfig | null> {
  for (const path of paths) {
    const raw = await tryReadFile(octokit, ref, path, gitRef);
    if (raw === null) continue;
    const parsed = RepoConfigSchema.safeParse(parseYaml(raw));
    if (!parsed.success) {
      logger.warn(
        { repo: `${ref.owner}/${ref.repo}`, path, errors: parsed.error.issues },
        `Ignoring invalid ${label} .zanuda.yml`,
      );
      return null;
    }
    logger.debug({ repo: `${ref.owner}/${ref.repo}`, path }, `Loaded ${label} config`);
    return parsed.data;
  }
  return null;
}

export async function tryReadFile(
  octokit: Octokit,
  ref: RepoRef,
  path: string,
  gitRef: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({ ...ref, path, ref: gitRef });
    if (!Array.isArray(data) && data.type === "file") {
      return Buffer.from(data.content, "base64").toString("utf8");
    }
    return null;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}
