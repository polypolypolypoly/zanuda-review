# Zanuda the Reviewer

AI-powered GitHub code review bot. Runs as a dedicated GitHub account (`ZlayaZanuda`). When a review is requested from the bot on a PR, it fetches context + diff, sends it to an LLM, and posts structured review comments back.

## Flow

```
[every 60 s] poller polls GitHub search API
  → finds open PRs with review-requested:ZlayaZanuda
  → fetch PR diff + repo config + project context files
  → load or generate persistent repo memory (architecture, style, invariants)
  → build prompt (preprompt + memory + context + diff)
  → LLM provider (Anthropic | OpenAI | OpenRouter | Ollama)
  → parse structured JSON result
  → post review comments via Octokit
  → (async) maybe update repo memory based on what the PR revealed
```

**No webhook / no public endpoint required.** The entrypoint (`index.ts`) runs only the poller. The Fastify webhook server (`server.ts`) exists in the codebase but is not used in production.

## Tech stack

| Layer        | Tech                                          |
|--------------|-----------------------------------------------|
| Runtime      | Node.js ≥ 20, TypeScript (ESM)                |
| Web server   | Fastify v5 (unused in prod)                   |
| GitHub API   | `@octokit/rest` + `@octokit/webhooks`         |
| LLM backends | Anthropic SDK, OpenAI SDK (also OpenRouter/Ollama via base URL override) |
| Validation   | Zod v4                                        |
| Config       | YAML (`config/default.yaml`) + dotenv         |
| Logging      | Pino + pino-pretty                            |

## Source layout (`src/`)

```
index.ts              entrypoint — starts the poller
poller.ts             poll loop: search PRs, enforce limits, dispatch reviews
config.ts             config schema, env overrides, per-repo merge
cli.ts                manual review runner (npm run review -- owner/repo#123)
logger.ts             pino logger setup
server.ts             (unused in prod) Fastify server: /webhook + /health
github/
  client.ts           Octokit singleton
  pullRequest.ts      fetch PR data & diff
  webhook.ts          (unused in prod) webhook event routing
  postReview.ts       post review comments back to GitHub
  comments.ts         fetch/format PR discussion; find @mentions
llm/
  types.ts            LLMProvider interface
  index.ts            provider factory (reads LLM_PROVIDER env)
  anthropic.ts        Anthropic Claude implementation
  openaiCompatible.ts OpenAI / OpenRouter / Ollama implementation
context/
  repoConfig.ts       fetch & merge per-repo .zanuda.yml
  builder.ts          build project context string (README, CONTRIBUTING, etc.)
  repoMemory.ts       generate, load, and update persistent per-repo memory
review/
  types.ts            ReviewComment, ReviewResult types
  prompt.ts           assemble final prompt
  engine.ts           orchestrate: context → prompt → LLM → parse → post
  replyEngine.ts      generate and post @mention replies
state/
  store.ts            atomic persistent PR state (rounds, mention caps)
```

## Key files outside `src/`

- `config/default.yaml` — global defaults (preprompt, models, limits, context file list)
- `.env` / `.env.example` — secrets (GITHUB_TOKEN, GITHUB_BOT_LOGIN, API keys)
- `deploy/zanuda.service` — systemd unit for homeserver deployment
- `Dockerfile` — Docker deployment (note: needs env vars at runtime)
- `test/` — Node built-in test runner tests

## Scripts

```bash
npm run dev           # tsx watch (dev)
npm run build         # tsc compile → dist/
npm start             # node dist/index.js (prod)
npm run review -- owner/repo#123 [--dry-run] [--round=2]  # manual one-shot review
npm test              # node --test
```

## Environment variables (key ones)

