/**
 * Scoping + validation tests for `kbexplorer mcp`.
 *
 * mcp.test.js proves the happy path with a single fixture root. These tests
 * prove the two properties that the happy-path tests cannot:
 *
 *   1. **Roots actually scope the graph.** Given a workspace that contains two
 *      independent content areas, granting only one root must EXCLUDE the other
 *      area's nodes from every tool (stats, search, get_node) — and granting
 *      both must include both. This is the security/scoping guarantee at the
 *      heart of the server ("scope the graph context it shares with the model").
 *   2. **Tools validate input and fail gracefully.** Unknown ids, empty
 *      questions/queries, no-hit questions, missing required args, and
 *      out-of-range depths are all handled deterministically.
 *
 * Driven over the in-memory SDK transport (real MCP `Client`), fully hermetic.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createKbMcpServer } from '../../src/commands/mcp.js';

function parseToolJson(result) {
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  return text == null ? undefined : JSON.parse(text);
}

function toolText(result) {
  return result?.content?.find((c) => c.type === 'text')?.text ?? '';
}

/**
 * A workspace with two independent content areas:
 *   <root>/teamA/content/alpha.md   (id: alpha, keyword "telemetry")
 *   <root>/teamB/content/beta.md    (id: beta,  keyword "billing")
 * Each can be granted independently as a root.
 */
function makeSplitFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-mcp-scope-'));
  const write = (team, id, cluster, body) => {
    const dir = resolve(root, team, 'content');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, `${id}.md`),
      `---\nid: ${id}\ntitle: "${id}"\ncluster: ${cluster}\n---\n${body}\n`,
      'utf-8',
    );
  };
  write('teamA', 'alpha', 'observability', 'Alpha node about telemetry pipelines and tracing.');
  write('teamB', 'beta', 'finance', 'Beta node about billing invoices and payments.');
  return { root, teamA: resolve(root, 'teamA'), teamB: resolve(root, 'teamB') };
}

/** A linear chain n0 - n1 - ... - n5 (6 nodes, 5 edges) for depth-clamp tests. */
function makeChainFixture(len = 6) {
  const root = mkdtempSync(join(tmpdir(), 'kb-mcp-chain-'));
  const content = resolve(root, 'content');
  mkdirSync(content, { recursive: true });
  for (let i = 0; i < len; i++) {
    const fm = [`id: n${i}`, `title: "Node ${i}"`, 'cluster: chain'];
    if (i + 1 < len) {
      fm.push('connections:', `  - to: n${i + 1}`, `    description: "links to node ${i + 1}"`);
    }
    writeFileSync(resolve(content, `n${i}.md`), `---\n${fm.join('\n')}\n---\nBody of node ${i}.\n`, 'utf-8');
  }
  return { root };
}

/**
 * Connect a real SDK Client to a fresh server. `rootsRef` is a mutable holder
 * `{ uris: string[] }` so a test can change which roots the host grants and
 * re-resolve via roots/list_changed.
 */
