/**
 * The model-agnostic contract. Every provider (Anthropic, OpenAI, OpenRouter,
 * Ollama, …) implements this single method. The review engine never imports a
 * concrete provider — it depends only on `LLMProvider`.
 */
export interface CompletionRequest {
  /** System / preprompt instruction. */
  system: string;
  /** The user message (assembled context + diff + task). */
  user: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /**
   * When provided, the provider uses its native structured-output API
   * (Anthropic tool_use, OpenAI json_schema mode) to guarantee the response
   * matches this JSON Schema object. The caller receives a pre-validated JSON
   * string and can skip extractJson entirely.
   *
   * Providers that do not support structured output ignore this field and
   * fall back to plain text completion.
   */
  jsonSchema?: Record<string, unknown>;
}

export interface CompletionResult {
  text: string;
  /** Provider + model that produced the text, for logging/attribution. */
  model: string;
  provider: string;
}

export interface LLMProvider {
  readonly name: string;
  /**
   * Whether this provider can enforce JSON Schema at the API level
   * (Anthropic tool_use, OpenAI json_schema strict mode).
   *
   * When false the engine falls back to including full output-format
   * instructions in the user prompt and uses extractJson to parse the
   * response. The provider may still use json_object mode to guarantee
   * valid JSON without schema enforcement.
   */
  readonly supportsStructuredOutput: boolean;
  /**
   * Provider's effective max output token limit. Undefined = no known cap
   * (cloud models with large output windows). When set, adaptiveMaxTokens
   * uses this as an additional ceiling to prevent 400s from providers that
   * reject oversized max_tokens requests (e.g. local Ollama models).
   */
  readonly maxOutputTokens?: number;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
