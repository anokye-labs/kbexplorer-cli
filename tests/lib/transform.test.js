import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { inferIcon, transformCatalogue, TOPIC_ICON_MAP } = await import('../../src/lib/transform.js');

describe('inferIcon', () => {
  it('returns Building for architecture', () => {
    assert.strictEqual(inferIcon('Architecture Overview', 'engine'), 'Building');
  });

  it('returns Database for data topics', () => {
    assert.strictEqual(inferIcon('Data Layer', 'data'), 'Database');
  });

  it('returns PlugConnected for API', () => {
    assert.strictEqual(inferIcon('API Client', 'network'), 'PlugConnected');
  });

  it('returns Document for unknown topics', () => {
    assert.strictEqual(inferIcon('Something Random', 'misc'), 'Document');
  });

  it('returns Book for documentation', () => {
    assert.strictEqual(inferIcon('Docs Reference', 'docs'), 'Book');
  });

  it('returns Beaker for testing', () => {
    assert.strictEqual(inferIcon('Unit Tests', 'testing'), 'Beaker');
  });
});

describe('TOPIC_ICON_MAP', () => {
  it('has entries', () => {
    assert.ok(Object.keys(TOPIC_ICON_MAP).length > 30);
  });

  it('maps to Fluent icon names not emoji', () => {
    for (const val of Object.values(TOPIC_ICON_MAP)) {
      assert.ok(/^[A-Z]/.test(val), `${val} should start with uppercase (Fluent icon name)`);
    }
  });
});

describe('transformCatalogue', () => {
  const OUT = join(tmpdir(), `kbe-test-transform-${Date.now()}`);

  after(() => { rmSync(OUT, { recursive: true, force: true }); });

  it('creates config.yaml and skeleton files', () => {
    const catalogue = {
      title: 'Test KB',
      subtitle: 'Test',
      clusters: { engine: { name: 'Engine', color: '#4A9CC8' } },
      nodes: [
        { id: 'overview', title: 'Overview', cluster: 'engine', emoji: 'Building', connections: [] },
        { id: 'graph', title: 'Graph Engine', cluster: 'engine', emoji: 'Flow', parent: 'overview', connections: [{ to: 'overview', description: 'part of' }] },
      ],
    };

    const result = transformCatalogue(catalogue, OUT);
    assert.ok(existsSync(join(OUT, 'config.yaml')));
    assert.ok(existsSync(join(OUT, 'overview.md')));
    assert.ok(existsSync(join(OUT, 'graph.md')));
    assert.strictEqual(result.totalNodes, 2);
  });

  it('config.yaml has clusters', () => {
    const config = readFileSync(join(OUT, 'config.yaml'), 'utf-8');
    assert.ok(config.includes('engine'));
    assert.ok(config.includes('Engine'));
  });

  it('skeleton has correct frontmatter', () => {
    const content = readFileSync(join(OUT, 'graph.md'), 'utf-8');
    assert.ok(content.includes('id: "graph"'));
    assert.ok(content.includes('parent: "overview"'));
    assert.ok(content.includes('to: "overview"'));
  });

  it('does not overwrite existing new files', () => {
    const catalogue = {
      title: 'Test',
      clusters: {},
      nodes: [{ id: 'overview', title: 'Overwritten?', cluster: 'engine', connections: [] }],
    };
    transformCatalogue(catalogue, OUT);
    const content = readFileSync(join(OUT, 'overview.md'), 'utf-8');
    assert.ok(content.includes('title: "Overview"'), 'Should keep original title');
  });
});
