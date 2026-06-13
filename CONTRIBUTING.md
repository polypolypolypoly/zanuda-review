# Contributing to Zanuda the Reviewer

Bug reports, fixes, and new features are welcome. Read this before opening a PR.

## Quick start

```bash
git clone https://github.com/polypolypolypoly/zanuda-review
cd zanuda-review
npm ci
cp .env.example .env   # fill in at minimum GITHUB_TOKEN + one LLM key
npm run build
npm test
```

## Ground rules

- **Open an issue first** for anything beyond a small fix. It avoids wasted effort if the direction isn't a fit.
- **Tests are required.** New behaviour needs tests; bug fixes should include a regression test.
- **All checks must pass** before a PR can merge: `npm run lint && npm run format:check && npm run typecheck && npm test`
- **Security issues** — do not open a public issue. Email the maintainers directly.

---

## Adding a new platform connector

This is the most impactful contribution you can make. The GitHub integration is
one implementation of `SCMConnector` — adding GitLab, Bitbucket, Gitea, or any
other platform follows the same pattern.

### How the abstraction works

```
SCMConnector (src/platform/types.ts)
├── GitHubConnector  (src/platform/github/connector.ts)  ← reference impl
└── YourConnector    (src/platform/<name>/connector.ts)  ← you build this
```

The review engine, LLM layer, prompt builder, config system, memory, and state
store all depend only on `SCMConnector` — they have zero knowledge of GitHub,
GitLab, or anything else. You only implement the interface; everything else
works for free.

### Step-by-step

**1. Copy the stub**

```bash
cp src/platform/stub/connector.ts src/platform/<name>/connector.ts
```

The stub is a fully annotated skeleton. Every method has:
- A description of what it must do
- The exact GitHub API call we use (for reference)
- The GitLab / Bitbucket equivalent where known
- Notes on edge cases

**2. Implement the 8 methods**

| Method | What it does |
|---|---|
| `getBotLogin()` | Return the reviewer account's username |
| `pollPendingReviews(botLogin)` | Return open PRs/MRs where the reviewer is requested |
| `fetchPR(ref, number)` | Fetch diff, files, title, body, base/head refs |
| `readFile(ref, path, gitRef)` | Read one file at a given git ref (null if 404) |
| `getFileTree(ref, gitRef, maxEntries)` | List all file paths in the repo |
| `fetchDiscussion(ref, number)` | Fetch all comments (inline + general) |
| `postReview(pr, result, config)` | Post verdict + inline comments |
| `postComment(ref, number, body)` | Post a plain PR comment; returns comment ID |
| `editComment(ref, commentId, body)` | Edit an existing comment by ID |
| `replyToComment(ref, number, comment, body)` | Reply to a specific comment |

Read `src/platform/types.ts` for the full type contracts and `src/platform/github/connector.ts` as a working reference.

**3. Register in the factory**

Open `src/platform/index.ts` and add your platform:

```typescript
case "gitlab":
  return new GitLabConnector({ token: requireEnv("GITLAB_TOKEN") });
```

**4. Add env vars to `.env.example`**

Document any new env vars under the `── Platform ──` section:

```bash
# GitLab (when PLATFORM=gitlab)
GITLAB_TOKEN=
GITLAB_BASE_URL=https://gitlab.com  # optional, for self-hosted
```

**5. Write tests**

Add `test/<name>Connector.test.ts`. See `test/githubConnector.test.ts` for
the pattern — mock the HTTP layer, test each method independently.

**6. Open a PR**

Title format: `feat: <Name> connector`

Include in the PR description:
- Which platform and API version you targeted
- Any platform-specific limitations or known gaps
- How you tested it (self-hosted instance, mocked, etc.)

### Key invariants to preserve

These are not optional — they exist for security and correctness reasons:

- **Always read config and context from `pr.baseSha`**, never `pr.headSha`. The base branch is maintainer-controlled; the PR head is not.
- **Return `null` on 404** from `readFile`, throw on other errors.
- **`platformId` must be stable and globally unique** across all repos for the lifetime of a PR. It is used as the key for round counting and mention tracking.
- **`postReview` must not silently drop feedback.** If inline comment anchoring fails, fall back to a summary comment.

---

## Running tests

```bash
npm test                  # all tests
npm run typecheck         # tsc on both src/ and test/
npm run lint              # eslint
npm run format:check      # prettier
```

## Manual review (without a running service)

```bash
npm run review -- owner/repo#123 --dry-run   # print JSON, post nothing
npm run review -- owner/repo#123             # post the review
```
