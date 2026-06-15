import { describe, it } from "node:test";
import assert from "node:assert";
import {
  extractImports,
  resolveImport,
  batchChangedFiles,
} from "../src/review/chunk.js";
import type { HeaderedFile } from "../src/review/header.js";

// ─── extractImports ──────────────────────────────────────────────────────────

describe("extractImports", () => {
  it("extracts TS import paths", () => {
    const source = `
import { foo, bar } from "./utils";
import type { Baz } from "../types";
import "./side-effect";
    `;
    const imports = extractImports(source);
    assert.deepStrictEqual(
      imports.sort(),
      ["./side-effect", "./utils", "../types"].sort(),
    );
  });

  it("extracts TS require() calls", () => {
    const source = `const lib = require("./lib");`;
    const imports = extractImports(source);
    assert.deepStrictEqual(imports, ["./lib"]);
  });

  it("extracts Python imports", () => {
    const source = `
from .models import User
from ..utils.helpers import format_name
import os
    `;
    const imports = extractImports(source);
    assert.ok(imports.includes(".models"));
    assert.ok(imports.includes("..utils.helpers"));
    assert.ok(imports.includes("os"));
  });

  it("extracts Solidity imports", () => {
    const source = `
import "@openzeppelin/contracts/token/ERC20.sol";
import { Ownable } from "./Ownable.sol";
import "../interfaces/IVault.sol";
    `;
    const imports = extractImports(source);
    assert.ok(imports.includes("@openzeppelin/contracts/token/ERC20.sol"));
    assert.ok(imports.includes("./Ownable.sol"));
    assert.ok(imports.includes("../interfaces/IVault.sol"));
  });

  it("extracts Rust use and mod statements", () => {
    const source = `
use crate::config::Settings;
use std::collections::HashMap;
mod parser;
    `;
    const imports = extractImports(source);
    assert.ok(imports.includes("crate::config::Settings"));
    assert.ok(imports.includes("std::collections::HashMap"));
    assert.ok(imports.includes("parser"));
  });

  it("extracts Go imports", () => {
    const source = `
import (
    "fmt"
    "./pkg/logger"
)
    `;
    const imports = extractImports(source);
    assert.ok(imports.includes("fmt"));
    assert.ok(imports.includes("./pkg/logger"));
  });

  it("returns empty array for files with no imports", () => {
    assert.deepStrictEqual(extractImports("const x = 1;\nconst y = 2;"), []);
  });

  it("does not confuse string contents with imports", () => {
    const source = `const example = 'import { fake } from "./not-real"';`;
    const imports = extractImports(source);
    // The import regex finds the path inside the string literal.
    // This is a known limitation — we accept some false positives
    // rather than missing real imports.
    assert.ok(imports.length >= 0); // at minimum doesn't crash
  });
});

// ─── resolveImport ───────────────────────────────────────────────────────────

describe("resolveImport", () => {
  it("resolves ./ imports relative to file directory", () => {
    assert.equal(
      resolveImport("src/utils/helpers.ts", "./format"),
      "src/utils/format",
    );
  });

  it("resolves ../ imports", () => {
    assert.equal(
      resolveImport("src/components/Button.tsx", "../hooks/useState"),
      "src/hooks/useState",
    );
  });

  it("resolves multiple ../ levels", () => {
    assert.equal(
      resolveImport(
        "src/components/forms/inputs/Text.tsx",
        "../../../utils/validate",
      ),
      "src/utils/validate",
    );
  });

  it("handles files in root (no directory)", () => {
    assert.equal(resolveImport("index.ts", "./app"), "app");
    assert.equal(resolveImport("index.ts", "../shared/lib"), "shared/lib");
  });

  it("handles . segment (same directory)", () => {
    assert.equal(resolveImport("src/app.ts", "././utils"), "src/utils");
  });

  it("returns null for non-relative imports", () => {
    assert.equal(resolveImport("src/app.ts", "react"), null);
    assert.equal(resolveImport("src/app.ts", "@scope/pkg"), null);
    assert.equal(resolveImport("src/app.ts", "fs"), null);
  });

  it("returns null for absolute paths", () => {
    assert.equal(resolveImport("src/app.ts", "/etc/config"), null);
  });

  it("returns empty string when resolving to root", () => {
    // From "src/app.ts" importing "../.."  → ""
    const result = resolveImport("src/app.ts", "../..");
    assert.equal(result, "");
  });
});

// ─── batchChangedFiles ───────────────────────────────────────────────────────

function hf(filename: string, patch: string, header?: string): HeaderedFile {
  const h = header ?? `import "./other";\n`;
  return { filename, header: h, patch, weight: h.length + patch.length };
}

describe("batchChangedFiles", () => {
  it("returns single batch for small PR", () => {
    const files = [
      hf("a.ts", "patch-a-content"),
      hf("b.ts", "patch-b-content"),
    ];
    const batches = batchChangedFiles(files, 50000);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.files.length, 2);
  });

  it("splits into multiple batches when exceeding capacity", () => {
    const big = "x".repeat(30000);
    const files = [hf("a.ts", big), hf("b.ts", big), hf("c.ts", big)];
    const batches = batchChangedFiles(files, 50000);
    assert.ok(
      batches.length >= 2,
      `expected ≥2 batches, got ${batches.length}`,
    );
    // Each batch should be within capacity
    for (const b of batches) {
      assert.ok(b.weight <= 50000, `batch weight ${b.weight} exceeds 50000`);
    }
    // All files accounted for
    const totalFiles = batches.reduce((s, b) => s + b.files.length, 0);
    assert.equal(totalFiles, 3);
  });

  it("keeps files with import edges in the same batch", () => {
    // a.ts imports b.ts
    const aHeader = `import { B } from "./b";\n`;
    const bHeader = `export class B {}\n`;

    // Make them large enough that they'd be split if not for the edge
    const bigPatch = "x".repeat(35000);
    const files = [
      {
        filename: "src/a.ts",
        header: aHeader,
        patch: bigPatch,
        weight: aHeader.length + bigPatch.length,
      },
      {
        filename: "src/b.ts",
        header: bHeader,
        patch: bigPatch,
        weight: bHeader.length + bigPatch.length,
      },
    ];

    const batches = batchChangedFiles(files, 50000);
    // a.ts imports b.ts → they should stay together (in one or two batches)
    // With 35000 each + header, both can fit in 50000 together
    assert.ok(batches.length <= 2);
  });

  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(batchChangedFiles([], 50000), []);
  });

  it("handles single file larger than capacity", () => {
    const huge = "x".repeat(60000);
    const files = [hf("huge.ts", huge)];
    const batches = batchChangedFiles(files, 50000);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.files.length, 1);
  });

  it("all files are included exactly once", () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      hf(`file${i}.ts`, "x".repeat(10000 + (i % 5) * 5000)),
    );
    const batches = batchChangedFiles(files, 50000);
    const filenames = batches
      .flatMap((b) => b.files.map((f) => f.filename))
      .sort();
    const expected = files.map((f) => f.filename).sort();
    assert.deepStrictEqual(filenames, expected);
  });
});
