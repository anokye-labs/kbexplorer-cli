import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCompositeKnowledgeBase,
  mergeSourceQualified,
} from '../../src/lib/composite-ingest.js';
import { normalizeCompositeConfig, CompositeConfigError } from '../../src/lib/composite-config.js';
import { normalizeExtraction } from '../../src/lib/jsonld.js';
import { conflateReferents } from '../../src/lib/conflation.js';
import { isMoreRestrictiveOrEqual } from '../../src/lib/access-label.js';

// ── composite-config: optional per-source access label ──────────────────────
describe('composite-config — source access label', () => {
  it('normalizes a valid access label onto the source', () => {
    const { sources } = normalizeCompositeConfig(
      {
        sources: [
          {
            sourceId: 'docs',
            kind: 'rich-markdown',
            access: { classification: 'confidential', labels: ['pii', 'pii'] },
          },
        ],
      },
      { env: {} }
    );
    assert.deepEqual(sources[0].access, { classification: 'confidential', labels: ['pii'] });
  });

  it('omits access when the block is empty/garbage', () => {
    const { sources } = normalizeCompositeConfig(
      { sources: [{ sourceId: 'docs', kind: 'rich-markdown', access: {} }] },
      { env: {} }
    );
    assert.equal('access' in sources[0], false);
  });

  it('throws when access is not an object', () => {
    assert.throws(
      () =>
        normalizeCompositeConfig(
          { sources: [{ sourceId: 'docs', kind: 'rich-markdown', access: 'secret' }] },
          { env: {} }
        ),
      CompositeConfigError
    );
  });
});

// ── composite carry: source label inherited unless node carries its own ──────
describe('mergeSourceQualified — source access inheritance', () => {
  it('unlabeled nodes/edges inherit the source label; labeled ones keep their own', () => {
    const graph = mergeSourceQualified([
      {
        sourceId: 'hr',
        access: { classification: 'restricted' },
        nodes: [
          { id: 'a', title: 'a' }, // inherits restricted
          { id: 'b', title: 'b', access: { classification: 'public' } }, // keeps own
        ],
        edges: [{ from: 'a', to: 'b', type: 'references' }],
      },
    ]);
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    assert.deepEqual(byId['kg://a'].access, { classification: 'restricted' });
    assert.deepEqual(byId['kg://b'].access, { classification: 'public' });
    assert.deepEqual(graph.edges[0].access, { classification: 'restricted' });
  });

  it('leaves nodes unlabeled when the source has no label', () => {
    const graph = mergeSourceQualified([
      { sourceId: 's', nodes: [{ id: 'a', title: 'a' }], edges: [] },
    ]);
    assert.equal('access' in graph.nodes[0], false);
  });
});

describe('loadCompositeKnowledgeBase — end-to-end source access carry', () => {
  it('carries a source access label through to the built graph', async () => {
    const provider = () => ({
      id: 'p',
      name: 'p',
      async resolve() {
        return {
          nodes: [
            { id: 'n1', title: 'n1', cluster: 'a' },
            { id: 'n2', title: 'n2', cluster: 'a', access: { classification: 'public' } },
          ],
          edges: [],
        };
      },
    });
    const config = {
      sources: [{ sourceId: 'hr', kind: 'hr', access: { classification: 'restricted' } }],
    };
    const { graph } = await loadCompositeKnowledgeBase(config, {
      env: {},
      loadProvider: async () => provider,
    });
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    assert.deepEqual(byId['kg://n1'].access, { classification: 'restricted' });
    assert.deepEqual(byId['kg://n2'].access, { classification: 'public' });
  });
});

