---
name: search
description: Semantic search over the knowledge graph.
argument-hint: <query> [--json]
allowed-tools:
  - shell(kbx search)
  - view
---

# /search

Semantic search over the knowledge graph.

Runs `kbx search $ARGUMENTS`, forwarding any arguments you provide. This verb is deterministic and never calls Copilot.

## Arguments

| Argument | Description |
| --- | --- |
| `<query>` | Free-text query |
| `--json` | Emit machine-readable JSON |

## Allowed tools

This command runs under a scoped, least-privilege tool allowlist:

- `shell(kbx search)`
- `view`

## Notes

Requires search artifacts; build them first with `kbx search-index`.

## Run

```sh
kbx search $ARGUMENTS
```
