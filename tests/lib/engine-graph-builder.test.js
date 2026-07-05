import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEngineGraph } from '../../src/lib/engine-graph-builder.ts';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('buildEngineGraph loads a non-empty graph from the repo content/config', async () => {
  const graph = await buildEngineGraph(repoRoot);

  assert.ok(graph, 'graph should be returned');
  assert.ok(Array.isArray(graph.nodes), 'graph should include nodes');
  assert.ok(graph.nodes.length > 0, 'expected the engine-backed graph to contain authored nodes');
  assert.ok(Array.isArray(graph.edges), 'graph should include edges');
  assert.ok(graph.edges.length > 0, 'expected the engine-backed graph to contain edges');
  assert.ok(Array.isArray(graph.clusters), 'graph should include clusters');
  assert.ok(graph.clusters.length > 0, 'expected the engine-backed graph to include clusters');
});
