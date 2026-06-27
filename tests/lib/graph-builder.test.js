import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildGraph } from '../../src/lib/graph-builder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeTmpRepo(files) {
  const dir = mkdtempSync(resolve(tmpdir(), 'kbgraph-'));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = resolve(dir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf-8');
  }
  return dir;
}

describe('buildGraph', () => {
  it('builds nodes from content/*.md files', () => {
    const dir = makeTmpRepo({
      'content/config.yaml': `
title: "Test KB"
clusters:
  core:
    name: "Core"
    color: "#f00"
`,
      'content/intro.md': `---
id: intro
title: Introduction
cluster: core
connections: []
---
This is the intro page.
`,
      'content/details.md': `---
id: details
title: Details
cluster: core
parent: intro
connections:
  - to: intro
    description: "References intro"
---
Detailed content here.
`,
    });

    try {
      const graph = buildGraph(dir);
      assert.equal(graph.nodes.length, 2);
      assert.equal(graph.clusters.length, 1);
      assert.equal(graph.clusters[0].id, 'core');
      assert.equal(graph.clusters[0].name, 'Core');

      const intro = graph.nodes.find((n) => n.id === 'intro');
      assert.ok(intro);
      assert.equal(intro.title, 'Introduction');
      assert.equal(intro.cluster, 'core');

      const details = graph.nodes.find((n) => n.id === 'details');
      assert.ok(details);
      assert.equal(details.parent, 'intro');

      // Should have edges: details->intro (connection) + intro->details (parent-child)
      const connEdge = graph.edges.find(
        (e) => e.from === 'details' && e.to === 'intro' && e.type === 'references',
      );
      assert.ok(connEdge, 'connection edge should exist');

      const parentEdge = graph.edges.find(
        (e) => e.from === 'intro' && e.to === 'details' && e.type === 'contains',
      );
      assert.ok(parentEdge, 'parent-child edge should exist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty graph for missing content dir', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kbgraph-'));
    try {
      const graph = buildGraph(dir);
      assert.equal(graph.nodes.length, 0);
      assert.equal(graph.edges.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips files without valid frontmatter', () => {
    const dir = makeTmpRepo({
      'content/config.yaml': 'title: "Test"\n',
      'content/no-frontmatter.md': 'Just a plain markdown file.\n',
      'content/valid.md': `---
id: valid-node
title: Valid
cluster: default
connections: []
---
Content here.
`,
    });

    try {
      const graph = buildGraph(dir);
      assert.equal(graph.nodes.length, 1);
      assert.equal(graph.nodes[0].id, 'valid-node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates nodes with the same id', () => {
    const dir = makeTmpRepo({
      'content/config.yaml': 'title: "Test"\n',
      'content/a.md': `---
id: same-id
title: First
cluster: default
connections: []
---
First content.
`,
      'content/b.md': `---
id: same-id
title: Second
cluster: default
connections: []
---
Second content.
`,
    });

    try {
      const graph = buildGraph(dir);
      assert.equal(graph.nodes.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves rawContent from markdown body', () => {
    const dir = makeTmpRepo({
      'content/config.yaml': 'title: "Test"\n',
      'content/page.md': `---
id: page
title: Page
cluster: default
connections: []
---
## Section One

Body content with **formatting**.
`,
    });

    try {
      const graph = buildGraph(dir);
      const node = graph.nodes[0];
      assert.ok(node.rawContent.includes('## Section One'));
      assert.ok(node.rawContent.includes('Body content with **formatting**.'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
