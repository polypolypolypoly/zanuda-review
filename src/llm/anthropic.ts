import Anthropic from "@anthropic-ai/sdk";
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
      notes.push(`${key}: ${String(value)}`);
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
      ...(req.jsonSchema
        ? {
            output_config: {
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
    return { text, model: req.model, provider: this.name };
  }
}
