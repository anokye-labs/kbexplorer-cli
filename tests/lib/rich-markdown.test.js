import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAddress, parseAddress } from '@anokye-labs/kbexplorer-core';

const {
  RICH_MARKDOWN_BLOCK_LANGS,
  parseRichFrontmatter,
  parseFrontmatterBlock,
  extractEmbeddedBlocks,
  extractLinkEdges,
  ingestRichMarkdown,
  contentHashOf,
  makeSourceRef,
} = await import('../../src/lib/rich-markdown.js');

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..');
const FIXTURE = join(REPO_ROOT, 'docs', 'samples', 'rich-markdown-sample.md');

const HASH_RE = /^sha256:hex:[0-9a-f]{64}$/;

describe('RICH_MARKDOWN_BLOCK_LANGS', () => {
  it('is the frozen four-language set', () => {
    assert.deepEqual([...RICH_MARKDOWN_BLOCK_LANGS], ['dot', 'mermaid', 'ics', 'canvas']);
    assert.ok(Object.isFrozen(RICH_MARKDOWN_BLOCK_LANGS));
  });
});

describe('contentHashOf', () => {
  it('produces a canonical, stable sha256:hex:<digest> hash', () => {
    // SHA-256 of "abc" is a well-known constant — proves the format and stability.
    assert.equal(
      contentHashOf('abc'),
      'sha256:hex:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.match(contentHashOf('anything'), HASH_RE);
    assert.equal(contentHashOf('x'), contentHashOf('x'));
  });
});

describe('parseFrontmatterBlock — arbitrary keys + types', () => {
  it('preserves arbitrary keys with typed scalars, collections, nesting', () => {
    const fm = parseFrontmatterBlock(
      [
        'id: doc-1',
        'count: 3',
        'ratio: 1.5',
        'enabled: true',
        'disabled: false',
        'nothing: null',
        'tags: [a, b, c]',
        'flow: {k: v, n: 2}',
        'owner:',
        '  name: Ada',
        '  team: platform',
        'list:',
        '  - one',
        '  - two',
        'people:',
        '  - name: Ada',
        '    role: lead',
        '  - name: Bob',
        '    role: eng',
        'note: >',
        '  folded text',
        '  on two lines',
        'x-weird_key.v2: kept',
      ].join('\n'),
    );
    assert.equal(fm.id, 'doc-1');
    assert.equal(fm.count, 3);
    assert.equal(fm.ratio, 1.5);
    assert.equal(fm.enabled, true);
    assert.equal(fm.disabled, false);
    assert.equal(fm.nothing, null);
    assert.deepEqual(fm.tags, ['a', 'b', 'c']);
    assert.deepEqual(fm.flow, { k: 'v', n: 2 });
    assert.deepEqual(fm.owner, { name: 'Ada', team: 'platform' });
    assert.deepEqual(fm.list, ['one', 'two']);
    assert.deepEqual(fm.people, [
      { name: 'Ada', role: 'lead' },
      { name: 'Bob', role: 'eng' },
    ]);
    assert.equal(fm.note, 'folded text on two lines');
    assert.equal(fm['x-weird_key.v2'], 'kept');
  });

  it('keeps a hex color value (no false comment strip)', () => {
    const fm = parseFrontmatterBlock('color: #ff0000\nname: red # the label');
    assert.equal(fm.color, '#ff0000');
    assert.equal(fm.name, 'red');
  });

  it('preserves internal indentation in a literal block scalar', () => {
    const fm = parseFrontmatterBlock(
      ['code: |', '  const x = 1;', '    nested();', '  return x;', 'next: ok'].join('\n'),
    );
    assert.equal(fm.code, 'const x = 1;\n  nested();\nreturn x;');
    assert.equal(fm.next, 'ok');
  });
});

describe('parseRichFrontmatter', () => {
  it('splits frontmatter from body and reports a body offset', () => {
    const raw = '---\nid: x\n---\nbody line\n';
    const r = parseRichFrontmatter(raw);
    assert.equal(r.ok, true);
    assert.equal(r.frontmatter.id, 'x');
    assert.equal(r.body, 'body line\n');
    assert.equal(raw.slice(r.bodyOffset), r.body);
  });

  it('treats a document without frontmatter as empty frontmatter + whole body', () => {
    const r = parseRichFrontmatter('# Title\ntext');
    assert.deepEqual(r.frontmatter, {});
    assert.equal(r.body, '# Title\ntext');
    assert.equal(r.bodyOffset, 0);
  });
});

describe('extractEmbeddedBlocks', () => {
  const body = [
    'intro',
    '```mermaid',
    'graph TD; A-->B',
    '```',
    'mid',
    '```dot',
    'digraph{a->b}',
    '```',
    '```ics',
    'BEGIN:VEVENT',
    '```',
    '```canvas',
    '{"nodes":[]}',
    '```',
    '```bash',
    'echo hi',
    '```',
  ].join('\n');

  it('captures only the four block languages, in document order', () => {
    const blocks = extractEmbeddedBlocks(body, { source: 'doc.md' });
    assert.deepEqual(
      blocks.map((b) => b.lang),
      ['mermaid', 'dot', 'ics', 'canvas'],
    );
  });

  it('captures content + a self-consistent, well-formed content hash', () => {
    const blocks = extractEmbeddedBlocks(body);
    const mermaid = blocks[0];
    assert.equal(mermaid.content, 'graph TD; A-->B');
    assert.match(mermaid.contentHash, HASH_RE);
    assert.equal(mermaid.contentHash, contentHashOf(mermaid.content));
  });

  it('records document-relative offsets + line numbers honoring bodyOffset/lineOffset', () => {
    const blocks = extractEmbeddedBlocks(body, { bodyOffset: 100, lineOffset: 10 });
    const mermaid = blocks[0];
    assert.ok(mermaid.span.start >= 100 && mermaid.span.end > mermaid.span.start);
    assert.ok(mermaid.lines.start >= 11);
    // The block content sits inside the reported content span.
    assert.equal(mermaid.contentSpan.start - 100, body.indexOf('graph TD'));
  });

  it('attaches interim provenance per block', () => {
    const [block] = extractEmbeddedBlocks(body, { source: 'doc.md' });
    assert.equal(block.sourceRef.kind, 'interim-source-ref');
    assert.equal(block.sourceRef.source, 'doc.md');
    assert.equal(block.sourceRef.contentHash, block.contentHash);
    assert.deepEqual(block.sourceRef.span, block.span);
  });
});

describe('extractLinkEdges', () => {
  const body = [
    'See [squad](kg://platform-squad){rel=leads} and [runtime](kg://runtime).',
    'An [external](https://example.com) and a [rel link](./other.md).',
    'Inline `[code](kg://ignored)` is skipped.',
    '```',
    '[fenced](kg://fenced-ignored)',
    '```',
  ].join('\n');

  it('types annotated links via the relation taxonomy and emits an edge', () => {
    const links = extractLinkEdges(body);
    const squad = links.find((l) => l.href === 'kg://platform-squad');
    assert.equal(squad.relation, 'leads');
    assert.equal(squad.emitEdge, true);
    assert.equal(squad.attrs.rel, 'leads');
  });

  it('emits edges for address targets (default structural relation)', () => {
    const links = extractLinkEdges(body);
    const runtime = links.find((l) => l.href === 'kg://runtime');
    assert.equal(runtime.relation, 'structural');
    assert.equal(runtime.emitEdge, true);
    const ext = links.find((l) => l.href === 'https://example.com');
    assert.equal(ext.isAddress, true);
    assert.equal(ext.emitEdge, true);
  });

  it('records but does not emit edges for non-address relative links', () => {
    const links = extractLinkEdges(body);
    const rel = links.find((l) => l.href === './other.md');
    assert.equal(rel.isAddress, false);
    assert.equal(rel.emitEdge, false);
  });

  it('ignores links inside inline code and fenced code blocks', () => {
    const hrefs = extractLinkEdges(body).map((l) => l.href);
    assert.ok(!hrefs.includes('kg://ignored'));
    assert.ok(!hrefs.includes('kg://fenced-ignored'));
  });

  it('masks multi-backtick code spans (length-aware close)', () => {
    const sample = 'Outer `` a ` [bad](kg://bad) `` tail and [ok](kg://ok).';
    const hrefs = extractLinkEdges(sample).map((l) => l.href);
    assert.ok(!hrefs.includes('kg://bad'), 'link inside a `` span must be masked');
    assert.ok(hrefs.includes('kg://ok'), 'link outside the span is still extracted');
  });

  it('reports document-relative spans honoring bodyOffset', () => {
    const links = extractLinkEdges(body, { bodyOffset: 50 });
    for (const l of links) assert.ok(l.span.start >= 50 && l.span.end > l.span.start);
  });
});

describe('makeSourceRef (interim — core#23)', () => {
  it('builds an interim ref and omits an invalid span', () => {
    assert.deepEqual(makeSourceRef({ source: 'a.md', span: { start: 1, end: 4 }, contentHash: 'h' }), {
      kind: 'interim-source-ref',
      source: 'a.md',
      span: { start: 1, end: 4 },
      contentHash: 'h',
    });
    const ref = makeSourceRef({ source: 'a.md', span: { start: NaN, end: 4 } });
    assert.equal(ref.span, undefined);
  });
});

describe('ingestRichMarkdown — identity', () => {
  it('mints an OPAQUE address (no type in body) from frontmatter id', () => {
    const { nodes } = ingestRichMarkdown({
      content: '---\nid: my-doc\nentityType: report\n---\nbody',
      path: 'docs/a.md',
      identity: { scheme: 'kg', authority: 'docs' },
    });
    const node = nodes[0];
    assert.equal(node.id, buildAddress('my-doc', { scheme: 'kg', authority: 'docs' }));
    assert.equal(node.identity, node.id);
    const parsed = parseAddress(node.id, { authority: 'docs' });
    assert.equal(parsed.scheme, 'kg');
    assert.equal(parsed.authority, 'docs');
    assert.equal(parsed.body, 'my-doc');
    assert.ok(!parsed.body.includes('/'), 'opaque body must not encode a type segment');
    // The declared type is carried as an attribute, never in the id.
    assert.equal(node.entityType, 'report');
    assert.equal(node.jsonld['@id'], node.id);
    assert.equal(node.jsonld['@type'], 'report');
  });

  it('falls back to a slug of the path when no frontmatter id', () => {
    const { nodes } = ingestRichMarkdown({ content: 'no frontmatter here', path: 'docs/My File.md' });
    assert.equal(nodes[0].id, buildAddress('my-file'));
  });

  it('respects a configurable scheme with no authority', () => {
    const { nodes } = ingestRichMarkdown({
      content: '---\nid: d\n---\n',
      identity: { scheme: 'org-kb' },
    });
    assert.equal(nodes[0].id, 'org-kb://d');
  });
});

describe('ingestRichMarkdown — full ingest of the committed fixture', () => {
  const content = readFileSync(FIXTURE, 'utf-8');
  const input = {
    content,
    path: 'docs/samples/rich-markdown-sample.md',
    identity: { scheme: 'kg', authority: 'docs' },
    cluster: 'samples',
    providerId: 'rich-markdown',
  };

  it('is deterministic across runs (byte-identical JSON)', () => {
    assert.equal(JSON.stringify(ingestRichMarkdown(input)), JSON.stringify(ingestRichMarkdown(input)));
  });

  it('preserves the FULL frontmatter (arbitrary keys) under node.data', () => {
    const node = ingestRichMarkdown(input).nodes[0];
    assert.equal(node.data.id, 'rich-markdown-sample');
    assert.equal(node.data.version, 2);
    assert.equal(node.data.draft, false);
    assert.deepEqual(node.data.tags, ['demo', 'deterministic', 'wave-0b']);
    assert.deepEqual(node.data.owner, { name: 'Platform Squad', alias: 'platform-squad' });
    assert.equal(node.data['x-custom-meta'], 'preserved-verbatim');
    assert.match(node.data.summary, /^A deterministic fixture/);
  });

  it('extracts all four embedded blocks with stable hashes + offsets', () => {
    const blocks = ingestRichMarkdown(input).nodes[0].data.richMarkdown.blocks;
    // Offsets are reported against the LF-normalized document (the lib normalizes
    // line endings up front so block hashes are identical on LF and CRLF checkouts).
    const norm = content.replace(/\r\n/g, '\n');
    assert.deepEqual(blocks.map((b) => b.lang), ['mermaid', 'dot', 'ics', 'canvas']);
    for (const b of blocks) {
      assert.match(b.contentHash, HASH_RE);
      assert.equal(b.contentHash, contentHashOf(b.content));
      assert.ok(b.span.end > b.span.start);
      assert.equal(norm.slice(b.contentSpan.start, b.contentSpan.end), b.content);
    }
  });

  it('produces typed edges from links + frontmatter, all rooted at the node identity', () => {
    const { nodes, edges } = ingestRichMarkdown(input);
    const id = nodes[0].id;
    const byTo = Object.fromEntries(edges.map((e) => [e.to, e]));
    assert.equal(byTo['kg://platform-squad'].relation, 'leads');
    assert.equal(byTo['kg://derivation-runtime'].relation, 'structural');
    assert.equal(byTo['kg://samples-overview'].source, 'frontmatter');
    assert.ok(!byTo['./other-sample.md'], 'relative non-address link is not an edge');
    for (const e of edges) {
      assert.equal(e.from, id);
      assert.equal(e.type, 'references');
      assert.ok(['leads', 'structural'].includes(e.relation));
    }
  });

  it('sets the rich-Markdown sourceFile affordance + interim provenance', () => {
    const node = ingestRichMarkdown(input).nodes[0];
    assert.deepEqual(node.sourceFile, {
      path: 'docs/samples/rich-markdown-sample.md',
      raw: content.replace(/\r\n/g, '\n'),
      format: 'markdown',
    });
    assert.equal(node.data.richMarkdown.source.kind, 'interim-source-ref');
    assert.equal(node.data.richMarkdown.source.contentHash, contentHashOf(content.replace(/\r\n/g, '\n')));
    assert.equal(node.provider, 'rich-markdown');
    assert.equal(node.cluster, 'samples');
  });
});
