# Zanuda the Reviewer

AI code reviewer with a dedicated GitHub account (`ZlayaZanuda`). When requested as a reviewer on a PR, Zanuda fetches context + diff, sends it to an LLM, and posts structured review comments back.

## Flow

```
[every 60 s] poller polls GitHub search API
  → finds open PRs with review-requested:ZlayaZanuda
  → post "Starting review…" comment (edited with verdict when done)
  → fetch PR diff + repo config + project context files
  → load or generate persistent repo memory (architecture, style, invariants)
  → build prompt (preprompt + memory + context + diff)
  → LLM provider (Anthropic | OpenAI | OpenRouter | Ollama | DeepSeek | Gemini)
  → parse structured JSON result
  → apply hard output filters (non-LLM: drop garbage, downgrade speculative blockers,
    enforce verdict consistency)
  → post review via SCMConnector (inline comments + COMMENT event; progress comment
    updated with recommendation)
  → (async) maybe update repo memory based on what the PR revealed
```

**No webhook / no public endpoint required.** The entrypoint (`index.ts`) runs only the poller.

### Round 2 (re-review)

Round 2 does NOT auto-trigger on commit push. The author must explicitly request it:
- **GitHub re-request:** click "Re-request review" in the PR sidebar
- **@mention:** post `@ZlayaZanuda re-review` (or `review again`, `round 2`, `recheck`)

After round 1, the review request is dismissed so the PR stops appearing in the
search. The poller also scans the state store for PRs with `reReviewRequested`
flags (set by the mention path).

### Output filters

Hard (non-LLM) filters run on the parsed review result before posting:
- **minBodyLength** (15 chars): drops "Test", empty strings, markdown-only garbage
- **selfDebate**: drops comments where the model argues with itself and concludes
  "it's fine" without a clear finding
- **speculativeBlocker**: downgrades 🛑→⚠️ when the model hedges ("in theory",
  "practically impossible")
- **maxBodyLength**: belt-and-suspenders truncation
- **filterReviewVerdict**: REQUEST_CHANGES with no blocker comments → COMMENT
- **commit dedup**: skips PRs whose commits were all already reviewed

## Tech stack

| Layer        | Tech                                          |
|--------------|-----------------------------------------------|
| Runtime      | Node.js ≥ 20, TypeScript (ESM)                |
| GitHub API   | `@octokit/rest`                               |
| LLM backends | Anthropic SDK, OpenAI SDK (also OpenRouter, Ollama, DeepSeek, Gemini via base URL override) |
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
  local/
    connector.ts      LocalConnector — reviews staged git changes, no GitHub needed
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
  openaiCompatible.ts OpenAI / OpenRouter / Ollama / DeepSeek / Gemini implementation
  stub.ts             annotated skeleton for new provider implementers
context/
  repoConfig.ts       fetch & merge per-repo .zanuda/config.yml
  builder.ts          build project context string (README, CONTRIBUTING, etc.)
  repoMemory.ts       generate, load, and update persistent per-repo memory
review/
  types.ts            ReviewComment, ReviewResult types
  prompt.ts           assemble final prompt
  engine.ts           orchestrate: context → prompt → LLM → parse → filters → post
  replyEngine.ts      generate and post @mention replies
  filters.ts          hard (non-LLM) output filters: minBodyLength, selfDebate,
                      speculativeBlocker, maxBodyLength, filterReviewVerdict
  format.ts           review comment body formatting (markdown)
  diff.ts             diff assembly and budget management
  chunk.ts            dependency-aware file clustering for large PRs
  batch.ts            multi-batch sequential review for large PRs
  parse.ts            parse LLM text output into ReviewResult
  verify.ts           self-verification pass (LLM checks own findings)
  budget.ts           token budget management
state/
  store.ts            atomic persistent PR state (rounds, mention caps, re-review)
  commitLog.ts        per-repo reviewed commit SHA log (dedup gate)
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
npm run review -- owner/repo#123 [--dry-run] [--round=2]  # remote PR review
npm run review -- --local [--diff <ref>] [--casual] [--no-memory] [--model <id>]  # local review
npm run review -- --spawn [--model <id>]                                         # initial memory scan
npm test              # node --test
```

## Environment variables (key ones)

| Var                    | Purpose                                      |
|------------------------|----------------------------------------------|
| `GITHUB_TOKEN`         | Zanuda's PAT — login is resolved from it automatically |
| `PLATFORM`             | Source control platform (default: `github`)  |
| `LLM_PROVIDER`         | `anthropic` \| `openai` \| `openrouter` \| `ollama` \| `deepseek` \| `gemini` |
| `ANTHROPIC_API_KEY`    | For Anthropic provider                       |
| `OPENAI_API_KEY`       | For OpenAI provider                          |
| `OPENROUTER_API_KEY`   | For OpenRouter provider                      |
| `OLLAMA_BASE_URL`      | For local Ollama (default: http://localhost:11434) |
| `DEEPSEEK_API_KEY`     | For DeepSeek provider                        |
| `DEEPSEEK_BASE_URL`    | Custom DeepSeek endpoint (optional)          |
| `GEMINI_API_KEY`       | For Gemini provider                          |
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
2. Add `ZlayaZanuda` as a collaborator on the repo (Read is enough; needed to be requestable as a reviewer). For orgs: adding Zanuda as an org member covers all repos at once.
3. _(Optional)_ Commit `.zanuda/config.yml` to the org's `.github` repo for org-wide defaults.
4. _(Optional)_ Commit `.zanuda/config.yml` to individual repos to override org defaults.

**Then forever, zero setup per PR:**
5. Open a PR → request review from `ZlayaZanuda` → review appears within 60 s.

## Deployment (this instance — homeserver)

- Runs as a **systemd service** under the dedicated `zanuda` service account.
- **CI/CD via GitHub Actions self-hosted runner** on the homeserver.
  - On push to `main`: pull → `npm ci` → `npm run build` → `systemctl restart review-helper`.
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

## Defensive coding — check before shipping

When adding any new feature, especially one that processes or renders LLM output,
pause and ask:

1. **Fence-break / injection:** If this string gets embedded inside markdown fences
   (\`\`\`, `"""`, `<tag>`), can it break out? Sanitise: prepend a space to lines
   starting with the fence delimiter, or reject/escape the delimiter.
2. **Unbounded output:** If the LLM generates this field, what's the worst-case
   size? Add a `.max()` in Zod and `maxLength` in JSON schema. Every string field
   the LLM writes needs a cap.
3. **Happy-path thinking:** "The prompt tells the model not to do X" is not a
   security boundary. Always ask: what happens if the model ignores the instruction?
   Add a defensive fallback.
4. **Tests for new rendering/output functions:** Even simple formatters on
   security-relevant paths need tests. Check if a test file already exists.

When the model drifts in production, prefer a hard (non-LLM) output filter over
another prompt tweak. See `src/review/filters.ts` for the pattern: regex-based
drop/mutate gates that run post-parse, pre-post, with zero additional LLM cost.
