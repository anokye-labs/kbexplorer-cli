/**
 * Minimal, zero-dependency `.docx` builder for hermetic tests.
 *
 * Produces a valid ZIP (the OOXML container) holding `word/document.xml` plus the
 * minimal `[Content_Types].xml` and `_rels/.rels` parts a real `.docx` carries,
 * so the extractor is exercised against a standards-compliant archive — not a
 * bespoke format that could mask shared bugs.
 *
 * Two store modes are supported so both extractor code paths are covered:
 *   compress: false → ZIP method 0 (stored)
 *   compress: true  → ZIP method 8 (raw deflate)
 */

import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Wrap an array of paragraph strings into WordprocessingML document.xml. */
export function paragraphsToDocumentXml(paragraphs) {
  const body = paragraphs
    .map((p) => {
      const safe = String(p)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<w:p><w:r><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body>` +
    '</w:document>'
  );
}

function zipEntry(name, contentBuf, compress) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(contentBuf);
  const stored = compress ? deflateRawSync(contentBuf) : contentBuf;
  const method = compress ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0, 12); // mod date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(stored.length, 18);
  local.writeUInt32LE(contentBuf.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  return { name, nameBuf, crc, method, stored, uncompressedSize: contentBuf.length, localHeader: local };
}

/**
 * Build a ZIP Buffer from `[name, contentString]` part pairs.
 * @param {[string, string][]} parts
 * @param {{ compress?: boolean }} [options]
 * @returns {Buffer}
 */
export function makeZip(parts, options = {}) {
  const compress = options.compress ?? true;
  const entries = parts.map(([name, content]) => zipEntry(name, Buffer.from(content, 'utf8'), compress));

  const chunks = [];
  let offset = 0;
  const localOffsets = [];
  for (const e of entries) {
    localOffsets.push(offset);
    chunks.push(e.localHeader, e.nameBuf, e.stored);
    offset += e.localHeader.length + e.nameBuf.length + e.stored.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(e.method, 10);
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.stored.length, 20);
    central.writeUInt32LE(e.uncompressedSize, 24);
    central.writeUInt16LE(e.nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(localOffsets[i], 42);
    chunks.push(central, e.nameBuf);
    centralSize += central.length + e.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

/**
 * Build a `.docx` Buffer from an array of paragraph strings.
 * @param {string[]} paragraphs
 * @param {{ compress?: boolean }} [options]
 * @returns {Buffer}
 */
export function makeDocx(paragraphs, options = {}) {
  return makeZip(
    [
      [
        '[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      ],
      [
        '_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      ],
      ['word/document.xml', paragraphsToDocumentXml(paragraphs)],
    ],
    options,
  );
}

export { crc32 };
