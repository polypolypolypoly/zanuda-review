import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./types.js";

/**
 * One implementation for every OpenAI-compatible Chat Completions endpoint.
 * OpenAI, OpenRouter, Ollama, and DeepSeek all speak this protocol — they
 * differ only in base URL, auth, and structured-output capability.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly supportsStructuredOutput: boolean;
  private client: OpenAI;
  /** json_object = valid JSON without schema enforcement; json_schema = strict schema */
  private jsonMode: "json_schema" | "json_object";

  constructor(opts: {
    name: string;
    apiKey: string;
    baseURL?: string;
    /** Defaults to json_schema. Use json_object for providers that don't support strict schema mode. */
    jsonMode?: "json_schema" | "json_object";
  }) {
    this.name = opts.name;
    this.supportsStructuredOutput =
      (opts.jsonMode ?? "json_schema") === "json_schema";
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.jsonMode = opts.jsonMode ?? "json_schema";
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const base = {
      model: req.model,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
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
  return new OpenAICompatibleProvider({ name: "openai", apiKey });
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
