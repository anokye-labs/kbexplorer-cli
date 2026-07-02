# Setup — bootstrap kbx in a repository

How to install kbx in a new or existing repository. The agent runs every
step except for the configuration wizard responses.

## Decide the mode first

| Mode | When | How |
|---|---|---|
| **Self-hosted** | This repo IS the kbx template (its `package.json` name is `kbx`) | Skip the submodule step; run the init wizard directly. |
| **Submodule** | Any other repo | Add `kbx` as a git submodule at `.kbx/`. This is the most common case. |

Detect self-hosted mode with:

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf-8')).name)"
```

## Submodule install — full sequence

```bash
# 1. Install the CLI globally or as a devDependency
npm install -D @anokye-labs/kbx

# 2. Run the interactive init — this does ALL of:
#    - add the .kbx submodule (pinned to the latest release tag)
#    - copy agents to .github/agents/
#    - copy the skill to .github/skills/kbx/
#    - ask config questions (owner, repo, branch, title, content mode, visuals, theme)
#    - write .env.kbx
#    - write .kbx.json (records template source / ref / mode for `update`)
#    - update .gitignore
#    - add kb:dev / kb:build / kb:generate npm scripts
#    - run npm install inside .kbx/
npx kbx init
```

## Custom templates and install modes

`init` defaults to installing the official template as a git submodule, but
supports alternatives:

| Flag | Effect |
|---|---|
| `--template <url>` | Install from a fork or org-internal template repo. |
| `--ref <tag\|branch>` | Pin to a specific version. Default: latest release tag. |
| `--vendor` (alias `--no-submodule`) | One-time copy instead of a submodule. The template's `.git` is stripped and the files become yours — best for "copy and customize". |

```bash
# install a custom template as a submodule
npx kbx init --template https://github.com/my-org/my-template.git

# one-time vendored copy of main
npx kbx init --vendor --ref main

# pin to a release tag
npx kbx init --ref v1.2.0
```

The install source (url, ref, refType, resolvedCommit, mode) is recorded in
`.kbx.json` at the repo root and is what `kbx update` reads.
For vendored installs `update` never clobbers local changes: it fetches the
new version into a sibling review folder, and `--force` backs the current
copy up to `.kbx.backup-<ts>` before swapping.

What the user answers (everything else is auto-detected):

| Question | Default | Notes |
|---|---|---|
| GitHub owner | from `git remote get-url origin` | Required even for local-only use; just needs to be plausible. |
| GitHub repo | from `git remote get-url origin` | Same. |
| Branch | from `git rev-parse --abbrev-ref HEAD` | The branch the explorer will read content from. |
| Knowledge base title | `<repo> Knowledge Base` | Display title in the header. |
| Content mode | Repo-aware | See `content-generation.md` for the difference. |
| Visual mode | `emoji` | See `presentation.md`. |
| Default theme | `dark` | See `presentation.md`. |

## Self-hosted install

Inside the kbx repo itself:

```bash
node scripts/init.js          # wizard only
npm run dev                   # agent runs this
# then validate with playwright-cli (see below)
```

No submodule, no agent copy — the assets already live in the same repo.

## Validation (mandatory)

After init succeeds, you MUST verify the explorer actually loads. Failure to
validate is the most common cause of false "done" claims.

```bash
npx kbx dev            # starts the dev server on http://localhost:5173
```

Then, in order of preference:

1. **Playwright CLI skill** — navigate to the URL, take a screenshot, evaluate
   that the page shows cards/graph/titles and no blank screen or error banner.
2. **Computer-use MCP** — same idea, GUI-level.
3. **Fallback** — open `http://localhost:5173` in the user's default browser
   (`Start-Process` on Windows, `open` on macOS, `xdg-open` on Linux) and ask
   the user to confirm.

Never report success without one of these checks.

## What got installed

| Path | Purpose |
|---|---|
| `.kbx/` | Submodule OR vendored copy of the explorer app (pinned to a release tag). |
| `.kbx.json` | Records the install source — `{template, ref, refType, resolvedCommit, mode}` — read by `update`. |
| `.github/agents/kb-architect.md` | Repo → catalogue JSON architect agent. |
| `.github/agents/kb-writer.md` | Per-page content writer. |
| `.github/agents/kb-researcher.md` | Deep code investigator. |
| `.github/skills/kbx/SKILL.md` | Routing skill (loads references on demand). |
| `.github/skills/kbx/references/` | All the lifecycle playbooks (this folder). |
| `.env.kbx` | Vite env vars; gitignored. |
| `package.json` | New scripts: `kb:dev`, `kb:build`, `kb:generate`. |

The agents are still installed even in environments that don't support agents
— their behavior is mirrored by the `*-playbook.md` references so any LLM can
follow the same procedure directly.

## After install — what next

- "I want to create content from scratch" → `architect-playbook.md`
- "I want to add a single page" → `add-node.md`
- "I want to check what's there" → run `kbx audit && kbx links`
- "I want to change how it looks" → `presentation.md`

## Common install gotchas

| Symptom | Fix |
|---|---|
| `git submodule add` fails with "already exists" | The submodule is already there — re-run init; it will skip the add step. |
| `npm install --no-audit --no-fund` fails inside `.kbx/` | Run it manually: `cd .kbx && npm install`. |
| Init succeeds but `kb:dev` says "command not found" | Run `npx kbx dev` directly, or re-add the scripts. |
| GitHub rate-limit errors at runtime | Set `GITHUB_TOKEN` in the environment; the explorer uses 5000 req/h with auth, 60/h without. |
| Empty graph in browser | Verify `.env.kbx` has the right owner/repo and the repo has issues/PRs/content. |

