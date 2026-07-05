/**
 * Tests for src/lib/engine-graph.js#loadGraph() — the Map-shaped adapter over
 * the raw engine graph (the SAME graph the SPA consumes, cli#230). Asserts
 * engine/SPA semantics for `identity` and `access`:
 *   - an author-pinned `identity` is preserved verbatim; an unpinned node gets
 *     a synthesized `urn:content:<id>` identity;
 *   - `access` shorthand is normalized to a canonical KBAccessLabel object;
 *   - access-withheld nodes (restricted/confidential/private) are DROPPED by
 *     the engine before the graph is returned (they never reach the adapter).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { loadGraph } = await import('../../src/lib/engine-graph.js');
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
  it('carries identity and normalizes access into a KBAccessLabel object when present', async () => {
    dir = makeFixture();
    const graph = await loadGraph({ roots: [dir] });
    const node = graph.nodes.get('labeled');
    assert.ok(node, 'labeled node should load');
    assert.equal(node.identity, 'kg://person/jane-doe');
    // AF-009: access is a canonical KBAccessLabel OBJECT, not a bare scalar —
    // the frontmatter shorthand `access: internal-only` carries the tier as
    // `classification`. A bare string is silently dropped by every consumer.
    assert.deepEqual(node.access, { classification: 'internal-only' });
  });

  it('synthesizes identity and leaves access undefined when absent from frontmatter', async () => {
    const graph = await loadGraph({ roots: [dir] });
    const node = graph.nodes.get('plain');
    assert.ok(node, 'plain node should load');
    // The engine mints `urn:content:<id>` for an author who did not pin an
    // identity (same as the SPA graph) — it is NOT undefined.
    assert.equal(node.identity, 'urn:content:plain');
    assert.equal(node.access, undefined);
  });

  it('does not invent enforcement: access is carried as a canonical object, not validated', async () => {
    const graph = await loadGraph({ roots: [dir] });
    const node = graph.nodes.get('labeled');
    // No allowlist of access values — carry-through only — but the shape must
    // be the object core/search/template consume, and re-normalizing is idempotent.
    assert.equal(typeof node.access, 'object');
    assert.deepEqual(normalizeAccessLabel(node.access), node.access);
    assert.equal(node.access.classification, 'internal-only');
  });

  it('drops access-withheld (restricted) nodes from the graph (AF-009)', async () => {
    const nestedDir = makeNestedAccessFixture();
    try {
      const graph = await loadGraph({ roots: [nestedDir] });
      // A restricted node is withheld by the engine — it is absent from the
      // returned graph entirely, so it can never reach any downstream consumer
      // (search index, affordances, SPA). This is the AF-009 guarantee enforced
      // at the engine layer rather than carried and filtered later.
      assert.equal(graph.nodes.get('nested'), undefined, 'restricted node must be dropped');
      assert.equal(graph.nodes.size, 0);
    } finally {
      rmSync(nestedDir, { recursive: true, force: true });
    }
  });
});
