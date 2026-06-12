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
