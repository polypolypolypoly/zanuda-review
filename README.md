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

---

## Self-hosting

### 1. Bot account

Create a dedicated GitHub account and a Personal Access Token — classic with `repo` scope, or fine-grained with *Pull requests* read/write and *Contents* read on the target repos.

### 2. Secrets

```bash
cp .env.example .env
# Set GITHUB_TOKEN, GITHUB_BOT_LOGIN, and your LLM provider key
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

```bash
npm ci && npm run build && npm start
```

### 5. Systemd

```bash
cp deploy/zanuda.service.example /etc/systemd/system/zanuda.service
# Edit the file — fill in <PLACEHOLDERS>
sudo systemctl daemon-reload && sudo systemctl enable --now zanuda
journalctl -u zanuda -f
```

### 6. CI/CD

`.github/workflows/deploy.yml` has a self-hosted runner example. Set `SERVICE_USER`, `REPO_PATH`, and `SERVICE_NAME` at the top of the deploy job.

### 7. Adding users

To give a user or org access: add their slug to `access.allowlist` in your local config and restart. Have them follow the hosted-instance steps above.

---

## Configuration

Settings merge in order — each layer overrides only what it sets:

```
config/default.yaml  →  {owner}/.github/.zanuda.yml  →  repo-root/.zanuda.yml
```

The org config (`.github` repo) is good for shared provider/model/rules across all repos in an org. Per-repo config overrides just what it needs to.

```yaml
# .zanuda.yml example
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
