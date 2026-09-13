# Zanuda the Reviewer

AI code reviewer with a dedicated GitHub account (`ZlayaZanuda`). When requested as a reviewer on a PR, Zanuda fetches context + diff, sends it to an LLM, and posts structured review comments back.

## Flow

```
[every 60 s, measured after the previous tick finishes] poller polls GitHub search API
  → finds open PRs with review-requested:ZlayaZanuda
  → post "Starting review…" comment (edited with verdict when done)
  → fetch PR diff + repo config + project context files
  → load or generate persistent repo memory (architecture, style, invariants)
  → build prompt (preprompt + memory + context + diff)
  → LLM provider (Anthropic | OpenAI | OpenRouter | Ollama | DeepSeek | Gemini)
  → parse structured JSON result
  → apply hard output filters (non-LLM: drop garbage, downgrade speculative blockers,
    enforce verdict consistency)
  → post review via SCMConnector (inline comments + COMMENT event carrying the
    summary; progress comment also updated with the recommendation)
  → (async) maybe update repo memory based on what the PR revealed
```

**No webhook / no public endpoint required.** The entrypoint (`index.ts`) runs only the poller.

### Round 2 (re-review)

Round 2 does NOT auto-trigger on commit push. The author must explicitly request it:
- **GitHub re-request:** click "Re-request review" in the PR sidebar
- **@mention:** post `@ZlayaZanuda re-review` (or `review again`, `round 2`, `recheck`)

The `re-review` and `retry` commands are **author-only** — they each cost a
review round, and on a public repo anyone can comment. A command from anyone
else gets a one-line refusal (no LLM call). Plain @mentions stay open to
everyone, capped by `MAX_MENTION_REPLIES`.

After each round, the poller **always submits a `createReview` COMMENT event**
with a non-empty body. Submitting the review is the natural GitHub mechanism that
clears `requested_reviewers` (Zanuda disappears from the sidebar). The summary
is carried in BOTH the review-event body and the progress comment — the small
duplication is the cost of guaranteeing `createReview` always fires (GitHub 422s
an empty-body no-comment review, and skipping the event would leave the request
open so the PR keeps matching the search every tick).

The round-2 gate is **authoritative, not inferential**: it never treats "PR appears in
the search/poll results" as a re-request, because the search index is eventually
consistent and lags behind the REST mutation that cleared the request (this caused
spurious round-2 reviews in production). Instead, round 2 proceeds only on a
strongly-consistent signal:

- **GitHub re-request** → reviewer is back in `requested_reviewers`, verified via
  `pulls.get` (`SCMConnector.isReviewRequested`), NOT the search API.
- **@mention** → `reReviewRequested` flag in the state store (set by the mention path).

If the `isReviewRequested` check fails (API error), round 2 is withheld until the
next tick rather than falling back to the search-index heuristic.

### Prompt trust boundaries

Every section built from PR-author or commenter input is XML-tagged and
`escapeXml`-ed before it reaches the model: `<pr_title>`, `<pr_description>`,
`<diff>`, `<discussion>`, `<comment>`, `<repo_memory>`, `<review_history>`.
Only `.zanuda/instructions.md` is injected raw — it comes from the base branch
and is meant to be followed. The same rule applies to the side prompts:
repo-memory updates, outcome classification, and @mention replies.

### Output filters

Hard (non-LLM) filters run on the parsed review result before posting:
- **minBodyLength** (15 chars): drops "Test", empty strings, markdown-only garbage
- **selfDebate**: drops comments where the model argues with itself and concludes
  "it's fine" without a clear finding
- **speculativeBlocker**: downgrades 🛑→⚠️ when the model hedges ("in theory",
  "practically impossible")
