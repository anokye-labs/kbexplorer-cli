---
id: "libs-overview"
title: "Core Libraries"
emoji: "Library"
cluster: libs
parent: home
connections:
  - to: "lib-detect-repo"
    description: "the runtime-resolution seam"
  - to: "lib-source"
    description: "the install-source seam"
  - to: "lib-frontmatter"
    description: "zero-dep YAML subset"
  - to: "lib-audit"
    description: "schema validator"
  - to: "lib-affected"
    description: "citation index"
  - to: "lib-manifest-transform"
    description: "repo → manifest JSON; catalogue → content/*.md"
  - to: "lib-version"
    description: "remote tag / SHA lookups"
---

`src/lib/` is the **reusable heart** of kbexplorer-cli. Pure functions, no
side effects beyond filesystem and `git` / `gh` shellouts where required,
and unit-tested in isolation. Commands in `src/commands/` are thin
orchestrators around these libs.

## The two seams

Two libs carry disproportionate weight:

- [lib-detect-repo](lib-detect-repo) — provides `getAppRoot()`, which lets
  every runtime command find the explorer app whether it was installed as a
  submodule, vendored, or self-hosted.
- [lib-source](lib-source) — owns `.kbexplorer.json`, the declarative record
  of where the template came from and how it should be updated.

These two together let the rest of the codebase ignore install mode and
template URL — turning what would be a combinatorial special-case matrix
into one resolution function and one read-from-disk.

## The new lifecycle libs

Three libraries were added to support the lifecycle tooling:

- [lib-frontmatter](lib-frontmatter) — zero-dep parser for the
  kbexplorer YAML subset, plus citation extraction.
- [lib-audit](lib-audit) — rules-based schema validator used by
  [audit](cmd-audit).
- [lib-affected](lib-affected) — builds the citation index and computes
  diff-to-node mappings for [affected](cmd-affected).

<!-- Sources: src/lib/*.js -->
