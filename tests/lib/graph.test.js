import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const {
  loadGraph,
  neighbors,
  graphStats,
  isWithinRoots,
  resolveScanDirs,
} = await import('../../src/lib/graph.js');

/** Build a temp repo root with a content/ dir of authored nodes. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-graph-'));
  const content = resolve(root, 'content');
  mkdirSync(content, { recursive: true });

  const node = (id, fm, body) =>
    writeFileSync(
      resolve(content, `${id}.md`),
      `---\n${fm}\n---\n${body}\n`,
      'utf-8',
    );

  node(
    'platform',
    [
      'id: platform',
      'title: "Platform Orchestrator"',
      'cluster: infra',
      'connections:',
      '  - to: api-gateway',
      '    description: "routes requests through the gateway"',
    ].join('\n'),
    'The platform orchestrator coordinates services and scheduling.',
  );
  node(
    'api-gateway',
    ['id: api-gateway', 'title: "API Gateway"', 'cluster: infra'].join('\n'),
    'The gateway authenticates and forwards every inbound request.',
  );
  node(
    'frontend',
    [
      'id: frontend',
      'title: "Frontend App"',
      'cluster: ui',
      'connections:',
      '  - to: api-gateway',
      '    description: "calls the gateway for data"',
    ].join('\n'),
    'The frontend renders the dashboard and talks to the API.',
  );
  node(
    'lonely',
    ['id: lonely', 'title: "Lonely Note"', 'cluster: misc'].join('\n'),
    'Nothing links here.',
  );

  return { root, content };
}

describe('graph — loadGraph', () => {
  it('loads authored nodes scoped to a root', () => {
    const { root } = makeFixture();
    const graph = loadGraph({ roots: [root] });
    assert.equal(graph.nodes.size, 4);
    assert.ok(graph.nodes.has('platform'));
    assert.equal(graph.nodes.get('platform').cluster, 'infra');
    assert.equal(graph.nodes.get('platform').connections[0].to, 'api-gateway');
  });

  it('builds undirected adjacency from connections', () => {
    const { root } = makeFixture();
    const graph = loadGraph({ roots: [root] });
    assert.ok(graph.adjacency.get('platform').has('api-gateway'));
    // Reverse edge present (undirected).
    assert.ok(graph.adjacency.get('api-gateway').has('platform'));
    assert.ok(graph.adjacency.get('api-gateway').has('frontend'));
    assert.equal(graph.adjacency.get('lonely').size, 0);
  });
});

describe('graph — neighbors / stats', () => {
  it('returns BFS neighbours up to depth', () => {
    const { root } = makeFixture();
    const graph = loadGraph({ roots: [root] });
    const d1 = neighbors(graph, 'platform', 1).map((n) => n.id);
    assert.deepEqual(d1.sort(), ['api-gateway']);
    const d2 = neighbors(graph, 'platform', 2).map((n) => n.id).sort();
    assert.deepEqual(d2, ['api-gateway', 'frontend']);
  });

  it('computes node/edge/cluster counts and orphans', () => {
    const { root } = makeFixture();
    const graph = loadGraph({ roots: [root] });
    const stats = graphStats(graph);
    assert.equal(stats.nodeCount, 4);
    assert.equal(stats.edgeCount, 2); // platform-api, frontend-api
    assert.ok(stats.orphans.includes('lonely'));
    const infra = stats.clusters.find((c) => c.cluster === 'infra');
    assert.equal(infra.count, 2);
  });
});

describe('graph — root confinement', () => {
  it('isWithinRoots accepts paths under a root and rejects siblings', () => {
    const { root } = makeFixture();
    assert.ok(isWithinRoots(resolve(root, 'content', 'x.md'), [root]));
    assert.ok(!isWithinRoots(resolve(root, '..', 'elsewhere', 'x.md'), [root]));
  });

  it('isWithinRoots handles Windows cross-drive + case-insensitive roots', () => {
    if (process.platform !== 'win32') return;
    assert.ok(!isWithinRoots('D:\\repo\\content\\x.md', ['C:\\repo']));
    assert.ok(isWithinRoots('c:\\repo\\content\\x.md', ['C:\\Repo']));
  });

  it('resolveScanDirs finds the content subdir of a root', () => {
    const { root, content } = makeFixture();
    const dirs = resolveScanDirs([root]);
    assert.ok(dirs.some((d) => d.toLowerCase() === content.toLowerCase()));
  });

  it('resolveScanDirs does not recurse the whole root when content/ exists', () => {
    const { root, content } = makeFixture();
    writeFileSync(resolve(root, 'README.md'), '# repo\n', 'utf-8');
    const dirs = resolveScanDirs([root]).map((d) => d.toLowerCase());
    assert.ok(dirs.includes(content.toLowerCase()));
    assert.ok(!dirs.includes(root.toLowerCase()));
  });

  it('resolveScanDirs includes root when no content dir exists but root has markdown', () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-graph-root-md-'));
    writeFileSync(resolve(root, 'README.md'), '# only root md\n', 'utf-8');
    const dirs = resolveScanDirs([root]).map((d) => d.toLowerCase());
    assert.ok(dirs.includes(root.toLowerCase()));
  });
});
