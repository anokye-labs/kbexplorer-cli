import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintReferenceEdges,
  resolveRelation,
  resolveLinkedRef,
  buildResolutionIndex,
  EDGE_MINT_GENERATOR,
} from '../../src/lib/edge-mint.ts';
import { canonicalStringify } from '../../src/lib/jsonld.ts';

/** Minimal valid KBNode with optional provenance/link substrate. */
function node(id, extra = {}) {
  return {
    id,
    title: id,
    cluster: 'default',
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

describe('mintReferenceEdges — acceptance: cross-source reference between distinct artifacts', () => {
  it('mints one typed, provenance-bearing edge from a linkedRef resolved by identity URN', () => {
    const doc = node('doc-a', {
      sourceId: 'docs',
      identity: 'kg://doc/doc-a',
      linkedRefs: [ref('kg://epic/epic-1', { resourceKind: 'issue', role: 'describes' })],
    });
    const epic = node('epic-1', { sourceId: 'github', identity: 'kg://epic/epic-1' });

    const { graph, minted, stats } = mintReferenceEdges({ nodes: [doc, epic], edges: [] });

    assert.equal(minted.length, 1);
    assert.equal(stats.minted, 1);
    const edge = minted[0];
    assert.equal(edge.from, 'doc-a');
    assert.equal(edge.to, 'epic-1');
    assert.equal(edge.type, 'references');
    assert.equal(edge.source, 'inferred');
    // 'describes' is outside the 6-relation taxonomy → structural + passthrough.
    assert.equal(edge.relation, 'structural');
    assert.equal(edge.relationRaw, 'describes');
    // Provenance: SoR that asserted the link, observed support, derived record.
    assert.equal(edge.sourceId, 'docs');
    assert.deepEqual(edge.sourceRefs, [doc.linkedRefs[0]]);
    assert.equal(edge.evidence.length, 1);
    assert.equal(edge.evidence[0].ref.href, 'kg://epic/epic-1');
    assert.deepEqual(edge.derivation, {
      mode: 'derived',
      generator: EDGE_MINT_GENERATOR,
      inputs: [doc.linkedRefs[0]],
    });
    // Graph edges + related reflect the minted edge.
    assert.equal(graph.edges.length, 1);
    assert.deepEqual(graph.related, { 'doc-a': ['epic-1'], 'epic-1': ['doc-a'] });
  });

  it('resolves a linkedRef by a target node\'s sourceRefs href when no identity matches', () => {
    const pr = node('pr-7', {
      sourceId: 'github',
      linkedRefs: [ref('git://repo/work-item-3', { role: 'implements' })],
    });
    const work = node('work-3', {
      sourceId: 'ado',
      sourceRefs: [ref('git://repo/work-item-3', { resourceKind: 'work-item' })],
    });
    const { minted } = mintReferenceEdges({ nodes: [pr, work] });
    assert.equal(minted.length, 1);
    assert.equal(minted[0].from, 'pr-7');
    assert.equal(minted[0].to, 'work-3');
    assert.equal(minted[0].relation, 'structural');
    assert.equal(minted[0].relationRaw, 'implements');
  });
});

describe('mintReferenceEdges — relation mapping', () => {
  it('uses an in-taxonomy role as the relation and leaves relationRaw unset', () => {
    const a = node('a', { identity: 'kg://x/a', linkedRefs: [ref('kg://x/b', { role: 'leads' })] });
    const b = node('b', { identity: 'kg://x/b' });
    const { minted } = mintReferenceEdges({ nodes: [a, b] });
    assert.equal(minted[0].relation, 'leads');
    assert.ok(!('relationRaw' in minted[0]));
  });

  it('falls back to structural with no relationRaw when the role is absent', () => {
    const a = node('a', { identity: 'kg://x/a', linkedRefs: [ref('kg://x/b')] });
    const b = node('b', { identity: 'kg://x/b' });
    const { minted } = mintReferenceEdges({ nodes: [a, b] });
    assert.equal(minted[0].relation, 'structural');
    assert.ok(!('relationRaw' in minted[0]));
  });

  it('resolveRelation: passthrough only outside the taxonomy', () => {
    assert.deepEqual(resolveRelation('leads'), { relation: 'leads' });
    assert.deepEqual(resolveRelation(''), { relation: 'structural' });
    assert.deepEqual(resolveRelation(undefined), { relation: 'structural' });
    assert.deepEqual(resolveRelation('Mentions'), { relation: 'structural', relationRaw: 'Mentions' });
  });
});

describe('mintReferenceEdges — identityClaims are excluded (that is #138, not #137)', () => {
  it('does NOT mint any edge from a same-as identity claim', () => {
    const a = node('a', {
      identity: 'kg://x/a',
      identityClaims: [{ claim: 'same-as', ref: ref('kg://x/b'), source: 'directory' }],
    });
    const b = node('b', { identity: 'kg://x/b' });
    const { minted, stats } = mintReferenceEdges({ nodes: [a, b] });
    assert.equal(minted.length, 0);
    assert.equal(stats.linkedRefs, 0);
  });
});

describe('mintReferenceEdges — resolution edge cases', () => {
  it('skips a dangling linkedRef (points outside the graph) silently', () => {
    const a = node('a', { identity: 'kg://x/a', linkedRefs: [ref('kg://x/nowhere')] });
    const b = node('b', { identity: 'kg://x/b' });
    const { minted, stats, warnings } = mintReferenceEdges({ nodes: [a, b] });
    assert.equal(minted.length, 0);
    assert.equal(stats.skippedDangling, 1);
    assert.equal(warnings.length, 0);
  });

  it('skips an ambiguous linkedRef and records a warning (deterministic, no first-wins)', () => {
    const a = node('a', { identity: 'kg://x/a', linkedRefs: [ref('shared://r')] });
    const b = node('b', { sourceRefs: [ref('shared://r')] });
    const c = node('c', { sourceRefs: [ref('shared://r')] });
    const { minted, stats, warnings } = mintReferenceEdges({ nodes: [a, b, c] });
    assert.equal(minted.length, 0);
    assert.equal(stats.skippedAmbiguous, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ambiguous .*b, c/);
  });

  it('skips a self-referential linkedRef (no node connects to itself)', () => {
    const a = node('a', {
      identity: 'kg://x/a',
      sourceRefs: [ref('self://a')],
      linkedRefs: [ref('self://a')],
    });
    const { minted, stats } = mintReferenceEdges({ nodes: [a] });
    assert.equal(minted.length, 0);
    assert.equal(stats.skippedSelf, 1);
  });

  it('prefers an identity-URN match over a sourceRefs href match (tier priority)', () => {
    const idx = buildResolutionIndex([
      { id: 'by-identity', identity: 'kg://t' },
      { id: 'by-sourceref', sourceRefs: [ref('kg://t')] },
    ]);
    assert.deepEqual(resolveLinkedRef(ref('kg://t'), idx), { id: 'by-identity' });
  });
});

describe('mintReferenceEdges — dedupe + provenance merge', () => {
  it('collapses two linkedRefs to the same target/relation into one edge, merging provenance', () => {
    const a = node('a', {
      sourceId: 'docs',
      identity: 'kg://x/a',
      linkedRefs: [
        ref('kg://x/b', { role: 'leads', resourceKind: 'one' }),
        ref('kg://x/b', { role: 'leads', resourceKind: 'two' }),
      ],
    });
    const b = node('b', { identity: 'kg://x/b' });
    const { minted, stats } = mintReferenceEdges({ nodes: [a, b] });
    assert.equal(minted.length, 1);
    assert.equal(stats.minted, 1);
    assert.equal(stats.deduped, 1);
    assert.equal(minted[0].sourceRefs.length, 2);
    assert.equal(minted[0].evidence.length, 2);
    assert.equal(minted[0].derivation.inputs.length, 2);
  });

  it('suppresses a minted edge that collides with a pre-existing edge', () => {
    const a = node('a', { identity: 'kg://x/a', linkedRefs: [ref('kg://x/b', { role: 'leads' })] });
    const b = node('b', { identity: 'kg://x/b' });
    const pre = {
      from: 'a',
      to: 'b',
      type: 'references',
      relation: 'leads',
      description: 'authored',
      source: 'frontmatter',
      weight: 1,
    };
    const { minted, stats } = mintReferenceEdges({ nodes: [a, b], edges: [pre] });
    assert.equal(minted.length, 0);
    assert.equal(stats.deduped, 1);
  });
});

describe('mintReferenceEdges — determinism', () => {
  function fixture() {
    return [
      node('doc-a', {
        sourceId: 'docs',
        identity: 'kg://doc/a',
        linkedRefs: [ref('kg://epic/1', { role: 'describes' })],
      }),
      node('epic-1', { sourceId: 'github', identity: 'kg://epic/1' }),
      node('pr-9', {
        sourceId: 'github',
        identity: 'kg://pr/9',
        linkedRefs: [ref('kg://doc/a', { role: 'leads' })],
      }),
    ];
  }

  it('produces identical output regardless of input node order', () => {
    const a = mintReferenceEdges({ nodes: fixture() });
    const reordered = fixture().reverse();
    const b = mintReferenceEdges({ nodes: reordered });
    assert.equal(canonicalStringify(a.graph.edges), canonicalStringify(b.graph.edges));
    assert.equal(canonicalStringify(a.minted), canonicalStringify(b.minted));
  });

  it('is idempotent: re-running over its own output is byte-identical and mints nothing new', () => {
    const first = mintReferenceEdges({ nodes: fixture() });
    assert.equal(first.minted.length, 2);
    const second = mintReferenceEdges(first.graph);
    assert.equal(second.minted.length, 0);
    assert.equal(canonicalStringify(first.graph.edges), canonicalStringify(second.graph.edges));
  });
});