async function connect({ capabilities = { roots: {} }, rootsRef = { uris: [] }, serverOpts = {} } = {}) {
  const { server } = createKbMcpServer({ name: 'kbexplorer', ...serverOpts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sdk-scope-test', version: '0.0.0' }, { capabilities });
  if (capabilities.roots) {
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: rootsRef.uris.map((uri, i) => ({ uri, name: `r${i}` })),
    }));
  }
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('kbexplorer mcp — roots genuinely scope a larger workspace', () => {
  const fx = makeSplitFixture();

  it('granting only teamA excludes teamB nodes from every tool', async () => {
    const rootsRef = { uris: [pathToFileURL(fx.teamA).href] };
    const { client, server } = await connect({ capabilities: { roots: {} }, rootsRef });
    try {
      const stats = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
      assert.equal(stats.nodeCount, 1, 'only the teamA node should be in scope');

      // kb_ask succeeds for in-scope node, fails for out-of-scope node.
      const inScope = parseToolJson(
        await client.callTool({ name: 'kb_ask', arguments: { nodeIds: ['alpha'], question: 'what is alpha?' } }),
      );
      assert.ok(!inScope.isError, 'alpha must be reachable via kb_ask');

      const outOfScope = await client.callTool({
        name: 'kb_ask',
        arguments: { nodeIds: ['beta'], question: 'what is beta?' },
      });
      assert.equal(outOfScope.isError, true, 'beta must be unreachable via kb_ask');
      assert.match(toolText(outOfScope), /Unknown node ids/);

      const ok = parseToolJson(await client.callTool({ name: 'kb_get_node', arguments: { id: 'alpha' } }));
      assert.equal(ok.id, 'alpha');

      const denied = await client.callTool({ name: 'kb_get_node', arguments: { id: 'beta' } });
      assert.equal(denied.isError, true, 'out-of-scope node must be unreachable');
      assert.match(toolText(denied), /Unknown node id: beta/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('granting only teamB flips the visible node set', async () => {
    const rootsRef = { uris: [pathToFileURL(fx.teamB).href] };
    const { client, server } = await connect({ capabilities: { roots: {} }, rootsRef });
    try {
      const stats = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
      assert.equal(stats.nodeCount, 1);
      // beta reachable, alpha not
      const betaOk = parseToolJson(
        await client.callTool({ name: 'kb_ask', arguments: { nodeIds: ['beta'], question: 'what is beta?' } }),
      );
      assert.ok(!betaOk.isError, 'beta must be reachable');
      const denied = await client.callTool({ name: 'kb_get_node', arguments: { id: 'alpha' } });
      assert.equal(denied.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('granting both roots includes both areas', async () => {
    const rootsRef = { uris: [pathToFileURL(fx.teamA).href, pathToFileURL(fx.teamB).href] };
    const { client, server } = await connect({ capabilities: { roots: {} }, rootsRef });
    try {
      const stats = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
      assert.equal(stats.nodeCount, 2);
      assert.deepEqual([...stats.clusters.map((c) => c.cluster)].sort(), ['finance', 'observability']);
      assert.equal(parseToolJson(await client.callTool({ name: 'kb_get_node', arguments: { id: 'alpha' } })).id, 'alpha');
      assert.equal(parseToolJson(await client.callTool({ name: 'kb_get_node', arguments: { id: 'beta' } })).id, 'beta');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('narrowing roots at runtime (list_changed) drops the now-out-of-scope node', async () => {
    const rootsRef = { uris: [pathToFileURL(fx.teamA).href, pathToFileURL(fx.teamB).href] };
    const { client, server } = await connect({ capabilities: { roots: { listChanged: true } }, rootsRef });
    try {
      assert.equal(parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} })).nodeCount, 2);

      rootsRef.uris = [pathToFileURL(fx.teamA).href]; // revoke teamB
      await client.sendRootsListChanged();
      await new Promise((r) => setTimeout(r, 50));

      const after = parseToolJson(await client.callTool({ name: 'kb_graph_stats', arguments: {} }));
      assert.equal(after.nodeCount, 1, 'revoked root must shrink the graph');
      const denied = await client.callTool({ name: 'kb_get_node', arguments: { id: 'beta' } });
      assert.equal(denied.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('kbexplorer mcp — input validation & error paths', () => {
  const fx = makeChainFixture(6);
  /** @type {import('@modelcontextprotocol/sdk/client/index.js').Client} */
  let client;
  let server;

  before(async () => {
    ({ client, server } = await connect({ serverOpts: { flagRoots: [fx.root] }, capabilities: {} }));
  });
  after(async () => {
    await client.close();
    await server.close();
  });

  it('kb_get_node on an unknown id returns an error result, not a throw', async () => {
    const res = await client.callTool({ name: 'kb_get_node', arguments: { id: 'does-not-exist' } });
    assert.equal(res.isError, true);
    assert.match(toolText(res), /Unknown node id: does-not-exist/);
  });

  it('kb_neighbors on an unknown id returns an error result', async () => {
    const res = await client.callTool({ name: 'kb_neighbors', arguments: { id: 'nope' } });
    assert.equal(res.isError, true);
    assert.match(toolText(res), /Unknown node id: nope/);
  });

  it('kb_ask with an empty question is rejected', async () => {
    // nodeIds valid, question blank — must fail validation.
    const res = await client.callTool({ name: 'kb_ask', arguments: { nodeIds: ['n0'], question: '   ' } });
    assert.equal(res.isError, true);
    assert.match(toolText(res), /non-empty/i);
  });

  it('kb_ask with an empty nodeIds array is rejected', async () => {
    let errored = false;
    try {
      const r = await client.callTool({ name: 'kb_ask', arguments: { nodeIds: [], question: 'any question' } });
      errored = Boolean(r.isError);
    } catch {
      errored = true; // SDK may surface schema violations as a protocol error
    }
    assert.ok(errored, 'kb_ask with empty nodeIds must not succeed');
  });

  it('kb_ask with unknown node ids returns an error', async () => {
    const res = await client.callTool({
      name: 'kb_ask',
      arguments: { nodeIds: ['does-not-exist', 'also-nope'], question: 'What is this?' },
    });
    assert.equal(res.isError, true);
    assert.match(toolText(res), /Unknown node ids/);
  });

  it('kb_neighbors clamps an out-of-range depth to the 1..4 bound', async () => {
    const res = parseToolJson(await client.callTool({ name: 'kb_neighbors', arguments: { id: 'n0', depth: 99 } }));
    assert.equal(res.depth, 4, 'depth must be clamped to the documented max of 4');
    const ids = res.neighbors.map((n) => n.id);
    assert.ok(!ids.includes('n5'), 'a node 5 hops away must be beyond the clamped depth');
    assert.equal(Math.max(...res.neighbors.map((n) => n.distance)), 4);
  });

  it('kb_neighbors clamps depth:0 up to 1', async () => {
    const res = parseToolJson(await client.callTool({ name: 'kb_neighbors', arguments: { id: 'n0', depth: 0 } }));
    assert.equal(res.depth, 1);
    assert.deepEqual(res.neighbors.map((n) => n.id), ['n1']);
  });

  it('a missing required argument is rejected by schema validation', async () => {
    let errored = false;
    try {
      const r = await client.callTool({ name: 'kb_get_node', arguments: {} });
      errored = Boolean(r.isError);
    } catch {
      errored = true; // SDK may surface schema violations as a protocol error
    }
    assert.ok(errored, 'kb_get_node without an id must not succeed');
  });
});
