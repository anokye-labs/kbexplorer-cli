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

  return dir;
}

let dir;
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('loadGraph — identity/access carry-through (AF-004 / AF-008)', () => {
  it('carries identity and access from frontmatter onto the node when present', () => {
    dir = makeFixture();
    const graph = loadGraph({ roots: [dir] });
    const node = graph.nodes.get('labeled');
    assert.ok(node, 'labeled node should load');
    assert.equal(node.identity, 'kg://person/jane-doe');
    assert.equal(node.access, 'internal-only');
  });

  it('leaves identity and access undefined when absent from frontmatter', () => {
    const graph = loadGraph({ roots: [dir] });
    const node = graph.nodes.get('plain');
    assert.ok(node, 'plain node should load');
    assert.equal(node.identity, undefined);
    assert.equal(node.access, undefined);
  });

  it('does not invent enforcement: access is a plain carried value, not validated', () => {
    const graph = loadGraph({ roots: [dir] });
    const node = graph.nodes.get('labeled');
    // No allowlist of access values — carry-through only.
    assert.equal(typeof node.access, 'string');
  });
});
