# kbexplorer mcp — knowledge-graph MCP server

`kbexplorer mcp` runs a **Model Context Protocol server** over stdio that turns
the repo's knowledge graph into a queryable, intelligence-grade source for any
MCP host (GitHub Copilot CLI, Claude, or any compliant client). It is the
graph-native sibling of "work IQ" / "web IQ" style assistants: instead of
shipping a model and API keys, kbexplorer **borrows the host's model through MCP
sampling** and grounds every answer in graph context that is **scoped by the
client's declared roots**.

This document is the engineering design and implementation reference for issue
[#5](https://github.com/gaming-microsoft/kbexplorer-cli/issues/5). The server is
now implemented on the official MCP SDK (`src/commands/mcp.js`); a few sections
still marked _(planned)_ describe phase-2 behavior not yet built.

```
        ┌──────────────────────────────────────────────┐
        │  MCP Host (Copilot / Claude / other client)  │
        │   • owns the model      • owns the roots     │
        └───────────────┬───────────────▲──────────────┘
       stdio JSON-RPC   │               │  server→client requests
       (ndjson, bidir)  ▼               │  (roots/list, sampling/createMessage)
        ┌──────────────────────────────────────────────┐
        │             kbexplorer mcp server            │
        │  tools  ◀─ graph-native nav ─▶  KB graph     │
        │  kb_ask · kb_get_node · kb_neighbors · …     │
        └───────────────────────┬──────────────────────┘
                                 ▼
                 content/*.md frontmatter + manifest
                 (loaded ONLY within granted roots)
```

## Why this shape

- **No model, no keys in kbexplorer.** The expensive, secret-bearing part —
  the LLM call — stays in the host. kbexplorer asks the host to run a completion
  via `sampling/createMessage`. This mirrors the CLI's existing
  adapter-agnostic philosophy ([copilot-runtime.md](copilot-runtime.md)): we
  never embed a vendor model, we delegate to whatever the user already runs.
- **Roots bound what we read and what we share.** The client tells the server
  which directories it has granted (`roots`). The server loads graph nodes
  **only from within those roots**, and only the caller-supplied nodes are
  placed into the sampling request. Roots are both a security boundary and a
  relevance boundary.
- **Graph-native navigation, no keyword search.** The host model explores the
  graph explicitly via `kb_graph_stats` → `kb_neighbors` → `kb_get_node`, then
  supplies specific node ids to `kb_ask` for grounded sampling. There is no
  lexical keyword ranker — context assembly is transparent and deterministic.
- **Built on the official MCP SDK.** The server uses
  [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
  (`McpServer` + `StdioServerTransport`, with `zod` tool schemas) rather than a
  hand-rolled JSON-RPC-over-stdio harness.

## Requirements

- An MCP **host** that launches the server over stdio and, for full
  functionality, advertises the **`sampling`** and **`roots`** client
  capabilities. Both degrade gracefully (see [Degradation](#degradation)).
- Node `>= 22` (same as the rest of the CLI). No `gh`, no network, no template
  install required — `mcp` is a deterministic, in-process server.

## Running it

```bash
kbexplorer mcp                       # serve over stdio (the normal mode)
kbexplorer mcp --root <dir>          # add an explicit root (repeatable) when the
                                     # host does not advertise the roots capability
kbexplorer mcp --no-sampling         # force degraded mode: never call the host model
```

Declare it to a host via that host's MCP config — Copilot
(`~/.copilot/mcp-config.json`) or Claude repo-local (`.mcp.json`). A ready-to-use
example lives at [`examples/copilot-mcp-config.json`](../examples/copilot-mcp-config.json):

```json
{
  "mcpServers": {
    "kbexplorer": { "command": "npx", "args": ["-y", "kbexplorer", "mcp"] }
  }
}
```

For an unpublished checkout, point the host at the local entrypoint instead:
`{ "command": "node", "args": ["bin/cli.js", "mcp"] }` with `cwd` set to the
repo root.

## Protocol surface

The server speaks JSON-RPC 2.0 framed as newline-delimited JSON. Protocol
version negotiation is handled by the SDK's `StdioServerTransport`.

### Capabilities exchange

On `initialize` the server:

1. Advertises its own capabilities: `{ tools: {}, resources: {} }`.
2. **Reads the client's capabilities** from the `initialize` params and records
   whether `roots` and `sampling` are present. Every later decision keys off
   these flags — the server never issues a server→client request the client
   did not advertise support for.

### Tools

| Tool | Sampling? | What it does |
|---|---|---|
| `kb_ask` | **yes** (host model) | NL question → retrieve top-K relevant nodes within roots → assemble a scoped context bundle → `sampling/createMessage` → return a grounded answer + node-id citations. The "intelligence" query. |
| `kb_query` | no | Deterministic keyword + graph retrieval (a lexical query, not semantic search). Returns node ids, titles, clusters, and snippets. The substrate `kb_ask` is built on, exposed directly for hosts that prefer to do their own reasoning. |
| `kb_get_node` | no | Fetch one node: frontmatter + body + outgoing/incoming edges. |
| `kb_neighbors` | no | Graph expansion from a node id to depth N (edges from `connections`, parent/child, issue/PR cross-refs). |
| `kb_graph_stats` | no | Counts by cluster, edge totals, orphans — a fast orientation call. |

Tool results follow MCP convention: a single `text` content block whose `text`
is the JSON-stringified payload (the in-repo `shapeToolResult` helper wraps each
tool's return value this way).

### Resources _(optional, phase 2)_

Expose each node as an MCP resource `kb://node/<id>` so hosts can subscribe to or
directly read graph nodes without a tool call. Resource listing is also scoped to
roots.

## The `kb_ask` flow

`kb_ask` is the work_iq/web_iq analogue. It is **retrieval-augmented sampling**:

```
kb_ask({ question, maxNodes? })
  │
  1. roots = current granted roots (cached from roots/list)
  2. nodes = loadGraph(roots)                 # bounded by roots
  3. hits  = retrieve(nodes, question, K)     # keyword score + graph expansion
  4. bundle = renderContext(hits)             # ids, titles, clusters, bodies, edges
  5. if client.sampling:
  6.     answer = sampling/createMessage({     # ← server asks the HOST's model
                    systemPrompt: KB_GROUNDING_PROMPT,
                    messages: [ user(question + bundle) ],
                    modelPreferences, maxTokens })
  7.     return { answer, citations: hits.map(h => h.id), usedSampling: true }
  8. else:                                      # degraded — see below
  9.     return { contextBundle: bundle, citations, usedSampling: false }
```

Retrieval (step 3) reuses the graph-building and scoring logic already present
in [`src/commands/links.js`](../src/commands/links.js) and
[`src/lib/manifest.js`](../src/lib/manifest.js); it will be factored into a
shared `src/lib/graph.js` so both `links` and `mcp` consume one implementation.

The grounding system prompt instructs the host model to answer **only** from the
provided nodes, to cite node ids, and to say when the graph does not cover the
question — the same discipline that keeps work_iq answers trustworthy.

## Roots scoping

```
initialize        → record client.capabilities.roots
(after init)      → if roots supported: roots/list → cache granted dirs
on graph load     → walk content/ + manifest ONLY under a granted root
notifications/roots/list_changed → re-run roots/list, invalidate the graph cache
```

- A node whose source path is **outside** every granted root is never loaded,
  never retrieved, and never placed into a sampling request.
- If the client does **not** advertise `roots`, the server falls back to the
  process working directory (and any `--root` flags), and logs that it is
  unscoped.

## Degradation

The server is useful even against minimal hosts:

| Missing capability | Behavior |
|---|---|
| `sampling` | `kb_ask` returns the assembled **context bundle + citations** instead of a model answer (`usedSampling: false`). The host can then reason over it with its own model. All deterministic tools are unaffected. |
| `roots` | Fall back to cwd + `--root` flags. A warning is emitted on stderr; the graph is loaded unscoped. |

`--no-sampling` forces the degraded `kb_ask` path even when the host supports
sampling (useful for debugging retrieval in isolation).

## Implementation (as built)

The server is the SDK's `McpServer` connected over `StdioServerTransport`
(`src/commands/mcp.js`). The SDK supplies exactly the machinery a
sampling/roots server needs and that the original design flagged as hard to
hand-roll:

- **Bidirectional requests.** Sampling and roots require the server to
  *originate* requests and await the client's response on the same stdio
  channel. The low-level `Server` exposes `createMessage()`
  (`sampling/createMessage`) and `listRoots()` (`roots/list`); tool handlers
  call these directly.
- **Capability gating.** `getClientCapabilities()` reports what the client
  advertised; the server never issues a server→client request the client did
  not declare support for.
- **Lifecycle.** `oninitialized` warms the granted roots after the handshake,
  and a `roots/list_changed` notification handler invalidates the cached graph
  so the next query reloads within the new roots.
- **Tools** register via `registerTool(name, { description, inputSchema },
  handler)`, where `inputSchema` is a `zod` raw shape — each tool gets validated
  arguments for free.

`createKbMcpServer()` is the testable factory: it returns the wired `server`
plus internal handles so the in-memory and subprocess tests can drive it without
a real host (see `tests/commands/mcp.test.js` and
`tests/commands/mcp-stdio.test.js`).

## Security

- **Root confinement** is the primary control: file reads for graph loading are
  restricted to granted roots; a path-traversal guard rejects anything resolving
  outside them.
- **No secrets ever enter kbexplorer.** Sampling means the model call (and any
  associated keys/tokens) lives entirely in the host.
- **Sampling is opt-in by the host.** Per MCP, the host mediates and may prompt
  the user before honoring a `sampling/createMessage`; kbexplorer cannot bypass
  that.
- **Read-only.** The server exposes no mutation tools; it never writes to the
  repo.

## Interaction with the rest of the CLI

- **`doctor`** _(planned)_ gains an `mcp` self-check: confirm the server starts,
  handshakes, and reports whether the configured host advertises sampling/roots.
- **`mcp-preflight`** is unchanged — it verifies that *other* servers a fuzzy
  phase depends on are configured. `kbexplorer mcp` is itself such a server; a
  host that wants graph intelligence simply declares it (example above).
- **Graph source of truth** stays `content/` + manifest. `mcp` adds no new
  authoring surface; it is a read path over the same data `dev`, `links`, and
  `audit` already consume.

## Open questions / assumptions

- **Host sampling coverage is uneven.** Not every MCP client implements
  `sampling/createMessage` yet. The degradation path makes `kb_ask` useful
  regardless, but the headline "ask the graph a question and get an answer"
  experience depends on host support.
- **Retrieval quality.** v1 uses transparent keyword scoring + graph expansion
  (no embeddings — retrieval stays offline and built-ins-only). An optional
  embedding-backed retriever could be a later, opt-in enhancement.
- **Resource exposure** (`kb://node/<id>`) is deferred to a second phase to keep
  the first cut tool-only.
