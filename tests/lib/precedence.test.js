import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePrecedence, pickWinner } from '../../src/lib/precedence.ts';
import { conflateReferents } from '../../src/lib/conflation.ts';
import { canonicalStringify } from '../../src/lib/jsonld.ts';

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

/** Build a conflated graph of two same-referent people with conflicting fields. */
function conflatedPair(aExtra, bExtra) {
  const a = node('gh', {
    sourceId: 'github',
    identity: 'kg://p/a',
    identityClaims: [claim('same-as', 'kg://p/b')],
    ...aExtra,
  });
  const b = node('dir', { sourceId: 'directory', identity: 'kg://p/b', ...bExtra });
  const { graph } = conflateReferents({ nodes: [a, b] });
  assert.equal(graph.nodes.length, 1, 'expected one conflated node');
  return graph;
}

describe('resolvePrecedence — winner selection by declared precedence', () => {
  it('picks the higher-precedence source value for a conflicting node-level field', () => {
    // gh (representative, identity kg://p/a) holds title 'Ada (GH)'; dir holds 'Ada Lovelace'.
    const conflated = conflatedPair({ title: 'Ada (GH)' }, { title: 'Ada Lovelace' });
    const { graph, stats } = resolvePrecedence(conflated, {
      config: { precedence: { sources: ['directory', 'github'] } },
    });
    const n = graph.nodes[0];
    assert.equal(n.title, 'Ada Lovelace'); // directory outranks github
    assert.equal(stats.fieldsResolved, 1);
    assert.equal(stats.fieldsConflicted, 0);
    assert.deepEqual(n.precedence.resolved.title, {
      sourceId: 'directory',
      value: 'Ada Lovelace',
      via: 'sources',
    });
    assert.ok(!('conflicts' in n.precedence));
    // conflatedFrom is never mutated.
    assert.equal(n.conflatedFrom.length, 2);
  });

  it('per-field override beats the global sources order (via: fields)', () => {
    const conflated = conflatedPair({ title: 'Ada (GH)' }, { title: 'Ada Lovelace' });
    const { graph } = resolvePrecedence(conflated, {
      config: {
        precedence: { sources: ['directory', 'github'], fields: { title: ['github', 'directory'] } },
      },
    });
    const n = graph.nodes[0];
    assert.equal(n.title, 'Ada (GH)'); // field override flips the winner
    assert.equal(n.precedence.resolved.title.via, 'fields');
    assert.equal(n.precedence.resolved.title.sourceId, 'github');
  });

  it('resolves a conflicting data.* key addressed by its bare name', () => {
    const conflated = conflatedPair(
      { data: { role: 'IC' } },
      { data: { role: 'Manager' } }
    );
    const { graph } = resolvePrecedence(conflated, {
      config: { precedence: { sources: ['directory', 'github'], fields: { role: ['directory'] } } },
    });
    const n = graph.nodes[0];
    assert.equal(n.data.role, 'Manager');
    assert.equal(n.precedence.resolved.role.via, 'fields');
  });
});

describe('resolvePrecedence — node-field vs data-key disambiguation', () => {
  it('a fields[name] rule targets the node-level field when one exists; data.name is ignored for that field', () => {
    // Both members have node-level title AND a data.title; the node-level field owns 'title'.
    const conflated = conflatedPair(
      { title: 'Node A', data: { title: 'Data A' } },
      { title: 'Node B', data: { title: 'Data B' } }
    );
    const { graph } = resolvePrecedence(conflated, {
      config: { precedence: { sources: ['github', 'directory'], fields: { title: ['directory'] } } },
    });
    const n = graph.nodes[0];
    assert.equal(n.title, 'Node B'); // node-level resolved
    assert.equal(n.precedence.resolved.title.value, 'Node B');
    // data.title was never treated as the 'title' field, so it is not resolved nor flattened.
    assert.ok(!('title' in (n.precedence.conflicts ?? {})));
  });

  it('a data key keeps its own slot when the name also exists node-level (node-level resolved, data untouched)', () => {
    // Both members have node-level title (gh/dir) AND a data.title. 'title' is owned
    // node-level; data.title is never treated as the resolvable 'title' field.
    const conflated = conflatedPair({ data: { title: 'Data A' } }, { data: { title: 'Data B' } });
    const { graph } = resolvePrecedence(conflated, {
      config: { precedence: { sources: ['directory', 'github'] } },
    });
    const n = graph.nodes[0];
    assert.equal(n.title, 'dir'); // node-level title resolved (directory outranks github)
    assert.equal(n.precedence.resolved.title.value, 'dir');
    // data.title stays as the representative's value, never resolved/flattened as 'title'.
    assert.equal(n.data.title, 'Data A');
  });
});

