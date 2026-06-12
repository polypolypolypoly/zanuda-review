import type { Octokit } from "@octokit/rest";
import { parse as parseYaml } from "yaml";
import { RepoConfigSchema, type RepoConfig } from "../config.js";
import type { RepoRef } from "../github/client.js";
import { logger } from "../logger.js";

const CONFIG_PATHS = [".review-helper.yml", ".review-helper.yaml", ".github/review-helper.yml"];

/**
 * Look for a `.review-helper.yml` on the PR's head ref. Returning null means
 * "use global defaults". A malformed file is logged and ignored rather than
 * blocking the review.
 */
export async function fetchRepoConfig(
  octokit: Octokit,
  ref: RepoRef,
  gitRef: string,
): Promise<RepoConfig | null> {
  for (const path of CONFIG_PATHS) {
    const raw = await tryReadFile(octokit, ref, path, gitRef);
    if (raw === null) continue;
    const parsed = RepoConfigSchema.safeParse(parseYaml(raw));
    if (!parsed.success) {
      logger.warn(
        { path, errors: parsed.error.issues },
        "Ignoring invalid .review-helper.yml",
      );
      return null;
    }
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
