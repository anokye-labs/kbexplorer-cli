import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  readSource,
  ingestText,
  detectFormat,
  splitSections,
  sha256,
  IngestError,
  IngestErrorCode,
  SUPPORTED_FORMATS,
} = await import('../../src/lib/ingest.ts');
const { makeDocx } = await import('../fixtures/make-docx.mjs');

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-ingest-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('detectFormat', () => {
  it('classifies supported extensions', () => {
    assert.strictEqual(detectFormat('a.docx'), 'docx');
    assert.strictEqual(detectFormat('a.md'), 'markdown');
    assert.strictEqual(detectFormat('a.markdown'), 'markdown');
    assert.strictEqual(detectFormat('a.txt'), 'text');
  });
  it('throws UNSUPPORTED for unknown extensions', () => {
    assert.throws(
      () => detectFormat('a.pdf'),
      (e) => e instanceof IngestError && e.code === IngestErrorCode.UNSUPPORTED,
    );
  });
  it('exposes a frozen format map', () => {
    assert.ok(Object.isFrozen(SUPPORTED_FORMATS));
  });
});

describe('sha256', () => {
  it('is stable and prefixed', () => {
    assert.strictEqual(sha256('abc'), sha256(Buffer.from('abc')));
    assert.match(sha256('abc'), /^sha256:[0-9a-f]{64}$/);
  });
});

describe('splitSections', () => {
  it('splits on markdown headings and captures a preamble', () => {
    const sections = splitSections('intro text\n# Title\nbody\n## Sub\nmore');
    assert.deepStrictEqual(
      sections.map((s) => s.heading),
      ['', 'Title', 'Sub'],
    );
    assert.strictEqual(sections[0].text, 'intro text');
  });
});

describe('ingestText', () => {
  it('strips frontmatter from markdown and derives a title from the heading', () => {
    const doc = ingestText('---\nx: 1\n---\n# Hello\nbody', { path: 'a.md' });
    assert.strictEqual(doc.format, 'markdown');
    assert.strictEqual(doc.title, 'Hello');
    assert.ok(!doc.text.includes('x: 1'));
    assert.ok(doc.text.includes('# Hello'));
  });
  it('falls back to the first non-blank line for a title', () => {
    const doc = ingestText('Just some prose here.\nMore.', { path: 'a.txt' });
    assert.strictEqual(doc.title, 'Just some prose here.');
  });
});

describe('readSource', () => {
  it('reads a .docx into a Document with relative path + hash', () => {
    withTempDir((dir) => {
      const p = join(dir, 'org.docx');
      writeFileSync(p, makeDocx(['Jane leads Platform.', 'Bob reports to Jane.']));
      const doc = readSource(p, { cwd: dir });
      assert.strictEqual(doc.format, 'docx');
      assert.strictEqual(doc.path, 'org.docx');
      assert.match(doc.sha256, /^sha256:/);
      assert.ok(doc.text.includes('Jane leads Platform.'));
      assert.ok(doc.bytes > 0);
    });
  });

  it('reads prose markdown, stripping frontmatter', () => {
    withTempDir((dir) => {
      const p = join(dir, 'notes.md');
      writeFileSync(p, '---\ntitle: x\n---\n# Notes\nAlice manages Beta team.', 'utf8');
      const doc = readSource(p, { cwd: dir });
      assert.strictEqual(doc.format, 'markdown');
      assert.strictEqual(doc.title, 'Notes');
      assert.ok(!doc.text.includes('title: x'));
    });
  });

  it('throws NOT_FOUND for a missing file', () => {
    assert.throws(
      () => readSource(join(tmpdir(), 'does-not-exist-xyz.md')),
      (e) => e instanceof IngestError && e.code === IngestErrorCode.NOT_FOUND,
    );
  });

  it('throws EMPTY for a whitespace-only source', () => {
    withTempDir((dir) => {
      const p = join(dir, 'blank.txt');
      writeFileSync(p, '   \n  \n', 'utf8');
      assert.throws(
        () => readSource(p, { cwd: dir }),
        (e) => e instanceof IngestError && e.code === IngestErrorCode.EMPTY,
      );
    });
  });

  it('throws PARSE_FAILED (actionable) for a corrupt .docx', () => {
    withTempDir((dir) => {
      const p = join(dir, 'broken.docx');
      writeFileSync(p, Buffer.from('totally not a docx'));
      assert.throws(
        () => readSource(p, { cwd: dir }),
        (e) =>
          e instanceof IngestError &&
          e.code === IngestErrorCode.PARSE_FAILED &&
          /\.docx/.test(e.message),
      );
    });
  });
});
