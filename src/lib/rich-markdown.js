/**
 * Rich-Markdown ingestion (Wave 0b / kbexplorer-cli#133).
 *
 * Turns a SINGLE Markdown document into a pure {@link KBGraph} fragment — one
 * node plus its typed edges — consuming the released `@anokye-labs/kbexplorer-core`
 * v0.1.0 identity seam. Everything in this module is PURE: no filesystem, no
 * network, no LLM. Identical input → byte-identical output, which is what makes
 * the deterministic fixture stable across runs. The filesystem boundary lives in
 * the provider wrapper (`src/providers/rich-markdown.js`).
 *
 * What it captures:
 *   • full frontmatter → `node.data` — ARBITRARY keys are preserved (not just a
 *     known subset), with typed scalars, inline/flow + block collections, nested
 *     maps and block scalars.
 *   • fenced embedded blocks (`dot` / `mermaid` / `ics` / `canvas`) → descriptors
 *     under `node.data.richMarkdown.blocks`, each with a content hash and the
 *     block's source offsets (byte + line span) into the document.
 *   • typed edges from Markdown links and the annotated `[..](urn){rel=..}` form,
 *     mapped onto the core relation taxonomy via `mapRelation`.
 *
 * Identity is minted with {@link buildAddress}: the body is OPAQUE (it never
 * encodes the entity's type) and the scheme/authority are configurable.
 *
 * Line endings are normalized to LF up front, so every content hash and source
 * offset is reported against the LF-normalized document and is byte-identical on
 * LF and CRLF checkouts (autocrlf-proof).
 *
 * ── Provenance seam (interim — see core#23) ─────────────────────────────────
 * The released core (v0.1.0) shipped only E1.P1 (identity + the `markdown`
 * source format). The formal **SourceRef** provenance contract is core#23, a
 * later E1 child that is NOT yet released. Until it ships, every fact (the node,
 * each block, each link) carries an INTERIM provenance pointer — the information
 * we already have: `{ source, span, contentHash }` — under `node.data`. When
 * core#23 lands, swap {@link makeSourceRef} for the formal `SourceRef` type and
 * re-point these fields; the call sites are centralized here for exactly that.
 *
 * ── Public API ──
 *   RICH_MARKDOWN_BLOCK_LANGS                     frozen set of captured langs.
 *   parseRichFrontmatter(raw)  -> { ok, frontmatter, body, raw, bodyOffset }
 *   extractEmbeddedBlocks(body, opts?) -> Block[]
 *   extractLinkEdges(body, opts?)      -> Link[]
 *   ingestRichMarkdown(input)  -> { nodes: [KBNode], edges: KBEdge[] }
 *   makeSourceRef(parts)       -> interim provenance pointer (see core#23).
 */

import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import {
  buildAddress,
  isAddress,
  mapRelation,
  slugify,
  formatContentHash,
} from '@anokye-labs/kbexplorer-core';

/** Fenced code languages captured as embedded blocks (lowercased). */
export const RICH_MARKDOWN_BLOCK_LANGS = Object.freeze(['dot', 'mermaid', 'ics', 'canvas']);

const BLOCK_LANG_SET = new Set(RICH_MARKDOWN_BLOCK_LANGS);

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Hex SHA-256 of a string (UTF-8). */
function sha256Hex(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex');
}

/**
 * Canonical content hash for a piece of text, formatted with the core helper as
 * `sha256:hex:<digest>` so block hashes line up with the rest of the system.
 */
export function contentHashOf(text) {
  return formatContentHash({ algorithm: 'sha256', encoding: 'hex', digest: sha256Hex(text) });
}

