---
name: init
description: Bootstrap kbx in this repo: install the .kbx explorer, agents/skills, and config.
argument-hint: [--vendor] [--ref <branch>] [--yes]
allowed-tools:
  - shell(kbx init)
  - shell(git)
  - write
  - edit
  - view
---

# /init

Bootstrap kbx in this repo: install the .kbx explorer, agents/skills, and config.

Runs `kbx init $ARGUMENTS`, forwarding any arguments you provide. This verb is deterministic and never calls Copilot.

## Arguments

| Argument | Description |
| --- | --- |
| `--template, -t <url>` | Install from a custom template repo |
| `--ref, --branch <ref>` | Install a specific template tag or branch |
| `--vendor, --no-submodule` | One-time copy instead of a git submodule |
| `--yes, -y` | Non-interactive onboarding (CI / templated) |

## Allowed tools

This command runs under a scoped, least-privilege tool allowlist:

- `shell(kbx init)`
- `shell(git)`
- `write`
- `edit`
- `view`

## Notes

One-time setup. Safe to re-run; pre-fills every prompt from the git remote and branch.

## Run

```sh
kbx init $ARGUMENTS
```
