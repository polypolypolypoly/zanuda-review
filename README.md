# review-helper

A model-agnostic AI code-review bot for GitHub. It runs under its own GitHub
account; when you **request a review from the bot on a pull request**, it
gathers project context, runs the diff through the configured LLM, and posts
review comments back on the PR.

## How it works

```
PR "review requested" → webhook → fetch PR + repo config + project context
                                → build prompt (preprompt + context + diff)
                                → LLM (Anthropic | OpenAI | OpenRouter | Ollama)
                                → parse structured result → post review comments
```

- **Bot account + PAT.** The bot is a normal GitHub account. Add it as a
  collaborator on a repo and configure that repo's webhook to point at this
  server. To get a review, add the bot as a reviewer on a PR.
- **Model-agnostic.** Every backend implements one `LLMProvider` interface
  (`src/llm/`). Switch with `LLM_PROVIDER`; nothing else changes.
- **Per-project context.** For every repo it's added to, the bot pulls
  convention files (README, CONTRIBUTING, CLAUDE.md, manifests, …) and an
  optional file tree to ground the review. Configured under `context:` in
  `config/default.yaml`.
- **Configurable preprompt.** The global system instruction lives in
  `config/default.yaml`. Any repo can override or extend it (and most other
  settings) by committing a `.review-helper.yml`.

## Setup

1. **Create the bot's GitHub account** and a Personal Access Token.
   - Classic token: `repo` scope. Fine-grained: *Pull requests* read/write and
     *Contents* read-only on the target repos.
2. `cp .env.example .env` and fill in `GITHUB_TOKEN`, `GITHUB_BOT_LOGIN`,
   `GITHUB_WEBHOOK_SECRET`, and the API key for your chosen provider.
3. `npm install`
4. `npm run dev` (or `npm run build && npm start`).
5. On each target repo: **Settings → Webhooks → Add webhook**
   - Payload URL: `https://<your-host>/webhook`
   - Content type: `application/json`
   - Secret: same as `GITHUB_WEBHOOK_SECRET`
   - Events: *Pull requests* (or just "Pull request review requested").
6. Add the bot account as a collaborator, then **request a review from it** on
   any PR.

## Per-repo configuration (`.review-helper.yml`)

Commit this to a repo's default branch to override global defaults:

```yaml
provider: ollama
models:
  ollama: qwen2.5:3b
prepromptAppend: |
  This is a Rust project — pay special attention to ownership and unsafe blocks.
review:
  inlineComments: true
context:
  includeFiles: [README.md, ARCHITECTURE.md]
```

## Local / manual reviews

Run a review without the webhook (good for testing):

```bash
npm run review -- owner/repo#123 --dry-run   # print JSON, post nothing
npm run review -- owner/repo#123             # post the review
```

## Choosing a model

Set `LLM_PROVIDER` and the matching key in `.env`, or per-repo in
`.review-helper.yml`. Defaults live in `config/default.yaml` under `models:`.

| Provider     | Env key              | Notes                                  |
| ------------ | -------------------- | -------------------------------------- |
| `anthropic`  | `ANTHROPIC_API_KEY`  | Claude models                          |
| `openai`     | `OPENAI_API_KEY`     | GPT / OpenAI-compatible                 |
| `openrouter` | `OPENROUTER_API_KEY` | Any model routed via OpenRouter        |
| `ollama`     | (none)               | Local models; `OLLAMA_BASE_URL`        |

## Deployment (homeserver)

The bot is a long-running webhook server. Two ways to run it; pick one.

### Option A — systemd (recommended on `homeserver`)

```bash
npm ci && npm run build
sudo cp deploy/review-helper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now review-helper
journalctl -u review-helper -f          # logs
```

The unit runs `node dist/index.js` from the project dir; secrets are read
from `.env` (via dotenv). Listens on `PORT` (default 3000).

### Option B — Docker

```bash
docker build -t review-helper .
docker run -d --name review-helper --env-file .env -p 3000:3000 review-helper
```

### Exposing the webhook to GitHub

GitHub delivers webhooks from the public internet, but `homeserver` is behind
Tailscale. Expose just the webhook port publicly with **Tailscale Funnel**:

```bash
sudo tailscale funnel 3000
```

This gives a public `https://homeserver.<tailnet>.ts.net/` URL. Use
`https://homeserver.<tailnet>.ts.net/webhook` as the Payload URL when
configuring each repo's webhook (see Setup, step 5).

### Per-repo wiring

For every repo the bot reviews:

1. Add `ZlayaZanuda` as a collaborator (Read is enough — it can post
   `COMMENT` reviews without write access).
2. Add a webhook → Payload URL `…/webhook`, content type `application/json`,
   secret = `GITHUB_WEBHOOK_SECRET`, event **Pull requests**.
3. On a PR, **request a review from the bot**.

> Note: for repos owned by a *different personal account*, the bot's
> `GITHUB_TOKEN` must be a **classic** PAT (`ghp_…`) with `repo` scope —
> fine-grained tokens can't reach another account's repos even as a
> collaborator.

## Project layout

```
src/
  index.ts            entrypoint — starts the webhook server
  server.ts           Fastify server: /webhook + /health
  config.ts           config schema, env overrides, per-repo merge
  github/             Octokit client, PR fetch, webhook routing, review posting
  llm/                model-agnostic provider interface + implementations
  context/            per-repo config + project context builder
  review/             prompt assembly, review engine, output schema
  cli.ts              manual review runner
```

## Tests

```bash
npm test
```

## Roadmap / not-yet-built

- Re-review on `@bot` mention or new commits.
- Caching of project context between reviews.
- Tool-use / function-calling output instead of JSON-in-text parsing.
- Rate limiting and per-repo allowlist.
