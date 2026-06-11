---
id: "home"
title: "kbexplorer-cli"
emoji: "Home"
cluster: entry
connections:
  - to: "cli-router"
    description: "every command is dispatched here"
  - to: "commands-overview"
    description: "ten commands span the full KB lifecycle"
  - to: "libs-overview"
    description: "pure, testable logic in src/lib/"
  - to: "agents-overview"
    description: "three Copilot agents author content"
  - to: "skill-overview"
    description: "one skill, deep references library"
  - to: "zero-deps"
    description: "no runtime dependencies — by design"
  - to: "derivation-overview"
    description: "docx/prose → engine-contract JSON-LD"
---

**kbexplorer-cli** is a zero-dependency Node.js CLI that turns any GitHub
repository into a navigable, interactive **knowledge graph**. It installs the
explorer web app into a host repo (as a git submodule or vendored copy), wires
in a set of Copilot agents and a routing skill, and provides eleven commands that
cover the full content lifecycle — from `init` and `generate` through `audit`,
`affected`, `scaffold`, and `derive`.

This knowledge base **dogfoods kbexplorer on its own source** — every node you
see here is authored markdown that cites real files in this repository, and
the graph is regenerated from the live repo each time you preview it.

## Start anywhere

- New to the CLI? Open [commands-overview](commands-overview) and pick a verb.
- Curious how it works? See [cli-router](cli-router) and [libs-overview](libs-overview).
- Writing content yourself? See [skill-overview](skill-overview).
- Deriving entities from docs? See [derivation-overview](derivation-overview).
- Standardizing kbexplorer across an org? Start with [install-modes](install-modes).

## The two-seam design

The codebase rests on two thin seams. `getAppRoot()` resolves the explorer
app's location identically whether it was installed as a submodule or vendored
— so [dev / build / manifest](cmd-dev-build) do not care which mode is in use.
And `.kbexplorer.json` records the install source, so [update](cmd-update) and
[init](cmd-init) read from the host repo rather than a hardcoded constant.
[lib-detect-repo](lib-detect-repo) and [lib-source](lib-source) hold both.

<!-- Sources: bin/cli.js, src/lib/detect-repo.js, src/lib/source.js -->
