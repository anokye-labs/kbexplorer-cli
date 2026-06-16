---
id: "lib-affected"
title: "lib/affected.js"
emoji: "Diff"
cluster: libs
parent: libs-overview
connections:
  - to: "cmd-affected"
    description: "the CLI wrapper"
  - to: "lib-frontmatter"
    description: "uses extractCitedFiles() to build the index"
---

`affected.js` answers: **"which content nodes cite files that just
changed?"** It is the pure-logic side of [cmd-affected](cmd-affected).

## The citation index

`buildCitationIndex(contentDir)` walks every `*.md` in `contentDir`,
extracts the cited file paths via
[`extractCitedFiles()`](lib-frontmatter), and returns:

- `index: Map<citedPath, Set<nodeId>>` — reverse map for fast lookup
- `nodes: Array<{id, file, citations}>` — per-node detail

## findAffected

`findAffected(changedFiles, index)` runs the intersection:

1. For each changed file, try **exact match** in the index.
2. Fall back to **suffix match** — `src/auth.ts` matches any indexed
   citation ending in `src/auth.ts`. This handles partial paths and
   monorepo-style cross-package references.
3. Collect the matching node ids, deduplicate, return.

## gitChangedFiles

The git integration uses `execFileSync('git', ['diff', '--name-only',
ref])`, not `execSync` with a template literal. This hardens the call
against shell-injection from user-controlled refs (e.g.
`HEAD~5; rm -rf /`).

## Trade-off: suffix-match ambiguity

In a monorepo with three `auth.ts` files, a citation of `auth.ts` will
match all three changed files. The library accepts this — over-reporting
is better than missing a node. A future enhancement could expose the
match type (`exact` / `suffix` / `ambiguous`) in the JSON output so
automation can treat ambiguous matches more cautiously.

<!-- Sources: src/lib/affected.js, src/lib/frontmatter.js -->
