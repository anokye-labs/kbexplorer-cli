import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  conflateReferents,
  pickRepresentative,
  CONFLATE_GENERATOR,
} from '../../src/lib/conflation.js';
import { canonicalStringify } from '../../src/lib/jsonld.js';

function node(id, extra = {}) {
  return {
    id,
    title: id,
    cluster: 'people',
    content: '',
    rawContent: '',
    connections: [],
    source: { type: 'external', provider: 'test' },
    ...extra,
  };
}
function ref(href, extra = {}) {
  return { kind: 'kg', href, ...extra };
}
function claim(kind, href, extra = {}) {
  return { claim: kind, ref: ref(href), ...extra };
}

describe('conflateReferents — acceptance: same person across two sources → one node', () => {
  it('conflates two same-as nodes into one node retaining BOTH source-pointers', () => {
    const ghAda = node('gh-ada', {
      sourceId: 'github',
      identity: 'kg://person/ada',
      sourceRefs: [ref('github://users/ada', { resourceKind: 'user' })],
      identityClaims: [claim('same-as', 'kg://person/ada-dir', { source: 'github' })],
    });
    const dirAda = node('dir-ada', {
      sourceId: 'directory',
      identity: 'kg://person/ada-dir',
      sourceRefs: [ref('directory://people/ada', { resourceKind: 'person' })],
    });

    const { graph, groups, stats } = conflateReferents({ nodes: [ghAda, dirAda], edges: [] });

    assert.equal(stats.conflatedGroups, 1);
    assert.equal(stats.mergedNodes, 1);
    assert.equal(graph.nodes.length, 1);
    const merged = graph.nodes[0];
    // Deterministic representative: identity 'kg://person/ada' < 'kg://person/ada-dir'.
    assert.equal(merged.id, 'gh-ada');
    assert.equal(merged.identity, 'kg://person/ada');
    // Both source-pointers retained (lossless union).
    assert.equal(merged.sourceRefs.length, 2);
    // conflatedFrom carries every member for #139 to rank.
    assert.deepEqual(
      merged.conflatedFrom.map((m) => m.id),
      ['dir-ada', 'gh-ada']
    );
    assert.deepEqual(merged.derivation, {
      mode: 'derived',
      generator: CONFLATE_GENERATOR,
      inputs: merged.sourceRefs,
    });
    assert.deepEqual(groups[0], {
      representative: 'gh-ada',
      identity: 'kg://person/ada',
      members: ['dir-ada', 'gh-ada'],
    });
  });
});

describe('conflateReferents — equivalent-to does NOT merge', () => {
  it('leaves two equivalent-to nodes distinct and preserves the claim', () => {
    const a = node('a', { identity: 'kg://t/a', identityClaims: [claim('equivalent-to', 'kg://t/b')] });
    const b = node('b', { identity: 'kg://t/b' });
    const { graph, stats } = conflateReferents({ nodes: [a, b] });
    assert.equal(stats.conflatedGroups, 0);
    assert.equal(graph.nodes.length, 2);
    // Claim preserved verbatim on the still-distinct node.
    const kept = graph.nodes.find((n) => n.id === 'a');
    assert.equal(kept.identityClaims[0].claim, 'equivalent-to');
  });
});

describe('conflateReferents — differentiated-from negative constraint', () => {
  it('never conflates a differentiated-from pair', () => {
    const a = node('a', { identity: 'kg://t/a', identityClaims: [claim('differentiated-from', 'kg://t/b')] });
    const b = node('b', { identity: 'kg://t/b' });
    const { graph, stats, warnings } = conflateReferents({ nodes: [a, b] });
    assert.equal(stats.conflatedGroups, 0);
    assert.equal(graph.nodes.length, 2);
    assert.equal(warnings.length, 0); // no positive union attempted → no contradiction
  });

  it('contradiction: A same-as B but B differentiated-from A → whole component skipped + informative warning', () => {
    const a = node('a', { identity: 'kg://t/a', identityClaims: [claim('same-as', 'kg://t/b')] });
    const b = node('b', {
      identity: 'kg://t/b',
      identityClaims: [claim('differentiated-from', 'kg://t/a'), claim('same-as', 'kg://t/c')],
    });
    const c = node('c', { identity: 'kg://t/c' });

    const { graph, stats, warnings } = conflateReferents({ nodes: [a, b, c] });
    // a-b-c are one positive component, but it harbours a forbidden a<->b pair.
    assert.equal(stats.conflatedGroups, 0);
    assert.equal(stats.contradictions, 1);
    assert.equal(graph.nodes.length, 3); // all left distinct (conservative)
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /component \{a, b, c\}/);
    assert.match(warnings[0], /a<->b/);
  });
});