- **maxBodyLength**: belt-and-suspenders truncation
- **filterReviewVerdict**: REQUEST_CHANGES with no blocker comments → COMMENT
- **filterResultSummaries**: trims runaway `summary` / `prSummary`
- **filterFilesSummary**: drops file-table rows for paths not in the PR
- **filterMentionReply**: same min/max length gates on @mention replies
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
  dailyBudget.ts      global per-day review-round counter (spend backstop)
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
memory:
  enabled: false
review:
  suggestions: true
```

**Operator-only keys** are stripped from org/repo configs at merge time
(`stripOperatorOnly` in `src/config.ts`) and apply only in `config/default.yaml`
or the `ZANUDA_CONFIG` overlay: `access`, `models`, `provider`, `limits`,
`generation.maxTokens`, `persistence`, `memory.dir`. They control the operator's
API spend and where the service account writes files — a repo config is written
by whoever can commit to that repo's base branch. Everything else
(`prepromptAppend`, `context`, `review`, `memory.enabled`) stays repo-overridable.

The `ZANUDA_CONFIG` overlay is merged by `mergeOperatorConfig` and may set every
key, including `access.allowlist`.

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

Global spend backstops:
- `limits.tokenBudgetPerPR` (400 000) — enforced between batches of a large-PR review
- `limits.maxReviewRoundsPerDay` (50) — review rounds started per UTC day across
  every repo, persisted in `daily-budget.json` so a restart cannot reset it.
  Deferred PRs keep their open review request and run the next day.

Per-PR caps (hardcoded in `poller.ts`):
- `MAX_REVIEW_ROUNDS = 2` — Zanuda does at most 2 full review rounds per PR
- `MAX_MENTION_REPLIES = 5` — at most 5 @mention replies per PR

All caps survive process restarts (persisted in `state.json`).

### Failure handling

- **Transport failures** (GitHub 5xx / rate limit / socket error, classified by
  `isTransientError` in `src/llm/retry.ts`) → `ROUND_FAILED_TRANSIENT`: the PR
  stays retryable and the next tick picks it up, bounded by
  `MAX_TRANSIENT_RETRIES` (3) consecutive failures.
- **Content failures** (unparseable model output, non-retryable 4xx) →
  `ROUND_FAILED`: the PR waits for an explicit `@reviewer retry`.
- GitHub calls go through `@octokit/plugin-throttling` and
  `@octokit/plugin-retry` with a 30 s per-request deadline (`src/github/client.ts`).
- The poll loop reschedules with `setTimeout` after each tick resolves, so ticks
  never overlap — a tick outlives the interval whenever an @mention reply is
  generated inline.

### Quota and growth

- `fetchPRDiscussion` sends `If-None-Match`; GitHub answers 304 for an unchanged
  discussion and does not charge it against the core quota. The ETag cache is
  in-memory and per PR; multi-page discussions fall back to full pagination.
- The poll loop prunes stale PR state once an hour (`store.prune()`) — pruning
  on load alone never fires in a process that stays up for months.
- The commit log caps each repo at 5 000 SHAs, oldest dropped first. Its 60-day
  prune keys off repo inactivity, which never triggers for an active repo.

## Roadmap / not yet built

- Context caching between reviews (currently re-fetches on every review)
- Tool-use / function-calling output parsing instead of JSON-in-text

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
4. **Inferential gates over eventually-consistent data:** "PR showed up in the
   search results, so the author must have re-requested" is not a safe
   inference — the search index lags behind REST mutations. Gates that drive
   side effects (round 2, retries) must check a strongly-consistent source
   (`pulls.get`, not the search API). See the round-2 re-review gate in
   `src/poller.ts` and `SCMConnector.isReviewRequested`.
5. **Tests for new rendering/output functions:** Even simple formatters on
   security-relevant paths need tests. Check if a test file already exists.

When the model drifts in production, prefer a hard (non-LLM) output filter over
another prompt tweak. See `src/review/filters.ts` for the pattern: regex-based
drop/mutate gates that run post-parse, pre-post, with zero additional LLM cost.
