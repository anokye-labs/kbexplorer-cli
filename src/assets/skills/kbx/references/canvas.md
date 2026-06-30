# The kbexplorer canvas (presenting the graph)

The kbx plugin ships an interactive **canvas** — a bespoke side-panel surface
that renders the knowledge graph the affordance tools act on. The canvas and
the `kbx_*` action tools are delivered together in one `joinSession` call, so
"act on the graph → the canvas updates" happens in-process with no MCP
round-trip.

## What the canvas is

| Property | Value |
|---|---|
| Canvas id | `kbexplorer` |
| Display name | kbexplorer Knowledge Graph |
| Open input | `{ nodeId?: string }` — optional node to focus on open |
| Role | Visual surface; the `kbx_*` tools are the *actions* that drive it |

The canvas renders the same `content/` graph that `kbx dev` / `kbx build`
serve. Authoring still happens in `content/*.md` and `content/config.yaml`
(see `frontmatter.md`, `configuration.md`, `presentation.md`) — the canvas is
how the user *sees and navigates* it.

## How to use it in a session

- **Focus a node for the user.** When you've found or written a node, open the
  canvas focused on it (`{ nodeId: "<id>" }`) so the user sees what you mean
  instead of reading an id.
- **Pair reads with the view.** After `kbx_search` / `kbx_query_node`, surface
  the result on the canvas rather than pasting raw frontmatter into chat.
- **Validate visually.** The `Validate visually` invariant in `SKILL.md` still
  applies: confirm affected nodes render correctly. The canvas is the in-plugin
  equivalent of running `kbx dev` and opening the browser.

## Relationship to the action tools

The canvas is a **presentation** surface; the `kbx_*` tools in `search.md` are
the **action** surface. They share one engine and one graph:

- `kbx_search` / `kbx_query_node` / `kbx_graph_neighbors` find and read nodes →
  open or focus them on the canvas.
- `kbx_audit` keeps the graph the canvas renders structurally valid.
- `kbx_derive` (write) extends the graph; re-open the canvas to see new nodes.

When no canvas runtime is available (plain CLI / desktop without the plugin),
fall back to `kbx dev` for the browser-based explorer — it renders the same
graph from `content/`.
