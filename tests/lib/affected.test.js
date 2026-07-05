import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const { buildCitationIndex, findAffected, affected } = await import(
  '../../src/lib/affected.ts'
);
const { extractCitedFiles } = await import('../../src/lib/citations.ts');

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-affected-'));
  const content = resolve(dir, 'content');
  mkdirSync(content, { recursive: true });
  return { dir, content };
}

function write(file, lines) {
  writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
}

describe('extractCitedFiles', () => {
  it('finds linked-format citations', () => {
    const body =
      'Auth lives in [src/auth.ts:42](https://github.com/o/r/blob/main/src/auth.ts#L42).';
    assert.deepEqual(extractCitedFiles(body).sort(), ['src/auth.ts']);
  });

  it('finds local-format citations', () => {
    const body = 'The dispatcher (src/dispatch.js:12-34) handles routing.';
    assert.deepEqual(extractCitedFiles(body), ['src/dispatch.js']);
  });

  it('picks up <!-- Source: --> comments', () => {
    const body = '```mermaid\nflow\n```\n<!-- Sources: src/a.ts:10, src/b.ts:20 -->';
    assert.deepEqual(extractCitedFiles(body).sort(), ['src/a.ts', 'src/b.ts']);
  });

  it('de-duplicates across formats', () => {
    const body =
      '[src/x.ts:1](u) and (src/x.ts:2) and <!-- Source: src/x.ts:3 -->';
    assert.deepEqual(extractCitedFiles(body), ['src/x.ts']);
  });

  it('returns empty for plain prose', () => {
    assert.deepEqual(extractCitedFiles('No code refs here.'), []);
  });
});

describe('buildCitationIndex', () => {
  it('indexes nodes by cited file', () => {
    const { dir, content } = makeFixture();
    try {
      write(resolve(content, 'a.md'), [
        '---',
        'id: "a"',
        'title: "A"',
        'cluster: x',
        '---',
        '',
        '(src/foo.ts:1) and (src/bar.ts:5)',
      ]);
      write(resolve(content, 'b.md'), [
        '---',
        'id: "b"',
        'title: "B"',
        'cluster: x',
        '---',
        '',
        '(src/foo.ts:99)',
      ]);
      const { index, nodes } = buildCitationIndex(content);
      assert.equal(nodes.length, 2);
      assert.deepEqual([...index.get('src/foo.ts')].sort(), ['a', 'b']);
      assert.deepEqual([...index.get('src/bar.ts')], ['a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findAffected', () => {
  it('maps changed files to citing nodes', () => {
    const index = new Map([
      ['src/foo.ts', new Set(['a', 'b'])],
      ['src/bar.ts', new Set(['c'])],
    ]);
    const { affected: ids, detail } = findAffected(
      ['src/foo.ts', 'README.md'],
      index,
    );
    assert.deepEqual(ids, ['a', 'b']);
    assert.deepEqual(detail.find((d) => d.file === 'README.md').nodes, []);
  });

  it('handles partial path matches via suffix', () => {
    const index = new Map([['src/foo.ts', new Set(['a'])]]);
    const { affected: ids } = findAffected(['packages/x/src/foo.ts'], index);
    assert.deepEqual(ids, ['a']);
  });
});

describe('affected — integration with file list bypass', () => {
  it('reports affected ids and uncited changes', () => {
    const { dir, content } = makeFixture();
    try {
      write(resolve(content, 'auth.md'), [
        '---',
        'id: "auth"',
        'title: "Auth"',
        'cluster: security',
        '---',
        '',
        '(src/auth.ts:10)',
      ]);
      const result = affected({
        ref: 'HEAD',
        contentDir: content,
        cwd: dir,
        files: ['src/auth.ts', 'src/unrelated.ts'],
      });
      assert.deepEqual(result.affected, ['auth']);
      assert.deepEqual(result.uncited, ['src/unrelated.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
