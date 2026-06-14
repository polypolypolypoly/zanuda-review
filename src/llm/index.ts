import type { Config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import {
  deepseekProvider,
  geminiProvider,
  ollamaProvider,
  openAIProvider,
  openRouterProvider,
} from "./openaiCompatible.js";
import type { LLMProvider } from "./types.js";

export type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./types.js";

/**
 * Module-level cache so that repeated calls for the same provider (e.g. one
 * per PR in the poller loop) reuse the same SDK client and its connection pool
 * rather than allocating a new one every time.
 */
const _providerCache = new Map<string, LLMProvider>();

/**
 * Return the provider instance for the given name, creating it on first use.
 * This is the single switch the rest of the app uses; adding a new backend
 * means adding one case to `_buildProvider`.
 */
export function createProvider(provider: Config["provider"]): LLMProvider {
  const cached = _providerCache.get(provider);
  if (cached) return cached;
  const instance = _buildProvider(provider);
  _providerCache.set(provider, instance);
  return instance;
}

function _buildProvider(provider: Config["provider"]): LLMProvider {
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return openAIProvider();
    case "openrouter":
      return openRouterProvider();
    case "ollama":
      return ollamaProvider();
    case "deepseek":
      return deepseekProvider();
    case "gemini":
      return geminiProvider();

    // ── Add new providers here ────────────────────────────────────────────
    // 1. Copy src/llm/stub.ts → src/llm/<name>.ts and implement complete().
    // 2. Import your factory function above.
    // 3. Add a case:
    //      case "myprovider":
    //        return myProvider();
    // 4. Add "myprovider" to the provider enum in src/config.ts.
    // 5. Add a default model under models: in config/default.yaml.
    // 6. Add the API key to .env.example.
    // See CONTRIBUTING.md for the full guide.
    // ─────────────────────────────────────────────────────────────────────

    default: {
      const _exhaustive: never = provider;
      throw new Error(
        `Unknown LLM provider: "${_exhaustive}". ` +
          `See src/llm/stub.ts to implement a new one.`,
      );
    }
  }
}
