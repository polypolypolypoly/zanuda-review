import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.ts";
import type { LLMProvider } from "../src/llm/types.ts";
import type { ProjectContext } from "../src/context/builder.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseConfig: Config = {
  provider: "anthropic",
  models: {
    anthropic: "claude-opus-4-8",
    openai: "gpt-4o",
    openrouter: "anthropic/claude-opus-4-8",
    ollama: "qwen2.5:3b",
    deepseek: "deepseek-chat",
    gemini: "gemini-2.5-flash",
  },
  generation: { temperature: 0.2, maxTokens: 8192 },
  preprompt: "You are a senior software engineer doing a code review.",
  persistence: { stateFile: "" },
  access: { allowlist: [] },
  limits: { maxConcurrentReviews: 3, maxNewPrsPerCycle: 5 },
  memory: {
    enabled: true,
    dir: "",
    updateAfterReview: true,
    maxHistoryEntries: 20,
  },
  context: {
    includeFiles: ["README.md"],
    maxFileChars: 20000,
    includeFileTree: true,
    maxTreeEntries: 400,
  },
  review: { maxDiffChars: 60000, inlineComments: true },
};

const stubProvider: LLMProvider = {
  name: "mock",
  supportsStructuredOutput: false,
  complete: async () => ({ text: "{}" }),
};

const contextWithFiles: ProjectContext = {
  text: [
    '<file path="src/a.ts">\nconst x = 1;\n</file>',
    '<file path="src/b.ts">\nconst y = 2;\n</file>',
    '<file path="src/c.ts">\nconst z = 3;\n</file>',
  ].join("\n"),
};

const emptyContext: ProjectContext = { text: "(no context)" };

const generatedMemory =
  "# Architecture\n\n## Overview\nMonorepo with three modules.\n";

// ─── Mutable test state (reset in afterEach) ─────────────────────────────────

let configOverride: Config = baseConfig;
let contextOverride: ProjectContext = contextWithFiles;
let memoryOverride = generatedMemory;
let savedPathOverride = "/home/user/.zanuda/memory/local_test.md";
let providerOverride: LLMProvider = stubProvider;

// Save calls are tracked so tests can inspect them.
let saveCalls: Array<{ config: Config; ref: unknown; content: string }> = [];

// ─── Register mocks synchronously ────────────────────────────────────────────

// cli.ts calls main() at the top level, which calls process.exit(2) when
// no flags/positionals are provided. Intercept process.exit so we can
// import the module without killing the test runner.
process.exit = ((_code?: number) => {
  // Swallow silently — main() is fire-and-forget at top level.
}) as typeof process.exit;

// Import the real config module to get ALL exports (mergeRepoConfig,
// RepoConfigSchema, etc.) needed by transitive dependencies.
const realConfig = await import("../src/config.ts");
mock.module("../src/config.ts", {
  namedExports: {
    ...Object.fromEntries(
      // Spread all runtime exports (functions, objects — types are erased)
      Object.entries(realConfig).filter(([, v]) => typeof v !== "undefined"),
    ),
    // Override loadConfig with a mock that returns controlled config
    loadConfig: mock.fn(() => ({
      ...configOverride,
      models: { ...configOverride.models },
      memory: { ...configOverride.memory },
    })),
  },
});

// repoMemory.ts has 4 exported functions. engine.ts uses all of them.
const realRepoMemory = await import("../src/context/repoMemory.ts");
mock.module("../src/context/repoMemory.ts", {
  namedExports: {
    ...Object.fromEntries(
      Object.entries(realRepoMemory).filter(
        ([, v]) => typeof v !== "undefined",
      ),
    ),
    generateRepoMemory: mock.fn(
      (_ref: unknown, _ctx: unknown, _cfg: unknown, _provider: unknown) =>
        Promise.resolve(memoryOverride),
    ),
    saveRepoMemory: mock.fn((cfg: Config, ref: unknown, content: string) => {
      saveCalls.push({ config: cfg, ref, content });
      return savedPathOverride;
    }),
  },
});

// builder.ts has buildContext + ProjectContext (type only, erased)
const realBuilder = await import("../src/context/builder.ts");
mock.module("../src/context/builder.ts", {
  namedExports: {
    ...Object.fromEntries(
      Object.entries(realBuilder).filter(([, v]) => typeof v !== "undefined"),
    ),
    buildContext: mock.fn(
      (_connector: unknown, _ref: unknown, _gitRef: unknown, _cfg: unknown) =>
        Promise.resolve(contextOverride),
    ),
  },
});

