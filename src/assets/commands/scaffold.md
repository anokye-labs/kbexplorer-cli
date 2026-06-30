---
name: scaffold
description: Create one new content/<slug>.md page with valid frontmatter.
argument-hint: <slug> --cluster <id> [--parent <id>] [--title <text>]
allowed-tools:
  - shell(kbx scaffold)
  - write
  - view
---

# /scaffold

Create one new content/<slug>.md page with valid frontmatter.

Runs `kbx scaffold $ARGUMENTS`, forwarding any arguments you provide. This verb is deterministic and never calls Copilot.

## Arguments

| Argument | Description |
| --- | --- |
| `<slug>` | Page slug (becomes content/<slug>.md) |
| `--cluster <id>` | Cluster the new node belongs to (required) |
| `--parent <id>` | Parent node id for hierarchy |
| `--title <text>` | Human-readable page title |

## Allowed tools

This command runs under a scoped, least-privilege tool allowlist:

- `shell(kbx scaffold)`
- `write`
- `view`

## Notes

Writes a skeleton only; edit the body by hand or hand off to a writer playbook.

## Run

```sh
kbx scaffold $ARGUMENTS
```
