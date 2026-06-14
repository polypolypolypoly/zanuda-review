/**
 * Boundary and property tests for the config system.
 *
 * ConfigSchema is not exported (it's internal to config.ts), but:
 * - RepoConfigSchema IS exported and uses the same validators — we test
 *   boundary values through it.
 * - mergeRepoConfig is a pure function — we test its invariants with
 *   both hand-crafted and property-based inputs.
 *
 * These tests focus on the questions "what happens at the edges of the
 * allowed ranges?" and "does merging always produce a valid, non-mutating
 * result?" — neither of which is covered by the existing config tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fc from "fast-check";
import {
  mergeRepoConfig,
  RepoConfigSchema,
  type Config,
} from "../src/config.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseConfig: Config = {
  provider: "anthropic",
  models: {
    anthropic: "claude",
    openai: "gpt-4o",
    openrouter: "r",
    ollama: "q",
    deepseek: "deepseek-chat",
  },
  generation: { temperature: 0.2, maxTokens: 4096 },
  preprompt: "You are a reviewer.",
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
    maxFileChars: 20_000,
    includeFileTree: true,
    maxTreeEntries: 400,
  },
  review: { maxDiffChars: 60_000, inlineComments: true },
};

// ── RepoConfigSchema: numeric field boundaries ────────────────────────────────

describe("RepoConfigSchema: generation.temperature boundaries", () => {
  it("accepts 0 (minimum)", () => {
    const r = RepoConfigSchema.safeParse({
      generation: { temperature: 0, maxTokens: 1024 },
    });
    assert.ok(
      r.success,
      `expected success but got: ${!r.success ? JSON.stringify(r.error.issues) : ""}`,
    );
  });

  it("accepts 2 (maximum)", () => {
    const r = RepoConfigSchema.safeParse({
      generation: { temperature: 2, maxTokens: 1024 },
    });
    assert.ok(r.success);
  });

  it("accepts 0.7 (typical value)", () => {
    const r = RepoConfigSchema.safeParse({
      generation: { temperature: 0.7, maxTokens: 1024 },
    });
    assert.ok(r.success);
  });

  it("rejects -0.001 (below minimum)", () => {
    const r = RepoConfigSchema.safeParse({
      generation: { temperature: -0.001, maxTokens: 1024 },
    });
    assert.ok(!r.success);
    assert.ok(
      r.error.issues.some((i) =>
        JSON.stringify(i.path).includes("temperature"),
      ),
    );
  });

  it("rejects 2.001 (above maximum)", () => {
    const r = RepoConfigSchema.safeParse({
      generation: { temperature: 2.001, maxTokens: 1024 },
    });
    assert.ok(!r.success);
  });
});

describe("RepoConfigSchema: generation.maxTokens boundaries", () => {
  it("accepts 1 (minimum positive integer)", () => {
    const r = RepoConfigSchema.safeParse({
      generation: { temperature: 0.2, maxTokens: 1 },
    });
    assert.ok(r.success);
  });

  it("accepts 8192 (typical value)", () => {
    const r = RepoConfigSchema.safeParse({
      generation: { temperature: 0.2, maxTokens: 8192 },
    });
    assert.ok(r.success);
  });

  it("rejects 0 (not positive)", () => {
    const r = RepoConfigSchema.safeParse({
      generation: { temperature: 0.2, maxTokens: 0 },
    });
    assert.ok(!r.success);
  });

  it("rejects -1 (negative)", () => {
    const r = RepoConfigSchema.safeParse({
      generation: { temperature: 0.2, maxTokens: -1 },
    });
    assert.ok(!r.success);
  });

  it("rejects 1.5 (non-integer)", () => {
    const r = RepoConfigSchema.safeParse({
      generation: { temperature: 0.2, maxTokens: 1.5 },
    });
    assert.ok(!r.success);
  });
});

describe("RepoConfigSchema: limits boundaries", () => {
  it("accepts maxConcurrentReviews: 1 (minimum positive integer)", () => {
    const r = RepoConfigSchema.safeParse({
      limits: { maxConcurrentReviews: 1, maxNewPrsPerCycle: 1 },
    });
    assert.ok(r.success);
  });

  it("rejects maxConcurrentReviews: 0", () => {
    const r = RepoConfigSchema.safeParse({
      limits: { maxConcurrentReviews: 0, maxNewPrsPerCycle: 1 },
    });
    assert.ok(!r.success);
  });

  it("accepts maxNewPrsPerCycle: 1 (minimum positive integer)", () => {
    const r = RepoConfigSchema.safeParse({
      limits: { maxConcurrentReviews: 1, maxNewPrsPerCycle: 1 },
    });
    assert.ok(r.success);
  });

  it("rejects maxNewPrsPerCycle: 0", () => {
    const r = RepoConfigSchema.safeParse({
      limits: { maxConcurrentReviews: 1, maxNewPrsPerCycle: 0 },
    });
    assert.ok(!r.success);
  });
});

describe("RepoConfigSchema: memory.maxHistoryEntries boundaries", () => {
  it("accepts 1 (minimum)", () => {
    const r = RepoConfigSchema.safeParse({ memory: { maxHistoryEntries: 1 } });
    assert.ok(r.success);
  });

  it("rejects 0", () => {
    const r = RepoConfigSchema.safeParse({ memory: { maxHistoryEntries: 0 } });
    assert.ok(!r.success);
  });

  it("rejects 10.5 (non-integer)", () => {
    const r = RepoConfigSchema.safeParse({
      memory: { maxHistoryEntries: 10.5 },
    });
    assert.ok(!r.success);
  });
});

describe("RepoConfigSchema: provider values", () => {
  it("accepts all valid provider values", () => {
    for (const provider of [
      "anthropic",
      "openai",
      "openrouter",
      "ollama",
      "deepseek",
    ] as const) {
      const r = RepoConfigSchema.safeParse({ provider });
      assert.ok(r.success, `expected "${provider}" to be valid`);
    }
  });

  it("rejects unknown provider value", () => {
    const r = RepoConfigSchema.safeParse({ provider: "nonexistent" });
    assert.ok(!r.success);
  });
});

// ── mergeRepoConfig: deterministic invariants ─────────────────────────────────

describe("mergeRepoConfig: core invariants", () => {
  it("merging with null is always identity", () => {
    const result = mergeRepoConfig(baseConfig, null);
    assert.deepEqual(result, baseConfig);
  });

  it("does not mutate the base config", () => {
    const frozen = structuredClone(baseConfig);
    mergeRepoConfig(baseConfig, {
      provider: "openai",
      prepromptAppend: "extra",
    });
    assert.deepEqual(baseConfig, frozen);
  });

  it("prepromptAppend always concatenates onto the existing preprompt", () => {
    const append = "Extra rule.";
    const result = mergeRepoConfig(baseConfig, { prepromptAppend: append });
    assert.ok(result.preprompt.startsWith(baseConfig.preprompt));
    assert.ok(result.preprompt.includes(append));
  });

  it("explicit preprompt fully replaces the base", () => {
    const result = mergeRepoConfig(baseConfig, { preprompt: "Brand new." });
    assert.equal(result.preprompt, "Brand new.");
    assert.ok(!result.preprompt.includes(baseConfig.preprompt));
  });

  it("partial memory override preserves unset memory fields", () => {
    const result = mergeRepoConfig(baseConfig, { memory: { enabled: false } });
    assert.equal(result.memory.enabled, false);
    assert.equal(result.memory.dir, baseConfig.memory.dir);
    assert.equal(
      result.memory.updateAfterReview,
      baseConfig.memory.updateAfterReview,
    );
    assert.equal(
      result.memory.maxHistoryEntries,
      baseConfig.memory.maxHistoryEntries,
    );
  });
});

// ── mergeRepoConfig: property-based ──────────────────────────────────────────

describe("mergeRepoConfig: property-based", () => {
  /** Arbitrary for a valid partial provider value */
  const providerArb = fc.oneof(
    fc.constant("anthropic" as const),
    fc.constant("openai" as const),
    fc.constant("openrouter" as const),
    fc.constant("ollama" as const),
    fc.constant("deepseek" as const),
  );

  it("null overlay is always identity — for any base config shape", () => {
    // We vary a few config fields to ensure the identity holds broadly.
    fc.assert(
      fc.property(
        providerArb,
        fc.string({ minLength: 1 }),
        fc.boolean(),
        (provider, preprompt, inlineComments) => {
          const config: Config = {
            ...baseConfig,
            provider,
            preprompt,
            review: { ...baseConfig.review, inlineComments },
          };
          const result = mergeRepoConfig(config, null);
          assert.deepEqual(result, config);
        },
      ),
    );
  });

  it("provider override is always reflected in the result", () => {
    fc.assert(
      fc.property(providerArb, (provider) => {
        const result = mergeRepoConfig(baseConfig, { provider });
        assert.equal(result.provider, provider);
        // Other fields are untouched
        assert.equal(result.preprompt, baseConfig.preprompt);
      }),
    );
  });

  it("prepromptAppend always appends — for any string", () => {
    fc.assert(
      fc.property(fc.string(), (append) => {
        const result = mergeRepoConfig(baseConfig, { prepromptAppend: append });
        assert.ok(result.preprompt.includes(baseConfig.preprompt));
        assert.ok(result.preprompt.includes(append));
        assert.ok(result.preprompt.length >= baseConfig.preprompt.length);
      }),
    );
  });

  it("merging never shortens the allowlist beyond what the overlay specifies", () => {
    const allowlistArb = fc.array(
      fc.stringMatching(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/),
      { minLength: 0, maxLength: 5 },
    );
    fc.assert(
      fc.property(allowlistArb, (allowlist) => {
        const result = mergeRepoConfig(baseConfig, { access: { allowlist } });
        assert.deepEqual(result.access.allowlist, allowlist);
      }),
    );
  });

  it("base config is never mutated — for any overlay", () => {
    const overlayArb = fc.record({
      provider: fc.option(providerArb),
      prepromptAppend: fc.option(fc.string()),
    });
    fc.assert(
      fc.property(overlayArb, (overlay) => {
        const before = structuredClone(baseConfig);
        mergeRepoConfig(baseConfig, overlay);
        assert.deepEqual(baseConfig, before, "base config was mutated");
      }),
    );
  });
});
