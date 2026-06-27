/**
 * Subprocess test for `kbexplorer mcp`.
 *
 * Spawns the *real* shipped entrypoint (`node bin/cli.js mcp`) and drives it
 * with the official MCP SDK `StdioClientTransport`. This is the end-to-end
 * proof that the published binary speaks MCP over stdio, honours host-granted
 * roots, and performs sampling — complementing the fast in-process coverage in
 * mcp.test.js.
 *
 * Hermetic: the client answers roots + sampling with canned responses; no live
 * model is involved.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema, CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'bin', 'cli.js');

function parseToolJson(result) {
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  return text == null ? undefined : JSON.parse(text);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-mcp-stdio-'));
  const content = resolve(root, 'content');
  mkdirSync(content, { recursive: true });
  const node = (id, fm, body) =>
    writeFileSync(resolve(content, `${id}.md`), `---\n${fm}\n---\n${body}\n`, 'utf-8');

  node(
    'scheduler',
    [
      'id: scheduler',
      'title: "Job Scheduler"',
      'cluster: core',
      'connections:',
      '  - to: queue',
      '    description: "enqueues jobs onto the queue"',
    ].join('\n'),
    'The job scheduler plans and dispatches background jobs.',
  );
  node(
    'queue',
    ['id: queue', 'title: "Message Queue"', 'cluster: core'].join('\n'),
    'A durable queue buffering jobs for workers.',
  );
  return { root };
}

describe('kbexplorer mcp — real stdio subprocess (SDK StdioClientTransport)', () => {
  const { root } = makeFixture();
  /** @type {import('@modelcontextprotocol/sdk/client/index.js').Client} */
  let client;
  /** @type {StdioClientTransport} */
  let transport;
  let samplingCalls = 0;

  before(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp'],
      cwd: root,
      stderr: 'ignore',
    });
    client = new Client({ name: 'sdk-stdio-test', version: '0.0.0' }, { capabilities: { roots: {}, sampling: {} } });
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(root).href, name: 'fixture' }],
    }));
    client.setRequestHandler(CreateMessageRequestSchema, () => {
      samplingCalls++;
      return {
        role: 'assistant',
        content: { type: 'text', text: 'The [scheduler] dispatches jobs to the [queue].' },
        model: 'mock-model-1',
        stopReason: 'endTurn',
      };
    });
    await client.connect(transport);
  });

  after(async () => {
    await client.close();
  });

  it('handshakes and advertises the kbexplorer server', () => {
    const info = client.getServerVersion();
    assert.equal(info.name, 'kbexplorer');
  });

  it('lists the four kb tools over stdio', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['kb_ask', 'kb_get_node', 'kb_graph_stats', 'kb_neighbors']);
  });

  it('scopes the graph to the host-granted root', async () => {
    const stats = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
    assert.equal(stats.nodeCount, 2);
    assert.equal(stats.edgeCount, 1);
  });

  it('kb_ask round-trips sampling through the host', async () => {
    const before = samplingCalls;
    const res = parseToolJson(
      await client.callTool({ name: 'kb_ask', arguments: { nodeIds: ['scheduler'], question: 'How are jobs dispatched?' } }),
    );
    assert.equal(res.usedSampling, true);
    assert.equal(res.model, 'mock-model-1');
    assert.match(res.answer, /scheduler/);
    assert.equal(samplingCalls, before + 1);
  });
});
