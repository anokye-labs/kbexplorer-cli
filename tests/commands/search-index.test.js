import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectionMetadata } from '../../src/commands/search-index.js';

describe('search-index projection metadata', () => {
  it('records explicit access exclusion settings and unit-less node kinds', () => {
    const graph = {
      nodes: [
        { id: 'open-node', title: 'Open node', content: 'Public body', nodeType: 'markdown' },
        { id: 'restricted-node', title: 'Restricted node', access: { classification: 'restricted' }, nodeType: 'issue' },
        { id: 'provider-node', title: 'Provider node', nodeType: 'pull_request' },
      ],
      edges: [],
    };

    const meta = buildProjectionMetadata(graph);
    assert.equal(typeof meta.engineNodeIdSetHash, 'string');
    assert.equal(meta.engineNodeIdSetHash.length, 64);
    assert.ok(Array.isArray(meta.projection.accessExclusion.excludedClassifications));
    assert.ok(meta.projection.unitLessNodeKinds.includes('pull_request'));
    assert.equal(meta.projectedNodeIds.includes('restricted-node'), false);
    assert.equal(meta.projectedNodeIds.includes('open-node'), true);
  });
});
