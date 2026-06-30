---
name: derive
description: Extract entities/relationships from .docx/prose into committed content/derived/*.jsonld.
argument-hint: <source...> [--refresh] [--check]
allowed-tools:
  - shell(kbx derive)
  - view
  - write
---

# /derive

Extract entities/relationships from .docx/prose into committed content/derived/*.jsonld.

Runs `kbx derive $ARGUMENTS`, forwarding any arguments you provide. This verb shells out to `copilot -p` for its fuzzy phase.

## Arguments

| Argument | Description |
| --- | --- |
| `<source...>` | One or more .docx/.md/.markdown/.txt sources |
| `--out, -o <dir>` | Output directory for *.jsonld (default content/derived) |
| `--check` | Drift check: non-zero exit if a committed artifact is stale |
| `--refresh, --force` | Re-run fuzzy extraction even if a fresh artifact exists |
| `--dry-run` | Print the assembled copilot command + planned outputs |

## Allowed tools

This command runs under a scoped, least-privilege tool allowlist:

- `shell(kbx derive)`
- `view`
- `write`

## Notes

Idempotent: re-emitting an unchanged source is byte-identical and never calls the LLM. Pass the source files (never the .jsonld outputs) to `--check`.

## Run

```sh
kbx derive $ARGUMENTS
```
