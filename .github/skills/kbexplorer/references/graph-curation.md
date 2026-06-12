# Graph curation — clusters, hierarchy, refactoring

Day-2 graph maintenance: rename a cluster, recolor it, move nodes between
clusters, change parent-child relationships, merge two nodes, split one node
into many, prune orphans. These are the operations that keep the graph
legible as content grows.

Always run `kbexplorer audit && kbexplorer links` before AND after any
curation pass so you can see what changed.

## The cluster manifest

Clusters are declared in `content/config.yaml`:

```yaml
clusters:
  overview:
    name: "Overview"
    color: "#4A9CC8"
  runtime:
    name: "Runtime"
    color: "#8CB050"
  security:
    name: "Security"
    color: "#C04040"
```

Every node's frontmatter `cluster:` field references one of these keys. A
cluster present in content but not declared here will render with an
auto-assigned color and trigger an `undeclared-cluster` warning in
`kbexplorer audit`.

## Operation: rename a cluster

Renaming the cluster KEY requires updating every node that references it.

1. Edit `config.yaml`: change the key.
2. Use grep to find every reference: `grep -rln "^cluster: oldkey" content/`.
3. Update each file's `cluster:` line.
4. Run `kbexplorer audit` — there should be no new warnings.

Renaming only the DISPLAY NAME (`name:` field) requires no node edits.

## Operation: recolor a cluster

Edit `name:` and/or `color:` in `config.yaml`. No node edits required.
Reload the explorer (`Ctrl-R` in the browser) to see the change.

Good color choices:

- High contrast against the dark theme background (`#0a0a14` by default).
- Visually distinct from neighbouring clusters in the graph view.
- For domain-meaningful colors: red for security/risk, green for healthy,
  amber for in-progress, blue for foundational.

## Operation: move a node to a different cluster

1. Edit the node's frontmatter — change `cluster:`.
2. Reconsider connections — does this node still connect to the right
   neighbours? Cross-cluster edges are healthy; if all of this node's
   connections are now in a different cluster from itself, the move may be
   correct but its connections need pruning.
3. Run audit + links.

## Operation: introduce a new cluster

Use this when several nodes share a topic that doesn't fit any existing
cluster.

1. Add the cluster to `config.yaml` (`name`, `color`).
2. For each node that belongs to it: change frontmatter `cluster:`.
3. Optionally add a parent node summarizing the cluster, and set
   `parent:` on its members.
4. Audit + links.

## Operation: change a node's parent

Just edit the `parent:` field. Then:

- Audit will catch `broken-parent` if the new parent doesn't exist.
- Audit will catch `parent-cycle` if the move creates a loop.

If you're moving many nodes under a new parent, create the parent node FIRST
(`kbexplorer scaffold`), then update children.

## Operation: merge two nodes

Use this when two nodes cover overlapping ground and the distinction is
artificial.

1. Pick the SURVIVOR (the node id you'll keep).
2. Manually merge the content of the LOSER into the survivor — preserve
   citations, diagrams, and any commentary worth keeping.
3. Add a connection from the survivor to anywhere the LOSER had outgoing
   connections (skip duplicates).
4. Search content for any incoming connection to the LOSER:
   `grep -rln 'to: "loser-id"' content/`
5. Rewrite each to point to the survivor. Update the `description:` if the
   relationship's meaning changed.
6. Delete the LOSER file.
7. Audit + links — there should be no `dead-connection` warnings.

## Operation: split one node into many

Use this when a node has grown unwieldy or covers multiple distinct topics.

1. Identify the new node ids and their boundaries.
2. `kbexplorer scaffold` each new node (set the original node as `parent:` if
   appropriate).
3. Move sections from the original into each new node, preserving citations.
4. Update connections:
   - Connections that pointed to the original may need to be redirected to a
     specific child.
   - Add connections among the new children if they reference each other.
5. Decide what to do with the original:
   - Keep it as an overview/landing node with high-level prose and
     `children` references in the body.
   - Or delete it (then run the dead-connection cleanup from the merge
     procedure).
6. Audit + links.

## Operation: prune orphans

`kbexplorer links` reports orphan nodes — nodes with zero edges. For each:

| Why orphaned | Fix |
|---|---|
| Genuinely unrelated content | Decide if the node should exist at all. If yes, add at least one connection to a relevant parent or sibling. If no, delete the file. |
| Author forgot to add connections | Add them. |
| Was connected via inline link only | Move the inline link into the `connections:` frontmatter, or audit the redundant-frontmatter rule and accept inline-only. |

## Operation: rebalance a deep hierarchy

If `parent` chains get more than ~4 levels deep, navigation degrades. To
flatten:

1. Identify the deepest chain (manual inspection of frontmatter).
2. Promote intermediate nodes by removing their `parent:` and pointing them
   at the cluster root, or at a higher ancestor.
3. Add explicit `connections` to preserve the relationships that the
   hierarchy was carrying.

## Anti-patterns

| Don't | Reason |
|---|---|
| Rename ids casually | Every file that links to the old id breaks silently. Use grep to find them first. |
| Edit `config.yaml` and not re-run audit | Undeclared-cluster warnings hide in the noise. |
| Build a 6-level-deep hierarchy | The reading-view breadcrumb gets unreadable; the graph layout pancakes. |
| Use clusters for ad-hoc labels | If a cluster has 1–2 nodes and no shared color story, fold it into a sibling cluster and use `parent` instead. |
