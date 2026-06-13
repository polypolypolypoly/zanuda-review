# review-helper

A model-agnostic AI code-review bot for GitHub. It runs under its own GitHub
account; when you **request a review from the bot on a pull request**, it
gathers project context, runs the diff through the configured LLM, and posts
structured review comments back on the PR.

## How it works

```
[every 60 s] poller → GitHub search API (review-requested:<bot-account>)
  → fetch PR diff + repo config + project context + repo memory
  → build prompt (preprompt + memory + context + diff)
  → LLM (Anthropic | OpenAI | OpenRouter | Ollama)
  → parse structured JSON result
  → post review comments via GitHub API
```

**No webhook or public endpoint required.** The bot polls GitHub — GitHub
never needs to reach in. There is no server to expose.

- **Poller-based.** Every 60 s (configurable) the bot searches for open PRs
  requesting review from the bot account and processes them. Round counts and
  reply caps persist across restarts.
- **Two review rounds.** Round 1 is the initial review. If the author pushes
  fixes and re-requests, round 2 checks whether the issues were addressed
  (final verdict — no round 3).
- **@mention replies.** After reviewing, the bot monitors the PR discussion for
  mentions and replies (up to 5 per PR).
- **Repo memory.** On first encounter with a repo the bot generates a
  persistent knowledge document (architecture, code style, key invariants).
  Every subsequent review injects this memory and optionally updates it.
- **Model-agnostic.** Every backend implements one `LLMProvider` interface.
  Switch with `LLM_PROVIDER`; nothing else changes.
- **Per-project context.** Pulls convention files (README, CONTRIBUTING,
  CLAUDE.md, manifests, …) and an optional file tree to ground the review.
- **Access control.** An allowlist (`access.allowlist` in config) restricts
  which owners/repos can request reviews. Empty = open to all.

---

## Using a hosted instance

If someone is already running review-helper as a service and has given you
access, you only need to do the following — no server or API keys required
on your end.

**Once per repo:**
1. Add the bot account as a collaborator on your repo (Read access is enough
   on public repos). For orgs, adding it as an org member covers all repos.
2. _(Optional)_ Commit `.review-helper.yml` to your org's `.github` repo for
   org-wide defaults (provider, model, extra rules).
3. _(Optional)_ Commit `.review-helper.yml` to individual repos to override
   org defaults.

**Then forever, zero setup per PR:**

4. Open a PR → request review from the bot → review appears within 60 s.

---

## Self-hosting

### 1. Create a bot GitHub account and token

Create a dedicated GitHub account for the bot (e.g. `MyReviewBot`) and
generate a Personal Access Token:
- Classic token: `repo` scope.
- Fine-grained: *Pull requests* read/write + *Contents* read on target repos.

### 2. Configure secrets

```bash
cp .env.example .env
# Fill in: GITHUB_TOKEN, GITHUB_BOT_LOGIN, and your LLM provider key
```

### 3. Create a local config override (not committed)

`config/default.yaml` ships with generic defaults. Create a separate file for
your deployment-specific values:

```yaml
# e.g. /etc/review-helper/config.yaml  (or anywhere you like)
access:
  allowlist:
    - your-org     # owner slug — any repo under this org/account
    # - other-org/specific-repo   # or a single repo

persistence:
  stateFile: "/var/lib/review-helper/state.json"

memory:
  dir: "/var/lib/review-helper/memory"
```

Point the service at it:

```bash
export REVIEW_HELPER_CONFIG=/etc/review-helper/config.yaml
```

### 4. Run

```bash
npm ci && npm run build && npm start
```

### 5. Systemd (recommended for production)

```bash
cp deploy/review-helper.service.example /etc/systemd/system/review-helper.service
$EDITOR /etc/systemd/system/review-helper.service   # fill in the <PLACEHOLDERS>

sudo systemctl daemon-reload
sudo systemctl enable --now review-helper
journalctl -u review-helper -f
```

### 6. CI/CD (optional)

See `.github/workflows/deploy.yml` for a self-hosted GitHub Actions runner
example. Customise the `SERVICE_USER`, `REPO_PATH`, and `SERVICE_NAME` env
vars at the top of the deploy job.

### 7. Onboarding a user or org

Once your instance is running, onboarding a new user/org is:

1. Add their owner slug to `access.allowlist` in your local config and restart.
2. Have them follow the **"Using a hosted instance"** steps above.

---

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

**Per-repo config** — commit `.review-helper.yml` to the repo root:

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

---

## Local / manual reviews

```bash
npm run review -- owner/repo#123 --dry-run   # print JSON, post nothing
npm run review -- owner/repo#123             # post the review
npm run review -- owner/repo#123 --round=2   # simulate round 2
```

## Choosing a model

Set `LLM_PROVIDER` and the matching key in `.env`, or per-repo in
`.review-helper.yml`. Defaults live in `config/default.yaml` under `models:`.

| Provider     | Env key              | Notes                               |
| ------------ | -------------------- | ------------------------------------|
| `anthropic`  | `ANTHROPIC_API_KEY`  | Claude models                       |
| `openai`     | `OPENAI_API_KEY`     | GPT / OpenAI-compatible             |
| `openrouter` | `OPENROUTER_API_KEY` | Any model via OpenRouter            |
| `ollama`     | (none)               | Local models; set `OLLAMA_BASE_URL` |

## Project layout

```
src/
  index.ts              entrypoint — starts the poller
  poller.ts             poll loop: find PRs, enforce limits, dispatch reviews
  config.ts             config schema, env overrides, per-repo merge
  cli.ts                manual review runner
  logger.ts             pino logger setup
  github/
    client.ts           Octokit singleton
    pullRequest.ts      fetch PR data & diff
    postReview.ts       post review comments back to GitHub
    comments.ts         fetch/format PR discussion, find @mentions
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
