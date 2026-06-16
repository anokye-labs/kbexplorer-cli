---
id: "cmd-audit"
title: "audit"
emoji: "ShieldCheckmark"
cluster: commands
parent: commands-overview
connections:
  - to: "lib-audit"
    description: "the rules engine"
  - to: "lib-frontmatter"
    description: "parses every content file"
  - to: "cmd-links"
    description: "non-overlapping: links is soft, audit is hard"
---

`audit` is the hard structural validator for the knowledge graph. It exits
**non-zero on errors**, so it is safe to wire into CI as a gating check.

```bash
npx kbexplorer audit                          # default: scan content/
npx kbexplorer audit --content my-content     # custom content dir
npx kbexplorer audit --json                   # machine-readable output
```

## What it catches

| Rule | Severity | Catches |
|---|---|---|
| `malformed-frontmatter` | error | YAML that the kbexplorer-subset parser cannot read |
| `missing-required-field` | error | `id`, `title`, or `cluster` is missing |
| `duplicate-id` | error | The same `id:` appears in two or more files |
| `broken-parent` | error | `parent:` points to an id that does not exist |
| `parent-cycle` | error | The parent chain forms a cycle |
| `dead-connection` | error | `connections.to:` points to an unknown node |
| `undeclared-cluster` | error | `cluster:` is not declared in `config.yaml` |
| `missing-config` | error | Content declares clusters but `config.yaml` is missing |
| `filename-id-mismatch` | warning | The filename slug differs from the `id:` field |
| `read-error` | warning | File could not be read |

Built-in connection targets (`issue-N`, `pr-N`, `dir-*`, `readme`,
`repo-root`) are accepted by `dead-connection` without warning.

## Why a separate command from links

[links](cmd-links) is intentionally **soft** — orphan pages, weak clusters,
coverage gaps. It is advisory and never fails CI. `audit` is the opposite:
errors block, warnings are informational. The split lets teams be strict
about correctness while keeping graph-shape feedback as guidance.

<!-- Sources: src/commands/audit.js, src/lib/audit.js, src/lib/frontmatter.js -->
