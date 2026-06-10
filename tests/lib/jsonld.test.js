import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  slugify,
  normalizeType,
  buildId,
  buildEdgeId,
  mapRelation,
  normalizeExtraction,
  buildArtifact,
  canonicalStringify,
  validateArtifact,
  toKBNode,
  sourceRefOf,
  KNOWN_RELATIONS,
  DEFAULT_CONTEXT,
  ARTIFACT_SCHEMA_VERSION,
} = await import('../../src/lib/jsonld.js');

const INTERMEDIATE = {
  entities: [
    { id: 'jane', type: 'Person', name: 'Jane Doe', properties: { jobTitle: 'VP Eng', nested: { x: 1 } } },
    { type: 'team', name: 'Platform Team' },
    { type: 'team', name: 'Platform Team' }, // duplicate → same @id, merged
  ],
  relationships: [
    { from: 'jane', to: 'Platform Team', type: 'manages' }, // synonym → leads
    { from: 'Platform Team', to: 'jane', type: 'reports to' }, // phrase → reports-to
    { from: 'jane', to: 'jane', type: 'leads' }, // self → dropped
    { from: 'ghost', to: 'jane', type: 'leads' }, // dangling → dropped
  ],
};

describe('slugify / normalizeType / buildId', () => {
  it('kebab-cases and ascii-folds', () => {
    assert.strictEqual(slugify('Jürgen Müller!!'), 'jurgen-muller');
    assert.strictEqual(slugify('  Platform  Team  '), 'platform-team');
  });
  it('falls back to "unknown" for empty input', () => {
    assert.strictEqual(slugify(''), 'unknown');
    assert.strictEqual(slugify(null), 'unknown');
  });
  it('normalizeType maps empty to "entity"', () => {
    assert.strictEqual(normalizeType(''), 'entity');
    assert.strictEqual(normalizeType('Person'), 'person');
  });
  it('buildId yields kg://<type>/<slug>', () => {
    assert.strictEqual(buildId('Person', 'Jane Doe'), 'kg://person/jane-doe');
  });
  it('buildEdgeId strips schemes and joins with the relation', () => {
    assert.strictEqual(
      buildEdgeId('kg://person/jane', 'leads', 'kg://team/platform'),
      'kg://edge/person/jane~leads~team/platform',
    );
  });
});

describe('mapRelation', () => {
  it('passes through known relations', () => {
    for (const r of KNOWN_RELATIONS) assert.strictEqual(mapRelation(r).relation, r);
  });
  it('maps synonyms (single + phrase)', () => {
    assert.strictEqual(mapRelation('manages').relation, 'leads');
    assert.strictEqual(mapRelation('reports to').relation, 'reports-to');
    assert.strictEqual(mapRelation('part of').relation, 'structural');
    assert.strictEqual(mapRelation('member-of').relation, 'staffs');
  });
  it('falls back to structural for unknown relations', () => {
    const m = mapRelation('frobnicates');
    assert.strictEqual(m.relation, 'structural');
    assert.strictEqual(m.raw, 'frobnicates');
  });
});

describe('normalizeExtraction', () => {
  const { nodes, edges, graph } = normalizeExtraction(INTERMEDIATE, { sourceRef: 'docs/org.docx' });

  it('dedupes entities by @id', () => {
    assert.strictEqual(nodes.length, 2);
    const ids = nodes.map((n) => n.id).sort();
    assert.deepStrictEqual(ids, ['kg://person/jane', 'kg://team/platform-team']);
  });
  it('promotes only scalar properties to jsonld', () => {
    const jane = nodes.find((n) => n.id === 'kg://person/jane');
    assert.strictEqual(jane.jsonld.jobTitle, 'VP Eng');
    assert.ok(!('nested' in jane.jsonld)); // non-scalar excluded from LD bag
    assert.deepStrictEqual(jane.data.nested, { x: 1 }); // but retained in data
  });
  it('embeds a reversible source.ref', () => {
    const jane = nodes.find((n) => n.id === 'kg://person/jane');
    assert.ok(jane.source.ref.startsWith('docs/org.docx#'));
  });
  it('resolves endpoints, maps taxonomy, drops self + dangling edges', () => {
    assert.strictEqual(edges.length, 2);
    const rels = edges.map((e) => e.relation).sort();
    assert.deepStrictEqual(rels, ['leads', 'reports-to']);
    for (const e of edges) assert.ok(KNOWN_RELATIONS.includes(e.relation));
  });
  it('records the raw relation when remapped', () => {
    const leads = edges.find((e) => e.relation === 'leads');
    assert.strictEqual(leads.relationRaw, 'manages');
  });
  it('builds a combined @graph of nodes + Relationship members', () => {
    const rels = graph.filter((m) => m['@type'] === 'Relationship');
    const ents = graph.filter((m) => m['@type'] !== 'Relationship');
    assert.strictEqual(ents.length, 2);
    assert.strictEqual(rels.length, 2);
    assert.ok(rels.every((r) => r.from?.['@id'] && r.to?.['@id']));
  });
});

