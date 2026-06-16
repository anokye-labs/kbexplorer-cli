/**
 * Behavioral tests for the ADO + SharePoint-docs MCP twins.
 *
 * Spawns each twin as a real child process and drives it over the MCP stdio
 * protocol (initialize → tools/list → tools/call), proving the twins are
 * protocol-faithful and serve their canned fixtures. Fully hermetic.
 *
 * Per the holdout rule, assertions live here; the twins ship only canned data,
 * which we load via the servers' own exported loaders to assert against.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpStdioClient, parseToolJson } from './stdio-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TWINS_MCP = join(__dirname, '..', '..', '..', 'twins', 'mcp');

const adoServer = await import(pathToFileURL(join(TWINS_MCP, 'ado-server.js')).href);
const sharepointServer = await import(
  pathToFileURL(join(TWINS_MCP, 'sharepoint-docs-server.js')).href
);

// ── ADO twin ───────────────────────────────────────────────────────────────────

describe('ado MCP twin', () => {
  /** @type {McpStdioClient} */
  let client;
  before(async () => {
    client = new McpStdioClient(join(TWINS_MCP, 'ado-server.js'));
    const init = await client.start();
    assert.strictEqual(init.serverInfo.name, 'ado');
    assert.strictEqual(init.protocolVersion, '2024-11-05');
  });
  after(async () => {
    await client.stop();
  });

  it('lists its tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['get_work_item', 'list_work_items']);
    for (const t of tools) assert.ok(t.inputSchema, `${t.name} has an inputSchema`);
  });

  it('list_work_items returns all canned items', async () => {
    const result = await client.callTool('list_work_items', {});
    const { workItems } = parseToolJson(result);
    const expected = adoServer.loadWorkItems();
    assert.strictEqual(workItems.length, expected.length);
    assert.deepStrictEqual(
      workItems.map((w) => w.id).sort(),
      expected.map((w) => w.id).sort(),
    );
  });

  it('list_work_items filters by state and type', async () => {
    const byState = parseToolJson(await client.callTool('list_work_items', { state: 'New' }));
    assert.ok(byState.workItems.every((w) => w.state === 'New'));
    assert.ok(byState.workItems.length >= 1);

    const byType = parseToolJson(await client.callTool('list_work_items', { type: 'Epic' }));
    assert.ok(byType.workItems.every((w) => w.type === 'Epic'));
  });

  it('get_work_item returns a single item by id', async () => {
    const expected = adoServer.loadWorkItems()[0];
    const { workItem } = parseToolJson(await client.callTool('get_work_item', { id: expected.id }));
    assert.strictEqual(workItem.id, expected.id);
    assert.strictEqual(workItem.title, expected.title);
  });

  it('get_work_item on an unknown id returns an in-band error', async () => {
    const result = await client.callTool('get_work_item', { id: 999999 });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('999999'));
  });

  it('calling an unknown tool yields a JSON-RPC error', async () => {
    await assert.rejects(() => client.callTool('does_not_exist', {}), /Unknown tool/);
  });
});

// ── SharePoint-docs twin ─────────────────────────────────────────────────────

describe('sharepoint-docs MCP twin', () => {
  /** @type {McpStdioClient} */
  let client;
  before(async () => {
    client = new McpStdioClient(join(TWINS_MCP, 'sharepoint-docs-server.js'));
    const init = await client.start();
    assert.strictEqual(init.serverInfo.name, 'sharepoint-docs');
  });
  after(async () => {
    await client.stop();
  });

  it('lists its tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['get_document', 'list_documents', 'search_documents']);
  });

  it('list_documents returns all canned documents', async () => {
    const { documents } = parseToolJson(await client.callTool('list_documents', {}));
    const expected = sharepointServer.loadDocuments();
    assert.strictEqual(documents.length, expected.length);
  });

  it('list_documents filters by contentType', async () => {
    const { documents } = parseToolJson(
      await client.callTool('list_documents', { contentType: 'text/markdown' }),
    );
    assert.ok(documents.length >= 1);
    assert.ok(documents.every((d) => d.contentType === 'text/markdown'));
  });

  it('search_documents matches title/summary substrings (case-insensitive)', async () => {
    const { documents } = parseToolJson(
      await client.callTool('search_documents', { query: 'runbook' }),
    );
    assert.ok(documents.length >= 1);
    assert.ok(
      documents.every(
        (d) =>
          d.title.toLowerCase().includes('runbook') ||
          String(d.summary ?? '').toLowerCase().includes('runbook'),
      ),
    );
  });

  it('get_document returns a single document by id', async () => {
    const expected = sharepointServer.loadDocuments()[0];
    const { document } = parseToolJson(
      await client.callTool('get_document', { id: expected.id }),
    );
    assert.strictEqual(document.id, expected.id);
    assert.strictEqual(document.title, expected.title);
  });

  it('tolerates a malformed input line without crashing', async () => {
    client.writeRaw('this is not json');
    // The server should still answer subsequent valid requests.
    const { documents } = parseToolJson(await client.callTool('list_documents', {}));
    assert.ok(Array.isArray(documents));
  });
});
