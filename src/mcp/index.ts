/**
 * MCP adapter wiring (PE3-F4) — the stdio `Server` boundary.
 *
 * This module assembles the pure pieces — the affordance→MCP tool binding
 * ({@link module:src/mcp/tools}), the consent bridge ({@link module:src/mcp/consent}),
 * and the request-handler registration ({@link module:src/mcp/server}) — into a
 * runnable stdio MCP server. It is the MCP twin of the extension adapter's
 * `main` ({@link module:src/extension/index}).
 *
 * As with the extension adapter, the Model Context Protocol SDK is the *only*
 * wire protocol involved and it is touched **exactly here, and only via dynamic
 * import inside `main`** — so the SDK stays out of the static module graph
 * (`npm ci`/the test runner never load it), the adapter's other modules and
 * their tests remain hermetic, and the neutrality guard holds: the affordance
 * *contract* imports no MCP; only this runnable adapter entry does, at runtime.
 *
 * {@link createKbxMcpServer} takes an injected `Server` constructor + request
 * schemas, so it is unit-testable with a fake SDK; {@link main} resolves the real
 * SDK and drives the stdio lifecycle (salvaged from the earlier feat/mcp-server
 * spike, anokye-labs/kbexplorer-cli#116): stay alive until the host closes the
 * pipe (stdin EOF) or signals termination, then exit cleanly.
 *
 * @module src/mcp/index
 */

import { registerKbxMcpServer } from './server.ts';
import { buildMcpTools } from './tools.ts';
import { createMcpContextFactory } from './consent.ts';

export { TOOL_PREFIX, toolNameFor, affordanceToMcpTool, buildMcpTools } from './tools.ts';
export { registerKbxMcpServer } from './server.ts';
export { successResult, errorResult } from './tool-result.ts';
export {
  createMcpContextFactory,
  createMcpConsentSeam,
  renderConsentMessage,
  buildElicitationSchema,
} from './consent.ts';
export { runMcpServerPreflight, formatMcpServerPreflight } from './server-preflight.ts';

/** Advertised server identity (name is overridable via `--name`). */
export const SERVER_NAME = 'kbexplorer';
export const SERVER_VERSION = '0.1.0';

/**
 * Build a low-level MCP `Server` with the kbexplorer affordance tools registered
 * and consent wired to MCP elicitation. Pure w.r.t. the SDK: the `Server`
 * constructor and request-schema objects are injected, so this is unit-testable
 * with fakes.
 *
 * @param {object} deps
 * @param {new (info: object, options: object) => object} deps.Server
 *        The SDK low-level `Server` class.
 * @param {object} deps.listToolsSchema  SDK `ListToolsRequestSchema`.
 * @param {object} deps.callToolSchema   SDK `CallToolRequestSchema`.
 * @param {string}  [deps.name=SERVER_NAME]
 * @param {string}  [deps.version=SERVER_VERSION]
 * @param {boolean} [deps.allow=false]   Non-interactive consent opt-in.
 * @param {string}  [deps.cwd=process.cwd()]
 * @returns {{ server: object, tools: ReturnType<typeof buildMcpTools> }}
 */
export function createKbxMcpServer({
  Server,
  listToolsSchema,
  callToolSchema,
  name = SERVER_NAME,
  version = SERVER_VERSION,
  allow = false,
  cwd = process.cwd(),
} = {}) {
  if (typeof Server !== 'function') {
    throw new TypeError('createKbxMcpServer: "Server" constructor must be provided');
  }

  const server = new Server(
    { name, version },
    // We provide `tools`; we *consume* the client's `elicitation` capability for
    // consent (checked lazily at call time), so nothing extra is declared here.
    { capabilities: { tools: {} } }
  );

  const contextFactory = createMcpContextFactory({
    cwd,
    allow,
    elicitInput: (params) => server.elicitInput(params),
    getClientCapabilities: () => server.getClientCapabilities?.() ?? {},
  });

  const { tools } = registerKbxMcpServer({
    server,
    listToolsSchema,
    callToolSchema,
    toolOptions: { contextFactory },
  });

  return { server, tools };
}

/**
 * Block until the host ends the stdio session: the SDK transport's `onclose`, a
 * stdin EOF, or a termination signal. Returns a promise that settles once.
 *
 * @param {object} server   The connected low-level `Server` (has `onclose`).
 * @param {object} [io]     Injectable process seams for tests.
 * @param {NodeJS.ReadableStream} [io.stdin=process.stdin]
 * @param {NodeJS.Process} [io.proc=process]
 * @returns {Promise<void>}
 */
export function waitForClose(server, { stdin = process.stdin, proc = process } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const prevOnClose = server.onclose;
    server.onclose = () => {
      try {
        prevOnClose?.();
      } finally {
        settle();
      }
    };
    stdin.once?.('end', settle);
    stdin.once?.('close', settle);
    proc.once?.('SIGINT', settle);
    proc.once?.('SIGTERM', settle);
  });
}

/**
 * Runnable entry: resolve the real MCP SDK, stand up the stdio server, and stay
 * alive until the host disconnects.
 *
 * @param {object} [opts]
 * @param {string}  [opts.cwd=process.cwd()]
 * @param {boolean} [opts.allow=false]  Non-interactive consent opt-in.
 * @param {string}  [opts.name=SERVER_NAME]
 * @returns {Promise<void>}
 */
export async function main({ cwd = process.cwd(), allow = false, name = SERVER_NAME } = {}) {
  const [{ Server }, { StdioServerTransport }, { ListToolsRequestSchema, CallToolRequestSchema }] =
    await Promise.all([
      import('@modelcontextprotocol/sdk/server/index.js'),
      import('@modelcontextprotocol/sdk/server/stdio.js'),
      import('@modelcontextprotocol/sdk/types.js'),
    ]);

  const { server } = createKbxMcpServer({
    Server,
    listToolsSchema: ListToolsRequestSchema,
    callToolSchema: CallToolRequestSchema,
    name,
    allow,
    cwd,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await waitForClose(server);
}
