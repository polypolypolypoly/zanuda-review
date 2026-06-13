# Zanuda the Reviewer

A GitHub code review bot that runs as its own account. Add it as a reviewer on a PR and it posts inline comments, approves, or requests changes — powered by whatever LLM you configure.

## How it works

Zanuda polls GitHub every 60 s for PRs with a pending review request, then:

1. Fetches the diff, per-repo config, and convention files (README, manifests, etc.)
2. On first encounter with a repo, generates a persistent memory doc (architecture, code style, invariants) and reuses it on every subsequent review
3. Sends everything to the configured LLM and parses the structured result
4. Posts inline review comments via the GitHub API

No webhook or public endpoint needed — the bot reaches out to GitHub, not the other way around.

**Rounds.** Zanuda does at most two rounds per PR. Round 1 is the initial review. If the author pushes fixes and re-requests, round 2 is the final verdict. It also replies to `@mentions` in the PR discussion (up to 5 per PR).

**Providers.** Anthropic, OpenAI, OpenRouter (200+ models), and Ollama for local models. Switch with `LLM_PROVIDER` in `.env`; nothing else changes.

---

## Using a hosted instance

If someone is running Zanuda and has given you access:

1. Add the bot account as a collaborator on your repo (Read is enough on public repos; for orgs, making it an org member covers everything).
2. Optionally commit `.zanuda.yml` to your org's `.github` repo for org-wide defaults, or to individual repos to override them.
3. Open a PR and request a review from the bot. That's it.

**Want reviews requested automatically on every PR?** Pick one:
- **CODEOWNERS** — add `* @YourBotAccount` to `.github/CODEOWNERS`. GitHub requests a review on every opened PR automatically.
- **GitHub Actions** — copy `deploy/auto-review.yml.example` to `.github/workflows/zanuda-review.yml`. Skips drafts; triggers when a PR is marked ready for review.

---

## Self-hosting

### 1. Bot account

Create a dedicated GitHub account and a Personal Access Token — classic with `repo` scope, or fine-grained with *Pull requests* read/write and *Contents* read on the target repos.

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
  -v zanuda-data:/root/.zanuda \
  zanuda
```

**Node directly:**

```bash
npm ci && npm run build && npm start
```

Both work. Docker is self-contained; Node is simpler if you're already on the machine.

### 5. Long-running in production (optional)

If you want the bot to survive reboots and restart on failure, use a process
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

Settings merge in order — each layer overrides only what it sets:

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

Free-form markdown injected into every review as reviewer guidelines. Use it to tell Zanuda what matters for your specific codebase — naming conventions, invariants, things to always flag, things to ignore.

This repo ships its own `.zanuda/instructions.md` as a working example. Copy it and adapt to your project.

Committed to the base branch only — PR authors cannot influence it.

---

## Manual reviews

```bash
npm run review -- owner/repo#123            # post the review
npm run review -- owner/repo#123 --dry-run  # print JSON, don't post
npm run review -- owner/repo#123 --round=2  # run as round 2
```

## Models

| Provider     | Env var              | Notes                               |
| ------------ | -------------------- | ------------------------------------|
| `anthropic`  | `ANTHROPIC_API_KEY`  | Claude                              |
| `openai`     | `OPENAI_API_KEY`     | GPT and compatible                  |
| `openrouter` | `OPENROUTER_API_KEY` | 200+ models                         |
| `ollama`     | —                    | Local; set `OLLAMA_BASE_URL`        |

## Tests

```bash
npm test
```

## Contributing

Bug reports and pull requests are welcome. A few things to know before you start:

- **Open an issue first** for anything beyond a small fix. It avoids wasted effort if the direction isn't a fit.
- **Tests are required.** New behaviour needs tests; bug fixes should include a regression test. Run `npm test` and `npm run typecheck` before submitting.
- **Security issues** — please don't open a public issue. Email the maintainers directly instead.

This project is MIT licensed. By contributing you agree your work will be distributed under the same terms.
