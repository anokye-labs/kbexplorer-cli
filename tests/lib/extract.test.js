import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const {
  RELATION_VOCABULARY,
  buildExtractionPrompt,
  parseExtraction,
  extractEntities,
  ExtractionError,
  ExtractionErrorCode,
} = await import('../../src/lib/extract.js');
const { runCopilot } = await import('../../src/lib/copilot-runtime.js');
const { ingestText } = await import('../../src/lib/ingest.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, '..', 'fixtures', 'mock-copilot.mjs');

const SAMPLE = {
  entities: [
    { id: 'jane', type: 'person', name: 'Jane Doe', properties: { jobTitle: 'VP' } },
    { type: 'team', name: 'Platform' },
  ],
  relationships: [{ from: 'jane', to: 'Platform', type: 'leads' }],
};

describe('buildExtractionPrompt', () => {
  it('embeds the document text and the relation taxonomy', () => {
    const doc = ingestText('Alice leads Beta.', { path: 'a.txt' });
    const prompt = buildExtractionPrompt(doc);
    assert.ok(prompt.includes('Alice leads Beta.'));
    for (const rel of RELATION_VOCABULARY) assert.ok(prompt.includes(rel));
    assert.ok(/JSON object/i.test(prompt));
  });
  it('truncates very long documents', () => {
    const doc = ingestText('x'.repeat(50_000), { path: 'a.txt' });
    const prompt = buildExtractionPrompt(doc, { maxChars: 100 });
    assert.ok(prompt.includes('[truncated]'));
  });
});

describe('parseExtraction', () => {
  it('parses a bare JSON object', () => {
    const out = parseExtraction(JSON.stringify(SAMPLE));
    assert.strictEqual(out.entities.length, 2);
    assert.strictEqual(out.relationships.length, 1);
  });
  it('parses JSON inside code fences with surrounding prose', () => {
    const text = `Here you go:\n\`\`\`json\n${JSON.stringify(SAMPLE)}\n\`\`\`\nDone.`;
    const out = parseExtraction(text);
    assert.strictEqual(out.entities.length, 2);
  });
  it('isolates the first balanced object when extra text follows', () => {
    const text = `${JSON.stringify(SAMPLE)} trailing noise {not json`;
    const out = parseExtraction(text);
    assert.strictEqual(out.entities.length, 2);
  });
  it('accepts "edges" as an alias for relationships', () => {
    const out = parseExtraction(JSON.stringify({ entities: SAMPLE.entities, edges: SAMPLE.relationships }));
    assert.strictEqual(out.relationships.length, 1);
  });
  it('throws EMPTY_RESPONSE on blank input', () => {
    assert.throws(
      () => parseExtraction('   '),
      (e) => e instanceof ExtractionError && e.code === ExtractionErrorCode.EMPTY_RESPONSE,
    );
  });
  it('throws INVALID_JSON when no object is present', () => {
    assert.throws(
      () => parseExtraction('no json here at all'),
      (e) => e instanceof ExtractionError && e.code === ExtractionErrorCode.INVALID_JSON,
    );
  });
  it('throws INVALID_SHAPE when there are no entities', () => {
    assert.throws(
      () => parseExtraction(JSON.stringify({ entities: [], relationships: [] })),
      (e) => e instanceof ExtractionError && e.code === ExtractionErrorCode.INVALID_SHAPE,
    );
  });
});

describe('extractEntities (injected run)', () => {
  it('passes a prompt and parses the response', async () => {
    const doc = ingestText('Jane leads Platform.', { path: 'a.txt' });
    let seenOpts;
    const run = async (opts) => {
      seenOpts = opts;
      return { response: JSON.stringify(SAMPLE) };
    };
    const out = await extractEntities({ document: doc, run });
    assert.strictEqual(out.entities.length, 2);
    assert.strictEqual(seenOpts.outputFormat, 'json');
    assert.ok(seenOpts.prompt.includes('Jane leads Platform.'));
  });

  it('accepts a bare string result', async () => {
    const doc = ingestText('x', { path: 'a.txt' });
    const out = await extractEntities({ document: doc, run: async () => JSON.stringify(SAMPLE) });
    assert.strictEqual(out.entities.length, 2);
  });

  it('rejects when document is missing', async () => {
    await assert.rejects(() => extractEntities({}), ExtractionError);
  });
});

describe('extractEntities (real process via mock binary)', () => {
  it('extracts through the runtime in text mode', async () => {
    const doc = ingestText('Jane leads Platform.', { path: 'a.txt' });
    const out = await extractEntities({
      document: doc,
      runtimeOptions: {
        outputFormat: 'text',
        binary: process.execPath,
        binaryArgs: [MOCK],
        env: { ...process.env, MOCK_COPILOT_MODE: 'text', MOCK_COPILOT_STDOUT: JSON.stringify(SAMPLE) },
      },
    });
    assert.strictEqual(out.entities.length, 2);
    assert.strictEqual(out.relationships.length, 1);
  });

  it('extracts through the runtime in json mode (JSONL response)', async () => {
    const doc = ingestText('Jane leads Platform.', { path: 'a.txt' });
    const out = await extractEntities({
      document: doc,
      runtimeOptions: {
        binary: process.execPath,
        binaryArgs: [MOCK],
        env: { ...process.env, MOCK_COPILOT_MODE: 'json', MOCK_COPILOT_RESPONSE: JSON.stringify(SAMPLE) },
      },
    });
    assert.strictEqual(out.entities.length, 2);
  });
});
