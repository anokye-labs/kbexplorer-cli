# Contributing

Thank you for your interest in contributing to this project.

## Getting Started

1. **File an issue first.** Every change must trace back to a GitHub Issue. Use the appropriate issue type (Epic, Feature, Task, or Bug).
2. **Create a branch.** Work on a feature branch — never commit directly to the default branch.
3. **Open a pull request.** Reference the issue in your PR description.
4. **Resolve all conversations.** All review comments must be resolved before merging.

## Issue Types

| Type | Use When |
|------|----------|
| Epic | Large initiatives spanning multiple features |
| Feature | User-facing capabilities or system components |
| Task | Concrete, actionable work items |
| Bug | Defects and fixes |

Issue types are set via the GitHub Issue Type field, not labels or title prefixes.

## Development Workflow

1. Clone the repository and create a feature branch
2. Make your changes following existing code conventions
3. Run the build and tests locally before pushing
4. Open a PR and ensure CI passes
5. Address any review feedback

## Local development and dogfooding

This repo is the CLI package for the kbexplorer explorer template. The explorer itself is installed into `.kbx/` during setup, so `kbx dev` only works once `.kbx/` exists.

### Running the site locally

Requirements: Node >= 22 and network access for the one-time template setup.

```bash
# 1. Pull latest
git pull

# 2. One-time setup — only if .kbx/ is absent
npx kbx init --vendor

# 3. Launch the dev server (opens http://localhost:5173)
npx kbx dev
```

`init --vendor` is interactive, but the prompts are pre-filled from your git remote and branch; pressing Enter accepts the defaults. It vendors a one-time copy of the template into `.kbx/`, runs `npm install` there, and writes `.env.kbx`.

### Dogfooding the CLI on this repo

This checkout is its own test bed: the authored pages under `content/` describe the CLI, and the dev server renders them. The main content lifecycle commands are:

```bash
npx kbx generate
npx kbx scaffold <slug> --cluster <id>
npx kbx derive <source...>
npx kbx affected <git-ref>
npx kbx audit
npx kbx links
npx kbx manifest
npx kbx update
```

For local verification of the CLI itself, run:

```bash
npm test
node bin/cli.js --help
node bin/cli.js audit
node bin/cli.js generate --dry-run
node bin/cli.js derive docs/samples/platform-squad.md --check
```

### Testing and verification

The deterministic verification commands for this issue are:

```bash
npm test
node --check src/commands/sync.js src/commands/affected.js
grep -rn "function normalizeGraph" src/
```

## Code Style

This project uses automated formatting and linting. Check for `.editorconfig`, `ruff.toml`, `.prettierrc.json`, or similar configuration files and ensure your changes conform.

## Branch Protection

The default branch has protection rules enforced:
- Direct pushes are blocked
- All PR conversations must be resolved before merging
- Force pushes and branch deletion are blocked