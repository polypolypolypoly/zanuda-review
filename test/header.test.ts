import { describe, it } from "node:test";
import assert from "node:assert";
import { extractFileHeader, headeredFile } from "../src/review/header.js";

describe("extractFileHeader", () => {
  it("extracts first lines of a short file", () => {
    const content =
      "import { foo } from './bar';\n\nexport function main() {\n  return foo();\n}\n";
    const header = extractFileHeader(content);
    assert.ok(header.includes("import { foo }"));
    assert.ok(header.includes("export function main"));
  });

  it("stops at 2000 char budget", () => {
    const long = "x".repeat(2500);
    const header = extractFileHeader(long);
    assert.ok(header.length <= 2000);
  });

  it("stops at 150 line budget", () => {
    const many = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const header = extractFileHeader(many);
    assert.ok(header.split("\n").length <= 150);
  });

  it("skips leading comment blocks (//)", () => {
    const content =
      "// License header\n// Copyright 2024\n// All rights reserved\n\nimport { foo } from './bar';\n";
    const header = extractFileHeader(content);
    assert.ok(!header.includes("License header"));
    assert.ok(!header.includes("Copyright"));
    assert.ok(header.includes("import { foo }"));
  });

  it("skips leading comment blocks (#)", () => {
    const content =
      "# This is a Python file\n# with a docstring\n\nimport os\n";
    const header = extractFileHeader(content);
    assert.ok(!header.includes("This is a Python file"));
    assert.ok(header.includes("import os"));
  });

  it("skips leading /* */ block comments", () => {
    const content =
      "/*\n * Copyright notice\n * SPDX-License-Identifier: MIT\n */\n\nimport React from 'react';\n";
    const header = extractFileHeader(content);
    assert.ok(!header.includes("Copyright notice"));
    assert.ok(header.includes("import React"));
  });

  it("skips leading HTML-style comment blocks", () => {
    // Lines with <!--, -->, and blank lines are skipped.
    // Content-only lines inside the block (like @license without a marker)
    // are a known limitation — they waste a small amount of header budget.
    const content =
      "<!--\n  Some comment\n-->\n\n<script setup>\nimport Foo from './Foo.vue';\n</script>\n";
    const header = extractFileHeader(content);
    assert.ok(!header.includes("<!--"));
    assert.ok(!header.includes("-->"));
    assert.ok(
      header.includes("<script setup>") || header.includes("import Foo"),
    );
  });

  it("skips leading comment lines even when followed immediately by code", () => {
    // A single // comment line at the top IS a leading comment and is skipped.
    // The model sees the actual code that follows. SPDX identifiers in the
    // diff context lines will still be visible.
    const content =
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\nimport './Foo.sol';\n";
    const header = extractFileHeader(content);
    // SPDX is a comment — skipped like any leading comment
    assert.ok(!header.includes("SPDX-License-Identifier"));
    assert.ok(header.includes("pragma solidity"));
    assert.ok(header.includes("import './Foo.sol'"));
  });

  it("skips shebang lines", () => {
    const content = "#!/usr/bin/env node\n\nimport { main } from './cli.js';\n";
    const header = extractFileHeader(content);
    assert.ok(!header.includes("#!/usr/bin/env"));
    assert.ok(header.includes("import { main }"));
  });

  it("skips mixed comment styles in leading block", () => {
    const content =
      "#!/usr/bin/env python3\n#\n# Configuration loader\n# Reads from YAML\n\nimport yaml\nfrom pathlib import Path\n";
    const header = extractFileHeader(content);
    assert.ok(!header.includes("Configuration loader"));
    assert.ok(header.includes("import yaml"));
  });

  it("returns empty string for empty content", () => {
    assert.equal(extractFileHeader(""), "");
  });

  it("returns empty for content that is all comments", () => {
    const content = "// comment 1\n// comment 2\n// comment 3\n";
    assert.equal(extractFileHeader(content), "");
  });
});

describe("headeredFile", () => {
  it("returns null when patch is undefined", () => {
    const result = headeredFile("test.ts", "content", undefined);
    assert.equal(result, null);
  });

  it("returns HeaderedFile with header + patch + weight", () => {
    const content = "import { foo } from './bar';\n\nconst x = 1;\n";
    const patch = "@@ -1,3 +1,4 @@";
    const result = headeredFile("test.ts", content, patch);
    assert.ok(result !== null);
    assert.equal(result!.filename, "test.ts");
    assert.ok(result!.header.includes("import { foo }"));
    assert.equal(result!.patch, patch);
    assert.equal(result!.weight, result!.header.length + patch.length);
  });
});
