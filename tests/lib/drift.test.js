import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceOf,
  buildSourceIndex,
  rollupSources,
  computeSyncStatus,
  UNKNOWN_SOURCE,
} from '../../src/lib/drift.js';

const hash = (d) => ({ algorithm: 'sha256', digest: d, encoding: 'hex' });

/** A node in source `src` deriving from input `href` with content-hash `digest`. */
const dnode = (id, src, href, digest) => ({
  id,
  sourceId: src,
  derivation: {
    mode: 'derived',
    generator: 'g@1',
    inputs: [{ kind: 'git', href, contentHash: hash(digest) }],
  },
});

describe('drift — sourceOf', () => {
  it('prefers sourceId, falls back to provider, then sentinel', () => {
    assert.equal(sourceOf({ sourceId: 'gh', provider: 'x' }), 'gh');
    assert.equal(sourceOf({ provider: 'sp' }), 'sp');
    assert.equal(sourceOf({}), UNKNOWN_SOURCE);
    assert.equal(sourceOf(null), UNKNOWN_SOURCE);
  });
});

describe('drift — buildSourceIndex', () => {
  it('maps every node and edge key to its source', () => {
    const graph = {
      nodes: [dnode('a', 'gh', 'x', 'h1'), dnode('b', 'sp', 'y', 'h2')],
      edges: [{ id: 'e1', sourceId: 'gh', from: 'a', to: 'b' }],
    };
    const idx = buildSourceIndex(graph);
    assert.equal(idx.get('a'), 'gh');
    assert.equal(idx.get('b'), 'sp');
    assert.equal(idx.get('e1'), 'gh');
  });
});

describe('drift — rollupSources', () => {
  it('classifies drifted (seed) vs stale (downstream) vs in-sync', () => {
    // a (gh) drifted; b (sp) is downstream of a via edge a->b, so stale.
    const current = {
      nodes: [dnode('a', 'gh', 'x', 'h2'), { id: 'b', sourceId: 'sp' }],
      edges: [{ id: 'e1', sourceId: 'gh', from: 'a', to: 'b' }],
    };
    const affected = { full: false, seeds: ['a'], affected: ['a', 'b'] };
    const rollup = rollupSources({ current, affected });
    const byId = Object.fromEntries(rollup.map((r) => [r.source, r]));
    assert.equal(byId.gh.status, 'drifted');
    assert.deepEqual(byId.gh.drifted, ['a']);
    assert.equal(byId.sp.status, 'stale');
    assert.deepEqual(byId.sp.stale, ['b']);
  });

  it('reports in-sync sources and is sorted by source', () => {
    const current = { nodes: [{ id: 'a', sourceId: 'zeta' }, { id: 'b', sourceId: 'alpha' }] };
    const rollup = rollupSources({ current, affected: { full: false, seeds: [], affected: [] } });
    assert.deepEqual(rollup.map((r) => r.source), ['alpha', 'zeta']);
    assert.ok(rollup.every((r) => r.status === 'in-sync'));
  });
});

describe('drift — computeSyncStatus', () => {
  it('no baseline ⇒ full build, not drift', () => {
    const current = { nodes: [dnode('a', 'gh', 'x', 'h1')] };
    const s = computeSyncStatus({ current, baseline: null });
    assert.equal(s.full, true);
    assert.equal(s.drift, false);
    assert.equal(s.inSync, false);
  });

  it('unchanged graph vs baseline ⇒ in sync', () => {
    const current = { nodes: [dnode('a', 'gh', 'x', 'h1')] };
    const baseline = { nodes: [dnode('a', 'gh', 'x', 'h1')] };
    const s = computeSyncStatus({ current, baseline });
    assert.equal(s.full, false);
    assert.equal(s.drift, false);
    assert.equal(s.inSync, true);
    assert.deepEqual(s.graph.affected, []);
  });

  it('changed input hash ⇒ drift + drifted source', () => {
    const current = { nodes: [dnode('a', 'gh', 'x', 'h2')] };
    const baseline = { nodes: [dnode('a', 'gh', 'x', 'h1')] };
    const s = computeSyncStatus({ current, baseline });
    assert.equal(s.drift, true);
    assert.equal(s.inSync, false);
    assert.deepEqual(s.graph.dirtyInputs, ['x']);
    assert.equal(s.sources.find((x) => x.source === 'gh').status, 'drifted');
  });

  it('folds in connection-artifact drift even when the graph is clean', () => {
    const current = { nodes: [dnode('a', 'gh', 'x', 'h1')] };
    const baseline = { nodes: [dnode('a', 'gh', 'x', 'h1')] };
    const connect = { ok: false, drift: [{ file: 'minted-edges.json', reason: 'stale' }] };
    const s = computeSyncStatus({ current, baseline, connect });
    assert.equal(s.drift, true);
    assert.equal(s.connect.ok, false);
    assert.equal(s.connect.drift.length, 1);
  });

  it('is deterministic — identical inputs yield identical status', () => {
    const current = { nodes: [dnode('a', 'gh', 'x', 'h2'), dnode('b', 'sp', 'y', 'h1')] };
    const baseline = { nodes: [dnode('a', 'gh', 'x', 'h1'), dnode('b', 'sp', 'y', 'h1')] };
    const a = computeSyncStatus({ current, baseline });
    const b = computeSyncStatus({ current, baseline });
    assert.deepEqual(a, b);
  });
});
