#!/usr/bin/env node
/**
 * Fake SharePoint-docs MCP server twin.
 *
 * A hermetic, protocol-faithful stand-in for a real SharePoint documents MCP
 * server. It serves canned documents from `fixtures/sharepoint-docs.json` over
 * stdio (JSON-RPC), so the CLI's MCP-preflight and the derive/ingest paths that
 * depend on a document source can be exercised without touching a live SharePoint
 * site.
 *
 * Tools:
 *   - `list_documents`  → all canned documents (optionally filtered by `contentType`)
 *   - `get_document`    → a single document by `id`
 *   - `search_documents`→ documents whose title/summary contain a `query` substring
 *
 * Run directly:  `node twins/mcp/sharepoint-docs-server.js`
 * Point an adapter at it via `.mcp.json` / `~/.copilot/mcp-config.json` — see README.
 *
 * @module twins/mcp/sharepoint-docs-server
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runStdioServer } from './lib/stdio-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Server name as advertised in `initialize` and used as the canonical twin id. */
export const SERVER_NAME = 'sharepoint-docs';

/**
 * Load the canned documents. Exported so tests can assert against the same
 * fixture the server serves (the fixture is data; assertions live in tests).
 *
 * @returns {Array<object>}
 */
export function loadDocuments() {
  const fixturePath = join(__dirname, 'fixtures', 'sharepoint-docs.json');
  return JSON.parse(readFileSync(fixturePath, 'utf-8')).documents;
}

/**
 * Build the tool definitions for the SharePoint-docs twin. Exported for direct
 * unit use.
 *
 * @param {Array<object>} [docs]  Documents to serve (defaults to the fixture).
 * @returns {Array<object>}
 */
export function buildTools(docs = loadDocuments()) {
  return [
    {
      name: 'list_documents',
      description: 'List SharePoint documents, optionally filtered by contentType.',
      inputSchema: {
        type: 'object',
        properties: {
          contentType: { type: 'string', description: 'Filter by MIME content type.' },
        },
      },
      handler: ({ contentType } = {}) => {
        const result = contentType ? docs.filter((d) => d.contentType === contentType) : docs;
        return { documents: result };
      },
    },
    {
      name: 'get_document',
      description: 'Fetch a single SharePoint document by id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Document id.' } },
        required: ['id'],
      },
      handler: ({ id } = {}) => {
        const found = docs.find((d) => d.id === id);
        if (!found) throw new Error(`Document ${id} not found`);
        return { document: found };
      },
    },
    {
      name: 'search_documents',
      description: 'Search SharePoint documents by case-insensitive substring of title or summary.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search substring.' } },
        required: ['query'],
      },
      handler: ({ query } = {}) => {
        const q = String(query ?? '').toLowerCase();
        const result = docs.filter(
          (d) =>
            d.title.toLowerCase().includes(q) ||
            String(d.summary ?? '').toLowerCase().includes(q),
        );
        return { documents: result };
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
