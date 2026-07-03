/**
 * Tests for src/lib/graph.js#loadGraph() — structural round-trip carry-through
 * of `identity` and `access` frontmatter fields onto the in-memory node
 * (AF-004 / AF-008). Carry-through only: no new semantics, no enforcement.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { loadGraph } = await import('../../src/lib/graph.js');
const { normalizeAccessLabel } = await import('../../src/lib/access-label.js');

/** Build a temp dir with a couple of `.md` nodes (no `content/` subdir, so
 * loadGraph scans the root directly). */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-graph-'));
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, 'labeled.md'),
    [
      '---',
      'id: "labeled"',
      'title: "Labeled Node"',
      'cluster: core',
      'identity: "kg://person/jane-doe"',
      'access: "internal-only"',
      '---',
      '',
      'Body text.',
      '',
    ].join('\n')
  );

  writeFileSync(
    join(dir, 'plain.md'),
    ['---', 'id: "plain"', 'title: "Plain Node"', 'cluster: core', '---', '', 'Body text.', ''].join(
      '\n'
    )
  );

  writeFileSync(
    join(dir, 'nested.md'),
    [
      '---',
      'id: "nested"',
      'title: "Nested Access Node"',
      'cluster: core',
      'access:',
      '  classification: restricted',
      '  labels:',
      '    - pii',
      '---',
      '',
      'Body text.',
      '',
    ].join('\n')
  );

  return dir;
}

function makeNestedAccessFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-graph-nested-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'nested.md'),
    [
      '---',
      'id: "nested"',
      'title: "Nested Access Node"',
      'cluster: core',
      'access:',
      '  classification: restricted',
      '  labels:',
      '    - pii',
      '---',
      '',
      'Body text.',
      '',
    ].join('\n')
  );
  return dir;
}

let dir;
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('loadGraph — identity/access carry-through (AF-004 / AF-008)', () => {
  it('carries identity and normalizes access into a KBAccessLabel object when present', () => {
    dir = makeFixture();
    const graph = loadGraph({ roots: [dir] });
    const node = graph.nodes.get('labeled');
    assert.ok(node, 'labeled node should load');
    assert.equal(node.identity, 'kg://person/jane-doe');
    // AF-009: access is a canonical KBAccessLabel OBJECT, not a bare scalar —
    // the frontmatter shorthand `access: internal-only` carries the tier as
    // `classification`. A bare string is silently dropped by every consumer.
    assert.deepEqual(node.access, { classification: 'internal-only' });
  });

  it('leaves identity and access undefined when absent from frontmatter', () => {
    const graph = loadGraph({ roots: [dir] });
    const node = graph.nodes.get('plain');
    assert.ok(node, 'plain node should load');
    assert.equal(node.identity, undefined);
    assert.equal(node.access, undefined);
  });

  it('does not invent enforcement: access is carried as a canonical object, not validated', () => {
    const graph = loadGraph({ roots: [dir] });
    const node = graph.nodes.get('labeled');
    // No allowlist of access values — carry-through only — but the shape must
    // be the object core/search/template consume, and re-normalizing is idempotent.
    assert.equal(typeof node.access, 'object');
    assert.deepEqual(normalizeAccessLabel(node.access), node.access);
    assert.equal(node.access.classification, 'internal-only');
  });

  it('preserves nested access blocks from frontmatter', () => {
    const nestedDir = makeNestedAccessFixture();
    try {
      const graph = loadGraph({ roots: [nestedDir] });
      const node = graph.nodes.get('nested');
      assert.ok(node, 'nested node should load');
      assert.deepEqual(node.access, { classification: 'restricted', labels: ['pii'] });
    } finally {
      rmSync(nestedDir, { recursive: true, force: true });
    }
  });
});
