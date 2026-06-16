/**
 * Dependency-aware batching for large PR reviews.
 *
 * Rather than packing files greedily by size (which can split tightly coupled
 * files across batches), this module parses the import graph among changed
 * files and groups them into connected components via union-find. Each
 * component is reviewed as a unit so the model can trace call chains across
 * files within the same batch.
 *
 * Algorithm:
 *   1. Parse import paths from each changed file (regex-based, language-agnostic)
 *   2. Build an undirected graph: edge (u—v) iff u imports v or v imports u,
 *      and both are in the changed set.
 *   3. Union-find to find connected components (clusters of coupled files).
 *   4. Sort components by descending total weight, greedy bin-pack into
 *      batches ≤ capacity.
 *   5. If a component exceeds capacity, split it by directory prefix,
 *      then greedily. A single file > capacity ships alone.
 *
 * Isolates (files with no import edges to other changed files) are packed
 * greedily into batches with spare capacity.
 */

import type { HeaderedFile } from "./header.js";

// ── Import parsing ───────────────────────────────────────────────────────────

/**
 * Regex-based import extraction. Covers the most common import styles across
 * languages without requiring a full parser.
 */
const IMPORT_PATTERNS: RegExp[] = [
  // TypeScript/JavaScript: named / default / namespace / side-effect imports + require()
  /import\s+(?:type\s+)?(?:\{[^}]*\}\s+from\s+|\*\s+as\s+\w+\s+from\s+|\w+\s+from\s+)?["']([^"']+)["']|import\s+["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']/g,
  // Python: from foo import bar | import foo
  // Exclude artifacts from other languages: Python modules start with
  // a letter or underscore, never { or type.
  /(?:from\s+(\S+)\s+import|^import\s+([a-zA-Z_]\S*))/gm,
  // Solidity: import "./Foo.sol" | import {Foo} from "./Foo.sol"
  /import\s+(?:\{[^}]*\}\s+from\s+)?["']([^"']+)["']/g,
  // Rust: use crate::foo::bar; | mod foo;
  /(?:use\s+(\S+?);|mod\s+(\S+);)/gm,
  // Go: import "foo/bar" (single) or import ( "a" "b" ) (parenthesized)
  /import\s*(?:\(([^)]+)\)|["']([^"']+)["'])/gs,
  // C/C++: #include "foo.h" (local) — system includes <foo.h> are ignored
  /#include\s+"([^"]+)"/g,
  // Java: import com.foo.Bar;
  /import\s+([a-z_][\w.]*)\s*;/g,
  // Ruby: require_relative '../foo' — regular require is load-path, not file-relative
  /require_relative\s+['"]([^'"]+)['"]/g,
  // CSS: @import './foo.css' | @import url('./foo.css')
  /@import\s+(?:url\s*\(\s*)?["']([^"']+)["']/g,
];

/**
 * Extract the set of import paths referenced in a source file.
 * Returns file-relative paths (e.g. "./foo", "../bar/baz").
 */
export function extractImports(source: string): string[] {
  const seen = new Set<string>();
  const imports: string[] = [];

  const add = (path: string) => {
    if (path && !seen.has(path)) {
      seen.add(path);
      imports.push(path);
    }
  };

  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      // Go parenthesized imports: group 1 is the body "...", extract each string
      if (match[1] && match[1].includes('"')) {
        const inner = [...match[1].matchAll(/["']([^"']+)["']/g)].map(
          (m) => m[1]!,
        );
        for (const p of inner) add(p);
      } else {
        // Other patterns: group 1, 2, or 3 has the path
        const path = match[1] || match[2] || match[3];
        if (path) add(path);
      }
    }
  }
  return imports;
}

/**
 * Resolve a relative import path to a repo-relative file path.
 *
 * Handles:
 *   - Relative paths ("./foo", "../bar") — resolved against fromFile's directory.
 *   - Java-style dot-path imports ("com.foo.Bar") — dots → slashes, .java appended.
 *
 * Absolute imports ("react", "@scope/pkg") are ignored — they don't
 * reference other files in the changed set.
 */
