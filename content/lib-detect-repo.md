---
id: "lib-detect-repo"
title: "lib/detect-repo.js"
emoji: "Map"
cluster: libs
parent: libs-overview
connections:
  - to: "install-modes"
    description: "indistinguishable: submodule vs vendor"
  - to: "cmd-dev-build"
    description: "every runtime command uses getAppRoot()"
---

`detect-repo.js` is the **runtime-resolution seam**. It answers two
questions for every command:

1. *Where is the explorer app installed?*
2. *Where are we — the host repo, or the template repo itself?*

## getAppRoot(cwd)

The single function every runtime command depends on:

- If `cwd` is the template repo itself (its `package.json#name` is
  `kbexplorer` or `kbexplorer-template`), return `cwd`. **Self-hosted mode.**
- Else if `cwd/.kbexplorer/package.json` exists, return `cwd/.kbexplorer`.
  **Host-repo mode** — could be a submodule **or** a vendored copy; the
  function does not care, and neither does any caller.
- Else return `null`. Nothing is installed.

This three-line resolution is the entire reason adding [vendor mode](install-modes)
required **zero changes** to [dev / build / manifest](cmd-dev-build).

## Other helpers

| Function | Returns |
|---|---|
| `isTemplateRepo(cwd)` | true when in self-hosted mode |
| `isSubmoduleInstall(cwd)` | true when `.kbexplorer/` is a submodule (parses `.gitmodules`) |
| `getSubmoduleUrl(cwd)` | the registered submodule URL, if any |
| `hasTemplate(cwd)` | true when a template install of any kind is present |
| `detectGitOrigin(cwd)` | `{ owner, repo }` parsed from `git remote get-url origin` |
| `detectBranch(cwd)` | current branch via `git rev-parse --abbrev-ref HEAD` |

The submodule helpers are used only by [update](cmd-update) and [init](cmd-init);
runtime code never branches on install mode.

<!-- Sources: src/lib/detect-repo.js -->
