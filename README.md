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
| `kbexplorer doctor` | Diagnose local runtime, MCP, and template setup |

## Quick Start

```bash
# In any GitHub repo:
npx kbexplorer init    # Interactive setup wizard
npx kbexplorer dev     # Launch the explorer
```

For a full enterprise deployment walkthrough — prerequisites, work-graph YAML
authoring, the local regeneration loop, and hosting options — see
**[docs/deploy-to-a-work-repo.md](docs/deploy-to-a-work-repo.md)**.

Copy-paste YAML starters for the five organizational-layer descriptor kinds are in
**[docs/templates/](docs/templates/)**.

## Dogfood: build a KB over this repo

The authored content in [`content/`](content/) describes kbexplorer-cli
itself. Once the explorer is installed (`init`), `dev` will render it:

```bash
npx kbexplorer init --vendor   # one-time: vendors the explorer into .kbexplorer/
npx kbexplorer dev             # build the manifest, start Vite at :5173
```

Open <http://localhost:5173>. You should see a graph of 28 nodes covering
the CLI router, every command, the lib/ heart, the agents, the skill,
install modes, the dependency philosophy, and the **derivation & contract**
subsystem (the `derive` command, the programmatic-mode runtime, and the engine
node-type contract).

To regression-check the dogfood loop end-to-end:

```bash
node scripts/verify-self-kb.js   # headless Playwright; screenshots → dist-screenshots/
```

## Dogfood: query this repo's KB over MCP

`kbexplorer mcp` starts a stdio [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes this repo's dogfood KB to any MCP host. It serves five tools —
`kb_query`, `kb_get_node`, `kb_neighbors`, `kb_graph_stats`, and `kb_ask` — uses
MCP **roots** to scope which clusters are in context, and answers `kb_ask` through
the host's own model via MCP **sampling** (degrading to a grounded-context answer
when the host has no sampling). The full tool/contract reference is in
**[docs/mcp-server.md](docs/mcp-server.md)**.

Verify it end-to-end with no model required — a built-in harness plays the host
and answers the sampling round-trip:

```bash
npm run mcp:smoke
```

Or wire it into the GitHub Copilot CLI with the checked-in
[`examples/copilot-mcp-config.json`](examples/copilot-mcp-config.json) (it points at
`node bin/cli.js mcp`) and ask a question against the live host:

```bash
copilot -p "Use the kbexplorer MCP server: call kb_graph_stats, then kb_query for 'mcp server'." \
  --additional-mcp-config @examples/copilot-mcp-config.json --allow-all-tools
```

> The `@` prefix tells Copilot CLI to load the JSON from a file rather than parse
> it inline. `kb_ask` performs a real sampling round-trip only when the host
> advertises MCP sampling. Copilot CLI advertises it in **interactive** sessions
> (gated by a user-approval prompt); the non-interactive `copilot -p` path used
> above does **not**, so `kb_ask` there falls back to a grounded-context answer.

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

## GitHub API Base Configuration

By default the CLI fetches GitHub data (issues, PRs, releases) via the `gh` CLI — behaviour identical to previous releases. You can override this to point the CLI at a **Gitea DTU adapter** (for hermetic testing) or a **GitHub Enterprise / EMU host** (real deployment).

### Precedence

| Priority | Source | How |
|----------|--------|-----|
| 1 | `ghApiBase` in `.kbexplorer.json` | Set once; travels with the repo |
| 2 | `KBEXPLORER_GH_API_BASE` env var | Runtime override |
| 3 | Default | `gh` CLI (github.com) |

### Gitea DTU adapter (hermetic testing)

When the DTU adapter is running on `TWIN_PORT` (default 3456), point the CLI at it:

```bash
KBEXPLORER_GH_API_BASE=http://localhost:3456 \
KBEXPLORER_GH_TOKEN=<gitea-token> \
kbexplorer manifest
```

The adapter translates GitHub REST v3 requests to the Gitea API — the CLI needs no other changes.

### GitHub Enterprise / EMU

Two options:

```bash
# Option A — direct HTTP (works without a gh auth handshake)
KBEXPLORER_GH_API_BASE=https://github.example.com/api/v3 \
KBEXPLORER_GH_TOKEN=<personal-access-token> \
kbexplorer manifest

# Option B — gh CLI with GH_HOST (no base override needed)
GH_HOST=github.example.com kbexplorer manifest
```

### Auth

When a base is set the CLI sends `Authorization: token <token>` where `<token>` is:

| Priority | Source |
|----------|--------|
| 1 | `KBEXPLORER_GH_TOKEN` env var |
| 2 | `GH_TOKEN` env var |
| 3 | Anonymous (no header sent) |

### Repo-local config

Add `ghApiBase` alongside the existing template-source fields in `.kbexplorer.json`:

```jsonc
{
  "template": "https://github.com/anokye-labs/kbexplorer-template.git",
  "mode": "submodule",
  // …
  "ghApiBase": "http://localhost:3456"
}
```

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
| `copilot` | `~/.copilot/mcp-config.json` (auto-loaded for preflight; a repo file can also be passed per-invocation via `--additional-mcp-config @<file>`) |
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

## Doctor

`kbexplorer doctor` is the first thing to run when regeneration fails on a teammate's machine. It diagnoses the full local setup in four sections:

```
Runtime
───────
  ✅ Adapter: copilot (source: default)
  ✅ Binary: copilot
  ✅ Binary available: copilot version 1.2.3

MCP
───
  ✅ No MCP servers declared in runtime config

Template
────────
  ✅ .kbexplorer.json present (mode: submodule, template: …)
  ✅ .gitmodules url agrees with .kbexplorer.json
  ⚠️  A newer release tag exists: v1.0.0 → v1.1.0 (run kbexplorer update)

Environment
───────────
  ✅ Node v22.1.0 (requires >=22)
  ✅ git available: git version 2.44.0
  ✅ gh (GitHub CLI) available: gh version 2.40.0
  ⚠️  content/ directory not found
```

```bash
kbexplorer doctor                 # full diagnosis
kbexplorer doctor --runtime claude  # diagnose a specific adapter
kbexplorer doctor --json          # machine-readable output for scripts
kbexplorer doctor --offline       # skip the latest-tag network check
```

**Exit codes:** `0` when all checks pass or produce warnings; `1` when any check fails. Suitable as a CI gate (`kbexplorer doctor --offline || exit 1`).

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
