---
name: dev
description: Start the kbx dev server in local mode (regenerates the manifest, then Vite).
argument-hint: [--no-watch] [--host] [--port <n>]
allowed-tools:
  - shell(kbx dev)
---

# /dev

Start the kbx dev server in local mode (regenerates the manifest, then Vite).

Runs `kbx dev $ARGUMENTS`, forwarding any arguments you provide. This verb is deterministic and never calls Copilot.

## Arguments

| Argument | Description |
| --- | --- |
| `--no-watch` | Don't watch host content for changes (one-shot manifest) |
| `(passthrough)` | Other args are forwarded to Vite (e.g. --host, --port) |

## Allowed tools

This command runs under a scoped, least-privilege tool allowlist:

- `shell(kbx dev)`

## Notes

Long-running. Requires `.kbx/` (run the init command first).

## Run

```sh
kbx dev $ARGUMENTS
```
