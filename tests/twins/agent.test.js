/**
 * Hermetic tests for the deterministic agent-runtime twin (issue #59).
 *
 * These prove that pointing the runtime at the fake agent yields a
 * deterministic derive/extract result — exercising the real child_process
 * spawn / stdout-capture / parse path with NO live LLM.
 *
 * Holdout rule: the twin's canned responses are fixtures (twins/agent/*.mjs).
 * Every expectation below lives here, in the test — not in the twin.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TWIN = resolve(__dirname, '..', '..', 'twins', 'agent', 'fake-agent.mjs');

const { extractEntities } = await import('../../src/lib/extract.js');
const { ingestText } = await import('../../src/lib/ingest.js');
const {
  runRuntimeTask,
  copilotAdapter,
  claudeAdapter,
  COPILOT_BIN_ENV,
} = await import('../../src/lib/copilot-runtime.js');
const { deriveSource, artifactPathFor } = await import('../../src/commands/derive.js');
const { validateArtifact } = await import('../../src/lib/jsonld.js');
const { makeDocx } = await import('../fixtures/make-docx.mjs');
const { selectFixture, FIXTURES, DEFAULT_EXTRACTION } = await import(
  '../../twins/agent/fixtures.mjs'
);
const { extractPromptFromArgv, wantsClaudeJson, renderOutput, main } = await import(
  '../../twins/agent/fake-agent.mjs'
);

/** Run the real CLI through the twin via `node <twin>` (cross-platform spawn). */
function twinRuntimeOptions(extra = {}) {
  return { binary: process.execPath, binaryArgs: [TWIN], ...extra };
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-twin-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Pure-unit coverage of the twin's helpers ─────────────────────────────────

describe('fake-agent argv parsing', () => {
  it('extracts the prompt following -p', () => {
    assert.strictEqual(
      extractPromptFromArgv(['-p', 'hello world', '--no-color']),
      'hello world',
    );
  });
  it('extracts the prompt following --prompt', () => {
    assert.strictEqual(extractPromptFromArgv(['--prompt', 'hi there']), 'hi there');
  });
  it('falls back to the longest non-flag token', () => {
    assert.strictEqual(extractPromptFromArgv(['--x', 'a', 'a longer prompt token']), 'a longer prompt token');
  });
  it('detects claude --output-format json', () => {
    assert.strictEqual(wantsClaudeJson(['-p', 'x', '--output-format', 'json']), true);
    assert.strictEqual(wantsClaudeJson(['-p', 'x', '--output-format', 'text']), false);
    assert.strictEqual(wantsClaudeJson(['-p', 'x']), false);
  });
});

describe('fake-agent fixture selection', () => {
  it('selects a fixture by prompt substring', () => {
    const { key, extraction } = selectFixture('… Jane Doe leads Platform Team. …');
    assert.strictEqual(key, 'jane-platform');
    assert.ok(extraction.entities.length >= 1);
  });
  it('falls back to the default extraction when nothing matches', () => {
    const { key, extraction } = selectFixture('nothing relevant here');
    assert.strictEqual(key, 'default');
    assert.deepStrictEqual(extraction, DEFAULT_EXTRACTION);
  });
  it('every fixture extraction is a valid extraction shape', () => {
    for (const f of FIXTURES) {
      assert.ok(Array.isArray(f.extraction.entities) && f.extraction.entities.length >= 1, f.key);
      assert.ok(Array.isArray(f.extraction.relationships), f.key);
    }
  });
});

describe('fake-agent output rendering', () => {
  it('renders copilot-style JSONL carrying the extraction JSON', () => {
    const out = renderOutput({ entities: [{ id: 'x' }], relationships: [] });
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    const assistant = lines.find((l) => l.type === 'assistant');
    assert.ok(assistant, 'has an assistant event');
    assert.deepStrictEqual(JSON.parse(assistant.text), { entities: [{ id: 'x' }], relationships: [] });
  });
  it('renders a single Claude result object in claudeJson mode', () => {
    const out = renderOutput({ entities: [{ id: 'x' }], relationships: [] }, { claudeJson: true });
    const obj = JSON.parse(out.trim());
    assert.strictEqual(obj.type, 'result');
    assert.deepStrictEqual(JSON.parse(obj.result), { entities: [{ id: 'x' }], relationships: [] });
  });
  it('main() writes diagnostics to stderr and response to stdout only', () => {
    let out = '';
    let err = '';
    const code = main(['-p', 'Jane Doe leads Platform Team.'], {
      stdout: { write: (s) => (out += s) },
      stderr: { write: (s) => (err += s) },
    });
    assert.strictEqual(code, 0);
    assert.ok(/TWIN_FIXTURE jane-platform/.test(err));
    assert.ok(!/TWIN_/.test(out), 'stdout carries no diagnostics');
    // stdout must be parseable structured output, nothing else.
    for (const line of out.trim().split('\n')) JSON.parse(line);
  });
});

// ── End-to-end through the real runtime spawn path (no live LLM) ─────────────

describe('extractEntities through the twin (copilot adapter)', () => {
  it('yields a deterministic extraction from the spawned twin', async () => {
    const doc = ingestText('Jane Doe leads Platform Team.', { path: 'org.txt' });
    const out = await extractEntities({ document: doc, runtimeOptions: twinRuntimeOptions() });
    assert.strictEqual(out.entities.length, 2);
    assert.strictEqual(out.relationships.length, 1);
    assert.strictEqual(out.entities[0].name, 'Jane Doe');
    assert.strictEqual(out.relationships[0].type, 'leads');
  });

  it('is deterministic across repeated runs (byte-identical raw response)', async () => {
    const doc = ingestText('Jane Doe leads Platform Team.', { path: 'org.txt' });
    const a = await extractEntities({ document: doc, runtimeOptions: twinRuntimeOptions() });
    const b = await extractEntities({ document: doc, runtimeOptions: twinRuntimeOptions() });
    assert.strictEqual(a.raw, b.raw);
  });

  it('serves a different source from a different fixture', async () => {
    const doc = ingestText('Acme Corp strategy overview.', { path: 'acme.txt' });
    const out = await extractEntities({ document: doc, runtimeOptions: twinRuntimeOptions() });
    assert.ok(out.entities.some((e) => e.name === 'Acme Corp'));
  });
});

describe('extractEntities through the twin (claude adapter)', () => {
  it('parses the Claude single-object JSON result', async () => {
    const doc = ingestText('Jane Doe leads Platform Team.', { path: 'org.txt' });
    const out = await extractEntities({
      document: doc,
      runtimeOptions: twinRuntimeOptions({ adapter: claudeAdapter }),
    });
    assert.strictEqual(out.entities.length, 2);
    assert.strictEqual(out.relationships.length, 1);
  });
});

describe('runtime binary-override env resolves to the twin', () => {
  it('runRuntimeTask honours KBEXPLORER_COPILOT_BIN (via node + script arg)', async () => {
    // Node cannot spawn a bare .mjs as a binary on every OS, so we set the
    // override to `node` and thread the script through binaryArgs — proving the
    // env-override path reaches the twin and produces parseable output.
    const r = await runRuntimeTask({
      adapter: copilotAdapter,
      prompt: 'Jane Doe leads Platform Team.',
      outputFormat: 'json',
      binaryArgs: [TWIN],
      env: { ...process.env, [COPILOT_BIN_ENV]: process.execPath },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.binary, process.execPath);
    const parsed = JSON.parse(r.response);
    assert.strictEqual(parsed.entities[0].name, 'Jane Doe');
  });
});

// ── Full derive loop through the twin ────────────────────────────────────────

describe('deriveSource end-to-end through the twin', () => {
  it('creates a valid JSON-LD artifact from a .docx with no live LLM', async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, 'org.docx');
      writeFileSync(src, makeDocx(['Jane Doe leads Platform Team.']));
      const outDir = join(dir, 'out');

      const runExtraction = (document) =>
        extractEntities({ document, runtimeOptions: twinRuntimeOptions({ cwd: dir }) });

      const res = await deriveSource(src, { outDir, cwd: dir, runExtraction });

      assert.strictEqual(res.status, 'created');
      assert.strictEqual(res.drift, false);
      assert.ok(res.validation.ok);
      assert.strictEqual(res.nodeCount, 2);
      assert.strictEqual(res.edgeCount, 1);
      assert.ok(existsSync(artifactPathFor(src, outDir)));

      const onDisk = JSON.parse(readFileSync(artifactPathFor(src, outDir), 'utf8'));
      assert.deepStrictEqual(validateArtifact(onDisk).errors, []);
      assert.strictEqual(
        onDisk['@graph'].find((m) => m['@type'] === 'person')['@id'],
        'kg://person/jane',
      );
    });
  });

  it('re-derive reuses the embedded extraction (no second spawn) and is byte-identical', async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, 'org.docx');
      writeFileSync(src, makeDocx(['Jane Doe leads Platform Team.']));
      const outDir = join(dir, 'out');

      let spawns = 0;
      const runExtraction = (document) => {
        spawns += 1;
        return extractEntities({ document, runtimeOptions: twinRuntimeOptions({ cwd: dir }) });
      };

      await deriveSource(src, { outDir, cwd: dir, runExtraction });
      const first = readFileSync(artifactPathFor(src, outDir), 'utf8');
      const res2 = await deriveSource(src, { outDir, cwd: dir, runExtraction });
      const second = readFileSync(artifactPathFor(src, outDir), 'utf8');

      assert.strictEqual(spawns, 1, 'twin is not spawned again for unchanged input');
      assert.strictEqual(res2.status, 'unchanged');
      assert.strictEqual(first, second);
    });
  });
});
