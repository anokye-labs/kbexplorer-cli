# Add a single node — workflow

When the user wants to add ONE new topic without regenerating the whole graph.
Use this workflow instead of `kbx generate` whenever the rest of the
graph is already in good shape.

## Decision tree

```
User wants to add a topic →
   Is this a brand-new area of the codebase with many sub-topics?
      Yes → switch to architect-playbook.md (catalogue-driven)
      No  → continue here
```

## Step 1 — Pick the metadata

Before writing anything, decide:

| Question | How to decide |
|---|---|
| **id (slug)** | Kebab-case, unique. Look at the current `content/` directory for naming conventions (`auth-flow` not `AuthFlow`). |
| **title** | Human-readable. Will be used in cards, graph node labels, and the page heading. |
| **cluster** | MUST exist in `content/config.yaml`. Run `kbx audit` first to see declared clusters; create a new one only if no existing cluster fits — see `graph-curation.md`. |
| **parent** | Optional. Pick the closest existing node that conceptually contains this one. |
| **emoji** | Either Unicode or a Fluent icon name (see `frontmatter.md`). If unsure, omit it — scaffold will infer one from title + cluster. |

## Step 2 — Scaffold the file

Use the CLI to create a valid skeleton — never hand-create the frontmatter
from scratch; the scaffold is deterministic and audit-clean.

```bash
kbx scaffold <slug> --cluster <id> [--parent <id>] [--title "..."] [--emoji "..."]
```

Examples:

```bash
# Minimal — title and emoji inferred
kbx scaffold worker-pool --cluster runtime

# Full
kbx scaffold auth-flow \
  --cluster security \
  --parent core \
  --title "Authentication Flow" \
  --emoji LockClosed
```

This creates `content/<slug>.md` containing valid frontmatter, a writer-brief
HTML comment, and a placeholder body. The file passes `kbx audit`
immediately.

## Step 3 — Fill in the content

Open the scaffold and follow `writer-playbook.md` for the body. The short
version:

1. Read every source file you intend to cite, end to end.
2. Plan: 3–5 Mermaid diagrams (at least 2 different types), 5+ file citations.
3. Write structured Markdown with citations after every claim.
4. Add `<!-- Sources: ... -->` after each diagram.

## Step 4 — Wire it into the graph

The scaffold leaves `connections: []`. Edit the frontmatter to add edges to
related nodes. Follow `connections.md` for what counts as a valid edge and
how to phrase descriptions.

```yaml
connections:
  - to: "core"
    description: "extends"
  - to: "job-queue"
    description: "drains tasks from"
```

If the parent or a sibling should also link back, edit those files too —
connections in this graph are directional; the explorer does not auto-create
inverse edges.

## Step 5 — Validate

Run both checks. Both must pass before declaring done.

```bash
kbx audit          # hard structural errors — must be 0
kbx links          # soft graph health — investigate any new warnings
```

If audit reports `undeclared-cluster`, either add the cluster to
`config.yaml` (preferred) or change the node to use an existing cluster.

## Step 6 — Preview

```bash
npx kbx dev
```

Open the explorer, find the new node, and verify:

- Title and emoji render correctly.
- The node sits in the right cluster (right color, right group).
- Connections appear as edges in the graph view.
- Clicking the node opens the reading view with rendered Mermaid + working
  citation links.

If validation tooling is available (playwright-cli, computer-use MCP), use it.

## When NOT to use add-node

| Situation | Use this instead |
|---|---|
| You want to map an unfamiliar repo for the first time | `architect-playbook.md` |
| You're refreshing existing pages after code changes | `incremental-refresh.md` |
| You want to reorganize clusters or move several nodes | `graph-curation.md` |
| You want to merge or split nodes | `graph-curation.md` |

