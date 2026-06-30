# kbx — Copilot plugin bundle

This directory is the authored **plugin bundle** for kbx. It aggregates the kbx
command surface, agents, skill, and canvas extension into a single installable
GitHub Copilot plugin, served over one engine.

## Layout

```
kbx/
├── .claude-plugin/
│   └── plugin.json          # plugin manifest (name, version, description, author)
├── copilot-extension.json   # gist-share descriptor (required to share via gist)
├── README.md                # this file
├── agents/                  # kb-architect, kb-researcher, kb-writer (assembled)
├── commands/                # kbx command surface (assembled)
├── skills/kbx/              # the kbx skill + references (assembled)
└── extensions/              # kbexplorer canvas extension (assembled)
```

The `agents/`, `commands/`, `skills/`, and `extensions/` directories are not
checked in here — they are **assembled** at install time from their canonical
sources in this package so there is a single source of truth:

| Component | Source | Required |
| --- | --- | --- |
| agents | `src/assets/agents` | yes |
| skill | `src/assets/skills/kbx` | yes |
| commands | `src/assets/commands` | no (PE1-F2) |
| canvas extension | `src/assets/extensions` | no (template) |

## Install scopes

The bundle installs at three scopes (`src/lib/plugin-bundle.js#resolveScopeRoot`):

| Scope | Install root |
| --- | --- |
| `project` | `<repo>/.github/plugins/kbx` |
| `user` | `~/.copilot/plugins/kbx` |
| `session` | `<session-state-dir>/plugins/kbx` |

```sh
kbx plugin install                 # project scope (default)
kbx plugin install --scope user
kbx plugin install --scope session
```

## Sharing via gist

`copilot-extension.json` is what makes the bundle shareable as a gist. Validate
and print the share payload with:

```sh
kbx plugin share
```

## Health check

`kbx doctor` includes a **Plugin** section that verifies the manifest is valid,
the gist-share descriptor resolves, and every required component is present.
