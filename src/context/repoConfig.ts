import type { Octokit } from "@octokit/rest";
import { parse as parseYaml } from "yaml";
import { RepoConfigSchema, type RepoConfig } from "../config.js";
import type { RepoRef } from "../github/client.js";
import { logger } from "../logger.js";

// All Zanuda-related files now live under .zanuda/ in the repo root.
// Kept in priority order — first match wins.
const REPO_CONFIG_PATHS   = [".zanuda/config.yml", ".zanuda/config.yaml"];
const ORG_CONFIG_PATHS    = [".zanuda/config.yml", ".zanuda/config.yaml"];
const INSTRUCTIONS_PATH   = ".zanuda/instructions.md";

/**
 * Look for a per-repo `.zanuda/config.yml` on the PR's base ref.
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
 * Look for an org-wide `.zanuda/config.yml` in the `{owner}/.github` repo.
 * Returns null if the .github repo doesn't exist, the file isn't there,
 * or the file is malformed.
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
        `Ignoring invalid ${label} .zanuda/config.yml`,
      );
      return null;
    }
    logger.debug({ repo: `${ref.owner}/${ref.repo}`, path }, `Loaded ${label} config`);
    return parsed.data;
  }
  return null;
}

/**
 * Fetch `.zanuda/instructions.md` from a repo at the given ref.
 * Returns null if the file doesn't exist.
 *
 * Instructions are written by maintainers on the base branch — they are
 * intentionally injected without XML sandboxing so the model follows them.
 * Contrast with PR-author content (title, body, diff, comments) which IS
 * sandboxed because it is untrusted.
 */
export async function fetchInstructions(
  octokit: Octokit,
  ref: RepoRef,
  gitRef: string,
): Promise<string | null> {
  const content = await tryReadFile(octokit, ref, INSTRUCTIONS_PATH, gitRef);
  if (content !== null) {
    logger.debug({ repo: `${ref.owner}/${ref.repo}` }, "Loaded .zanuda/instructions.md");
  }
  return content;
}

/**
 * Fetch org-wide `.zanuda/instructions.md` from `{owner}/.github`.
 * Returns null if not present.
 */
export async function fetchOrgInstructions(
  octokit: Octokit,
  owner: string,
): Promise<string | null> {
  return fetchInstructions(octokit, { owner, repo: ".github" }, "HEAD");
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
