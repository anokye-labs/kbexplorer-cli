import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { deriveSource, artifactPathFor, buildDeriveRuntimeOptions } = await import(
  '../../src/commands/derive.js'
);
const { validateArtifact } = await import('../../src/lib/jsonld.js');
const { makeDocx } = await import('../fixtures/make-docx.mjs');
const { resolveRuntime, loadRuntimeConfig, validateRuntimeBlock } = await import(
  '../../src/lib/runtime-config.js'
);
const { copilotAdapter, claudeAdapter } = await import('../../src/lib/copilot-runtime.js');

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-derive-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXTRACTION = {
  entities: [
    { id: 'jane', type: 'person', name: 'Jane Doe', properties: { jobTitle: 'VP' } },
    { type: 'team', name: 'Platform Team' },
  ],
  relationships: [{ from: 'jane', to: 'Platform Team', type: 'manages' }],
};

/** A counting fake extractor so we can assert when the LLM path is (not) taken. */
function fakeExtractor(extraction = EXTRACTION) {
  const calls = { n: 0 };
  const run = async () => {
    calls.n += 1;
    return extraction;
  };
  return { run, calls };
}

describe('buildDeriveRuntimeOptions', () => {
  it('defaults to allow-all-tools when no scoped tools are given', () => {
    const o = buildDeriveRuntimeOptions({ allowTools: [], allowAllTools: null }, '/tmp');
    assert.strictEqual(o.allowAllTools, true);
    assert.deepStrictEqual(o.allowTools, []);
  });
  it('uses scoped tools (and disables allow-all) when provided', () => {
    const o = buildDeriveRuntimeOptions({ allowTools: ['shell(ls)'], allowAllTools: true }, '/tmp');
    assert.strictEqual(o.allowAllTools, false);
    assert.deepStrictEqual(o.allowTools, ['shell(ls)']);
  });
});

describe('deriveSource (end-to-end, injected extractor)', () => {
  it('creates a valid JSON-LD artifact from a .docx without a live LLM', async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, 'org.docx');
      writeFileSync(src, makeDocx(['Jane Doe leads Platform Team.']));
      const outDir = join(dir, 'out');
      const { run, calls } = fakeExtractor();

      const res = await deriveSource(src, { outDir, cwd: dir, runExtraction: run });

      assert.strictEqual(res.status, 'created');
      assert.strictEqual(res.drift, false);
      assert.strictEqual(calls.n, 1);
      assert.ok(res.validation.ok);
      assert.strictEqual(res.nodeCount, 2);
      assert.strictEqual(res.edgeCount, 1);
      assert.ok(existsSync(artifactPathFor(src, outDir)));

      const onDisk = JSON.parse(readFileSync(artifactPathFor(src, outDir), 'utf8'));
      assert.deepStrictEqual(validateArtifact(onDisk).errors, []);
      assert.strictEqual(onDisk['@graph'].find((m) => m['@type'] === 'person')['@id'], 'kg://person/jane');
    });
  });

  it('is idempotent: a second derive reuses the embedded extraction (no LLM) and is byte-identical', async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, 'org.docx');
      writeFileSync(src, makeDocx(['Jane Doe leads Platform Team.']));
      const outDir = join(dir, 'out');
      const { run, calls } = fakeExtractor();

      await deriveSource(src, { outDir, cwd: dir, runExtraction: run });
      const first = readFileSync(artifactPathFor(src, outDir), 'utf8');

      const res2 = await deriveSource(src, { outDir, cwd: dir, runExtraction: run });
      const second = readFileSync(artifactPathFor(src, outDir), 'utf8');

      assert.strictEqual(calls.n, 1, 'extractor must not be called again for unchanged input');
      assert.strictEqual(res2.status, 'unchanged');
      assert.strictEqual(first, second);
    });
  });

  it('--refresh re-runs extraction even when a fresh artifact exists', async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, 'org.docx');
      writeFileSync(src, makeDocx(['Jane Doe leads Platform Team.']));
      const outDir = join(dir, 'out');
      const { run, calls } = fakeExtractor();

      await deriveSource(src, { outDir, cwd: dir, runExtraction: run });
      await deriveSource(src, { outDir, cwd: dir, refresh: true, runExtraction: run });

      assert.strictEqual(calls.n, 2);
    });
  });
});