describe('buildArtifact + validateArtifact', () => {
  const artifact = buildArtifact({
    source: { path: 'docs/org.docx', format: 'docx', sha256: 'sha256:abc', bytes: 10 },
    intermediate: INTERMEDIATE,
  });

  it('carries schema version, generator, and embedded extraction (no timestamp)', () => {
    assert.strictEqual(artifact.kbexplorer.schemaVersion, ARTIFACT_SCHEMA_VERSION);
    assert.ok(artifact.kbexplorer.generator.includes('derive'));
    assert.deepStrictEqual(artifact.kbexplorer.extraction.entities, INTERMEDIATE.entities);
    const json = JSON.stringify(artifact);
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(json)); // no ISO timestamp anywhere
  });
  it('defaults @context to schema.org', () => {
    assert.strictEqual(artifact['@context'], DEFAULT_CONTEXT);
  });
  it('validates clean against the F1 contract', () => {
    const v = validateArtifact(artifact);
    assert.deepStrictEqual(v.errors, []);
    assert.ok(v.ok);
  });
  it('requires source.path', () => {
    assert.throws(() => buildArtifact({ intermediate: INTERMEDIATE }), /source\.path/);
  });

  it('flags a path-derived @type', () => {
    const bad = structuredClone(artifact);
    bad['@graph'].find((m) => m['@type'] === 'person')['@type'] = 'docs/org.docx';
    const v = validateArtifact(bad);
    assert.ok(!v.ok);
    assert.ok(v.errors.some((e) => /path-derived/.test(e)));
  });
  it('flags an off-taxonomy edge relation', () => {
    const bad = structuredClone(artifact);
    bad.kbexplorer.edges[0].relation = 'frobnicates';
    const v = validateArtifact(bad);
    assert.ok(!v.ok);
    assert.ok(v.errors.some((e) => /off-taxonomy/.test(e)));
  });
  it('flags a non-URN @id', () => {
    const bad = structuredClone(artifact);
    bad['@graph'].find((m) => m['@type'] === 'team')['@id'] = 'not-a-urn';
    const v = validateArtifact(bad);
    assert.ok(!v.ok);
  });
});

describe('canonicalStringify (idempotency)', () => {
  it('is byte-identical for structurally identical inputs regardless of key order', () => {
    const a = buildArtifact({ source: { path: 'a.docx', sha256: 'sha256:1', bytes: 1 }, intermediate: INTERMEDIATE });
    const b = buildArtifact({ source: { path: 'a.docx', sha256: 'sha256:1', bytes: 1 }, intermediate: INTERMEDIATE });
    assert.strictEqual(canonicalStringify(a), canonicalStringify(b));
  });
  it('sorts keys and appends a trailing newline', () => {
    const s = canonicalStringify({ b: 1, a: 2 });
    assert.strictEqual(s, '{\n  "a": 2,\n  "b": 1\n}\n');
  });
});

describe('reversibility (toKBNode / sourceRefOf)', () => {
  it('maps a graph member back to a KBNode and recovers the source ref', () => {
    const { graph } = normalizeExtraction(INTERMEDIATE, { sourceRef: 'docs/org.docx' });
    const member = graph.find((m) => m['@type'] === 'person');
    const node = toKBNode(member, 'docs/org.docx');
    assert.strictEqual(node.entityType, 'person');
    assert.strictEqual(node.identity, member['@id']);
    const { path, anchor } = sourceRefOf(node);
    assert.strictEqual(path, 'docs/org.docx');
    assert.ok(anchor.length > 0);
  });
});
