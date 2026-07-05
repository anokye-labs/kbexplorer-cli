import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildEngineGraph } from '../../src/lib/engine-graph-builder.js';
import { normalizeAccessLabel } from '../../src/lib/access-label.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mirror of @anokye-labs/kbexplorer-search's default-SAFE index-build predicate
// (its README "Access labels": a node is EXCLUDED from the index when its
// access label's classification is confidential/restricted/unknown, or its
// visibility is private). Search reads `label.classification` — a bare *string*
// carries none, so the pre-AF-009-fix carry (`access: fm.access`) silently
// indexed restricted content. We can't import the search module in the CLI test
// env (it ships no dist here), so this local predicate proves the label is now
// actionable. Keep in sync with the search README if that contract changes.
const EXCLUDED_CLASSIFICATIONS = new Set(['confidential', 'restricted', 'unknown']);
function isExcludedByAccess(rawAccess) {
  const label = normalizeAccessLabel(rawAccess);
  if (!label) return false;
  if (label.classification && EXCLUDED_CLASSIFICATIONS.has(label.classification)) return true;
  if (label.visibility === 'private') return true;
  return false;
}

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

  it('skips files without valid frontmatter', async () => {
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
      assert.equal(graph.nodes.length, 1);
      assert.equal(graph.nodes[0].id, 'valid-node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates nodes with the same id', async () => {
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
      assert.equal(graph.nodes.length, 1);
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

      // Carry-through only — absent frontmatter fields stay absent, not defaulted.
      const plain = graph.nodes.find((n) => n.id === 'plain');
      assert.ok(plain);
      assert.equal(plain.identity, undefined);
      assert.equal(plain.access, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries a restricted access label as an object search actually excludes (AF-009 no-op regression)', async () => {
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
      assert.ok(secret && open);

      // Canonical KBAccessLabel object — NOT the bare string `'restricted'` that
      // the pre-fix carry produced (and that normalizeAccessLabel drops to
      // undefined = "unlabeled = public", the silent AF-009 no-op).
      assert.deepEqual(secret.access, { classification: 'restricted' });
      assert.equal(normalizeAccessLabel(secret.access)?.classification, 'restricted');

      // The label is actionable end-to-end: search's default-SAFE predicate now
      // EXCLUDES the restricted node (the test class the no-op evaded) while the
      // public node stays indexed. Under the old bare-string carry,
      // isExcludedByAccess('restricted') === false — exclusion never fired.
      assert.equal(isExcludedByAccess(secret.access), true);
      assert.equal(isExcludedByAccess(open.access), false);
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
