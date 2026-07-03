# Agent guidance for kbexplorer-cli

## What this repository contains
- This repo is the kbexplorer CLI package, not the visual explorer app.
- The CLI entry points live under `src/commands/`; shared logic lives under `src/lib/` and `src/mcp/`.
- Authored knowledge lives under `content/`; derived artifacts under `content/derived/`.
- Tests live under `tests/`.

## Working conventions
- Keep changes scoped to the issue in hand and avoid unrelated refactors.
- Prefer small, deterministic changes that preserve existing command behavior.
- When you change CLI behavior, update or add tests under `tests/`.
- Follow the repo's issue-first workflow: reference the issue in commits and PRs.
- Use conventional commit messages and keep commits focused.

## Common verification commands
- `npm test`
- `node --check src/commands/sync.js src/commands/affected.js`
- `grep -rn "function normalizeGraph" src/`

## Repo layout notes
- `src/commands/` contains the user-facing CLI commands.
- `src/lib/` contains reusable helpers and preflight logic.
- `src/mcp/` contains the local MCP server implementation.
- `content/` is the source of truth for authored KB pages.