export function resolveImport(
  fromFile: string,
  importPath: string,
): string | null {
  // Java-style dot-path imports: convert dots to slashes, append .java.
  if (/^[a-z_]\w*(?:\.[a-zA-Z_]\w*)+$/.test(importPath)) {
    return importPath.replace(/\./g, "/") + ".java";
  }

  // Only resolve relative imports
  if (!importPath.startsWith(".")) return null;

  const fromDir = fromFile.includes("/")
    ? fromFile.slice(0, fromFile.lastIndexOf("/"))
    : "";

  // Split and resolve "../" segments
  const parts = fromDir ? fromDir.split("/") : [];
  const importParts = importPath.split("/");

  for (const part of importParts) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }

  const candidate = parts.join("/");
  // Allow empty string — means "repo root" when importing from a nested
  // file with enough ../ to reach the root.
  return candidate;
}

// ── Graph construction ───────────────────────────────────────────────────────

/** Common file extensions tried when matching resolved imports to filenames. */
const FILE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".sol",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".cc",
  ".h",
  ".hpp",
  ".rb",
  ".css",
];

/**
 * Build an undirected graph of imports among changed files.
 * Returns adjacency: for each file index, the set of other file indices
 * that it imports or that import it (within the changed set).
 */
function buildUndirectedGraph(
  headers: Map<string, string>,
  changedFiles: Set<string>,
): { n: number; files: string[]; adj: number[][] } {
  const files = [...changedFiles];
  const fileIndex = new Map(files.map((f, i) => [f, i]));
  const n = files.length;
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set());

  for (const [i, file] of files.entries()) {
    const source = headers.get(file);
    if (!source) continue;

    const rawImports = extractImports(source);

    for (const imp of rawImports) {
      const resolvedPath = resolveImport(file, imp);
      if (resolvedPath === null) continue;

      for (const ext of FILE_EXTENSIONS) {
        const target = fileIndex.get(resolvedPath + ext);
        if (target !== undefined) {
          // Undirected: u imports v → u—v
          adj[i]!.add(target);
          adj[target]!.add(i);
          break;
        }
      }
    }
  }

  return { n, files, adj: adj.map((s) => [...s]) };
}

// ── Union-find ───────────────────────────────────────────────────────────────

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]!); // path compression
    }
    return this.parent[x]!;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra]! < this.rank[rb]!) {
      this.parent[ra] = rb;
    } else if (this.rank[ra]! > this.rank[rb]!) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra]!++;
    }
  }
}

// ── Directory-based split for oversize clusters ──────────────────────────────

/**
 * Split a cluster of files that exceeds batch capacity into sub-groups by
 * directory prefix. Files in the same directory tend to be more tightly
 * coupled than files in different directories.
 *
 * Returns sub-clusters, each fitting within capacity where possible.
 * Single files exceeding capacity are shipped alone.
 */
