import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./types.js";

/**
 * One implementation for every OpenAI-compatible Chat Completions endpoint.
 * OpenAI, OpenRouter and Ollama all speak this protocol — they differ only in
 * base URL and auth. The concrete providers below are thin presets.
 */
class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private client: OpenAI;

  constructor(opts: { name: string; apiKey: string; baseURL?: string }) {
    this.name = opts.name;
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await this.client.chat.completions.create({
      model: req.model,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    });
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
