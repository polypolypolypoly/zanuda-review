/**
 * Self-verification pass: after the model produces findings, run a second
 * dedicated call whose only job is to locate the exact diff line(s) that
 * prove each finding, or retract it.
 *
 * This operationalizes the safety-net ethos already in the preprompt
 * ("if you can't point to a line, don't flag it") as a separate pass.
 * The verification task is narrower and more reliable than self-policing
 * mid-flow during review.
 *
 * Won't catch confident hallucinations (the model that invented a finding
 * will often invent a justification too), but catches the careless errors
 * that make up most of the noise.
 */

import type { LLMProvider } from "../llm/index.js";
import { completeWithRetry } from "../llm/retry.js";
import type { ReviewComment } from "./types.js";
import type { Config } from "../config.js";
import { extractJson } from "./parse.js";

/**
 * Run a verification pass on a set of findings against a diff.
 * Returns only the findings that the model could ground in the diff.
 * Retracted findings are logged as warnings.
 *
 * @param findings — the original findings to verify
 * @param diffText — the diff the findings were based on
 * @param config — for model selection
 * @param provider — LLM provider
 * @param log — logger for retraction warnings
 * @returns filtered findings (verified only)
 */
export async function verifyFindings(
  findings: ReviewComment[],
  diffText: string,
  config: Config,
  provider: LLMProvider,
  log: { warn: (obj: object, msg: string) => void },
): Promise<ReviewComment[]> {
  if (findings.length === 0) return [];

  const verificationPrompt = buildVerificationPrompt(findings, diffText);

  const completion = await completeWithRetry(provider, {
    system: VERIFICATION_SYSTEM,
    user: verificationPrompt,
    model: config.models[config.provider],
    temperature: 0, // deterministic — we want consistent verification
    maxTokens: Math.min(config.generation.maxTokens, 4096),
  });

  // Parse the verification response — same JSON extraction as reviews
  const result = parseVerificationResult(completion.text);

  // Log retracted findings
  for (const r of result.retracted) {
    log.warn(
      {
        path: r.path,
        line: r.line,
        reason: r.reason,
      },
      "Finding retracted — could not be verified against diff",
    );
  }

  // Match verified findings back to original findings (preserve body, severity)
  const verifiedSet = new Set(
    result.verified.map((v) => `${v.path}:${v.line}`),
  );
  const kept = findings.filter((f) => verifiedSet.has(`${f.path}:${f.line}`));

  return kept;
}

const VERIFICATION_SYSTEM = `\
You verify code review findings against a diff. Your only job: for each
finding, point to the exact diff line(s) that prove the issue. If you
cannot find clear evidence in the diff, mark the finding as RETRACTED.

Rules:
- You are NOT producing new findings. Only verify what's given.
- A finding is verified if there is concrete evidence in the diff that
  supports it. "Concrete" means a specific line or hunk that shows the
  issue.
- If the finding references a line that doesn't appear in the diff,
  or the diff doesn't show the claimed issue, retract it.
- If the diff shows the issue but the finding mischaracterizes it,
  retract it (the finding body is what gets posted — if it's wrong, it
  must be retracted).
- Do not retract just because the finding is imprecise about the line
  number — if the issue is visible somewhere nearby (±5 lines), verify it.
- Return only the verified findings. Retracted findings must include a
  one-sentence reason.`;

function buildVerificationPrompt(
  findings: ReviewComment[],
  diffText: string,
): string {
  const findingsList = findings
    .map((f) => `- [${f.path}:${f.line}] ${f.severity}: ${f.body}`)
    .join("\n");

  // Truncate diff if it's huge — verification only needs the relevant sections
  const MAX_DIFF_CHARS = 50000;
  const truncated =
    diffText.length > MAX_DIFF_CHARS
      ? diffText.slice(0, MAX_DIFF_CHARS) +
        `\n(Diff truncated at ${MAX_DIFF_CHARS} chars)`
      : diffText;

  return [
    `## Diff`,
    "```diff",
    truncated,
    "```",
    "",
    `## Findings to verify (${findings.length})`,
    findingsList || "(none)",
    "",
    `## Your task`,
    `Verify each finding above against the diff. Return JSON:`,
    `{`,
    `  "verified": [`,
    `    { "path": "repo-relative path", "line": N, "severity": "blocker|warning", "body": "original body" }`,
    `  ],`,
    `  "retracted": [`,
    `    { "path": "repo-relative path", "line": N, "reason": "one-sentence explanation" }`,
    `  ]`,
    `}`,
    ``,
    `Pass through the original body and severity unchanged for verified findings.`,
    `Do not modify the finding text — just verify or retract.`,
  ].join("\n");
}

interface VerificationResult {
  verified: ReviewComment[];
  retracted: { path: string; line: number; reason: string }[];
}

function parseVerificationResult(text: string): VerificationResult {
  try {
    const parsed = JSON.parse(text);
    return {
      verified: Array.isArray(parsed.verified) ? parsed.verified : [],
      retracted: Array.isArray(parsed.retracted) ? parsed.retracted : [],
    };
  } catch {
    try {
      const json = extractJson(text);
      const parsed = JSON.parse(json);
      return {
        verified: Array.isArray(parsed.verified) ? parsed.verified : [],
        retracted: Array.isArray(parsed.retracted) ? parsed.retracted : [],
      };
    } catch {
      return { verified: [], retracted: [] };
    }
  }
}
