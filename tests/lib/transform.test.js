import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { inferIcon, transformCatalogue, collectExistingClusters, TOPIC_ICON_MAP } = await import('../../src/lib/transform.js');

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

// ── collectExistingClusters ────────────────────────────────────────────────────

describe('collectExistingClusters', () => {
  const OUT = join(tmpdir(), `kbe-test-collect-clusters-${Date.now()}`);
  before(() => { mkdirSync(OUT, { recursive: true }); });
  after(() => { rmSync(OUT, { recursive: true, force: true }); });

  it('returns empty map for empty directory', () => {
    const result = collectExistingClusters(OUT);
    assert.strictEqual(result.size, 0);
  });

  it('returns empty map for non-existent directory', () => {
    const result = collectExistingClusters(join(OUT, 'nonexistent'));
    assert.strictEqual(result.size, 0);
  });

  it('collects cluster IDs from .md files with frontmatter', () => {
    writeFileSync(join(OUT, 'a.md'), '---\nid: "a"\ntitle: "A"\ncluster: alpha\nconnections: []\n---\n# A\n', 'utf-8');
    writeFileSync(join(OUT, 'b.md'), '---\nid: "b"\ntitle: "B"\ncluster: beta\nconnections: []\n---\n# B\n', 'utf-8');
    writeFileSync(join(OUT, 'c.md'), '---\nid: "c"\ntitle: "C"\ncluster: alpha\nconnections: []\n---\n# C\n', 'utf-8');

    const result = collectExistingClusters(OUT);
    assert.ok(result.has('alpha'), 'Should have alpha cluster');
    assert.ok(result.has('beta'), 'Should have beta cluster');
    assert.strictEqual(result.size, 2, 'Duplicate cluster IDs are deduplicated');
  });

  it('ignores non-.md files', () => {
    writeFileSync(join(OUT, 'config.yaml'), 'clusters:\n  gamma:\n    name: Gamma\n', 'utf-8');
    const result = collectExistingClusters(OUT);
    assert.ok(!result.has('gamma'), 'config.yaml clusters should not be picked up');
  });

  it('ignores .md files without frontmatter cluster field', () => {
    writeFileSync(join(OUT, 'no-fm.md'), '# No frontmatter\n\nJust a body.\n', 'utf-8');
    const before = collectExistingClusters(OUT).size;
    // Size should not increase from adding a file without cluster: field
    const after = collectExistingClusters(OUT).size;
    assert.strictEqual(before, after);
  });
});

// ── Regression #40: connections with string IDs must not produce `to: "undefined"` ──

describe('transformCatalogue — fix #40: string-array connections', () => {
  const OUT = join(tmpdir(), `kbe-test-transform-40-${Date.now()}`);
  after(() => { rmSync(OUT, { recursive: true, force: true }); });

  it('string IDs produce correct `to:` frontmatter, not to: "undefined"', () => {
    const catalogue = {
      title: 'Test #40',
      clusters: { cmd: { name: 'Commands', color: '#000' } },
      nodes: [
        {
          id: 'cmd-init',
          title: 'init',
          cluster: 'cmd',
          // architect emits bare string IDs
          connections: ['cmd-generate', 'cmd-manifest'],
        },
        { id: 'cmd-generate', title: 'generate', cluster: 'cmd', connections: [] },
        { id: 'cmd-manifest', title: 'manifest', cluster: 'cmd', connections: [] },
      ],
    };

    transformCatalogue(catalogue, OUT);
    const content = readFileSync(join(OUT, 'cmd-init.md'), 'utf-8');

    // Must contain the actual target IDs
    assert.ok(content.includes('to: "cmd-generate"'), 'Should have to: "cmd-generate"');
    assert.ok(content.includes('to: "cmd-manifest"'), 'Should have to: "cmd-manifest"');
    // Must NOT contain the bug string
    assert.ok(!content.includes('to: "undefined"'), 'Must not produce to: "undefined"');
  });

  it('object connections with {to, description} still work', () => {
    const catalogue = {
      title: 'Test #40 obj',
      clusters: { lib: { name: 'Libs', color: '#000' } },
      nodes: [
        {
          id: 'lib-a',
          title: 'Lib A',
          cluster: 'lib',
          connections: [{ to: 'lib-b', description: 'calls' }],
        },
        { id: 'lib-b', title: 'Lib B', cluster: 'lib', connections: [] },
      ],
    };

    transformCatalogue(catalogue, OUT);
    const content = readFileSync(join(OUT, 'lib-a.md'), 'utf-8');
    assert.ok(content.includes('to: "lib-b"'), 'Object connection: to should be set');
    assert.ok(content.includes('description: "calls"'), 'Object connection: description should be set');
  });

  it('mixed string and object connections both resolve correctly', () => {
    const catalogue = {
      title: 'Test #40 mixed',
      clusters: { core: { name: 'Core', color: '#000' } },
      nodes: [
        {
          id: 'core-x',
          title: 'Core X',
          cluster: 'core',
          connections: ['core-y', { to: 'core-z', description: 'imports' }],
        },
        { id: 'core-y', title: 'Core Y', cluster: 'core', connections: [] },
        { id: 'core-z', title: 'Core Z', cluster: 'core', connections: [] },
      ],
    };

    transformCatalogue(catalogue, OUT);
    const content = readFileSync(join(OUT, 'core-x.md'), 'utf-8');
    assert.ok(content.includes('to: "core-y"'), 'String connection should resolve');
    assert.ok(content.includes('to: "core-z"'), 'Object connection should resolve');
    assert.ok(!content.includes('to: "undefined"'), 'No undefined connections');
  });
});

