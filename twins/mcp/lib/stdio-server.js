/**
 * Minimal, protocol-faithful MCP stdio server harness.
 *
 * The project does not (yet) depend on `@modelcontextprotocol/sdk`, so the twins
 * implement just enough of the Model Context Protocol over stdio to be a faithful
 * behavioral clone for hermetic tests: JSON-RPC 2.0 request/response framed as
 * newline-delimited JSON ("ndjson") on stdin/stdout.
 *
 * Supported methods:
 *   - `initialize`             → returns serverInfo + capabilities + protocolVersion
 *   - `notifications/initialized` (notification; no response)
 *   - `tools/list`             → returns the registered tools' schemas
 *   - `tools/call`             → invokes a tool handler, wraps the result as MCP content
 *   - `ping`                   → returns {}
 *
 * Unknown methods return a JSON-RPC error (-32601, "Method not found").
 * Notifications (requests without an `id`) never get a response.
 *
 * This is deliberately framework-free so it can run under plain `node` with no
 * install step. If/when the real MCP SDK is adopted, the twin entrypoints can be
 * reimplemented against it without changing their canned fixtures or the tests.
 *
 * @module twins/mcp/lib/stdio-server
 */

import { createInterface } from 'node:readline';

export const PROTOCOL_VERSION = '2024-11-05';
export const JSONRPC_VERSION = '2.0';

/**
 * Run an MCP stdio server until stdin closes.
 *
 * @param {object} spec
 * @param {string} spec.name              Server name advertised in `initialize`.
 * @param {string} [spec.version]         Server version (default '0.0.0-twin').
 * @param {Array<{name: string, description?: string, inputSchema?: object, handler: (args: object) => unknown}>} spec.tools
 *        Tool definitions. Each `handler` returns either a plain value (wrapped as
 *        a single text content block of JSON) or a pre-shaped MCP result object
 *        ({ content: [...] }), which is passed through unchanged.
 * @param {object} [io]
 * @param {NodeJS.ReadableStream} [io.input]   Defaults to process.stdin.
 * @param {NodeJS.WritableStream} [io.output]  Defaults to process.stdout.
 * @returns {Promise<void>} Resolves when the input stream ends.
 */
export function runStdioServer(spec, { input = process.stdin, output = process.stdout } = {}) {
  const toolMap = new Map((spec.tools ?? []).map((t) => [t.name, t]));

  function send(message) {
    output.write(JSON.stringify(message) + '\n');
  }

  function reply(id, result) {
    send({ jsonrpc: JSONRPC_VERSION, id, result });
  }

  function fail(id, code, message, data) {
    send({ jsonrpc: JSONRPC_VERSION, id, error: { code, message, ...(data ? { data } : {}) } });
  }

  function handle(message) {
    // Notifications (no id) get no response. The only one we expect is
    // `notifications/initialized`, but silently ignore any others too.
    const isNotification = !('id' in message) || message.id === null || message.id === undefined;

    switch (message.method) {
      case 'initialize':
        reply(message.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: spec.name, version: spec.version ?? '0.0.0-twin' },
        });
        return;

      case 'notifications/initialized':
        // Notification — no response.
        return;

      case 'ping':
        if (!isNotification) reply(message.id, {});
        return;

      case 'tools/list':
        reply(message.id, {
          tools: [...toolMap.values()].map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
          })),
        });
        return;

      case 'tools/call': {
        const params = message.params ?? {};
        const tool = toolMap.get(params.name);
        if (!tool) {
          fail(message.id, -32602, `Unknown tool: ${params.name}`);
          return;
        }
        let raw;
        try {
          raw = tool.handler(params.arguments ?? {});
        } catch (err) {
          // Tool execution errors are reported in-band per MCP convention.
          reply(message.id, {
            isError: true,
            content: [{ type: 'text', text: String(err?.message ?? err) }],
          });
          return;
        }
        reply(message.id, shapeToolResult(raw));
        return;
      }

      default:
        if (!isNotification) {
          fail(message.id, -32601, `Method not found: ${message.method}`);
        }
    }
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        // Malformed line — MCP has no id to attach to, so emit a parse error
        // with a null id per JSON-RPC.
        fail(null, -32700, 'Parse error');
        return;
      }
      handle(message);
    });
    rl.on('close', resolve);
  });
}

/**
 * Wrap a tool handler's return value as an MCP `tools/call` result.
 * Pre-shaped results (already carrying a `content` array) pass through.
 *
 * @param {unknown} raw
 * @returns {{ content: Array<object>, isError?: boolean }}
 */
export function shapeToolResult(raw) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
    return raw;
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }],
  };
}
