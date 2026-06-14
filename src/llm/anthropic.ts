import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./types.js";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  /** tool_use with input_schema provides full JSON Schema enforcement. */
  readonly supportsStructuredOutput = true;
  private client: Anthropic;

  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // temperature is deprecated for Claude 4+ models — omit it entirely
    // and let the model use its default. Claude 3 and earlier still
    // accept it, but omitting is safe for all versions.

    if (req.jsonSchema) {
      // Use tool_use to guarantee the response matches the JSON schema.
      // tool_choice: {type: "tool"} forces the model to always call the tool,
      // returning structured JSON rather than free text.
      const res = await this.client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        tools: [
          {
            name: "structured_result",
            description: "Return the structured result as specified.",
            input_schema: req.jsonSchema as Anthropic.Tool["input_schema"],
          },
        ],
        tool_choice: { type: "tool", name: "structured_result" },
      });
      const toolBlock = res.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const text = toolBlock ? JSON.stringify(toolBlock.input) : "{}";
      return { text, model: req.model, provider: this.name };
    }

    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, model: req.model, provider: this.name };
  }
}
