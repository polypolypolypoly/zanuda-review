import type { Config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import {
  ollamaProvider,
  openAIProvider,
  openRouterProvider,
} from "./openaiCompatible.js";
import type { LLMProvider } from "./types.js";

export type { CompletionRequest, CompletionResult, LLMProvider } from "./types.js";

/**
 * Build the configured provider. This is the single switch the rest of the
 * app uses; adding a new backend means adding one case here.
 */
export function createProvider(provider: Config["provider"]): LLMProvider {
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return openAIProvider();
    case "openrouter":
      return openRouterProvider();
    case "ollama":
      return ollamaProvider();
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}
