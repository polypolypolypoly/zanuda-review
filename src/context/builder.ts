import type { Config } from "../config.js";
import type { SCMConnector, RepoRef } from "../platform/types.js";
import { logger } from "../logger.js";

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
  connector: SCMConnector,
  ref: RepoRef,
  gitRef: string,
  config: Config,
): Promise<ProjectContext> {
  const sections: string[] = [];

  const files = await collectFiles(connector, ref, gitRef, config);
  let budget = config.context.maxFileChars;
  for (const { path, content } of files) {
    if (budget <= 0) break;
    const slice = content.slice(0, budget);
    budget -= slice.length;
    sections.push(`<file path="${path}">\n${slice}\n</file>`);
  }

  if (config.context.includeFileTree) {
    const tree = await buildFileTree(
      connector,
      ref,
      gitRef,
      config.context.maxTreeEntries,
    );
    if (tree) sections.push(`<file_tree>\n${tree}\n</file_tree>`);
  }

  return {
    text: sections.length
      ? sections.join("\n\n")
      : "(No project context files found.)",
  };
}

async function collectFiles(
  connector: SCMConnector,
  ref: RepoRef,
  gitRef: string,
  config: Config,
): Promise<Array<{ path: string; content: string }>> {
  // Sequential fetching avoids triggering secondary rate limits.
  const results: Array<{ path: string; content: string }> = [];
  for (const path of config.context.includeFiles) {
    const content = await connector
      .readFile(ref, path, gitRef)
      .catch(() => null);
    if (content !== null) results.push({ path, content });
  }
  return results;
}

async function buildFileTree(
  connector: SCMConnector,
  ref: RepoRef,
  gitRef: string,
  maxEntries: number,
): Promise<string | null> {
  try {
    const tree = await connector.getFileTree(ref, gitRef, maxEntries);
    if (tree.paths.length === 0) return null;
    const paths = [...tree.paths];
    if (tree.truncated) {
      paths.push(`… (${tree.total - paths.length} more)`);
    }
    return paths.join("\n");
  } catch (err) {
    logger.warn({ err }, "Could not build file tree");
    return null;
  }
}
