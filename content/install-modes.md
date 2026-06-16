---
id: "install-modes"
title: "Submodule vs Vendor"
emoji: "Branch"
cluster: infra
parent: home
connections:
  - to: "cmd-init"
    description: "init --vendor opts out of submodules"
  - to: "cmd-update"
    description: "update behaves differently per mode"
  - to: "lib-detect-repo"
    description: "the runtime treats them identically"
  - to: "lib-source"
    description: "the mode is recorded declaratively"
---

kbexplorer can install the explorer template into a host repo in two modes:

| Mode | When | How |
|---|---|---|
| **Submodule** (default) | Most cases; you want tag-pinned upstream + easy upgrades. | Git submodule at `.kbexplorer/`, pinned to a tag. |
| **Vendor** | You want to customize the template freely, or your environment cannot use submodules. | One-time copy with `.git` stripped; the files become yours. |

```bash
npx kbexplorer init                              # submodule, latest tag
npx kbexplorer init --vendor                     # vendor, latest tag
npx kbexplorer init --vendor --ref main          # vendor, branch HEAD
npx kbexplorer init --ref v1.2.0                 # submodule, pinned tag
```

## The runtime cannot tell

[lib-detect-repo](lib-detect-repo) treats both modes identically — once
`.kbexplorer/package.json` exists, [dev / build / manifest](cmd-dev-build)
run the same way. This is the architectural reason vendor mode required
**zero changes** to runtime commands when it was added.

## Update behavior differs

| Action | Submodule | Vendor |
|---|---|---|
| `update` (no flag) | `git submodule update --remote` | Fetch into sibling review folder; report |
| `update --force` | Same as above | Back up `.kbexplorer/` → `.kbexplorer.backup-<ts>`, swap in new version |

The asymmetry is intentional. A submodule has no local edits to lose
(the pin is the source of truth). A vendored install might have local
edits, so [update](cmd-update) refuses to silently clobber them.

<!-- Sources: src/commands/init.js, src/commands/update.js, src/lib/source.js, src/lib/detect-repo.js -->