describe('deriveSource (--check drift)', () => {
  it('reports drift when no artifact has been committed', async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, 'org.docx');
      writeFileSync(src, makeDocx(['Jane Doe leads Platform Team.']));
      const { run, calls } = fakeExtractor();

      const res = await deriveSource(src, { outDir: join(dir, 'out'), cwd: dir, check: true, runExtraction: run });
      assert.strictEqual(res.drift, true);
      assert.strictEqual(calls.n, 0, '--check must never call the LLM');
    });
  });

  it('reports no drift for an up-to-date artifact', async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, 'org.docx');
      writeFileSync(src, makeDocx(['Jane Doe leads Platform Team.']));
      const outDir = join(dir, 'out');
      const { run } = fakeExtractor();

      await deriveSource(src, { outDir, cwd: dir, runExtraction: run });
      const res = await deriveSource(src, { outDir, cwd: dir, check: true, runExtraction: run });
      assert.strictEqual(res.drift, false);
      assert.strictEqual(res.status, 'ok');
    });
  });

  it('reports drift when the source changes after derivation', async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, 'org.docx');
      writeFileSync(src, makeDocx(['Jane Doe leads Platform Team.']));
      const outDir = join(dir, 'out');
      const { run } = fakeExtractor();

      await deriveSource(src, { outDir, cwd: dir, runExtraction: run });
      writeFileSync(src, makeDocx(['Completely different content now.']));

      const res = await deriveSource(src, { outDir, cwd: dir, check: true, runExtraction: run });
      assert.strictEqual(res.drift, true);
      assert.match(res.reason, /source changed/);
    });
  });
});

// ── Runtime config integration: adapter flows into extraction path ────────────

describe('derive runtime config integration', () => {
  it('resolveRuntime defaults to copilot when no flag/config/env', () => {
    const adapter = resolveRuntime({ env: {} });
    assert.strictEqual(adapter, copilotAdapter);
    assert.strictEqual(adapter.name, 'copilot');
  });

  it('resolveRuntime picks up claude from .kbx.json config', () => {
    const config = validateRuntimeBlock({ agent: 'claude' });
    const adapter = resolveRuntime({ flag: null, config, env: {} });
    assert.strictEqual(adapter.name, 'claude');
  });

  it('resolveRuntime --runtime flag overrides .kbx.json', () => {
    const config = validateRuntimeBlock({ agent: 'claude' });
    const adapter = resolveRuntime({ flag: 'copilot', config, env: {} });
    assert.strictEqual(adapter, copilotAdapter);
  });

  it('loadRuntimeConfig returns null in a dir with no .kbx.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-drt-'));
    try {
      assert.strictEqual(loadRuntimeConfig(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('custom adapter built from config passes prompt through argsTemplate', () => {
    const config = validateRuntimeBlock({
      agent: 'custom',
      command: 'my-agent',
      argsTemplate: ['--ask', '{prompt}', '--out', 'result.json'],
    });
    const adapter = resolveRuntime({ flag: null, config, env: {} });
    const args = adapter.buildArgs({ prompt: 'Extract entities' });
    assert.deepStrictEqual(args, ['--ask', 'Extract entities', '--out', 'result.json']);
  });

  it('deriveSource uses injected extractor regardless of runtime config (pure function)', async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, 'org.docx');
      writeFileSync(src, makeDocx(['Acme Corp strategy.']));
      const outDir = join(dir, 'out');
      const { run, calls } = fakeExtractor();

      // deriveSource is pure — runtime adapter is a concern of the CLI layer
      const res = await deriveSource(src, { outDir, cwd: dir, runExtraction: run });
      assert.strictEqual(res.status, 'created');
      assert.strictEqual(calls.n, 1);
      assert.ok(res.validation.ok);
    });
  });
});

