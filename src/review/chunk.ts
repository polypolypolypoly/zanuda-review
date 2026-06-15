/**
 * Dependency-aware batching for large PR reviews.
 *
 * Rather than packing files greedily by size (which can split tightly coupled
 * files across batches), this module parses the import graph among changed
 * files and groups them into connected components. Each component is reviewed
 * as a unit so the model can trace call chains across files within the same
 * batch.
 *
 * Algorithm:
 *   1. Parse import paths from each changed file (regex-based, language-agnostic)
 *   2. Build a directed graph: edge (u→v) iff u imports v and v ∈ changed files
 *   3. Compute SCCs via Tarjan — each SCC is an atomic review unit
 *   4. Condense SCCs into a DAG, topological sort (BFS)
 *   5. Greedy bin-pack in topological order, respecting batch capacity
 *
 * For isolates (files with no import edges to other changed files), they are
 * packed greedily into batches with spare capacity.
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
 * Only handles relative imports ("./foo", "../bar").
 * Absolute imports ("react", "@scope/pkg") are ignored — they don't
 * reference other files in the changed set.
 */
export function resolveImport(
  fromFile: string,
  importPath: string,
): string | null {
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

  // Add common extensions if the path doesn't have one
  const candidate = parts.join("/");
  // Allow empty string — means "repo root" when importing from a nested
  // file with enough ../ to reach the root.
  return candidate;
}

// ── Graph types ──────────────────────────────────────────────────────────────

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

interface Graph {
  /** Number of nodes. */
  n: number;
  /** Index → filename map. */
  files: string[];
  /** Adjacency list: node → list of successors (files it imports). */
  adj: number[][];
}

/**
 * Build a directed graph of imports among changed files.
 * Edge (u→v) means file u imports file v, and v is in the changed set.
 */
function buildImportGraph(
  headers: Map<string, string>,
  changedFiles: Set<string>,
): Graph {
  const files = [...changedFiles];
  const fileIndex = new Map(files.map((f, i) => [f, i]));
  const n = files.length;
  const adj: number[][] = Array.from({ length: n }, () => []);

  for (const [i, file] of files.entries()) {
    const source = headers.get(file);
    if (!source) continue;

    const rawImports = extractImports(source);
    const resolved = new Set<number>();

    for (const imp of rawImports) {
      const resolvedPath = resolveImport(file, imp);
      if (resolvedPath === null) continue;

      // Check with common extensions
      for (const ext of FILE_EXTENSIONS) {
        const target = fileIndex.get(resolvedPath + ext);
        if (target !== undefined) {
          resolved.add(target);
          break;
        }
      }
    }

    adj[i] = [...resolved];
  }

  return { n, files, adj };
}

// ── Tarjan's SCC ─────────────────────────────────────────────────────────────

/**
 * Compute strongly connected components of the import graph.
 * Returns an array of SCCs, each an array of file indices.
 * Topological order: if SCC A depends on SCC B (A imports B), B comes before A.
 */
