# Setup — bootstrap kbexplorer in a repository

How to install kbexplorer in a new or existing repository. The agent runs every
step except for the configuration wizard responses.

## Decide the mode first

| Mode | When | How |
|---|---|---|
| **Self-hosted** | This repo IS the kbexplorer template (its `package.json` name is `kbexplorer`) | Skip the submodule step; run the init wizard directly. |
| **Submodule** | Any other repo | Add `kbexplorer` as a git submodule at `.kbexplorer/`. This is the most common case. |

Detect self-hosted mode with:

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf-8')).name)"
```

## Submodule install — full sequence

```bash
# 1. Install the CLI globally or as a devDependency
npm install -D @anokye-labs/kbexplorer

# 2. Run the interactive init — this does ALL of:
#    - add the .kbexplorer submodule (pinned to the latest release tag)
#    - copy agents to .github/agents/
#    - copy the skill to .github/skills/kbexplorer/
#    - ask config questions (owner, repo, branch, title, content mode, visuals, theme)
#    - write .env.kbexplorer
#    - update .gitignore
#    - add kb:dev / kb:build / kb:generate npm scripts
#    - run npm install inside .kbexplorer/
npx kbexplorer init
```

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

Inside the kbexplorer repo itself:

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
npx kbexplorer dev            # starts the dev server on http://localhost:5173
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
| `.kbexplorer/` | Submodule containing the explorer app (pinned to a release tag). |
| `.github/agents/kb-architect.md` | Repo → catalogue JSON architect agent. |
| `.github/agents/kb-writer.md` | Per-page content writer. |
| `.github/agents/kb-researcher.md` | Deep code investigator. |
| `.github/skills/kbexplorer/SKILL.md` | Routing skill (loads references on demand). |
| `.github/skills/kbexplorer/references/` | All the lifecycle playbooks (this folder). |
| `.env.kbexplorer` | Vite env vars; gitignored. |
| `package.json` | New scripts: `kb:dev`, `kb:build`, `kb:generate`. |

The agents are still installed even in environments that don't support agents
— their behavior is mirrored by the `*-playbook.md` references so any LLM can
follow the same procedure directly.

## After install — what next

- "I want to create content from scratch" → `architect-playbook.md`
- "I want to add a single page" → `add-node.md`
- "I want to check what's there" → run `kbexplorer audit && kbexplorer links`
- "I want to change how it looks" → `presentation.md`

## Common install gotchas

| Symptom | Fix |
|---|---|
| `git submodule add` fails with "already exists" | The submodule is already there — re-run init; it will skip the add step. |
| `npm install --no-audit --no-fund` fails inside `.kbexplorer/` | Run it manually: `cd .kbexplorer && npm install`. |
| Init succeeds but `kb:dev` says "command not found" | Run `npx kbexplorer dev` directly, or re-add the scripts. |
| GitHub rate-limit errors at runtime | Set `GITHUB_TOKEN` in the environment; the explorer uses 5000 req/h with auth, 60/h without. |
| Empty graph in browser | Verify `.env.kbexplorer` has the right owner/repo and the repo has issues/PRs/content. |
