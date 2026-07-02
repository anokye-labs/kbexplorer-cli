import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCompositeKnowledgeBase,
  mergeSourceQualified,
  planLevels,
  buildProviderConfig,
  contentHash,
  serializeCompositeGraph,
  persistCompositeKnowledgeBase,
  MemoryGraphStore,
  CompositeIngestError,
  CompositeIngestErrorCode,
} from '../../src/lib/composite-ingest.js';

/**
 * Build an injectable provider factory that yields a fixed fragment. The engine
 * passes the loader `(source) => factory`, so we close over a per-source map.
 */
function fakeLoader(byKind) {
  return async (source) => {
    const make = byKind[source.kind] ?? byKind[source.sourceId];
    if (!make)
      throw new CompositeIngestError(`no fake for ${source.sourceId}`, {
        sourceId: source.sourceId,
      });
    return make;
  };
}

function nodeFrag(id, cluster) {
  return {
    nodes: [
      {
        id,
        title: id,
        cluster,
        content: '',
        rawContent: '',
        connections: [],
        source: { type: 'external', provider: cluster },
      },
    ],
    edges: [],
  };
}

describe('loadCompositeKnowledgeBase — acceptance: two file sources, one graph', () => {
  const INLINE_DOCS =
    '---\nid: doc-a\nentityType: note\n---\n# Doc A\n\nLinks to [b](kg://doc-b){rel=leads}.\n';
  const INLINE_SPECS = '---\nid: doc-b\nentityType: note\n---\n# Doc B\n';

  it('ingests two real rich-markdown sources into a single source-qualified graph', async () => {
    const config = {
      kbx: {
        sources: [
          {
            sourceId: 'docs',
            kind: 'rich-markdown',
            module: '@anokye-labs/kbexplorer-provider-rich-markdown',
            cluster: 'docs',
            options: { content: INLINE_DOCS },
          },
          {
            sourceId: 'specs',
            kind: 'rich-markdown',
            module: '@anokye-labs/kbexplorer-provider-rich-markdown',
            cluster: 'specs',
            options: { content: INLINE_SPECS },
          },
        ],
      },
    };
    const { graph, results, errors, stats } = await loadCompositeKnowledgeBase(config, { env: {} });
    assert.equal(errors.length, 0);
    assert.equal(results.length, 2);
    assert.equal(stats.nodes, 2);
    const ids = graph.nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, ['kg://doc-a', 'kg://doc-b']);
    // Provenance is intact: each node is qualified by its originating sourceId.
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    assert.equal(byId['kg://doc-a'].sourceId, 'docs');
    assert.equal(byId['kg://doc-b'].sourceId, 'specs');
    // The cross-source edge survives the naive union (no minting/resolution).
    assert.ok(graph.edges.some((e) => e.from === 'kg://doc-a' && e.to === 'kg://doc-b'));
  });
});

describe('loadCompositeKnowledgeBase — failureMode', () => {
  const good = () => ({
    id: 'good',
    name: 'good',
    async resolve() {
      return nodeFrag('n1', 'a');
    },
  });
  const bad = () => ({
    id: 'bad',
    name: 'bad',
    async resolve() {
      throw new Error('boom');
    },
  });

  it('fail-fast throws on the first provider error', async () => {
    const config = {
      sources: [
        { sourceId: 'a', kind: 'good' },
        { sourceId: 'b', kind: 'bad' },
      ],
      ingestion: { failureMode: 'fail-fast' },
    };
    await assert.rejects(
      loadCompositeKnowledgeBase(config, { env: {}, loadProvider: fakeLoader({ good, bad }) }),
      /boom/
    );
  });

  it('best-effort records the error and keeps the healthy source', async () => {
    const config = {
      sources: [
        { sourceId: 'a', kind: 'good' },
        { sourceId: 'b', kind: 'bad' },
      ],
      ingestion: { failureMode: 'best-effort' },
    };
    const { graph, errors, results } = await loadCompositeKnowledgeBase(config, {
      env: {},
      loadProvider: fakeLoader({ good, bad }),
    });
    assert.equal(results.length, 1);
    assert.equal(graph.nodes.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].sourceId, 'b');
  });
});

