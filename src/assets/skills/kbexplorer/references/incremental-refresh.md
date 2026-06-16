# Incremental refresh — keep content in sync with code

When source code changes, the KB drifts. This workflow uses
`kbexplorer affected` to map a code diff to the impacted nodes, then drives
a focused refresh of only those pages.

This is the difference between "regenerate everything" (slow, destroys
authored edits) and "I know exactly which 4 pages need attention".

## When to run

- After merging a feature branch.
- Before opening a documentation PR.
- On a schedule (e.g., weekly housekeeping).
- After a refactor that moved files or renamed symbols.

## Step 1 — Pick a baseline ref

The git ref to diff against. Usually one of:

| Ref | Meaning |
|---|---|
| `HEAD~1` | Just the last commit. |
| `main` | Everything since the branch diverged from main. |
| A SHA / tag | Everything since a known checkpoint. |
| (none) | Working-tree changes only (defaults to `HEAD`). |

## Step 2 — Compute affected nodes

```bash
kbexplorer affected <ref>
```

Example output:

```
  Ref:              main
  Changed files:    7
  Indexed nodes:    24
  Affected nodes:   3
  Uncited changes:  4

Affected node ids:
  • auth-flow
  • worker-pool
  • job-queue

File → node mapping:
  src/auth.ts
    → auth-flow
  src/worker.ts
    → worker-pool
    → job-queue

Uncited changed files (consider adding nodes that cover them):
  src/metrics/exporter.ts
  src/metrics/registry.ts
  ...
```

Get machine-readable output with `--json` to script next steps.

## Step 3 — Triage the affected list

For each affected node, decide:

| Code change type | Likely action |
|---|---|
| Pure refactor (renames, file moves) | Just update line numbers + paths in citations. |
| Behavioural change | Re-read source; update diagrams + claims. Follow `update-node.md`. |
| New feature added to a covered area | Add a new section to the node; possibly add a new connection. |
| Functionality removed | Remove the corresponding section; consider deleting the node. |

Work through nodes one at a time using `update-node.md`. Do NOT batch-rewrite
without reading each one.

## Step 4 — Triage uncited changes

The `Uncited changes` list contains changed files that NO node currently
cites. Two outcomes:

- **The change is documentation-worthy** → use `add-node.md` to create a new
  page covering it. After scaffolding and writing, re-run `kbexplorer affected`
  on the same ref — the file should now appear under the new node.
- **The change is internal noise** (formatter, version bump, test fixture)
  → leave it alone. Not every line of code needs a KB node.

## Step 5 — Curation pass

After an incremental refresh, the graph topology may need adjustment:

- If you added several new nodes in a related area, consider grouping them
  under a new `parent` or creating a new `cluster` — see `graph-curation.md`.
- If you deleted nodes, prune incoming connections from neighbours.

## Step 6 — Validate

```bash
kbexplorer audit          # hard errors must be 0
kbexplorer links          # check for new orphans / weak clusters
```

Preview each touched page in the explorer.

## CI integration

A common pattern: gate a documentation PR on the audit, and warn (don't
block) on affected coverage.

```yaml
# .github/workflows/kb-check.yml
- run: npx kbexplorer audit                       # fails the job on errors
- run: npx kbexplorer affected origin/main --json > affected.json
- run: |
    count=$(jq '.affected | length' affected.json)
    uncited=$(jq '.uncited | length' affected.json)
    echo "Affected nodes: $count"
    echo "Uncited changed files: $uncited"
```

## Limitations of `kbexplorer affected`

- It can only see what your content cites. Pages that should cover a file but
  don't won't appear — that's what the `uncited` list is for.
- It does partial-path matching (suffix) so a citation to `src/auth.ts` will
  match a changed `packages/x/src/auth.ts`. This is intentional but can
  produce false positives in monorepos with shadow names; verify by hand.
- It does not parse imports — only literal `(path:line)` or `[path:line](url)`
  citations in markdown bodies (plus `<!-- Sources: -->` comments).
