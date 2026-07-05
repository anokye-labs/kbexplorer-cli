import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  itemKey,
  extractInputRefs,
  refFingerprint,
  buildInputIndex,
  baselineFromGraph,
  diffFingerprints,
  closure,
  computeAffected,
  affectedFromGraphs,
} = await import('../../src/lib/affected-graph.ts');

const hash = (digest) => ({ algorithm: 'sha256', digest, encoding: 'hex' });
const ref = (href, digest) => ({ kind: 'git', href, ...(digest ? { contentHash: hash(digest) } : {}) });

/** A derived node: id, derivation.inputs (SourceRefs). */
function dnode(id, inputs) {
  return { id, derivation: { mode: 'derived', generator: 'g@1', inputs } };
}

describe('itemKey', () => {
  it('reads internal id, JSON-LD @id, address, href', () => {
    assert.equal(itemKey({ id: 'a' }), 'a');
    assert.equal(itemKey({ '@id': 'kg://x' }), 'kg://x');
    assert.equal(itemKey({ address: 'addr' }), 'addr');
    assert.equal(itemKey({ href: 'h' }), 'h');
    assert.equal(itemKey(null), undefined);
    assert.equal(itemKey({}), undefined);
  });
});

describe('extractInputRefs', () => {
  it('gathers refs across derivation, provenance, top-level and evidence', () => {
    const node = {
      id: 'n',
      derivation: { mode: 'derived', inputs: [ref('a')] },
      provenance: { sourceRefs: [ref('b')], evidence: [{ ref: ref('c') }] },
      sourceRefs: [ref('d')],
      evidence: [{ ref: ref('e') }],
    };
    assert.deepEqual(
      extractInputRefs(node).map((r) => r.href).sort(),
      ['a', 'b', 'c', 'd', 'e']
    );
  });

  it('ignores malformed refs and non-objects', () => {
    assert.deepEqual(extractInputRefs(null), []);
    assert.deepEqual(extractInputRefs({ derivation: { inputs: [{ kind: 'git' }, 42, null] } }), []);
  });
});

describe('refFingerprint', () => {
  it('formats a content hash deterministically', () => {
    assert.equal(refFingerprint(ref('a', 'deadbeef')), 'sha256:hex:deadbeef');
  });
  it('returns empty string when no hash is present', () => {
    assert.equal(refFingerprint(ref('a')), '');
    assert.equal(refFingerprint({}), '');
  });
  it('is safe on a malformed hash', () => {
    assert.equal(refFingerprint({ href: 'a', contentHash: { weird: true } }), 'undefined:hex:undefined');
  });
});

describe('buildInputIndex', () => {
  it('maps fingerprints and consumers, combining multiple hashes per href', () => {
    const graph = {
      nodes: [dnode('n1', [ref('src/a.ts', 'h1')]), dnode('n2', [ref('src/a.ts', 'h2')])],
    };
    const { fingerprints, consumers } = buildInputIndex(graph);
    // Both occurrences fold into a single, order-independent fingerprint.
    assert.equal(fingerprints.get('src/a.ts'), 'sha256:hex:h1|sha256:hex:h2');
    assert.deepEqual([...consumers.get('src/a.ts')].sort(), ['n1', 'n2']);
  });
});

describe('diffFingerprints', () => {
  it('classifies added / changed / removed and unions dirty', () => {
    const baseline = new Map([['a', 'h1'], ['b', 'h1'], ['gone', 'h1']]);
    const current = new Map([['a', 'h1'], ['b', 'h2'], ['new', 'h3']]);
    const d = diffFingerprints(current, baseline);
    assert.deepEqual(d.added, ['new']);
    assert.deepEqual(d.changed, ['b']);
    assert.deepEqual(d.removed, ['gone']);
    assert.deepEqual(d.dirty, ['b', 'new']); // sorted union of added+changed
  });
});

describe('closure', () => {
  it('walks transitive downstream edges deterministically', () => {
    const down = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['x', new Set(['y'])],
    ]);
    assert.deepEqual(closure(['a'], down), ['a', 'b', 'c']);
    assert.deepEqual(closure(['b', 'x'], down), ['b', 'c', 'x', 'y']);
  });
  it('tolerates cycles', () => {
    const down = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['a'])],
    ]);
    assert.deepEqual(closure(['a'], down), ['a', 'b']);
  });
});

