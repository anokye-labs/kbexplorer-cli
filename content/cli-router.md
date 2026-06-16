---
id: "cli-router"
title: "CLI Router (bin/cli.js)"
emoji: "Code"
cluster: libs
parent: home
connections:
  - to: "commands-overview"
    description: "dispatches the eleven command modules"
  - to: "lib-detect-repo"
    description: "every command uses getAppRoot() under the hood"
---

`bin/cli.js` is the single entry point declared in `package.json#bin`. It does
exactly three things:

1. Parse `argv[2]` as a command name.
2. Look the name up in a static `COMMANDS` map mapping each verb to a
   `src/commands/*.js` module.
3. Dynamically `import()` that module and call its default export with the
   remaining argv.

That's it. No framework, no plugin system, no global state. A new command is
wired up by adding one entry to the `COMMANDS` map plus a line to the help
text — which is exactly how `audit`, `affected`, `scaffold`, and `derive` were
added.

## Why so thin

The CLI is the **router**, not the logic. Pure logic lives in
[`src/lib/`](libs-overview), where it can be tested in isolation. Command
modules orchestrate — they parse args, call into libs, and print results.
That split lets `init` and `update` share `lib/version.js` without inheriting
each other's concerns, and lets `audit` and `affected` reuse
[`lib/frontmatter.js`](lib-frontmatter) without duplicating its parser.

## The eleven commands

| Verb | Module | What it does |
|---|---|---|
| `init` | [cmd-init](cmd-init) | Bootstrap kbexplorer into a host repo. |
| `generate` | [cmd-generate](cmd-generate) | Architect → transform → writer pipeline. |
| `dev` | [cmd-dev-build](cmd-dev-build) | Start the Vite dev server. |
| `build` | [cmd-dev-build](cmd-dev-build) | Production build into `dist/`. |
| `manifest` | [cmd-dev-build](cmd-dev-build) | Regenerate the JSON snapshot. |
| `update` | [cmd-update](cmd-update) | Refresh template + agents + skill. |
| `links` | [cmd-links](cmd-links) | Soft graph-health report. |
| `audit` | [cmd-audit](cmd-audit) | Hard structural lint (CI-grade). |
| `affected` | [cmd-affected](cmd-affected) | Diff → impacted nodes. |
| `scaffold` | [cmd-scaffold](cmd-scaffold) | Create a single new node. |
| `derive` | [cmd-derive](cmd-derive) | Unstructured docs → committed `*.jsonld`. |

<!-- Sources: bin/cli.js, package.json -->
