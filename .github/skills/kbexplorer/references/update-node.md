# Update a single node — workflow

How to refresh ONE existing content page while preserving the author's prose,
hand-tuned diagrams, and intentional editorial decisions.

The naive failure mode is "regenerate from scratch", which silently destroys
the author's edits. This workflow avoids that.

## When to use this

- A small set of source files cited by the page have changed.
- Citations have drifted (line numbers no longer match the cited code).
- A new diagram or section is needed but the rest is fine.
- A reviewer asked for a specific tightening.

For bulk updates after a large change set, drive this workflow from
`incremental-refresh.md` (which uses `kbexplorer affected` to find the
candidate pages first).

## Step 1 — Read the existing page

Read the WHOLE file before touching anything. Note:

- The frontmatter — id, cluster, parent, current connections.
- The diagram types already in use (avoid changing them gratuitously).
- The structure (section order, table conventions).
- Any custom commentary or opinions — these are signal, not noise.

## Step 2 — Identify what changed

For each section, decide:

| Section status | Action |
|---|---|
| Cited code still exists, line numbers correct | Leave alone. |
| Cited code still exists, line numbers off | Update line numbers only. |
| Cited code moved or renamed | Update citation to the new location; check if the prose is still accurate. |
| Cited code deleted | Remove or rewrite the section; consider whether the page still needs to exist. |
| New code exists that the page should cover | Add a new section; update affected diagrams. |

A fast way to find drifted citations: run `kbexplorer affected <ref>` first,
then for each affected page open it and grep its citation list against the
current source.

## Step 3 — Re-read the source

For every section you intend to modify, read the cited source files in full
again. Names lie. Trace the actual code path. Do not paraphrase from memory.

## Step 4 — Surgical edits

Make the smallest edit that fixes the problem:

| Type of edit | Preserve |
|---|---|
| Update line number in a citation | Surrounding prose, diagram, table. |
| Update a code snippet | The surrounding explanation unless the code's behavior changed. |
| Update a diagram | The `<!-- Sources: -->` comment — update it to reflect the new source set. |
| Add a section | Existing section order; insert at the most appropriate point. |
| Add a connection | The full existing `connections:` list. |

Do NOT:

- Rewrite a section just because you would have phrased it differently.
- Replace a diagram of type X with type Y unless the underlying information
  is structurally different.
- Strip frontmatter fields the author added (image, sprite, custom keys).

## Step 5 — Update connections if structural relationships changed

If the code change introduced a new dependency, add a `connections` entry
pointing to the node that documents the new dependency. If a dependency was
removed, remove the corresponding connection. See `connections.md` for
phrasing rules.

## Step 6 — Validate

```bash
kbexplorer audit                          # must be 0 errors
kbexplorer links                          # check no new warnings introduced
```

Then preview the page in the explorer (`npx kbexplorer dev`, navigate to the
node) and confirm Mermaid renders, links resolve, and the layout still works.

## Edge cases

### The page is severely out of date

If more than ~40% of the page needs to change, prefer:

1. Save the current body somewhere safe.
2. Use `architect-playbook.md` to regenerate a fresh catalogue.
3. Carry the old commentary forward by hand into the new page.

### The cited source file no longer exists

Decide: did the functionality move (update the citation) or get removed
(rewrite the section, or delete the page and prune connections from
neighbours)? If you delete a page, you MUST also remove any connections in
other nodes that pointed to it — run `kbexplorer audit` afterwards to catch
the ones you missed.

### The page's `id` needs to change

Renaming an id is a graph-curation task — see `graph-curation.md`. Other
files reference this node by id; changing it without updating them produces
dead connections.
