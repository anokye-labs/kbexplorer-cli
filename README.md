# kbexplorer

CLI tool for the [kbexplorer-template](https://github.com/anokye-labs/kbexplorer-template) interactive knowledge base — turn any GitHub repository into a navigable knowledge graph.

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
| `kbexplorer scaffold <slug> --cluster <id>` | Create a single new content page with valid frontmatter |
| `kbexplorer audit` | Schema/structural validation (duplicate ids, broken parents, cycles) — CI-grade |
| `kbexplorer affected <git-ref>` | Map a git diff to impacted content nodes via citations |
| `kbexplorer links` | Graph health report (orphans, weak clusters, coverage gaps) |
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

For environments without agent support, each agent has an equivalent
step-by-step playbook in
`.github/skills/kbexplorer/references/{architect,writer,researcher}-playbook.md`
that any LLM can follow directly.

Adapted from [microsoft/skills deep-wiki](https://github.com/microsoft/skills/tree/main/.github/plugins/deep-wiki) (MIT License).

## Skill — full lifecycle

`kbexplorer init` installs the `kbexplorer` skill at
`.github/skills/kbexplorer/`. It is a single skill with a slim router and a
library of focused references loaded on demand:

| Reference | Covers |
|---|---|
| `setup.md` | Bootstrap in a new repo |
| `frontmatter.md` | Full schema for content files |
| `add-node.md` | Add a single page |
| `update-node.md` | Refresh one page preserving author intent |
| `incremental-refresh.md` | Diff-driven multi-page refresh |
| `graph-curation.md` | Rename / move / merge / split nodes; recolor clusters |
| `connections.md` | Edge derivation rules and good descriptions |
| `audit.md` | Hard structural lint rules and remediation |
| `presentation.md` | Visual mode, theme, fonts, HUD |
| `assets-pipeline.md` | Sprite and hero image workflows |
| `architect-playbook.md` | Build a catalogue without an agent runtime |
| `writer-playbook.md` | Author one page deeply without an agent runtime |
| `researcher-playbook.md` | Systematic codebase investigation |
| `configuration.md` | `config.yaml` reference |
| `content-generation.md` | Pipeline + catalogue → node mapping |

## License

MIT