/**
 * Build an INTERIM provenance pointer for a single fact.
 *
 * TODO(core#23): replace this shape with the formal `SourceRef` contract once it
 * ships. The fields are deliberately chosen to map cleanly onto it:
 *   source     → SourceRef source/document locator (repo-relative path here)
 *   span       → byte offsets `{ start, end }` into the source document
 *   contentHash→ canonical content digest (`sha256:hex:…`)
 *
 * @param {{ source: string, span?: {start:number,end:number}, contentHash?: string }} parts
 * @returns {{ kind: 'interim-source-ref', source: string, span?: object, contentHash?: string }}
 */
export function makeSourceRef({ source, span, contentHash } = {}) {
  const ref = { kind: 'interim-source-ref', source: String(source ?? '') };
  if (span && Number.isFinite(span.start) && Number.isFinite(span.end)) {
    ref.span = { start: span.start, end: span.end };
  }
  if (contentHash) ref.contentHash = contentHash;
  return ref;
}

// ──────────────────────────────────────────────────────────────────────────
// Frontmatter — a deterministic YAML-subset parser that preserves arbitrary keys
//
// Supports: typed scalars (string / number / boolean / null), double- and
// single-quoted strings, inline flow sequences `[a, b]` and maps `{a: b}`, block
// sequences (including sequences of maps), nested maps via indentation, and
// block scalars (`|` / `>`). NOT a general YAML parser (no anchors, tags, or
// multi-document streams) — but every key it sees is preserved, which is the
// contract this provider needs.
// ──────────────────────────────────────────────────────────────────────────

function indentOf(line) {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
}

/** Split a line into `{ key, rest }` at the first top-level `:` followed by space/EOL. */
function splitKey(content) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inS) {
      if (ch === "'") inS = false;
      continue;
    }
    if (inD) {
      if (ch === '"') inD = false;
      continue;
    }
    if (ch === "'") inS = true;
    else if (ch === '"') inD = true;
    else if (ch === ':' && (i + 1 >= content.length || content[i + 1] === ' ')) {
      const key = unquote(content.slice(0, i).trim());
      const rest = content.slice(i + 1).trim();
      return { key, rest };
    }
  }
  return { key: null, rest: content };
}

function unquote(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** Strip a trailing ` # comment` from a bare (unquoted) scalar; quotes are left intact. */
function stripInlineComment(value) {
  const s = String(value);
  if (s.trimStart().startsWith('"') || s.trimStart().startsWith("'")) return s;
  const m = s.match(/\s+#/);
  return m ? s.slice(0, m.index) : s;
}

/** Coerce a bare scalar string into a typed JS value. */
function coerceScalar(raw) {
  const t = String(raw).trim();
  if (t === '' || t === '~' || t.toLowerCase() === 'null') return null;
  if (t === 'true' || t === 'True') return true;
  if (t === 'false' || t === 'False') return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  return t;
}

/** Parse a scalar OR an inline flow collection (`[...]` / `{...}`). */
function parseScalarOrFlow(input) {
  const t = String(input).trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const parsed = parseFlow(t);
    if (parsed !== undefined) return parsed.value;
  }
  return coerceScalar(unquote(stripInlineComment(t)));
}

/** Parse a flow collection from the start of `t`; returns `{ value, end }` or undefined. */
function parseFlow(t) {
  const open = t[0];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inS = false;
  let inD = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inS) {
      if (ch === "'") inS = false;
      continue;
    }
    if (inD) {
      if (ch === '"') inD = false;
      continue;
    }
    if (ch === "'") inS = true;
    else if (ch === '"') inD = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        const inner = t.slice(1, i);
        const value = open === '[' ? parseFlowSeq(inner) : parseFlowMap(inner);
        return { value, end: i };
      }
    }
  }
  return undefined;
}

/** Split `inner` on top-level commas, honoring quotes and nested brackets. */
function splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let inS = false;
  let inD = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inS) {
      if (ch === "'") inS = false;
      continue;
    }
    if (inD) {
      if (ch === '"') inD = false;
      continue;
    }
    if (ch === "'") inS = true;
    else if (ch === '"') inD = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

