/**
 * Tests for the configurable GitHub API base feature in manifest.js.
 *
 * Complements the existing manifest.test.js (which covers the default gh path).
 * This file covers:
 *   - resolveOwnerRepo: git-remote parsing
 *   - fetchLocalIssues (HTTP override path): shape parity, auth header, degradation
 *   - fetchLocalPullRequests (HTTP override path): shape parity, auth header, degradation
 *   - fetchLocalReleases (HTTP override path): shape parity, draft exclusion, degradation
 *   - Default (gh CLI) path is still used when no base is set
 *
 * No actual network traffic — all HTTP calls are mocked via injected fetch/exec.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  resolveOwnerRepo,
  fetchLocalIssues,
  fetchLocalPullRequests,
  fetchLocalReleases,
} = await import('../../src/lib/manifest.js');

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a mock fetch that returns `body` with HTTP `status`.
 */
function makeFetch(status, body) {
  return (_url, _opts) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: () => Promise.resolve(body),
    });
}

/**
 * A fake execSync that returns the specified remote URL for `git remote get-url origin`
 * and an empty string for everything else.
 */
function makeExecWithRemote(remote) {
  return (cmd, _opts) => {
    if (cmd.startsWith('git remote get-url origin')) return remote;
    return '';
  };
}

/**
 * A fake execSync that throws (simulates missing gh / inaccessible git remote).
 */
function makeThrowingExec(message = 'command failed') {
  return (_cmd, _opts) => { throw new Error(message); };
}

// Sample REST v3-shaped issues
const MOCK_ISSUES = [
  {
    number: 1,
    title: 'Bug report',
    body: 'Something is broken.',
    state: 'open',
    labels: [{ name: 'bug', color: 'ee0701' }],
    assignees: [{ login: 'alice' }],
    html_url: 'https://github.com/org/repo/issues/1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
  },
  {
    number: 2,
    title: 'Feature request',
    body: 'Add support for X.',
    state: 'closed',
    labels: [],
    assignees: [],
    html_url: 'https://github.com/org/repo/issues/2',
    created_at: '2024-02-01T00:00:00Z',
    updated_at: '2024-02-02T00:00:00Z',
  },
];

// Sample REST v3-shaped PRs
const MOCK_PRS = [
  {
    number: 10,
    title: 'Add feature',
    body: 'This PR adds feature X.',
    state: 'open',
    labels: [{ name: 'enhancement', color: '84b6eb' }],
    html_url: 'https://github.com/org/repo/pull/10',
    created_at: '2024-03-01T00:00:00Z',
    updated_at: '2024-03-02T00:00:00Z',
  },
];

// Sample REST v3-shaped releases (includes a draft)
const MOCK_RELEASES = [
  {
    tag_name: 'v2.0.0',
    name: 'Version 2.0.0',
    body: 'Major release.',
    html_url: 'https://github.com/org/repo/releases/tag/v2.0.0',
    published_at: '2024-05-01T00:00:00Z',
    prerelease: false,
    draft: false,
  },
  {
    tag_name: 'v1.9.0-rc.1',
    name: 'RC 1',
    body: 'Release candidate.',
    html_url: 'https://github.com/org/repo/releases/tag/v1.9.0-rc.1',
    published_at: '2024-04-01T00:00:00Z',
    prerelease: true,
    draft: false,
  },
  {
    tag_name: 'v1.8.0-draft',
    name: 'Draft release',
    body: 'Not published.',
    html_url: 'https://github.com/org/repo/releases/tag/v1.8.0-draft',
    published_at: '2024-03-15T00:00:00Z',
    prerelease: false,
    draft: true,
  },
];

// ── resolveOwnerRepo ───────────────────────────────────────────────────────────

