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
| `kbexplorer derive <source...>` | Extract JSON-LD entities from unstructured sources (.docx/.md/.txt) via Copilot |
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

The authored content in [`content/`](content/) describes kbexplorer-cli
itself. Once the explorer is installed (`init`), `dev` will render it:

```bash
npx kbexplorer init --vendor   # one-time: vendors the explorer into .kbexplorer/
npx kbexplorer dev             # build the manifest, start Vite at :5173
```

Open <http://localhost:5173>. You should see a graph of 23 nodes covering
the CLI router, every command, the lib/ heart, the agents, the skill,
install modes, and the zero-dependency design.

To regression-check the dogfood loop end-to-end:

```bash
node scripts/verify-self-kb.js   # headless Playwright; screenshots → dist-screenshots/
```

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

`kbexplorer generate` runs the content pipeline on top of **Copilot CLI
programmatic mode** (`copilot -p`). When there is no `catalogue.json` (or you
pass `--refresh`), it drives Copilot to analyze the repo and emit one, then
deterministically transforms it into `content/` and regenerates the manifest:

```bash
# Drives `copilot -p` (kb-architect) → catalogue.json → content/ → manifest
npx kbexplorer generate

# Preview the exact copilot command without running it
npx kbexplorer generate --dry-run

# Scope tool permissions instead of the default --allow-all-tools
npx kbexplorer generate --allow-tool 'shell(git)' --allow-tool 'write'

# Re-run analysis even if catalogue.json already exists
npx kbexplorer generate --refresh

# Skip the agent step and just transform an existing catalogue
npx kbexplorer generate --no-agent
```

Requires the [Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
on your `PATH` (or set `KBEXPLORER_COPILOT_BIN` to its full path). The fuzzy
(LLM) and deterministic (transform/manifest) phases both flow through a single
**runtime router** — see [`docs/copilot-runtime.md`](docs/copilot-runtime.md)
for the adapter's public API and configuration.

You can still produce `catalogue.json` out-of-band (e.g. via the kb-architect
agent in an interactive Copilot session) and run `kbexplorer generate --no-agent`.

## Build-time Derivation (unstructured → JSON-LD)

`kbexplorer derive` turns **unstructured / semi-structured** sources — `.docx`,
prose Markdown, and loosely-structured text — into committed `*.jsonld` entity
artifacts that conform to the engine's node-type contract. It mirrors
`generate`: a fuzzy (LLM) phase runs through **Copilot programmatic mode**
(`copilot -p`) to extract entities and relationships, then a deterministic phase
normalizes and validates them into canonical JSON-LD.

```bash
# Read .docx/.md/.txt, extract via `copilot -p`, emit content/derived/*.jsonld
npx kbexplorer derive docs/org-chart.docx notes/teams.md

# Preview the exact copilot command + planned outputs without running anything
npx kbexplorer derive docs/org-chart.docx --dry-run

# Write to a custom output directory
npx kbexplorer derive docs/*.docx --out content/derived

# CI drift gate: fail (non-zero exit) if any committed artifact is stale.
# Never calls the LLM — purely deterministic.
npx kbexplorer derive content/derived/*.jsonld --check

# Force re-extraction even when a fresh artifact already exists
npx kbexplorer derive docs/org-chart.docx --refresh
```

Each emitted node carries the F1 contract fields: an `@id` identity URN
(`kg://<type>/<slug>`, reused as identity and **never** derived from a file
path), an open lowercase `@type` entity kind (also never path-derived), a
`@context` (defaults to `https://schema.org`), and relationships mapped onto the
six-relation taxonomy `leads | staffs | reports-to | structural | derived |
deprecated`. The committed artifact also embeds a KBNode mirror (`entityType` +
`jsonld` + `data`) and a reversible `source.ref` back to the originating
document.

**Idempotency & drift.** Artifacts are timestamp-free and serialized with sorted
keys, so identical input yields **byte-identical** output. The artifact embeds
the extraction intermediate keyed by the source's SHA-256; re-running `derive`
on an unchanged source reuses that intermediate and re-emits deterministically
**without calling the LLM**. `--check` is a read-only CI gate: it reports drift
(and exits non-zero) when an artifact is missing, when its source has changed, or
when a fresh deterministic emit differs from the committed bytes — never invoking
Copilot.

Like `generate`, the fuzzy phase requires the
[Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) on your
`PATH` (or `KBEXPLORER_COPILOT_BIN`); sources already derived from unchanged
input do not need it. Both phases flow through the same **runtime router** — see
[`docs/copilot-runtime.md`](docs/copilot-runtime.md).

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
