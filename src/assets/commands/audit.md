---
name: audit
description: CI-grade structural lint: duplicate ids, broken parents, cycles, dead connections.
argument-hint: [--json]
allowed-tools:
  - shell(kbx audit)
  - view
---

# /audit

CI-grade structural lint: duplicate ids, broken parents, cycles, dead connections.

Runs `kbx audit $ARGUMENTS`, forwarding any arguments you provide. This verb is deterministic and never calls Copilot.

## Arguments

| Argument | Description |
| --- | --- |
| `--json` | Emit machine-readable JSON for CI |

## Allowed tools

This command runs under a scoped, least-privilege tool allowlist:

- `shell(kbx audit)`
- `view`

## Notes

Exits non-zero on structural errors. Deterministic — never calls Copilot.

## Run

```sh
kbx audit $ARGUMENTS
```
