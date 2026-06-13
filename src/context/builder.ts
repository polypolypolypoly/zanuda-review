import type { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import type { RepoRef } from "../github/client.js";
import { logger } from "../logger.js";
import { tryReadFile } from "./repoConfig.js";

export interface ProjectContext {
  /** Rendered, ready-to-embed block describing the project. */
  text: string;
}

/**
 * Build project-level context for any repo the bot is added to: convention
 * files plus an optional file-tree overview. This grounds the review in the
 * project's own standards instead of generic best practices.
 */
export async function buildContext(
  octokit: Octokit,
  ref: RepoRef,
  gitRef: string,
  config: Config,
): Promise<ProjectContext> {
  const sections: string[] = [];

  const files = await collectFiles(octokit, ref, gitRef, config);
  let budget = config.context.maxFileChars;
  for (const { path, content } of files) {
    if (budget <= 0) break;
    const slice = content.slice(0, budget);
    budget -= slice.length;
    sections.push(`<file path="${path}">\n${slice}\n</file>`);
  }

  if (config.context.includeFileTree) {
    const tree = await buildFileTree(octokit, ref, gitRef, config.context.maxTreeEntries);
    if (tree) sections.push(`<file_tree>\n${tree}\n</file_tree>`);
  }

  return {
    text: sections.length
      ? sections.join("\n\n")
      : "(No project context files found.)",
  };
}

async function collectFiles(
  octokit: Octokit,
  ref: RepoRef,
  gitRef: string,
  config: Config,
): Promise<Array<{ path: string; content: string }>> {
  // Sequential fetching avoids triggering GitHub's secondary (concurrency)
  // rate limits when many context files are configured.
  const results: Array<{ path: string; content: string }> = [];
  for (const path of config.context.includeFiles) {
    const content = await tryReadFile(octokit, ref, path, gitRef).catch(() => null);
    if (content !== null) results.push({ path, content });
  }
  return results;
}

async function buildFileTree(
  octokit: Octokit,
  ref: RepoRef,
  gitRef: string,
  maxEntries: number,
): Promise<string | null> {
  try {
    const { data } = await octokit.git.getTree({
      ...ref,
      tree_sha: gitRef,
      recursive: "true",
    });
    const paths = data.tree
      .filter((t) => t.type === "blob" && t.path)
      .map((t) => t.path as string)
      .slice(0, maxEntries);
    if (data.truncated || data.tree.length > maxEntries) {
      paths.push(`… (${data.tree.length - paths.length} more)`);
    }
    return paths.join("\n");
  } catch (err) {
    logger.warn({ err }, "Could not build file tree");
    return null;
  }
}
