---
id: "cmd-update"
title: "update"
emoji: "ArrowSync"
cluster: commands
parent: commands-overview
connections:
  - to: "lib-source"
    description: "reads .kbx.json to know what to update"
  - to: "lib-version"
    description: "remote tag / SHA lookups"
  - to: "install-modes"
    description: "different behavior per mode"
---

`update` refreshes a previously-installed kbx. Crucially, it
**never silently clobbers local customizations** — the vendor mode path
always backs up before overwriting.

```bash
npx kbx update           # check + apply if safe
npx kbx update --force   # back up and swap (vendor only)
```

## What it updates

Always:

- Agents in `.github/agents/` — they ship with the CLI npm package.
- The skill at `.github/skills/kbx/` — same reason.

Conditionally, based on the install mode recorded in
[.kbx.json](lib-source):

| Install mode | `update` does |
|---|---|
| `submodule` | `git submodule update --remote` to the new ref. |
| `vendor` | Fetches the new version into a sibling review folder; with `--force` backs up the current install to `.kbx.backup-<ts>` and swaps. |

## Reproducibility

`update` compares the `resolvedCommit` in `.kbx.json` against the
remote SHA for the configured ref. If they match, it reports "Already up to
date" without re-downloading. This is why `init` always records the resolved
SHA rather than just the symbolic ref.

## Safety guarantees

- **No silent overwrites** for vendored installs — the user must opt in to
  `--force`.
- **Atomic swap** — same temp-dir-then-rename pattern as [init](cmd-init).
- **Refuses mode conversion** — `update` will not convert a submodule install
  to vendor or vice versa. Re-init explicitly to switch.

<!-- Sources: src/commands/update.js, src/lib/source.js, src/lib/version.js -->

