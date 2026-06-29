# MCP server twins — `ado` + `sharepoint-docs`

Hermetic, protocol-faithful **fake MCP servers** standing in for the work-repo
deployment's two real MCP backbones:

| Twin | Stands in for | Serves |
|---|---|---|
| `ado` | Azure DevOps work-items MCP server | canned work items |
| `sharepoint-docs` | SharePoint documents MCP server | canned documents |

They exist so the CLI's **MCP-preflight** (`src/lib/mcp-preflight.js`) and the
derive/ingest paths that depend on a work-item / document source can be exercised
**without touching real ADO or SharePoint** — no network, no auth, no live org.

This is part of the comprehensive-testing epic
(anokye-labs/kbexplorer-template#254): *local behavioral clones of every external
service*, under the **holdout rule** — the canned data here are fixtures only;
all assertions live in the tests under `tests/twins/mcp/`, never in the twins.

## Layout

```
twins/mcp/
  ado-server.js              # fake ADO work-items MCP server (stdio)
  sharepoint-docs-server.js  # fake SharePoint-docs MCP server (stdio)
  lib/
    stdio-server.js          # minimal MCP-over-stdio (JSON-RPC) harness
    config-helpers.js        # write adapter MCP config that points at the twins
  fixtures/
    ado-work-items.json      # canned work items
    sharepoint-docs.json     # canned documents
```

The project does not depend on `@modelcontextprotocol/sdk`, so the twins
implement just enough of the protocol over stdio to be faithful: JSON-RPC 2.0
framed as newline-delimited JSON, supporting `initialize`,
`notifications/initialized`, `tools/list`, `tools/call`, and `ping`. If the SDK
is later adopted, the entrypoints can be reimplemented against it without
changing the fixtures or tests.

## Tools

**`ado`**
- `list_work_items({ state?, type? })` → `{ workItems }`
- `get_work_item({ id })` → `{ workItem }`

**`sharepoint-docs`**
- `list_documents({ contentType? })` → `{ documents }`
- `get_document({ id })` → `{ document }`
- `search_documents({ query })` → `{ documents }` (substring of title/summary)

Tool results are returned as a single MCP text-content block whose `text` is the
JSON-stringified payload.

## Run a twin directly

```bash
node twins/mcp/ado-server.js
node twins/mcp/sharepoint-docs-server.js
```

Each reads JSON-RPC requests on stdin and writes responses (newline-delimited)
on stdout. A handshake looks like:

```jsonc
// → stdin
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_work_items","arguments":{}}}
```

## Point the CLI / agent at the twins

The CLI's preflight detects MCP servers per adapter from these files:

- **claude** — `<repo>/.mcp.json` (key `mcpServers`), or `~/.claude.json`
  (under `projects["<repo path>"].mcpServers`).
- **copilot** — `~/.copilot/mcp-config.json` (key `mcpServers`).

Declare the twins as stdio servers launched with `node`. Repo-local `.mcp.json`
for Claude:

```json
{
  "mcpServers": {
    "ado": { "command": "node", "args": ["twins/mcp/ado-server.js"] },
    "sharepoint-docs": { "command": "node", "args": ["twins/mcp/sharepoint-docs-server.js"] }
  }
}
```

Then declare them in `.kbx.json` so preflight enforces them:

```json
{
  "runtime": {
    "agent": "claude",
    "mcp": { "required": ["ado", "sharepoint-docs"] }
  }
}
```

`runMcpPreflight` will now pass when the config above is present and fail (naming
the missing twin) when it is not.

### From tests

`lib/config-helpers.js` writes these config files into a temp dir for hermetic
tests. The generated `mcpServers` entries use absolute paths to the twin
entrypoints and `process.execPath`, so the same config a test asserts on is one
that would really launch the twin:

```js
import { writeClaudeRepoConfig, writeCopilotConfig } from '../../twins/mcp/lib/config-helpers.js';

writeClaudeRepoConfig(repoDir, ['ado', 'sharepoint-docs']); // → <repoDir>/.mcp.json
writeCopilotConfig(homeDir, ['ado']);                       // → <homeDir>/.copilot/mcp-config.json
```

## Tests

- `tests/twins/mcp/twin-servers.test.js` — spawns each twin and drives it over
  the stdio protocol (initialize → list → call), asserting the canned fixtures.
- `tests/twins/mcp/preflight-twins.test.js` — runs `runMcpPreflight` /
  `detectConfiguredMcpServers` against the twin config for claude, copilot, and
  custom adapters (configured + missing cases), hermetically.

Run them with the repo's test command:

```bash
npm test
```

