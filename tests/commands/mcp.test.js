/**
 * In-process tests for `kbexplorer mcp`.
 *
 * Drives the server with the official MCP SDK `Client` over a linked
 * `InMemoryTransport` pair — no subprocess, no hand-rolled JSON-RPC. The test
 * client advertises and answers the `roots` and `sampling` capabilities, which
 * proves the server:
 *   - scopes the graph to the host-granted roots,
 *   - performs retrieval-augmented sampling for kb_ask,
 *   - degrades to a grounded context bundle when sampling is unavailable.
 *
 * Fully hermetic — no live model is involved; the client returns canned
 * sampling responses. The real shipped stdio binary is covered separately in
 * mcp-stdio.test.js.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema, CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createKbMcpServer } from '../../src/commands/mcp.js';

/** Parse the JSON payload out of a tool result's first text content block. */
function parseToolJson(result) {
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  return text == null ? undefined : JSON.parse(text);
}

/** Write a two-node (scheduler -> queue) content fixture under a temp root. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-mcp-'));
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

function makeSingleNodeFixture(prefix = 'kb-mcp-single-', id = 'solo') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const content = resolve(root, 'content');
  mkdirSync(content, { recursive: true });
  writeFileSync(
    resolve(content, `${id}.md`),
    `---\nid: ${id}\ntitle: "${id}"\ncluster: core\n---\nOnly node.\n`,
    'utf-8',
  );
  return { root };
}

/**
 * Connect an SDK `Client` to a freshly built server over an in-memory pair.
 *
 * @param {object} opts
 * @param {object} [opts.serverOpts]    Passed to createKbMcpServer.
 * @param {object} [opts.capabilities]  Client capabilities to advertise.
 * @param {object} [opts.handlers]      Map of { roots, sampling } request handlers.
 */
