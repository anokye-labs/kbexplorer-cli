/**
 * Tiny MCP stdio client for driving the twin servers in tests.
 *
 * Spawns a twin via `node <entry>`, performs the `initialize` handshake, and
 * exposes `listTools` / `callTool`. Newline-delimited JSON-RPC, matching the
 * twin harness (twins/mcp/lib/stdio-server.js).
 *
 * @module tests/twins/mcp/stdio-client
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class McpStdioClient {
  /**
   * @param {string} entry  Absolute path to a twin server entrypoint.
   */
  constructor(entry) {
    this._entry = entry;
    this._nextId = 1;
    this._pending = new Map();
    this._child = null;
  }

  /** Spawn the server and run the initialize handshake. */
  async start() {
    this._child = spawn(process.execPath, [this._entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._rl = createInterface({ input: this._child.stdout, crlfDelay: Infinity });
    this._rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.id != null && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });

    const init = await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'twin-test-client', version: '0.0.0' },
    });
    // Per MCP, the client sends an initialized notification after initialize.
    this._notify('notifications/initialized', {});
    return init;
  }

  /** @returns {Promise<object>} the `tools/list` result. */
  listTools() {
    return this._request('tools/list', {});
  }

  /**
   * @param {string} name
   * @param {object} [args]
   * @returns {Promise<object>} the `tools/call` result.
   */
  callTool(name, args = {}) {
    return this._request('tools/call', { name, arguments: args });
  }

  /** Send a raw line (used to test malformed-input handling). */
  writeRaw(line) {
    this._child.stdin.write(line + '\n');
  }

  /** Close stdin and wait for the child to exit. */
  async stop() {
    if (!this._child) return;
    this._child.stdin.end();
    await new Promise((resolve) => this._child.on('close', resolve));
    this._rl?.close();
  }

  _request(method, params) {
    const id = this._nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  _notify(method, params) {
    this._child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

/**
 * Parse the JSON payload from a single-text-content MCP tool result.
 *
 * @param {{ content: Array<{type: string, text?: string}> }} result
 * @returns {unknown}
 */
export function parseToolJson(result) {
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  return text == null ? undefined : JSON.parse(text);
}