// llm/index.ts: createProvider + exported types (erased)
const realLLM = await import("../src/llm/index.ts");
mock.module("../src/llm/index.ts", {
  namedExports: {
    ...Object.fromEntries(
      Object.entries(realLLM).filter(([, v]) => typeof v !== "undefined"),
    ),
    createProvider: mock.fn((_name: string) => providerOverride),
  },
});

// platform/index.ts: LocalConnector, createConnector, type re-exports
const realPlatform = await import("../src/platform/index.ts");
mock.module("../src/platform/index.ts", {
  namedExports: {
    ...Object.fromEntries(
      Object.entries(realPlatform).filter(([, v]) => typeof v !== "undefined"),
    ),
    LocalConnector: mock.fn(function (this: { name: string }) {
      this.name = "local";
    }),
  },
});

// Now import cli.ts — the mocks above intercept all its imports.
// The main() call at the module level will fire but we've mocked process.exit.
const cliMod = (await import("../src/cli.ts")) as {
  runSpawn: (
    values: Record<string, string | boolean | undefined>,
  ) => Promise<void>;
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runSpawn", () => {
  afterEach(() => {
    // Reset mutable overrides
    configOverride = baseConfig;
    contextOverride = contextWithFiles;
    memoryOverride = generatedMemory;
    savedPathOverride = "/home/user/.zanuda/memory/local_test.md";
    providerOverride = stubProvider;

    // Clear tracked calls
    saveCalls = [];

    // Reset all mock call histories
    mock.reset();
  });

  // ── Basic path (no model override) ──────────────────────────────────────

  it("builds context, generates memory, and saves to the expected path", async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await cliMod.runSpawn({ spawn: true });
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(saveCalls.length, 1, "saveRepoMemory called once");
    assert.equal(saveCalls[0]!.content, generatedMemory);

    const stderr = stderrChunks.join("");
    assert.ok(
      stderr.includes("/home/user/.zanuda/memory/local_test.md"),
      `stderr should contain the saved path, got: ${stderr}`,
    );
    assert.ok(
      stderr.includes("Generating memory from 3 context file(s)"),
      `stderr should mention file count, got: ${stderr}`,
    );
    assert.ok(stderr.includes("Scanning"), "stderr should mention scanning");
  });

  // ── Model override branch ────────────────────────────────────────────────

  it("applies model override from --model flag", async () => {
    await cliMod.runSpawn({ spawn: true, model: "claude-sonnet-4-8" });

    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0]!.config.memory.enabled, true);
    assert.equal(
      saveCalls[0]!.config.models.anthropic,
      "claude-sonnet-4-8",
      "models.anthropic should reflect the model override",
    );
  });

  // ── Default repo-name via basename(cwd) ─────────────────────────────────

  it("uses basename(process.cwd()) as repo name", async () => {
    const origCwd = process.cwd;
    process.cwd = () => "/home/user/projects/my-test-project";
    try {
      await cliMod.runSpawn({ spawn: true });
    } finally {
      process.cwd = origCwd;
    }

    assert.equal(saveCalls.length, 1);
    assert.deepStrictEqual(saveCalls[0]!.ref, {
      owner: "local",
      repo: "my-test-project",
    });
  });

  // ── Custom memory path via saveRepoMemory return value ──────────────────

  it("reports the path returned by saveRepoMemory in stderr", async () => {
    savedPathOverride = "/var/lib/zanuda/memory/local_custom.md";

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await cliMod.runSpawn({ spawn: true });
    } finally {
      process.stderr.write = origWrite;
    }

    const stderr = stderrChunks.join("");
    assert.ok(
      stderr.includes("/var/lib/zanuda/memory/local_custom.md"),
      `stderr should contain custom path, got: ${stderr}`,
    );
    // Must NOT contain the old hardcoded path
    assert.ok(
      !stderr.includes("~/.zanuda/memory/local_"),
      `stderr should NOT contain hardcoded tilde path, got: ${stderr}`,
    );
  });

  // ── Empty context (zero files) ──────────────────────────────────────────

  it("handles empty context gracefully", async () => {
    contextOverride = emptyContext;

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await cliMod.runSpawn({ spawn: true });
    } finally {
      process.stderr.write = origWrite;
    }

    const stderr = stderrChunks.join("");
    assert.ok(
      stderr.includes("Generating memory from 0 context file(s)"),
      `stderr should report 0 files, got: ${stderr}`,
    );
    assert.equal(saveCalls.length, 1);
  });

  // ── Memory enabled forced to true ───────────────────────────────────────

  it("forces memory.enabled = true regardless of base config", async () => {
    configOverride = {
      ...baseConfig,
      memory: { ...baseConfig.memory, enabled: false },
    };

    await cliMod.runSpawn({ spawn: true });

    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0]!.config.memory.enabled, true);
  });
});
