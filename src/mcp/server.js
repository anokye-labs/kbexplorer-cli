/**
 * MCP server binding (PE3-F4) — register affordance tools on an MCP `Server`.
 *
 * This is the pure, SDK-free heart of the MCP adapter, the transport twin of the
 * extension adapter's `registerKbxExtension` ({@link module:src/extension/index}).
 * It takes a low-level MCP `Server` (anything exposing `setRequestHandler`) plus
 * the SDK's `tools/list` and `tools/call` **request-schema objects** — both
 * *injected* — and wires two handlers:
 *
 *   - `tools/list` → the affordance tool catalogue (name, description, JSON-Schema
 *     `inputSchema`), built from the registry via {@link buildMcpTools};
 *   - `tools/call` → dispatch to the matching tool's handler, which routes through
 *     {@link executeAffordance} (so consent is enforced at the core) and maps the
 *     result/error through {@link module:src/mcp/tool-result}.
 *
 * The request schemas are parameters, not imports, precisely so this module — and
 * every test that drives it with a fake server — needs no MCP SDK. The SDK is
 * dynamic-imported once, in {@link module:src/mcp/index}'s `main`, keeping it out
 * of the static module graph (`npm ci`/the test runner never load it) and the
 * neutrality guard green: the *contract* imports no MCP; only the runnable
 * *adapter entry* does, and only at runtime.
 *
 * @module src/mcp/server
 */

import { buildMcpTools } from './tools.js';

/**
 * Register kbexplorer's affordance tools on a low-level MCP `Server`.
 *
 * @param {object} deps
 * @param {{ setRequestHandler: (schema: object, handler: Function) => void }} deps.server
 *        The MCP `Server` (injected; only `setRequestHandler` is used here).
 * @param {object} deps.listToolsSchema  SDK `ListToolsRequestSchema`.
 * @param {object} deps.callToolSchema   SDK `CallToolRequestSchema`.
 * @param {ReturnType<typeof buildMcpTools>} [deps.tools]
 *        Pre-built tool list (defaults to {@link buildMcpTools}). Handy for tests.
 * @param {object} [deps.toolOptions]  Forwarded to {@link buildMcpTools}
 *        (`describe` / `execute` / `contextFactory` seams).
 * @returns {{ tools: ReturnType<typeof buildMcpTools> }} The registered tool list.
 */
export function registerKbxMcpServer({
  server,
  listToolsSchema,
  callToolSchema,
  tools,
  toolOptions = {},
} = {}) {
  if (!server || typeof server.setRequestHandler !== 'function') {
    throw new TypeError('registerKbxMcpServer: "server" must expose setRequestHandler');
  }
  if (!listToolsSchema || !callToolSchema) {
    throw new TypeError(
      'registerKbxMcpServer: "listToolsSchema" and "callToolSchema" are required (inject the SDK request schemas)'
    );
  }

  const toolList = tools ?? buildMcpTools(toolOptions);
  const byName = new Map(toolList.map((t) => [t.name, t]));

  server.setRequestHandler(listToolsSchema, async () => ({
    tools: toolList.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(callToolSchema, async (request) => {
    const params = request?.params ?? {};
    const tool = byName.get(params.name);
    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: true,
                code: 'UNKNOWN_TOOL',
                message: `Unknown tool: ${params.name}`,
                available: [...byName.keys()],
              },
              null,
              2
            ),
          },
        ],
      };
    }
    return tool.handler(params.arguments ?? {});
  });

  return { tools: toolList };
}