function parseFlowSeq(inner) {
  if (inner.trim() === '') return [];
  return splitTopLevel(inner).map((p) => parseScalarOrFlow(p));
}

function parseFlowMap(inner) {
  const out = {};
  if (inner.trim() === '') return out;
  for (const part of splitTopLevel(inner)) {
    const { key, rest } = splitKey(part.trim());
    if (key == null) continue;
    out[key] = parseScalarOrFlow(rest);
  }
  return out;
}

/**
 * Parse a YAML-subset frontmatter block into a plain object, preserving every
 * key it encounters.
 */
export function parseFrontmatterBlock(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((raw) => ({ raw, indent: indentOf(raw), content: raw.slice(indentOf(raw)) }));
  let i = 0;

  const skip = () => {
    while (i < lines.length) {
      const t = lines[i].content.trim();
      if (t === '' || t.startsWith('#')) i++;
      else break;
    }
  };
  const isSeqItem = (content) => content === '-' || content.startsWith('- ');

  function parseBlock(minIndent) {
    skip();
    if (i >= lines.length || lines[i].indent < minIndent) return null;
    return isSeqItem(lines[i].content) ? parseSeq(lines[i].indent) : parseMap(lines[i].indent);
  }

  function parseBlockScalar(parentIndent, marker) {
    const literal = marker.startsWith('|');
    const collected = []; // { raw, indent, blank }
    while (i < lines.length) {
      if (lines[i].raw.trim() === '') {
        collected.push({ raw: '', indent: 0, blank: true });
        i++;
        continue;
      }
      if (lines[i].indent <= parentIndent) break;
      collected.push({ raw: lines[i].raw, indent: lines[i].indent, blank: false });
      i++;
    }
    // Trailing blank lines don't belong to the scalar value.
    while (collected.length && collected[collected.length - 1].blank) collected.pop();
    const nonBlank = collected.filter((c) => !c.blank);
    if (nonBlank.length === 0) return '';
    // Content indentation is the least-indented non-blank line; strip exactly
    // that common indent so deeper indentation inside the scalar is preserved.
    const blockIndent = Math.min(...nonBlank.map((c) => c.indent));
    const text = collected.map((c) => (c.blank ? '' : c.raw.slice(blockIndent)));
    if (literal) return text.join('\n');
    // Folded (`>`): fold runs of non-blank lines with single spaces; blank lines
    // are preserved as paragraph breaks.
    const parts = [];
    let buf = [];
    for (const line of text) {
      if (line === '') {
        if (buf.length) {
          parts.push(buf.join(' '));
          buf = [];
        }
        parts.push('');
      } else {
        buf.push(line);
      }
    }
    if (buf.length) parts.push(buf.join(' '));
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function parseMap(indent) {
    const map = {};
    while (true) {
      skip();
      if (i >= lines.length || lines[i].indent !== indent) break;
      if (isSeqItem(lines[i].content)) break;
      const { key, rest } = splitKey(lines[i].content);
      if (key == null) break;
      i++;
      if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
        map[key] = parseBlockScalar(indent, rest);
      } else if (rest === '') {
        skip();
        if (i < lines.length && lines[i].indent > indent) {
          map[key] = parseBlock(indent + 1);
        } else {
          map[key] = null;
        }
      } else {
        map[key] = parseScalarOrFlow(rest);
      }
    }
    return map;
  }

  function parseSeq(indent) {
    const arr = [];
    while (true) {
      skip();
      if (i >= lines.length || lines[i].indent !== indent) break;
      if (!isSeqItem(lines[i].content)) break;
      const content = lines[i].content;
      // Width of the `-` + following spaces; the item content begins at `col`.
      let k = 1;
      while (k < content.length && content[k] === ' ') k++;
      const after = content.slice(k);
      const col = indent + k;
      if (after.trim() === '') {
        i++;
        arr.push(parseBlock(indent + 1));
        continue;
      }
      const { key } = splitKey(after);
      if (key != null) {
        // Sequence of maps: rewrite this line so its first entry sits at the
        // absolute column where the post-dash content begins (continuation
        // entries align there too), then parse a map at that indent.
        lines[i] = { raw: lines[i].raw, indent: col, content: after };
        arr.push(parseMap(col));
      } else {
        arr.push(parseScalarOrFlow(after));
        i++;
      }
    }
    return arr;
  }

  skip();
  if (i >= lines.length) return {};
  return isSeqItem(lines[i].content) ? parseSeq(lines[i].indent) : parseMap(lines[i].indent);
}

