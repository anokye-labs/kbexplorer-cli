---
name: links
description: Soft graph-health report: orphans, weak clusters, coverage gaps (advisory).
argument-hint: [--json]
allowed-tools:
  - shell(kbx links)
  - view
---

# /links

Soft graph-health report: orphans, weak clusters, coverage gaps (advisory).

Runs `kbx links $ARGUMENTS`, forwarding any arguments you provide. This verb is deterministic and never calls Copilot.

## Arguments

| Argument | Description |
| --- | --- |
| `--json` | Emit machine-readable JSON |

## Allowed tools

This command runs under a scoped, least-privilege tool allowlist:

- `shell(kbx links)`
- `view`

## Notes

Advisory only — does not fail the build.

## Run

```sh
kbx links $ARGUMENTS
```