async function connect({ serverOpts = {}, capabilities = {}, handlers = {} } = {}) {
  const { server } = createKbMcpServer({ name: 'kbexplorer', ...serverOpts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sdk-test-client', version: '0.0.0' }, { capabilities });

  if (handlers.roots) client.setRequestHandler(ListRootsRequestSchema, handlers.roots);
  if (handlers.sampling) client.setRequestHandler(CreateMessageRequestSchema, handlers.sampling);

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('kbexplorer mcp — with roots + sampling', () => {
  const { root } = makeFixture();
  /** @type {import('@modelcontextprotocol/sdk/client/index.js').Client} */
  let client;
  let server;
  let samplingCalls = 0;

  before(async () => {
    ({ client, server } = await connect({
      capabilities: { roots: {}, sampling: {} },
      handlers: {
        roots: () => ({ roots: [{ uri: pathToFileURL(root).href, name: 'fixture' }] }),
        sampling: (req) => {
          samplingCalls++;
          const params = req.params;
          // Echo a grounded-looking answer that cites the scheduler node.
          assert.ok(params.systemPrompt.includes('kbexplorer'));
          assert.ok(params.messages[0].content.text.includes('Job Scheduler'));
          return {
            role: 'assistant',
            content: { type: 'text', text: 'The [scheduler] dispatches jobs to the [queue].' },
            model: 'mock-model-1',
            stopReason: 'endTurn',
          };
        },
      },
    }));
    const info = client.getServerVersion();
    assert.equal(info.name, 'kbexplorer');
  });

  after(async () => {
    await client.close();
    await server.close();
  });

  it('lists the four kb tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['kb_ask', 'kb_get_node', 'kb_graph_stats', 'kb_neighbors']);
  });

  it('kb_graph_stats reflects the host-granted root', async () => {
    const stats = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
    assert.equal(stats.nodeCount, 2);
    assert.equal(stats.edgeCount, 1);
    assert.ok(stats.roots.some((r) => r.toLowerCase().includes('kb-mcp-')));
  });

  it('kb_get_node returns full node detail', async () => {
    const node = parseToolJson(await client.callTool({ name: 'kb_get_node', arguments: { id: 'queue' } }));
    assert.equal(node.title, 'Message Queue');
    assert.equal(node.cluster, 'core');
  });

  it('kb_neighbors traverses edges', async () => {
    const res = parseToolJson(await client.callTool({ name: 'kb_neighbors', arguments: { id: 'scheduler', depth: 1 } }));
    assert.deepEqual(res.neighbors.map((n) => n.id), ['queue']);
  });

  it('kb_ask performs sampling grounded in caller-supplied node ids', async () => {
    const before = samplingCalls;
    const res = parseToolJson(
      await client.callTool({ name: 'kb_ask', arguments: { nodeIds: ['scheduler', 'queue'], question: 'How are jobs dispatched?' } }),
    );
    assert.equal(res.usedSampling, true);
    assert.equal(res.model, 'mock-model-1');
    assert.match(res.answer, /scheduler/);
    assert.ok(res.citations.some((c) => c.id === 'scheduler'));
    assert.equal(samplingCalls, before + 1);
  });
});

describe('kbexplorer mcp — degraded (no sampling, flag-root scope)', () => {
  const { root } = makeFixture();
  /** @type {import('@modelcontextprotocol/sdk/client/index.js').Client} */
  let client;
  let server;

  before(async () => {
    // No roots/sampling capability; scope comes from the flagRoots option instead.
    ({ client, server } = await connect({
      serverOpts: { flagRoots: [root] },
      capabilities: {},
      handlers: {},
    }));
  });

  after(async () => {
    await client.close();
    await server.close();
  });

  it('kb_ask returns a grounded context bundle instead of an answer', async () => {
    const res = parseToolJson(
      await client.callTool({ name: 'kb_ask', arguments: { nodeIds: ['scheduler'], question: 'How are jobs dispatched?' } }),
    );
    assert.equal(res.usedSampling, false);
    assert.match(res.reason, /sampling/i);
    assert.ok(res.contextBundle.includes('Job Scheduler'));
    assert.ok(res.citations.some((c) => c.id === 'scheduler'));
  });

  it('still scopes the graph via the flag root', async () => {
    const stats = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
    assert.equal(stats.nodeCount, 2);
  });
});

describe('kbexplorer mcp — roots capability fail-closed semantics', () => {
  it('fails closed when roots are advertised but roots/list returns empty and no --root is provided', async () => {
    const fixture = makeFixture();
    const { client, server } = await connect({
      serverOpts: { cwd: fixture.root },
      capabilities: { roots: {} },
      handlers: {
        roots: () => ({ roots: [] }),
      },
    });
    try {
      const stats = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
      assert.equal(stats.nodeCount, 0);
      assert.deepEqual(stats.roots, []);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('still allows explicit --root scope when roots/list is empty', async () => {
    const fixture = makeFixture();
    const { client, server } = await connect({
      serverOpts: { cwd: fixture.root, flagRoots: [fixture.root] },
      capabilities: { roots: {} },
      handlers: {
        roots: () => ({ roots: [] }),
      },
    });
    try {
      const stats = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
      assert.equal(stats.nodeCount, 2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('fails closed when roots/list throws and no --root is provided', async () => {
    const fixture = makeFixture();
    const { client, server } = await connect({
      serverOpts: { cwd: fixture.root },
      capabilities: { roots: {} },
      handlers: {
        roots: () => {
          throw new Error('roots unavailable');
        },
      },
    });
    try {
      const stats = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
      assert.equal(stats.nodeCount, 0);
      assert.deepEqual(stats.roots, []);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('falls back to cwd only when roots capability is absent', async () => {
    const fixture = makeFixture();
    const { client, server } = await connect({
      serverOpts: { cwd: fixture.root },
      capabilities: {},
      handlers: {},
    });
    try {
      const stats = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
      assert.equal(stats.nodeCount, 2);
      assert.ok(stats.roots.some((r) => r.toLowerCase() === fixture.root.toLowerCase()));
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('kbexplorer mcp — sampling empty-response degradation', () => {
  const { root } = makeFixture();
  /** @type {import('@modelcontextprotocol/sdk/client/index.js').Client} */
  let client;
  let server;

  before(async () => {
    ({ client, server } = await connect({
      capabilities: { roots: {}, sampling: {} },
      handlers: {
        roots: () => ({ roots: [{ uri: pathToFileURL(root).href, name: 'fixture' }] }),
        sampling: () => ({
          role: 'assistant',
          content: { type: 'text', text: '   ' },
          model: 'mock-empty',
          stopReason: 'endTurn',
        }),
      },
    }));
  });

  after(async () => {
    await client.close();
    await server.close();
  });

  it('returns a non-sampling context bundle when sampling returns no usable text', async () => {
    const res = parseToolJson(
      await client.callTool({ name: 'kb_ask', arguments: { nodeIds: ['scheduler'], question: 'How are jobs dispatched?' } }),
    );
    assert.equal(res.usedSampling, false);
    assert.match(res.reason, /no usable text/i);
    assert.ok(res.contextBundle.includes('Job Scheduler'));
    assert.ok(res.citations.some((c) => c.id === 'scheduler'));
  });
});

describe('kbexplorer mcp — roots/list_changed invalidates the cached graph', () => {
  /** @type {import('@modelcontextprotocol/sdk/client/index.js').Client} */
  let client;
  let server;
  let currentRoot;

  before(async () => {
    currentRoot = makeFixture().root;
    ({ client, server } = await connect({
      capabilities: { roots: { listChanged: true }, sampling: {} },
      handlers: {
        roots: () => ({ roots: [{ uri: pathToFileURL(currentRoot).href, name: 'fixture' }] }),
      },
    }));
  });

  after(async () => {
    await client.close();
    await server.close();
  });

  it('re-resolves roots after a roots/list_changed notification', async () => {
    const first = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
    assert.equal(first.nodeCount, 2);

    // Point the host at a brand-new single-node root, then signal the change.
    const next = mkdtempSync(join(tmpdir(), 'kb-mcp-changed-'));
    mkdirSync(resolve(next, 'content'), { recursive: true });
    writeFileSync(
      resolve(next, 'content', 'solo.md'),
      '---\nid: solo\ntitle: "Solo"\ncluster: core\n---\nOnly node.\n',
      'utf-8',
    );
    currentRoot = next;

    await client.sendRootsListChanged();
    // Give the server a tick to process the notification + invalidate.
    await new Promise((r) => setTimeout(r, 50));

    const after = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
    assert.equal(after.nodeCount, 1);
    assert.ok(after.roots.some((r) => r.toLowerCase().includes('kb-mcp-changed-')));
  });

  it('ignores stale in-flight roots/list completions after list_changed', async () => {
    const firstRoot = makeFixture().root;
    const secondRoot = makeSingleNodeFixture('kb-mcp-stale-', 'solo').root;
    let currentRoot = firstRoot;
    let rootCalls = 0;

    const connected = await connect({
      capabilities: { roots: { listChanged: true } },
      handlers: {
        roots: async () => {
          rootCalls++;
          if (rootCalls === 1) {
            await new Promise((r) => setTimeout(r, 120));
          }
          return { roots: [{ uri: pathToFileURL(currentRoot).href, name: 'fixture' }] };
        },
      },
    });

    const localClient = connected.client;
    const localServer = connected.server;
    try {
      const staleCall = localClient.callTool({ name: 'kb_graph_stats', arguments: {} });
      await new Promise((r) => setTimeout(r, 20));
      currentRoot = secondRoot;
      await localClient.sendRootsListChanged();
      // Allow the stale roots/list call to complete before the next tool call.
      await new Promise((r) => setTimeout(r, 180));

      const after = parseToolJson(await localClient.callTool({ name: 'kb_graph_stats', arguments: {} }));
      assert.equal(after.nodeCount, 1);
      assert.ok(after.roots.some((r) => r.toLowerCase().includes('kb-mcp-stale-')));

      await staleCall;
    } finally {
      await localClient.close();
      await localServer.close();
    }
  });
});
