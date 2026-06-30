# Searching and querying the graph (affordance tools)

When a kbx plugin is installed, the graph is not a pile of markdown you grep
by hand — it exposes a **protocol-neutral action surface** (the "do-seam").
Every action is delivered as a Copilot CLI tool named `kbx_<action>` by the
kbx extension, and the *same* contract is (or will be) re-exposed by the kbx
MCP server. Prefer these tools over ad-hoc file scanning: they read the graph
the canvas renders, so the agent and the user stay in sync.

## The read/sample tools

| Tool | Class | Use it to |
|---|---|---|
| `kbx_search` | read | Cosine-similarity search over checked-in search artifacts; returns ranked kbx-native results. Your first move when you don't know the node id. |
| `kbx_query_node` | read | Fetch a single node (frontmatter + full body) by id. Use after `kbx_search` to read the whole page. |
| `kbx_graph_neighbors` | read | Breadth-first neighbours of a node up to a given depth (max 4). Use to discover what already connects to a node before authoring `connections`. |
| `kbx_affected` | read | List content nodes whose citations reference files changed in a git ref (or an explicit file list). Use to scope an incremental refresh. |
| `kbx_audit` | read | Structural integrity audit of `content/` (duplicate ids, broken parents, cycles, dead connections). Use before declaring any change done. |
| `kbx_llm_context` | sample | Assemble a grounded context bundle and citations from explicit node ids for a model to reason over. **Does not call a model** — it only gathers the grounded material. |

## Typical flows

**"What does the graph already say about X?"**

1. `kbx_search { query: "X" }` → ranked candidate nodes.
2. `kbx_query_node { id: "<top hit>" }` → read the full page.
3. `kbx_graph_neighbors { id: "<top hit>", depth: 2 }` → see what it connects to.

**"Author connections that reflect the real graph, not guesses"**

- Resolve neighbours with `kbx_graph_neighbors` first; only add a `connection`
  in frontmatter when a real relationship exists (see `connections.md`).

**"Ground a new/refreshed page before writing"**

- `kbx_llm_context { ids: [...] }` returns the bundle + citations to reason
  over — feed it, don't fabricate. Citations still follow the `Cite or strike`
  invariant in `SKILL.md`.

## Why tools over hand-rolled logic

The deterministic CLI commands (`kbx audit`, `kbx affected`, …) and these
affordance tools share one engine. Using `kbx_*` means:

- you read exactly what the canvas shows the user;
- inputs are schema-validated (bad ids/depths fail loudly, not silently);
- the action class (read / sample / write) is explicit, so a consent layer can
  reason about side effects.

When no plugin/extension runtime is present, fall back to the deterministic CLI
commands listed in `SKILL.md` — they compute the same answers offline.