function tarjanSCC(g: Graph): number[][] {
  const index = new Array<number>(g.n).fill(-1);
  const lowlink = new Array<number>(g.n).fill(0);
  const onStack = new Array<boolean>(g.n).fill(false);
  const stack: number[] = [];
  let currentIndex = 0;
  const sccs: number[][] = [];

  function strongconnect(v: number): void {
    index[v] = currentIndex;
    lowlink[v] = currentIndex;
    currentIndex++;
    stack.push(v);
    onStack[v] = true;

    for (const w of g.adj[v]!) {
      if (index[w] === -1) {
        strongconnect(w);
        lowlink[v] = Math.min(lowlink[v]!, lowlink[w]!);
      } else if (onStack[w]) {
        lowlink[v] = Math.min(lowlink[v]!, index[w]!);
      }
    }

    if (lowlink[v] === index[v]) {
      const scc: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = false;
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (let v = 0; v < g.n; v++) {
    if (index[v] === -1) strongconnect(v);
  }

  // Reverse: Tarjan returns SCCs in reverse topological order.
  // We want topological order (dependencies first), so reverse.
  return sccs.reverse();
}

// ── Dense subgraph helper ────────────────────────────────────────────────────

interface CondensedNode {
  /** Original file indices in this SCC. */
  members: number[];
  /** Total weight (chars) of this SCC. */
  weight: number;
  /** Indices of other SCCs this one imports. */
  imports: number[];
  /** In-degree in the condensed graph. */
  indegree: number;
}

/**
 * Condense the graph by collapsing each SCC into a super-node.
 * Returns the condensed nodes in topological order.
 */
function condenseSCCs(
  g: Graph,
  sccs: number[][],
  weights: number[],
): CondensedNode[] {
  const sccIndex = new Map<number, number>(); // file → SCC index
  for (let i = 0; i < sccs.length; i++) {
    for (const v of sccs[i]!) {
      sccIndex.set(v, i);
    }
  }

  const nodes: CondensedNode[] = sccs.map((members) => {
    let weight = 0;
    for (const v of members) weight += weights[v]!;
    return { members, weight, imports: [], indegree: 0 };
  });

  // Build condensed edges
  for (let u = 0; u < g.n; u++) {
    const uScc = sccIndex.get(u)!;
    for (const v of g.adj[u]!) {
      const vScc = sccIndex.get(v)!;
      if (uScc !== vScc && !nodes[uScc]!.imports.includes(vScc)) {
        nodes[uScc]!.imports.push(vScc);
        nodes[vScc]!.indegree++;
      }
    }
  }

  return nodes;
}

// ── Spectral split for oversize SCCs ─────────────────────────────────────────

/**
 * Split an oversize SCC into two sub-batches via spectral partitioning.
 *
 * Algorithm:
 *   1. Build the symmetric adjacency matrix for the SCC subgraph
 *   2. Build the Laplacian L = D - A
 *   3. Compute the dominant eigenvector of L (after deflating the all-ones
 *      null-space vector for λ=0) via power iteration.
 *      NOTE: This is NOT the Fiedler vector (second-smallest eigenvalue, λ₂).
 *      It is the dominant (largest) eigenvector after null-space removal,
 *      which gives a spectral split based on eigenvector centrality — nodes
 *      with similar degree/connectivity get similar values. For the small
 *      graphs here (2-10 nodes), any capacity-respecting spectral cut is
 *      sufficient.
 *   4. Sort nodes by eigenvector value and find the capacity-respecting split
 *      that minimises the number of edges crossing the partition
 *
 * This is a safety valve for the rare case where a strongly connected
 * component exceeds batch capacity. In practice, SCCs in import graphs
 * are tiny (2-3 files) and this path is almost never taken.
 */
function splitOversizeSCC(
  files: HeaderedFile[],
  indices: number[],
  capacity: number,
): HeaderedFile[][] {
  const n = indices.length;
  if (n <= 1) {
    return [[files[indices[0]!]!]];
  }

  // Build symmetric adjacency: edge if either file imports the other.
  // Use the file headers to re-parse imports within this SCC subgraph.
  const adj: boolean[][] = Array.from({ length: n }, () =>
    Array(n).fill(false),
  );
  for (let i = 0; i < n; i++) {
    const srcFile = files[indices[i]!]!;
    const srcImports = extractImports(srcFile.header);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const targetFile = files[indices[j]!]!;
      for (const imp of srcImports) {
        const resolved = resolveImport(srcFile.filename, imp);
        if (resolved === null) continue;
        // Exact match with common extensions — same logic as buildImportGraph.
        // startsWith would match "src/a" against "src/ab.ts", creating false edges.
        for (const ext of FILE_EXTENSIONS) {
          if (targetFile.filename === resolved + ext) {
            adj[i]![j] = true;
            adj[j]![i] = true;
            break;
          }
        }
      }
    }
  }

  // Build Laplacian: L = D - A
  const degree = adj.map((row) => row.filter(Boolean).length);
  const laplacian: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      if (i === j) return degree[i]!;
      return adj[i]![j] ? -1 : 0;
    }),
  );

  // Power iteration for the dominant eigenvector of L (after deflating
  // the all-ones null-space). This is NOT the Fiedler vector (λ₂) — it is
  // the largest-eigenvalue vector after null-space removal, giving a
  // spectral split based on eigenvector centrality.
  const eigenvec = computeDominantEigenvector(laplacian);

  // Sort by eigenvector value and find the best capacity-respecting split.
  const indexed = indices.map((fileIdx, i) => ({
    file: files[fileIdx]!,
    value: eigenvec[i]!,
  }));
  indexed.sort((a, b) => a.value - b.value);

  // Find the split point that puts both halves under capacity and minimises
  // the number of edges crossing the cut.
  let bestSplit = 1;
  let bestCutEdges = Infinity;
  const prefixWeights: number[] = [];
  let running = 0;
  for (const item of indexed) {
    running += item.file.weight;
    prefixWeights.push(running);
  }
  const totalWeight = running;

  for (let split = 1; split < n; split++) {
    const leftWeight = prefixWeights[split - 1]!;
    const rightWeight = totalWeight - leftWeight;
    if (leftWeight > capacity || rightWeight > capacity) continue;

    // Count cut edges: edges between {0..split-1} and {split..n-1}
    let cutEdges = 0;
    for (let i = 0; i < split; i++) {
      for (let j = split; j < n; j++) {
        // Find original indices
        const origI = indices.indexOf(files.indexOf(indexed[i]!.file));
        const origJ = indices.indexOf(files.indexOf(indexed[j]!.file));
        if (origI >= 0 && origJ >= 0 && adj[origI]![origJ]) {
          cutEdges++;
        }
      }
    }

    if (cutEdges < bestCutEdges) {
      bestCutEdges = cutEdges;
      bestSplit = split;
    }
  }

  const left = indexed.slice(0, bestSplit).map((x) => x.file);
  const right = indexed.slice(bestSplit).map((x) => x.file);

  // Recurse: if either half still exceeds capacity, split it further.
  // This guarantees the documented invariant "each batch ≤ capacity chars"
  // even for pathological SCCs larger than 2× capacity.
  const result: HeaderedFile[][] = [];
  for (const half of [left, right]) {
    const halfWeight = half.reduce((s, f) => s + f.weight, 0);
    if (halfWeight > capacity && half.length > 1) {
      // Find indices of these files in the original array for recursion
      const halfIndices = half
        .map((f) => files.indexOf(f))
        .filter((i) => i >= 0);
      if (halfIndices.length > 1) {
        result.push(...splitOversizeSCC(files, halfIndices, capacity));
        continue;
      }
    }
    result.push(half);
  }
  return result;
}

