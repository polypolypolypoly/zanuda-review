/**
 * Boundary and property tests for the config system.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fc from "fast-check";
import {
  mergeRepoConfig,
  RepoConfigSchema,
  type Config,
} from "../src/config.js";

const baseConfig: Config = {
  provider: "anthropic",
  models: {
    anthropic: "claude",
    openai: "gpt-4o",
    openrouter: "r",
    ollama: "q",
    deepseek: "deepseek-chat",
    gemini: "gemini-2.5-flash",
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

// ── Numeric field boundaries (table-driven) ──────────────────────────────────

describe("RepoConfigSchema: numeric boundaries", () => {
  const cases = [
    // [field, value, valid?]
    { field: "temperature", value: 0, valid: true },
    { field: "temperature", value: 2, valid: true },
    { field: "temperature", value: -0.001, valid: false },
    { field: "temperature", value: 2.001, valid: false },
    { field: "maxTokens", value: 1, valid: true },
    { field: "maxTokens", value: 0, valid: false },
    { field: "maxTokens", value: -1, valid: false },
    { field: "maxTokens", value: 1.5, valid: false },
    { field: "maxConcurrentReviews", value: 1, valid: true },
    { field: "maxConcurrentReviews", value: 0, valid: false },
    { field: "maxNewPrsPerCycle", value: 1, valid: true },
    { field: "maxNewPrsPerCycle", value: 0, valid: false },
    { field: "maxHistoryEntries", value: 1, valid: true },
    { field: "maxHistoryEntries", value: 0, valid: false },
    { field: "maxHistoryEntries", value: 10.5, valid: false },
  ];

  for (const { field, value, valid } of cases) {
    it(`${field}=${value} → ${valid ? "accepts" : "rejects"}`, () => {
      const r = RepoConfigSchema.safeParse(buildOverlay(field, value));
      assert.equal(r.success, valid);
    });
  }
});

function buildOverlay(field: string, value: number): Record<string, unknown> {
  switch (field) {
    case "temperature":
      return { generation: { temperature: value, maxTokens: 1024 } };
    case "maxTokens":
      return { generation: { temperature: 0.2, maxTokens: value } };
    case "maxConcurrentReviews":
      return { limits: { maxConcurrentReviews: value, maxNewPrsPerCycle: 1 } };
    case "maxNewPrsPerCycle":
      return { limits: { maxConcurrentReviews: 1, maxNewPrsPerCycle: value } };
    case "maxHistoryEntries":
      return { memory: { maxHistoryEntries: value } };
    default:
      throw new Error(`unknown field: ${field}`);
  }
}

describe("RepoConfigSchema: provider values", () => {
  it("accepts all valid providers, rejects unknown", () => {
    const valid = [
      "anthropic",
      "openai",
      "openrouter",
      "ollama",
      "deepseek",
      "gemini",
    ];
    for (const p of valid) {
      assert.ok(RepoConfigSchema.safeParse({ provider: p }).success, p);
    }
    assert.ok(!RepoConfigSchema.safeParse({ provider: "nonexistent" }).success);
  });
});

// ── mergeRepoConfig: deterministic invariants ─────────────────────────────────

describe("mergeRepoConfig: core invariants", () => {
  it("merging with null is identity and does not mutate", () => {
    const frozen = structuredClone(baseConfig);
    const result = mergeRepoConfig(baseConfig, null);
    assert.deepEqual(result, baseConfig);
    assert.deepEqual(baseConfig, frozen);
  });

  it("prepromptAppend concatenates, explicit preprompt replaces", () => {
    const app = mergeRepoConfig(baseConfig, { prepromptAppend: "Extra." });
    assert.ok(app.preprompt.startsWith(baseConfig.preprompt));
    assert.ok(app.preprompt.includes("Extra."));

    const rep = mergeRepoConfig(baseConfig, { preprompt: "New." });
    assert.equal(rep.preprompt, "New.");
    assert.ok(!rep.preprompt.includes(baseConfig.preprompt));
  });

  it("partial overrides preserve unset fields", () => {
    const r = mergeRepoConfig(baseConfig, {
      provider: "openai",
      memory: { enabled: false },
    });
    assert.equal(r.provider, "openai");
    assert.equal(r.memory.enabled, false);
    assert.equal(r.memory.dir, baseConfig.memory.dir); // unset, preserved
  });
});

// ── mergeRepoConfig: property-based ──────────────────────────────────────────

describe("mergeRepoConfig: property-based", () => {
  const providerArb = fc.constantFrom(
    "anthropic" as const,
    "openai" as const,
    "openrouter" as const,
    "ollama" as const,
    "deepseek" as const,
    "gemini" as const,
  );

  it("null overlay is identity for varied configs", () => {
    fc.assert(
      fc.property(providerArb, fc.string({ minLength: 1 }), (p, s) => {
        const cfg = { ...baseConfig, provider: p, preprompt: s };
        assert.deepEqual(mergeRepoConfig(cfg, null), cfg);
      }),
    );
  });

  it("prepromptAppend always appends and never shortens", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = mergeRepoConfig(baseConfig, { prepromptAppend: s });
        assert.ok(r.preprompt.includes(baseConfig.preprompt));
        assert.ok(r.preprompt.includes(s));
        assert.ok(r.preprompt.length >= baseConfig.preprompt.length);
      }),
    );
  });

  it("base config is never mutated by any overlay", () => {
    fc.assert(
      fc.property(
        fc.record({
          provider: fc.option(providerArb),
          prepromptAppend: fc.option(fc.string()),
        }),
        (overlay) => {
          const before = structuredClone(baseConfig);
          mergeRepoConfig(baseConfig, overlay);
          assert.deepEqual(baseConfig, before);
        },
      ),
    );
  });

  // ── mergeRepoConfig: field-by-field nested merge ─────────────────────────

  it("preserves base values when repo config is null", () => {
    const merged = mergeRepoConfig(baseConfig, null);
    assert.deepEqual(merged, baseConfig);
  });

  it("merges a single nested field without affecting siblings", () => {
    const merged = mergeRepoConfig(baseConfig, {
      memory: { enabled: false },
    });
    // Override took effect
    assert.equal(merged.memory.enabled, false);
    // Sibling fields preserved from base
    assert.equal(merged.memory.dir, baseConfig.memory.dir);
    assert.equal(
      merged.memory.maxHistoryEntries,
      baseConfig.memory.maxHistoryEntries,
    );
    // Other sections untouched
    assert.equal(
      merged.review.inlineComments,
      baseConfig.review.inlineComments,
    );
  });

  it("strips undefined repo fields so they don't override base", () => {
    // A repo config with memory.enabled set but memory.dir missing
    // should NOT result in memory.dir being undefined.
    const merged = mergeRepoConfig(baseConfig, {
      memory: { enabled: false },
    });
    assert.equal(merged.memory.dir, baseConfig.memory.dir);
  });

  it("does NOT merge access from repo config (security)", () => {
    const merged = mergeRepoConfig(baseConfig, {
      access: { allowlist: ["evil-org"] },
    });
    // Access should remain the base config value, not the repo override
    assert.deepEqual(merged.access.allowlist, baseConfig.access.allowlist);
  });

  it("does NOT merge models from repo config (operator cost)", () => {
    const originalModel = baseConfig.models.anthropic;
    const merged = mergeRepoConfig(baseConfig, {
      models: { anthropic: "claude-expensive-9000" },
    });
    assert.equal(merged.models.anthropic, originalModel);
  });
});