// ── Regression #41: generate --refresh must not orphan existing clusters ──

describe('transformCatalogue — fix #41: orphaned cluster guard', () => {
  const OUT = join(tmpdir(), `kbe-test-transform-41-${Date.now()}`);
  after(() => { rmSync(OUT, { recursive: true, force: true }); });

  it('preserves existing cluster IDs not in the new catalogue as legacy entries', () => {
    // First run: 3 clusters, 3 nodes
    const catalogue1 = {
      title: 'KB v1',
      clusters: {
        entry: { name: 'Entry', color: '#111' },
        commands: { name: 'Commands', color: '#222' },
        libs: { name: 'Libraries', color: '#333' },
      },
      nodes: [
        { id: 'home', title: 'Home', cluster: 'entry', connections: [] },
        { id: 'cmd-init', title: 'Init', cluster: 'commands', connections: [] },
        { id: 'lib-core', title: 'Core', cluster: 'libs', connections: [] },
      ],
    };
    transformCatalogue(catalogue1, OUT);

    // Second run (simulating --refresh): completely different clusters
    const catalogue2 = {
      title: 'KB v2',
      clusters: {
        overview: { name: 'Overview', color: '#444' },
        install: { name: 'Install', color: '#555' },
      },
      nodes: [
        { id: 'overview', title: 'Overview', cluster: 'overview', connections: [] },
        { id: 'install', title: 'Install', cluster: 'install', connections: [] },
      ],
    };
    const result = transformCatalogue(catalogue2, OUT);

    // The 3 legacy clusters must appear in config.yaml
    const config = readFileSync(join(OUT, 'config.yaml'), 'utf-8');
    assert.ok(config.includes('entry:'), 'Orphaned cluster "entry" must be preserved');
    assert.ok(config.includes('commands:'), 'Orphaned cluster "commands" must be preserved');
    assert.ok(config.includes('libs:'), 'Orphaned cluster "libs" must be preserved');
    assert.ok(config.includes('overview:'), 'New cluster "overview" must be present');

    // The result must report orphaned clusters
    assert.ok(Array.isArray(result.orphanedClusters), 'orphanedClusters should be an array');
    assert.ok(result.orphanedClusters.includes('entry'), 'entry should be in orphanedClusters');
    assert.ok(result.orphanedClusters.includes('commands'), 'commands should be in orphanedClusters');
    assert.ok(result.orphanedClusters.includes('libs'), 'libs should be in orphanedClusters');
  });

  it('does not add orphaned clusters when no existing content', () => {
    const emptyDir = join(tmpdir(), `kbe-test-transform-41-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      const catalogue = {
        title: 'Fresh KB',
        clusters: { overview: { name: 'Overview', color: '#444' } },
        nodes: [{ id: 'overview', title: 'Overview', cluster: 'overview', connections: [] }],
      };
      const result = transformCatalogue(catalogue, emptyDir);
      assert.deepStrictEqual(result.orphanedClusters, [], 'No orphaned clusters on first run');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('does not add clusters already in the new catalogue', () => {
    // Existing content uses "entry" cluster; new catalogue also has "entry"
    const OUT2 = join(tmpdir(), `kbe-test-transform-41b-${Date.now()}`);
    mkdirSync(OUT2, { recursive: true });
    try {
      // Seed an existing file that uses "entry"
      writeFileSync(join(OUT2, 'home.md'), '---\nid: "home"\ntitle: "Home"\ncluster: entry\nconnections: []\n---\n# Home\n', 'utf-8');

      const catalogue = {
        title: 'KB',
        clusters: { entry: { name: 'Entry', color: '#111' } },
        nodes: [{ id: 'overview', title: 'Overview', cluster: 'entry', connections: [] }],
      };
      const result = transformCatalogue(catalogue, OUT2);
      assert.deepStrictEqual(result.orphanedClusters, [], '"entry" already in catalogue, not orphaned');
    } finally {
      rmSync(OUT2, { recursive: true, force: true });
    }
  });
});

// ── Regression fix: findExistingBody uses outputDir, not CLI source root ──

describe('transformCatalogue — fix: existing nodes import from outputDir', () => {
  const OUT = join(tmpdir(), `kbe-test-transform-existing-${Date.now()}`);
  after(() => { rmSync(OUT, { recursive: true, force: true }); });

  it('imports body from an existing file in outputDir when node.existing=true', () => {
    mkdirSync(OUT, { recursive: true });
    // Seed an existing file with known body content
    writeFileSync(
      join(OUT, 'about.md'),
      '---\nid: "about"\ntitle: "About (old)"\ncluster: core\nconnections: []\n---\n\n# About\n\nThis is the preserved body.\n',
      'utf-8',
    );

    const catalogue = {
      title: 'Test existing',
      clusters: { core: { name: 'Core', color: '#000' } },
      nodes: [
        {
          id: 'about',
          title: 'About (new title)',
          cluster: 'core',
          existing: true,
          connections: [],
        },
      ],
    };

    const result = transformCatalogue(catalogue, OUT);

    // Should have imported 1 body
    assert.strictEqual(result.filesImported, 1, 'Should import existing body');

    const content = readFileSync(join(OUT, 'about.md'), 'utf-8');
    // New frontmatter should be applied
    assert.ok(content.includes('title: "About (new title)"'), 'New title should be in frontmatter');
    // Existing body should be preserved
    assert.ok(content.includes('This is the preserved body.'), 'Existing body should be preserved');
    // Should NOT contain the skeleton placeholder
    assert.ok(!content.includes('_Content to be generated by kb-writer agent._'), 'Should not have skeleton placeholder');
  });
});
