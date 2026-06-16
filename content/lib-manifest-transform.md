---
id: "lib-manifest-transform"
title: "lib/manifest.js + transform.js"
emoji: "DatabaseStack"
cluster: libs
parent: libs-overview
connections:
  - to: "cmd-dev-build"
    description: "dev / build / manifest call generateManifest"
  - to: "cmd-generate"
    description: "generate calls transformCatalogue"
  - to: "agents-overview"
    description: "transform consumes the architect's catalogue"
---

Two libraries handle the **data side** of kbexplorer.

## generateManifest (lib/manifest.js)

Produces the JSON snapshot the explorer renders. Combines:

- Repo tree (capped depth)
- README
- Recent issues (cap 200)
- Recent PRs (cap 200)
- Recent commits (cap 50)
- Authored content from `content/*.md`

The caps exist because GitHub's REST is rate-limited and very large repos
choke. For exhaustive coverage, lean on authored content.

If `gh` is missing or unauthenticated, the build degrades gracefully — it
warns and omits the GitHub-derived parts. `readConfig()` (also exported
here) is used by [audit](cmd-audit) to discover declared clusters.

## transformCatalogue (lib/transform.js)

The conversion step in [generate](cmd-generate). Takes the `catalogue.json`
produced by the [`kb-architect` agent](agents-overview) and emits:

- `content/config.yaml` with cluster definitions
- One `content/<slug>.md` skeleton per node, with valid frontmatter and a
  writer-prompt placeholder

`inferIcon()` lives here too — it maps node titles to Fluent UI icon names
based on topic keywords. [scaffold](cmd-scaffold) reuses it for consistent
emoji selection.

## Idempotency

`transformCatalogue` will not overwrite an existing file that has been
edited beyond the skeleton. Re-running [generate](cmd-generate) after
human edits is safe — only new nodes get scaffolded; existing ones are
left alone.

<!-- Sources: src/lib/manifest.js, src/lib/transform.js -->