describe('resolveOwnerRepo', () => {
  it('parses HTTPS remote', () => {
    const exec = makeExecWithRemote('https://github.com/myorg/my-repo.git');
    assert.deepStrictEqual(resolveOwnerRepo(undefined, exec), { owner: 'myorg', repo: 'my-repo' });
  });

  it('parses SSH remote', () => {
    const exec = makeExecWithRemote('git@github.com:myorg/my-repo.git');
    assert.deepStrictEqual(resolveOwnerRepo(undefined, exec), { owner: 'myorg', repo: 'my-repo' });
  });

  it('parses GHE HTTPS remote', () => {
    const exec = makeExecWithRemote('https://github.example.com/corp/enterprise-repo');
    assert.deepStrictEqual(resolveOwnerRepo(undefined, exec), { owner: 'corp', repo: 'enterprise-repo' });
  });

  it('returns empty strings when git remote fails', () => {
    assert.deepStrictEqual(resolveOwnerRepo(undefined, makeThrowingExec()), { owner: '', repo: '' });
  });
});

// ── fetchLocalIssues — HTTP override path ─────────────────────────────────────

describe('fetchLocalIssues — HTTP override path', () => {
  const BASE = 'http://localhost:3456';
  const EXEC = makeExecWithRemote('https://github.com/myorg/my-repo.git');

  it('returns an array of issues shaped to GHIssue', async () => {
    const overrides = {
      base: BASE,
      token: 'tok',
      _exec: EXEC,
      _fetch: makeFetch(200, MOCK_ISSUES),
    };
    const issues = await fetchLocalIssues(undefined, overrides);
    assert.ok(Array.isArray(issues));
    assert.strictEqual(issues.length, 2);
  });

  it('maps GHIssue fields correctly', async () => {
    const overrides = {
      base: BASE,
      token: 'tok',
      _exec: EXEC,
      _fetch: makeFetch(200, MOCK_ISSUES),
    };
    const issues = await fetchLocalIssues(undefined, overrides);
    const first = issues[0];
    assert.strictEqual(first.number, 1);
    assert.strictEqual(first.title, 'Bug report');
    assert.strictEqual(first.body, 'Something is broken.');
    assert.strictEqual(first.state, 'open');
    assert.strictEqual(first.html_url, 'https://github.com/org/repo/issues/1');
    assert.strictEqual(first.created_at, '2024-01-01T00:00:00Z');
    assert.strictEqual(first.updated_at, '2024-01-02T00:00:00Z');
    assert.deepStrictEqual(first.labels, [{ name: 'bug', color: 'ee0701' }]);
    assert.deepStrictEqual(first.assignees, [{ login: 'alice' }]);
  });

  it('sends Authorization header with provided token', async () => {
    const sentHeaders = [];
    const fetch = (url, opts) => {
      sentHeaders.push(opts?.headers ?? {});
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    await fetchLocalIssues(undefined, { base: BASE, token: 'secret-tok', _exec: EXEC, _fetch: fetch });
    assert.strictEqual(sentHeaders[0].Authorization, 'token secret-tok');
  });

  it('returns empty array on non-200 HTTP status (degradation)', async () => {
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let issues;
    try {
      issues = await fetchLocalIssues(undefined, {
        base: BASE,
        token: 'tok',
        _exec: EXEC,
        _fetch: makeFetch(404, { message: 'Not Found' }),
      });
    } finally {
      console.warn = orig;
    }
    assert.deepStrictEqual(issues, []);
    assert.ok(warns.some((w) => w.includes('Failed to fetch issues')));
  });

  it('does not call gh when base is set', async () => {
    let ghCalled = false;
    const exec = (cmd, _opts) => {
      if (cmd.startsWith('gh')) ghCalled = true;
      return 'https://github.com/org/repo.git';
    };
    await fetchLocalIssues(undefined, {
      base: BASE,
      token: 'tok',
      _exec: exec,
      _fetch: makeFetch(200, []),
    });
    assert.strictEqual(ghCalled, false);
  });

  it('hits the correct /repos/{owner}/{repo}/issues endpoint', async () => {
    const urls = [];
    const fetch = (url, _opts) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    await fetchLocalIssues(undefined, { base: BASE, token: 'tok', _exec: EXEC, _fetch: fetch });
    assert.ok(urls[0].includes('/repos/myorg/my-repo/issues'), `URL was: ${urls[0]}`);
    assert.ok(urls[0].includes('state=all'), `URL missing state=all: ${urls[0]}`);
  });
});

// ── fetchLocalPullRequests — HTTP override path ───────────────────────────────

describe('fetchLocalPullRequests — HTTP override path', () => {
  const BASE = 'http://localhost:3456';
  const EXEC = makeExecWithRemote('https://github.com/myorg/my-repo.git');

  it('returns an array of PRs shaped to GHPullRequest', async () => {
    const prs = await fetchLocalPullRequests(undefined, {
      base: BASE,
      token: 'tok',
      _exec: EXEC,
      _fetch: makeFetch(200, MOCK_PRS),
    });
    assert.ok(Array.isArray(prs));
    assert.strictEqual(prs.length, 1);
  });

  it('maps GHPullRequest fields correctly', async () => {
    const prs = await fetchLocalPullRequests(undefined, {
      base: BASE,
      token: 'tok',
      _exec: EXEC,
      _fetch: makeFetch(200, MOCK_PRS),
    });
    const first = prs[0];
    assert.strictEqual(first.number, 10);
    assert.strictEqual(first.title, 'Add feature');
    assert.strictEqual(first.state, 'open');
    assert.strictEqual(first.html_url, 'https://github.com/org/repo/pull/10');
    assert.deepStrictEqual(first.labels, [{ name: 'enhancement', color: '84b6eb' }]);
  });

  it('sends Authorization header with provided token', async () => {
    const sentHeaders = [];
    const fetch = (url, opts) => {
      sentHeaders.push(opts?.headers ?? {});
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    await fetchLocalPullRequests(undefined, { base: BASE, token: 'pr-tok', _exec: EXEC, _fetch: fetch });
    assert.strictEqual(sentHeaders[0].Authorization, 'token pr-tok');
  });

  it('returns empty array on non-200 HTTP status (degradation)', async () => {
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let prs;
    try {
      prs = await fetchLocalPullRequests(undefined, {
        base: BASE,
        token: 'tok',
        _exec: EXEC,
        _fetch: makeFetch(503, {}),
      });
    } finally {
      console.warn = orig;
    }
    assert.deepStrictEqual(prs, []);
    assert.ok(warns.some((w) => w.includes('Failed to fetch PRs')));
  });

  it('hits the correct /repos/{owner}/{repo}/pulls endpoint', async () => {
    const urls = [];
    const fetch = (url, _opts) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    await fetchLocalPullRequests(undefined, { base: BASE, token: 'tok', _exec: EXEC, _fetch: fetch });
    assert.ok(urls[0].includes('/repos/myorg/my-repo/pulls'), `URL was: ${urls[0]}`);
    assert.ok(urls[0].includes('state=all'), `URL missing state=all: ${urls[0]}`);
  });
});

// ── fetchLocalReleases — HTTP override path ───────────────────────────────────

describe('fetchLocalReleases — HTTP override path', () => {
  const BASE = 'http://localhost:3456';
  const EXEC = makeExecWithRemote('https://github.com/myorg/my-repo.git');

  it('returns shaped releases array', async () => {
    const releases = await fetchLocalReleases(undefined, EXEC, {
      base: BASE,
      token: 'tok',
      _exec: EXEC,
      _fetch: makeFetch(200, MOCK_RELEASES),
    });
    assert.ok(Array.isArray(releases));
  });

  it('excludes drafts', async () => {
    const releases = await fetchLocalReleases(undefined, EXEC, {
      base: BASE,
      token: 'tok',
      _exec: EXEC,
      _fetch: makeFetch(200, MOCK_RELEASES),
    });
    assert.ok(releases.every((r) => r.tag_name !== 'v1.8.0-draft'));
  });

  it('includes pre-releases', async () => {
    const releases = await fetchLocalReleases(undefined, EXEC, {
      base: BASE,
      token: 'tok',
      _exec: EXEC,
      _fetch: makeFetch(200, MOCK_RELEASES),
    });
    assert.ok(releases.some((r) => r.prerelease === true));
  });

  it('sorts newest-first', async () => {
    const releases = await fetchLocalReleases(undefined, EXEC, {
      base: BASE,
      token: 'tok',
      _exec: EXEC,
      _fetch: makeFetch(200, MOCK_RELEASES),
    });
    for (let i = 1; i < releases.length; i++) {
      assert.ok(
        new Date(releases[i - 1].published_at) >= new Date(releases[i].published_at),
        `releases not sorted at index ${i}`,
      );
    }
  });

  it('sends Authorization header with provided token', async () => {
    const sentHeaders = [];
    const fetch = (url, opts) => {
      sentHeaders.push(opts?.headers ?? {});
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    await fetchLocalReleases(undefined, EXEC, { base: BASE, token: 'rel-tok', _exec: EXEC, _fetch: fetch });
    assert.strictEqual(sentHeaders[0].Authorization, 'token rel-tok');
  });

  it('returns empty array on non-200 HTTP status (degradation)', async () => {
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let releases;
    try {
      releases = await fetchLocalReleases(undefined, EXEC, {
        base: BASE,
        token: 'tok',
        _exec: EXEC,
        _fetch: makeFetch(500, {}),
      });
    } finally {
      console.warn = orig;
    }
    assert.deepStrictEqual(releases, []);
    assert.ok(warns.some((w) => w.includes('Failed to fetch releases')));
  });

  it('hits the /repos/{owner}/{repo}/releases endpoint', async () => {
    const urls = [];
    const fetch = (url, _opts) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    };
    await fetchLocalReleases(undefined, EXEC, { base: BASE, token: 'tok', _exec: EXEC, _fetch: fetch });
    assert.ok(urls[0].includes('/repos/myorg/my-repo/releases'), `URL was: ${urls[0]}`);
  });
});

// ── Default (gh CLI) path not regressed ───────────────────────────────────────

describe('fetchLocalIssues — default (gh CLI) path unchanged', () => {
  it('calls gh issue list when no base is set', () => {
    const cmds = [];
    const exec = (cmd, _opts) => {
      cmds.push(cmd);
      if (cmd.startsWith('gh --version')) return '';
      if (cmd.startsWith('gh issue list')) return JSON.stringify([]);
      return '';
    };
    const result = fetchLocalIssues(undefined, { _exec: exec });
    // Sync path — result is an array directly
    assert.ok(Array.isArray(result));
    assert.ok(cmds.some((c) => c.startsWith('gh issue list')));
  });

  it('returns empty array when gh is not available (default path degradation)', () => {
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let result;
    try {
      result = fetchLocalIssues(undefined, { _exec: makeThrowingExec('spawn gh ENOENT') });
    } finally {
      console.warn = orig;
    }
    assert.deepStrictEqual(result, []);
    assert.ok(warns.some((w) => w.includes('gh CLI not found') || w.includes('issues')));
  });
});

describe('fetchLocalPullRequests — default (gh CLI) path unchanged', () => {
  it('calls gh pr list when no base is set', () => {
    const cmds = [];
    const exec = (cmd, _opts) => {
      cmds.push(cmd);
      if (cmd.startsWith('gh --version')) return '';
      if (cmd.startsWith('gh pr list')) return JSON.stringify([]);
      return '';
    };
    const result = fetchLocalPullRequests(undefined, { _exec: exec });
    assert.ok(Array.isArray(result));
    assert.ok(cmds.some((c) => c.startsWith('gh pr list')));
  });
});

describe('fetchLocalReleases — default (gh CLI) path unchanged', () => {
  it('calls gh api when no base is set', () => {
    const cmds = [];
    const exec = (cmd, _opts) => {
      cmds.push(cmd);
      if (cmd.startsWith('gh --version')) return '';
      if (cmd.includes('gh api')) return JSON.stringify([]);
      return '';
    };
    const result = fetchLocalReleases(undefined, exec, {});
    // Sync result for default path
    assert.ok(Array.isArray(result));
    assert.ok(cmds.some((c) => c.includes('gh api')));
  });

  it('gh api endpoint is double-quoted (shell safety preserved)', () => {
    const cmds = [];
    const exec = (cmd, _opts) => {
      cmds.push(cmd);
      if (cmd.startsWith('gh --version')) return '';
      return JSON.stringify([]);
    };
    fetchLocalReleases(undefined, exec, {});
    const apiCmd = cmds.find((c) => c.includes('gh api'));
    assert.ok(apiCmd, 'expected a gh api invocation');
    assert.match(apiCmd, /gh api "[^"]+"$/, 'endpoint must be wrapped in double quotes');
  });
});
