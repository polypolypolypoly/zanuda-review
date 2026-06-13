# Zanuda the Reviewer

AI code reviewer with a dedicated GitHub account (`ZlayaZanuda`). When requested as a reviewer on a PR, she fetches context + diff, sends it to an LLM, and posts structured review comments back.

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
poller.ts             poll loop: find PRs, enforce limits, dispatch reviews
config.ts             config schema, env overrides, per-repo merge
cli.ts                manual review runner (npm run review -- owner/repo#123)
logger.ts             pino logger setup
platform/
  types.ts            SCMConnector interface + shared types (PullRequest, SCMComment, …)
  index.ts            connector factory (reads PLATFORM env var)
  github/
    connector.ts      GitHubConnector — reference implementation
  stub/
    connector.ts      annotated skeleton for new platform implementers
github/
  client.ts           Octokit singleton + createOctokit()
  pullRequest.ts      fetch PR data & diff
  postReview.ts       post review comments back to GitHub
  comments.ts         fetch/format PR discussion; find @mentions
  allowlist.ts        allowlist check (isAllowed)
llm/
  types.ts            LLMProvider interface
  index.ts            provider factory (reads LLM_PROVIDER env)
  anthropic.ts        Anthropic Claude implementation
  openaiCompatible.ts OpenAI / OpenRouter / Ollama implementation
context/
  repoConfig.ts       fetch & merge per-repo .zanuda/config.yml
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
- `.env` / `.env.example` — secrets (GITHUB_TOKEN, LLM API keys)
- `deploy/zanuda.service.example` — systemd unit template for deployment
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
| `GITHUB_TOKEN`         | Zanuda's PAT — login is resolved from it automatically |
| `LLM_PROVIDER`         | `anthropic` \| `openai` \| `openrouter` \| `ollama` |
| `ANTHROPIC_API_KEY`    | For Anthropic provider                       |
| `OPENAI_API_KEY`       | For OpenAI provider                          |
| `OPENROUTER_API_KEY`   | For OpenRouter provider                      |
| `OLLAMA_BASE_URL`      | For local Ollama (default: http://localhost:11434) |
| `POLL_INTERVAL_SECS`   | Polling interval in seconds (default: 60)    |

## Per-repo and per-org files

All Zanuda files live under `.zanuda/` in the repo root, or in the org's `.github` repo for org-wide settings:

```
.zanuda/
  config.yml          # settings overrides
  instructions.md     # free-form reviewer guidelines
```

### Config merge order

```
global defaults (config/default.yaml)
  → org config   ({owner}/.github → .zanuda/config.yml)
  → repo config  (repo root → .zanuda/config.yml)
```

Instructions concatenate in the same order (org first, repo appended).

All files are fetched from the **base branch** of the PR — a PR author cannot
influence Zanuda's behaviour by editing them in their branch.

### `.zanuda/config.yml` (org or repo)

```yaml
prepromptAppend: |
  All repos here are TypeScript. Treat any use of `any` as a warning.
provider: openrouter
models:
  openrouter: anthropic/claude-opus-4-8
memory:
  enabled: false
```

### `.zanuda/instructions.md` (org or repo)

Free-form markdown injected into every review as reviewer guidelines. Not XML-sandboxed (intentional — we want the model to follow these). Fetched from the base branch so PR authors cannot tamper with them.

This repo ships its own `.zanuda/instructions.md` — it serves as both the live configuration and a reference example for other projects.

## Onboarding a new user or org

**Your side (once per user/org):**
1. Add the owner slug (or `owner/repo` for a single repo) to `access.allowlist` in `config/default.yaml` and push → CI deploys automatically.

**Their side (once per org/repo):**
2. Add `ZlayaZanuda` as a collaborator on the repo (Read is enough; needed to be requestable as a reviewer). For orgs: adding her as an org member covers all repos at once.
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
