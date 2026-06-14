# Zanuda the Reviewer

An AI code reviewer that runs as its own GitHub account. Add Zanuda to a PR and they post inline comments and a clear recommendation — with a consistent voice, codebase memory, and security-first judgment. Zanuda never blocks or approves merges; that's the humans' call.

## How it works

Zanuda polls GitHub every 60 s for PRs with a pending review request, then:

1. Fetches the diff, per-repo config, and convention files (README, manifests, etc.)
2. On first encounter with a repo, generates a persistent memory doc (architecture, code style, invariants) and reuses it on every subsequent review
3. Sends everything to the configured LLM and parses the structured result
4. Posts inline review comments via the GitHub API

No webhook or public endpoint needed — Zanuda reaches out to GitHub, not the other way around.

**Rounds.** Zanuda does at most two rounds per PR. Round 1 is the initial review. If the author pushes fixes and re-requests, round 2 is the final verdict. It also replies to `@mentions` in the PR discussion (up to 5 per PR).

**Providers.** Anthropic, OpenAI, OpenRouter (200+ models), and Ollama for local models. Switch with `LLM_PROVIDER` in `.env`; nothing else changes.

---

## Using a hosted instance

The hosted instance runs as [@ZlayaZanuda](https://github.com/ZlayaZanuda). If you've been given access:

1. Add [@ZlayaZanuda](https://github.com/ZlayaZanuda) as a collaborator on your repo (Read is enough on public repos; for orgs, making it an org member covers everything).
2. Optionally commit `.zanuda/config.yml` to your org's `.github` repo for org-wide defaults, or to individual repos to override them.
3. Open a PR and request a review from Zanuda. That's it.

**Automatic review requests.** Zanuda skips draft PRs regardless of how the review was requested — it only picks up non-draft, open PRs. Two common setups:

- **GitHub Actions** (recommended) — copy `deploy/auto-review.yml.example` to `.github/workflows/zanuda-review.yml`. Requests Zanuda only when a PR is opened or marked ready, never on drafts.
- **CODEOWNERS** — add `* @ZlayaZanuda` to `.github/CODEOWNERS`. GitHub auto-requests on every PR including drafts; Zanuda won't act until the PR is marked ready, at which point a review fires automatically with no further human action. Useful for agent-driven or high-throughput repos — be aware that every non-draft PR will trigger a review without anyone explicitly asking for one.

---

## Self-hosting

### 1. Reviewer account

Create a dedicated GitHub account for Zanuda and a Personal Access Token - classic with `repo` scope, or fine-grained with *Pull requests* read/write and *Contents* read on the target repos.

### 2. Secrets

```bash
cp .env.example .env
# Set GITHUB_TOKEN and your LLM provider key
```

### 3. Local config

`config/default.yaml` has the generic defaults. Put your deployment-specific overrides in a separate file that you don't commit:

```yaml
# /etc/zanuda/config.yaml
access:
  allowlist:
    - your-org          # any repo under this org/account
    # - your-org/repo   # or a single repo

persistence:
  stateFile: "/var/lib/zanuda/state.json"

memory:
  dir: "/var/lib/zanuda/memory"
```

```bash
export ZANUDA_CONFIG=/etc/zanuda/config.yaml
```

### 4. Run

**Docker** (easiest):

```bash
docker build -t zanuda .
docker run -d --restart unless-stopped --env-file .env \
  -e ZANUDA_CONFIG=/config.yaml \
  -v /path/to/your/config.yaml:/config.yaml:ro \
  -v zanuda-data:/home/zanuda/.zanuda \
  zanuda
```

**Node directly:**

```bash
npm ci && npm run build && npm start
```

Both work. Docker is self-contained; Node is simpler if you're already on the machine.

### 5. Long-running in production (optional)

If you want Zanuda to survive reboots and restart on failure, use a process
manager. Systemd example (`deploy/zanuda.service.example`), Docker's
`--restart unless-stopped`, or PM2 all work fine. Pick what you already use.

### 6. CI/CD

`.github/workflows/deploy.yml` has a self-hosted runner example. Set `SERVICE_USER`, `REPO_PATH`, and `SERVICE_NAME` at the top of the deploy job.

### 7. Adding users

To give a user or org access: add their slug to `access.allowlist` in your local config and restart. Have them follow the hosted-instance steps above.

---

## Configuration

All Zanuda files live under `.zanuda/` in the repo root (or in the org's `.github` repo for org-wide settings):

```
.zanuda/
  config.yml          # settings (provider, model, preprompt rules, etc.)
  instructions.md     # free-form reviewer guidelines
```

Settings merge in order - each layer overrides only what it sets:

```
global defaults  →  {owner}/.github/.zanuda/config.yml  →  repo/.zanuda/config.yml
```

Instructions concatenate in the same order (org first, repo second).

### `.zanuda/config.yml`

```yaml
provider: openrouter
models:
  openrouter: anthropic/claude-opus-4-8
prepromptAppend: |
  This is a Rust project. Flag any use of unsafe.
context:
  includeFiles: [README.md, ARCHITECTURE.md]
memory:
  enabled: false
```

Full list of options: see `config/default.yaml`.

### `.zanuda/instructions.md`

Free-form markdown injected into every review as reviewer guidelines. Use it to tell Zanuda what matters for your specific codebase - naming conventions, invariants, things to always flag, things to ignore.

This repo ships its own `.zanuda/instructions.md` as a working example. Copy it and adapt to your project.

Committed to the base branch only - PR authors cannot influence it.

---

## Manual reviews

**Remote PR:**
```bash
npm run review -- owner/repo#123            # post the review
npm run review -- owner/repo#123 --dry-run  # print JSON, don't post
npm run review -- owner/repo#123 --round=2  # run as round 2
```

**Local** (no GitHub account needed):
```bash
npm run review -- --local                        # review staged changes
npm run review -- --local --diff main            # diff against main
npm run review -- --local --diff HEAD~3          # last 3 commits
npm run review -- --local --output review.md     # write to file
```
Zanuda reads your local diff and `.zanuda/` config, sends it to the configured LLM, and prints the review to stdout (or a file).

## Models

| Provider     | Env var              | Notes                               |
| ------------ | -------------------- | ------------------------------------|
| `anthropic`  | `ANTHROPIC_API_KEY`  | Claude                              |
| `openai`     | `OPENAI_API_KEY`     | GPT and compatible                  |
| `openrouter` | `OPENROUTER_API_KEY` | 200+ models                         |
| `ollama`     | -                    | Local; set `OLLAMA_BASE_URL`        |

## Tests

```bash
npm test
```

## Adding a new LLM provider

Zanuda's LLM layer is a single-method interface. Adding Gemini, Mistral, Cohere, or any other provider follows the same pattern as the existing ones.

**Four wiring points:**

1. **Copy the stub** - `src/llm/stub.ts` is an annotated skeleton with JSDoc explaining every field.

   ```bash
   cp src/llm/stub.ts src/llm/<name>.ts
   ```

2. **Implement `complete()`** - one method: takes a system prompt + user message, returns a text string. See `src/llm/types.ts` for the full contract.

3. **Register in the factory** - add one `case` to `src/llm/index.ts` and add the provider name to the enum in `src/config.ts`.

4. **Wire up config** - add a default model ID to `config/default.yaml` and an API key entry to `.env.example`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide including notes on temperature handling, streaming, and error propagation.

## Adding a new platform (GitLab, Bitbucket, ...)

Zanuda's GitHub integration is one connector behind a clean interface. The review engine, LLM layer, config system, and state store are all platform-agnostic and require zero changes to support a new platform.

**Five steps:**

1. **Copy the stub** - `src/platform/stub/connector.ts` is a fully annotated skeleton with JSDoc explaining what each method needs to do, plus GitLab/Bitbucket API equivalents for every call.

   ```bash
   cp src/platform/stub/connector.ts src/platform/<name>/connector.ts
   ```

2. **Implement the interface** - 10 methods: auth, polling, PR fetch, file read, file tree, discussion fetch, post review, post comment, edit comment, reply to comment. See `src/platform/types.ts` for the full contract and `src/platform/github/connector.ts` as a reference.

3. **Register in the factory** - add one `case` to `src/platform/index.ts`:

   ```typescript
   case "gitlab":
     return new GitLabConnector({ token: requireEnv("GITLAB_TOKEN") });
   ```

4. **Wire up config** - add the new token/URL env vars to `.env.example` under the platform section.

5. **Test** - run `npm test` and add connector-specific tests in `test/`. See `test/githubConnector.test.ts` for the pattern.

Set `PLATFORM=<name>` in `.env` to activate your connector. Everything else - reviews, memory, config merging, rate limits - works unchanged.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, including how to add a new platform connector.

Short version: open an issue first for anything beyond a small fix, tests are required, all CI checks must pass. Security issues go to the maintainers directly, not a public issue.

MIT licensed. By contributing you agree your work will be distributed under the same terms.
