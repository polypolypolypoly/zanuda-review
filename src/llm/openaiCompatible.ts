import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./types.js";

/**
 * Model families that reject a `temperature` other than the default. Matched as
 * a prefix on the model id, after any vendor route prefix ("openai/gpt-5").
 * A wrong guess here is a 400, so the list stays short and explicit; anything
 * unlisted keeps the configured temperature.
 */
const FIXED_TEMPERATURE_MODELS = ["o1", "o3", "o4", "gpt-5"];

/** True when the endpoint accepts `temperature` for this model. */
export function supportsTemperature(model: string): boolean {
  const id = (model.split("/").pop() ?? model).toLowerCase();
  return !FIXED_TEMPERATURE_MODELS.some(
    (family) => id === family || id.startsWith(`${family}-`),
  );
}

/**
 * One implementation for every OpenAI-compatible Chat Completions endpoint.
 * OpenAI, OpenRouter, Ollama, and DeepSeek all speak this protocol — they
 * differ only in base URL, auth, and structured-output capability.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly supportsStructuredOutput: boolean;
  readonly maxOutputTokens: number | undefined;
  private client: OpenAI;
  /** json_object = valid JSON without schema enforcement; json_schema = strict schema */
  private jsonMode: "json_schema" | "json_object";
  /** OpenAI renamed max_tokens; compatibility layers mostly still want the old name. */
  private tokenParam: "max_tokens" | "max_completion_tokens";

  constructor(opts: {
    name: string;
    apiKey: string;
    baseURL?: string;
    /** Defaults to json_schema. Use json_object for providers that don't support strict schema mode. */
    jsonMode?: "json_schema" | "json_object";
    /** Provider's effective max output token cap. Set for local models with small output windows. */
    maxOutputTokens?: number;
    /** Which output-length parameter this endpoint expects. Defaults to max_tokens. */
    tokenParam?: "max_tokens" | "max_completion_tokens";
  }) {
    this.name = opts.name;
    this.supportsStructuredOutput =
      (opts.jsonMode ?? "json_schema") === "json_schema";
    this.maxOutputTokens = opts.maxOutputTokens;
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.jsonMode = opts.jsonMode ?? "json_schema";
    this.tokenParam = opts.tokenParam ?? "max_tokens";
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const base = {
      model: req.model,
      // Reasoning models accept only their default temperature and 400 on
      // anything else — omit the parameter rather than guess the default.
      ...(supportsTemperature(req.model)
        ? { temperature: req.temperature }
        : {}),
      [this.tokenParam]: req.maxTokens,
      messages: [
        { role: "system" as const, content: req.system },
        { role: "user" as const, content: req.user },
      ],
    };

    if (req.jsonSchema) {
      if (this.jsonMode === "json_schema") {
        // Full schema enforcement at the API level — model output is
        // guaranteed to match the schema. No extractJson needed.
        const res = await this.client.chat.completions.create({
          ...base,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "structured_result",
              strict: true,
              schema: req.jsonSchema,
            },
          } as Parameters<
            typeof this.client.chat.completions.create
          >[0]["response_format"],
        });
        const text = res.choices[0]?.message?.content ?? "{}";
        return { text, model: req.model, provider: this.name };
      }

      // json_object mode: guarantees valid JSON but no schema enforcement.
      // The prompt carries the format instructions instead.
      const res = await this.client.chat.completions.create({
        ...base,
        response_format: { type: "json_object" },
      });
      const text = res.choices[0]?.message?.content ?? "{}";
      return { text, model: req.model, provider: this.name };
    }

    const res = await this.client.chat.completions.create(base);
    const text = res.choices[0]?.message?.content ?? "";
    return { text, model: req.model, provider: this.name };
  }
}

export function openAIProvider(): LLMProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const baseURL = process.env.OPENAI_BASE_URL || undefined;
  return new OpenAICompatibleProvider({
    name: "openai",
    apiKey,
    baseURL,
    // OpenAI's own endpoint deprecated max_tokens in favour of
    // max_completion_tokens and rejects the old name on newer models. The
    // other providers below keep max_tokens — their compatibility layers are
    // built against the older shape.
    tokenParam: "max_completion_tokens",
  });
}

export function openRouterProvider(): LLMProvider {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return new OpenAICompatibleProvider({
    name: "openrouter",
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
}

export function ollamaProvider(): LLMProvider {
  // Ollama ignores the API key but the SDK requires a non-empty string.
  const baseURL = `${process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"}/v1`;
  return new OpenAICompatibleProvider({
    name: "ollama",
    apiKey: "ollama",
    baseURL,
    // Local models commonly have small output windows (2K–4K). 2048 is a
    // safe default that prevents max_tokens-rejection 400s; override via
    // OLLAMA_MAX_OUTPUT_TOKENS env var if your model supports more.
    maxOutputTokens: Number(process.env.OLLAMA_MAX_OUTPUT_TOKENS) || 2048,
  });
}

export function deepseekProvider(): LLMProvider {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");
  const baseURL =
    process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
  // DeepSeek supports json_object mode but NOT json_schema strict mode.
  // json_object guarantees valid JSON while the prompt carries the schema.
  return new OpenAICompatibleProvider({
    name: "deepseek",
    apiKey,
    baseURL,
    jsonMode: "json_object",
  });
}

export function geminiProvider(): LLMProvider {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const baseURL =
    process.env.GEMINI_BASE_URL ??
    "https://generativelanguage.googleapis.com/v1beta/openai/";
  return new OpenAICompatibleProvider({
    name: "gemini",
    apiKey,
    baseURL,
    jsonMode: "json_object",
  });
}
