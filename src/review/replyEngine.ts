import type { Config } from "../config.js";
import { replyToComment, type PRComment } from "../github/comments.js";
import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "../github/client.js";
import { createProvider } from "../llm/index.js";
import { logger } from "../logger.js";

export interface ReplyDeps {
  octokit: Octokit;
  config: Config;
  botLogin: string;
}

/**
 * Generate a reply to a comment that @mentions the bot and post it.
 * Keeps the bot's character: terse, technical, security-minded.
 */
export async function replyToMention(
  deps: ReplyDeps,
  ref: RepoRef,
  prNumber: number,
  comment: PRComment,
  prTitle: string,
  discussion: string,
): Promise<void> {
  const { octokit, config, botLogin } = deps;

  const provider = createProvider(config.provider);
  const completion = await provider.complete({
    system: buildReplySystem(botLogin),
    user: buildReplyUserPrompt(prTitle, comment, discussion),
    model: config.models[config.provider],
    temperature: config.generation.temperature,
    // Replies are short — no need for the full review token budget.
    maxTokens: 512,
  });

  const replyBody = completion.text.trim();
  await replyToComment(octokit, ref, prNumber, comment, replyBody);

  logger.info(
    { repo: `${ref.owner}/${ref.repo}`, pr: prNumber, commentId: comment.id },
    "Replied to mention",
  );
}

function buildReplySystem(botLogin: string): string {
  return (
    `You are ${botLogin}, a senior security engineer and blockchain auditor. ` +
    `You have already reviewed this PR and someone has mentioned you in a comment.\n\n` +
    `Rules:\n` +
    `- Get straight to the point. No greetings, no filler.\n` +
    `- Answer questions directly in 2-4 sentences max.\n` +
    `- If reconsidering a point, either acknowledge it concisely or stand your ground with a reason.\n` +
    `- Stay in character: paranoid, security-first, technically precise.\n` +
    `- Do not be sycophantic. Do not start with "Great question" or similar.`
  );
}

function buildReplyUserPrompt(
  prTitle: string,
  comment: PRComment,
  discussion: string,
): string {
  const location = comment.path
    ? ` (on \`${comment.path}${comment.line != null ? `:${comment.line}` : ""}\`)`
    : "";

  return [
    `## PR: ${prTitle}`,
    "",
    "## Recent discussion (for context)",
    discussion,
    "",
    `## Comment mentioning you${location}`,
    comment.body,
    "",
    "Reply to this comment.",
  ].join("\n");
}
