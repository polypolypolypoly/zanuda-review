# Zanuda reviewer guidelines for zanuda-review

This is the codebase for Zanuda herself. Be strict.

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
PR head SHA.** Reading config from the PR head lets PR authors influence the
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

- **Round 2 must never post `REQUEST_CHANGES`.** The engine coerces
  `REQUEST_CHANGES → COMMENT` on round 2 because Zanuda won't do a round 3,
  and `REQUEST_CHANGES` would block the PR permanently. Any change that removes
  or bypasses this coercion is a blocker.

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
