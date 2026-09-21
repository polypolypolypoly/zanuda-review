# Zanuda reviewer guidelines for zanuda-review

This is Zanuda's own codebase. Be strict.

## Review calibration (read first)

"Strict" means precise on the things that matter — not exhaustive. The bar for
raising anything is: **does the fix improve correctness, security, or
readability of THIS PR today?**

- Only flag concrete bugs, security issues, invariant violations, or genuine
  readability regressions that exist in the diff right now.
- Never raise hypotheticals ("in theory", "if X were ever added", "in case the
  schema evolves") or self-conceding notes ("not blocking", "no action needed",
  "flagging in case"). If you cannot state how the fix improves the code today,
  do not raise it.
- Readability and clear intent are first-class goals. A pattern that is plain
  and obviously correct is NOT a bug just because a more defensive version
  exists. Do not demand defensive code against unreachable states.
- Prefer fewer, high-confidence findings over covering every corner.

## Security — highest priority

**Prompt injection is the primary threat model.** Any user-controlled content
that reaches an LLM prompt without sandboxing is a blocker.

User-controlled surfaces (must be XML-sandboxed in prompts):
- PR title → `<pr_title>`
- PR body → `<pr_description>`
- PR diff → ` ```diff ``` ` code fence
- PR discussion / comments → `<discussion>`
- @mention comment body → `<comment>`
- Repo memory (LLM-generated from user files) → `<repo_memory>`

`.zanuda/instructions.md` is intentionally NOT sandboxed — it is maintainer
content from the base branch. If you see it sandboxed, that is a bug.

**Config must always be read from `pr.baseSha` (base branch), never from the
PR head SHA.** Reading config from the PR head lets PR authors influence
Zanuda's behaviour. Flag any `getContent` call that uses `headSha` for config or
context files.

**Allowlist check must happen before any LLM call.** If a PR bypasses
`isAllowed()` and reaches `reviewPullRequest()`, it's a security gap.

## Key invariants — flag violations as blockers

- **`store.set()` for every state mutation.** All changes to round counts,
  mention reply counts, and replied comment IDs must go through `store.set()`.
  Direct mutation of state fields without a subsequent `store.set()` means the
  change won't survive a restart.

- **State file writes must be atomic.** The pattern is: write to `.tmp`,
  then `renameSync()`. Any direct `writeFileSync()` to the state file path
  (not a `.tmp` sibling) is a bug — a crash mid-write would corrupt the file.

- **`_generatingFor` lock must be released in a `finally` block.** If memory
  generation throws and the lock isn't released, all future reviews of that
  repo will deadlock waiting for it.

- **`inProgress` is intentionally not persisted.** It is a runtime-only set.
  On restart, in-flight reviews are retried from scratch — that is correct
  behaviour, not a bug.

- **The GitHub review event is always `COMMENT`.** Zanuda never posts an
  APPROVE or REQUEST_CHANGES review event to GitHub — merges are never blocked
  or unblocked. The verdict (APPROVE / REQUEST_CHANGES / COMMENT in the
  JSON output) is a recommendation expressed in the summary comment only.
  Any change that makes `postReview` use `result.action` as the GitHub event
  is a blocker.

- **`MAX_REVIEW_ROUNDS = 2` and `MAX_MENTION_REPLIES = 5` are intentional.**
  Do not flag them as magic numbers that need extracting — they are deliberate
  product decisions with comments explaining why.

## Code style

- **Pino logger only.** `console.log`, `console.error`, etc. are not used in
  this codebase. All logging goes through `logger` or a child logger.

- **ESM imports require `.js` extensions** even for `.ts` source files
  (TypeScript ESM convention). Missing extensions cause runtime errors.

- **No `any`.** `tsconfig.json` enforces strict mode. Flag any `as any` or
  untyped function parameters.

- **Zod schemas are the source of truth for external data.** Any place that
  parses untrusted input (GitHub API responses, config files, LLM JSON output)
  without going through a Zod schema is a bug.

- **New environment variables must be documented in `.env.example`.**

## LLM provider interface

The `LLMProvider` interface in `llm/types.ts` is the only abstraction all
providers must implement. Flag any code that imports a concrete provider
(e.g. `AnthropicProvider`) directly outside of `llm/index.ts`.

## Tests

Flag any new public function in `src/` that has no corresponding test,
especially in security-relevant paths (allowlist, prompt building, config
parsing). Test files are in `test/` and run with Node's built-in test runner.