describe('loadCompositeKnowledgeBase — budgets', () => {
  const mk = (id) => () => ({
    id,
    name: id,
    async resolve() {
      return nodeFrag(`${id}-n`, id);
    },
  });

  it('maxSources caps resolution (best-effort skips the overflow)', async () => {
    const config = {
      sources: [
        { sourceId: 'a', kind: 'a' },
        { sourceId: 'b', kind: 'b' },
        { sourceId: 'c', kind: 'c' },
      ],
      ingestion: { failureMode: 'best-effort', budgets: { maxSources: 2 } },
    };
    const { results, skipped } = await loadCompositeKnowledgeBase(config, {
      env: {},
      loadProvider: fakeLoader({ a: mk('a'), b: mk('b'), c: mk('c') }),
    });
    assert.equal(results.length, 2);
    assert.deepEqual(skipped, ['c']);
  });

  it('maxNodes throws under fail-fast and truncates under best-effort', async () => {
    const many = () => ({
      id: 'many',
      name: 'many',
      async resolve() {
        return {
          nodes: [1, 2, 3].map((i) => ({
            id: `n${i}`,
            title: `n${i}`,
            cluster: 'c',
            content: '',
            rawContent: '',
            connections: [],
            source: { type: 'external', provider: 'c' },
          })),
          edges: [],
        };
      },
    });
    const base = { sources: [{ sourceId: 'a', kind: 'many' }] };
    await assert.rejects(
      loadCompositeKnowledgeBase(
        { ...base, ingestion: { failureMode: 'fail-fast', budgets: { maxNodes: 2 } } },
        { env: {}, loadProvider: fakeLoader({ many }) }
      ),
      (e) => e.code === CompositeIngestErrorCode.BUDGET_EXCEEDED
    );
    const { graph, warnings } = await loadCompositeKnowledgeBase(
      { ...base, ingestion: { failureMode: 'best-effort', budgets: { maxNodes: 2 } } },
      { env: {}, loadProvider: fakeLoader({ many }) }
    );
    assert.equal(graph.nodes.length, 2);
    assert.ok(warnings.some((w) => /maxNodes/.test(w)));
  });

  it('timeoutMs trips a hung provider', async () => {
    // resolveWithTimeout() deliberately calls `timer.unref()` on its budget
    // timer (correct prod behavior: a pending provider timeout should never
    // by itself keep a real CLI process alive). But that means the only thing
    // driving this test's assertion forward is an unref'd timer — if nothing
    // else refs the event loop, Node can decide the loop has "resolved" and
    // fire its beforeExit/idle check *before* that timer gets a turn to run,
    // which is what left the old `new Promise(() => {})` version of this test
    // "cancelled" instead of settled. We hold a trivially refed interval open
    // for the duration of the assertion so the unref'd timeout gets a real
    // chance to fire (proving the timeout path genuinely works), and we tear
    // both it and the hung provider's promise down in `finally` so nothing —
    // handle or promise — is left pending once the test completes.
    let releaseHang;
    const hangSignal = new Promise((resolve) => {
      releaseHang = resolve;
    });
    const hang = () => ({ id: 'hang', name: 'hang', resolve: () => hangSignal });
    const keepEventLoopAlive = setInterval(() => {}, 1000);
    try {
      await assert.rejects(
        loadCompositeKnowledgeBase(
          { sources: [{ sourceId: 'a', kind: 'hang' }], ingestion: { budgets: { timeoutMs: 20 } } },
          { env: {}, loadProvider: fakeLoader({ hang }) }
        ),
        (e) => e.code === CompositeIngestErrorCode.PROVIDER_TIMEOUT
      );
    } finally {
      clearInterval(keepEventLoopAlive);
      releaseHang();
    }
  });
});

describe('planLevels — dependency ordering', () => {
  it('orders dependents after their dependencies and exposes existingNodes', async () => {
    const producer = () => ({
      id: 'producer',
      name: 'producer',
      async resolve() {
        return nodeFrag('base', 'a');
      },
    });
    let sawBase = false;
    const consumer = () => ({
      id: 'consumer',
      name: 'consumer',
      dependencies: ['producer'],
      async resolve({ existingNodes }) {
        sawBase = existingNodes.some((n) => n.id === 'base');
        return nodeFrag('leaf', 'b');
      },
    });
    const config = {
      sources: [
        { sourceId: 'consumer', kind: 'consumer' },
        { sourceId: 'producer', kind: 'producer' },
      ],
    };
    const { graph } = await loadCompositeKnowledgeBase(config, {
      env: {},
      loadProvider: fakeLoader({ producer, consumer }),
    });
    assert.equal(sawBase, true, 'consumer should see the producer node in existingNodes');
    assert.equal(graph.nodes.length, 2);
  });

  it('detects dependency cycles', () => {
    const entries = [
      { sourceId: 'a', provider: { id: 'a', dependencies: ['b'] } },
      { sourceId: 'b', provider: { id: 'b', dependencies: ['a'] } },
    ];
    assert.throws(
      () => planLevels(entries),
      (e) => e.code === CompositeIngestErrorCode.DEPENDENCY_CYCLE
    );
  });
});

