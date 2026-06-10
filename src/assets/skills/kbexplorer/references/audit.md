# Audit — schema and structural integrity

`kbexplorer audit` is the hard-error linter for content. It complements
`kbexplorer links` (soft graph-health analysis) by catching the issues that
will break or silently corrupt the explorer at runtime.

Run audit before every commit that touches `content/` and gate CI on it.

## Quick reference

```bash
kbexplorer audit                  # human report, exits 1 on any error
kbexplorer audit --json           # machine-readable JSON
kbexplorer audit --content docs   # override content directory
```

## Severity model

| Severity | Meaning | Exit code impact |
|---|---|---|
| **error** | The explorer will fail to render correctly or the graph will be silently wrong. | Causes non-zero exit. |
| **warning** | Authorial intent is probably broken but the explorer still runs. | Does NOT fail the run. |

## Rule catalogue

### `malformed-frontmatter` — error

The file has no `---` block, or YAML inside the block didn't parse.

**Detect**: audit reports the file and parser error.

**Fix**: open the file; ensure the frontmatter looks like:

```yaml
---
id: "..."
title: "..."
cluster: ...
---
```

No tabs, no smart quotes, no leading whitespace before keys.

### `missing-required-field` — error

`id`, `title`, or `cluster` is missing from the frontmatter.

**Fix**: add the field. See `frontmatter.md` for the schema.

### `duplicate-id` — error

The same `id` value is declared in two or more files.

**Fix**: pick which file owns the id. Rename the other(s) — both filename
slug and the `id:` field — and update any `connections.to` and inline
`[text](old-id)` references.

```bash
# find inline references to the doomed id
grep -rln 'old-id' content/
```

### `broken-parent` — error

A node's `parent:` points to an id that does not exist.

**Fix**: either create the parent (`kbexplorer scaffold <parent-id> --cluster …`)
or remove the `parent:` line.

### `parent-cycle` — error

The parent chain loops back on itself (A → B → A or A → A).

**Fix**: break the chain. The most common cause is renaming an id without
updating the children's `parent:` fields. Identify the smallest cycle and
remove one parent reference.

### `filename-id-mismatch` — warning

`content/foo.md` declares `id: "bar"`. This isn't a runtime error but it
breaks navigation conventions (URLs and links assume filename === id).

**Fix**: rename the file OR change the id so they match.

### `undeclared-cluster` — warning

A node's `cluster:` references a key that isn't under `clusters:` in
`config.yaml`. The explorer auto-assigns a color, but you lose control
over naming and palette.

**Fix**: add the cluster to `config.yaml`:

```yaml
clusters:
  newcluster:
    name: "Display Name"
    color: "#hex"
```

### `dead-connection` — warning

A `connections.to` value references a node id that doesn't exist (and isn't
a built-in target like `issue-N`, `pr-N`, `dir-X`, `readme`, `repo-root`).

**Fix**: either correct the typo, point to a different target, or remove the
connection. After deleting/renaming nodes, this rule will fire across all
neighbours — clean them up in one pass.

### `read-error` — error

The file could not be read off disk (permissions, encoding, etc.).

**Fix**: inspect the file system; this is rarely a content problem.

## Recommended audit cadence

| When | What |
|---|---|
| Before every commit touching `content/` | `kbexplorer audit` |
| In CI on every PR | `kbexplorer audit` (gates merge) |
| After bulk operations (rename, merge, split) | `kbexplorer audit && kbexplorer links` |
| Weekly housekeeping | both, plus `kbexplorer affected origin/main` |

## What audit does NOT cover

| Concern | Where to find it |
|---|---|
| Orphan nodes (no edges) | `kbexplorer links` |
| Weak clusters (no cross-cluster edges) | `kbexplorer links` |
| Coverage gaps (source files no node cites) | `kbexplorer links` |
| Unlinkified mentions | `kbexplorer links` |
| Drift between code and content | `kbexplorer affected <ref>` + `update-node.md` |
| Diagram correctness, citation accuracy | Manual review against the source files. |

## CI snippet

```yaml
- name: KB audit
  run: npx kbexplorer audit
- name: KB graph health
  run: npx kbexplorer links
  continue-on-error: true        # warnings only
```