describe('resolvePrecedence — conflict preservation (never silently flatten)', () => {
  it('with NO precedence config, retains both competing values with provenance', () => {
    const conflated = conflatedPair({ title: 'Ada (GH)' }, { title: 'Ada Lovelace' });
    const repTitle = conflated.nodes[0].title; // #138 representative placeholder
    const { graph, stats } = resolvePrecedence(conflated, {});
    const n = graph.nodes[0];
    assert.equal(n.title, repTitle); // placeholder kept, NOT flattened
    assert.equal(stats.fieldsResolved, 0);
    assert.equal(stats.fieldsConflicted, 1);
    assert.ok(!('resolved' in n.precedence));
    assert.deepEqual(
      n.precedence.conflicts.title.map((c) => c.sourceId),
      ['directory', 'github']
    );
    assert.deepEqual(
      n.precedence.conflicts.title.map((c) => c.value).sort(),
      ['Ada (GH)', 'Ada Lovelace']
    );
  });

  it('preserves the conflict when every contributing sourceId is unranked', () => {
    const conflated = conflatedPair({ title: 'Ada (GH)' }, { title: 'Ada Lovelace' });
    const { graph } = resolvePrecedence(conflated, {
      config: { precedence: { sources: ['some-other-source'] } },
    });
    const n = graph.nodes[0];
    assert.ok('conflicts' in n.precedence);
    assert.ok(!('resolved' in n.precedence));
  });

  it('does not touch a field where all members agree', () => {
    const conflated = conflatedPair({ title: 'Same' }, { title: 'Same' });
    const { graph, stats } = resolvePrecedence(conflated, {
      config: { precedence: { sources: ['directory', 'github'] } },
    });
    assert.equal(stats.fieldsResolved, 0);
    assert.equal(stats.fieldsConflicted, 0);
    assert.ok(!('precedence' in graph.nodes[0]));
  });
});

describe('resolvePrecedence — pickWinner unit', () => {
  it('returns null without an order (conflict-preserve)', () => {
    assert.equal(pickWinner([{ sourceId: 'a', value: 1 }], null), null);
  });
  it('returns null when the top source disagrees with itself', () => {
    const w = pickWinner(
      [
        { sourceId: 'a', value: 1 },
        { sourceId: 'a', value: 2 },
      ],
      ['a', 'b']
    );
    assert.equal(w, null);
  });
  it('ranks by order index, lowest index wins', () => {
    const w = pickWinner(
      [
        { sourceId: 'b', value: 'lo' },
        { sourceId: 'a', value: 'hi' },
      ],
      ['a', 'b']
    );
    assert.deepEqual(w, { sourceId: 'a', value: 'hi' });
  });
});

describe('resolvePrecedence — passthrough + idempotency', () => {
  it('leaves non-conflated (singleton) nodes verbatim', () => {
    const g = { nodes: [node('solo', { title: 'Solo' })], edges: [] };
    const { graph, stats } = resolvePrecedence(g, {
      config: { precedence: { sources: ['x'] } },
    });
    assert.equal(stats.conflatedNodes, 0);
    assert.deepEqual(graph.nodes[0], g.nodes[0]);
  });

  it('is idempotent: re-running over its own output is byte-identical', () => {
    const conflated = conflatedPair({ title: 'Ada (GH)' }, { title: 'Ada Lovelace' });
    const cfg = { config: { precedence: { sources: ['directory', 'github'] } } };
    const first = resolvePrecedence(conflated, cfg);
    const second = resolvePrecedence(first.graph, cfg);
    assert.equal(canonicalStringify(first.graph.nodes), canonicalStringify(second.graph.nodes));
  });

  it('conflict-preservation is also idempotent (no-config)', () => {
    const conflated = conflatedPair({ title: 'Ada (GH)' }, { title: 'Ada Lovelace' });
    const first = resolvePrecedence(conflated, {});
    const second = resolvePrecedence(first.graph, {});
    assert.equal(canonicalStringify(first.graph.nodes), canonicalStringify(second.graph.nodes));
  });
});