| Var                    | Purpose                                      |
|------------------------|----------------------------------------------|
| `GITHUB_TOKEN`         | Bot PAT (classic `repo` scope recommended)   |
| `GITHUB_BOT_LOGIN`     | Bot's GitHub username (`ZlayaZanuda`)        |
| `LLM_PROVIDER`         | `anthropic` \| `openai` \| `openrouter` \| `ollama` |
| `ANTHROPIC_API_KEY`    | For Anthropic provider                       |
| `OPENAI_API_KEY`       | For OpenAI provider                          |
| `OPENROUTER_API_KEY`   | For OpenRouter provider                      |
| `OLLAMA_BASE_URL`      | For local Ollama (default: http://localhost:11434) |
| `POLL_INTERVAL_SECS`   | Polling interval in seconds (default: 60)    |

## Config merge order

```
global defaults (config/default.yaml)
  → org config   ({owner}/.github repo → .zanuda.yml)
  → repo config  (repo root → .zanuda.yml)
```

Each layer overrides only the keys it sets; everything else inherits from above.
Both org and repo configs are fetched from the **base branch** of the PR, not
the PR head, so a PR author cannot influence the bot by editing them in their
branch.

## Per-org config (`{owner}/.github` → `.zanuda.yml`)

Applies to all repos under that owner/org. Useful for setting a provider,
model, or preprompt rules once instead of per-repo:

```yaml
prepromptAppend: |
  All repos here are TypeScript. Treat any use of `any` as a warning.
provider: openrouter
models:
  openrouter: anthropic/claude-opus-4-8
```

## Per-repo config (`.zanuda.yml` committed to repo root)

```yaml
provider: ollama
models:
  ollama: qwen2.5:3b
prepromptAppend: |
  This is a Rust project — pay attention to ownership and unsafe blocks.
review:
  inlineComments: true
context:
  includeFiles: [README.md, ARCHITECTURE.md]
memory:
  enabled: false   # opt out of repo memory for this repo
```

## Onboarding a new user or org

**Your side (once per user/org):**
1. Add the owner slug (or `owner/repo` for a single repo) to `access.allowlist` in `config/default.yaml` and push → CI deploys automatically.

**Their side (once per org/repo):**
2. Add `ZlayaZanuda` as a collaborator on the repo (Read is enough; needed to be requestable as a reviewer). For orgs: adding the bot as an org member covers all repos at once.
3. _(Optional)_ Commit `.zanuda.yml` to the org's `.github` repo for org-wide defaults.
4. _(Optional)_ Commit `.zanuda.yml` to individual repos to override org defaults.

**Then forever, zero setup per PR:**
5. Open a PR → request review from `ZlayaZanuda` → review appears within 60 s.

## Deployment (this instance — homeserver)

- Runs as a **systemd service** under the dedicated `zanuda` service account.
- **CI/CD via GitHub Actions self-hosted runner** on the homeserver.
  - On push to `main`: pull → `npm ci` → `npm run build` → `systemctl restart zanuda`.
  - Deploy job has `concurrency: group: deploy` to prevent parallel deploys.
- Persistent data lives in `/mnt/data/apps/review-helper/` (state file + repo memory).
- Homeserver-specific config (allowlist, paths) lives in `/mnt/data/apps/review-helper/config.yaml` — **not committed**. Loaded via `ZANUDA_CONFIG` env var in the systemd unit.
- No public endpoint — the poller reaches out to GitHub, GitHub never needs to reach in.

## Self-hosting (for others)

See `README.md → Self-hosting` and `deploy/zanuda.service.example`.
The `config/default.yaml` in the repo contains generic defaults (empty allowlist, default paths). Create your own local config file with overrides and point `ZANUDA_CONFIG` at it.

## Access control & limits

Configured in `config/default.yaml` under `access:` and `limits:`:

```yaml
access:
  allowlist:
    - polypolypolypoly   # owner slug — any repo under this account/org

limits:
  maxConcurrentReviews: 3   # max parallel LLM reviews
  maxNewPrsPerCycle: 5      # max new PRs started per poll tick
```

Per-PR caps (hardcoded in `poller.ts`):
- `MAX_REVIEW_ROUNDS = 2` — Zanuda does at most 2 full review rounds per PR
- `MAX_MENTION_REPLIES = 5` — at most 5 @mention replies per PR

All caps survive process restarts (persisted in `state.json`).

## Roadmap / not yet built

- Context caching between reviews (currently re-fetches on every review)
- Tool-use / function-calling output parsing instead of JSON-in-text
- Per-repo daily LLM call budget cap
