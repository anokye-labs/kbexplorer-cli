import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const FIXTURES = join(tmpdir(), `kbe-test-manifest-${Date.now()}`);

before(() => {
  mkdirSync(join(FIXTURES, 'src', 'engine'), { recursive: true });
  mkdirSync(join(FIXTURES, 'content', 'wiki'), { recursive: true });
  mkdirSync(join(FIXTURES, '.git'), { recursive: true });
  mkdirSync(join(FIXTURES, 'node_modules', 'foo'), { recursive: true });

  writeFileSync(join(FIXTURES, 'README.md'), '# Test Repo\n\nHello.');
  writeFileSync(join(FIXTURES, 'package.json'), '{"name":"test-repo"}');
  writeFileSync(join(FIXTURES, 'src', 'App.tsx'), 'export default function App() {}');
  writeFileSync(join(FIXTURES, 'src', 'engine', 'graph.ts'), 'export function build() {}');
  writeFileSync(join(FIXTURES, '.git', 'config'), '[core]');
  writeFileSync(join(FIXTURES, 'node_modules', 'foo', 'index.js'), 'module.exports = {}');
  writeFileSync(join(FIXTURES, 'content', 'config.yaml'), 'title: "Test"');
  writeFileSync(join(FIXTURES, 'content', 'overview.md'), '---\nid: overview\ntitle: Overview\n---\n# Overview');
  writeFileSync(join(FIXTURES, 'content', 'wiki', 'setup.md'), '---\nid: setup\n---\n# Setup');
});

after(() => { rmSync(FIXTURES, { recursive: true, force: true }); });

const { walkFileSystem, readAuthoredContent, readConfig, readReadme, fetchLocalCommits } = await import('../../src/lib/manifest.js');

describe('walkFileSystem', () => {
  it('produces entries for files and directories', () => {
    const tree = walkFileSystem(FIXTURES);
    assert.ok(tree.length > 0);
    assert.ok(tree.some(e => e.path === 'README.md' && e.type === 'blob'));
    assert.ok(tree.some(e => e.path === 'src' && e.type === 'tree'));
  });

  it('filters .git directory', () => {
    const tree = walkFileSystem(FIXTURES);
    assert.ok(!tree.some(e => e.path.startsWith('.git')));
  });

  it('filters node_modules', () => {
    const tree = walkFileSystem(FIXTURES);
    assert.ok(!tree.some(e => e.path.startsWith('node_modules')));
  });

  it('includes file sizes', () => {
    const tree = walkFileSystem(FIXTURES);
    const readme = tree.find(e => e.path === 'README.md');
    assert.ok(readme);
    assert.ok(readme.size > 0);
  });

  it('returns empty for non-existent dir', () => {
    const tree = walkFileSystem(join(FIXTURES, 'nonexistent'));
    assert.deepStrictEqual(tree, []);
  });
});

describe('readAuthoredContent', () => {
  it('reads markdown files', () => {
    const content = readAuthoredContent(join(FIXTURES, 'content'), 'content');
    assert.ok(Object.keys(content).length >= 2);
  });

  it('keys by relative path', () => {
    const content = readAuthoredContent(join(FIXTURES, 'content'), 'content');
    assert.ok(content['content/overview.md']?.includes('# Overview'));
  });

  it('returns empty for non-existent dir', () => {
    const content = readAuthoredContent(join(FIXTURES, 'missing'), 'missing');
    assert.deepStrictEqual(content, {});
  });
});

describe('readConfig', () => {
  it('reads config.yaml', () => {
    const config = readConfig(FIXTURES, 'content');
    assert.ok(config?.includes('title'));
  });

  it('returns null when missing', () => {
    assert.strictEqual(readConfig(FIXTURES, 'nonexistent'), null);
  });
});

describe('readReadme', () => {
  it('reads README.md', () => {
    assert.strictEqual(readReadme(FIXTURES), '# Test Repo\n\nHello.');
  });

  it('returns null when missing', () => {
    assert.strictEqual(readReadme(join(FIXTURES, 'src')), null);
  });
});

describe('fetchLocalCommits', () => {
  it('returns an array', () => {
    assert.ok(Array.isArray(fetchLocalCommits()));
  });
});