describe('computeAffected — full build fallback', () => {
  it('treats all nodes as affected when there is no baseline', () => {
    const graph = { nodes: [dnode('n1', [ref('a', 'h1')]), { id: 'n2' }], edges: [] };
    const r = computeAffected({ graph, baseline: null });
    assert.equal(r.full, true);
    assert.deepEqual(r.affected, ['n1', 'n2']);
    assert.deepEqual(r.dirtyInputs, []);
  });

  it('also full-builds on an empty baseline map', () => {
    const graph = { nodes: [{ id: 'n1' }] };
    const r = computeAffected({ graph, baseline: new Map() });
    assert.equal(r.full, true);
    assert.deepEqual(r.affected, ['n1']);
  });
});

describe('computeAffected — content-hash diff + closure', () => {
  it('seeds the node whose input hash changed; clean inputs are not affected', () => {
    const graph = {
      nodes: [dnode('changed', [ref('src/a.ts', 'h2')]), dnode('clean', [ref('src/b.ts', 'h1')])],
    };
    const baseline = baselineFromGraph({
      nodes: [dnode('changed', [ref('src/a.ts', 'h1')]), dnode('clean', [ref('src/b.ts', 'h1')])],
    });
    const r = computeAffected({ graph, baseline });
    assert.equal(r.full, false);
    assert.deepEqual(r.dirtyInputs, ['src/a.ts']);
    assert.deepEqual(r.seeds, ['changed']);
    assert.deepEqual(r.affected, ['changed']);
  });

  it('propagates downstream through graph edges', () => {
    const graph = {
      nodes: [dnode('a', [ref('src/a.ts', 'h2')]), { id: 'b' }, { id: 'c' }],
      edges: [
        { from: 'a', to: 'b' },
        { from: { '@id': 'b' }, to: { '@id': 'c' } },
      ],
    };
    const baseline = baselineFromGraph({ nodes: [dnode('a', [ref('src/a.ts', 'h1')])] });
    const r = computeAffected({ graph, baseline });
    assert.deepEqual(r.affected, ['a', 'b', 'c']);
  });

  it('propagates downstream through intra-graph Derivation.inputs', () => {
    // node "leaf" derives from the identity href of node "root".
    const graph = {
      nodes: [dnode('root', [ref('src/a.ts', 'h2')]), dnode('leaf', [ref('root')])],
    };
    const baseline = baselineFromGraph({
      nodes: [dnode('root', [ref('src/a.ts', 'h1')]), dnode('leaf', [ref('root')])],
    });
    const r = computeAffected({ graph, baseline });
    assert.deepEqual(r.affected, ['leaf', 'root']);
  });

  it('reports nothing affected when no input hash changed (idempotent)', () => {
    const nodes = [dnode('a', [ref('src/a.ts', 'h1')])];
    const baseline = baselineFromGraph({ nodes });
    const r1 = computeAffected({ graph: { nodes }, baseline });
    const r2 = computeAffected({ graph: { nodes }, baseline });
    assert.deepEqual(r1.affected, []);
    assert.deepEqual(r1, r2); // deterministic / idempotent
  });

  it('seeds an added input (new href absent from baseline)', () => {
    const graph = { nodes: [dnode('a', [ref('src/new.ts', 'h1')])] };
    const baseline = baselineFromGraph({ nodes: [dnode('a', [ref('src/old.ts', 'h1')])] });
    const r = computeAffected({ graph, baseline });
    assert.deepEqual(r.dirtyInputs, ['src/new.ts']);
    assert.deepEqual(r.affected, ['a']);
  });
});

describe('affectedFromGraphs', () => {
  it('full-builds when the baseline graph is absent or empty', () => {
    const current = { nodes: [{ id: 'n1' }] };
    assert.equal(affectedFromGraphs(current, null).full, true);
    assert.equal(affectedFromGraphs(current, { nodes: [], edges: [] }).full, true);
  });

  it('diffs against a non-empty baseline graph', () => {
    const current = { nodes: [dnode('a', [ref('x', 'h2')])] };
    const prior = { nodes: [dnode('a', [ref('x', 'h1')])] };
    const r = affectedFromGraphs(current, prior);
    assert.equal(r.full, false);
    assert.deepEqual(r.affected, ['a']);
  });
});
