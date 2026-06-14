import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  deepseekProvider,
  OpenAICompatibleProvider,
} from "../src/llm/openaiCompatible.js";
import type { CompletionRequest } from "../src/llm/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const API_KEY = "sk-deepseek-test-key";

function saveEnv(name: string): string | undefined {
  return process.env[name];
}
function restoreEnv(name: string, value: string | undefined): void {
  if (value !== undefined) process.env[name] = value;
  else delete process.env[name];
}

function makeReq(
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest {
  return {
    system: "You are a reviewer.",
    user: "Review this diff.",
    model: "deepseek-chat",
    temperature: 0.2,
    maxTokens: 4096,
    ...overrides,
  };
}

// ─── deepseekProvider factory ────────────────────────────────────────────────

describe("deepseekProvider factory", () => {
  const savedKey = saveEnv("DEEPSEEK_API_KEY");
  const savedBase = saveEnv("DEEPSEEK_BASE_URL");

  beforeEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
  });

  afterEach(() => {
    restoreEnv("DEEPSEEK_API_KEY", savedKey);
    restoreEnv("DEEPSEEK_BASE_URL", savedBase);
  });

  it("throws when DEEPSEEK_API_KEY is not set", () => {
    assert.throws(() => deepseekProvider(), /DEEPSEEK_API_KEY/);
  });

  it("returns a provider with name='deepseek'", () => {
    process.env.DEEPSEEK_API_KEY = API_KEY;
    const p = deepseekProvider();
    assert.equal(p.name, "deepseek");
  });

  it("sets supportsStructuredOutput to false", () => {
    process.env.DEEPSEEK_API_KEY = API_KEY;
    const p = deepseekProvider();
    assert.equal(p.supportsStructuredOutput, false);
  });

  it("defaults baseURL to api.deepseek.com/v1", () => {
    process.env.DEEPSEEK_API_KEY = API_KEY;
    const p = deepseekProvider();
    assert.equal(p.name, "deepseek");
  });

  it("honors DEEPSEEK_BASE_URL env override", () => {
    process.env.DEEPSEEK_API_KEY = API_KEY;
    process.env.DEEPSEEK_BASE_URL = "https://deepseek-proxy.example.com/v1";
    const p = deepseekProvider();
    assert.equal(p.name, "deepseek");
    assert.equal(p.supportsStructuredOutput, false);
  });
});

// ─── json_object branch (DeepSeek's mode) ────────────────────────────────────

describe("OpenAICompatibleProvider json_object mode", () => {
  it("sends response_format: { type: 'json_object' } when jsonSchema is provided", async () => {
    let capturedParams: Record<string, unknown> | null = null;

    const provider = new OpenAICompatibleProvider({
      name: "deepseek",
      apiKey: API_KEY,
      baseURL: "https://api.deepseek.com/v1",
      jsonMode: "json_object",
    });

    // Replace the real client so we don't hit the network.
    (provider as unknown as Record<string, unknown>)["client"] = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            capturedParams = params;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: "ok",
                      action: "COMMENT",
                      filesSummary: [],
                      comments: [],
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const req = makeReq({
      jsonSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
      },
    });

    const result = await provider.complete(req);

    // Verify response format shape
    assert.ok(capturedParams, "create() should have been called");
    const rf = capturedParams!["response_format"] as Record<string, unknown>;
    assert.equal(rf.type, "json_object");

    // json_schema strict mode must NOT have been used — no json_schema key
    assert.equal(
      rf["json_schema"],
      undefined,
      "json_schema key must not be present in json_object mode",
    );

    // Verify result
    assert.equal(result.model, "deepseek-chat");
    assert.equal(result.provider, "deepseek");
    assert.ok(typeof result.text === "string");
    assert.ok(result.text.includes("summary"));
  });

  it("does not send response_format at all when no jsonSchema", async () => {
    let capturedParams: Record<string, unknown> | null = null;

    const provider = new OpenAICompatibleProvider({
      name: "deepseek",
      apiKey: API_KEY,
      jsonMode: "json_object",
    });

    (provider as unknown as Record<string, unknown>)["client"] = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            capturedParams = params;
            return { choices: [{ message: { content: "plain text" } }] };
          },
        },
      },
    };

    const req = makeReq(); // no jsonSchema
    await provider.complete(req);

    assert.ok(capturedParams);
    assert.equal(
      capturedParams!["response_format"],
      undefined,
      "response_format must be absent when jsonSchema is not provided",
    );
  });

  it("fallbacks to '{}' when message content is null", async () => {
    const provider = new OpenAICompatibleProvider({
      name: "deepseek",
      apiKey: API_KEY,
      jsonMode: "json_object",
    });

    (provider as unknown as Record<string, unknown>)["client"] = {
      chat: {
        completions: {
          create: async (_params: Record<string, unknown>) => {
            return { choices: [{ message: { content: null } }] };
          },
        },
      },
    };

    const req = makeReq({
      jsonSchema: { type: "object" },
    });

    const result = await provider.complete(req);
    assert.equal(result.text, "{}");
  });

  it("records model and provider in the result", async () => {
    const provider = new OpenAICompatibleProvider({
      name: "deepseek",
      apiKey: API_KEY,
      jsonMode: "json_object",
    });

    (provider as unknown as Record<string, unknown>)["client"] = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "response text" } }],
          }),
        },
      },
    };

    const req = makeReq({ model: "deepseek-reasoner" });
    const result = await provider.complete(req);

    assert.equal(result.model, "deepseek-reasoner");
    assert.equal(result.provider, "deepseek");
    assert.equal(result.text, "response text");
  });

  it("supportsStructuredOutput is false in json_object mode", () => {
    const provider = new OpenAICompatibleProvider({
      name: "test",
      apiKey: "k",
      jsonMode: "json_object",
    });
    assert.equal(provider.supportsStructuredOutput, false);
  });
});

// ─── json_schema mode (comparison) ───────────────────────────────────────────

describe("OpenAICompatibleProvider json_schema mode (OpenAI path)", () => {
  it("sends response_format with json_schema strict when jsonSchema is provided", async () => {
    let capturedParams: Record<string, unknown> | null = null;

    const provider = new OpenAICompatibleProvider({
      name: "openai",
      apiKey: API_KEY,
    });
    // defaults to json_schema

    (provider as unknown as Record<string, unknown>)["client"] = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            capturedParams = params;
            return {
              choices: [{ message: { content: '{"summary":"ok"}' } }],
            };
          },
        },
      },
    };

    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
    };

    await provider.complete(makeReq({ jsonSchema: schema }));

    assert.ok(capturedParams);
    const rf = capturedParams!["response_format"] as Record<string, unknown>;
    assert.equal(rf.type, "json_schema");
    const js = rf["json_schema"] as Record<string, unknown>;
    assert.equal(js.name, "structured_result");
    assert.equal(js.strict, true);
    assert.deepEqual(js.schema, schema);
  });

  it("supportsStructuredOutput is true by default", () => {
    const provider = new OpenAICompatibleProvider({
      name: "openai",
      apiKey: "k",
    });
    assert.equal(provider.supportsStructuredOutput, true);
  });
});
