/**
 * Source ingestion (T8.1).
 *
 * Reads UNSTRUCTURED / semi-structured sources — `.docx`, prose markdown, and
 * loosely-structured text — into a single structured *intermediate document*
 * that the fuzzy-extraction step ({@link module:lib/extract}) consumes. This is
 * the deterministic front of the F8 pipeline: no LLM, no network, just bytes →
 * `{ path, format, title, text, bytes, sha256, sections }`.
 *
 * ── Public API ──
 *   SUPPORTED_FORMATS                       frozen map ext → format label.
 *   detectFormat(path)        -> string     'docx' | 'markdown' | 'text'.
 *   IngestError                             actionable error with `.code`.
 *   sha256(text|Buffer)       -> string     'sha256:<hex>' content digest.
 *   readSource(path, opts?)   -> Document    read + normalize a single source.
 *   ingestText(text, meta?)   -> Document    build a Document from in-memory text.
 *
 * A *Document* is:
 *   {
 *     path:    string,        // source path (relative when a cwd is given)
 *     format:  'docx'|'markdown'|'text',
 *     title:   string,        // best-effort title (heading / first line / filename)
 *     text:    string,        // normalized plain text
 *     bytes:   number,        // raw byte length of the source
 *     sha256:  string,        // 'sha256:<hex>' of the RAW source bytes
 *     sections:{ heading: string, text: string }[],  // coarse structure
 *   }
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, basename, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { extractDocxText, DocxParseError } from './docx.js';

/** Recognized source extensions → canonical format label. */
export const SUPPORTED_FORMATS = Object.freeze({
  '.docx': 'docx',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.text': 'text',
});

/** Stable error codes for ingestion failures. */
export const IngestErrorCode = Object.freeze({
  NOT_FOUND: 'INGEST_NOT_FOUND',
  UNSUPPORTED: 'INGEST_UNSUPPORTED',
  EMPTY: 'INGEST_EMPTY',
  PARSE_FAILED: 'INGEST_PARSE_FAILED',
});

/** Error thrown by ingestion. Carries a stable `.code` and an actionable message. */
export class IngestError extends Error {
  constructor(message, { code = IngestErrorCode.PARSE_FAILED, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'IngestError';
    this.code = code;
  }
}

/**
 * Classify a path by extension. Throws {@link IngestError} (UNSUPPORTED) for
 * anything outside {@link SUPPORTED_FORMATS}.
 * @param {string} path
 * @returns {('docx'|'markdown'|'text')}
 */
export function detectFormat(path) {
  const ext = extname(String(path)).toLowerCase();
  const format = SUPPORTED_FORMATS[ext];
  if (!format) {
    const allowed = [...new Set(Object.values(SUPPORTED_FORMATS))].join(', ');
    throw new IngestError(
      `Unsupported source "${path}" (extension "${ext || '∅'}"). ` +
        `Supported: ${Object.keys(SUPPORTED_FORMATS).join(', ')} (formats: ${allowed}).`,
      { code: IngestErrorCode.UNSUPPORTED },
    );
  }
  return format;
}

/** Content digest of text or bytes, prefixed `sha256:`. */
export function sha256(input) {
  const hash = createHash('sha256');
  hash.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
  return `sha256:${hash.digest('hex')}`;
}

/** Strip a leading YAML frontmatter block from markdown, returning the body. */
function stripFrontmatter(text) {
  const m = text.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return m ? m[1] : text;
}

/**
 * Split plain text into coarse sections keyed by markdown-style headings. Text
 * before the first heading is captured under an empty heading. Non-markdown
 * sources yield a single section.
 *
 * @param {string} text
 * @returns {{ heading: string, text: string }[]}
 */
export function splitSections(text) {
  const lines = String(text).split(/\r?\n/);
  const sections = [];
  let current = { heading: '', lines: [] };
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) {
      if (current.heading || current.lines.some((l) => l.trim())) {
        sections.push({ heading: current.heading, text: current.lines.join('\n').trim() });
      }
      current = { heading: h[2].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.heading || current.lines.some((l) => l.trim())) {
    sections.push({ heading: current.heading, text: current.lines.join('\n').trim() });
  }
  return sections;
}

/** Best-effort title: first markdown heading, else first non-blank line, else fallback. */
function deriveTitle(text, fallback) {
  const heading = text.match(/^\s*#{1,6}\s+(.*\S)\s*$/m);
  if (heading) return heading[1].trim();
  const firstLine = text.split(/\r?\n/).find((l) => l.trim());
  if (firstLine) return firstLine.trim().slice(0, 200);
  return fallback;
}

/**
 * Build a {@link Document} from in-memory text (no filesystem access). Useful
 * for tests and for callers that already hold the content.
 *
 * @param {string} text
 * @param {{ path?: string, format?: string, rawBytes?: Buffer }} [meta]
 * @returns {object} Document
 */
export function ingestText(text, meta = {}) {
  const path = meta.path ?? 'inline.txt';
  const format = meta.format ?? detectFormat(path);
  const body = format === 'markdown' ? stripFrontmatter(text) : text;
  const normalized = body.replace(/\r\n/g, '\n').replace(/\s+$/g, '').trim();
  const rawForHash = meta.rawBytes ?? Buffer.from(text, 'utf8');
  return {
    path,
    format,
    title: deriveTitle(normalized, basename(path, extname(path))),
    text: normalized,
    bytes: rawForHash.length,
    sha256: sha256(rawForHash),
    sections: splitSections(normalized),
  };
}

/**
 * Read a single source file and normalize it to a {@link Document}.
 *
 * @param {string} path                     Path to a `.docx | .md | .markdown | .txt`.
 * @param {{ cwd?: string }} [options]       When set, `Document.path` is made
 *                                           relative to `cwd` for stable, portable refs.
 * @returns {object} Document
 * @throws {IngestError} NOT_FOUND | UNSUPPORTED | EMPTY | PARSE_FAILED
 */
export function readSource(path, options = {}) {
  if (typeof path !== 'string' || !path) {
    throw new IngestError('readSource requires a non-empty path.', {
      code: IngestErrorCode.NOT_FOUND,
    });
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new IngestError(`Source not found: ${path}`, { code: IngestErrorCode.NOT_FOUND });
  }

  const format = detectFormat(path);
  const raw = readFileSync(path);
  const relPath = options.cwd ? toPosix(relative(options.cwd, path)) : toPosix(path);

  let text;
  if (format === 'docx') {
    try {
      text = extractDocxText(raw);
    } catch (err) {
      if (err instanceof DocxParseError) {
        throw new IngestError(`Failed to read .docx "${path}": ${err.message}`, {
          code: IngestErrorCode.PARSE_FAILED,
          cause: err,
        });
      }
      throw err;
    }
  } else {
    text = raw.toString('utf8');
    if (format === 'markdown') text = stripFrontmatter(text);
  }

  text = text.replace(/\r\n/g, '\n').trim();
  if (!text) {
    throw new IngestError(
      `Source "${path}" contains no extractable text. ` +
        'Confirm the document has body content (images/tables alone are not extracted).',
      { code: IngestErrorCode.EMPTY },
    );
  }

  return {
    path: relPath,
    format,
    title: deriveTitle(text, basename(path, extname(path))),
    text,
    bytes: raw.length,
    sha256: sha256(raw),
    sections: splitSections(text),
  };
}

function toPosix(p) {
  const s = String(p).split('\\').join('/');
  return isAbsolute(p) ? s : s.replace(/^\.\//, '');
}
