---
id: "lib-source"
title: "lib/source.js"
emoji: "DocumentText"
cluster: libs
parent: libs-overview
connections:
  - to: "cmd-init"
    description: "init writes the source record"
  - to: "cmd-update"
    description: "update reads it to decide what to do"
  - to: "install-modes"
    description: "captures the mode declaratively"
---

`source.js` owns `.kbexplorer.json`, the **install-source record**. It is
a tiny library — read / write / classify — but it removes a class of
hardcoded coupling from the rest of the codebase.

## The record

```json
{
  "template": "https://github.com/anokye-labs/kbexplorer-template.git",
  "ref": "v1.2.0",
  "refType": "tag",
  "resolvedCommit": "a1b2c3d4...",
  "mode": "submodule"
}
```

## What it replaces

Historically the template URL was a hardcoded constant. Install and update
logic had to special-case the constant for every code path. Now both read
the record from the host repo — and the constant in
[`lib/version.js`](lib-version) survives only as a *default* for first-time
`init` without `--template`.

## classifyRef

A pure function that turns a ref string into one of three classifications,
used by [update](cmd-update) to decide whether to track HEAD or pin:

| Ref looks like | Classification | update behavior |
|---|---|---|
| (omitted, default) | `release` | Track the latest semver tag. |
| `v1.2.0`, `1.2`, etc. | `tag` | Pin to exactly this tag. |
| `main`, `dev`, etc. | `branch` | Track the branch HEAD. |

## Legacy installs

Pre-v0.2 installs predate `.kbexplorer.json`. The library synthesizes a
plausible record on the fly from [`.gitmodules`](lib-detect-repo) so old
installs work without a migration step.

<!-- Sources: src/lib/source.js, src/lib/version.js -->