function splitOversizeCluster(
  files: HeaderedFile[],
  capacity: number,
): HeaderedFile[][] {
  // Group by directory (everything before the last "/")
  const byDir = new Map<string, HeaderedFile[]>();
  for (const f of files) {
    const dir = f.filename.includes("/")
      ? f.filename.slice(0, f.filename.lastIndexOf("/"))
      : "";
    const group = byDir.get(dir);
    if (group) group.push(f);
    else byDir.set(dir, [f]);
  }

  // Sort directory groups by total weight, descending
  const groups = [...byDir.values()].map((group) => ({
    files: group,
    weight: group.reduce((s, f) => s + f.weight, 0),
  }));
  groups.sort((a, b) => b.weight - a.weight);

  // Greedy bin-pack the directory groups
  const batches: HeaderedFile[][] = [];
  let current: HeaderedFile[] = [];
  let currentWeight = 0;

  for (const group of groups) {
    if (group.weight > capacity) {
      // A single directory group exceeds capacity — recurse.
      // If it's already a single file, ship it alone.
      if (current.length > 0) {
        batches.push(current);
        current = [];
        currentWeight = 0;
      }
      if (group.files.length === 1) {
        batches.push(group.files);
      } else {
        // Split by filename prefix (one level deeper) — but only if
        // there's something to split. Otherwise just ship as-is.
        const deeper = splitByFilenamePrefix(group.files, capacity);
        for (const sub of deeper) batches.push(sub);
      }
      continue;
    }

    if (currentWeight + group.weight > capacity && current.length > 0) {
      batches.push(current);
      current = [];
      currentWeight = 0;
    }

    current.push(...group.files);
    currentWeight += group.weight;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/** Split a same-directory group by the first filename segment after the dir. */
function splitByFilenamePrefix(
  files: HeaderedFile[],
  capacity: number,
): HeaderedFile[][] {
  // Sort descending by weight
  const sorted = [...files].sort((a, b) => b.weight - a.weight);
  const batches: HeaderedFile[][] = [];
  let current: HeaderedFile[] = [];
  let currentWeight = 0;

  for (const f of sorted) {
    if (f.weight > capacity) {
      // Ship alone
      if (current.length > 0) {
        batches.push(current);
        current = [];
        currentWeight = 0;
      }
      batches.push([f]);
      continue;
    }
    if (currentWeight + f.weight > capacity && current.length > 0) {
      batches.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(f);
    currentWeight += f.weight;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface Batch {
  files: HeaderedFile[];
  /** Total char weight of this batch. */
  weight: number;
}

/**
 * Partition changed files into ordered batches for sequential review.
 *
 * Guarantees:
 *   - Every file with a patch appears in exactly one batch.
 *   - Each batch is ≤ capacity chars.
 *   - Files connected by imports are grouped together (union-find
 *     connected components), so the model can trace call chains across
 *     coupled files within the same batch.
 *
 * @param files — headered files to partition (must include filename, patch, weight)
 * @param capacity — maximum characters per batch
 */
export function batchChangedFiles(
  files: HeaderedFile[],
  capacity: number,
): Batch[] {
  if (files.length === 0) return [];

  const changedSet = new Set(files.map((f) => f.filename));

  // Build a minimal header map for import parsing.
  const headerMap = new Map<string, string>();
  for (const f of files) {
    headerMap.set(f.filename, f.header);
  }

  // 1. Build undirected import graph
  const g = buildUndirectedGraph(headerMap, changedSet);

  // 2. Union-find to find connected components
  const uf = new UnionFind(g.n);
  for (let u = 0; u < g.n; u++) {
    for (const v of g.adj[u]!) {
      uf.union(u, v);
    }
  }

  // 3. Collect components: root → list of file indices
  const components = new Map<number, number[]>();
  for (let i = 0; i < g.n; i++) {
    const root = uf.find(i);
    const comp = components.get(root);
    if (comp) comp.push(i);
    else components.set(root, [i]);
  }

  // 4. Sort components by total weight, descending
  const weights = files.map((f) => f.weight);
  const sorted = [...components.values()]
    .map((indices) => ({
      indices,
      totalWeight: indices.reduce((s, i) => s + weights[i]!, 0),
    }))
    .sort((a, b) => b.totalWeight - a.totalWeight);

  // 5. Greedy bin-pack
  const batches: Batch[] = [];
  let currentBatch: HeaderedFile[] = [];
  let currentWeight = 0;

  for (const comp of sorted) {
    const compFiles = comp.indices.map((i) => files[i]!);

    if (comp.totalWeight > capacity) {
      // Component exceeds capacity — split by directory
      if (currentBatch.length > 0) {
        batches.push({ files: currentBatch, weight: currentWeight });
        currentBatch = [];
        currentWeight = 0;
      }
      const split = splitOversizeCluster(compFiles, capacity);
      for (const sub of split) {
        batches.push({
          files: sub,
          weight: sub.reduce((s, f) => s + f.weight, 0),
        });
      }
      continue;
    }

    if (
      currentWeight + comp.totalWeight > capacity &&
      currentBatch.length > 0
    ) {
      batches.push({ files: currentBatch, weight: currentWeight });
      currentBatch = [];
      currentWeight = 0;
    }

    currentBatch.push(...compFiles);
    currentWeight += comp.totalWeight;
  }

  if (currentBatch.length > 0) {
    batches.push({ files: currentBatch, weight: currentWeight });
  }

  return batches;
}
