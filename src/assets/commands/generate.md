---
name: generate
description: Run the content-generation pipeline (architect → transform → writer) into content/.
argument-hint: [--refresh] [--no-agent] [--dry-run]
allowed-tools:
  - shell(kbx generate)
  - view
  - edit
  - write
---

# /generate

Run the content-generation pipeline (architect → transform → writer) into content/.

Runs `kbx generate $ARGUMENTS`, forwarding any arguments you provide. This verb shells out to `copilot -p` for its fuzzy phase.

## Arguments

| Argument | Description |
| --- | --- |
| `--prompt, -p <text>` | Override the architect prompt sent to copilot |
| `--model <model>` | Model to use (copilot --model) |
| `--allow-tool <spec>` | Scoped tool permission, repeatable (e.g. 'shell(git)') |
| `--no-agent` | Skip the copilot step; only transform an existing catalogue |
| `--refresh, --force` | Re-run the agent even if catalogue.json exists |
| `--dry-run` | Print the assembled copilot command and exit |

## Allowed tools

This command runs under a scoped, least-privilege tool allowlist:

- `shell(kbx generate)`
- `view`
- `edit`
- `write`

## Notes

Fuzzy phase: shells out to `copilot -p`. Preview the exact argv first with `--dry-run`.

## Run

```sh
kbx generate $ARGUMENTS
```
