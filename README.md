# kbexplorer

CLI tool for the [kbexplorer](https://github.com/anokye-labs/kbexplorer) interactive knowledge base — turn any GitHub repository into a navigable knowledge graph.

## Install

```bash
# Use directly
npx @anokye-labs/kbexplorer init

# Or install as dev dependency
npm install -D @anokye-labs/kbexplorer
```

## Commands

| Command | Description |
|---------|-------------|
| `kbexplorer init` | Add `.kbexplorer/` submodule, install agents/skills, configure |
| `kbexplorer generate` | Run content generation pipeline (architect → transform → writer) |
| `kbexplorer dev` | Start dev server in local mode |
| `kbexplorer build` | Production build |
| `kbexplorer manifest` | Regenerate repo manifest from local data |
| `kbexplorer update` | Pull latest template + refresh agents/skills |

## Quick Start

```bash
# In any GitHub repo:
npx kbexplorer init    # Interactive setup wizard
npx kbexplorer dev     # Launch the explorer
```

## What `init` Does

1. Adds `.kbexplorer/` as a git submodule (the visual explorer app)
2. Installs agents to `.github/agents/` (kb-architect, kb-writer, kb-researcher)
3. Installs skills to `.github/skills/kbexplorer/`
4. Runs interactive config wizard (content mode, title, theme, etc.)
5. Creates `.env.kbexplorer` and adds npm scripts

## Content Generation

Generate rich documentation from code analysis:

```bash
# In Copilot CLI, ask the kb-architect agent to analyze the repo
# It produces catalogue.json, then:
npx kbexplorer generate
```

Or use the full pipeline in Copilot CLI — the kb-architect, kb-writer, and kb-researcher agents are installed in your repo's `.github/agents/`.

## Agents

| Agent | Description |
|-------|-------------|
| `kb-architect` | Scans repo → structured catalogue with clusters, connections, Fluent icons |
| `kb-writer` | Generates rich content pages with citations, Mermaid diagrams |
| `kb-researcher` | Deep investigation with evidence-first analysis |

Adapted from [microsoft/skills deep-wiki](https://github.com/microsoft/skills/tree/main/.github/plugins/deep-wiki) (MIT License).

## License

MIT
