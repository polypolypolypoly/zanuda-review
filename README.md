# review-helper (Zanuda)

A model-agnostic AI code-review bot for GitHub. It runs under its own GitHub
account (`ZlayaZanuda`); when you **request a review from the bot on a pull
request**, it gathers project context, runs the diff through the configured
LLM, and posts structured review comments back on the PR.

## How it works

```
[every 60 s] poller → GitHub search API (review-requested:ZlayaZanuda)
  → fetch PR diff + repo config + project context + repo memory
  → build prompt (preprompt + memory + context + diff)
  → LLM (Anthropic | OpenAI | OpenRouter | Ollama)
  → parse structured JSON result
  → post review comments via GitHub API
```

**No webhook or public endpoint required.** The bot polls GitHub — GitHub
never needs to reach in. There is no server to expose.

- **Poller-based.** Every 60 s (configurable) the bot searches for open PRs
  with `review-requested:ZlayaZanuda` and processes them. Round counts and
  reply caps persist across restarts.
- **Two review rounds.** Round 1 is the initial review. If the author pushes
  fixes and re-requests, round 2 checks whether the issues were addressed
  (final verdict — no round 3).
- **@mention replies.** After reviewing, the bot monitors the PR discussion for
  `@ZlayaZanuda` mentions and replies (up to 5 per PR).
- **Repo memory.** On first encounter with a repo the bot generates a
  persistent knowledge document (architecture, code style, key invariants).
  Every subsequent review injects this memory and optionally updates it.
- **Model-agnostic.** Every backend implements one `LLMProvider` interface.
  Switch with `LLM_PROVIDER`; nothing else changes.
- **Per-project context.** Pulls convention files (README, CONTRIBUTING,
  CLAUDE.md, manifests, …) and an optional file tree to ground the review.
- **Access control.** An allowlist (`access.allowlist` in config) restricts
  which owners/repos can request reviews. Empty = open to all.

## Setup

1. **Create the bot's GitHub account** and a Personal Access Token.
   - Classic token: `repo` scope.
   - Fine-grained: *Pull requests* read/write + *Contents* read on target repos.
2. `cp .env.example .env` — fill in `GITHUB_TOKEN`, `GITHUB_BOT_LOGIN`, and
   the API key for your chosen LLM provider.
3. `npm install && npm run build`
4. `npm start` (or via systemd — see Deployment below).
5. For each repo to review: add `ZlayaZanuda` as a collaborator (Read access
   is enough), then **request a review from the bot** on a PR.

No webhook configuration required.

## Configuration layers

Settings are merged in order — each layer overrides only what it sets:

```
global defaults (config/default.yaml)
  → org config   ({owner}/.github repo → .review-helper.yml)
  → repo config  (repo root → .review-helper.yml)
```

**Org config** — commit `.review-helper.yml` to the org's `.github` repository.
Applies to all repos under that org. Good for setting a shared provider, model,
or preprompt rules once:

```yaml
prepromptAppend: |
  All repos here are TypeScript — treat any use of `any` as a warning.
provider: openrouter
models:
  openrouter: anthropic/claude-opus-4-8
```

**Per-repo config** — commit `.review-helper.yml` to the repo root to override
global and org defaults:

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

## Local / manual reviews

```bash
npm run review -- owner/repo#123 --dry-run   # print JSON, post nothing
npm run review -- owner/repo#123             # post the review
npm run review -- owner/repo#123 --round=2   # simulate round 2
```

## Choosing a model

Set `LLM_PROVIDER` and the matching key in `.env`, or per-repo in
`.review-helper.yml`. Defaults live in `config/default.yaml` under `models:`.

| Provider     | Env key              | Notes                           |
| ------------ | -------------------- | --------------------------------|
| `anthropic`  | `ANTHROPIC_API_KEY`  | Claude models                   |
| `openai`     | `OPENAI_API_KEY`     | GPT / OpenAI-compatible         |
| `openrouter` | `OPENROUTER_API_KEY` | Any model via OpenRouter        |
| `ollama`     | (none)               | Local models; set `OLLAMA_BASE_URL` |

## Deployment (homeserver)

Runs as a systemd service under the `zanuda` service account. CI/CD via a
self-hosted GitHub Actions runner that pulls, builds, and restarts on every
push to `main`.

```bash
# First-time setup
sudo cp deploy/review-helper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now review-helper

# Logs
journalctl -u review-helper -f
```

Persistent data (state file + repo memory) lives in `/mnt/data/apps/review-helper/`.

## Project layout

```
src/
  index.ts              entrypoint — starts the poller
  poller.ts             poll loop: find PRs, enforce limits, dispatch reviews
  config.ts             config schema, env overrides, per-repo merge
  cli.ts                manual review runner
  logger.ts             pino logger setup
  server.ts             (unused in prod) Fastify webhook server
  github/
    client.ts           Octokit singleton
    pullRequest.ts      fetch PR data & diff
    postReview.ts       post review comments back to GitHub
    comments.ts         fetch/format PR discussion, find @mentions
    webhook.ts          (unused in prod) webhook event routing
  llm/
    types.ts            LLMProvider interface
    index.ts            provider factory
    anthropic.ts        Anthropic Claude implementation
    openaiCompatible.ts OpenAI / OpenRouter / Ollama implementation
  context/
    repoConfig.ts       fetch & merge per-repo .review-helper.yml
    builder.ts          build project context string
    repoMemory.ts       generate, load, update persistent repo memory
  review/
    types.ts            ReviewComment, ReviewResult types
    prompt.ts           assemble final prompt
    engine.ts           orchestrate: context → prompt → LLM → parse → post
    replyEngine.ts      generate and post @mention replies
  state/
    store.ts            atomic persistent PR state (rounds, mention caps)
```

## Tests

```bash
npm test
```
