---
id: "zero-deps"
title: "Zero Runtime Dependencies"
emoji: "Diamond"
cluster: infra
parent: home
connections:
  - to: "lib-frontmatter"
    description: "the custom YAML subset parser is a direct consequence"
  - to: "cli-router"
    description: "the router uses only node:* built-ins"
---

`package.json` declares **no `dependencies`** — only `devDependencies`
(`vitest`, etc.). At runtime the CLI uses only Node built-ins and shells
out to `git`, `gh`, and `vite` (which lives in the installed template).

## What this buys

- **Fast `npx` cold starts.** Nothing to download except the package
  itself.
- **Tiny supply chain.** No transitive deps means no supply-chain audit
  surface for the CLI's runtime.
- **Predictable behavior.** Node + git + gh are stable interfaces; npm
  packages are not.
- **Easy fork-and-modify.** A new contributor can read the entire codebase
  in an afternoon.

## What it costs

- **Custom YAML parser.** The [lib-frontmatter](lib-frontmatter) parser
  handles a deliberate subset of YAML and explicitly does not support
  multi-line strings, inline objects, anchors, or escaped specials. The
  trade-off was reviewed and accepted — a full YAML parser is too much
  weight for what kbx's content schema needs.
- **Custom prompt / arg parsing.** [lib-detect-repo](lib-detect-repo),
  `lib/args.js`, and `lib/prompt.js` reinvent small bits of what `commander`
  / `inquirer` would do — kept small enough to be unit-tested in full.
- **Discipline required.** Every PR that wants to add a dep is rejected by
  default. The bar is genuinely high.

## What is not zero-dep

The **explorer template** (`.kbx/`) has a normal Vite / React stack
with all the usual dependencies. The zero-dep posture applies only to the
CLI itself — the template is a regular npm app and that is fine.

<!-- Sources: package.json -->

