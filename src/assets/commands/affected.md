---
name: affected
description: Map a git diff to the content nodes that cite the changed files.
argument-hint: <git-ref> [--json]
allowed-tools:
  - shell(kbx affected)
  - shell(git)
  - view
---

# /affected

Map a git diff to the content nodes that cite the changed files.

Runs `kbx affected $ARGUMENTS`, forwarding any arguments you provide. This verb is deterministic and never calls Copilot.

## Arguments

| Argument | Description |
| --- | --- |
| `<git-ref>` | Git ref to diff against (e.g. HEAD~1) |
| `--json` | Emit machine-readable JSON for tooling |

## Allowed tools

This command runs under a scoped, least-privilege tool allowlist:

- `shell(kbx affected)`
- `shell(git)`
- `view`

## Notes

Tells you which pages to refresh after a code change.

## Run

```sh
kbx affected $ARGUMENTS
```
