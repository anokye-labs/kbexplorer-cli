/**
 * Built-ins-only `.docx` text extractor.
 *
 * A `.docx` file is a ZIP container; the body text lives in `word/document.xml`
 * as a stream of `<w:p>` paragraphs containing `<w:t>` text runs. This module
 * locates that entry via the ZIP central directory (the robust path — local
 * headers may omit sizes when streamed), inflates it with `zlib.inflateRawSync`,
 * and reduces the WordprocessingML to plain text.
 *
 * Only `node:zlib` and `node:buffer` built-ins are used — no third-party deps,
 * matching the rest of the CLI.
 *
 * ── Public API ──
 *   readZipEntry(buffer, name)  -> Buffer|null   raw (inflated) bytes of an entry.
 *   listZipEntries(buffer)      -> string[]      entry names in the archive.
 *   docxXmlToText(xml)          -> string        WordprocessingML → plain text.
 *   extractDocxText(buffer)     -> string        end-to-end .docx → text.
 */

import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50; // End of central directory
const SIG_CEN = 0x02014b50; // Central directory file header
const SIG_LOC = 0x04034b50; // Local file header

/** Error thrown for malformed / unexpected archive content. */
export class DocxParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocxParseError';
  }
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new DocxParseError('Expected a Buffer/Uint8Array of .docx bytes.');
}

/** Find the End-Of-Central-Directory record by scanning backwards. */
function findEocd(buf) {
  // EOCD is at least 22 bytes; comment can push it back up to 0xFFFF.
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Parse the central directory into a map of entry name → { method, offset,
 * compressedSize }.
 *
 * @param {Buffer} buf
 * @returns {Map<string, { method: number, compressedSize: number, offset: number }>}
 */
function parseCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) {
    throw new DocxParseError('Not a valid ZIP/.docx archive (no end-of-central-directory record).');
  }
  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // offset of central directory
  const entries = new Map();

  for (let i = 0; i < total; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== SIG_CEN) {
      throw new DocxParseError('Corrupt ZIP central directory.');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    entries.set(name, { method, compressedSize, offset: localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Read (and decompress) a single entry's bytes by name. Returns null when the
 * entry is absent.
 *
 * @param {Buffer|Uint8Array} input
 * @param {string} name
 * @returns {Buffer|null}
 */
export function readZipEntry(input, name) {
  const buf = toBuffer(input);
  const entries = parseCentralDirectory(buf);
  const entry = entries.get(name);
  if (!entry) return null;

  const { offset, method, compressedSize } = entry;
  if (buf.readUInt32LE(offset) !== SIG_LOC) {
    throw new DocxParseError(`Corrupt local header for "${name}".`);
  }
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return Buffer.from(data); // stored
  if (method === 8) return inflateRawSync(data); // deflate
  throw new DocxParseError(`Unsupported ZIP compression method ${method} for "${name}".`);
}

/**
 * List all entry names in the archive (central-directory order).
 * @param {Buffer|Uint8Array} input
 * @returns {string[]}
 */
export function listZipEntries(input) {
  return [...parseCentralDirectory(toBuffer(input)).keys()];
}

const XML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/**
 * Convert WordprocessingML (`word/document.xml`) to plain text.
 *
 * Paragraph boundaries (`</w:p>`) become newlines; `<w:tab/>` → tab and
 * `<w:br/>` → newline; `<w:t>` run text is concatenated. All other tags are
 * dropped. Blank/whitespace-only paragraphs collapse but paragraph structure is
 * otherwise preserved so downstream extraction sees document shape.
 *
 * @param {string} xml
 * @returns {string}
 */
export function docxXmlToText(xml) {
  if (!xml) return '';
  // Restrict to the body when present to avoid headers/footers/settings noise.
  const bodyMatch = xml.match(/<w:body[\s\S]*?<\/w:body>/);
  const scope = bodyMatch ? bodyMatch[0] : xml;

  const paragraphs = scope.split(/<\/w:p>/);
  const lines = [];
  // Walk text runs, tabs, and breaks in document order so inline <w:tab/> and
  // <w:br/> between runs are preserved (not just the <w:t> content).
  const token = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:(?:br|cr)\b[^>]*\/?>/g;
  for (const para of paragraphs) {
    let line = '';
    for (const m of para.matchAll(token)) {
      if (m[1] !== undefined) line += m[1];
      else if (m[0].startsWith('<w:tab')) line += '\t';
      else line += '\n';
    }
    lines.push(decodeXmlEntities(line));
  }

  return lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract plain text from a `.docx` byte buffer.
 *
 * @param {Buffer|Uint8Array} input  Raw `.docx` bytes.
 * @returns {string}
 * @throws {DocxParseError} when the archive is not a valid `.docx`.
 */
export function extractDocxText(input) {
  const xml = readZipEntry(input, 'word/document.xml');
  if (!xml) {
    throw new DocxParseError(
      'Not a valid .docx: missing word/document.xml. The file may be corrupt, ' +
        'password-protected, or a legacy .doc — convert it to .docx and retry.',
    );
  }
  return docxXmlToText(xml.toString('utf8'));
}
