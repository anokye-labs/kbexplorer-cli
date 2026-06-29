---
id: "lib-version"
title: "lib/version.js"
emoji: "Tag"
cluster: libs
parent: libs-overview
connections:
  - to: "cmd-init"
    description: "init resolves the install ref through here"
  - to: "cmd-update"
    description: "update compares remote SHA against the recorded one"
  - to: "lib-source"
    description: "default template URL lives as a constant here"
---

`version.js` handles **remote tag / SHA lookups** for any template repo.

## Helpers

| Function | Returns |
|---|---|
| `getLatestTag(repoUrl)` | The most recent semver tag from `git ls-remote --tags`. |
| `resolveRef(repoUrl, ref)` | The commit SHA the ref points to right now. |
| `checkoutRef(cwd, ref)` | Switch a submodule to the given ref. |

All helpers shell out to `git`; none require `gh` or network access beyond
what `git` itself uses. The `repoUrl` is always parametrized — kbx's
default template URL is a constant defined here, but every helper accepts
an arbitrary URL so custom templates work identically.

## Backward compatibility

When [lib-source](lib-source) was added, every helper was changed to
**default** to the kbx template URL rather than hardcode it. Callers
that don't pass a URL get the default; callers that do (like
[init](cmd-init) with `--template`) get their own. No legacy call site
broke.

## Default template

The constant lives at the top of the file and is the **only** hardcoded
mention of the official template URL in the entire codebase. Everything
else flows through [`.kbx.json`](lib-source) or an explicit
`--template` flag.

<!-- Sources: src/lib/version.js, src/lib/source.js -->