/**
 * Split a Markdown document into its frontmatter object + body, recording the
 * character offset where the body begins (so block/link spans are document
 * relative). A document without a frontmatter block is valid: `frontmatter` is
 * `{}` and `body` is the whole document.
 *
 * @param {string} raw
 * @returns {{ ok: boolean, frontmatter: object, body: string, raw: string, bodyOffset: number }}
 */
export function parseRichFrontmatter(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    return { ok: true, frontmatter: {}, body: text, raw: text, bodyOffset: 0 };
  }
  const body = match[2] ?? '';
  const bodyOffset = text.length - body.length;
  let frontmatter;
  let ok = true;
  try {
    const parsed = parseFrontmatterBlock(match[1]);
    frontmatter = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    frontmatter = {};
    ok = false;
  }
  return { ok, frontmatter, body, raw: text, bodyOffset };
}

// ──────────────────────────────────────────────────────────────────────────
// Embedded fenced blocks
// ──────────────────────────────────────────────────────────────────────────

/** Build per-line metadata: text + character offset of each line within `body`. */
function lineIndex(body) {
  const out = [];
  let offset = 0;
  for (const text of body.split('\n')) {
    out.push({ text, start: offset });
    offset += text.length + 1; // + the '\n' that split removed
  }
  return out;
}

const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})\s*(\S[^\r]*)?$/;

/**
 * Find every fenced code block in `body`. Returns raw fence descriptors (all
 * languages), each with the inner content and document-relative spans. Used both
 * to extract embedded blocks and to mask code regions before link scanning.
 *
 * @param {string} body
 * @param {number} bodyOffset  offset of `body` within the full document
 */
