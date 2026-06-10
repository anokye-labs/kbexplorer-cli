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

## Dogfood: build a KB over this repo

The `scripts/` folder contains a self-hosting demo that uses kbexplorer's own
lifecycle commands to render a knowledge base about kbexplorer-cli itself.
The authored content lives in [`content/`](content/) and is validated by
`node bin/cli.js audit` (78 unit tests + 0 audit errors on every commit).

```bash
node scripts/preview-self-kb.js    # vendors .kbexplorer/, syncs content/, starts dev
node scripts/verify-self-kb.js     # Playwright check; screenshots → dist-screenshots/
```

Open <http://localhost:5173>. You should see a graph of 23 nodes covering the
CLI router, every command, the lib/ heart, the agents, the skill, install
modes, and the zero-dependency design — the same content model the template
demo uses, but authored entirely from this repo's source.

## What `init` Does

1. Adds `.kbexplorer/` as a git submodule (the visual explorer app)
2. Installs agents to `.github/agents/` (kb-architect, kb-writer, kb-researcher)
3. Installs skills to `.github/skills/kbexplorer/`
4. Runs interactive config wizard (content mode, title, theme, etc.)
5. Creates `.env.kbexplorer` and adds npm scripts

## Using a Custom Template

By default `init` installs the official `anokye-labs/kbexplorer-template`. To use your own
fork or an org-internal template, pass `--template`:

```bash
npx kbexplorer init --template https://github.com/my-org/my-template.git
```

### Install modes

| Mode | Flag | What you get |
|------|------|--------------|
| **Submodule** (default) | _(none)_ | `.kbexplorer/` is a pinned git submodule. Lightweight; `kbexplorer update` bumps the pin. Best when you track upstream as-is. |
| **Vendor** (one-time copy) | `--vendor` / `--no-submodule` | `.kbexplorer/` is a plain folder (the template's `.git` is stripped). Best when you want to copy-and-customize. |

```bash
# Pin to a specific tag or branch (default: latest release tag)
npx kbexplorer init --ref v1.2.0
npx kbexplorer init --vendor --ref main
```

Both modes record where the template came from in **`.kbexplorer.json`** at your repo root:

```json
{ "template": "<url>", "ref": "v1.2.0", "refType": "tag", "resolvedCommit": "…", "mode": "submodule" }
```

`kbexplorer update` reads this record. For vendored installs it never overwrites your
`.kbexplorer/` silently — it fetches the new version into a sibling folder for review, and
`--force` backs up your current copy before swapping it in.

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
