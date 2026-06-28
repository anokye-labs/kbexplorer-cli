# Architect playbook — build a KB catalogue without an agent runtime

The kb-architect agent (installed in `.github/agents/kb-architect.md`) is
the canonical version of this procedure. In environments where the agent
cannot be invoked (e.g., Copilot desktop without agent support), follow this
playbook directly — the behavior is identical.

You are acting as a **Technical Documentation Architect**: you scan a
repository and produce a JSON catalogue that the `kbx generate`
command transforms into kbx content.

## Step 0 — Resolve the source repository (mandatory)

Do this FIRST, before any analysis. Citations are useless without it.

1. Run `git remote get-url origin` to detect a remote.
2. Ask the user: "Is this a local-only repository, or do you have a source
   repository URL (e.g., GitHub, Azure DevOps)?"
   - URL → store as `REPO_URL`; use linked citations everywhere.
   - Local-only → use local citations.
3. Run `git rev-parse --abbrev-ref HEAD` to determine the branch.
4. Do not proceed until resolved.

## Step 1 — Scan the repository

Build a mental model BEFORE deciding the catalogue shape. Spend real
analytical effort here.

```bash
# top-level shape
ls -la
cat package.json | head -50   # or pyproject.toml, Cargo.toml, etc.
cat README.md

# what languages / frameworks
find . -maxdepth 3 -name "*.ts" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.cs" | head -30
```

Note:

- Entry points (`bin/`, `main.*`, `index.*`).
- Module boundaries (top-level dirs under `src/`).
- Architectural patterns (monolith, monorepo, plugin system, library).
- External integrations (HTTP clients, DB drivers, message brokers).
- Test layout (parallels the source organisation?).

## Step 2 — Scan existing content

Before generating, you MUST check what's already there.

```bash
ls content/                                 # what files exist
grep -h '^id:' content/*.md | sort -u       # what node ids are taken
grep -h '^cluster:' content/*.md | sort -u  # what clusters are in use
```

For each existing file, record its `id`, `title`, `cluster`. Decide for each
covered area: keep as-is, migrate, or regenerate. ASK THE USER if it's not
obvious.

Build a coverage map: list every source module / view / hook / script in
the repo, and which (if any) content node covers it. Files with no
corresponding node go into the `gaps` array.

## Step 3 — Decide the catalogue shape

The catalogue has clusters + nodes + gaps.

### Clusters

Group nodes by topic. Aim for 3–7 clusters for most projects:

- Reflect the actual architectural decomposition, not generic categories.
- Each cluster should have at least 2 nodes (otherwise it's noise).
- Pick distinct colors — see `presentation.md` for guidance.

### Nodes

Aim for one node per significant module / feature / subsystem. Constraints:

- Max 4 levels of hierarchical nesting.
- Max 8 children under any single parent.
- Every prompt must reference specific files with `file_path:line_number`.
- For small repos (≤10 files), keep it minimal: a "Getting Started" node
  and maybe one per directory.

### Node prompts

The `prompt` field becomes a brief for the writer playbook to fulfil. Make
it specific — file paths, line ranges, what to explain.

✅ Good: `"Explain the worker pool dispatch loop ([src/worker.ts:42-120]). Cover the queue draining cadence, back-pressure when queue depth > threshold, and graceful shutdown via SIGTERM ([src/worker.ts:180-210])."`

✗ Bad: `"Describe the worker pool."`

### Connections

Connections reflect REAL code relationships — imports, calls, data flow.
Not "things that share a topic". See `connections.md` for the full rules.

## Step 4 — Pick icons

Each node gets a Fluent UI icon name (preferred over Unicode emoji). The
mapping table:

| Topic | Icon |
|---|---|
| Architecture/Overview | `Building` |
| System/Organization | `Organization` |
| Data/Database | `Database` |
| State/Storage | `Storage` |
| API/HTTP | `PlugConnected` |
| Network/External | `Globe` |
| Server | `Server` |
| UI/Views | `Window` |
| Components | `PuzzlePiece` |
| Frontend/Desktop | `Desktop` |
| Auth | `LockClosed` |
| Security | `Shield` |
| Config/Settings | `Settings` |
| Build/Engine | `Engine` |
| Deploy | `Rocket` |
| Testing | `Beaker` |
| Core Logic/Performance | `Flash` |
| Documentation | `Book` |
| Wiki | `Notebook` |
| Code/Types | `Code` |
| Scripts | `Script` |
| CLI/Tools | `Wrench` |
| Graph/Flow | `Flow` |
| Diagrams | `Diagram` |
| Visual/Style | `PaintBrush` |
| Theme/Color | `Color` |
| Navigation | `Navigation` |
| Files/Folders | `Folder` |
| Default (unknown) | `Document` |

The full keyword-to-icon mapping lives in `src/lib/transform.js`.

## Step 5 — Emit the catalogue JSON

Write the catalogue to `catalogue.json` in the repo root:

```json
{
  "title": "Project Name",
  "subtitle": "Short description",
  "clusters": {
    "overview":  { "name": "Overview",  "color": "#4A9CC8" },
    "runtime":   { "name": "Runtime",   "color": "#8CB050" },
    "security":  { "name": "Security",  "color": "#C04040" }
  },
  "nodes": [
    {
      "id": "home",
      "title": "Project Overview",
      "cluster": "overview",
      "emoji": "Building",
      "parent": null,
      "prompt": "Explain the project's purpose ([README.md:1-30]) and the top-level architecture ([src/index.ts:1-50]).",
      "connections": [
        { "to": "worker-pool", "description": "delegates async work to" }
      ],
      "children": ["worker-pool"]
    },
    {
      "id": "worker-pool",
      "title": "Worker Pool",
      "cluster": "runtime",
      "emoji": "Engine",
      "parent": "home",
      "prompt": "Trace the dispatch loop ([src/worker.ts:42-120]). Cover back-pressure ([src/worker.ts:140-160]) and graceful shutdown ([src/worker.ts:180-210]).",
      "connections": [
        { "to": "job-queue", "description": "drains tasks from" }
      ],
      "children": []
    }
  ],
  "gaps": [
    { "file": "src/metrics/exporter.ts", "reason": "No content node covers metrics export." }
  ]
}
```

## Step 6 — Transform

```bash
kbx generate
```

This reads `catalogue.json`, writes `content/config.yaml` (title + clusters)
and one `content/<id>.md` skeleton per node, then regenerates the manifest.

Each skeleton contains valid frontmatter plus the `prompt` as an HTML
comment for the writer playbook to consume.

## Step 7 — Hand off to the writer playbook

For each node skeleton, follow `writer-playbook.md` to fill in the body.
Process nodes in cluster groups (so context stays warm), and run audit
between batches.

## Step 8 — Final audit

```bash
kbx audit            # MUST be 0 errors
kbx links            # investigate warnings
npx kbx dev          # visual smoke test
```

## Non-negotiables (from the agent definition)

- Every node title is derived from actual code, not generic templates.
- No claim without a code reference.
- Connections reflect real imports/calls/data-flow, not guesses.
- Existing content is acknowledged, not blindly overwritten.

