import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { extractDocxText, docxXmlToText, readZipEntry, listZipEntries, DocxParseError } = await import(
  '../../src/lib/docx.js'
);
const { makeDocx, makeZip, paragraphsToDocumentXml } = await import('../fixtures/make-docx.mjs');

describe('docxXmlToText', () => {
  it('extracts paragraph text and joins with newlines', () => {
    const xml = paragraphsToDocumentXml(['First line.', 'Second line.']);
    assert.strictEqual(docxXmlToText(xml), 'First line.\nSecond line.');
  });

  it('decodes XML entities', () => {
    const xml = paragraphsToDocumentXml(['Tom & Jerry <ok> "q"']);
    assert.strictEqual(docxXmlToText(xml), 'Tom & Jerry <ok> "q"');
  });

  it('honours <w:tab/> and <w:br/> inside a paragraph', () => {
    const xml =
      '<w:body><w:p><w:r><w:t>A</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>B</w:t></w:r></w:p></w:body>';
    assert.strictEqual(docxXmlToText(xml), 'A\tB');
  });

  it('returns empty string for empty input', () => {
    assert.strictEqual(docxXmlToText(''), '');
  });
});

describe('zip reader', () => {
  it('lists entries and reads a stored (uncompressed) entry', () => {
    const buf = makeDocx(['hello'], { compress: false });
    assert.deepStrictEqual(listZipEntries(buf), [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ]);
    const doc = readZipEntry(buf, 'word/document.xml');
    assert.ok(doc.toString('utf8').includes('hello'));
  });

  it('reads a deflated entry', () => {
    const buf = makeDocx(['compressed body text here'], { compress: true });
    const doc = readZipEntry(buf, 'word/document.xml');
    assert.ok(doc.toString('utf8').includes('compressed body text here'));
  });

  it('returns null for an absent entry', () => {
    const buf = makeDocx(['x']);
    assert.strictEqual(readZipEntry(buf, 'word/missing.xml'), null);
  });

  it('throws DocxParseError on non-zip bytes', () => {
    assert.throws(() => listZipEntries(Buffer.from('not a zip at all')), DocxParseError);
  });
});

describe('extractDocxText (end-to-end)', () => {
  for (const compress of [true, false]) {
    it(`extracts text from a ${compress ? 'deflated' : 'stored'} .docx`, () => {
      const buf = makeDocx(['Jane Doe leads Platform.', 'Bob reports to Jane.'], { compress });
      assert.strictEqual(extractDocxText(buf), 'Jane Doe leads Platform.\nBob reports to Jane.');
    });
  }

  it('throws DocxParseError when word/document.xml is missing', () => {
    const zipWithoutDocument = makeZip([['readme.txt', 'no word doc here']]);
    assert.throws(() => extractDocxText(zipWithoutDocument), DocxParseError);
  });

  it('throws DocxParseError on truncated/non-zip bytes', () => {
    assert.throws(() => extractDocxText(Buffer.from('PK')), DocxParseError);
  });
});
