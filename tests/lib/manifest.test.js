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

const { walkFileSystem, readAuthoredContent, readConfig, readReadme, fetchLocalCommits, fetchLocalReleases } = await import('../../src/lib/repo-manifest.js');

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

  it('normalizes CRLF to LF in authored markdown content', () => {
    const crlfPath = join(FIXTURES, 'content', 'crlf.md');
    writeFileSync(crlfPath, 'line one\r\nline two\r\n', 'utf8');
    try {
      const content = readAuthoredContent(join(FIXTURES, 'content'), 'content');
      assert.equal(content['content/crlf.md'], 'line one\nline two\n');
      assert.ok(!content['content/crlf.md']?.includes('\r'));
    } finally {
      rmSync(crlfPath, { force: true });
    }
  });

  it('returns empty for non-existent dir', () => {
    const content = readAuthoredContent(join(FIXTURES, 'missing'), 'missing');
    assert.deepStrictEqual(content, {});
  });

  it('normalizes CRLF to LF for deterministic manifest output', () => {
    const crlfRoot = join(FIXTURES, 'crlf-manifest');
    mkdirSync(join(crlfRoot, 'content', 'wiki'), { recursive: true });

    writeFileSync(join(crlfRoot, 'README.md'), 'Line 1\r\nLine 2\r\n');
    writeFileSync(join(crlfRoot, 'content', 'config.yaml'), 'title: "Test"\r\n');
    writeFileSync(join(crlfRoot, 'content', 'wiki', 'guide.md'), '# Guide\r\n\r\nBody\r\n');

    assert.strictEqual(readReadme(crlfRoot), 'Line 1\nLine 2\n');
    assert.strictEqual(readConfig(crlfRoot, 'content'), 'title: "Test"\n');

    const content = readAuthoredContent(join(crlfRoot, 'content'), 'content');
    assert.strictEqual(content['content/wiki/guide.md'], '# Guide\n\nBody\n');
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

// ── fetchLocalReleases ────────────────────────────────────────────────────────

// Fake gh API response representing published releases (including a draft)
const MOCK_GH_RELEASES = [
  {
    tag_name: 'v1.2.0',
    name: 'Version 1.2.0',
    body: '## What\'s new\n- Feature A',
    html_url: 'https://github.com/org/repo/releases/tag/v1.2.0',
    published_at: '2024-03-01T12:00:00Z',
    prerelease: false,
    draft: false,
  },
  {
    tag_name: 'v1.1.0',
    name: 'Version 1.1.0',
    body: 'Bug fixes.',
    html_url: 'https://github.com/org/repo/releases/tag/v1.1.0',
    published_at: '2024-02-01T12:00:00Z',
    prerelease: false,
    draft: false,
  },
  {
    tag_name: 'v1.0.0-beta.1',
    name: 'Beta 1',
    body: 'Pre-release.',
    html_url: 'https://github.com/org/repo/releases/tag/v1.0.0-beta.1',
    published_at: '2024-01-15T09:00:00Z',
    prerelease: true,
    draft: false,
  },
  {
    tag_name: 'v1.0.0-draft',
    name: 'Draft release',
    body: 'Not published yet.',
    html_url: 'https://github.com/org/repo/releases/tag/v1.0.0-draft',
    published_at: '2024-01-10T09:00:00Z',
    prerelease: false,
    draft: true,
  },
];

/**
 * Build a minimal fake execSync that:
 * - succeeds for `gh --version`
 * - returns mock JSON for `gh api repos/{owner}/{repo}/releases`
 */
function makeGhExec(releases = MOCK_GH_RELEASES) {
  return (cmd, _opts) => {
    if (cmd.startsWith('gh --version')) return '';
    if (cmd.includes('gh api') && cmd.includes('/releases')) {
      return JSON.stringify(releases);
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };
}

/**
 * Fake execSync that throws ENOENT on `gh --version` (simulates gh missing).
 */
function makeGhMissingExec() {
  return (_cmd, _opts) => { throw new Error('spawn gh ENOENT'); };
}

describe('fetchLocalReleases — happy path', () => {
  it('returns an array of releases', () => {
    const releases = fetchLocalReleases(undefined, makeGhExec());
    assert.ok(Array.isArray(releases));
    assert.ok(releases.length > 0);
  });

  it('maps fields to GHRelease shape', () => {
    const releases = fetchLocalReleases(undefined, makeGhExec());
    const first = releases[0];
    assert.ok('tag_name' in first);
    assert.ok('name' in first);
    assert.ok('body' in first);
    assert.ok('html_url' in first);
    assert.ok('published_at' in first);
    assert.ok('prerelease' in first);
  });

  it('sorts newest-first by published_at', () => {
    const releases = fetchLocalReleases(undefined, makeGhExec());
    for (let i = 1; i < releases.length; i++) {
      const prev = new Date(releases[i - 1].published_at);
      const curr = new Date(releases[i].published_at);
      assert.ok(prev >= curr, `releases not in descending order at index ${i}`);
    }
  });

  it('excludes draft releases', () => {
    const releases = fetchLocalReleases(undefined, makeGhExec());
    assert.ok(
      releases.every((r) => r.tag_name !== 'v1.0.0-draft'),
      'draft release should not appear in results',
    );
  });

  it('includes pre-releases (prerelease=true)', () => {
    const releases = fetchLocalReleases(undefined, makeGhExec());
    assert.ok(
      releases.some((r) => r.prerelease === true),
      'pre-releases should be included',
    );
  });

  it('tag_name and name are strings', () => {
    const releases = fetchLocalReleases(undefined, makeGhExec());
    for (const r of releases) {
      assert.strictEqual(typeof r.tag_name, 'string');
      assert.strictEqual(typeof r.name, 'string');
    }
  });
});

describe('fetchLocalReleases — shell safety', () => {
  it('quotes the api endpoint so ? and & survive the shell (cmd.exe splits on unquoted &)', () => {
    const cmds = [];
    const exec = (cmd, _opts) => {
      cmds.push(cmd);
      if (cmd.startsWith('gh --version')) return '';
      return JSON.stringify([]);
    };
    fetchLocalReleases(undefined, exec);
    const apiCmd = cmds.find((c) => c.includes('gh api'));
    assert.ok(apiCmd, 'expected a gh api invocation');
    assert.match(apiCmd, /gh api "[^"]+"$/, 'endpoint must be wrapped in double quotes');
  });
});

describe('fetchLocalReleases — cap at 30', () => {
  it('returns at most 30 releases regardless of how many gh returns', () => {
    // Build 50 synthetic releases
    const many = Array.from({ length: 50 }, (_, i) => ({
      tag_name: `v${50 - i}.0.0`,
      name: `Release ${50 - i}`,
      body: '',
      html_url: '',
      published_at: new Date(Date.now() - i * 86400000).toISOString(),
      prerelease: false,
      draft: false,
    }));
    const releases = fetchLocalReleases(undefined, makeGhExec(many));
    assert.ok(releases.length <= 30, `Expected <= 30, got ${releases.length}`);
  });
});

describe('fetchLocalReleases — gh missing (degradation)', () => {
  it('returns an empty array when gh is not available', () => {
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let releases;
    try {
      releases = fetchLocalReleases(undefined, makeGhMissingExec());
    } finally {
      console.warn = origWarn;
    }
    assert.deepStrictEqual(releases, []);
  });

  it('emits a warning when gh is not available', () => {
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      fetchLocalReleases(undefined, makeGhMissingExec());
    } finally {
      console.warn = origWarn;
    }
    assert.ok(
      warns.some((w) => w.includes('gh CLI not found') || w.includes('skipping releases') || w.includes('releases')),
      'Expected a warning about gh not being available',
    );
  });
});

describe('fetchLocalReleases — gh non-zero exit (degradation)', () => {
  it('returns empty array on gh api error', () => {
    const exec = (cmd, _opts) => {
      if (cmd.startsWith('gh --version')) return '';
      throw new Error('gh: Not Found (HTTP 404)');
    };
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let releases;
    try {
      releases = fetchLocalReleases(undefined, exec);
    } finally {
      console.warn = origWarn;
    }
    assert.deepStrictEqual(releases, []);
  });

  it('emits a warning on gh api error', () => {
    const exec = (cmd, _opts) => {
      if (cmd.startsWith('gh --version')) return '';
      throw new Error('gh: Not Found (HTTP 404)');
    };
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      fetchLocalReleases(undefined, exec);
    } finally {
      console.warn = origWarn;
    }
    assert.ok(warns.length > 0, 'Expected at least one warning');
  });
});
