#!/usr/bin/env node
/**
 * Fake Azure DevOps (ADO) work-items MCP server twin.
 *
 * A hermetic, protocol-faithful stand-in for a real ADO MCP server. It serves
 * canned work items from `fixtures/ado-work-items.json` over stdio (JSON-RPC),
 * so the CLI's MCP-preflight and the derive/ingest paths that depend on a work-item
 * source can be exercised without touching a live Azure DevOps organization.
 *
 * Tools:
 *   - `list_work_items`  → all canned work items (optionally filtered by `state`/`type`)
 *   - `get_work_item`    → a single work item by `id`
 *
 * Run directly:  `node twins/mcp/ado-server.js`
 * Point an adapter at it via `.mcp.json` / `~/.copilot/mcp-config.json` — see README.
 *
 * @module twins/mcp/ado-server
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runStdioServer } from './lib/stdio-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Server name as advertised in `initialize` and used as the canonical twin id. */
export const SERVER_NAME = 'ado';

/**
 * Load the canned work items. Exported so tests can assert against the same
 * fixture the server serves (the fixture is data; assertions live in tests).
 *
 * @returns {Array<object>}
 */
export function loadWorkItems() {
  const fixturePath = join(__dirname, 'fixtures', 'ado-work-items.json');
  return JSON.parse(readFileSync(fixturePath, 'utf-8')).workItems;
}

/**
 * Build the tool definitions for the ADO twin. Exported for direct unit use.
 *
 * @param {Array<object>} [items]  Work items to serve (defaults to the fixture).
 * @returns {Array<object>}
 */
export function buildTools(items = loadWorkItems()) {
  return [
    {
      name: 'list_work_items',
      description: 'List Azure DevOps work items, optionally filtered by state and/or type.',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'Filter by work-item state (e.g. "Active").' },
          type: { type: 'string', description: 'Filter by work-item type (e.g. "Bug").' },
        },
      },
      handler: ({ state, type } = {}) => {
        let result = items;
        if (state) result = result.filter((w) => w.state === state);
        if (type) result = result.filter((w) => w.type === type);
        return { workItems: result };
      },
    },
    {
      name: 'get_work_item',
      description: 'Fetch a single Azure DevOps work item by numeric id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number', description: 'Work-item id.' } },
        required: ['id'],
      },
      handler: ({ id } = {}) => {
        const found = items.find((w) => w.id === id);
        if (!found) throw new Error(`Work item ${id} not found`);
        return { workItem: found };
      },
    },
  ];
}

/** Run the server until stdin closes. */
export function main(io) {
  return runStdioServer({ name: SERVER_NAME, version: '0.1.0-twin', tools: buildTools() }, io);
}

// Run when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
