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

Open <http://localhost:5173>. You should see a graph of 27 nodes covering
the CLI router, every command, the lib/ heart, the agents, the skill,
install modes, the zero-dependency design, and the **derivation & contract**
subsystem (the `derive` command, the programmatic-mode runtime, and the engine
node-type contract).

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
# Pass the SAME source files you derived from — never the .jsonld outputs.
# Never calls the LLM — purely deterministic.
npx kbexplorer derive docs/*.docx --check

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

These fields are exactly the **engine node-type contract** published by the
template (Epic 1 / F1 — see
[kbexplorer-template#148](https://github.com/anokye-labs/kbexplorer-template/issues/148)).
The engine renders a `structured` node by resolving its `entityType` against an
open node-type registry: spine kinds such as `person`, `squad`, `workstream`,
`mission`, `priority`, `cycle`, and `org` get bespoke viewers, and any other
`@type` falls back to a generic structured view — so a derived artifact always
renders without core edits. A worked end-to-end example (a `.docx` sentence →
`kg://person/…` + a `leads` edge → a rendered node) lives in the dogfood KB at
[`content/node-type-contract.md`](content/node-type-contract.md).

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

## Runtime Configuration

kbexplorer supports three agent runtimes for fuzzy (LLM) steps: **copilot**
(default), **claude**, and **custom** (any CLI). The active runtime is resolved
using the following precedence, from highest to lowest:

| Priority | Source | How |
|----------|--------|-----|
| 1 | `--runtime <name>` flag | `kbexplorer derive --runtime claude` |
| 2 | `runtime` block in `.kbexplorer.json` | Set once; travels with the repo |
| 3 | `KBEXPLORER_RUNTIME` env var | `KBEXPLORER_RUNTIME=claude kbexplorer derive …` |
| 4 | Default | `copilot` |

### Repo-local config (`.kbexplorer.json`)

Add a `runtime` block alongside the existing template-source fields:

```jsonc
{
  "template": "https://github.com/anokye-labs/kbexplorer-template.git",
  "mode": "submodule",
  // …
  "runtime": {
    "agent": "copilot"   // "copilot" | "claude" | "custom"
  }
}
```

For `claude`:
```json
{
  "runtime": { "agent": "claude" }
}
```

For a **custom** CLI (must include `{prompt}` placeholder):
```json
{
  "runtime": {
    "agent": "custom",
    "command": "my-agent",
    "argsTemplate": ["-p", "{prompt}", "--json"],
    "outputFormat": "jsonl",
    "timeoutMs": 600000
  }
}
```

`kbexplorer init` offers a runtime selection step during interactive setup and
can write this block automatically.

### MCP server requirements

Fuzzy tasks often depend on local MCP servers. Declare them in the `runtime`
block so the CLI verifies they are configured **before** any LLM call or
partial write:

```jsonc
{
  "runtime": {
    "agent": "copilot",
    "mcp": {
      "required": ["ado", "sharepoint-docs"],   // preflight fails if missing
      "optional": ["org-chart"]                  // warning only, never fails
    }
  }
}
```

On failure the CLI prints the missing server name, the config file it expected
it in, and a one-line example entry, then exits non-zero. Optional servers that
are absent produce a warning instead.

#### Detection locations per adapter

| Adapter | Files checked (in order) |
|---------|--------------------------|
| `copilot` | `~/.copilot/mcp-config.json` (the file Copilot CLI reads; it has no repo-local MCP config today) |
| `claude` | `<repo>/.mcp.json` → `~/.claude.json` (project entries matching cwd) |
| `custom` | Detection not possible — all declared servers reported as unverifiable (warning, not failure) |

#### Config file shape

Both adapters' files use the same entry shape (`~/.copilot/mcp-config.json`
for copilot, `.mcp.json` for claude):

```json
{ "mcpServers": { "ado": { "command": "npx", "args": ["-y", "ado-mcp"] } } }
```

#### `--skip-preflight`

Development escape hatch. Bypasses the MCP check with a warning — never use
in CI.

```bash
kbexplorer derive docs/org.docx --skip-preflight
kbexplorer generate --skip-preflight
```

### Binary path overrides

The named adapters honour existing env vars for binary paths:

| Env var | Purpose |
|---------|---------|
| `KBEXPLORER_COPILOT_BIN` | Full path to the `copilot` binary |
| `KBEXPLORER_CLAUDE_BIN` | Full path to the `claude` binary |

These work alongside (not instead of) the runtime selection above.

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