describe('mergeSourceQualified — determinism', () => {
  it('produces identical output regardless of fragment order', () => {
    const f1 = { sourceId: 'a', ...nodeFrag('z', 'a') };
    const f2 = { sourceId: 'b', ...nodeFrag('m', 'b') };
    const f3 = { sourceId: 'c', ...nodeFrag('a', 'c') };
    const g1 = serializeCompositeGraph(mergeSourceQualified([f1, f2, f3]));
    const g2 = serializeCompositeGraph(mergeSourceQualified([f3, f1, f2]));
    assert.equal(g1, g2);
  });

  it('keeps colliding ids from different sources (no dedupe)', () => {
    const g = mergeSourceQualified([
      { sourceId: 'a', ...nodeFrag('dup', 'a') },
      { sourceId: 'b', ...nodeFrag('dup', 'b') },
    ]);
    assert.equal(g.nodes.length, 2);
    assert.deepEqual(
      g.nodes.map((n) => n.provider),
      ['a', 'b']
    );
  });
});

describe('loadCompositeKnowledgeBase — GraphStore cache parity', () => {
  const counted = { calls: 0 };
  const make = () => ({
    id: 'p',
    name: 'p',
    async resolve() {
      counted.calls++;
      return nodeFrag('cached-node', 'a');
    },
  });
  const config = { sources: [{ sourceId: 'a', kind: 'p', options: { x: 1 } }] };

  it('is byte-identical with the cache ON vs OFF', async () => {
    const off = await loadCompositeKnowledgeBase(config, {
      env: {},
      loadProvider: fakeLoader({ p: make }),
    });
    const store = new MemoryGraphStore();
    const on = await loadCompositeKnowledgeBase(config, {
      env: {},
      loadProvider: fakeLoader({ p: make }),
      store,
    });
    assert.equal(serializeCompositeGraph(on.graph), serializeCompositeGraph(off.graph));
  });

  it('serves a second run from the cache (no second resolve)', async () => {
    counted.calls = 0;
    const store = new MemoryGraphStore();
    const first = await loadCompositeKnowledgeBase(config, {
      env: {},
      loadProvider: fakeLoader({ p: make }),
      store,
    });
    const second = await loadCompositeKnowledgeBase(config, {
      env: {},
      loadProvider: fakeLoader({ p: make }),
      store,
    });
    assert.equal(counted.calls, 1, 'provider.resolve runs once; the second build hits the cache');
    assert.equal(second.stats.cacheHits, 1);
    assert.equal(serializeCompositeGraph(first.graph), serializeCompositeGraph(second.graph));
  });
});

describe('buildProviderConfig + contentHash', () => {
  it('maps a source into an ExternalProviderConfig with resolved credentials in options', () => {
    const cfg = buildProviderConfig({
      sourceId: 'gh',
      kind: 'rich-markdown',
      module: '@p',
      cluster: 'docs',
      options: { content: 'x' },
      credentials: { token: 'secret' },
    });
    assert.equal(cfg.type, 'rich-markdown');
    assert.equal(cfg.name, 'gh');
    assert.equal(cfg.cluster, 'docs');
    assert.equal(cfg.module, '@p');
    assert.deepEqual(cfg.options.credentials, { token: 'secret' });
  });

  it('forwards only the credentials declared for THIS source, never a broader bag (#203)', () => {
    // Simulate a source whose resolved `credentials` bag was contaminated with a
    // key it never declared under its own config entry — e.g. a shared object
    // reference, or a future normalizeCompositeConfig bug. `credentialEnv` (the
    // declared logical-key -> env-var-name map normalizeSource always produces
    // alongside `credentials`) is the allowlist; only keys present there survive.
    const cfg = buildProviderConfig({
      sourceId: 'gh',
      kind: 'rich-markdown',
      module: '@p',
      options: {},
      credentialEnv: { token: 'GH_TOKEN' },
      credentials: { token: 'secret', otherSourcesSecret: 'leaked' },
    });
    assert.deepEqual(cfg.options.credentials, { token: 'secret' });
    assert.equal(cfg.options.credentials.otherSourcesSecret, undefined);
  });

  it('omits options.credentials entirely when the source declares no credentials', () => {
    const cfg = buildProviderConfig({
      sourceId: 'gh',
      kind: 'rich-markdown',
      module: '@p',
      options: {},
      credentialEnv: {},
      credentials: {},
    });
    assert.equal('credentials' in cfg.options, false);
  });

  it('contentHash is stable and key-order independent', () => {
    const a = contentHash({ a: 1, b: 2 });
    const b = contentHash({ b: 2, a: 1 });
    assert.equal(a.digest, b.digest);
    assert.equal(a.algorithm, 'sha256');
  });
});

describe('persistCompositeKnowledgeBase', () => {
  it('writes a canonical, byte-stable graph file to the working tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kbx-composite-'));
    try {
      const graph = mergeSourceQualified([{ sourceId: 'a', ...nodeFrag('n', 'a') }]);
      const file = persistCompositeKnowledgeBase(graph, { outDir: dir });
      const bytes = readFileSync(file, 'utf-8');
      assert.equal(bytes, serializeCompositeGraph(graph));
      assert.ok(bytes.endsWith('\n'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