// ── jsonld derive: carry entity/relationship labels ─────────────────────────
describe('normalizeExtraction — access carry', () => {
  it('carries entity.access onto the node and its LD member', () => {
    const { nodes, graph } = normalizeExtraction(
      {
        entities: [
          { type: 'person', name: 'Ada', access: { classification: 'confidential', labels: ['pii'] } },
        ],
        relationships: [],
      },
      { sourceRef: 'docs/org.md' }
    );
    assert.deepEqual(nodes[0].access, { classification: 'confidential', labels: ['pii'] });
    const ld = graph.find((m) => m['@type'] === 'person');
    assert.deepEqual(ld.access, { classification: 'confidential', labels: ['pii'] });
  });

  it('carries relationship.access onto the edge and its LD member', () => {
    const { edges, graph } = normalizeExtraction(
      {
        entities: [
          { type: 'person', name: 'Ada' },
          { type: 'person', name: 'Bob' },
        ],
        relationships: [{ from: 'Ada', to: 'Bob', type: 'reports-to', access: { visibility: 'private' } }],
      },
      { sourceRef: 'docs/org.md' }
    );
    assert.deepEqual(edges[0].access, { visibility: 'private' });
    const ld = graph.find((m) => m['@type'] === 'Relationship');
    assert.deepEqual(ld.access, { visibility: 'private' });
  });

  it('merges duplicate-id entity labels most-restrictively', () => {
    const { nodes } = normalizeExtraction(
      {
        entities: [
          { id: 'ada', type: 'person', name: 'Ada', access: { classification: 'internal' } },
          { id: 'ada', type: 'person', name: 'Ada', access: { classification: 'restricted' } },
        ],
        relationships: [],
      },
      { sourceRef: 'docs/org.md' }
    );
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].access.classification, 'restricted');
  });
});

// ── conflation: most-restrictive merge + member preservation + edge derive ───
function node(id, extra = {}) {
  return { id, title: id, cluster: 'people', connections: [], source: { type: 'external' }, ...extra };
}
function claim(kind, href) {
  return { claim: kind, ref: { kind: 'kg', href } };
}

describe('conflateReferents — access merge', () => {
  it('a conflated node is never less restrictive than any member, and member labels survive', () => {
    const members = [
      node('a', {
        sourceId: 's1',
        identity: 'kg://person/x',
        access: { classification: 'internal', labels: ['a'] },
        identityClaims: [claim('same-as', 'kg://person/x2')],
      }),
      node('b', {
        sourceId: 's2',
        identity: 'kg://person/x2',
        access: { classification: 'restricted', labels: ['b'] },
      }),
    ];
    const { graph } = conflateReferents({ nodes: members, edges: [] });
    assert.equal(graph.nodes.length, 1);
    const conflated = graph.nodes[0];
    // Most-restrictive: restricted classification, union of labels.
    assert.equal(conflated.access.classification, 'restricted');
    assert.deepEqual(conflated.access.labels, ['a', 'b']);
    for (const m of members) assert.ok(isMoreRestrictiveOrEqual(conflated.access, m.access));
    // Member labels are preserved on conflatedFrom (nothing lost).
    const fromLabels = conflated.conflatedFrom.map((e) => e.access);
    assert.deepEqual(fromLabels, [
      { classification: 'internal', labels: ['a'] },
      { classification: 'restricted', labels: ['b'] },
    ]);
  });

  it('an unlabeled edge derives the most-restrictive label of its endpoints', () => {
    const nodes = [
      node('a', { access: { classification: 'restricted' } }),
      node('b', { access: { classification: 'internal' } }),
    ];
    const edges = [{ from: 'a', to: 'b', type: 'references' }];
    const { graph } = conflateReferents({ nodes, edges });
    const edge = graph.edges.find((e) => e.from === 'a' && e.to === 'b');
    assert.equal(edge.access.classification, 'restricted');
  });

  it('an edge keeps its own label rather than deriving from endpoints', () => {
    const nodes = [
      node('a', { access: { classification: 'restricted' } }),
      node('b', { access: { classification: 'restricted' } }),
    ];
    const edges = [{ from: 'a', to: 'b', type: 'references', access: { classification: 'public' } }];
    const { graph } = conflateReferents({ nodes, edges });
    const edge = graph.edges.find((e) => e.from === 'a' && e.to === 'b');
    assert.equal(edge.access.classification, 'public');
  });

  it('is idempotent over access labels (re-run yields byte-identical graph)', () => {
    const nodes = [
      node('a', {
        sourceId: 's1',
        identity: 'kg://person/x',
        access: { classification: 'internal' },
        identityClaims: [claim('same-as', 'kg://person/x2')],
      }),
      node('b', { sourceId: 's2', identity: 'kg://person/x2', access: { classification: 'restricted' } }),
    ];
    const first = conflateReferents({ nodes, edges: [] }).graph;
    const second = conflateReferents(first).graph;
    assert.deepEqual(second, first);
  });
});
