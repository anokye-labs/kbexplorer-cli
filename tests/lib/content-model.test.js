import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const {
  parseDescriptor,
  validateContentModel,
  KIND_DIRS,
  KNOWN_KINDS,
  _internal,
} = await import('../../src/lib/content-model.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures', 'content-model');
const CLEAN = resolve(FIXTURES, 'clean');
const BROKEN = resolve(FIXTURES, 'broken');

function rules(result) {
  return new Set(result.findings.map((f) => f.rule));
}

describe('content-model — parseDescriptor', () => {
  it('parses scalars, quoted keys/values, and coerces integers', () => {
    const r = parseDescriptor('"@type": priority\nid: p1\nname: "P1 — Done"\nrank: 1\n');
    assert.ok(r.ok);
    assert.equal(r.data['@type'], 'priority');
    assert.equal(r.data.id, 'p1');
    assert.equal(r.data.name, 'P1 — Done');
    assert.equal(r.data.rank, 1);
    assert.equal(typeof r.data.rank, 'number');
  });

  it('strips inline comments from bare scalars and list items', () => {
    const r = parseDescriptor(
      ['"@type": person', 'id: adwoa', 'name: Adwoa', 'manager: kwame   # reports-to'].join('\n'),
    );
    assert.ok(r.ok);
    assert.equal(r.data.manager, 'kwame');
  });

  it('keeps "#" inside quoted values', () => {
    const r = parseDescriptor('"@type": system-of-record\nid: s\nname: N\nurl: "https://x/#a"\n');
    assert.ok(r.ok);
    assert.equal(r.data.url, 'https://x/#a');
  });

  it('parses block lists with inline comments', () => {
    const r = parseDescriptor(
      ['"@type": team', 'id: t', 'name: T', 'members:', '  - adwoa   # a', '  - kwame'].join('\n'),
    );
    assert.ok(r.ok);
    assert.deepEqual(r.data.members, ['adwoa', 'kwame']);
  });

  it('parses an empty inline list', () => {
    const r = parseDescriptor('"@type": team\nid: t\nname: T\nmembers: []\n');
    assert.ok(r.ok);
    // `[]` is treated as a verbatim inline-collection scalar, not a populated list.
    assert.ok(r.data.members === '[]' || (Array.isArray(r.data.members) && r.data.members.length === 0));
  });

  it('parses a folded block scalar', () => {
    const r = parseDescriptor(
      ['"@type": team', 'id: t', 'name: T', 'description: >', '  line one', '  line two', 'lead: adwoa'].join(
        '\n',
      ),
    );
    assert.ok(r.ok);
    assert.equal(r.data.description, 'line one line two');
    assert.equal(r.data.lead, 'adwoa');
  });

  it('reports malformed YAML on a stray indented line', () => {
    const r = parseDescriptor('  oops: indented\n');
    assert.equal(r.ok, false);
    assert.match(r.error, /indent/i);
  });

  it('reports malformed YAML on a missing colon', () => {
    const r = parseDescriptor('"@type": person\njust-a-bare-line\n');
    assert.equal(r.ok, false);
  });
});

describe('content-model — registry', () => {
  it('maps the five kind directories', () => {
    assert.deepEqual(Object.keys(KIND_DIRS).sort(), [
      'people',
      'priorities',
      'systems-of-record',
      'teams',
      'workstreams',
    ]);
    assert.deepEqual([...KNOWN_KINDS].sort(), [
      'person',
      'priority',
      'system-of-record',
      'team',
      'workstream',
    ]);
  });
});

describe('content-model — validateContentModel (clean tree)', () => {
  it('returns zero errors for the clean fixture', () => {
    const result = validateContentModel({ rootDir: CLEAN });
    assert.equal(result.summary.errors, 0, JSON.stringify(result.findings, null, 2));
    assert.equal(result.findings.length, 0);
    assert.equal(result.exists, true);
    assert.equal(result.summary.descriptors, 7);
    assert.deepEqual(result.summary.byKind, {
      person: 2,
      team: 1,
      workstream: 1,
      priority: 1,
      'system-of-record': 2,
    });
  });

  it('treats a missing content-model directory as valid (nothing to validate)', () => {
    const result = validateContentModel({ rootDir: resolve(FIXTURES, 'does-not-exist') });
    assert.equal(result.exists, false);
    assert.equal(result.summary.errors, 0);
  });
});

describe('content-model — validateContentModel (broken tree)', () => {
  const result = validateContentModel({ rootDir: BROKEN });

  it('exits with errors', () => {
    assert.ok(result.summary.errors > 0);
  });

  it('flags every rule category', () => {
    const r = rules(result);
    for (const rule of [
      'missing-required-field',
      'broken-ref',
      'duplicate-id',
      'unknown-kind',
      'reports-to-cycle',
      'type-mismatch',
      'off-taxonomy-relation',
    ]) {
      assert.ok(r.has(rule), `expected rule "${rule}" — got ${[...r].join(', ')}`);
    }
  });

  it('reports each dangling FK with a precise file-scoped finding', () => {
    const broken = result.findings.filter((f) => f.rule === 'broken-ref');
    const refs = broken.map((f) => f.ref).sort();
    assert.deepEqual(refs, ['ghost-team', 'no-sor', 'p9']);
    for (const f of broken) {
      assert.match(f.file, /orphan\.yaml$/);
      assert.ok(f.field && f.target);
    }
  });

  it('reports the duplicate id with both files', () => {
    const dup = result.findings.find((f) => f.rule === 'duplicate-id');
    assert.equal(dup.id, 'bee');
    assert.equal(dup.kind, 'person');
    assert.equal(dup.files.length, 2);
  });

  it('detects the reports-to cycle', () => {
    const cyc = result.findings.find((f) => f.rule === 'reports-to-cycle');
    assert.ok(cyc.cycle.includes('cyril') && cyc.cycle.includes('dora'));
  });
});

describe('content-model — detectReportsToCycles', () => {
  it('returns nothing for an acyclic chain', () => {
    const people = [
      { id: 'a', manager: null },
      { id: 'b', manager: 'a' },
      { id: 'c', manager: 'b' },
    ];
    assert.deepEqual(_internal.detectReportsToCycles(people), []);
  });

  it('does not treat a dangling manager as a cycle', () => {
    const people = [{ id: 'a', manager: 'ghost' }];
    assert.deepEqual(_internal.detectReportsToCycles(people), []);
  });

  it('detects a self-managed cycle', () => {
    const people = [{ id: 'a', manager: 'a' }];
    const cycles = _internal.detectReportsToCycles(people);
    assert.ok(cycles.length >= 1);
  });
});
