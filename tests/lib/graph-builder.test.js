import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildEngineGraph } from '../../src/lib/engine-graph-builder.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// buildEngineGraph returns the raw engine graph — the SAME graph the SPA
// consumes via loadKnowledgeBase(config, { source }) (cli#230). These tests
// assert engine/SPA semantics directly, NOT the CLI's legacy content model:
//   - authored nodes get a synthesized `urn:content:<id>` identity unless the
//     author pins one in frontmatter;
//   - an untyped frontmatter connection is an edge of type `frontmatter`;
//   - files without frontmatter are still nodes (id = filename stem);
//   - same-id files are NOT deduplicated;
//   - access-withheld nodes (restricted/confidential/private) are DROPPED by
//     the engine before the graph is returned — so they can never reach the
//     search index. That access-exclusion guarantee lives in the engine, and
//     any additional search-side projection is documented in index-meta.json.

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
  it('builds nodes from content/*.md files', async () => {
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
      const graph = await buildEngineGraph(dir);
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

      // Should have edges: details->intro (untyped connection => `frontmatter`)
      // + intro->details (parent-child => `contains`).
      const connEdge = graph.edges.find(
        (e) => e.from === 'details' && e.to === 'intro' && e.type === 'frontmatter',
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

  it('returns empty graph for missing content dir', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kbgraph-'));
    try {
      const graph = await buildEngineGraph(dir);
      assert.equal(graph.nodes.length, 0);
      assert.equal(graph.edges.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps files without frontmatter as nodes (engine/SPA semantics)', async () => {
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
      const graph = await buildEngineGraph(dir);
      // The engine keeps a frontmatter-less file as a node (id = filename stem),
      // exactly as the SPA graph does — it does not silently drop it.
      assert.equal(graph.nodes.length, 2);
      assert.ok(graph.nodes.find((n) => n.id === 'valid-node'));
      assert.ok(graph.nodes.find((n) => n.id === 'no-frontmatter'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps same-id nodes without deduplication (engine/SPA semantics)', async () => {
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
      const graph = await buildEngineGraph(dir);
      // The engine does NOT deduplicate by id — both authored files surface as
      // nodes (it warns on collision but keeps both). The CLI indexes the graph
      // as-is; any collision handling is the search layer's documented concern.
      assert.equal(graph.nodes.filter((n) => n.id === 'same-id').length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries identity and access from frontmatter onto the node (AF-009)', async () => {
    const dir = makeTmpRepo({
      'content/config.yaml': 'title: "Test"\n',
      'content/labeled.md': `---
id: labeled
title: Labeled
cluster: default
identity: "kg://person/jane-doe"
access: "internal-only"
connections: []
---
Body content.
`,
      'content/plain.md': `---
id: plain
title: Plain
cluster: default
connections: []
---
Body content.
`,
    });

    try {
      const graph = await buildEngineGraph(dir);
      const labeled = graph.nodes.find((n) => n.id === 'labeled');
      assert.ok(labeled);
      assert.equal(labeled.identity, 'kg://person/jane-doe');
      // AF-009: `access` is normalized to a canonical KBAccessLabel object, not
      // carried as a bare scalar (which search/core/template drop as unlabeled).
      assert.deepEqual(labeled.access, { classification: 'internal-only' });

      // The engine synthesizes `urn:content:<id>` for a node whose author did
      // not pin an identity (the SPA graph shows the same). It is NOT undefined.
      const plain = graph.nodes.find((n) => n.id === 'plain');
      assert.ok(plain);
      assert.equal(plain.identity, 'urn:content:plain');
      assert.equal(plain.access, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops access-withheld nodes at the engine layer so they never reach the index (AF-009)', async () => {
    const dir = makeTmpRepo({
      'content/config.yaml': 'title: "Test"\n',
      'content/secret.md': `---
id: secret
title: Secret
cluster: default
access: restricted
connections: []
---
Sensitive content that must never reach the search index.
`,
      'content/open.md': `---
id: open
title: Open
cluster: default
access: public
connections: []
---
Public content that stays indexed.
`,
    });

    try {
      const graph = await buildEngineGraph(dir);
      const secret = graph.nodes.find((n) => n.id === 'secret');
      const open = graph.nodes.find((n) => n.id === 'open');

      // AF-009 (no-op regression): a restricted node is WITHHELD by the engine —
      // it is absent from the returned graph entirely. Because buildEngineGraph
      // is exactly what search-index.js feeds to extraction, restricted content
      // can never become a search unit. This is stronger than the old CLI
      // behavior (carry a label + filter later): the node never exists.
      assert.equal(secret, undefined, 'restricted node must be dropped by the engine');

      // A public node survives and carries a canonical KBAccessLabel object.
      assert.ok(open);
      assert.deepEqual(open.access, { classification: 'public' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves rawContent from markdown body', async () => {
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
      const graph = await buildEngineGraph(dir);
      const node = graph.nodes[0];
      assert.ok(node.rawContent.includes('## Section One'));
      assert.ok(node.rawContent.includes('Body content with **formatting**.'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
