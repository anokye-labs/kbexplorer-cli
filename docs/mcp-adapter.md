# MCP adapter (`kbx mcp`) — the optional, non-canvas delivery path

**PE3-F4 · [#156](https://github.com/anokye-labs/kbexplorer-cli/issues/156) · part of [kbexplorer#21](https://github.com/anokye-labs/kbexplorer/issues/21).**

The affordance action contract (PE3-F1) is the protocol-neutral **DO-seam**: a
typed catalogue of graph operations (`search`, `query_node`, `graph_neighbors`,
`affected`, `audit`, `llm_context`, `derive`) plus the workflow/job layer
(`start_generate`, `get_job_status`, `cancel_job`, `preview_changes`,
`apply_changes`, `create_pr`). It knows nothing about MCP, JSON-RPC, or canvases.

Affordances reach a host through **interchangeable delivery adapters**, never
through MCP:

```
affordances (contract + jobs + consent)
        │
        ├── extension-tool adapter  (src/extension/)  ← primary, Wave 1, canvas-bundled
        └── MCP adapter             (src/mcp/)         ← optional, this document
```

The **canvas path never touches MCP** — the extension registers the affordances
as in-process `tools` in the same `joinSession({ canvases, tools })` call. **This
MCP adapter is only for hosts that don't load that extension**: plain
`copilot -p`, Claude Desktop, or any other MCP client.

## What it is

`kbx mcp` runs a **stdio Model Context Protocol server** that exposes the *same*
affordance registry as MCP tools named `kbx_<affordance>`. It is a **thin
transport binding**: every `tools/call` routes through the shared
`executeAffordance`, so input validation, the job layer, and the consent gate
(PE3-F3) are inherited unchanged — the adapter re-implements none of them.

```
src/mcp/
  tool-result.js  affordance result / AffordanceError → MCP CallToolResult
  tools.js        describeAffordances() → kbx_<name> tools (reuses the JSON-Schema bridge)
  consent.js      requestConsent seam over MCP elicitation; --allow policy
  server.js       pure registerKbxMcpServer() — sets tools/list + tools/call handlers
  preflight.js    provider-readiness check for the server itself
  index.js        createKbxMcpServer() + main() (dynamic-imports the SDK, stdio lifecycle)
```

## Usage

```bash
# Launched by a host over stdio (see examples/copilot-mcp-config.json):
npx -y @anokye-labs/kbx mcp
```

Host config (`~/.copilot/mcp-config.json`, or any MCP client):

```json
{ "mcpServers": { "kbexplorer": { "command": "npx", "args": ["-y", "@anokye-labs/kbx", "mcp"] } } }
```

Options: `--allow` (non-interactive consent), `--name <name>`,
`--skip-preflight`, `--help`.

## Consent over MCP

Consent is enforced **once, at the action core** (`src/affordances/consent.js`):
every adapter goes through the same `enforceConsent` gate, and every adapter
fails closed the same way when no `context.seams.requestConsent` callback is
wired — that choke point really is shared. But "the gate is shared" is not the
same claim as "consent behaves identically across adapters", and today it
doesn't:

- **The MCP adapter is the only one with a working consent seam.** `read`
  actions never prompt; `write` / `sample` actions request approval **before**
  any side effect via the injected `context.seams.requestConsent(request)`
  callback, which this adapter renders as an **elicitation**
  (`elicitation/create`) carrying the deterministic disclosure (model cost,
  credential *names*, write targets). If the client doesn't advertise
  `elicitation`, the seam denies with an actionable reason. `--allow` (or
  `KBX_MCP_CONSENT=allow`) opts into non-interactive consent for trusted
  automation.
- **The extension-tool adapter (`src/extension/`) and the canvas adapter
  (`src/extension/canvas-server.js`'s `/affordance/:name`) supply no
  `requestConsent` seam at all.** Every `write` / `sample`-class call through
  either surface unconditionally hits the fail-closed default and returns
  `CONSENT_REQUIRED` (surfaced as HTTP `403` on the canvas). This is safe — it
  never approves something it shouldn't — but it also means neither surface can
  *ever* complete a write or sample-class affordance as shipped today; only
  read actions work end-to-end through them. Implementing an interactive
  consent UX for those two surfaces is tracked as **post-launch** work, not
  something this document should imply already exists.

BYO-cred: the server inherits the ambient environment (`gh`, provider keys)
exactly like the rest of the CLI.

## Two "MCP preflights" — don't conflate them

- **Consumer** (`src/lib/mcp-preflight.js`, #46): before a fuzzy phase, verifies
  the *upstream* MCP servers kbx *calls* are configured. About servers kbx uses.
- **Provider** (`src/mcp/preflight.js`, this feature): before starting `kbx mcp`,
  verifies the local environment can *run our server* (Node ≥ 22, registry
  loads). `doctor` surfaces both (see the `mcp.server` check).

## Neutrality guarantee

The MCP SDK (`@modelcontextprotocol/sdk`) is **dynamic-imported only in
`index.js`'s `main()`** — it never enters the static module graph, so `npm ci`
and the test suite stay hermetic (no live SDK, no live LLM). A neutrality guard
(`tests/mcp/neutrality.test.js`) asserts that no `src/mcp` module statically
imports the SDK and that `src/affordances/**` imports no transport at all: the
dependency arrow is always **affordances → adapters**, never the reverse.
