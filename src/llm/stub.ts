/**
 * Stub LLM provider — starting point for implementing a new backend.
 *
 * Copy this file, rename the class, and implement `complete()`.
 * The review engine, prompt builder, and memory system require zero changes.
 *
 * Steps:
 *   1. cp src/llm/stub.ts src/llm/<name>.ts
 *   2. Implement complete() below.
 *   3. Export a factory function (see bottom of file).
 *   4. Register it in src/llm/index.ts (_buildProvider switch).
 *   5. Add the provider name to the enum in src/config.ts.
 *   6. Add a default model ID under models: in config/default.yaml.
 *   7. Add the API key / URL env var to .env.example.
 *
 * The existing providers are good references:
 *   - src/llm/anthropic.ts       — Anthropic Messages API
 *   - src/llm/openaiCompatible.ts — OpenAI Chat Completions (also OpenRouter, Ollama)
 */

import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./types.js";

export class StubProvider implements LLMProvider {
  /**
   * Short lowercase name shown in logs and used as the key in config.models.
   * Must match the case you add to the provider enum in src/config.ts.
   */
  readonly name = "stub";

  constructor() {
    // Initialise your SDK client here.
    // Read credentials from env vars — never hardcode keys.
    //
    // Example:
    //   const apiKey = process.env.MYPROVIDER_API_KEY;
    //   if (!apiKey) throw new Error("MYPROVIDER_API_KEY is not set");
    //   this.client = new MyProviderSDK({ apiKey });
  }

  /**
   * Send a completion request and return the model's text response.
   *
   * req.system   — the system / preprompt instruction
   * req.user     — the user message (assembled context + diff + task)
   * req.model    — model ID from config (e.g. "gpt-4o", "claude-opus-4-8")
   * req.temperature — sampling temperature (0–2); some APIs don't support it
   * req.maxTokens   — maximum tokens to generate
   *
   * Must return:
   *   text     — the raw completion text (may be wrapped in JSON, prose, etc.)
   *   model    — the model ID used (pass req.model through unless the API
   *              returns the actual model name)
   *   provider — this.name
   *
   * Notes:
   * - Do NOT parse the JSON inside complete(). The engine calls extractJson()
   *   on the returned text — your job is just to return the raw string.
   * - If the API doesn't support temperature, omit it from the request rather
   *   than passing 0 (some APIs treat 0 as "no randomness", others reject it).
   * - If the API streams responses, collect the full stream before returning.
   * - On API errors, throw — the engine catches and retries on the next poll.
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Replace with your actual API call:
    throw new Error(
      `StubProvider.complete: not implemented (model=${req.model})`,
    );
  }
}

/**
 * Factory function — called by src/llm/index.ts.
 * Read any required env vars here and throw clearly if they are missing.
 */
export function stubProvider(): LLMProvider {
  return new StubProvider();
}
