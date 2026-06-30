---
name: build
description: Production build of the knowledge base into dist/kb/.
argument-hint: [--base <path>]
allowed-tools:
  - shell(kbx build)
  - view
---

# /build

Production build of the knowledge base into dist/kb/.

Runs `kbx build $ARGUMENTS`, forwarding any arguments you provide. This verb is deterministic and never calls Copilot.

## Arguments

| Argument | Description |
| --- | --- |
| `--base <path>` | Public base path for the built site |

## Allowed tools

This command runs under a scoped, least-privilege tool allowlist:

- `shell(kbx build)`
- `view`

## Notes

Requires `.kbx/` (run the init command first).

## Run

```sh
kbx build $ARGUMENTS
```