function scanFences(body, bodyOffset = 0) {
  const lines = lineIndex(body);
  const fences = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].text.match(FENCE_OPEN_RE);
    if (!open) {
      i++;
      continue;
    }
    const indent = open[1].length;
    const marker = open[2];
    const info = (open[3] ?? '').trim();
    const lang = info.split(/\s+/)[0]?.toLowerCase() ?? '';
    const openLine = i;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].text;
      const cm = t.match(/^( {0,3})(`{3,}|~{3,})\s*$/);
      if (cm && cm[2][0] === marker[0] && cm[2].length >= marker.length) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      // Unterminated fence — treat the rest of the doc as the block body.
      close = lines.length;
    }
    const contentLines = lines.slice(openLine + 1, close);
    const innerStart = lines[openLine + 1]?.start ?? lines[openLine].start + lines[openLine].text.length;
    const closeLine = close < lines.length ? lines[close] : null;
    const innerEnd = closeLine
      ? closeLine.start - 1
      : body.length;
    const blockEnd = closeLine ? closeLine.start + closeLine.text.length : body.length;
    const content = contentLines.map((l) => l.text).join('\n');
    fences.push({
      lang,
      info,
      content,
      span: { start: bodyOffset + lines[openLine].start, end: bodyOffset + blockEnd },
      contentSpan: { start: bodyOffset + innerStart, end: bodyOffset + Math.max(innerStart, innerEnd) },
      lines: { start: openLine + 1, end: (close < lines.length ? close : lines.length - 1) + 1 },
    });
    i = close < lines.length ? close + 1 : lines.length;
  }
  return fences;
}

/**
 * Extract the embedded `dot` / `mermaid` / `ics` / `canvas` blocks from a body.
 *
 * @param {string} body
 * @param {{ bodyOffset?: number, lineOffset?: number, source?: string }} [opts]
 * @returns {Array<object>} block descriptors with `contentHash`, spans + `sourceRef`.
 */
export function extractEmbeddedBlocks(body, opts = {}) {
  const bodyOffset = opts.bodyOffset ?? 0;
  const lineOffset = opts.lineOffset ?? 0;
  const source = opts.source;
  const blocks = [];
  let index = 0;
  for (const fence of scanFences(String(body ?? '').replace(/\r\n/g, '\n'), bodyOffset)) {
    if (!BLOCK_LANG_SET.has(fence.lang)) continue;
    const contentHash = contentHashOf(fence.content);
    blocks.push({
      index: index++,
      lang: fence.lang,
      info: fence.info,
      content: fence.content,
      contentHash,
      span: fence.span,
      contentSpan: fence.contentSpan,
      lines: { start: lineOffset + fence.lines.start, end: lineOffset + fence.lines.end },
      // Interim provenance (see makeSourceRef / core#23).
      sourceRef: makeSourceRef({ source, span: fence.span, contentHash }),
    });
  }
  return blocks;
}

// ──────────────────────────────────────────────────────────────────────────
// Typed link edges
// ──────────────────────────────────────────────────────────────────────────

/** Replace fenced + inline code regions with same-length spaces so link scanning skips them. */
function maskCode(body, bodyOffset) {
  let masked = body;
  for (const fence of scanFences(body, bodyOffset)) {
    const start = fence.span.start - bodyOffset;
    const end = fence.span.end - bodyOffset;
    masked = masked.slice(0, start) + ' '.repeat(end - start) + masked.slice(end);
  }
  return maskInlineCode(masked);
}

/**
 * Mask inline code spans, preserving length. Per CommonMark, an opening run of N
 * backticks is closed by the next run of EXACTLY N backticks; an unmatched run
 * is literal text and left intact.
 */
function maskInlineCode(s) {
  const out = s.split('');
  let k = 0;
  while (k < s.length) {
    if (s[k] !== '`') {
      k++;
      continue;
    }
    let run = 1;
    while (s[k + run] === '`') run++;
    let j = k + run;
    let closed = -1;
    while (j < s.length) {
      if (s[j] === '`') {
        let r = 1;
        while (s[j + r] === '`') r++;
        if (r === run) {
          closed = j + run;
          break;
        }
        j += r;
      } else {
        j++;
      }
    }
    if (closed === -1) {
      k += run; // unmatched backtick run — not a code span
      continue;
    }
    for (let p = k; p < closed; p++) if (out[p] !== '\n') out[p] = ' ';
    k = closed;
  }
  return out.join('');
}

/** Parse a `{rel=foo key="bar baz" flag}` attribute string into an object. */
function parseAttrs(attrText) {
  const attrs = {};
  if (!attrText) return attrs;
  const inner = attrText.replace(/^\{/, '').replace(/\}$/, '');
  const re = /(\w[\w-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s}]+)|(\w[\w-]*)/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    if (m[1]) attrs[m[1]] = unquote(m[2]);
    else if (m[3]) attrs[m[3]] = true;
  }
  return attrs;
}

