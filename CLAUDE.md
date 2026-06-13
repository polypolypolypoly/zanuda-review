# review-helper (alias: Zanuda)

AI-powered GitHub code review bot. Runs as a dedicated GitHub account (`ZlayaZanuda`). When a review is requested from the bot on a PR, it fetches context + diff, sends it to an LLM, and posts structured review comments back.

## Flow

```
[every 60 s] poller polls GitHub search API
  → finds open PRs with review-requested:ZlayaZanuda
  → fetch PR diff + repo config + project context files
  → build prompt (preprompt + context + diff)
  → LLM provider (Anthropic | OpenAI | OpenRouter | Ollama)
  → parse structured JSON result
  → post review comments via Octokit
```

**No webhook / no public endpoint required.** The entrypoint (`index.ts`) runs only the poller. The Fastify webhook server (`server.ts`) exists in the codebase but is not used in production.

## Tech stack

| Layer        | Tech                                          |
|--------------|-----------------------------------------------|
| Runtime      | Node.js ≥ 20, TypeScript (ESM)                |
| Web server   | Fastify v5                                    |
| GitHub API   | `@octokit/rest` + `@octokit/webhooks`         |
| LLM backends | Anthropic SDK, OpenAI SDK (also OpenRouter/Ollama via base URL override) |
| Validation   | Zod v4                                        |
| Config       | YAML (`config/default.yaml`) + dotenv         |
| Logging      | Pino + pino-pretty                            |

## Source layout (`src/`)

```
index.ts              entrypoint — starts the webhook server
server.ts             Fastify server: /webhook + /health
config.ts             config schema, env overrides, per-repo merge
cli.ts                manual review runner (npm run review -- owner/repo#123)
poller.ts             (polling fallback, not webhook)
logger.ts             pino logger setup
github/
  client.ts           Octokit singleton
  pullRequest.ts      fetch PR data & diff
  webhook.ts          webhook event routing
  postReview.ts       post review comments back to GitHub
llm/
  types.ts            LLMProvider interface
  index.ts            provider factory (reads LLM_PROVIDER env)
  anthropic.ts        Anthropic Claude implementation
  openaiCompatible.ts OpenAI / OpenRouter / Ollama implementation
context/
  repoConfig.ts       fetch & merge per-repo .review-helper.yml
  builder.ts          build project context string (README, CONTRIBUTING, etc.)
review/
  types.ts            ReviewComment, ReviewResult types
  prompt.ts           assemble final prompt
  engine.ts           orchestrate: context → prompt → LLM → parse → post
```

## Key files outside `src/`

- `config/default.yaml` — global defaults (preprompt, models, context file list)
- `.env` / `.env.example` — secrets (GITHUB_TOKEN, GITHUB_BOT_LOGIN, GITHUB_WEBHOOK_SECRET, API keys)
- `deploy/review-helper.service` — systemd unit for homeserver deployment
- `Dockerfile` — Docker deployment
- `test/engine.test.ts` — Node built-in test runner tests

## Scripts

```bash
npm run dev           # tsx watch (dev)
npm run build         # tsc compile → dist/
npm start             # node dist/index.js (prod)
npm run review -- owner/repo#123 [--dry-run]   # manual one-shot review
npm test              # node --test
```

## Environment variables (key ones)

| Var                    | Purpose                                      |
|------------------------|----------------------------------------------|
| `GITHUB_TOKEN`         | Bot PAT (classic `repo` scope recommended)   |
| `GITHUB_BOT_LOGIN`     | Bot's GitHub username (`ZlayaZanuda`)         |
| `GITHUB_WEBHOOK_SECRET`| Webhook HMAC secret                          |
| `LLM_PROVIDER`         | `anthropic` \| `openai` \| `openrouter` \| `ollama` |
| `ANTHROPIC_API_KEY`    | For Anthropic provider                       |
| `OPENAI_API_KEY`       | For OpenAI provider                          |
| `OPENROUTER_API_KEY`   | For OpenRouter provider                      |
| `OLLAMA_BASE_URL`      | For local Ollama (default: http://localhost:11434) |
| `PORT`                 | HTTP port (default: 3000)                    |

## Per-repo config (`.review-helper.yml` committed to repo root)

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
```

## Deployment (homeserver)

- Runs as a **systemd service** (`deploy/review-helper.service`) on the homeserver under user `amogus`.
- **CI/CD via GitHub Actions self-hosted runner** (the runner itself runs on the homeserver).
  - On push to `main`: runner pulls latest code, `npm ci`, `npm run build`, `sudo systemctl restart review-helper`.
- No public endpoint or Tailscale Funnel — the poller reaches out to GitHub, GitHub never needs to reach in.

## Roadmap / not yet built

- Re-review on `@bot` mention or new commits
- Context caching between reviews
- Tool-use / function-calling output parsing
- Rate limiting and per-repo allowlist
