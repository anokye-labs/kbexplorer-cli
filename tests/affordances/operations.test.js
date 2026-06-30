import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { createAffordanceContext } = await import('../../src/affordances/context.js');
const { executeAffordance, ERROR_CODES, AffordanceError } =
  await import('../../src/affordances/index.js');

/** Build a temp repo with a small content/ graph + a prose source. */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-aff-'));
  const content = resolve(dir, 'content');
  mkdirSync(content, { recursive: true });

  writeFileSync(
    join(content, 'config.yaml'),
    ['title: Demo', 'clusters:', '  core:', '    name: "Core"', '    color: "#fff"'].join('\n') +
      '\n'
  );
  const node = (id, extra = '', body = 'Body text.') =>
    writeFileSync(
      join(content, `${id}.md`),
      `---\nid: "${id}"\ntitle: "${id} title"\ncluster: core\n${extra}---\n\n${body}\n`
    );
  node('home', '', 'Home page. The audit lives at (src/lib/audit.js:12-30).');
  node('child', 'parent: home\nconnections:\n  - to: "home"\n    description: "links home"\n');
  node('lonely');

  return { dir, content };
}

let fx;
let ctx;
before(() => {
  fx = makeFixture();
  ctx = createAffordanceContext({ cwd: fx.dir });
});
after(() => rmSync(fx.dir, { recursive: true, force: true }));

describe('operation: query_node', () => {
  it('returns a node by id', async () => {
    const r = await executeAffordance('query_node', { id: 'home' }, ctx);
    assert.equal(r.id, 'home');
    assert.equal(r.title, 'home title');
    assert.match(r.body, /Home page/);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    await assert.rejects(
      () => executeAffordance('query_node', { id: 'nope' }, ctx),
      (e) => e instanceof AffordanceError && e.code === ERROR_CODES.NOT_FOUND
    );
  });

  it('throws INVALID_INPUT when id is missing', async () => {
    await assert.rejects(
      () => executeAffordance('query_node', {}, ctx),
      (e) => e.code === ERROR_CODES.INVALID_INPUT
    );
  });
});

describe('operation: graph_neighbors', () => {
  it('returns BFS neighbours and clamps depth', async () => {
    const r = await executeAffordance('graph_neighbors', { id: 'home', depth: 99 }, ctx);
    assert.equal(r.depth, 4);
    assert.ok(r.neighbors.some((n) => n.id === 'child'));
  });

  it('defaults depth to 1', async () => {
    const r = await executeAffordance('graph_neighbors', { id: 'home' }, ctx);
    assert.equal(r.depth, 1);
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    await assert.rejects(
      () => executeAffordance('graph_neighbors', { id: 'nope' }, ctx),
      (e) => e.code === ERROR_CODES.NOT_FOUND
    );
  });
});

describe('operation: llm_context', () => {
  it('assembles a grounded bundle + citations without calling a model', async () => {
    const r = await executeAffordance(
      'llm_context',
      { nodeIds: ['home', 'child'], question: 'how?' },
      ctx
    );
    assert.equal(r.citations.length, 2);
    assert.equal(r.question, 'how?');
    assert.match(r.contextBundle, /\[home\]/);
    assert.match(r.contextBundle, /\[child\]/);
  });

  it('throws NOT_FOUND listing the missing ids', async () => {
    await assert.rejects(
      () => executeAffordance('llm_context', { nodeIds: ['home', 'ghost'] }, ctx),
      (e) => e.code === ERROR_CODES.NOT_FOUND && e.details.missing.includes('ghost')
    );
  });

  it('throws INVALID_INPUT for an empty nodeIds array', async () => {
    await assert.rejects(
      () => executeAffordance('llm_context', { nodeIds: [] }, ctx),
      (e) => e.code === ERROR_CODES.INVALID_INPUT
    );
  });
});

describe('operation: audit', () => {
  it('reports a clean structural summary', async () => {
    const r = await executeAffordance('audit', {}, ctx);
    assert.equal(r.summary.nodes, 3);
    assert.equal(r.summary.errors, 0);
  });
});

describe('operation: affected', () => {
  it('maps an explicit changed-file list to citing nodes (no git)', async () => {
    const r = await executeAffordance('affected', { files: ['src/lib/audit.js'] }, ctx);
    assert.ok(r.affected.includes('home'));
    assert.equal(r.ref, 'HEAD');
  });

  it('returns no affected nodes for an uncited file', async () => {
    const r = await executeAffordance('affected', { files: ['src/unrelated.js'] }, ctx);
    assert.equal(r.affected.length, 0);
    assert.deepEqual(r.uncited, ['src/unrelated.js']);
  });
});