// Matches `[text](dest)` with an optional title and an optional `{attrs}` suffix.
// `dest` is a bare token or an angle-bracketed `<...>`. NOTE: a bare destination
// can't contain unescaped parentheses (e.g. `kg://x(v2)`); wrap such targets in
// angle brackets — `[t](<kg://x(v2)>)` — which this pattern handles.
const LINK_RE = /\[([^\]]*)\]\(\s*(<[^>]+>|[^()\s]+)\s*(?:"[^"]*"|'[^']*')?\)(\{[^}]*\})?/g;

/**
 * Extract typed link facts from a Markdown body. Recognizes plain links and the
 * annotated `[text](urn){rel=..}` form. Relations are mapped onto the core
 * taxonomy; `emitEdge` flags which facts become graph edges (annotated links, or
 * links whose target is a `<scheme>://` address) versus links recorded for
 * provenance only (e.g. external URLs / relative paths).
 *
 * @param {string} body
 * @param {{ bodyOffset?: number, source?: string, defaultRelation?: string }} [opts]
 * @returns {Array<object>}
 */
export function extractLinkEdges(body, opts = {}) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const bodyOffset = opts.bodyOffset ?? 0;
  const source = opts.source;
  const defaultRelation = opts.defaultRelation ?? 'structural';
  const masked = maskCode(text, bodyOffset);
  const links = [];
  let index = 0;
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(masked)) !== null) {
    const linkText = m[1];
    let href = m[2];
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
    const attrs = parseAttrs(m[3]);
    const hasRel = typeof attrs.rel === 'string' && attrs.rel.trim() !== '';
    const mapped = mapRelation(hasRel ? attrs.rel : defaultRelation);
    const span = { start: bodyOffset + m.index, end: bodyOffset + m.index + m[0].length };
    const address = isAddress(href);
    links.push({
      index: index++,
      text: linkText,
      href,
      attrs,
      relation: mapped.relation,
      rawRelation: mapped.raw,
      isAddress: address,
      emitEdge: hasRel || address,
      span,
      // Interim provenance (see makeSourceRef / core#23).
      sourceRef: makeSourceRef({
        source,
        span,
        contentHash: contentHashOf(m[0]),
      }),
    });
  }
  return links;
}

// ──────────────────────────────────────────────────────────────────────────
// Orchestration → KBGraph fragment
// ──────────────────────────────────────────────────────────────────────────

/** Best-effort title: first ATX heading, else first non-blank line, else fallback. */
function deriveTitle(body, fallback) {
  const heading = body.match(/^\s{0,3}#{1,6}\s+(.*\S)\s*$/m);
  if (heading) return heading[1].trim();
  const firstLine = body.split(/\r?\n/).find((l) => l.trim());
  if (firstLine) return firstLine.trim().slice(0, 200);
  return fallback;
}

/** Resolve the opaque identity body for a document. Frontmatter `id` wins (verbatim). */
function identityBody(frontmatter, path, title) {
  const fmId = frontmatter?.id;
  if (fmId != null && String(fmId).trim() !== '') return String(fmId).trim();
  const base = path ? basename(String(path), extname(String(path))) : '';
  return slugify(base || title || 'document');
}

/** Pull a declared entity type from frontmatter without ever deriving it from a path. */
function declaredEntityType(frontmatter) {
  const t = frontmatter?.entityType ?? frontmatter?.['@type'];
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : undefined;
}

/** Normalize frontmatter `connections` (if authored) into Connection objects. */
function frontmatterConnections(frontmatter) {
  const raw = frontmatter?.connections;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (entry.to == null) continue;
    const mapped = mapRelation(entry.relation ?? entry.type ?? 'structural');
    out.push({
      to: String(entry.to),
      type: entry.type ? String(entry.type) : 'references',
      description: entry.description != null ? String(entry.description) : '',
      relation: mapped.relation,
      source: 'frontmatter',
      weight: Number.isFinite(entry.weight) ? entry.weight : 1,
    });
  }
  return out;
}

/**
 * Ingest a single Markdown document into a one-node graph fragment.
 *
 * @param {object} input
 * @param {string}  input.content                The raw Markdown document text.
 * @param {string}  [input.path]                 Repo-relative source path (provenance + id fallback).
 * @param {{ scheme?: string, authority?: string }} [input.identity]  Address config.
 * @param {string}  [input.cluster='default']    Cluster id to assign the node to.
 * @param {string}  [input.providerId]           Provider id recorded on the node.
 * @param {string}  [input.entityType]           Override entity type (else read from frontmatter).
 * @returns {{ nodes: object[], edges: object[] }}
 */