describe('conflateReferents — edges repoint onto the representative', () => {
  it('repoints edges from merged-away members, drops intra-referent self-loops, dedupes', () => {
    const a = node('a', { identity: 'kg://t/a', identityClaims: [claim('same-as', 'kg://t/b')] });
    const b = node('b', { identity: 'kg://t/b' });
    const x = node('x', { identity: 'kg://t/x' });
    const edges = [
      // becomes a self-loop after b→a remap → dropped
      { from: 'a', to: 'b', type: 'references', relation: 'structural', description: '', source: 'inferred', weight: 1 },
      // external edge to b → repointed to a
      { from: 'x', to: 'b', type: 'references', relation: 'leads', description: '', source: 'inferred', weight: 1 },
    ];
    const { graph, stats } = conflateReferents({ nodes: [a, b, x], edges });
    assert.equal(stats.edgesDropped, 1);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].from, 'x');
    assert.equal(graph.edges[0].to, 'a'); // repointed b→a
    assert.deepEqual(graph.related, { a: ['x'], x: ['a'] });
  });
});

describe('conflateReferents — deterministic representative', () => {
  it('prefers an identity URN, then lex-smallest identity, then smallest id', () => {
    assert.equal(
      pickRepresentative([node('z', { identity: 'kg://a' }), node('a', {})]).id,
      'z' // has identity, wins over the no-identity 'a'
    );
    assert.equal(
      pickRepresentative([node('z', { identity: 'kg://b' }), node('a', { identity: 'kg://a' })]).id,
      'a' // lex-smaller identity
    );
    assert.equal(
      pickRepresentative([node('b', {}), node('a', {})]).id,
      'a' // no identities → smallest id
    );
  });
});

describe('conflateReferents — determinism + idempotency', () => {
  function fixture() {
    return {
      nodes: [
        node('gh-ada', {
          sourceId: 'github',
          identity: 'kg://person/ada',
          sourceRefs: [ref('github://ada')],
          identityClaims: [claim('same-as', 'kg://person/ada-dir')],
        }),
        node('dir-ada', {
          sourceId: 'directory',
          identity: 'kg://person/ada-dir',
          sourceRefs: [ref('dir://ada')],
        }),
        node('svc-x', { sourceId: 'ops', identity: 'kg://svc/x' }),
      ],
      edges: [
        { from: 'svc-x', to: 'dir-ada', type: 'references', relation: 'staffs', description: '', source: 'inferred', weight: 1 },
      ],
    };
  }

  it('produces identical output regardless of input node order', () => {
    const a = conflateReferents(fixture());
    const rev = fixture();
    rev.nodes.reverse();
    const b = conflateReferents(rev);
    assert.equal(canonicalStringify(a.graph.nodes), canonicalStringify(b.graph.nodes));
    assert.equal(canonicalStringify(a.graph.edges), canonicalStringify(b.graph.edges));
  });

  it('is idempotent: re-running over its own output is byte-identical and merges nothing new', () => {
    const first = conflateReferents(fixture());
    assert.equal(first.stats.conflatedGroups, 1);
    const second = conflateReferents(first.graph);
    assert.equal(second.stats.conflatedGroups, 0);
    assert.equal(second.stats.mergedNodes, 0);
    assert.equal(canonicalStringify(first.graph.nodes), canonicalStringify(second.graph.nodes));
    assert.equal(canonicalStringify(first.graph.edges), canonicalStringify(second.graph.edges));
  });
});

describe('conflateReferents — transitive + dangling/ambiguous claims', () => {
  it('unions a transitive same-as chain (A→B→C) into one node', () => {
    const a = node('a', { identity: 'kg://t/a', identityClaims: [claim('same-as', 'kg://t/b')] });
    const b = node('b', { identity: 'kg://t/b', identityClaims: [claim('same-as', 'kg://t/c')] });
    const c = node('c', { identity: 'kg://t/c' });
    const { graph, groups } = conflateReferents({ nodes: [a, b, c] });
    assert.equal(graph.nodes.length, 1);
    assert.deepEqual(groups[0].members, ['a', 'b', 'c']);
  });

  it('ignores a same-as claim whose ref points outside the graph (dangling)', () => {
    const a = node('a', { identity: 'kg://t/a', identityClaims: [claim('same-as', 'kg://t/nowhere')] });
    const { graph, stats } = conflateReferents({ nodes: [a] });
    assert.equal(stats.conflatedGroups, 0);
    assert.equal(graph.nodes.length, 1);
  });
});
