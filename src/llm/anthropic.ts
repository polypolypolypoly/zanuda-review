import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger.js";
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./types.js";

/**
 * JSON Schema keywords that structured outputs rejects with a 400.
 *
 * The grammar-constrained sampler supports a subset of JSON Schema; length and
 * range constraints are not in it. They stay in the canonical schema (the
 * OpenAI-compatible path sends it verbatim) and are enforced in code by the
 * hard output filters — see review/filters.ts.
 */
const UNSUPPORTED_KEYWORDS = [
  "maxLength",
  "minLength",
  "minimum",
  "maximum",
  "multipleOf",
] as const;

/**
 * Render a dropped constraint value for the prose note. `JSON.stringify` keeps
 * array/object values readable where `String()` would collapse them to
 * `[object Object]`; strings stay unquoted so the note reads naturally.
 */
export function serializeConstraintValue(value: unknown): string {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value) ?? String(value));
}

/**
 * Strip the unsupported keywords, keeping the constraint visible to the model
 * as prose in `description` — the same trade the SDK's own schema helpers make.
 */
export function sanitizeSchemaForAnthropic(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForAnthropic);
  if (schema === null || typeof schema !== "object") return schema;

  const notes: string[] = [];
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(
    schema as Record<string, unknown>,
  )) {
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
      notes.push(`${key}: ${serializeConstraintValue(value)}`);
      continue;
    }
    out[key] = sanitizeSchemaForAnthropic(value);
  }

  if (notes.length > 0) {
    const existing = typeof out.description === "string" ? out.description : "";
    out.description = `${existing}${existing ? " " : ""}(${notes.join(", ")})`;
  }

  return out;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  /** output_config.format constrains generation to the JSON schema. */
  readonly supportsStructuredOutput = true;
  private client: Anthropic;

  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // temperature is not accepted by current Claude models — omit it and let
    // the model use its default.
    //
    // Structured output goes through output_config.format rather than a forced
    // tool call: the response is a plain text block that is already valid
    // against the schema, so both paths below read the text the same way.
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      // claude-opus-5-5 is an adaptive-thinking model whose hidden reasoning
      // tokens count against max_tokens; a multi-file batch can burn the whole
      // budget thinking and return an empty/truncated body. The model rejects
      // `thinking.type.disabled`, so pin adaptive thinking to LOW effort — the
      // preprompt + verifyFindings pass already enforce review discipline, and
      // this leaves max_tokens for the visible structured output.
      thinking: { type: "adaptive", display: "omitted" },
      ...(req.jsonSchema
        ? {
            output_config: {
              effort: "low",
              format: {
                type: "json_schema" as const,
                schema: sanitizeSchemaForAnthropic(req.jsonSchema) as Record<
                  string,
                  unknown
                >,
              },
            },
          }
        : {}),
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Diagnostic: reasoning models spend output tokens on hidden thinking.
    // When generation stops short (stop_reason !== "end_turn") the visible
    // text is truncated, which surfaces downstream as a JSON parse failure.
    if (res.stop_reason !== "end_turn") {
      logger.warn(
        {
          model: req.model,
          stopReason: res.stop_reason,
          outputTokens: res.usage?.output_tokens,
          inputTokens: res.usage?.input_tokens,
          maxTokens: req.maxTokens,
          textChars: text.length,
          thinkingBlocks: res.content.filter(
            (b) => b.type === "thinking" || b.type === "redacted_thinking",
          ).length,
        },
        "Anthropic generation stopped before end_turn",
      );
    }

    return { text, model: req.model, provider: this.name };
  }
}
