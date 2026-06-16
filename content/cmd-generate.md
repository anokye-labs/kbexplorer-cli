---
id: "cmd-generate"
title: "generate"
emoji: "Sparkle"
cluster: commands
parent: commands-overview
connections:
  - to: "agents-overview"
    description: "orchestrates the three agents"
  - to: "lib-manifest-transform"
    description: "transforms catalogue.json into content/*.md"
  - to: "derivation-runtime"
    description: "the architect step runs through copilot -p"
---

`generate` runs the AI-assisted content pipeline. The agents do the writing;
the CLI command is a thin orchestrator that wires them together.

```bash
npx kbexplorer generate
```

## Pipeline

```mermaid
flowchart LR
    repo[Repository] --> arch[kb-architect agent]
    arch --> cat[catalogue.json]
    cat --> trans[transformCatalogue]
    trans --> skel[content/*.md skeletons]
    skel --> writer[kb-writer agent]
    writer --> done[fully-authored nodes]
```

1. [`kb-architect`](agents-overview) scans the repo and produces
   `catalogue.json`: a structured list of nodes, clusters, and connections
   with Fluent icon hints.
2. `transformCatalogue` in [`lib/transform.js`](lib-manifest-transform)
   converts that JSON into per-node markdown skeletons under `content/` plus
   a `config.yaml` with cluster definitions.
3. [`kb-writer`](agents-overview) opens each skeleton and fills in the body
   with cited Mermaid diagrams and prose. [`kb-researcher`](agents-overview)
   is invoked on demand for deep investigation.

## Idempotency

`generate` only touches files that don't already exist or are empty
skeletons. Existing authored nodes are left alone. Re-running after edits is
safe — it picks up only new catalogue entries.

For diff-driven refresh of existing nodes, use [affected](cmd-affected)
instead — it maps a git diff to the nodes that cite the changed files, so
the writer agent only refreshes what actually shifted.

<!-- Sources: src/commands/generate.js, src/lib/transform.js -->
