# Frontmatter — full schema

Every file under the content directory begins with a YAML frontmatter block.
This is the contract between authored content and the explorer's graph. Get
it right or the page will not appear, the graph will break, or both.

## Skeleton

```yaml
---
id: "unique-kebab-case-id"
title: "Human-Readable Title"
emoji: "Building"
cluster: architecture
parent: "parent-node-id"
image: "assets/hero.jpg"
sprite: "assets/sprite.png"
connections:
  - to: "other-node-id"
    description: "how they relate"
---
```

## Field reference

| Field | Required | Type | Notes |
|---|---|---|---|
| `id` | yes | string (kebab-case) | Unique node identifier. Must match the filename slug (filename: `<id>.md`). Lowercase letters, digits, hyphens only. |
| `title` | yes | string | Display title shown in cards and graph nodes. |
| `cluster` | yes | string | Cluster key. SHOULD be declared in `content/config.yaml`. Undeclared clusters render with auto-assigned colors and trigger a warning. |
| `emoji` | recommended | string | Either a Unicode emoji ("🏗️") or a Fluent icon name ("Building"). Fluent names render as crisp SVGs and are preferred. |
| `parent` | optional | string | id of another node. Establishes hierarchy and contributes to the graph layout. |
| `image` | optional | path | Hero image (used when `visuals.mode: heroes`). Relative to the content directory. |
| `sprite` | optional | path | Sprite image (used when `visuals.mode: sprites`). |
| `connections` | optional | list | Outgoing edges. Each entry has `to` (node id) and `description` (short verb phrase). |

## Connections list

```yaml
connections:
  - to: "auth-flow"
    description: "authenticates requests through"
  - to: "issue-42"
    description: "tracked in"
  - to: "dir-src"
    description: "implemented under"
```

Acceptable `to:` values:

| Form | Example | Source |
|---|---|---|
| Authored node id | `auth-flow` | Another file in the content directory. |
| `issue-N` | `issue-42` | Issue from the source repo. |
| `pr-N` | `pr-17` | Pull request from the source repo. |
| `dir-<name>` | `dir-src` | A top-level directory in the source repo. |
| `readme` | `readme` | The repo README. |
| `repo-root` | `repo-root` | The repository as a whole. |

Anything else triggers a `dead-connection` warning in `kbexplorer audit`.

## Empty connections — be explicit

Always include `connections: []` rather than omitting the field, so the
frontmatter unambiguously declares "no outgoing edges, yet". This makes
diffs cleaner when edges are added later.

```yaml
connections: []
```

## Citation format inside the body

The body of the page should cite specific lines of source code. Two formats
exist, both recognised by `kbexplorer affected`:

| Style | Use when | Example |
|---|---|---|
| **Linked** | A remote source repo URL is known | `[src/auth.ts:42](https://github.com/o/r/blob/main/src/auth.ts#L42)` |
| **Local** | Repo is local-only or URL is unknown | `(src/auth.ts:42)` |

Line ranges: `#L42-L58` (linked) or `(src/auth.ts:42-58)` (local).

After every Mermaid diagram, add a `<!-- Sources: ... -->` HTML comment
listing the source files depicted. This both attributes the diagram and
gives the explorer/auditor a structured reference index.

## Examples

### Minimal valid

```yaml
---
id: "home"
title: "Home"
cluster: overview
connections: []
---

# Home

Welcome.
```

### Hierarchy + connections

```yaml
---
id: "worker-pool"
title: "Worker Pool"
emoji: "Engine"
cluster: runtime
parent: "core"
connections:
  - to: "job-queue"
    description: "drains tasks from"
  - to: "metrics"
    description: "publishes counters to"
---
```

### Heroes visual mode

```yaml
---
id: "intro"
title: "Why kbexplorer"
cluster: overview
image: "assets/heroes/intro.jpg"
connections: []
---
```

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Page does not appear in the graph | Missing `id` or `cluster` | Add the required field; re-run `kbexplorer audit`. |
| "duplicate-id" error | Same `id` declared in two files | Pick one; delete or rename the other. |
| "broken-parent" error | `parent:` points to a non-existent id | Either create the parent node, or remove the `parent:` line. |
| "parent-cycle" error | Hierarchy chain loops back on itself | Break the cycle; usually one of the nodes should have no parent. |
| Cluster shows a random color | Cluster key not declared in `config.yaml` | Add it under `clusters:` with a name and color. |
| Connection appears in graph but has no description on hover | Empty `description:` field | Use a short verb phrase; "related to" is forbidden — see `connections.md`. |
