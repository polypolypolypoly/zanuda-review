import { parse as parseYaml } from "yaml";
import { RepoConfigSchema, type RepoConfig } from "../config.js";
import type { SCMConnector, RepoRef } from "../platform/types.js";
import { logger } from "../logger.js";

// All Zanuda files live under .zanuda/ in the repo root (or the org .github repo).
const CONFIG_PATHS = [".zanuda/config.yml", ".zanuda/config.yaml"];
const INSTRUCTIONS_PATH = ".zanuda/instructions.md";

/**
 * Look for a per-repo `.zanuda/config.yml` on the PR's base ref.
 * Returns null if not found or malformed (logged and ignored).
 */
export async function fetchRepoConfig(
  connector: SCMConnector,
  ref: RepoRef,
  gitRef: string,
): Promise<RepoConfig | null> {
  return fetchConfig(connector, ref, gitRef, CONFIG_PATHS, "repo");
}

/**
 * Look for an org-wide `.zanuda/config.yml` in the `{owner}/.github` repo.
 * Returns null if not found or malformed.
 */
export async function fetchOrgConfig(
  connector: SCMConnector,
  owner: string,
): Promise<RepoConfig | null> {
  const ref: RepoRef = { owner, repo: ".github" };
  return fetchConfig(connector, ref, "HEAD", CONFIG_PATHS, "org");
}

/** Shared implementation used by both fetch functions. */
async function fetchConfig(
  connector: SCMConnector,
  ref: RepoRef,
  gitRef: string,
  paths: string[],
  label: string,
): Promise<RepoConfig | null> {
  for (const path of paths) {
    const raw = await connector.readFile(ref, path, gitRef);
    if (raw === null) continue;
    const parsed = RepoConfigSchema.safeParse(parseYaml(raw));
    if (!parsed.success) {
      logger.warn(
        { repo: `${ref.owner}/${ref.repo}`, path, errors: parsed.error.issues },
        `Ignoring invalid ${label} .zanuda/config.yml`,
      );
      return null;
    }
    logger.debug(
      { repo: `${ref.owner}/${ref.repo}`, path },
      `Loaded ${label} config`,
    );
    return parsed.data;
  }
  return null;
}

/**
 * Fetch `.zanuda/instructions.md` from a repo at the given ref.
 * Returns null if the file doesn't exist.
 */
export async function fetchInstructions(
  connector: SCMConnector,
  ref: RepoRef,
  gitRef: string,
): Promise<string | null> {
  const content = await connector.readFile(ref, INSTRUCTIONS_PATH, gitRef);
  if (content !== null) {
    logger.debug(
      { repo: `${ref.owner}/${ref.repo}` },
      "Loaded .zanuda/instructions.md",
    );
  }
  return content;
}

/**
 * Fetch org-wide `.zanuda/instructions.md` from `{owner}/.github`.
 */
export async function fetchOrgInstructions(
  connector: SCMConnector,
  owner: string,
): Promise<string | null> {
  return fetchInstructions(connector, { owner, repo: ".github" }, "HEAD");
}
