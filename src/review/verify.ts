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
 *
 * Failure mode: verification is a precision filter, not a correctness gate.
 * If the verifier can't parse its result, we keep the original findings and
 * log loudly — a parse failure should never silently suppress real issues.
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
 * If verification itself fails (provider error, unparseable response),
 * keeps all original findings — verification is a precision filter, not
 * a correctness gate. A parse failure shouldn't silently approve.
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

  try {
    const completion = await completeWithRetry(provider, {
      system: VERIFICATION_SYSTEM,
      user: verificationPrompt,
      model: config.models[config.provider],
      temperature: 0,
      maxTokens: Math.min(config.generation.maxTokens, 4096),
    });

    const result = parseVerificationResult(completion.text, findings.length);

    // Log retractions
    for (const idx of result.retractedIndices) {
      const f = findings[idx];
      if (f) {
        log.warn(
          { path: f.path, line: f.line, body: f.body.slice(0, 100) },
          "Finding retracted — could not be verified against diff",
        );
      }
    }

    // Keep findings whose index was verified, drop the rest
    const verifiedSet = new Set(result.verifiedIndices);
    return findings.filter((_, i) => verifiedSet.has(i));
  } catch (err) {
    // Verification itself failed — fail open: keep all findings
    log.warn(
      { err },
      "Verification pass failed — keeping original findings unverified",
    );
    return findings;
  }
}

const VERIFICATION_SYSTEM = `\
You verify code review findings against a diff. Your only job: for each
finding, point to the exact diff line(s) that prove the issue. If you
cannot find clear evidence in the diff, mark the finding as RETRACTED.

Rules:
- You are NOT producing new findings. Only verify what's given.
- A finding is verified if there is concrete evidence in the diff that
  supports it. "Concrete" means a specific line or hunk that shows the issue.
- If the finding references a line that doesn't appear in the diff,
  or the diff doesn't show the claimed issue, retract it.
- If the diff shows the issue but the finding mischaracterizes it, retract it.
- Do not retract just because the finding is imprecise about the line number —
  if the issue is visible somewhere nearby (±5 lines), verify it.
- Return indices (0-based) of verified and retracted findings. Do NOT
  re-emit the finding bodies — reference by index only.`;

function buildVerificationPrompt(
  findings: ReviewComment[],
  diffText: string,
): string {
  const findingsList = findings
    .map((f, i) => `[${i}] ${f.path}:${f.line} ${f.severity}: ${f.body}`)
    .join("\n");

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
    `Verify each finding against the diff. Reference findings by their [N] index.`,
    `Return JSON with verified and retracted INDICES (0-based), not the full bodies:`,
    `{`,
    `  "verifiedIndices": [0, 2],`,
    `  "retractedIndices": [1]`,
    `}`,
    ``,
    `Only return indices. Do not re-emit the finding bodies.`,
  ].join("\n");
}

interface VerificationResult {
  verifiedIndices: number[];
  retractedIndices: number[];
}

function parseVerificationResult(
  text: string,
  totalFindings: number,
): VerificationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      const json = extractJson(text);
      parsed = JSON.parse(json);
    } catch {
      throw new Error("Unparseable verification response");
    }
  }

  if (typeof parsed !== "object" || parsed === null)
    throw new Error("Not an object");

  const obj = parsed as Record<string, unknown>;
  const verified = normalizeIndices(obj.verifiedIndices, totalFindings);
  const retracted = normalizeIndices(obj.retractedIndices, totalFindings);

  // A finding can't be both verified and retracted — verified wins
  const retractedSet = new Set(retracted);
  const verifiedSet = new Set(verified);
  for (const r of retractedSet) verifiedSet.delete(r);

  return {
    verifiedIndices: [...verifiedSet],
    retractedIndices: [...retractedSet],
  };
}

/** Validate and clamp indices to the valid range. */
function normalizeIndices(raw: unknown, max: number): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n < max);
}