export function ingestRichMarkdown(input = {}) {
  const content = String(input.content ?? '').replace(/\r\n/g, '\n');
  const path = input.path != null ? String(input.path) : undefined;
  const identityOpts = input.identity ?? {};
  const cluster = input.cluster ?? 'default';
  const providerId = input.providerId;

  const { frontmatter, body, bodyOffset } = parseRichFrontmatter(content);
  const title =
    frontmatter.title != null && String(frontmatter.title).trim() !== ''
      ? String(frontmatter.title)
      : deriveTitle(body, path ? basename(path, extname(path)) : 'Untitled');

  const idBody = identityBody(frontmatter, path, title);
  const identity = buildAddress(idBody, {
    scheme: identityOpts.scheme,
    authority: identityOpts.authority,
  });

  const source = path ?? title;
  // Document-relative line offset so block `lines` align with `span` (which is
  // document-relative). `bodyOffset` chars precede the body; count their lines.
  const lineOffset = content.slice(0, bodyOffset).split('\n').length - 1;
  const blocks = extractEmbeddedBlocks(body, { bodyOffset, lineOffset, source });
  const links = extractLinkEdges(body, { bodyOffset, source });
  const fmConnections = frontmatterConnections(frontmatter);

  const entityType = input.entityType ?? declaredEntityType(frontmatter);

  // Per-document provenance (interim — see makeSourceRef / core#23).
  const docSourceRef = makeSourceRef({
    source,
    span: { start: 0, end: content.length },
    contentHash: contentHashOf(content),
  });

  // Inline (link-derived) connections — provenance for each link-fact lives on
  // the `links` entries below, keeping KBEdge contract-pure (it has no `data`).
  const linkConnections = links
    .filter((l) => l.emitEdge)
    .map((l) => ({
      to: l.href,
      type: 'references',
      description: l.text || '',
      relation: l.relation,
      source: 'inline',
      weight: 1,
    }));

  const node = {
    id: identity,
    title,
    cluster: String(cluster),
    content: '',
    rawContent: body,
    connections: [...linkConnections, ...fmConnections],
    identity,
    source: path ? { type: 'authored', file: path } : { type: 'readme' },
    // The contract's exact rich-Markdown affordance: a writable markdown source.
    sourceFile: path ? { path, raw: content, format: 'markdown' } : undefined,
    display: typeof frontmatter.display === 'string' ? frontmatter.display : 'prose',
    data: {
      // Full frontmatter — ARBITRARY keys preserved, not just a known subset.
      ...frontmatter,
      richMarkdown: {
        source: docSourceRef,
        blocks,
        links,
      },
    },
  };
  if (frontmatter.emoji != null) node.emoji = String(frontmatter.emoji);
  if (frontmatter.parent != null) node.parent = String(frontmatter.parent);
  if (providerId) node.provider = providerId;
  if (entityType) {
    node.entityType = entityType;
    node.jsonld = {
      '@context': 'https://schema.org',
      '@id': identity,
      '@type': entityType,
    };
  }

  // Typed edges. Identical (to, relation) facts are de-duplicated for a clean,
  // deterministic fragment; the first occurrence's description wins.
  const edges = [];
  const seen = new Set();
  const pushEdge = (to, relation, description, edgeSource) => {
    const key = `${to}\u0000${relation}\u0000${edgeSource}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      from: identity,
      to: String(to),
      type: 'references',
      description: description || '',
      source: edgeSource,
      weight: 1,
      relation,
    });
  };
  for (const l of links) {
    if (l.emitEdge) pushEdge(l.href, l.relation, l.text, 'inline');
  }
  for (const c of fmConnections) {
    pushEdge(c.to, c.relation, c.description, 'frontmatter');
  }

  return { nodes: [node], edges };
}