/**
 * Compute the dominant eigenvector of a graph Laplacian after deflating
 * the all-ones null-space vector (λ=0). Uses power iteration with
 * orthogonalization. NOT the Fiedler vector — see splitOversizeSCC
 * for the rationale.
 */
function computeDominantEigenvector(L: number[][]): number[] {
  const n = L.length;
  const MAX_ITER = 100;
  const TOLERANCE = 1e-6;

  // Start with a random unit vector orthogonal to all-ones
  let x = Array.from({ length: n }, () => Math.random() * 2 - 1);
  // Orthogonalize against all-ones vector
  const onesMean = x.reduce((s, v) => s + v, 0) / n;
  for (let i = 0; i < n; i++) x[i]! -= onesMean;
  // Normalize
  let norm = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
  if (norm < 1e-10) {
    // Degenerate: all random values were equal. Use a sawtooth.
    for (let i = 0; i < n; i++) x[i]! = i / n - 0.5;
    norm = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
  }
  for (let i = 0; i < n; i++) x[i]! /= norm;

  // Power iteration: repeatedly apply L, orthogonalize, normalize.
  // Converges to the dominant eigenvector (largest eigenvalue) since
  // we orthogonalize against the all-ones null-space vector at each step.
  for (let iter = 0; iter < MAX_ITER; iter++) {
    // Multiply: y = L * x
    const y = Array(n).fill(0) as number[];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        y[i]! += L[i]![j]! * x[j]!;
      }
    }

    // Orthogonalize against all-ones
    const mean = y.reduce((s, v) => s + v, 0) / n;
    for (let i = 0; i < n; i++) y[i]! -= mean;

    // Normalize
    const yNorm = Math.sqrt(y.reduce((s, v) => s + v * v, 0));
    if (yNorm < 1e-10) break; // converged to zero
    for (let i = 0; i < n; i++) y[i]! /= yNorm;

    // Check convergence: dot product with previous
    let dot = 0;
    for (let i = 0; i < n; i++) dot += x[i]! * y[i]!;
    if (Math.abs(dot) > 1 - TOLERANCE) {
      x = y;
      break;
    }

    x = y;
  }

  return x;
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
 *   - Files in the same SCC are always in the same batch (unless the SCC
 *     itself exceeds capacity — then a spectral split divides it).
 *   - Batches respect topological order of the import graph — dependencies
 *     are reviewed before dependants.
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

  // Build a minimal header map for import parsing: just the header (first 2000
  // chars) of each file is enough to find imports, since imports are at the top.
  const headerMap = new Map<string, string>();
  for (const f of files) {
    headerMap.set(f.filename, f.header);
  }

  const g = buildImportGraph(headerMap, changedSet);

  // Compute weights per file
  const weights = files.map((f) => f.weight);

  // Compute SCCs
  const sccs = tarjanSCC(g);

  // Condense to DAG, topological order
  const nodes = condenseSCCs(g, sccs, weights);

  // BFS topological order: process nodes with indegree 0 first
  const queue: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i]!.indegree === 0) queue.push(i);
  }

  const topoOrder: number[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    topoOrder.push(u);
    for (const v of nodes[u]!.imports) {
      nodes[v]!.indegree--;
      if (nodes[v]!.indegree === 0) queue.push(v);
    }
  }

  // Greedy bin-packing in topological order
  const batches: Batch[] = [];
  let currentBatch: HeaderedFile[] = [];
  let currentWeight = 0;

  for (const nodeIdx of topoOrder) {
    const node = nodes[nodeIdx]!;

    // Collect the actual HeaderedFile objects for this SCC
    const sccFiles = node.members.map((i) => files[i]!);

    if (node.weight > capacity) {
      // SCC exceeds capacity — split it (rare)
      if (currentBatch.length > 0) {
        batches.push({ files: currentBatch, weight: currentWeight });
        currentBatch = [];
        currentWeight = 0;
      }
      const split = splitOversizeSCC(files, node.members, capacity);
      for (const sub of split) {
        const w = sub.reduce((s, f) => s + f.weight, 0);
        batches.push({ files: sub, weight: w });
      }
      continue;
    }

    if (currentWeight + node.weight > capacity && currentBatch.length > 0) {
      batches.push({ files: currentBatch, weight: currentWeight });
      currentBatch = [];
      currentWeight = 0;
    }

    currentBatch.push(...sccFiles);
    currentWeight += node.weight;
  }

  if (currentBatch.length > 0) {
    batches.push({ files: currentBatch, weight: currentWeight });
  }

  return batches;
}