describe('operation: search', () => {
  it('runs against an injected search module seam', async () => {
    const stub = {
      readArtifacts: () => ({ meta: { model: 'm', dimensions: 3 } }),
      getProvider: () => ({}),
      createSearchEngine: () => ({
        search: async (q, opts) => [
          { id: 'home', title: 'home title', score: 0.9, cluster: 'core', limit: opts.limit },
        ],
      }),
    };
    const sctx = createAffordanceContext({
      cwd: fx.dir,
      seams: { loadSearchModule: async () => stub },
    });
    const r = await executeAffordance('search', { query: 'home', limit: 3 }, sctx);
    assert.equal(r.query, 'home');
    assert.equal(r.results[0].id, 'home');
  });

  it('throws MISSING_ARTIFACT when no index exists', async () => {
    const stub = {
      readArtifacts: () => null,
      getProvider: () => ({}),
      createSearchEngine: () => ({}),
    };
    const sctx = createAffordanceContext({
      cwd: fx.dir,
      seams: { loadSearchModule: async () => stub },
    });
    await assert.rejects(
      () => executeAffordance('search', { query: 'x' }, sctx),
      (e) => e.code === ERROR_CODES.MISSING_ARTIFACT
    );
  });

  it('throws UNSUPPORTED when the search module cannot be resolved', async () => {
    const sctx = createAffordanceContext({
      cwd: fx.dir,
      seams: {
        loadSearchModule: async () => {
          throw new Error('not installed');
        },
      },
    });
    await assert.rejects(
      () => executeAffordance('search', { query: 'x' }, sctx),
      (e) => e.code === ERROR_CODES.UNSUPPORTED
    );
  });
});

describe('operation: derive', () => {
  const intermediate = {
    entities: [
      { type: 'person', name: 'Ada' },
      { type: 'team', name: 'Core' },
    ],
    relationships: [{ from: 'Ada', to: 'Core', type: 'memberOf' }],
  };

  function deriveCtx() {
    return createAffordanceContext({
      cwd: fx.dir,
      seams: { runExtraction: async () => intermediate },
    });
  }

  it('extracts and writes a canonical artifact, then reuses it idempotently', async () => {
    const src = resolve(fx.dir, 'org.md');
    writeFileSync(src, '# Org\n\nAda is on Core.\n');

    const r1 = await executeAffordance(
      'derive',
      { sources: ['org.md'], out: 'content/derived' },
      deriveCtx()
    );
    assert.equal(r1.results[0].status, 'created');
    const outPath = resolve(fx.dir, 'content/derived/org.jsonld');
    assert.ok(existsSync(outPath));
    const bytes1 = readFileSync(outPath, 'utf-8');

    // Second run reuses the embedded extraction (no LLM) and is byte-identical.
    const r2 = await executeAffordance(
      'derive',
      { sources: ['org.md'], out: 'content/derived' },
      deriveCtx()
    );
    assert.equal(r2.results[0].status, 'unchanged');
    assert.match(r2.results[0].reason, /reused embedded extraction/);
    assert.equal(readFileSync(outPath, 'utf-8'), bytes1);
  });

  it('check mode reports no drift for a fresh artifact and never writes', async () => {
    const r = await executeAffordance(
      'derive',
      { sources: ['org.md'], check: true },
      createAffordanceContext({ cwd: fx.dir })
    );
    assert.equal(r.drift, false);
    assert.equal(r.results[0].status, 'ok');
  });

  it('check mode reports drift when no artifact exists (offline, no seam)', async () => {
    const src = resolve(fx.dir, 'missing.md');
    writeFileSync(src, '# Missing\n');
    const r = await executeAffordance(
      'derive',
      { sources: ['missing.md'], check: true },
      createAffordanceContext({ cwd: fx.dir })
    );
    assert.equal(r.drift, true);
  });

  it('throws UNSUPPORTED when extraction is needed but no runtime seam is supplied', async () => {
    const src = resolve(fx.dir, 'fresh.md');
    writeFileSync(src, '# Fresh\n');
    await assert.rejects(
      () =>
        executeAffordance(
          'derive',
          { sources: ['fresh.md'] },
          createAffordanceContext({ cwd: fx.dir })
        ),
      (e) => e.code === ERROR_CODES.UNSUPPORTED
    );
  });
});
