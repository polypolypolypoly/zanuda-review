# Contributing to Zanuda the Reviewer

Bug reports, fixes, and new features are welcome. Read this before opening a PR.

## Quick start

```bash
git clone https://github.com/polypolypolypoly/zanuda-review
cd zanuda-review
npm ci
cp .env.example .env   # fill in at minimum GITHUB_TOKEN + one LLM key
npm run build
npm test
```

## Ground rules

- **Open an issue first** for anything beyond a small fix. It avoids wasted effort if the direction isn't a fit.
- **Tests are required.** New behaviour needs tests; bug fixes should include a regression test.
- **All checks must pass** before a PR can merge: `npm run lint && npm run format:check && npm run typecheck && npm test`
- **Security issues** — do not open a public issue. Email the maintainers directly.

---

## Adding a new platform connector

This is the most impactful contribution you can make. The GitHub integration is
one implementation of `SCMConnector` — adding GitLab, Bitbucket, Gitea, or any
other platform follows the same pattern.

### How the abstraction works

```
SCMConnector (src/platform/types.ts)
├── GitHubConnector  (src/platform/github/connector.ts)  ← reference impl
└── YourConnector    (src/platform/<name>/connector.ts)  ← you build this
```

The review engine, LLM layer, prompt builder, config system, memory, and state
store all depend only on `SCMConnector` — they have zero knowledge of GitHub,
GitLab, or anything else. You only implement the interface; everything else
works for free.

### Step-by-step

**1. Copy the stub**

```bash
cp src/platform/stub/connector.ts src/platform/<name>/connector.ts
```

The stub is a fully annotated skeleton. Every method has:
- A description of what it must do
- The exact GitHub API call we use (for reference)
- The GitLab / Bitbucket equivalent where known
- Notes on edge cases

**2. Implement the 10 methods**

| Method | What it does |
|---|---|
| `getReviewerLogin()` | Return the reviewer account's username |
| `pollPendingReviews(reviewerLogin)` | Return open PRs/MRs where the reviewer is requested |
| `fetchPR(ref, number)` | Fetch diff, files, title, body, base/head refs |
| `readFile(ref, path, gitRef)` | Read one file at a given git ref (null if 404) |
| `getFileTree(ref, gitRef, maxEntries)` | List all file paths in the repo |
| `fetchDiscussion(ref, number)` | Fetch all comments (inline + general) |
| `postReview(pr, result, config)` | Post verdict + inline comments |
| `postComment(ref, number, body)` | Post a plain PR comment; returns comment ID |
| `editComment(ref, commentId, body)` | Edit an existing comment by ID |
| `replyToComment(ref, number, comment, body)` | Reply to a specific comment |

Read `src/platform/types.ts` for the full type contracts and `src/platform/github/connector.ts` as a working reference.

**3. Register in the factory**

Open `src/platform/index.ts` and add your platform:

```typescript
case "gitlab":
  return new GitLabConnector({ token: requireEnv("GITLAB_TOKEN") });
```

**4. Add env vars to `.env.example`**

Document any new env vars under the `── Platform ──` section:

```bash
# GitLab (when PLATFORM=gitlab)
GITLAB_TOKEN=
GITLAB_BASE_URL=https://gitlab.com  # optional, for self-hosted
```

**5. Write tests**

Add `test/<name>Connector.test.ts`. See `test/githubConnector.test.ts` for
the pattern — mock the HTTP layer, test each method independently.

**6. Open a PR**

Title format: `feat: <Name> connector`

Include in the PR description:
- Which platform and API version you targeted
- Any platform-specific limitations or known gaps
- How you tested it (self-hosted instance, mocked, etc.)

### Key invariants to preserve

These are not optional — they exist for security and correctness reasons:

- **Always read config and context from `pr.baseSha`**, never `pr.headSha`. The base branch is maintainer-controlled; the PR head is not.
- **Return `null` on 404** from `readFile`, throw on other errors.
- **`platformId` must be stable and globally unique** across all repos for the lifetime of a PR. It is used as the key for round counting and mention tracking.
- **`postReview` must not silently drop feedback.** If inline comment anchoring fails, fall back to a summary comment.

---

## Adding a new LLM provider

Zanuda's LLM layer is a one-method interface. Adding Gemini, Mistral, Cohere,
or any other provider takes about 30 minutes.

### How the abstraction works

```
LLMProvider (src/llm/types.ts)
├── AnthropicProvider    (src/llm/anthropic.ts)        ← reference impl
├── OpenAICompatibleProvider (src/llm/openaiCompatible.ts) ← covers OpenAI/OpenRouter/Ollama
└── YourProvider         (src/llm/<name>.ts)           ← you build this
```

The review engine calls `provider.complete(req)` and gets back a text string.
It never imports a concrete provider — add yours without touching any other file
except the four wiring points below.

### Step-by-step

**1. Copy the stub**

```bash
cp src/llm/stub.ts src/llm/<name>.ts
```

The stub has detailed JSDoc explaining every field of `CompletionRequest` and
what `complete()` must return.

**2. Implement `complete()`**

The interface is a single method:

```typescript
async complete(req: CompletionRequest): Promise<CompletionResult>
```

| Field | Type | Notes |
|---|---|---|
| `req.system` | `string` | System / preprompt instruction |
| `req.user` | `string` | User message (context + diff + task) |
| `req.model` | `string` | Model ID from config |
| `req.temperature` | `number` | 0–2; **omit if your API doesn't support it** |
| `req.maxTokens` | `number` | Max tokens to generate |

Return `{ text, model, provider }` where `text` is the raw completion string (no JSON parsing).

**3. Register in the factory** (`src/llm/index.ts`)

```typescript
case "myprovider":
  return myProvider();
```

**4. Add to the config schema** (`src/config.ts`)

```typescript
provider: z.enum(["anthropic", "openai", "openrouter", "ollama", "myprovider"]),
models: z.object({
  // ...
  myprovider: z.string(),
}),
```

**5. Add defaults** (`config/default.yaml`)

```yaml
models:
  myprovider: my-model-id
```

**6. Document env vars** (`.env.example`)

```bash
# MyProvider (when LLM_PROVIDER=myprovider)
MYPROVIDER_API_KEY=
```

**7. Test**

Add `test/<name>Provider.test.ts`. Mock the HTTP layer; test that `complete()`
maps request fields correctly and handles API errors.

### Key notes

- **temperature** — some APIs (e.g. Claude 4+) don't accept `temperature`. Check your API's docs and omit it if unsupported rather than passing `0`.
- **Streaming** — if your API streams, collect the full stream before returning the text string.
- **Errors** — throw on API errors. The engine catches them, logs, and retries on the next poll cycle.
- **Model ID** — pass `req.model` through to the API and return it in `CompletionResult.model`. If the API returns the actual resolved model name, use that instead.

---

## Running tests

```bash
npm test                  # all tests
npm run typecheck         # tsc on both src/ and test/
npm run lint              # eslint
npm run format:check      # prettier
```

## Manual review (without a running service)

```bash
npm run review -- owner/repo#123 --dry-run   # print JSON, post nothing
npm run review -- owner/repo#123             # post the review
```
