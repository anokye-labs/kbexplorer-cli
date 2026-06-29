# Connections — derivation rules

Connections are the edges in the knowledge graph. Good connections turn a
collection of pages into a navigable map; bad connections turn it into noise.

## When to add a connection

Add a `connections:` entry between nodes A and B when at least one of these
is true:

| Reason | Example |
|---|---|
| Code in A's covered files imports / calls into B's covered files | `auth-flow → token-store` |
| Data flows from A to B at runtime | `event-bus → metrics-exporter` |
| A's topic is impossible to understand without B's | `worker-pool → job-queue` |
| A is a specialisation or implementation of B | `redis-cache → cache-interface` |
| A's behavior is configured by B | `dispatcher → config-loader` |
| A is tracked / spec'd by an issue or PR | `migration-plan → issue-42` |

## When NOT to add a connection

| Don't connect | Why |
|---|---|
| Two unrelated leaves in the same cluster | Cluster membership already groups them visually. |
| Every page back to "home" or "overview" | This makes the overview node a degree-100 hairball. Use parent/cluster instead. |
| Things that "share a vibe" | If there's no concrete code, data, or behavioural relationship, there's no edge. |
| Pairs of pages that mutually reference each other in prose | An inline link is enough — only promote to frontmatter when the relationship is structural. |

## Connection direction

Connections are directional in the graph. From A's frontmatter:

```yaml
connections:
  - to: "b"
    description: "authenticates against"
```

… renders as `A → B`. If the relationship is genuinely bidirectional and
both directions matter (e.g., a long-running coupling between two services),
declare it from BOTH sides. If only A "uses" B and B doesn't know about A,
declare it from A only.

## Writing good descriptions

The `description` field appears on edge hover in the graph view and on
connection chips in the reading view. It is short, lowercased, verb-led.

✅ Good — specific verb phrase:

- `authenticates requests through`
- `renders via`
- `feeds events to`
- `extends the contract of`
- `is configured by`
- `tracks the migration in`

✗ Forbidden — vague or filler:

- `related to`
- `see also`
- `connected`
- `uses` (without saying what for — at least `uses for caching`)
- `references` (when not literal — say what aspect)

Rule of thumb: if you delete the description, would the reader still
understand the edge? If yes, the description is filler.

## Special targets

Some `to:` values reference entities the explorer synthesises rather than
authored content files:

| Target | What it means |
|---|---|
| `issue-N` | Issue number N from the source repo. |
| `pr-N` | Pull request number N. |
| `dir-<name>` | A top-level directory in the repo (e.g. `dir-src`, `dir-scripts`). |
| `readme` | The repo's README.md as a node. |
| `repo-root` | The repository as a whole. |

The audit accepts these without warning. Anything else must be an authored
node id, or it becomes a `dead-connection` warning.

## Frontmatter vs inline links

Authored content can also reference other nodes via plain markdown links
(`[Auth Flow](auth-flow)`). These render as inline links in the body and
ALSO count as edges in the graph.

| Use frontmatter `connections` | Use inline link |
|---|---|
| Structural relationship that matters at the graph level. | A passing reference in prose. |
| The edge should appear on graph hover with a description. | Reader will see the link in context. |
| You want the connection to survive even if the prose is rewritten. | The reference is tied to a specific sentence. |

`kbx links` flags `redundantFrontmatter` when both forms reference
the same target — pick one. For structural edges, prefer frontmatter
(survives rewrites); for prose references, prefer inline (reads better).

## Deriving connections from code

A practical heuristic for finding the right connections during the
architect/writer playbooks:

1. List the source files cited by node A.
2. Grep their imports / requires.
3. For each imported module, find which other node cites it.
4. That node is a connection candidate. Write a description that names the
   actual interaction (`drains tasks from`, not `imports`).

The CLI doesn't automate this yet, but it's the procedure to follow when
you're writing connections by hand.

## Validating connections

```bash
kbx audit            # catches dead connections (typos, deleted nodes)
kbx links            # surfaces weak clusters (no cross-cluster edges)
                            # and unlinkified mentions (text mentions another
                            # node by title but doesn't link)
```

A healthy graph typically has:

- Most nodes with 2–5 outgoing connections (very few orphans, very few
  hairballs of 20+).
- At least one cross-cluster edge from every multi-node cluster.
- No dead connections.

