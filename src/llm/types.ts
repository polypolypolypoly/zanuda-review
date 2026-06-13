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
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
