---
name: doctor
description: Diagnose runtime, MCP, template setup, plugin bundle, and adoption readiness.
argument-hint: [--runtime <name>] [--json] [--offline]
allowed-tools:
  - shell(kbx doctor)
  - view
---

# /doctor

Diagnose runtime, MCP, template setup, plugin bundle, and adoption readiness.

Runs `kbx doctor $ARGUMENTS`, forwarding any arguments you provide. This verb is deterministic and never calls Copilot.

## Arguments

| Argument | Description |
| --- | --- |
| `--runtime <name>` | Check a specific adapter ("copilot" | "claude" | "custom") |
| `--json` | Emit machine-readable JSON |
| `--offline` | Skip network-dependent checks (latest tag lookup) |

## Allowed tools

This command runs under a scoped, least-privilege tool allowlist:

- `shell(kbx doctor)`
- `view`

## Notes

Read-only diagnostics — safe to run anytime.

## Run

```sh
kbx doctor $ARGUMENTS
```
